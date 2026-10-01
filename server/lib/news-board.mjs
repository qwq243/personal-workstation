/**
 * 资讯页（`#/news`）的看板数据：把采集器抓来的条目变成「能一眼看完」的东西。
 *
 * 要的形状：
 *  - 每件事**简洁明了 + 带来源**（一行一句，来源是标签，点开是原文）
 *  - **信息密度高**，不是把条目堆起来 —— 所以要有分类 / 情感 / 关键词热度 / 来源统计这几层
 *  - **来源统计要能点**：点某个来源或某个分类，跳到下面那一段
 *  - 论坛开放评论区 ⇒ 要有**情绪**与**词频**（词频只统计关心的词表 + 英文实词，
 *    不做盲目 n-gram —— 那样出来的全是「一个」「以及」这种噪音）
 *
 * 数据来源是 `newsfeed.feed()`（采集器产物的只读视图），本模块**只读 + 算**，不抓取、不调模型。
 * 分类/情感都是**词典规则**，所以它给的是「信号」而不是「结论」：页面上写清楚是哪来的，
 * 别让人以为这是模型判断（模型那层在 `news-ai.mjs`）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../config.mjs'
import { feed } from './newsfeed.mjs'
import * as fb from './news-feedback.mjs'
import * as follow from './news-follow.mjs'
import * as aiDigest from './news-ai.mjs'
import * as comments from './news-comments.mjs'

/* ------------------------------------------------------------- 分类 --- */

/** 分类词表（工具端与卡片端共用一套） */
const CAT_ORDER = ['focus', 'kaoyan', 'ai', 'tech', 'tools', 'world', 'other']

const CAT_NAME = {
  focus: '与我相关',
  kaoyan: '考研',
  ai: 'AI',
  tech: '科技',
  tools: '工具',
  world: '世界',
  other: '其他',
}

/**
 * 公开平台源的内置默认分类（源是人工挑的，比关键词更准）。
 * **采集器自己写了 `cat` 的以它为准**（见 `classify` ①）—— 这张表只是给
 * 「装了但没标分类」的常见公开源一个合理的落点，不认识的一律走关键词规则。
 */
const SOURCE_CAT = {
  'chsi-yz': 'kaoyan',
  'x-openai': 'ai',
  'wx-jiqizhixin': 'ai',
  'wx-qbitai': 'ai',
  'wx-paperweekly': 'ai',
  sspai: 'tech',
  'github-hot': 'tools',
  hn: 'tech',
  v2ex: 'tech',
  'linuxdo-top': 'tech',
  'linuxdo-news': 'tech',
  'world-bbc': 'world',
  'world-nyt': 'world',
  'world-dw': 'world',
  'tech-ithome': 'tech',
  'tech-ifanr': 'tech',
  /**
   * B 站视频源（2026-09-30 加）：关键词都没命中时兜到「世界」——
   * 不写这一条会落到 `other`，而页面的页签只有 我相关 / AI 圈 / 科技工具 / 世界 / 全部，
   * `other` 只在「全部」里看得见（点「世界」就找不到它了）。
   * 关键词仍然优先（讲 AI 的那期会进 AI 圈），这条只是兜底。
   */
}

/**
 * 关键词覆盖：**顺序即优先级**（越靠前越具体）。
 * 「考研节点」放最前 —— 「某校研究生院发通知」要算考研，不算 AI/科技。
 */
const RULES = [
  { cat: 'kaoyan', re: /考研|研招|研究生招生|招生简章|专业目录|考试大纲|报名|网上确认|调剂|复试|推免|保研|国家线|初试|准考证|参考书|考试安排|拟录取|四六级|CET-?[46]/i },
  { cat: 'ai', re: /\bAI\b|人工智能|大模型|模型|\bLLM\b|\bAGI\b|OpenAI|Anthropic|Claude|Gemini|Grok|DeepSeek|Qwen|Kimi|豆包|智谱|通义|GLM|LLaMA|Llama|Mistral|扩散模型|Transformer|智能体|Agent|多模态|推理模型|算力|训练|微调|算力/i },
  { cat: 'world', re: /关税|制裁|停火|大选|选举|总统|联合国|外交部|俄乌|乌克兰|中东|以色列|伊朗|以巴|汇率|美联储|央行|通胀|GDP|国债|北约/i },
  { cat: 'tools', re: /开源|self-?host|自托管|命令行|\bCLI\b|插件|\bAPI\b|Show HN|GitHub|devtool|SDK|框架|库\b/i },
  { cat: 'tech', re: /芯片|半导体|苹果|安卓|Android|iOS|鸿蒙|浏览器|Linux|Windows|数据库|云原生|Kubernetes|Docker|安全漏洞|漏洞|开源许可|编程语言|TypeScript|Rust|Python|Go\b|Rust/i },
]

/**
 * 配置里的「与我相关」关键词（`news.focusKeywords`）编译成一条正则。
 *
 * 为什么要缓存：看板每次要处理上百条，每条都现编译一遍正则既慢又白费；
 * 配置改了（键不同了）才重编。写不进去的配置（比如填了非法正则字符）按字面量转义，
 * 不让一条配置把整个看板打崩。
 */
let focusCache = { key: '\u0000', re: null }
function focusRe() {
  const raw = loadConfig().news?.focusKeywords
  const kws = (Array.isArray(raw) ? raw : []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
  const key = kws.join('\u0000')
  if (focusCache.key !== key) {
    let re = null
    if (kws.length) {
      const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      try {
        re = new RegExp(kws.map(esc).join('|'), 'i')
      } catch {
        re = null
      }
    }
    focusCache = { key, re }
  }
  return focusCache.re
}

/**
 * 归类。四条判据，**从上到下第一个命中说了算**：
 *  ① **采集器标的 `cat`**（条目级，其次源级）—— 最权威：源是人工挑的，标了就是标了；
 *  ② **`news.focusKeywords` 命中** → focus。这是「与我相关」的入口，配置驱动，不写死任何机构名；
 *  ③ 公开平台源的**内置默认分类**（HN/V2EX 这类，见 SOURCE_CAT）；
 *  ④ 关键词规则（考研 / AI / 世界 / 工具 / 科技），都不中就是 other。
 *
 * 为什么要有 ②：官方公告的标题里常常压根不带任何关键词（「2027 年硕士招生公告 3——关于做好…」），
 * 只按关键词走会把最在意的那几条混进「其他」（2026-09-28 实测）。让配置兜住它。
 */
function classify(it) {
  const own = String(it.cat || '').trim()
  if (CAT_ORDER.includes(own)) return own
  const hay = `${it.title} ${it.desc || ''}`
  const fre = focusRe()
  if (fre && fre.test(hay)) return 'focus'
  const bySource = SOURCE_CAT[it.sourceId]
  if (bySource) return bySource
  for (const r of RULES) if (r.re.test(hay)) return r.cat
  return 'other'
}

/* ------------------------------------------------------------- 情感 --- */

/**
 * 中文情感词典（小、可解释）。
 * 为什么不用模型：这条流水线一直在跑，词典是 0 成本、0 延迟、结果稳定；
 * 页面上标了是词典判断，不会把它当模型结论。要更准时再上模型（`news-ai.mjs` 那层）。
 */
const POS = /突破|首发|开源|免费|发布|上线|增长|提升|成功|通过|获批|获奖|中标|利好|优秀|推荐|改进|优化|修复|稳定|合作|融资|收购|支持|新增|推出|升级|刷新|领先|最高|超预期|里程碑|冠军|完成|实现|落地|达成|签约|获投|领跑|创新|亮眼|强劲|回暖|复苏|好于|优于|节省|提速|加速|开放|免费开放|值得|惊喜|优雅|巧妙|稳|胜|赢|赞|喜|妙|强|快|准|省/i
const NEG = /故障|崩溃|宕机|挂掉|失败|报错|无法|下架|停服|封号|涨价|裁员|漏洞|攻击|泄露|罚款|起诉|争议|批评|投诉|延期|取消|警告|风险|事故|糟糕|垃圾|差评|翻车|退市|亏损|跌|暂停|禁止|限制|拒绝|驳回|违规|下架|叫停|质疑|担忧|不满|不稳|效果不佳|不理想|缩水|缩紧|降|贵|慢|卡|坑|踩坑|破|烂|废|危|难|错|疑|害|险/i
/** 论坛里的「火/吵」信号：情感是中性的，但值得看 */
const HOT = /(?:^|\s)(\d{2,})\s*(?:points|comments)|^\d+ 条回复|热帖|热议|\d+\s*replies/i

/** 英文情感词（论坛 / 仓库类源里的英文条目） */
const EN_POS = /\b(best|great|better|faster|fast|new|launch(es|ed)?|release[sd]?|improve[sd]?|fix(es|ed)?|support(s|ed)?|free|open[- ]?sourc\w*|gain(s|ed)?|win(s|ning)?|success\w*|awesome|love[sd]?|nice|stable|fastest|cheaper|available|shipped)\b/i
const EN_NEG = /\b(worst|worse|fail(s|ed|ure)?|bug(s|gy)?|broke(n)?|crash(es|ed)?|downtime|deprecat\w*|remov(e|es|ed)|shutdown|ban(ned)?|lawsuit|sue[sd]?|fine[sd]?|layoff(s)?|risk(s|y)?|vulnerab\w*|attack(s|ed)?|leak(s|ed)?|slow(er)?|expensive|regress\w*|issue(s)?|problem(s)?|unstable|discontinu\w*|retire[sd]?|kill(s|ed)?)\b/i

function sentimentOf(text) {
  const t = String(text || '')
  const p = (t.match(POS) || []).length + (t.match(EN_POS) || []).length
  const n = (t.match(NEG) || []).length + (t.match(EN_NEG) || []).length
  // 出现次数少时用平分：1 个正 vs 1 个负 = 中性
  const score = p - n
  const label = score > 0 ? 'pos' : score < 0 ? 'neg' : 'neu'
  return { label, score, pos: p, neg: n, hot: HOT.test(t) }
}

/* ----------------------------------------------------------- 关键词 --- */

/**
 * 关心的词表（词频只统计这些 + 英文实词）。
 * 每条 [显示名, 正则, 分类]，命中就计数；不在表里的中文词不进榜（避免 n-gram 噪音）。
 */
const TERMS = [
  ['DeepSeek', /\bDeepSeek\b/i, 'ai'],
  ['OpenAI', /\bOpenAI\b/i, 'ai'],
  ['Claude', /\bClaude\b|Anthropic/i, 'ai'],
  ['Gemini', /\bGemini\b|Google AI/i, 'ai'],
  ['Grok', /\bGrok\b|\bxAI\b/i, 'ai'],
  ['Qwen', /\bQwen\b|通义/i, 'ai'],
  ['Kimi', /\bKimi\b|月之暗面/i, 'ai'],
  ['豆包', /豆包|Doubao/i, 'ai'],
  ['GLM/智谱', /\bGLM\b|智谱/i, 'ai'],
  ['智能体', /智能体|\bagent(s)?\b/i, 'ai'],
  ['大模型', /大模型|\bLLM\b/i, 'ai'],
  ['开源模型', /开源模型|权重开放|open[- ]?weights/i, 'ai'],
  ['算力/芯片', /算力|GPU|英伟达|NVIDIA|芯片|半导体/i, 'tech'],
  ['GitHub', /GitHub/i, 'tools'],
  ['自托管', /自托管|self[- ]?host/i, 'tools'],
  ['考研', /考研|研究生招生|招生简章|初试|复试|调剂/i, 'kaoyan'],
  ['研招网', /研招网/i, 'kaoyan'],
  ['四六级', /四六级|CET-?[46]|四级|六级/i, 'kaoyan'],
  ['AI 安全', /对齐|安全|越狱|jailbreak|幻觉/i, 'ai'],
  ['苹果', /Apple|苹果|iPhone|Mac(Book)?\b/i, 'tech'],
  ['裁员', /裁员|layoff/i, 'other'],
  ['融资', /融资|轮融资|估值|IPO/i, 'other'],
]

/** 英文实词（论坛 / 仓库类源用；中文不进这个榜） */
const EN_STOP = new Set(
  ('the a an and or of to in for on with at by from is are was were be been being this that these those it its as ' +
    'you your we our they their he she his her i me my not no do does did doing have has had how what when where ' +
    'who why which can could should would may might will just more most some any all than then there here about ' +
    'into over after before out up down off again very s t re ve ll d m o ' +
    // 代码/仓库描述里的常客：不是新闻词，留着只会占榜
    'todo code coding use using used new get got make made file files test tests ' +
    'data app apps https http www com org net github readme license build built api apis ' +
    'one two three first last next time year day week month way thing things show showhn ' +
    'ask hn comment comments point points source sources project projects').split(' '),
)

function wordsOf(items) {
  const tally = new Map()
  /** 同一个词的大小写变体要合并（`openai` 与 `OpenAI` 分开计数看着就像 bug） */
  const bump = (w, cat, n = 1) => {
    const k = String(w).toLowerCase()
    const cur = tally.get(k) || { w, n: 0, cat }
    cur.n += n
    tally.set(k, cur)
  }
  // 第一遍：关心词表（显示名用词表里那个规范写法）
  for (const it of items) {
    const hay = `${it.title} ${it.desc || ''}`
    for (const [name, re, cat] of TERMS) if (re.test(hay)) bump(name, cat, 1)
  }
  const canonical = new Set(tally.keys())
  // 第二遍：英文实词（只从英文条目里取，≥4 个字母；词表已经收过的不再算一遍）
  for (const it of items) {
    const hay = `${it.title} ${it.desc || ''}`
    for (const w of hay.toLowerCase().match(/[a-z][a-z+.+#-]{3,}/g) || []) {
      if (EN_STOP.has(w) || canonical.has(w)) continue
      bump(w, 'en', 1)
    }
  }
  return [...tally.values()]
    .filter((x) => x.n > 1 || x.cat !== 'en') // 英文只留重复出现的，中文词表命一次也算
    .sort((a, b) => b.n - a.n)
    .slice(0, 30)
}

/* ------------------------------------------------------------- 任务 --- */

/** 采集器每源档位（频率 + 上次抓取 + 状态），来自采集器的 sources.json / state.json */
function collectorTasks() {
  const dir = String(loadConfig().collector?.dir || '').trim()
  if (!dir) return []
  const readJson = (f, d) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
    } catch {
      return d
    }
  }
  const sources = readJson('sources.json', []) || []
  const state = readJson('state.json', {}) || {}
  return sources
    .filter((s) => !s.disabled)
    .map((s) => {
      const st = state[s.id] || {}
      const every = Number(s.everyMinutes || 0)
      const last = st.lastRunAt ? Date.parse(st.lastRunAt) : 0
      return {
        id: s.id,
        name: s.name,
        everyMinutes: every,
        lastRunAt: st.lastRunAt || '',
        nextAt: last && every ? new Date(last + every * 60_000).toISOString() : '',
        seen: (st.seen || []).length,
        kind: s.type || s.kind || '',
        note: s.note || '',
      }
    })
    .sort((a, b) => (a.everyMinutes || 999) - (b.everyMinutes || 999))
}

/* ----------------------------------------------------------- 看板 --- */

/**
 * 条目时间 → 毫秒时间戳。认三种形状：
 *   ① 数字时间戳：10 位当 epoch **秒**、13 位当毫秒；
 *   ② RFC822（RSS 的 `pubDate`）、ISO、以及 `Date.parse` 认得的其它中文/英文日期；
 *   ③ 其它 → 0（页面上按「无日期」处理：不参与时效排序，也不做过期剔除）。
 *
 * 为什么要专门认数字（2026-09-30）：v2ex 的 `created` 就是 `"1790728324"`，
 * `Date.parse('1790728324')` 是 NaN ⇒ ts=0 ⇒ 那几条在页面上永远排不进时间线、
 * 时间档位一筛就消失，也永远不会被判「过期」—— 看起来就是「资讯不更新」。
 */
const toTs = (s) => {
  const raw = String(s ?? '').trim()
  if (!raw) return 0
  if (/^\d{10}$/.test(raw)) return Number(raw) * 1000
  if (/^\d{13}$/.test(raw)) return Number(raw)
  const t = Date.parse(raw)
  return Number.isFinite(t) ? t : 0
}

/**
 * 词表驱动的关键词：把 `TERMS` 里命中的名字挑出来（反馈与排序都要用，
 * 页面显示用 `TERMS` 的「显示名」，别用原始小写）。
 */
const kwsOf = (it) => TERMS.filter(([, re]) => re.test(`${it.title} ${it.desc || ''}`)).map(([name]) => name)

/**
 * 看板数据。**先给快照，再后台刷新**。
 *
 * 为什么必须缓存：这一份要读采集结果（上百条 × 每条几轮正则）+ 读评论缓存 + 数源档位，
 * 放在请求路径上就是「点进去要等」。所以：90 秒内的快照直接回；过期的先把旧快照回给页面，
 * 同时在后台重算，下次刷新就是新的。
 * `force`（页面上的「刷新」）才同步等一轮重算。
 */
let snap = { at: 0, data: null }
let snapBuilding = null

export async function dashboard({ force = false } = {}) {
  if (!force && snap.data) {
    if (Date.now() - snap.at > 90_000 && !snapBuilding) {
      snapBuilding = (async () => {
        const fresh = await buildDashboard({ force: false })
        if (fresh?.ok) snap = { at: Date.now(), data: fresh }
      })()
        .catch(() => {})
        .finally(() => {
          snapBuilding = null
        })
    }
    return snap.data
  }
  const data = await buildDashboard({ force })
  if (data?.ok) snap = { at: Date.now(), data }
  return data
}

async function buildDashboard() {
  const f = feed()
  if (!f.ok) return { ok: false, error: f.error }

  const now = Date.now()
  // 论坛评论：把「评论区前几条」在后台填进缓存，这一轮用上一轮已经抓好的（慢活不挡页面）
  comments.prime(f.items ?? [])
  let items = (f.items || []).map((it) => {
    const cat = classify(it)
    const fromComments = comments.sentimentFor(it)
    const sent = fromComments ?? sentimentOf(`${it.title} ${it.desc || ''}`)
    const ts = toTs(it.date)
    const kws = kwsOf(it)
    const w = fb.weightFor({ cat, sourceId: it.sourceId, kws })
    return {
      id: it.url || it.title,
      title: it.title,
      desc: it.desc || '',
      url: it.url,
      source: it.source,
      sourceId: it.sourceId,
      cat,
      catName: CAT_NAME[cat],
      sent: sent.label,
      sentScore: sent.score,
      sentN: sent.n ?? 0,
      sentFrom: fromComments ? 'comments' : 'dict',
      /** 评论情绪的**条数分布**（情绪条用）：只有真读过评论才有，没有就是 null */
      sentCounts: fromComments?.dist ? { n: fromComments.n, pos: fromComments.dist.pos, neu: fromComments.dist.neu, neg: fromComments.dist.neg } : null,
      hot: sent.hot ?? false,
      ts,
      ageMin: ts ? Math.max(0, Math.round((now - ts) / 60_000)) : null,
      official: !!it.official,
      watch: it.watch || [],
      isNew: !!it.isNew,
      kws,
      w,
    }
  })

  // 同一事件被多个源抓到：按标题前 24 字合并，保留最早出现的那个源 + 记下其他源
  const merged = new Map()
  for (const it of items) {
    const k = (it.title || '').slice(0, 24)
    const prev = merged.get(k)
    if (!prev) {
      merged.set(k, { ...it, alsoFrom: [] })
      continue
    }
    if (prev.sourceId !== it.sourceId) prev.alsoFrom.push(it.source)
    if (it.official && !prev.official) {
      // 官方源优先占据这条
      merged.set(k, { ...it, alsoFrom: [...prev.alsoFrom, prev.source] })
    }
  }
  let list = [...merged.values()]

  /**
   * 时效闸门（2026-09-29：「时间很重要，不要发那些过期的时间信息」）。
   *
   * 带日期、且超过 STALE_DAYS 的条目**不进主信息流**（页面主体、AI 概括都看不到它们），
   * 挪到 `oldItems` 里由页面折叠展示 —— 官方站那批「去年的通知」就不会再冒充今天的消息。
   * 只治**有日期**的条目：论坛这类没日期的（帖子本身自带新鲜度）不在这里判，
   * 卡片那一层的时效由契约（7/14 天）管。
   */
  const STALE_DAYS = 21
  const staleMs = STALE_DAYS * 86400_000
  const oldItems = list.filter((x) => x.ts && now - x.ts > staleMs)
  if (oldItems.length) list = list.filter((x) => !(x.ts && now - x.ts > staleMs))

  // 排序：① 👍/👎 学到的权重（大 → 小）② 时间（新 → 旧）。
  // 权重的差异只在它「真的动过」时才主导 —— 全是 1.0 的时候按时间排，页面才不会乱。
  const touched = fb.learned(1).kws.length > 0 || Object.values(fb.prefs().cat).some((v) => Math.abs(v - 1) > 0.02) || Object.values(fb.prefs().source).some((v) => Math.abs(v - 1) > 0.02)
  list.sort((a, b) => (touched ? b.w - a.w || b.ts - a.ts : b.ts - a.ts))

  // AI 概括：页面先拿到当前这批（有 AI 卡就用，没有就原始），跑批在后台继续
  const trackedTitles = new Set(fb.trackedCards().map((t) => t.title))
  const ai = await aiLayer(list)

  const counts = (arr, key) => {
    const m = new Map()
    for (const x of arr) m.set(x[key], (m.get(x[key]) || 0) + 1)
    return m
  }
  const catCount = counts(list, 'cat')
  const categories = CAT_ORDER.filter((c) => catCount.get(c)).map((c) => ({
    id: c,
    name: CAT_NAME[c],
    count: catCount.get(c) || 0,
    newCount: list.filter((x) => x.cat === c && x.isNew).length,
    official: list.filter((x) => x.cat === c && x.official).length,
  }))

  const sentCount = { pos: 0, neu: 0, neg: 0 }
  for (const it of list) sentCount[it.sent]++
  const hotItems = list.filter((x) => x.hot).length

  return {
    ok: true,
    generatedAt: f.generatedAt ?? 0,
    dir: f.dir,
    brief: f.brief ?? null,
    stats: { ...(f.stats || {}), events: list.length, merged: (f.items || []).length - list.length, staleDays: STALE_DAYS, stale: oldItems.length },
    items: list,
    /** 过期条目（> staleDays 天，且有日期）：页面抽屉里折叠展示，不进主流程 */
    oldItems,
    categories,
    sentiment: {
      ...sentCount,
      total: list.length,
      posSamples: list.filter((x) => x.sentScore > 0).sort((a, b) => b.sentScore - a.sentScore).slice(0, 4),
      negSamples: list.filter((x) => x.sentScore < 0).sort((a, b) => a.sentScore - b.sentScore).slice(0, 4),
      hot: hotItems,
    },
    words: wordsOf(list),
    sources: f.sources || [],
    topics: f.topics || [],
    tasks: { collector: collectorTasks() },
    /** 「调教记录」：学出来的权重榜 + 待采纳的备注建议 */
    learned: fb.learned(24),
    suggestions: fb.suggestions(20),
    /** AI 卡：标题 → 卡 的索引（页面按它把原始条目换成 AI 写的），以及管线状态 */
    ai: {
      map: Object.fromEntries(ai.map),
      status: ai.status,
      /** 页面主体就是它：最新一批 AI 概括卡（结构见 docs/news-contract.md §1） */
      cards: (aiDigest.latest()?.cards ?? []).map((c) => ({ ...c, tracked: trackedTitles.has(c.title) })),
      batchSummary: aiDigest.latest()?.summary ?? '',
    },
    /** 把当前这批原始条目也给出去（手动跑概括的接口要用它） */
    _rawItems: list,
  }
}

/* --------------------------------------------------------- 反馈接口 --- */

/**
 * 页面点 👍/👎/提交备注。
 * 备注既可能是**调教**（少给/屏蔽），也可能是**对该主题的补充要求** ——
 * 两种都要让采集器那一侧看见，所以落盘之外顺手导出一次（节流 20s，见 `news-follow.mjs`）。
 */
export function feedback(body = {}) {
  follow.pushSoon()
  return fb.addFeedback({
    id: body.id,
    title: body.title,
    url: body.url,
    cat: body.cat,
    sourceId: body.sourceId,
    kws: Array.isArray(body.kws) ? body.kws : [],
    vote: body.vote,
    note: body.note,
  })
}

/** 点「追踪」：让下一轮概括在原卡上补齐（规范 §1.3）；同时把「在追这张」导出给采集器 */
export function track(body = {}) {
  follow.pushSoon()
  return fb.trackCard({ title: body.title, summary: body.summary, on: body.on !== false })
}

/** 一键采用某条备注（黑名单 / 加权 / 降频 / 停用源） */
export function apply(body = {}) {
  follow.pushSoon()
  return fb.applySuggestion(body.id, String(body.action || ''))
}

/* --------------------------------------------------------- AI 概括 --- */

/**
 * AI 卡的回指表（标题 → 卡）+ 顺手跑一批（懒：每 30 分钟一次，见 `news-ai.mjs`）。
 * 页面按这张表把「原始条目」换成「AI 卡」—— title/summary 换成 AI 写的，
 * sources 换成这一组的全部源；匹配不到就退回原始条目（页面不能断粮）。
 */
export async function aiLayer(items) {
  const map = aiDigest.cardMap()
  // 不 await：跑批是分钟级的慢活，页面先拿到当前这批（有 AI 卡就用，没有就原始）
  aiDigest.tick(items).catch(() => {})
  return { map, status: aiDigest.status() }
}

/** 手动跑一批 AI 概括（页面上的「现在概括」按钮）；会等它跑完再回 */
export async function digestNow(items) {
  const r = await aiDigest.tick(items, { force: true })
  return { ...r, map: Object.fromEntries(aiDigest.cardMap()), status: aiDigest.status() }
}

/* ------------------------------------------------- 追踪/备注 → 采集器 --- */

/** 「追踪 + 备注」导出给采集器的状态（页面/排障用） */
export function followStatus() {
  return { ok: true, ...follow.status() }
}

/** 手动导出一次（排障与验收用；平时是 feedback/track/apply 顺手触发、20 秒节流） */
export function followPush() {
  return follow.pushNow()
}
