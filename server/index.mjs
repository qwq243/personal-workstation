/**
 * 工作站本地边车（sidecar）HTTP 服务。
 *
 * 为什么需要它：
 *  浏览器直连外部接口会被 CORS 挡（很多自建 / 第三方服务不回 CORS 头）。把外部请求收到边车，
 *  前端只跟 127.0.0.1 说话：跨域问题消失，密钥也不必进浏览器。
 *
 * 只监听回环地址。数据不出本机。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, saveConfig, publicConfig, migrateScopedConfig, syncConfigMirrors, dataDir, CONFIG_PATH, ROOT_DIR, DEFAULTS } from './config.mjs'
import { CONFIG_EDITABLE, CONFIG_EDITABLE_SCALARS } from './lib/config-editable.mjs'
import { request, spawnHidden } from './lib/net.mjs'
import * as pguard from './lib/pguard.mjs'
import * as procscan from './lib/procscan.mjs'
import * as newapi from './lib/newapi.mjs'
import * as panel from './lib/panel.mjs'
import * as autostart from './lib/autostart.mjs'
import * as usageCache from './lib/usage-cache.mjs'
import * as dashboard from './lib/dashboard.mjs'
import * as englishDaily from './lib/english-daily.mjs'
import * as schoolCalendar from './lib/school-calendar.mjs'
import * as plan from './lib/plan.mjs'
import * as vocab from './lib/vocab.mjs'
import * as ai from './lib/ai.mjs'
import * as summaries from './lib/summaries.mjs'
import * as auth from './lib/auth.mjs'
import * as wiki from './lib/wiki.mjs'
import * as wikiChat from './lib/wiki-chat.mjs'
import * as wikiQueue from './lib/wiki-queue.mjs'
import * as wikiEmbed from './lib/wiki-embed.mjs'
import * as wikiCloud from './lib/wiki-cloud.mjs'
import * as wikiLlm from './lib/wiki-llm.mjs'
import * as wikiWeb from './lib/wiki-websearch.mjs'
import * as singleton from './lib/singleton.mjs'
import * as memo from './lib/memo.mjs'
import * as hotwords from './lib/hotwords.mjs'
import * as newsfeed from './lib/newsfeed.mjs'
import * as newsBoard from './lib/news-board.mjs'
import * as zuotiben from './lib/zuotiben.mjs'
import * as zuotibenExport from './lib/zuotiben-export.mjs'
import * as zuotibenSuggest from './lib/zuotiben-suggest.mjs'
import * as tts from './lib/tts.mjs'
import { handleMcp } from './mcp.mjs'

/**
 * 边车版本号：直接读 package.json。
 *
 * 别在代码里手写一份 —— 那必然会在某次「改了 package.json 忘了改这儿」之后漂掉，
 * 而 /api/health 的 version 正是「页面连的是不是这一份代码」的第一条判据。
 */
const PKG_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

const cfg = loadConfig()
// 把「错放在 wiki 里的全站配置」搬到顶层（大模型 / 嵌入 / 检索 / 文档解析 / 网络 / 输出）
{
  const moved = migrateScopedConfig()
  if (moved.length) console.log(` 配置迁移: 已把 ${moved.join('、')} 从 wiki.* 提到顶层（设置页里不再分两处）`)
  // 再把顶层同步回 wiki.*（只读镜像）：老位置长期躺着过期值，会让「照着它改」的人白改 —— 见 config.mjs
  const mirrored = syncConfigMirrors()
  if (mirrored.length) console.log(` 配置镜像: 已同步 ${mirrored.join('、')}（只读镜像，改配置请改顶层）`)
}
const PORT = Number(process.env.WS_PORT || cfg.port || 5278)
const HOST = '127.0.0.1'

/* 本机边车的出网目标（模型端点 / 网络搜索 / 抓链接）都是公网直连，不该走系统代理。
 * 终端 / 沙箱注入的 HTTP_PROXY 会把请求截到本地代理端口：轻则慢，重则让
 * usage-cache 的定时同步整轮静默失败（页面拿到空缓存）。入口处统一清掉。 */
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
  delete process.env[k]
}
process.env.NO_PROXY = '*'

/* ------------------------------------------------------------- 工具 --- */

function send(res, status, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body)
  const payload = isObj ? JSON.stringify(body) : body
  // 注意：Access-Control-Allow-Origin 不在这里写死。
  // 它由 applyCors() 按 Origin 白名单逐请求设置（原来固定写 '*' 等于对任何网页开放）。
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(payload)
}

/**
 * 按 Origin 白名单设置 CORS 头。
 * 命中白名单就回显该来源（并加 Vary: Origin 防缓存串味）；未命中不设 ACAO，
 * 浏览器自然取不到响应，配合下面的 403 直接拒掉。
 */
function applyCors(req, res, origin) {
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-WS-Token, Mcp-Session-Id, Accept')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id')
  if (origin && auth.originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const type = String(req.headers['content-type'] ?? '')
  // 二进制上传（知识库拖文件进来）走这里：不按 utf8 解，原样交给处理器写盘。
  // 其余接口照旧收 JSON —— 这条分支是唯一的例外，别扩散。
  if (/^application\/octet-stream/.test(type)) return { __bin: Buffer.concat(chunks) }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return { __raw: raw }
  }
}

/** 简单计时包装，便于排查慢接口 */
async function timed(name, fn) {
  const t0 = Date.now()
  try {
    const v = await fn()
    const ms = Date.now() - t0
    if (ms > 2000) console.log(`[slow] ${name} ${ms}ms`)
    return v
  } catch (err) {
    console.error(`[error] ${name}:`, err)
    return { ok: false, error: err.message }
  }
}

/* ------------------------------------------------------------- 路由 --- */

const routes = []
function route(method, pattern, handler) {
  routes.push({ method, pattern, handler })
}

/* --- 健康 / 概览 --- */

route('GET', /^\/api\/health$/, async () => ({
  ok: true,
  service: 'workstation',
  version: PKG_VERSION,
  port: PORT,
  configPath: CONFIG_PATH,
  time: Date.now(),
}))

/** 一次给前端全部「外部世界」状态，避免首页打一堆请求。
 *  秒响应策略：
 *  1. 内存缓存 20s —— 多页切换/看板轮询瞬时返回；
 *  2. 磁盘缓存 data/cache/overview.json —— 边车重启后首屏立即有数据；
 *  3. stale-while-revalidate —— 缓存过期时**立即返回旧值**（标 stale），后台刷新供下次用，
 *     看板永远不等外部接口（冷拉要 2~10s）；
 *  4. 边车启动 2s 后预热一次 —— 正常「双击启动 → 打开页面」全程命中缓存；
 *  5. 服务状态与 AI 上下文复用同一个 serviceStatus() Promise，不再一次查两遍。
 *  ?force=1 是唯一现场重拉的路径（设置页/排查用）。 */
const OVERVIEW_TTL = 20000
/** 磁盘缓存路径走 dataDir()（认 WS_DATA_DIR 与 config.json 的 dataDir），别写死仓库内 */
const overviewFile = () => path.join(dataDir(), 'cache', 'overview.json')
let overviewCache = { at: 0, value: null }
let overviewRefreshing = false

function loadOverviewDisk() {
  try {
    const j = JSON.parse(fs.readFileSync(overviewFile(), 'utf8'))
    if (j && typeof j.at === 'number' && j.value) return j
  } catch {}
  return null
}
overviewCache = loadOverviewDisk() ?? overviewCache

function saveOverviewDisk() {
  if (!overviewCache.value) return
  try {
    const file = overviewFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(overviewCache))
  } catch (err) {
    console.warn('[overview] 磁盘缓存写入失败:', err.message)
  }
}

/**
 * 一次给前端「外部世界」的总体状态。
 *
 * 这里的每一项都必须只依赖**本项目自带的能力**（模型端点、本地看板数据）。
 * 原来它还聚合过课表 / 待办 / 早报 / 签到 / 校方服务状态那几类数据 —— 它们的来源各自
 * 依赖特定机构的私有接口或使用者本机的服务，开源版不随仓库分发，已整块摘掉；
 * 需要的话由使用者按同样的「加一节 + 前端加一张卡」的方式自己接回来。
 */
async function buildOverview() {
  const ctx = await ai.gatherContext()
  return {
    ok: true,
    // 余额与今日花费（模型端点）
    balance: ctx.balance,
    spend: ctx.todaySpend,
    plan: ctx.plan,
    streak: ctx.streak,
    vocab: ctx.vocab ?? null,
    school: ctx.school ?? null,
    ai: (() => {
      const p = newapi.aiProvider()
      return p.ok ? { ok: true, provider: p.name, models: newapi.aiModels(), model: cfg.ai.model } : { ok: false, error: p.error }
    })(),
    checkedAt: Date.now(),
  }
}

function rememberOverview(payload) {
  overviewCache = { at: Date.now(), value: payload }
  saveOverviewDisk()
}

/** 后台刷新：带并发锁；失败保留旧值（页面不受抖动影响），成功后下次请求拿到新数据 */
function refreshOverview() {
  if (overviewRefreshing) return
  overviewRefreshing = true
  buildOverview()
    .then(rememberOverview)
    .catch((err) => console.warn('[overview] 后台刷新失败（保留旧缓存）:', err.message))
    .finally(() => {
      overviewRefreshing = false
    })
}

route('GET', /^\/api\/overview$/, (req, { query }) => {
  const age = Date.now() - overviewCache.at
  if (query.force === '1') {
    return timed('overview', async () => {
      const payload = await buildOverview()
      rememberOverview(payload)
      return payload
    })
  }
  if (overviewCache.value && age < OVERVIEW_TTL) {
    return { ...overviewCache.value, cached: true, cachedAgeMs: age }
  }
  if (overviewCache.value) {
    // 过期但仍有数据：先给旧值保证秒开，后台刷新供下次使用
    refreshOverview()
    return { ...overviewCache.value, cached: true, stale: true, cachedAgeMs: age }
  }
  // 完全没有缓存（首次部署且磁盘缓存丢失）：只能现场拉
  return timed('overview', async () => {
    rememberOverview(await buildOverview())
    return overviewCache.value
  })
})

/* --- 每日汇总（按天自动汇总本机数据，每个 section 独立降级） --- */

const SUMMARY_TTL = 60000
/** date -> { at, value }；当天数据变化（学单词、花钱）最多延迟 1 分钟可见 */
const summaryCache = new Map()

function localDateStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 单节数据源失败不影响整份汇总：每个 section 都带 ok，前端按节降级 */
async function buildDailySummary(date) {
  const isToday = date === localDateStr()
  const dayStartMs = new Date(`${date}T00:00:00`).getTime()
  const startUnix = Math.floor(dayStartMs / 1000)
  const endUnix = startUnix + 86400

  const [day, progress] = await Promise.all([
    Promise.resolve(dashboard.getDay(date)),
    Promise.resolve(vocab.readProgress()),
  ])

  // AI：stat 只有起始时间下界，logs 拉回来后按天精确过滤；模型分布也从 log 聚合
  const [spend, logs] = await Promise.all([
    newapi.todaySpendByToken({ startTimestamp: startUnix }).catch((e) => ({ ok: false, error: e.message })),
    newapi.recentLogs({ startTimestamp: startUnix, pageSize: 200 }).catch((e) => ({ ok: false, error: e.message })),
  ])
  const dayLogs = logs.ok ? (logs.items ?? []).filter((l) => l.time >= startUnix && l.time < endUnix) : []
  const modelMap = new Map()
  for (const l of dayLogs) {
    if (!l.model) continue
    const cur = modelMap.get(l.model) ?? { model: l.model, count: 0, yuan: 0 }
    cur.count += 1
    cur.yuan += l.yuan ?? 0
    modelMap.set(l.model, cur)
  }
  const modelTop = [...modelMap.values()].sort((a, b) => b.yuan - a.yuan).slice(0, 4)

  // 校历：这一天上不上课 / 教学第几周（只依赖本机校历文件，不依赖任何外部服务）
  let school = null
  try {
    school = schoolCalendar.monthMarks(date.slice(0, 7))?.days?.[date] ?? null
  } catch {
    school = null
  }

  // 背单词：总量 + 当天（sessions 有多少算多少；stats 无历史维度只给总量）
  const sessions = (Array.isArray(progress.sessions) ? progress.sessions : []).filter((s) => {
    const t = s.startedAt ?? s.at ?? (s.date ? Date.parse(s.date) : NaN)
    return Number.isFinite(t) && t >= dayStartMs && t < dayStartMs + 86400000
  })
  const allStats = Object.values(progress.stats ?? {})
  const masteredSetting = progress.settings?.masterStreak ?? 2
  const vocabSection = {
    ok: true,
    totalWords: allStats.length,
    mastered: allStats.filter((s) => (s.streak ?? 0) >= masteredSetting).length,
    todaySessions: sessions.length,
    todayWords: sessions.reduce((n, s) => n + (s.count ?? s.wordCount ?? 0), 0),
  }

  const plans = day.plans ?? []
  return {
    ok: true,
    date,
    isToday,
    generatedAt: Date.now(),
    school,
    plans: {
      total: plans.length,
      done: plans.filter((p) => p.done).length,
      items: plans.slice(0, 10),
    },
    notes: (day.notes ?? []).slice(0, 10),
    mood: day.mood ?? null,
    moodNote: day.moodNote ?? '',
    review: day.done ?? '',
    tomorrow: day.tomorrow ?? '',
    vocab: vocabSection,
    ai: spend.ok
      ? { ok: true, totalYuan: spend.totalYuan, byToken: spend.items.slice(0, 5), requests: dayLogs.length, modelTop }
      : { ok: false, error: spend.error ?? '取不到模型端点数据' },
  }
}

route('GET', /^\/api\/daily\/summary$/, async (req, { query }) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(query.date ?? '') ? query.date : localDateStr()
  const hit = summaryCache.get(date)
  const age = Date.now() - (hit?.at ?? 0)
  if (hit && age < SUMMARY_TTL) return { ...hit.value, cached: true }
  const payload = await timed('daily-summary', () => buildDailySummary(date))
  summaryCache.set(date, { at: Date.now(), value: payload })
  if (summaryCache.size > 60) {
    const oldest = [...summaryCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) summaryCache.delete(oldest[0])
  }
  return payload
})


/* --- NewAPI --- */

route('GET', /^\/api\/newapi\/summary$/, () => timed('newapi.summary', () => newapi.summary()))
route('GET', /^\/api\/newapi\/balance$/, () => newapi.balance())
route('GET', /^\/api\/newapi\/tokens$/, () => newapi.tokens())
route('GET', /^\/api\/newapi\/spend\/today$/, () => newapi.todaySpendByToken())
route('GET', /^\/api\/newapi\/logs$/, (req, { query }) =>
  newapi.recentLogs({ pageSize: Number(query.pageSize || 30), tokenName: query.tokenName }),
)
/**
 * 用量快照：永远立即回缓存（usage-cache 两级定时同步），页面打开 0 个 NewAPI 请求。
 * ?refresh=1 = 手动刷新（同步等一轮轻同步，full 缺失时补全量）。旧路由保留给 MCP/脚本。
 */
route('GET', /^\/api\/newapi\/snapshot$/, (req, { query }) =>
  usageCache.snapshot({ refresh: query.refresh === '1' }),
)

/* --- 工作站自身（面板）。页面在「运行与自启」`#/service` --- */

/** 当前这个边车进程：端口 / PID / node / 项目根 / 配置文件路径 */
route('GET', /^\/api\/panel\/sidecar$/, () => panel.sidecarStatus())
/** 面板自身状态 + 自启位体检（编码/路径/用的哪个 node） */
route('GET', /^\/api\/panel\/status$/, () => panel.status())
/** 面板的运维动作：enable 生成/修复自启位 · disable 关 · remove 删 · open-startup 打开启动文件夹 */
route('POST', /^\/api\/panel\/autostart$/, (req, { body }) => {
  const action = body?.action
  if (action === 'enable') return panel.enable()
  if (action === 'disable') return panel.disable()
  if (action === 'remove') return panel.remove()
  if (action === 'open-startup') {
    const dir = autostart.startupDir()
    // 用 explorer 打开，方便用户自己核对文件夹里到底有什么
    try {
      spawnHidden(`explorer.exe "${dir}"`)
      return { ok: true, dir }
    } catch (err) {
      return { ok: false, error: err.message, dir }
    }
  }
  return { ok: false, error: `未知动作：${action}` }
})

/* --- 配置读写见文件后部「配置」一节（白名单式 PATCH） --- */

/* --- 看板 --- */

route('GET', /^\/api\/dashboard\/day$/, (req, { query }) => ({ ok: true, ...dashboard.getDay(query.date) }))
route('PATCH', /^\/api\/dashboard\/day$/, (req, { body, query }) =>
  ({ ok: true, ...dashboard.patchDay(query.date ?? dashboard.todayStr(), body ?? {}) }),
)
route('GET', /^\/api\/dashboard\/recent$/, (req, { query }) => ({
  ok: true,
  days: dashboard.recentDays(Number(query.limit || 14)),
  streak: dashboard.streak(),
}))
/** 月历：某个月的每日记录摘要（计划完成数 / 记录条数 / 心情 / 有无复盘） */
route('GET', /^\/api\/dashboard\/calendar$/, (req, { query }) => {
  const month = /^\d{4}-\d{2}$/.test(query.month ?? '') ? query.month : localDateStr().slice(0, 7)
  return dashboard.monthDays(month)
})
/**
 * 校历：某个月每天的「是不是上课日 / 放假 / 考试周 / 第几教学周」。
 *
 * 与 /api/dashboard/calendar 分开：那个是**你自己留的痕迹**（计划/记录），
 * 这个是**学校的安排**（放假、考试、教学周）。来源不同、变化频率不同，混在一起
 * 以后想换学年就会把用户数据也搅进去。
 */
route('GET', /^\/api\/calendar\/school$/, (req, { query }) => {
  const month = /^\d{4}-\d{2}$/.test(query.month ?? '') ? query.month : localDateStr().slice(0, 7)
  return schoolCalendar.monthMarks(month)
})
route('POST', /^\/api\/dashboard\/plan$/, (req, { body, query }) => ({
  ok: true,
  plan: dashboard.addPlan(query.date ?? dashboard.todayStr(), body.text, { source: body.source ?? 'web' }),
}))
route('POST', /^\/api\/dashboard\/plan\/update$/, (req, { body, query }) =>
  ({ ok: true, plan: dashboard.updatePlan(query.date ?? dashboard.todayStr(), body.id, body.patch ?? {}) }),
)
route('POST', /^\/api\/dashboard\/plan\/remove$/, (req, { body, query }) =>
  dashboard.removePlan(query.date ?? dashboard.todayStr(), body.id),
)
route('POST', /^\/api\/dashboard\/note$/, (req, { body, query }) => ({
  ok: true,
  note: dashboard.addNote(query.date ?? dashboard.todayStr(), body.text, { source: body.source ?? 'web' }),
}))
route('POST', /^\/api\/dashboard\/note\/remove$/, (req, { body, query }) =>
  dashboard.removeNote(query.date ?? dashboard.todayStr(), body.id),
)

/* --- 朗读（edge-tts 合成整句；与背单词那套真人音频分工不同） ---
 * 没配工具目录（`tts.dir`）时 status 会说明原因，前端据此回落浏览器朗读。
 */
route('GET', /^\/api\/tts\/status$/, () => tts.status())
/** 合成并回一段 mp3（带缓存；文本上限 800 字，见 lib/tts.mjs 的 MAX_TEXT） */
route('GET', /^\/api\/tts\/speak$/, async (req, { query, res }) => {
  const r = await tts.speak({ text: query.text, voice: query.voice, rate: query.rate })
  if (!r.ok) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: r.error }))
    return 'handled'
  }
  tts.pipeAudio(req, res, r.file)
  return 'handled'
})

/* --- 每日一句（句库自备，见 docs/每日一句导入.md） --- */
/** 当前句 + 进度 + 计划推算：指针不自动走，做完才 +1（规则见 lib/english-daily.mjs 头注释） */
route('GET', /^\/api\/english\/daily$/, () => englishDaily.current())
/** 句子库：全部天的摘要 + 完成/自评状态（句子库页） */
route('GET', /^\/api\/english\/daily\/library$/, () => englishDaily.library())
/** 单日详情：全文 + 该句的练习记录（抽屉/重练用） */
route('GET', /^\/api\/english\/daily\/day$/, (req, { query }) => englishDaily.dayDetail(query.day))
/** 打卡日志：最近 N 天每天做没做 */
route('GET', /^\/api\/english\/daily\/log$/, (req, { query }) => englishDaily.log(query.days))
/** 完成一次训练：{ day, rating: good|half|lost } —— 记当日打卡，是当前句才推进指针 */
route('POST', /^\/api\/english\/daily\/complete$/, (req, { body }) => englishDaily.complete(body ?? {}))
/** 误触复位：删某天的打卡并把指针拉回第一个未完成句（只给智能体/自救用） */
route('POST', /^\/api\/english\/daily\/undo$/, (req, { body }) => englishDaily.undoDate(String(body?.date ?? '')))
/** Day 区间取句（做题本的「每日一句」那本与它的打印页用；上限 120 句） */
route('GET', /^\/api\/english\/daily\/sheet$/, (req, { query }) => englishDaily.sheet({ from: query.from, to: query.to }))

/* --- 规划台（项目管理 + 备考清单 + 倒计时） --- */
/**
 * 长期目标数据，存 server/data/plan.json，前端与智能体读写同一份 ——
 * 外部脚本 / 智能体把整理出的项目进度写进来，面板就自动更新。
 * 倒计时由服务端按**本地日历日**算一份（今天 = 0），前端另有一份现算的用于跨天自增。
 */
route('GET', /^\/api\/plan\/panel$/, () => plan.panel())
/** 部分保存：只传要改的那几节（exams / projects / prep），没传的保持原样 */
route('POST', /^\/api\/plan\/save$/, (req, { body }) =>
  plan.save(body ?? {}, { baseRev: body?.baseRev, source: body?.source ?? 'web' }),
)
/** 单个项目的细粒度更新（智能体主入口，不必读全量再写全量） */
route('POST', /^\/api\/plan\/project$/, (req, { body }) => plan.upsertProject(body ?? {}))
/** 关键日期（考试 / 报名截止）的细粒度更新 */
route('POST', /^\/api\/plan\/exam$/, (req, { body }) => plan.upsertExam(body ?? {}))
/** 备考清单勾选 / 追加 */
route('POST', /^\/api\/plan\/prep$/, (req, { body }) => plan.updatePrep(body ?? {}))

/* --- 背单词 --- */
/**
 * 背单词数据的读写口。
 *
 * 存在 server/data/vocab/{lists,progress}.json，前端与智能体读写同一份 ——
 * 这是「网页里练、智能体帮你录词」能成立的前提。
 *
 * 两组接口分工：
 *   - snapshot + lists/progress 的整体替换：给前端用（本地缓存 ↔ 服务端，带 baseRev 防并发覆盖）；
 *   - list / words 的细粒度操作：给智能体与脚本用，不必读全量再写全量。
 */

route('GET', /^\/api\/vocab\/snapshot$/, () => vocab.snapshot())

/** 词单整体替换（前端写回）。baseRev=前端读到的版本号，不一致时服务端会留 .conflict 副本 */
route('POST', /^\/api\/vocab\/lists$/, (req, { body }) =>
  vocab.writeLists(body.lists ?? [], { baseRev: body.baseRev, source: body.source ?? 'web' }),
)
route('GET', /^\/api\/vocab\/lists$/, () => vocab.listSummaries())
/** 单个词单（含词条）；id 可以是词单 id，也可以是名称 */
route('GET', /^\/api\/vocab\/list$/, (req, { query }) => {
  const l = vocab.findList(query.id ?? query.name)
  return l ? { ok: true, list: l, words: l.words.length } : { ok: false, error: `没有找到词单：${query.id ?? query.name}` }
})
route('POST', /^\/api\/vocab\/list$/, (req, { body }) => vocab.createList(body ?? {}))
route('PATCH', /^\/api\/vocab\/list$/, (req, { body }) => vocab.updateList(body ?? {}))
route('DELETE', /^\/api\/vocab\/list$/, (req, { query }) => vocab.removeList(query.id ?? query.name))
/** 加词（智能体主入口）：listId/listName 省略则用唯一的词单，没有就新建；text 走解析器 */
route('POST', /^\/api\/vocab\/words$/, (req, { body }) => vocab.addWords(body ?? {}))
route('POST', /^\/api\/vocab\/words\/remove$/, (req, { body }) => vocab.removeWords(body ?? {}))
route('GET', /^\/api\/vocab\/words$/, (req, { query }) =>
  vocab.searchWords({ listId: query.listId ?? query.id, q: query.q, limit: Number(query.limit || 200) }),
)
/** 导出为「term\t释义」文本，便于智能体一次读走 */
route('GET', /^\/api\/vocab\/export$/, (req, { query }) => vocab.exportListText(query.id ?? query.name))
/** 学情：读汇总 / 整体替换（前端写回） */
route('GET', /^\/api\/vocab\/progress$/, () => vocab.progressSummary())
route('PUT', /^\/api\/vocab\/progress$/, (req, { body }) =>
  vocab.writeProgress(body ?? {}, { baseRev: body.baseRev, source: body.source ?? 'web' }),
)
route('GET', /^\/api\/vocab\/due$/, (req, { query }) =>
  vocab.dueQueue({ limit: Number(query.limit || 20), includeNew: query.includeNew !== '0' }),
)
route('GET', /^\/api\/vocab\/advice$/, (req, { query }) => vocab.reviewAdvice({ limit: Number(query.limit || 15) }))
route('GET', /^\/api\/vocab\/sessions$/, (req, { query }) =>
  vocab.listSessions({ limit: Number(query.limit || 10), includeAnswers: query.answers === '1' }),
)
route('POST', /^\/api\/vocab\/dedupe$/, (req, { body }) => vocab.dedupeLists(body ?? {}))
/**
 * 单词发音（有道词典公开音频的边车代理）。
 * 浏览器直连 dict.youdao.com 会被 CORS 挡住，所以这里代拉并落盘缓存。
 * q=单词，accent=us|uk；命中缓存就不再出网。
 */
route('GET', /^\/api\/vocab\/audio$/, async (req, { query, res }) => {
  const r = await vocab.fetchWordAudio(query.q ?? query.word ?? '', query.accent || 'us')
  if (!r.ok) {
    res.statusCode = 400
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ ok: false, error: r.error, spoken: r.spoken }))
    return 'handled'
  }
  // 用 setHeader 而不是 writeHead，避免冲掉上面 applyCors 已经写好的 Origin 头
  res.setHeader('Content-Type', 'audio/mpeg')
  res.setHeader('Content-Length', r.buffer.length)
  res.setHeader('Cache-Control', 'private, max-age=2592000')
  res.setHeader('X-Vocab-Audio-Cached', r.cached ? '1' : '0')
  res.setHeader('X-Vocab-Audio-Spoken', encodeURIComponent(r.spoken))
  res.end(r.buffer)
  return 'handled'
})


/* --- AI --- */

/**
 * 每日总结：生成 + **按天存档**。
 *
 * 存档这一步是后加的，理由：这份总结的用法是「第二天回头看昨天」，不是当场看一眼就扔。
 * 以前不落盘 → 关掉页面就没了、第二天打开还是空的。现在生成过就存在
 * server/data/ai-summaries.json，看板直接读（见下面的 GET）。
 */
route('POST', /^\/api\/ai\/summary$/, (req, { body }) =>
  timed('ai.summary', async () => {
    const r = await ai.dailySummary({ date: body.date })
    if (r.ok) summaries.save(r.date, r, { kind: 'recap', source: body.source ?? 'web' })
    return r
  }),
)
/**
 * 今天的行动建议：由「昨天的总结 + 今天的计划、词单与做题进度」现算，单独存档。
 * 与 recap 分开存 —— 一个回答「昨天怎么样」，一个回答「今天怎么过」，生命周期不同。
 */
route('POST', /^\/api\/ai\/today$/, (req, { body }) =>
  timed('ai.today', async () => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date ?? '')) ? body.date : dashboard.todayStr()
    // 「今天」的建议要站在昨天的总结上 —— 固定取 date 的前一天，别让模型自己去猜
    const recap = summaries.recapFor(summaries.shiftDate(date, -1))
    const r = await ai.todayBrief({ date, recap })
    if (r.ok) summaries.save(date, r, { kind: 'today', source: body.source ?? 'web' })
    return r
  }),
)
/** 读总结卡的整包数据：回顾（三级降级）+ 今天的建议存档 + 主线倒计时 */
route('GET', /^\/api\/ai\/daily$/, (req, { query }) => summaries.view(query.date))
/** 存档自检（有哪些日期、最近一份是哪天） */
route('GET', /^\/api\/ai\/summaries$/, () => summaries.status())
route('POST', /^\/api\/ai\/review$/, (req, { body }) => timed('ai.review', () => ai.reviewDraft({ date: body.date })))
route('POST', /^\/api\/ai\/ask$/, (req, { body }) => timed('ai.ask', () => ai.ask(body.question, { history: body.history })))
route('GET', /^\/api\/ai\/context$/, () => ai.gatherContext())

/* --- 访问控制 --- */

/**
 * 前端引导取令牌。
 * 只对「工作站自己的页面来源」开放，所以恶意网页拿不到（它的 Origin 不在白名单）。
 * 本机脚本能直接读 config.json，本来也不需要这个接口，所以无 Origin 也放行。
 */
route('GET', /^\/api\/auth\/token$/, () => ({
  ok: true,
  enabled: auth.authEnabled(),
  token: auth.authConfig().token ?? '',
  howto: '请求 /api/* 与 /mcp 时带 X-WS-Token: <token>（或 ?token=<token>）',
}))

/* --- 配置 --- */

/**
 * 可编辑字段的默认值（设置页「恢复默认值」用）。
 *
 * 从 DEFAULTS 取，不在前端硬编码一份 —— 两份默认值必然漂移，
 * 而且前端那份还不知道服务器实际装在哪。
 */
function editableDefaults() {
  const d = DEFAULTS
  const pick = (obj, keys) => {
    const out = {}
    for (const k of keys) if (obj?.[k] !== undefined) out[k] = obj[k]
    return out
  }
  return {
    newapi: pick(d.newapi, ['baseUrl']),
    ai: pick(d.ai, ['model', 'models', 'temperature', 'persona']),
    workstation: pick(d.workstation, ['autostartEntry', 'autostartLog']),
    pguard: pick(d.pguard, ['enabled', 'dataDir']),
    startupDir: d.startupDir,
  }
}

route('GET', /^\/api\/config$/, () => ({
  ok: true,
  config: publicConfig(),
  defaults: editableDefaults(),
  editable: CONFIG_EDITABLE,
  editableScalars: [...CONFIG_EDITABLE_SCALARS],
  path: CONFIG_PATH,
}))
/**
 * 改配置：**白名单式**放行，只允许改「服务地址 / 目录 / 自启开关」这类。
 *
 * 为什么不直接 saveConfig(body)：这个接口正是处理请求的那个进程自己的配置，
 * 一个手滑（或前端传了个多余字段）就能把边车配置写坏 —— 写坏之后连「打开设置页改回来」
 * 都做不到。所以逐字段过白名单，没列上的一律拒绝并在响应里点名。
 * 敏感项另有 SECRET_PATHS 与脱敏串拦截，见 config.mjs 的 saveConfig。
 *
 * 两张白名单（分节 / 标量）在 `server/lib/config-editable.mjs` —— 那里有「为什么分两张」
 * 的来龙去脉，以及加新配置项要动哪几处。它们被单独放一个文件，是为了能被
 * `scripts/tests/config-whitelist.test.mjs` 与 `DEFAULTS`、`config.example.json` 对账。
 */

/* --- pguard（工作台的进程守护引擎） ---
 *
 * 它**没有「结束任意进程」的接口** —— 手动结束会绕过演练开关与动作预算，那是它设计里
 * 就划掉的。能动手的只有规则自己，外加两个明确标注为「人点一下」的动作：
 * 释放某个进程的工作集（可逆）、清系统待机列表（要一次 UAC）。
 */
route('GET', /^\/api\/pguard\/status$/, () => pguard.status())
/** 引擎启停（停只是不判定，不去动已经在跑的进程） */
route('POST', /^\/api\/pguard\/engine$/, (req, { body }) => (body?.on === false ? pguard.stop() : pguard.start()))
/** 暂停/恢复判定（采样继续，只是不动手） */
route('POST', /^\/api\/pguard\/pause$/, (req, { body }) => pguard.setPaused(body?.on !== false, body?.reason))
/** 立即跑一轮判定（演练模式下只记录） */
route('POST', /^\/api\/pguard\/tick$/, () => pguard.tick({ force: true, source: 'manual' }))
/** 演练开关（想关掉它时若第三方那个还在跑，会被拒并说明原因 —— 两个守卫不能同时动手） */
route('POST', /^\/api\/pguard\/dry-run$/, (req, { body }) => pguard.setDryRun(body?.on !== false))
/** 改规则阈值等（白名单见 lib/pguard.mjs 的 EDITABLE） */
route('POST', /^\/api\/pguard\/settings$/, (req, { body }) => pguard.setSettings(body ?? {}))
/** 审计记录（字段与它原来的 actions.jsonl 一致，连 outcomeText 都照抄） */
route('GET', /^\/api\/pguard\/journal$/, (req, { query }) =>
  pguard.journal({
    limit: Number(query.limit) || 80,
    onlyActed: query.acted === '1',
    rule: query.rule || '',
    outcome: query.outcome || '',
  }),
)
/** 进程表（按工作台自己的采样窗口算瞬时 CPU） */
route('GET', /^\/api\/pguard\/processes$/, (req, { query }) =>
  pguard.processTable({ limit: Number(query.limit) || 60 }),
)
/** 名单增删（白名单两向可改；受保护名单只读 —— 那是安全网） */
route('POST', /^\/api\/pguard\/lists$/, (req, { body }) => pguard.listsOp(body ?? {}))
/** 手动释放某个进程的工作集（可逆动作，仍过保护层。不做「结束进程」的手动入口） */
route('POST', /^\/api\/pguard\/trim$/, (req, { body }) => pguard.trimPid(body?.pid))
/** 清系统待机列表 —— 需要提权，会弹一次 UAC（周期动作做不到，所以降级成按钮） */
route('POST', /^\/api\/pguard\/purge-standby$/, () => pguard.purgeStandby())
/* --- 进程守护的另外两页：端口 / 智能体 -------------------------------------------------
 * pguard 引擎覆盖了规则与进程表，但没有端口与智能体识别，这两页补上。
 * 数据来自 lib/procscan.mjs：一次全表快照（父子 + 命令行），判定过同一条保护层
 * （受保护名单 + 白名单）—— 见那个文件的头注释。
 */

/** 全表进程（带保护判定，页面上的「进程」补充视图） */
route('GET', /^\/api\/procscan\/processes$/, (req, { query }) =>
  procscan.listProcesses({ q: query.q || '', limit: Number(query.limit) || 300, sort: query.sort || 'ws' }),
)
/** 端口与连接（netstat -ano → 属主进程 → 是否受保护） */
route('GET', /^\/api\/procscan\/ports$/, (req, { query }) =>
  procscan.listPorts({ onlyListen: query.listen === '1', q: query.q || '', limit: Number(query.limit) || 300 }),
)
/** 智能体会话（子树；识别规则照 CliAgentCatalog，另加配置里的 agentExtras） */
route('GET', /^\/api\/procscan\/agents$/, () => procscan.listAgents())
/** 结束进程。**必须过保护层**（受保护/关键/会话0/系统目录/前台窗口/白名单一律拒），每次留审计。
 *  force=false 走温和结束（等价于发 WM_CLOSE）；tree=true 连子进程。 */
route('POST', /^\/api\/procscan\/end$/, (req, { body }) =>
  procscan.endProcess(Number(body?.pid), { tree: body?.tree === true, force: body?.force === true, by: '面板' }),
)
/** 结束整个智能体会话（逐个成员过保护层，被拒的会说明原因） */
route('POST', /^\/api\/procscan\/end-session$/, (req, { body }) =>
  procscan.endSession(Number(body?.pid), { force: true, by: '面板' }),
)
/** 工作台自己记的结束动作审计 */
route('GET', /^\/api\/procscan\/actions$/, (req, { query }) => procscan.actionLog(Number(query.limit) || 50))
/** 引擎自己的运行日志尾部 */
route('GET', /^\/api\/pguard\/log$/, (req, { query }) => ({ ok: true, ...pguard.readLog(Number(query.lines) || 40) }))

/* ------------------------------------------------------------------ 知识库 ---
 * 这些能力原先在一个独立的桌面应用里，现在搬进边车：
 * 库还是那个库（格式没动，仍是 schema.md + frontmatter + [[双链]]），只是读写通道换成了这里。
 * 读只允许 wiki/ 与 raw/，写只允许 wiki/ —— raw/ 是原始资料，只进不改。
 */
/* 边车自身：看看有几个实例在跑、手动清一次重复实例（对照 lib/singleton.mjs） */
route('GET', /^\/api\/self\/instances$/, async () => {
  const dups = await singleton.findDuplicates()
  const all = await singleton.listNodeProcesses()
  return {
    ok: true,
    self: process.pid,
    duplicates: dups.map((d) => ({ pid: d.pid, cmd: d.cmd.slice(0, 200) })),
    nodeCount: all.length,
  }
})
route('POST', /^\/api\/self\/reap$/, async () => {
  const dups = await singleton.findDuplicates()
  const killed = []
  for (const d of dups) {
    const r = await singleton.killPid(d.pid)
    killed.push({ pid: d.pid, killed: r.ok })
  }
  return { ok: true, found: dups.length, killed }
})

route('GET', /^\/api\/wiki\/status$/, () => ({ ok: true, ...wiki.status() }))
route('GET', /^\/api\/wiki\/tree$/, (req, { query }) => ({ ok: true, ...wiki.tree({ root: query.root || 'wiki', recursive: query.recursive !== '0' }) }))
route('GET', /^\/api\/wiki\/pages$/, (req, { query }) => {
  const type = query.type || ''
  const pages = wiki.listPages({ force: query.force === '1' }).filter((p) => (type ? p.type === type : true))
  return { ok: true, total: pages.length, pages }
})
/** 读一页（含 frontmatter 解析、出链与反链） */
route('GET', /^\/api\/wiki\/page$/, (req, { query }) => {
  const r = wiki.pageDetail(String(query.path ?? ''))
  return r.ok ? r : { ok: false, error: r.error }
})
/** 存一页（先备份再原子写） */
route('POST', /^\/api\/wiki\/page$/, (req, { body }) => wiki.writePage(String(body?.path ?? ''), String(body?.content ?? '')))
/** 改名/移动页面（原子 rename；目标已存在则拒绝。不会自动修别处的双链，体检页会报） */
route('POST', /^\/api\/wiki\/rename$/, (req, { body }) => wiki.renamePage(String(body?.from ?? ''), String(body?.to ?? '')))
/** 新建一页：只会生成带 frontmatter 的骨架，重名会被拒（不覆盖别人写的东西） */
route('POST', /^\/api\/wiki\/create$/, (req, { body }) => {
  const type = String(body?.type ?? 'concept')
  const slug = String(body?.slug ?? '').trim()
  if (!slug) return { ok: false, error: '请填 slug（文件名，英文 kebab-case）' }
  if (!wiki.TYPE_DIR[type]) return { ok: false, error: `未知类型：${type}` }
  const title = String(body?.title ?? slug)
  const rel = `${wiki.TYPE_DIR[type]}/${slug}.md`
  const content = wiki.stringifyFrontmatter(
    { type, title, tags: [], related: [], created: wiki.today(), updated: wiki.today() },
    `# ${title}\n\n`,
  )
  return wiki.writePage(rel, content)
})
route('POST', /^\/api\/wiki\/search$/, (req, { body }) =>
  body?.mode && body.mode !== 'lexical'
    ? wiki.searchHybrid(String(body?.query ?? ''), {
        topK: Number(body?.topK) || 10,
        includeContent: body?.includeContent === true,
        mode: body.mode === 'semantic' ? 'semantic' : 'auto',
      })
    : wiki.search(String(body?.query ?? ''), { topK: Number(body?.topK) || 10, scope: body?.scope || 'wiki', includeContent: body?.includeContent === true }),
)
route('GET', /^\/api\/wiki\/graph$/, (req, { query }) => wiki.graph({ q: query.q || '', type: query.type || '', limit: Number(query.limit) || 300 }))
route('GET', /^\/api\/wiki\/lint$/, () => wiki.lint())
route('POST', /^\/api\/wiki\/index-sync$/, (req, { body }) => wiki.syncIndex({ write: body?.write !== false }))
route('POST', /^\/api\/wiki\/log$/, (req, { body }) => wiki.appendLog(body?.lines ?? [], { date: body?.date }))
/** 抓一个外链（X 长文）落成 raw/sources 里的源文件 —— 只加不覆盖 */
route('POST', /^\/api\/wiki\/fetch$/, (req, { body }) =>
  wiki.fetchSource(String(body?.url ?? ''), { slug: body?.slug, overwrite: body?.overwrite === true }),
)
/** 编译入库：模型按 schema.md 把一份 raw 资料写成 wiki 页面。dryRun 只回计划不落盘 */
route('POST', /^\/api\/wiki\/ingest$/, (req, { body }) =>
  wiki.ingest(String(body?.source ?? ''), {
    dryRun: body?.dryRun === true,
    model: body?.model || undefined,
    types: body?.types || 'all',
  }),
)
/** 基于库内页面问答（先把命中页面喂进上下文，再要求标注依据） */
route('POST', /^\/api\/wiki\/ask$/, (req, { body }) =>
  wiki.ask(String(body?.question ?? ''), { topK: Number(body?.topK) || 6, history: body?.history ?? [] }),
)

/* ---- 多库：切库只换当前目录，从不删文件 ---- */
route('GET', /^\/api\/wiki\/projects$/, () => wiki.projects())
route('POST', /^\/api\/wiki\/projects\/set$/, (req, { body }) => wiki.setProject(body?.dir ?? body?.id ?? ''))
route('POST', /^\/api\/wiki\/projects\/add$/, (req, { body }) => wiki.addProject(String(body?.dir ?? ''), { name: body?.name }))
route('POST', /^\/api\/wiki\/projects\/remove$/, (req, { body }) => wiki.removeProject(body?.dir ?? body?.id ?? ''))
route('POST', /^\/api\/wiki\/projects\/init$/, (req, { body }) =>
  wiki.initProject(String(body?.dir ?? ''), { name: body?.name, language: body?.language }),
)

/* ---- 会话式问答：一次性 + 流式（SSE，逐字下发，工具轮次先报事件） ---- */
route('GET', /^\/api\/wiki\/chat\/sessions$/, (req, { query }) => ({ ok: true, sessions: wikiChat.sessions({ limit: Number(query.limit) || 50 }) }))
route('GET', /^\/api\/wiki\/chat\/session$/, (req, { query }) => wikiChat.getSession(String(query.id ?? '')))
route('POST', /^\/api\/wiki\/chat\/new$/, (req, { body }) => wikiChat.newSession({ title: body?.title }))
route('POST', /^\/api\/wiki\/chat\/rename$/, (req, { body }) => wikiChat.renameSession(String(body?.id ?? ''), body?.title))
route('POST', /^\/api\/wiki\/chat\/delete$/, (req, { body }) => wikiChat.deleteSession(String(body?.id ?? '')))
route('GET', /^\/api\/wiki\/chat\/skills$/, () => ({ ok: true, skills: wikiChat.skills() }))
/** 一次性问答（不带流式）：脚本/智能体用 */
route('POST', /^\/api\/wiki\/chat$/, (req, { body }) =>
  wikiChat.reply({
    sessionId: body?.sessionId,
    message: body?.message,
    regen: body?.regen === true,
    model: body?.model,
    skills: body?.skills ?? [],
    deep: body?.deep !== false,
    topK: Number(body?.topK) || 6,
    tools: body?.tools && typeof body.tools === 'object' ? body.tools : {},
    retrieval: body?.retrieval && typeof body.retrieval === 'object' ? body.retrieval : {},
  }),
)
/** 流式问答：data: {type:'tool'|'delta'|'done'|'error'}，与知识库问答同用一套帧格式 */
route('POST', /^\/api\/wiki\/chat\/stream$/, async (req, { body, res }) => {
  const write = (obj) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`)
    } catch {
      /* 客户端断了：下面 finally 会收尾 */
    }
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  const ctl = new AbortController()
  res.on('close', () => ctl.abort())
  try {
    const out = await wikiChat.reply({
      sessionId: body?.sessionId,
      message: body?.message,
      regen: body?.regen === true,
      model: body?.model,
      skills: body?.skills ?? [],
      deep: body?.deep !== false,
      topK: Number(body?.topK) || 6,
      tools: body?.tools && typeof body.tools === 'object' ? body.tools : {},
      retrieval: body?.retrieval && typeof body.retrieval === 'object' ? body.retrieval : {},
      signal: ctl.signal,
      onEvent: (e) => write(e),
    })
    if (!out.ok && !out.sessionId) write({ type: 'error', error: out.error })
  } catch (err) {
    write({ type: 'error', error: err.message })
  } finally {
    write({ type: 'end' })
    res.end()
  }
  return 'handled'
})

/* ---- 入库队列 + 源目录监听 ---- */
route('GET', /^\/api\/wiki\/queue$/, (req, { query }) => wikiQueue.list({ limit: Number(query.limit) || 200 }))
/**
 * 把页面里拖进来的文件落到临时目录并排队（Content-Type: application/octet-stream，文件名走 ?name=）。
 * 为什么要有这条：浏览器拿不到本地文件的真实路径（安全限制），所以拖拽只能走内容上传；
 * 「已经在硬盘上、路径已知」的文件请直接走 queue/add 的 kind=file，不必绕一圈。
 */
route('POST', /^\/api\/wiki\/upload$/, async (req, { body, query }) => {
  const buf = body?.__bin
  if (!buf?.length) return { ok: false, error: '没有收到文件内容（要用 application/octet-stream 发原文件）' }
  const raw = String(query.name ?? '').trim() || `upload-${Date.now().toString(36)}`
  const name = raw.replace(/[\\/:*?"<>|]/g, '_').slice(-120)
  const dir = path.join(loadConfig().dataDir, 'tmp', 'wiki-upload')
  fs.mkdirSync(dir, { recursive: true })
  const abs = path.join(dir, `${Date.now().toString(36)}-${name}`)
  fs.writeFileSync(abs, buf)
  const item = wikiQueue.add({ kind: 'file', target: abs.replace(/\\/g, '/'), title: name.replace(/\.[^.]+$/, ''), ingest: query.ingest !== '0' })
  return { ok: item.ok, size: buf.length, ...item, error: item.error }
})
route('POST', /^\/api\/wiki\/queue\/add$/, (req, { body }) =>
  wikiQueue.add({ kind: body?.kind, target: body?.target ?? body?.url ?? body?.path, title: body?.title, ingest: body?.ingest }),
)
route('POST', /^\/api\/wiki\/queue\/remove$/, (req, { body }) => wikiQueue.remove(String(body?.id ?? '')))
route('POST', /^\/api\/wiki\/queue\/clear$/, (req, { body }) => wikiQueue.clear({ status: body?.status || 'done' }))
route('POST', /^\/api\/wiki\/queue\/run$/, (req, { body }) => wikiQueue.run({ limit: Number(body?.limit) || 5 }))
route('GET', /^\/api\/wiki\/watch$/, () => wikiQueue.status())
route('POST', /^\/api\/wiki\/watch\/scan$/, (req, { body }) => wikiQueue.scan({ enqueue: body?.enqueue !== false }))
route('POST', /^\/api\/wiki\/watch\/settings$/, (req, { body }) => {
  const out = wikiQueue.setSettings(body ?? {})
  // 定时器跟着设置走：开/关/改周期都立刻生效，不用重启边车
  if (out.enabled) wikiQueue.startScheduler()
  else wikiQueue.stopScheduler()
  return out
})
/** 解析环境自检（pandoc / LibreOffice / Python / pdftotext / MinerU 云端 各自是否可用） */
route('GET', /^\/api\/wiki\/environment$/, () => wikiQueue.environment())
/** 云端解析（MinerU）：看一眼状态、真测一次、改参数 */
route('GET', /^\/api\/wiki\/mineru$/, async () => {
  const [ready, t] = [await wikiCloud.available(), wikiCloud.tokenStatus()]
  return { ok: true, ...wikiCloud.conf(), token: undefined, ready, tokenStatus: t }
})
route('GET', /^\/api\/wiki\/mineru\/test$/, () => wikiCloud.test())
/* ---- 模型配置（预设 / 任务路由 / 连通测试）---- */
route('GET', /^\/api\/wiki\/llm$/, () => wikiLlm.overview())
route('POST', /^\/api\/wiki\/llm$/, (req, { body }) => wikiLlm.save(body ?? {}))
route('GET', /^\/api\/wiki\/llm\/test$/, (req, { query }) => wikiLlm.test(query.id || undefined))
route('GET', /^\/api\/wiki\/llm\/presets$/, () => ({ ok: true, presets: wikiLlm.allPresets().map((p) => ({ ...p, apiKey: undefined })) }))
/** 这个任务这一档路由下能用的模型（问答页模型下拉用；名字必须是该端点认的，见 wiki-llm.mjs） */
route('GET', /^\/api\/wiki\/llm\/models$/, (req, { query }) => wikiLlm.models(String(query.task ?? 'chat')))

/* ---- 检索：网络搜索（7 家）+ 本机文件（AnyTXT） ---- */
route('GET', /^\/api\/wiki\/search-config$/, () => wikiWeb.status())
route('POST', /^\/api\/wiki\/search-config$/, (req, { body }) => wikiWeb.save(body ?? {}))
route('GET', /^\/api\/wiki\/search-config\/test$/, () => wikiWeb.test())
route('GET', /^\/api\/wiki\/websearch$/, (req, { query }) =>
  wikiWeb.webSearch(String(query.q ?? ''), { maxResults: Number(query.limit) || undefined }),
)
route('GET', /^\/api\/wiki\/anytxt$/, () => wikiWeb.anyTxtStatus())
route('GET', /^\/api\/wiki\/anytxt\/search$/, (req, { query }) =>
  wikiWeb.anyTxtSearch(String(query.q ?? ''), { maxResults: Number(query.limit) || undefined }),
)

route('POST', /^\/api\/wiki\/mineru$/, (req, { body }) => {
  const patch = {}
  for (const k of ['enabled', 'endpoint', 'modelVersion', 'language', 'isOcr', 'timeoutSec', 'token']) {
    if (body?.[k] !== undefined) patch[k] = body[k]
  }
  const out = saveConfig({ docparse: { mineru: patch } })
  return { ok: true, enabled: out.docparse?.mineru?.enabled, modelVersion: out.docparse?.mineru?.modelVersion, isOcr: out.docparse?.mineru?.isOcr, language: out.docparse?.mineru?.language }
})

/* ---- 语义检索（嵌入端点 + 本地向量索引） ---- */
route('GET', /^\/api\/wiki\/embed$/, () => ({ ok: true, ...wikiEmbed.indexStatus(wiki.listPages()) }))
route('GET', /^\/api\/wiki\/embed\/probe$/, () => wikiEmbed.probe())
/** 列嵌入端点上可选的模型（设置页「模型」下拉用；可带端点在参数里，便于先试后存） */
route('POST', /^\/api\/wiki\/embed\/models$/, (req, { body }) =>
  wikiEmbed.listModels({
    endpoint: body?.endpoint,
    apiKey: body?.apiKey,
    extraHeaders: body?.extraHeaders,
  }),
)
route('POST', /^\/api\/wiki\/embed\/build$/, async (req, { body }) => {
  const pages = wiki.pagesWithBody()
  const only = body?.path ? pages.filter((p) => p.path === body.path) : pages
  if (!only.length) return { ok: false, error: body?.path ? `没有这一页：${body.path}` : '库里没有可索引的页面' }
  // keepPaths 给整库：只补一页时也不能让别的页被 prune 掉（见 wiki-embed.mjs 的说明）
  return wikiEmbed.indexAll(only, { force: body?.force === true, keepPaths: pages.map((p) => p.path) })
})
route('POST', /^\/api\/wiki\/embed\/drop$/, () => wikiEmbed.drop())

/* ---- 体检动作（建页 / 编译 / 忽略 / 补索引） ---- */
route('POST', /^\/api\/wiki\/review\/action$/, (req, { body }) => wiki.reviewAction(body ?? {}))
route('GET', /^\/api\/wiki\/review\/ignored$/, () => wiki.reviewIgnored())
/** 库内图片（页面里引用的 raw/assets/*）：只放行图像扩展名，路径仍限制在 wiki/ 与 raw/ 内 */
route('GET', /^\/api\/wiki\/asset$/, (req, { query, res }) => {
  const got = wiki.assetPath(String(query.path ?? ''))
  if (!got.ok) return { ok: false, error: got.error }
  res.writeHead(200, { 'Content-Type': wiki.MIME[got.ext] ?? 'application/octet-stream', 'Cache-Control': 'private, max-age=3600' })
  fs.createReadStream(got.abs).pipe(res)
  return 'handled'
})

route('PATCH', /^\/api\/config$/, (req, { body }) => {
  // 兼容两种调用：{ patch: {...} } 或直接把分节名当键 { wiki: {...} }
  const patch = body?.patch && typeof body.patch === 'object' ? body.patch : body ?? {}
  const clean = {}
  const rejected = []
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'patch') continue
    // 标量项（outputLanguage / startupDir）：整项是一个字符串，别走下面的分节循环 ——
    // 那里的 `typeof v !== 'object'` 会把它们当「无效分节」拒掉（历史上真的这么拒过）。
    if (CONFIG_EDITABLE_SCALARS.has(k)) {
      clean[k] = typeof v === 'string' ? v : String(v ?? '')
      continue
    }
    const fields = CONFIG_EDITABLE[k]
    if (!fields || typeof v !== 'object' || v === null || Array.isArray(v)) {
      rejected.push(k)
      continue
    }
    const sub = {}
    for (const [fk, fv] of Object.entries(v)) {
      if (fields.includes(fk)) sub[fk] = fv
      else rejected.push(`${k}.${fk}`)
    }
    if (Object.keys(sub).length) clean[k] = sub
  }
  if (!Object.keys(clean).length) {
    return {
      ok: false,
      error: `没有可改的字段${rejected.length ? `（被拒绝：${rejected.join('、')}）` : ''}`,
      rejected,
    }
  }
  const r = saveConfig(clean)
  if (r && r.ok === false) return { ok: false, error: r.error ?? '保存失败', rejected }
  return { ok: true, saved: Object.keys(clean), rejected, config: publicConfig(), path: CONFIG_PATH }
})


/* ---------------------------------------------------------------- 资讯 ---
 * 读采集器的产物目录（配置 `collector.dir`，格式见 docs/news-contract.md）。
 * **采集不在这里做**：采集器是独立进程（scripts/collector-skeleton.mjs 是个最小示例），
 * 边车只负责读与算（分类 / 热度 / 时间线 / 案卷 / AI 事件卡）。
 */
route('GET', /^\/api\/news\/feed$/, () => newsfeed.feed())
route('GET', /^\/api\/news\/dashboard$/, (req, { query }) => newsBoard.dashboard({ force: query.force === '1' }))
route('POST', /^\/api\/news\/feedback$/, (req, { body }) => newsBoard.feedback(body))
route('POST', /^\/api\/news\/apply$/, (req, { body }) => newsBoard.apply(body))
route('POST', /^\/api\/news\/track$/, (req, { body }) => newsBoard.track(body))
route('GET', /^\/api\/news\/follow-status$/, () => newsBoard.followStatus())
route('POST', /^\/api\/news\/follow-push$/, () => newsBoard.followPush())
/** 现在概括：把最新一批原始条目交给模型，变成 AI 事件卡（要等它跑完） */
route('POST', /^\/api\/news\/digest$/, async () => {
  const d = await newsBoard.dashboard({ force: false })
  if (!d.ok) return d
  const r = await newsBoard.digestNow(d._rawItems ?? [])
  return r
})
route('GET', /^\/api\/news\/batches$/, (req, { query }) => newsfeed.batches(Number(query.limit) || 8))
route('GET', /^\/api\/news\/timeline$/, (req, { query }) => newsfeed.timeline(String(query.id ?? '')))
route('GET', /^\/api\/news\/case$/, (req, { query }) => newsfeed.caseFile(String(query.id ?? '')))
route('GET', /^\/api\/news\/reports$/, (req, { query }) => newsfeed.reports(Number(query.limit) || 20))
route('GET', /^\/api\/news\/report$/, (req, { query }) => newsfeed.report(String(query.file ?? '')))

/* -------------------------------------------------------------- 做题本 ---
 * 数据在 server/data/zuotiben.json，前端与智能体读写同一份。
 * **渲染不在这边**：一题一页的版式与公式排版走前端 `#/zuotiben/print`（复用 KaTeX 那套），
 * 服务端只出数据，免得两套公式管线要同时维护。
 */
route('GET', /^\/api\/zuotiben\/day$/, (req, { query }) => zuotiben.getDay(query.date))
route('GET', /^\/api\/zuotiben\/days$/, () => ({ ok: true, days: zuotiben.listDays(), stats: zuotiben.stats() }))
route('GET', /^\/api\/zuotiben\/range$/, (req, { query }) => ({ ok: true, problems: zuotiben.listRange({ from: query.from, to: query.to }) }))
/** 页眉右边的日期范围（「YYYY.MM.01 - YYYY.MM.末」这种参照物） */
route('GET', /^\/api\/zuotiben\/range-label$/, (req, { query }) => ({ ok: true, label: zuotiben.rangeLabel(query.date) }))
route('POST', /^\/api\/zuotiben\/add$/, (req, { body }) => zuotiben.addProblems({ ...(body ?? {}), source: 'web' }))
route('POST', /^\/api\/zuotiben\/problem$/, (req, { body }) =>
  // source 显式给 'web'：网页上点的和智能体写的要分得出来（不然 savedBy 全是 agent）
  zuotiben.updateProblem({ date: body?.date, id: body?.id, patch: { ...(body?.patch ?? {}), source: 'web' } }),
)
route('POST', /^\/api\/zuotiben\/remove$/, (req, { body }) =>
  zuotiben.removeProblem({ date: body?.date, id: body?.id, source: 'web' }),
)
route('POST', /^\/api\/zuotiben\/clear$/, (req, { body }) => zuotiben.clearDay({ date: body?.date, source: 'web' }))

/**
 * 导出 PDF：**真出文件**（本机 Chrome 的 `--print-to-pdf`），直接把字节回给浏览器下载。
 *
 * 为什么是 GET：前端拿 `fetch` 取了再转 blob 存盘，这样点一下就是「下载」，
 * 不会像 `window.open` 那样先跳一个页面出来。
 * 生成要十几秒，所以前端得配 loading；起不来浏览器（没装 Chrome/Edge）会回 400 + JSON 原因。
 */
route('GET', /^\/api\/zuotiben\/export$/, async (req, { query, res }) => {
  const r = await zuotibenExport.exportPdf({
    // 用请求自带的主机名，省得把端口写死（改端口时这里不用跟着改）
    baseUrl: `http://${req.headers.host || '127.0.0.1:5278'}`,
    // book=sentence 就是英语「每日一句」那本（走 #/zuotiben/sentence-print），默认是数学题目本
    book: query.book === 'sentence' ? 'sentence' : 'problem',
    date: query.date,
    from: query.from,
    to: query.to,
    mode: query.mode,
    orient: query.orient,
    withNote: query.note === '1',
    withVocab: query.vocab === '1',
    ansLayout: query.anslayout,
  })
  if (!r.ok) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: r.error }))
    return 'handled'
  }
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': String(r.bytes),
    // filename* 用 UTF-8 编码，中文名才不会变成乱码
    'Content-Disposition': `attachment; filename="${r.name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(r.name)}`,
    'Cache-Control': 'no-store',
  })
  fs.createReadStream(r.file).pipe(res)
  return 'handled'
})
/** 导出记录（排查「导过了但找不到文件」用） */
route('GET', /^\/api\/zuotiben\/exports$/, () => zuotibenExport.info())

/* --- 做题本：给智能体的三个口（作答总结 / 已学范围 / 推荐同类题） --- */
route('GET', /^\/api\/zuotiben\/review$/, (req, { query }) =>
  zuotiben.review({ date: query.date, from: query.from, to: query.to }),
)
route('GET', /^\/api\/zuotiben\/scope$/, () => ({ ok: true, scope: zuotiben.getScope() }))
/** 已学范围由智能体核过进度后写进来 —— 推荐同类题拿它当过滤器 */
route('POST', /^\/api\/zuotiben\/scope$/, (req, { body }) => zuotiben.setScope(body ?? {}))
/** 题库池总览（有哪些章、每章题数、解析齐不齐）—— 题库文件要自己按 docs/zuotiben-import.md 备 */
route('GET', /^\/api\/zuotiben\/pool$/, () => zuotibenSuggest.poolInfo())
/** 推荐同类题：按章/关键词筛、排掉做过的，返回可直接灌进做题本的题 */
route('GET', /^\/api\/zuotiben\/suggest$/, (req, { query }) =>
  zuotibenSuggest.suggestProblems({
    basis: query.basis,
    chapters: String(query.chapters ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter(Boolean),
    keywords: String(query.keywords ?? '')
      .split(/[,，|]/)
      .map((s) => s.trim())
      .filter(Boolean),
    limit: Number(query.limit) || 8,
  }),
)

/* ---------------------------------------------------- 语音随记（音频+转写） ---
 *
 * 链路：给一段音频 → 转写后端（OpenAI 兼容 /audio/transcriptions，见 lib/asr.mjs）
 *      → 大模型起标题写摘要 → 落成一条记录。
 *
 * 为什么「起任务 + 轮询」而不是一个请求里等完：转写是分钟级的，
 * Node 的 requestTimeout 默认 5 分钟，长音频会被掐。所以 upload / transcribe 都立刻
 * 返回 jobId，页面拿 job?id= 轮询 —— 这个任务模型与转写后端是谁无关。
 */

route('GET', /^\/api\/memo\/status$/, () => memo.status())

/** 转写后端配了没有 + 支持哪些音频格式（页面据此显示引导或操作区） */
route('GET', /^\/api\/memo\/asr$/, () => ({ ok: true, ...memo.asrStatus() }))

/** 改转写后端（设置页/随记配置页用）。密钥走 credentials.json，页面只拿得到末四位提示 */
route('POST', /^\/api\/memo\/asr$/, (req, { body }) => memo.setAsrBackend(body ?? {}))

/**
 * 上传音频（application/octet-stream + ?name=xx.wav），落进 data/memo/audio/，返回绝对路径。
 * 与知识库的上传同一条路数：二进制不走 JSON，别把它塞进 body。
 */
route('POST', /^\/api\/memo\/upload$/, (req, { body, query }) => {
  const buf = body?.__bin
  if (!buf?.length) return { ok: false, error: '没有收到文件内容（要用 application/octet-stream 发原文件）' }
  const abs = memo.stashUploadedAudio(String(query.name ?? ''), buf)
  return { ok: true, path: abs, bytes: buf.length }
})

/** 起一个转写任务：立刻回 jobId；转写与总结在后台跑 */
route('POST', /^\/api\/memo\/transcribe$/, (req, { body }) =>
  memo.startTranscribe({
    path: body?.path,
    name: body?.name,
    source: 'web',
    type: body?.type,
    category: body?.category,
    focus: body?.focus,
  }),
)

/** 轮询任务；转写完成后顺手带上落成的记录 */
route('GET', /^\/api\/memo\/job$/, (req, { query }) => memo.jobStatus(query.id))

/* 总结用哪个模型：清单来自模型配置（与知识库问答同源）；选了就存 server/data/memo/settings.json */
route('GET', /^\/api\/memo\/models$/, () => memo.models())

route('POST', /^\/api\/memo\/model$/, (req, { body }) => memo.setModel(body?.model))

/* 给 AI 的提示词：四段模板（总结/滚动摘要 × 系统/要求），`{{transcript}}` 是占位符 */
route('GET', /^\/api\/memo\/prompts$/, () => memo.prompts())

route('POST', /^\/api\/memo\/prompts$/, (req, { body }) => memo.setPrompts(body ?? {}))

route('GET', /^\/api\/memo\/records$/, (req, { query }) => ({ ok: true, records: memo.list({ limit: query.limit }) }))

route('GET', /^\/api\/memo\/record$/, (req, { query }) => {
  const record = memo.get(String(query.id ?? ''))
  if (!record) return { ok: false, error: `没有这条记录：${query.id ?? ''}` }
  return { ok: true, record }
})

/* 页面「导出 MD / 复制」：给一份 Markdown 全文（生成器与落盘的 records/*.md 是同一个） */
route('GET', /^\/api\/memo\/export$/, (req, { query }) => memo.exportDoc(String(query.id ?? '')))

route('POST', /^\/api\/memo\/rename$/, (req, { body }) => memo.rename(String(body?.id ?? ''), body?.title))

route('POST', /^\/api\/memo\/delete$/, (req, { body }) => memo.remove(String(body?.id ?? '')))

/* 整理前的那几个开关：记录类型（口述/访谈）、默认热词分类、是否自动学新词 */
route('GET', /^\/api\/memo\/options$/, () => ({ ok: true, options: memo.options(), hotwords: hotwords.list() }))

route('POST', /^\/api\/memo\/options$/, (req, { body }) => memo.setOptions(body ?? {}))

/* 热词库：分类 + 词表（页面「热词」页走这两条）；动作分支在 lib/hotwords.mjs 的 act() */
route('GET', /^\/api\/memo\/hotwords$/, () => ({ ok: true, ...hotwords.list() }))

route('POST', /^\/api\/memo\/hotwords$/, (req, { body }) => hotwords.act(body ?? {}))

/* 从一条已存的记录里再学一遍热词（自动学词关着、或事后改了分类时用） */
route('POST', /^\/api\/memo\/hotwords\/extract$/, (req, { body }) =>
  memo.learnFromRecord(String(body?.id ?? '')))

/* 记录的标签 / 分类 / 重点：标签可直接改，toHotwords=true 时顺手收进热词库 */
route('POST', /^\/api\/memo\/tags$/, (req, { body }) =>
  memo.setTags(String(body?.id ?? ''), body?.tags ?? [], { toHotwords: body?.toHotwords === true }))

route('POST', /^\/api\/memo\/category$/, (req, { body }) => memo.setCategory(String(body?.id ?? ''), body?.category))

route('POST', /^\/api\/memo\/focus$/, (req, { body }) => memo.setFocus(String(body?.id ?? ''), body?.focus))

/* 原始音频回放：按 Range 给 <audio>（拖进度条靠 206）；令牌走 ?token= */
route('GET', /^\/api\/memo\/audio$/, (req, { query, res }) => memo.streamAudio(req, res, String(query.id ?? '')))
/* 音频占用的两个口写在更宽的 /audio 之前，别被它抢走 */
route('GET', /^\/api\/memo\/audio\/usage$/, () => ({ ok: true, ...memo.audioUsage() }))
route('POST', /^\/api\/memo\/audio\/remove$/, (req, { body }) => memo.removeAudio(String(body?.id ?? '')))
/** 路径总览（数据目录 / 记录 / 音频 / 任务分别在哪） */
route('GET', /^\/api\/memo\/dir$/, () => ({ ok: true, ...memo.dir() }))

route('POST', /^\/api\/memo\/summarize$/, (req, { body }) =>
  timed('memo.summarize', () => memo.resummarize(String(body?.id ?? ''), { model: body?.model })))

/**
 * 流式总结（SSE）：边生成边把 Markdown 推给页面，结束时服务端已经解析并落盘。
 * 帧：{type:'start'} → {type:'delta', text} … → {type:'done', record} → {type:'end'}
 */
route('POST', /^\/api\/memo\/summarize\/stream$/, async (req, { body, res }) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  const ctl = new AbortController()
  res.on('close', () => ctl.abort())
  const write = (obj) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`)
    } catch {
      /* 页面断了就算了 */
    }
  }
  try {
    await memo.summarizeStream({
      id: String(body?.id ?? ''),
      model: body?.model,
      onEvent: write,
      signal: ctl.signal,
    })
  } catch (err) {
    write({ type: 'error', error: err?.message ?? String(err) })
  } finally {
    write({ type: 'end' })
    res.end()
  }
  return 'handled'
})

// ↓ 新接口加在这里（路由是「注册顺序 = 匹配顺序」，第一条命中就停：
//   更具体的 pattern 要写在更宽的**前面**；加完别忘了前端 src/core/sidecar.ts 里加一条，
//   以及需要被智能体调用时在 server/mcp.mjs 的 TOOLS / HANDLERS 各加一条）

/* --------------------------------------------------- 静态资源（生产） --- */

const DIST = path.join(ROOT_DIR, 'dist')
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
}

function serveStatic(req, res, urlPath) {
  if (!fs.existsSync(DIST)) {
    return send(
      res,
      200,
      '工作站边车已启动（未找到 dist/，开发模式请访问 Vite 的 5273 端口）\n\n' +
        `健康检查: http://${HOST}:${PORT}/api/health\n` +
        `MCP 端点:  http://${HOST}:${PORT}/mcp\n`,
    )
  }
  let rel = decodeURIComponent(urlPath.split('?')[0])
  if (rel === '/' || rel === '') rel = '/index.html'
  let file = path.join(DIST, rel)
  // 防目录穿越
  if (!file.startsWith(DIST)) return send(res, 403, 'forbidden')
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    /**
     * 缺文件分两种情况，混在一起会埋坑：
     *  - 静态资源（/assets/… 或带扩展名的）：**不能**回落 index.html。
     *    页面开着的时候重新 npm run build，chunk 名全换了一批，旧文件名会命中这个回落，
     *    浏览器拿 HTML 当 ES module 解析 → 报「MIME type of text/html」，
     *    到 Vue Router 那边只表现为「点了没反应，刷新才行」。给个干脆的 404，
     *    前端 router.onError 才认得出这是「构建换版了」并自愈重载。
     *  - 没有扩展名的路径：还是 hash 路由之外的深链，回落 index.html。
     */
    if (rel.startsWith('/assets/') || path.extname(rel) !== '') return send(res, 404, 'not found')
    file = path.join(DIST, 'index.html')
  }
  const ext = path.extname(file).toLowerCase()
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    // 缓存就一条原则：名字带内容哈希的长缓存，名字不变的每次核对。
    // index.html 名字固定、内容里写着当次的 chunk 名 —— 它被浏览器缓存住，
    // 刷新也拿不到新 chunk，同样回到「点了没反应」。
    'Cache-Control':
      rel.startsWith('/assets/') && ext !== '.html'
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
  })
  fs.createReadStream(file).pipe(res)
}

/* ------------------------------------------------------------ 启动 --- */


/**
 * 启动前先过单实例闸：把「同一个入口文件」的旧实例收掉（它们往往已经不再监听端口，
 * 只是窗口和进程挂着），见 lib/singleton.mjs。只为放掉自己人；端口被陌生进程占着就报错退出。
 */
async function startServer() {
  const gate = await singleton.enforce({ port: PORT, log: (m) => console.log(' ' + m) })
  if (!gate.ok) {
    console.error(`[单实例闸] ${gate.error}`)
    process.exit(1)
  }
  if (gate.reaped.length) {
    console.log(` 单实例闸: 回收了 ${gate.reaped.filter((r) => r.killed).length} 个旧边车实例（本次只保留这一个）`)
  }

    const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${HOST}:${PORT}`)
    const urlPath = url.pathname
    const query = Object.fromEntries(url.searchParams.entries())
    const origin = req.headers.origin

    // ---- 第 1 道闸：Origin 白名单 -------------------------------------------------
    // 浏览器发起的跨源请求一定带 Origin。不是工作站自己的页面来源，直接 403：
    // 这样别的网页连「探测端口上有什么」都做不到。
    applyCors(req, res, origin)
    if (origin && !auth.originAllowed(origin)) {
      return send(res, 403, {
        ok: false,
        error: '来源未被允许（Origin 不在白名单）',
        origin,
        hint: '如需放行，改 server/config.json 的 auth.allowedOrigins',
      })
    }

    if (req.method === 'OPTIONS') return send(res, 204, '')

    // ---- 第 2 道闸：本地令牌 -----------------------------------------------------
    // /api/auth/token 与 /api/health 免令牌；其余 /api/* 和 /mcp 必须带。
    if (auth.needsToken(urlPath) && !auth.tokenValid(req, query)) {
      return send(res, 401, auth.unauthorizedBody(urlPath))
    }

    // MCP 端点（POST=JSON-RPC，GET=SSE 保活/能力探测）
    if (urlPath === '/mcp') {
      const body = req.method === 'POST' ? await readBody(req) : null
      const out = await handleMcp({ req, res, body, method: req.method, send })
      if (out === 'handled') return
      return send(res, 200, out ?? { ok: true })
    }

    for (const r of routes) {
      if (r.method !== req.method) continue
      const m = urlPath.match(r.pattern)
      if (!m) continue
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {}
      // 处理器抛异常时必须自己接住：不接的话这个请求会**永远吊着**（响应发不出去，
      // 页面一直转圈、curl 一直挂）。加流式/代理类接口时踩过一次。
      let result
      try {
        result = await r.handler(req, { query, body, params: m.slice(1), res })
      } catch (err) {
        const msg = err?.stack ?? err?.message ?? String(err)
        console.error(`[路由] ${req.method} ${urlPath} 抛异常：`, msg)
        if (res.headersSent) {
          try {
            res.destroy()
          } catch {
            /* 已经在写了，断掉就好 */
          }
          return
        }
        return send(res, 500, { ok: false, error: `接口内部出错：${err?.message ?? String(err)}`, path: urlPath })
      }
      if (result === 'handled') return
      return send(res, 200, result ?? { ok: true })
    }

    if (urlPath.startsWith('/api/')) return send(res, 404, { ok: false, error: `未知接口 ${urlPath}` })
    return serveStatic(req, res, urlPath)
  })

  server.listen(PORT, HOST, async () => {
    console.log(`工作站边车已启动: http://${HOST}:${PORT}`)
    console.log(` 配置文件: ${CONFIG_PATH}`)
    if (fs.existsSync(DIST)) console.log(` 静态页面: http://${HOST}:${PORT}/`)
    else console.log(' 未找到 dist/，前端请用 npm run dev（5273）')
    console.log(` MCP 端点: http://${HOST}:${PORT}/mcp`)
    if (auth.authEnabled()) {
      console.log(' 访问控制: 已开启（Origin 白名单 + 本地令牌）')
      console.log(`   页面自动取令牌；MCP / 脚本调用请带 X-WS-Token，值见 ${CONFIG_PATH} 的 auth.token`)
    } else {
      console.log(' 访问控制: 已关闭（config.json 的 auth.enabled = false）—— 本机任何网页都能读写，慎用')
    }

    // 知识库源目录监听（默认关）：开了之后按周期扫监听目录，把新增/改过的文档排进入库队列。
    // 自动编译（watchAutoIngest）会花模型额度，单独一个开关，默认不动手。
    {
      const w = wikiQueue.status()
      if (w.enabled) {
        wikiQueue.startScheduler()
        console.log(
          ` 知识库监听: 每 ${w.intervalMin} 分钟扫一次（${w.dirsResolved.join('、')}，自动编译${w.autoIngest ? '开' : '关'}）`,
        )
      } else {
        console.log(' 知识库监听: 已关闭（页面「知识库 → 入库 → 源目录监听」里可开）')
      }
    }

    // NewAPI 用量缓存：读落盘缓存 → 两级定时同步（轻 liveSec / 全量 fullSec）→ 立即补一轮。
    // 模型用量页/打开即秒显缓存，不再每次现拉 NewAPI。
    usageCache.startSync()
    console.log(` 模型用量: 缓存同步已启动（轻 ${usageCache.LIVE_SEC}s / 全量 ${usageCache.FULL_SEC}s，环境变量 USAGE_LIVE_SEC/USAGE_FULL_SEC 可调）`)

    // overview 预热：启动 2s 后后台构建一次（结果落盘）。
    // 这样「双击启动 → 打开页面」时首屏直接命中缓存，看板秒开。
    setTimeout(() => {
      console.log('[overview] 启动预热：后台构建看板数据…')
      refreshOverview()
    }, 2000)

    // 进程守护引擎（pguard）：判定与动手都由边车做。
    // 放在启动流程的**最后**、并整体 try 住 —— 它不该把前面的子系统拖下水（这个回调里
    // 早先踩过「一步抛异常、后面整段被跳过」的坑，见 README 的启动回调那节）。
    try {
      const pg = pguard.start({ immediate: false })
      const pgc = pguard.engineConfig()
      if (pg.ok) {
        console.log(
          ` 进程守护: 引擎已启动（${pgc.dryRun ? '**演练模式**：只记录不动手' : '⚠ 真实执行'}，` +
            `判定线 CPU≥${pgc.cpuGuard.triggerPercent}%/${pgc.cpuGuard.triggerSustainSeconds}s，内存每 ${pgc.memory.intervalSeconds}s 一轮）`,
        )
      } else {
        console.log(` 进程守护: 引擎没起来（${pg.error}）`)
      }
    } catch (err) {
      console.error('[pguard] 引擎启动失败（不影响其它子系统）:', err.message)
    }
  })

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`端口 ${PORT} 已被占用。改 config.json 的 port，或先关掉旧实例。`)
    } else {
      console.error('边车启动失败：', err)
    }
    process.exit(1)
  })

  process.on('uncaughtException', (err) => {
    console.error('[uncaught]', err)
  })
  process.on('unhandledRejection', (err) => {
    console.error('[unhandled]', err)
  })
  process.on('SIGINT', () => {
    console.log('\n边车已停止')
    process.exit(0)
  })
}

// 边车没有子命令：启动即常驻。要有一次性任务，单独写脚本调 lib，别塞进这个入口 ——
// 塞进来会多一个「边车在不在跑」的状态要判断，之前那版就这么长出来的。
startServer()
