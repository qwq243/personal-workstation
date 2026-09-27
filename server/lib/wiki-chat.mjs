/**
 * 知识库问答：会话式、有依据、带检索预判。
 *
 * 与「非流式一次性问答」的区别：
 *   1. **会话**：一次问答存一条会话（server/data/wiki-chats.json），可以回来接着问；
 *   2. **先检索、再作答**：命中页面直接进上下文，再让模型判断「还缺什么」补一轮检索
 *      （多跳问题——比如「作者怎么看比较法」——只搜一次常常搜不全）；
 *   3. **流式**：最终作答逐字下发，工具轮次以事件形式先报给页面，不让用户干等十几秒；
 *   4. **只依据库内页面回答**，末尾标依据；库里没有就直说。
 *
 * 模型与技能（skills）都跟着工作台走：模型用 config.json 的 ai.*（或用 wiki.model 覆盖），
 * 技能读库内的技能目录（`.workstation-kb/skills/*.md`），只有这一份 LLM 配置。
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../config.mjs'
import { writeAtomic } from './jsonstore.mjs'
import * as wiki from './wiki.mjs'
import * as llm from './wiki-llm.mjs'
import * as websearch from './wiki-websearch.mjs'
import { budgetFor } from './llm.mjs'

/* ------------------------------------------------------------ 存储 --- */

function chatsFile() {
  return path.join(loadConfig().dataDir, 'wiki-chats.json')
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(chatsFile(), 'utf8'))
    if (Array.isArray(raw?.sessions)) return raw
  } catch {
    /* 首次或坏文件：当空库 */
  }
  return { version: 1, sessions: [] }
}

function save(data) {
  data.updatedAt = new Date().toISOString()
  writeAtomic(chatsFile(), JSON.stringify(data, null, 1))
}

function newId() {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/* ------------------------------------------------------------ 会话 --- */

export function sessions({ limit = 50 } = {}) {
  const d = load()
  return d.sessions
    .slice()
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, limit)
    .map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messages: s.messages.length,
      preview: s.messages.filter((m) => m.role === 'user').slice(-1)[0]?.content?.slice(0, 60) ?? '',
    }))
}

export function getSession(id) {
  const d = load()
  const s = d.sessions.find((x) => x.id === id)
  return s ? { ok: true, session: s } : { ok: false, error: `没有这个会话：${id}` }
}

export function newSession({ title, project } = {}) {
  const d = load()
  const s = {
    id: newId(),
    title: String(title || '新会话').slice(0, 40),
    project: project ?? wiki.root(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
  }
  d.sessions.push(s)
  // 只留最近 200 个会话：这文件是给人回看的，不是审计日志
  if (d.sessions.length > 200) d.sessions = d.sessions.slice(-200)
  save(d)
  return { ok: true, session: s }
}

export function renameSession(id, title) {
  const d = load()
  const s = d.sessions.find((x) => x.id === id)
  if (!s) return { ok: false, error: '会话不存在' }
  s.title = String(title || s.title).slice(0, 40)
  s.updatedAt = new Date().toISOString()
  save(d)
  return { ok: true, session: s }
}

export function deleteSession(id) {
  const d = load()
  const before = d.sessions.length
  d.sessions = d.sessions.filter((x) => x.id !== id)
  save(d)
  return { ok: d.sessions.length < before }
}

/* ------------------------------------------------------------ 技能 --- */

/**
 * 库内技能：`.workstation-kb/skills/*.md` 的第一行当名字，其余当正文。
 * 选中的技能会拼进系统提示，用来固定输出风格（例如「回答先给结论」「用表格对比」）。
 */
export function skills() {
  const dir = path.join(wiki.root(), '.workstation-kb', 'skills')
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue
    try {
      const text = fs.readFileSync(path.join(dir, f), 'utf8')
      const title = (text.match(/^#\s+(.+)$/m)?.[1] ?? f.replace(/\.md$/, '')).trim()
      out.push({ id: f.replace(/\.md$/, ''), name: title, chars: text.length, preview: text.replace(/^#.*$/m, '').trim().slice(0, 120) })
    } catch {
      /* 单个技能读不到就跳过 */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

function skillText(ids) {
  const dir = path.join(wiki.root(), '.workstation-kb', 'skills')
  const parts = []
  for (const id of ids ?? []) {
    const f = path.join(dir, `${id}.md`)
    try {
      parts.push(fs.readFileSync(f, 'utf8').trim())
    } catch {
      /* 技能没了就不注入 */
    }
  }
  return parts.join('\n\n')
}

/* ------------------------------------------------------------ 检索 --- */

/** 一轮「检索 + 让模型判断还缺什么」 */
async function gather(question, { runner, deep = true, topK = 6, tools = {}, retrieval = {}, onEvent } = {}) {
  const picked = new Map()
  const external = []
  const mode = ['auto', 'lexical', 'semantic'].includes(retrieval.mode) ? retrieval.mode : 'auto'
  const add = (hits, via) => {
    for (const r of hits ?? []) {
      const prev = picked.get(r.path)
      if (prev && (prev.score ?? 0) >= (r.score ?? 0)) continue
      picked.set(r.path, { ...r, via })
    }
  }

  // 库内检索（词法 + 语义）：永远跑，这是「用自己的库回答」的前提
  const first = await wiki.searchHybrid(question, { topK, includeContent: true, mode })
  add(first.results, first.mode)
  onEvent?.({ type: 'tool', name: '检索库内', detail: `${first.mode === 'hybrid' ? '词法+语义' : first.mode} 命中 ${first.total ?? first.results.length} 页` })

  // 网络搜索 / 本机文件：按轮开启（tools.web / tools.anytxt）
  if (tools.web) {
    const w = await websearch.webSearch(question, { maxResults: retrieval.webTopK ?? 5 })
    if (w.ok) {
      external.push(...w.results.map((r) => ({ ...r, kind: 'web' })))
      onEvent?.({ type: 'tool', name: '网络搜索', detail: `${w.provider} 取回 ${w.total} 条（${w.ms}ms）` })
    } else {
      onEvent?.({ type: 'tool', name: '网络搜索', detail: `失败：${w.error}` })
    }
  }
  if (tools.anytxt) {
    const a = await websearch.anyTxtSearch(question, { maxResults: retrieval.anyTxtTopK ?? 5 })
    if (a.ok) {
      external.push(...a.results.map((r) => ({ ...r, kind: 'anytxt' })))
      onEvent?.({ type: 'tool', name: '本机文件', detail: `AnyTXT 取回 ${a.total} 条` })
    } else {
      onEvent?.({ type: 'tool', name: '本机文件', detail: `跳过：${a.error}` })
    }
  }

  if (deep) {
    const catalog = wiki
      .listPages()
      .filter((p) => p.type !== 'meta')
      .map((p) => `${p.slug}｜${p.title}`)
      .join('\n')
    /* 补检索这一步也必须走**同一档路由**：它是同一场问答里的一个小请求，
       路由不一致时（chat 指 A 家、这一步却打了 B 家）会静默失败 —— 不会报错，
       只是「补检索」再也不补了，看着像检索变差了。 */
    const plan = runner
      ? await llm.chatOnce(runner, [
          {
            role: 'system',
            content:
              '你在为知识库问答做检索计划。只输出 JSON，不要解释。\n' +
              '格式：{"queries":["…"],"reason":"一句话"}\n' +
              '规则：最多给 2 条补充检索词（要能命中「概念名/人名/作品名/术语」这类字面词）；\n' +
              '如果拿不准或已经够了，就返回 {"queries":[],"reason":"…"}。',
          },
          {
            role: 'user',
            content: `问题：${question}\n\n库内页面清单（slug｜标题）：\n${catalog.slice(0, 4000)}`,
          },
          // 预算别按"这条只要一个 JSON"来拍：思考 token 与正文共用预算，300 会让正文变空串，
          // 而空串在这里只是「补检索不再补充」——静默降级，看不出是预算问题。
        ], { maxTokens: budgetFor('short').first, temperature: 0.2, timeout: 60000 })
      : { ok: false }
    if (plan.ok) {
      let parsed = null
      try {
        const body = plan.content.match(/\{[\s\S]*\}/)?.[0] ?? plan.content
        parsed = JSON.parse(body)
      } catch {
        /* 模型没给 JSON：跳过补检索，不影响主流程 */
      }
      for (const q of (parsed?.queries ?? []).slice(0, 2)) {
        if (!q || String(q).trim().length < 2) continue
        const more = await wiki.searchHybrid(String(q), { topK: 3, includeContent: true, mode })
        const fresh = (more.results ?? []).filter((r) => !picked.has(r.path))
        add(more.results, `补检「${q}」`)
        onEvent?.({ type: 'tool', name: '补检索', detail: `「${q}」新增 ${fresh.length} 页` })
      }
    }
  }

  const results = [...picked.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, topK + 2)
  return { results, external }
}

/** 把命中页面 + 外部结果拼成上下文（单页截断 3500 字，总量按 wiki.maxChars 控；按 [N] 编号供内联引用） */
function contextOf(hits, maxChars, external = []) {
  const budget = Math.max(4000, Number(maxChars) || 24000)
  const parts = []
  let used = 0
  let n = 0
  for (const h of hits) {
    const text = String(h.content ?? '').slice(0, 3500)
    if (used + text.length > budget) break
    used += text.length
    n += 1
    parts.push(`### [${n}] ${h.title}（${h.path}）\n${text}`)
  }
  if (external.length) {
    const lines = external.map(
      (e) => `- [${e.kind === 'web' ? '网络' : '本机文件'}] ${e.title} — ${e.url}\n  ${String(e.snippet ?? '').slice(0, 300)}`,
    )
    const block = `### 外部检索结果（网络搜索 / 本机文件）\n引用这些内容时请标注来源链接：\n${lines.join('\n')}`
    if (used + block.length <= budget) {
      parts.push(block)
      used += block.length
    }
  }
  return { text: parts.join('\n\n'), pages: hits.length, externals: external.length, chars: used }
}

/* ------------------------------------------------------------ 作答 --- */

/**
 * 回一轮问答。onEvent 收事件：
 *   {type:'tool', name, detail} · {type:'delta', text} · {type:'reasoning', text}
 *   {type:'done', references, usage, elapsedMs, sessionId, sessionTitle}
 *   {type:'error', error}
 * 返回 { ok, answer, references, sessionId }；流式与一次性走同一套逻辑。
 */
export async function reply({
  sessionId,
  message,
  /** 重试：不新增一轮问答，丢掉这个会话最后一条助手回复、用最后一条用户消息重跑（页面上的「重试」按钮） */
  regen = false,
  model,
  skills: skillIds = [],
  deep = true,
  topK = 6,
  tools = {},
  retrieval = {},
  signal,
  onEvent,
} = {}) {
  let question = String(message ?? '').trim()
  if (!question && !regen) return { ok: false, error: '消息为空' }
  const cfg = loadConfig()
  // 模型走「任务路由」里的 chat 预设（设置 → 模型）；显式传 model 时以传的为准
  const chatModel = llm.resolve('chat')
  if (!chatModel.ok) {
    onEvent?.({ type: 'error', error: chatModel.error })
    return { ok: false, error: chatModel.error }
  }
  const useModel = model || chatModel.model || undefined
  /* 显式传了 model 就**只覆盖模型名，不换路由**。
     原先这里写的是 `{ ...chatModel, followWorkstation: true, model }` —— 于是只要页面上挑过模型，
     请求就一律打回「跟随工作台」那家；chat 路由指向另一个预设时，等于拿 A 家的模型名去问 B 家，
     必然报错（实测页面显示的是 A 家的模型名，请求却发去了 B 家）。
     路由归路由、模型归模型：名字必须是这一档路由认的，清单也由 `/api/wiki/llm/models` 给。 */
  const runner = model ? { ...chatModel, model } : chatModel
  onEvent?.({ type: 'tool', name: '模型', detail: `${runner.label}${runner.model ? ` · ${runner.model}` : ''}` })

  // 会话：没给就现开一个，并把这次问题当标题
  let session = sessionId ? load().sessions.find((s) => s.id === sessionId) : null
  if (sessionId && !session) return { ok: false, error: `没有这个会话：${sessionId}` }
  if (!session) {
    if (regen) return { ok: false, error: '重试要先有会话' }
    const r = newSession({ title: question.slice(0, 24) })
    session = r.session
  }
  /* 重试：问题取自会话里最后一条用户消息（真正的「摘掉旧回复」在下面落盘时做，
     因为那里会重新从磁盘读一次，才不会被并发写覆盖）。 */
  if (regen) {
    const lastUser = [...session.messages].reverse().find((m) => m.role === 'user')
    question = String(lastUser?.content ?? '').trim()
    if (!question) return { ok: false, error: '这个会话里没有可重试的问题' }
    onEvent?.({ type: 'tool', name: '重试', detail: '用上一个问题重跑（旧回复会被替换）' })
  }

  const history = session.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-6)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) }))

  const t0 = Date.now()
  const { results: hits, external } = await gather(question, { runner, deep, topK, tools, retrieval, onEvent })
  // 覆盖优先级：retrieval.maxChars > wiki.maxChars > 24000；回答上限同理（retrieval.chatMaxTokens）
  const maxChars = Number(retrieval?.maxChars) > 0 ? Number(retrieval.maxChars) : cfg.wiki?.maxChars
  /* 回答上限：**思考与正文共用这个预算**。原先 1600 配思考模型会出现「思考两千多字、
     正文一个字没写」的空壳（页面看着只有思考过程）。现在默认给到 16000，留得下推演也留得下回答。 */
  const outBudget = Number(retrieval?.chatMaxTokens) > 0 ? Number(retrieval.chatMaxTokens) : Number(cfg.wiki?.chatMaxTokens) || 16000
  const ctx = contextOf(hits, maxChars, external)
  const skillBlock = skillText(skillIds)

  const messages = [
    {
      role: 'system',
      content: [
        '你在回答关于本地知识库的问题。',
        '规则：',
        '1. 只依据下面给出的库内页面作答；页面里没有的内容不要补充，也不要凭常识编造。',
        '2. 材料按 [1][2]… 编号。引用某页内容时在句末紧跟对应编号（如「作者认为比较法靠两点[1]」），一句话用多个来源就连写 [1][3]；没用到的不许标。',
        '3. 回答末尾另起一行写「依据：」，按编号列出实际用到的页面（如 `依据：[1] 页面标题、[2] 另一页`）。',
        '4. 材料不足以回答时，直说库里缺哪一部分。',
        '5. 中文作答；该展开就展开（背景、对比、步骤按问题需要给足），不要硬压缩；需要对比时用短列表或表格。',
        skillBlock ? `\n本项目技能（优先遵守）：\n${skillBlock}` : '',
        '',
        `===== 可用材料（库内页面${external?.length ? ' + 外部检索结果' : ''}）=====`,
        ctx.text || '（没有命中任何页面）',
      ].join('\n'),
    },
    ...history,
    { role: 'user', content: question },
  ]

  // 流式：逐帧回调（跟随工作台走 newapi；自定义预设走通用通道，见 wiki-llm.chatStreamVia）
  // 思考量单独记一笔：正文为空时要靠它区分「思考吃光预算」和「模型啥也没说」
  let reasoningChars = 0
  const res = await llm.chatStreamVia(runner, messages, {
    model: useModel,
    maxTokens: outBudget,
    temperature: 0.3,
    signal,
    onDelta: (d) => onEvent?.({ type: 'delta', text: d }),
    onEvent: (e) => {
      if (e?.type === 'reasoning') reasoningChars += String(e.text ?? '').length
      onEvent?.(e)
    },
  })

  if (!res.ok) {
    onEvent?.({ type: 'error', error: res.error, detail: res.detail })
    return { ok: false, error: res.error, detail: res.detail, sessionId: session.id }
  }

  const references = [
    ...hits.map((h) => ({ path: h.path, title: h.title, type: h.type, score: h.score, via: h.via, kind: 'wiki' })),
    ...(external ?? []).map((e) => ({ path: e.url, title: e.title, kind: e.kind, snippet: e.snippet })),
  ]
  /* 空正文兜底：思考型模型会先把输出预算花在 reasoning 上，正文一个字都写不出来
     （实测：思考 2858 字时，1600 token 的预算里正文为 0）。这时候页面上会出现
     「只有思考过程 + 依据、没有回答」的空壳 —— 与其让人对着空泡泡猜，不如把原因和下一步写清楚。 */
  const rawAnswer = String(res.content ?? '').trim()
  const answer = rawAnswer
    ? rawAnswer
    : reasoningChars > 0
      ? `**这次没有写出正文**：模型把输出预算全用在思考上了（思考 ${reasoningChars} 字）。\n\n` +
        '两个办法：①「检索设置 → 回答上限」调大（思考与正文共用这个预算）；' +
        '②在「设置 → 模型」里给这一档路由选「关思考」再问一次。'
      : '**模型这次没有返回内容**（没有正文也没有思考）。重发一次通常就好；连续这样就在「设置 → 模型」里「测连通」看一眼。'

  // 落盘（重新读一次，避免并发写覆盖别的会话）
  const d = load()
  const s = d.sessions.find((x) => x.id === session.id)
  if (s) {
    /* 重试（regen）：把这一轮的助手回复摘掉，**用户那条留着不动**（问题取自它），
       所以这里不能像新问答那样再 push 一条用户消息 —— 否则会话里会出现「同一问两份」。 */
    if (regen) {
      while (s.messages.length && s.messages[s.messages.length - 1].role === 'assistant') s.messages.pop()
    } else {
      s.messages.push({ role: 'user', content: question, at: new Date().toISOString() })
    }
    s.messages.push({
      role: 'assistant',
      content: answer,
      references,
      usage: res.usage ?? null,
      partial: res.partial === true,
      at: new Date().toISOString(),
    })
    s.updatedAt = new Date().toISOString()
    if (s.messages.length === 2 && /^新会话$/.test(s.title)) s.title = question.slice(0, 24)
    save(d)
  }

  onEvent?.({
    type: 'done',
    sessionId: session.id,
    sessionTitle: s?.title ?? session.title,
    references,
    usage: res.usage ?? null,
    elapsedMs: Date.now() - t0,
    partial: res.partial === true,
    contextChars: ctx.chars,
    model: runner.model || undefined,
  })
  return { ok: true, answer, references, sessionId: session.id, usage: res.usage ?? null, model: useModel ?? cfg.ai?.model }
}
