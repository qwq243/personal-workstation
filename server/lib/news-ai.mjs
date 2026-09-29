/**
 * 资讯的 AI 概括层（`#/news` 的「它在讲什么」那一行从哪来）。
 *
 * 规矩：**返回的是「AI 高度概括的同类事件」，不是原始标题的搬运**。所以这一层干两件事：
 *  ① 把**最新的一批新条目**交给模型（走 `server/lib/llm.mjs` 的统一预算守卫，
 *     模型从 `ai.model` / 全站模型预设来，不在这里写死）做「同类聚合 + 一件一段」：
 *     卡片的 `sources[].title` 用**原始标题原样**回指 —— 这样反馈的 URL / 标题能对上，
 *     👍/👎 才不会错指；
 *  ② 结果写进 `<dataDir>/news-ai/cards.json`（只追加，前面批次不动）；
 *     页面优先读这批，**没出来时就退回原始标题**（在意的信息流不能断，见 NewsView 的注释）。
 *
 * 模型调度是**懒的**：页面打开看板时如果时间到了（每 30 分钟）就顺手跑一批，不另起定时器 ——
 * 采集在采集器那一侧做，本机这层只负责「把最新的新条目变成能看的卡」。
 *
 * 偏好档也在这里生效：**👎 过的源、👎 过的关键词会先被调低排序再送模型**，
 * 同一批送进去的条数有限（45 条封顶），所以「不关心的」更早被挤出输入。
 */
import fs from 'node:fs'
import path from 'node:path'
import { dataDir, loadConfig } from '../config.mjs'
import { chatGuarded } from './llm.mjs'

const DIR = () => {
  const p = path.join(dataDir(), 'news-ai')
  fs.mkdirSync(p, { recursive: true })
  return p
}
const CARDS = () => path.join(DIR(), 'cards.json')
const STATE = () => path.join(DIR(), 'state.json')

const readJson = (file, d) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return d
  }
}
const writeJson = (file, obj) => {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
  fs.renameSync(tmp, file)
}

const BATCH_MINUTES = 30
const MAX_ITEMS_PER_BATCH = 45

/** 卡片的分类（与 `news-board.mjs` 的 CAT_ORDER 同一套；采集侧与卡片侧共用一套词表最省心） */
const CARD_CATS = ['focus', 'kaoyan', 'ai', 'tech', 'tools', 'world', 'other']

/** 已经概括到第几批（用最新批次的 generatedAt 当水位） */
function state() {
  return readJson(STATE(), { watermark: 0, batches: 0 })
}

/** 已经有 AI 卡的批次（最新的一批在第一个） */
export function cards() {
  const d = readJson(CARDS(), { list: [] })
  return d.list || []
}

/** 最新一批 AI 卡（按标题回指）。没有就返回空数组，页面退回原始条目。 */
export function latest() {
  const list = cards()
  return list.length ? list[0] : null
}

/**
 * 给看板用的「AI 卡替换表」：标题 → 卡。
 * 页面把 `cards.map()` 里同标题的原始条目换成 AI 卡（title/summary 换成 AI 写的，
 * sources 换成这一组里的全部源）。
 */
export function cardMap() {
  const b = latest()
  const m = new Map()
  for (const c of b?.cards ?? []) {
    for (const s of c.sources ?? []) {
      if (s.title) m.set(s.title, c)
      if (s.url) m.set(s.url, c)
    }
  }
  return m
}

/* ------------------------------------------------------------- 跑批 --- */

/** 条目日期给模型看的一小段（月-日）——年份没用还占字；没有日期就给空串。 */
const mdOf = (ts) => {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 系统提示词里的「服务对象」。
 *
 * 与 `server/lib/ai.mjs` 的 `personaLine()` 同一套口径：基础人设读 `ai.persona`，
 * 更具体的身份（学校 / 专业这类）放 `ai.personaPrivate`（落 credentials.json，不进版本库）。
 * 抄这一小段而不从 ai.mjs 导出，是因为这一层要**自己组装**提示词（那边只有全站助手那一段），
 * 两处的规矩必须一致：人设永远从配置来，不写死在提示词里。
 */
function personaLine() {
  const cfg = loadConfig()
  const base = String(cfg.ai?.persona ?? '').trim() || '服务对象是一名在校大学生'
  const extra = String(cfg.ai?.personaPrivate ?? '').trim()
  return extra ? `${base}（${extra}）` : base
}

/**
 * 概括用的 system 提示词（`docs/news-contract.md` §1 的可执行版本）。
 * 「关注的那几类（focus / kaoyan）单独成卡」是**硬要求**：不写死它，模型会把这些揉进科技新闻里，
 * 「与我相关」那一栏就空着（2026-09-28 踩过）。
 */
const SYS = () =>
  `你是个人资讯助手，${personaLine()}。` +
  '把给你的条目按「同一件事」归成 6-16 张卡（条目多就多成几张，别浪费），并给这一段写一句总览。要求：' +
  '① 每张卡的 title 是**这件事本身**（一句中文，别抄原始标题）；' +
  '② summary 是**它到底在讲什么 / 为什么值得看 / 跟服务对象有什么关系**（2-3 句，别堆细节）；' +
  '③ mood 只能是 pos / neu / neg 之一（就这件事本身，不评价整个行业）；' +
  '④ 卡的范围 cat 用 focus / kaoyan / ai / tech / tools / world / other 之一；' +
  '⑤ sources 里列**这张卡对应的原始条目**，用我给的原始标题原样回指（title 必须一字不改），别编新标题；' +
  '⑥ **带 [focus] / [kaoyan] 标记的条目里，只有「招生 / 报名 / 考试 / 复试 / 分数线 / 培养 / 学籍」这类通知必须单独成卡、cat 用 focus 或 kaoyan**；' +
  '机构自己的**宣传类**（活动报道、来访交流、签约揭牌、表彰喜报、竞赛战果、行政培训）**不要成卡**，最多在总览里一句带过 —— ' +
  '2026-09-29 实测：这类内容会把名额占满，真正要看的那几条反而进不来；' +
  '⑦ summary 要**厚一点**：4-6 条要点，每条 25-45 字、各自成句（分号或句号隔开），分别说清「哪一头的动向 / 具体是什么 / 跟服务对象有什么关系」；不够四条说明你看得太少，回去再看一遍条目。' +
  '只输出 JSON：{"summary":"","cards":[{"title":"","summary":"","mood":"neu","cat":"focus","tags":["产品"],"sources":[{"title":"","source":""}]}]}。' +
  '⑧ 每张卡再给 tags：从 [新产品,教程,薅羊毛,工具,论文,政策,招聘,讨论] 里挑 1-3 个（别造新词）。' +
  '⑨ **时效**：条目行首那个括号是它的日期（月-日）。**超过 14 天的不要单独成卡** —— ' +
  '确实重要就几条合一张卡、summary 里写明「已过期（日期）」；不许把几个月前的旧消息当成今天的报出来。' +
  '**没有日期**的条目：只有明显是刚发布的动态才成卡；招生简章、报名系统、管理系统这类**常驻页 / 每届都有的流程件**一律不成卡。' +
  'summary 里凡有明确日期的事都把日期写出来（如「9 月 26 日」），让人一眼看出新旧。' +
  '宁缺勿滥：凑不齐就少给几张，别把不相干的硬塞进一张。' +
  '⑩ 那个顶层 `summary`（这一段的总览）**只写真发生了的事**，不要写「本批没有 X 类内容」「无新增」这类空话；' +
  '每一段独立写，最后会被拼成整批的大总结，所以别假设你看得到别的段。'

/** 标签白名单（规范 §1.1）：只认这几个，模型爱自由发挥会让标签聚不起来 */
const TAG_SET = new Set(['新产品', '教程', '薅羊毛', '工具', '论文', '政策', '招聘', '讨论'])
/**
 * 近义词归一。模型会写「新模型 / 发布 / 优惠 / 研究 / 通知」这类词，
 * 直接按白名单过滤会把标签全丢掉（2026-09-28 实测：19 张卡一个标签都没有）。
 */
const TAG_ALIAS = [
  [/新产品|新模型|发布|上线|新版本|新服务|首发|开源模型|新范式/, '新产品'],
  [/教程|指南|经验|实践|怎么做|入门|踩坑|复盘|提示词/, '教程'],
  [/薅羊毛|免费|优惠|代充|折扣|限时|额度|白嫖/, '薅羊毛'],
  [/工具|开源|项目|插件|CLI|应用|平台/, '工具'],
  [/论文|研究|顶会|技术报告|arXiv|基准|评测/, '论文'],
  [/政策|规定|监管|通知|官方|法规|合规/, '政策'],
  [/招聘|实习|校招|就业|面试|offer/i, '招聘'],
  [/讨论|观点|争论|吐槽|疑问|求助|测评/, '讨论'],
]
const normTags = (arr) => {
  const out = []
  for (const raw of Array.isArray(arr) ? arr : []) {
    const t = String(raw).slice(0, 12)
    if (TAG_SET.has(t)) { if (!out.includes(t)) out.push(t); continue }
    for (const [re, canon] of TAG_ALIAS) {
      if (re.test(t) && !out.includes(canon)) { out.push(canon); break }
    }
  }
  return out.slice(0, 3)
}

let busy = null

/**
 * 挑出喂给模型的这一池（≤ MAX_ITEMS_PER_BATCH）。
 *
 * 抽成独立函数是为了**能核对**：排障时直接 import 它、把看板条目喂进来，
 * 就能看到「到底哪几条进了模型」，不用真跑一轮模型（2026-09-29 加）。
 */
export function pickPool(items = []) {
  const all = items ?? []
  const byCat = (c) => all.filter((x) => x.cat === c)
  const fresh = all.filter((x) => x.isNew)
  /**
   * 送进模型的名额分配：**先按类留位，再拿新增补满**。
   * 为什么不是简单的「优先项优先」：优先池本身就有几十条（官方公告不常更新、一直是头几条），
   * 直接切前 45 会把**关注的那几类**整批挤掉（2026-09-28 实测：问了 45 条，focus 一条都没有）。
   */
  const picked = [
    ...byCat('focus').slice(0, 6),
    ...byCat('kaoyan').slice(0, 8),
    ...fresh,
    ...all,
  ]
  return [...new Map(picked.map((x) => [x.id || x.url, x])).values()].slice(0, MAX_ITEMS_PER_BATCH)
}

/**
 * 顺手跑一批（如果到点了）。页面看板函数里 `aiDigest.tick(items)` 调它；
 * 它自己判断要不要跑，不阻塞页面（没跑就返回 `{skipped:true}`）。
 *
 * @param {Array} items 看板当前那批条目（拿 isNew 的那些）
 * @param {{force?: boolean}} opts force=true 跳过「已经概括过这批」的判断（手动触发用）
 */
export function tick(items, { force = false } = {}) {
  if (busy) return busy
  const st = state()
  const lastWater = Number(st.watermark || 0)
  const due = force || Date.now() - Number(readJson(STATE(), {}).at || 0) > BATCH_MINUTES * 60_000
  const all = items ?? []
  const pool = pickPool(all)
  const batchId = pool.length ? String(Math.max(...pool.map((x) => x.ts || 0))) : ''
  if (!pool.length || !due || (!force && batchId === String(st.lastBatchId || ''))) {
    return Promise.resolve({ skipped: true, reason: !pool.length ? 'no-items' : !due ? 'not-due' : 'already' })
  }
  const news = pool
  busy = (async () => {
    // 按偏好先排一次：👎 过的往后站（页面上也一样，但这里影响「哪几条进模型」）
    const fb = await import('./news-feedback.mjs')
    const tracked = fb.trackedCards()
    /**
     * 挑进模型的条数：**按源限流**（同一个源最多 4 条）。
     *
     * 为什么必须限：不限流的话，条目最多的那个源会把名额一条不剩地占满
     * （2026-09-29 实测复现：30 条里 20+ 条来自同一个源），别的源一条都进不来，
     * 页面就变成「只有那一家」。限流后仍是「权重 → 时间」的顺序，只是每个源最多占 4 席。
     */
    const CAP_PER_SOURCE = 4
    /**
     * 跨批去重（2026-09-29 加）：最近 4 批里**已经成过卡**的原始条目，不再喂给模型。
     *
     * 为什么需要：低频源（每轮几乎不变的公告页）改成「每天一次」之后，它们的条目一天里
     * 几乎不变 —— 不排掉就会**每 30 分钟重新出一张一模一样的卡**（实测：同一条连出 3 批，
     * 页面上一眼看过去就是重复）。同一批内部的重复由 seenTitle 管，这里管跨批。
     * 例外：点过「追踪」的卡 —— 那种就是要反复补厚的。
     * 兜底：万一全被覆盖（比如刚清过缓存），宁可重复也别把这一轮空着。
     */
    const normKey = (s) => String(s ?? '').replace(/[\s·—\-_|｜「」【】（）()]/g, '').slice(0, 40)
    const covered = new Set()
    for (const b of cards().slice(0, 4)) for (const c of b.cards ?? []) for (const sc of c.sources ?? []) covered.add(normKey(sc.title))
    const trackedKeys = tracked.map((t) => normKey(t.title).slice(0, 10)).filter(Boolean)
    const isCovered = (x) => {
      const k = normKey(x.title)
      if (!k || !covered.has(k)) return false
      for (const t of trackedKeys) if (k.includes(t) || t.includes(k.slice(0, 10))) return false
      return true
    }
    const feed = news.filter((x) => !isCovered(x))
    const picked = []
    const seat = new Map()
    for (const it of (feed.length ? feed : news).sort((a, b) => fb.weightFor(b) - fb.weightFor(a))) {
      const k = it.sourceId || it.source || '?'
      const n = seat.get(k) || 0
      if (n >= CAP_PER_SOURCE) continue
      seat.set(k, n + 1)
      picked.push(it)
      if (picked.length >= MAX_ITEMS_PER_BATCH) break
    }
    const sorted = picked

    /** 喂进去的条目按类计数（回给调用方，便于核对「关注的那几条到底进没进」） */
    const askedByCat = sorted.reduce((m, x) => ((m[x.cat] = (m[x.cat] || 0) + 1), m), {})
    /**
     * 标题 → 原始条目：AI 只说「这句标题属于这张卡」，**id / url 由我们对回去**。
     * 匹配要**宽容**：模型回写的标题常有点出入（少个破折号、截断、全角半角），
     * 严格相等会让来源名与链接一起丢掉（2026-09-28：卡片底下显示成一个裸的源 id ×5）。
     */
    const norm = (s) => String(s ?? '').replace(/[\s·—\-_|｜「」【】（）()]/g, '').slice(0, 40)
    const byTitle = new Map()
    for (const it of sorted) byTitle.set(norm(it.title), it)
    const lookup = (t) => {
      const a = norm(t)
      if (!a) return null
      const exact = byTitle.get(a)
      if (exact) return exact
      const head = a.slice(0, 10)
      return sorted.find((x) => {
        const b = norm(x.title)
        if (!b) return false
        return a.startsWith(b.slice(0, 10)) || b.startsWith(head) || a.includes(b.slice(0, 12)) || b.includes(head)
      }) ?? null
    }
    const resolve = (c) => {
      const srcs = (c.sources ?? [])
        .slice(0, 6)
        .map((s) => {
          const t = String(s?.title ?? '').trim()
          const hit = lookup(t)
          return {
            title: t,
            // **真实源名优先**：模型常把我们喂进去的 [focus] 标记当来源名回填，
            // 用它会让卡片底下出现四个「focus」（2026-09-28 实测）
            source: String(hit?.source ?? s?.source ?? ''),
            id: hit?.sourceId ?? '',
            url: hit?.url ?? '',
            _hit: hit,
          }
        })
        .filter((s) => s.title)
      const hits = srcs.map((s) => s._hit).filter(Boolean)
      for (const s of srcs) delete s._hit
      /**
       * 卡片右栏那三样「数据面」，本地这层也自己产（2026-09-29）——
       * 三样都有真实出处，不是编的：词=词表命中、热度=评论数、情绪=评论条数的倾向分布；
       * 拿不到就**整条不写**（宁缺勿编）。
       */
      const keywords = [...new Set(hits.flatMap((it) => it.kws ?? []))].slice(0, 6)
      const heatN = hits.reduce((a, it) => Math.max(a, Number(it.sentN) || 0), 0)
      const withN = hits.filter((it) => it.sentCounts?.n)
      const sentiment = withN.length
        ? {
            n: withN.reduce((a, it) => a + it.sentCounts.n, 0),
            pos: withN.reduce((a, it) => a + it.sentCounts.pos, 0),
            neu: withN.reduce((a, it) => a + it.sentCounts.neu, 0),
            neg: withN.reduce((a, it) => a + it.sentCounts.neg, 0),
          }
        : null
      return {
        title: String(c.title).slice(0, 80),
        summary: String(c.summary ?? '').slice(0, 400),
        mood: ['pos', 'neu', 'neg'].includes(c.mood) ? c.mood : 'neu',
        cat: CARD_CATS.includes(c.cat) ? c.cat : 'ai',
        tags: normTags(c.tags),
        sources: srcs,
        ...(keywords.length ? { keywords } : {}),
        ...(heatN ? { heat: { n: heatN, unit: '评论' } } : {}),
        ...(sentiment ? { sentiment } : {}),
      }
    }

    /**
     * 分片喂：一次 12 条。
     * 为什么不一锅端：几十条加摘要会让上游请求太长（2026-09-28 实测：一锅端直接被网关掐），
     * 而分片后每片都快、失败也只丢一片。
     */
    const CHUNK = 12
    const cardList = []
    const seenTitle = new Set()
    let summary = ''
    /** 各分片写的小总览（合并成批总览，见下面 summaryParts.join） */
    const summaryParts = []
    let okChunks = 0
    let lastErr = ''
    let model = ''
    for (let i = 0; i < sorted.length; i += CHUNK) {
      const part = sorted.slice(i, i + CHUNK)
      const partLines = part
        .map((x) => `- [${x.cat}] ${x.ts ? `(${mdOf(x.ts)}) ` : ''}${x.title}${x.desc ? '  —— ' + String(x.desc).slice(0, 90) : ''}`)
        .join('\n')
      const ask = [
        { role: 'system', content: SYS() },
        { role: 'user', content: (i === 0 ? '这是本批的条目：\n' : '这是本批的另一部分条目：\n') + partLines },
      ]
      let r = await chatGuarded(ask, { tier: 'doc', chars: partLines.length, label: `news-digest-${i / CHUNK + 1}`, temperature: 0.2 })
      // 上游偶发 5xx/超时（限流、换节点），隔几秒再来一次就过去了
      if (!r.ok) {
        await new Promise((res) => setTimeout(res, 5000))
        r = await chatGuarded(ask, { tier: 'doc', chars: partLines.length, label: `news-digest-${i / CHUNK + 1}-retry`, temperature: 0.2 })
      }
      if (!r.ok) {
        lastErr = String(r.error ?? '空响应')
        continue
      }
      if (!model && r.model) model = String(r.model)
      const content = String(r.content ?? '')
      const m = content.match(/\{[\s\S]*\}/)
      let parsed
      try {
        parsed = JSON.parse(m ? m[0] : content)
      } catch {
        lastErr = '模型回了 JSON，但里头的 cards 结构没对上：' + content.slice(0, 160)
        continue
      }
      okChunks++
      /**
       * 总览**按分片收集**，最后合并 —— 只取第一片会让「AI 大总结」漏掉后面几片的主题
       * （2026-09-29 实测：第一片全是 AI 动向，总结就写成「本批没有关注类内容」，
       *  可同一批里明明有 focus 卡，一眼看过去就觉得对不上）。
       */
      const chunkSummary = String(parsed.summary ?? '').trim()
      if (chunkSummary && !summaryParts.includes(chunkSummary)) summaryParts.push(chunkSummary)
      for (const raw of parsed.cards ?? []) {
        if (!raw || !raw.title || !Array.isArray(raw.sources) || !raw.sources.length) continue
        const c = resolve(raw)
        if (!c.sources.length) continue
        const k = c.title.slice(0, 24)
        if (seenTitle.has(k)) continue
        seenTitle.add(k)
        cardList.push(c)
      }
    }
    if (!okChunks) return { ok: false, error: `模型调用全部失败：${lastErr || '未知'}` }

    // 批总览 = 各分片的小总览合并（见上面 summaryParts）；每段去掉结尾的标点，免得拼出「。；」
    summary = summaryParts.map((s) => s.replace(/[。.；;\s]+$/, '')).join('；')

    const allBatches = cards()
    // 没写总览时兜一句：把几张卡的标题串起来，轮播里也不至于空着
    const fallback = cardList.slice(0, 3).map((c) => c.title).join('；')
    const batch = {
      at: Date.now(),
      batchId,
      summary: String(summary || fallback).slice(0, 800),
      count: cardList.length,
      model,
      cards: cardList,
    }
    allBatches.unshift(batch)
    writeJson(CARDS(), { list: allBatches.slice(0, 20) })
    writeJson(STATE(), { ...state(), at: Date.now(), lastBatchId: batchId, watermark: Date.now(), batches: (state().batches || 0) + 1 })
    return { ok: true, count: cardList.length, model, asked: askedByCat }
  })().finally(() => {
    busy = null
  })
  return busy
}

/** 看板要的状态（「上一批 AI 总结」的标头那一行）+ 批次概要（概要用） */
export function status() {
  const s = state()
  const list = cards()
  const last = list[0] ?? null
  return {
    at: s.at ?? 0,
    batches: s.batches ?? 0,
    lastCount: last?.count ?? 0,
    model: last?.model ?? '',
    due: Date.now() - Number(s.at || 0) > BATCH_MINUTES * 60_000,
    /** 各批次概要（更早的批次用）：新批在前，每批一句 + 卡数 */
    periods: list.slice(0, 8).map((b) => ({ at: b.at, summary: b.summary ?? '', count: b.count ?? 0 })),
  }
}
