/**
 * 边车（sidecar）API 客户端。
 *
 * 前端所有「外部数据」都从这里走：看板与规划台、词单与每日一句、模型用量、
 * 知识库、语音随记、进程与端口、以及工作站自己的自启位。
 * 边车不在时（没启动 / 端口被占），所有调用返回 { ok:false }，页面显示引导而不是崩掉。
 *
 * 加一条新调用的规矩：**只在这个文件的 `api` 对象里加**，别在页面里裸 `fetch` ——
 * 这里统一处理令牌（401 自动重取一次）、超时与中文错误文案。见 docs/EXTENDING.md §3.3。
 */
import { ref } from 'vue'
import { readSseStream } from './sse'

/**
 * 边车地址。
 *
 * 生产态边车**同源**提供页面（dist 就是它发出去的），所以默认走**相对路径** ——
 * 不必写死 127.0.0.1:5278，换端口 / 换机器都不用改代码。
 * 开发态（Vite 5273）在 `.env.local` 里写 `VITE_SIDECAR_URL=http://127.0.0.1:5278`，
 * 或临时在 URL 上带 `?sidecar=host:port`。
 */
export const SIDECAR_URL = (import.meta.env?.VITE_SIDECAR_URL as string | undefined) ?? ''

/** 允许覆盖（例如你把边车放到别的端口）：在 URL 上带 ?sidecar=host:port */
function resolveBase(): string {
  try {
    const q = new URLSearchParams(location.search).get('sidecar')
    if (q) return /^https?:\/\//.test(q) ? q : `http://${q}`
  } catch {
    /* ignore */
  }
  const saved = localStorage.getItem('workstation.sidecar.url')
  if (saved) return saved
  return SIDECAR_URL
}

let base = resolveBase()
export function sidecarBase() {
  return base
}

/** 当前内存里的访问令牌（页面已经跟边车握过手之后才有） */
export function sidecarToken() {
  return token
}

/** 给 <img> 用：拼上边车地址和令牌（开发态前端在 5273，图片必须打到 5278） */
export function sidecarMedia(pathAndQuery: string) {
  const p = pathAndQuery.startsWith('/') ? pathAndQuery : `/${pathAndQuery}`
  const joiner = p.includes('?') ? '&' : '?'
  return `${base}${p}${token ? `${joiner}token=${encodeURIComponent(token)}` : ''}`
}
export function setSidecarBase(url: string) {
  base = url.replace(/\/+$/, '')
  token = null
  localStorage.setItem('workstation.sidecar.url', base)
}

/* ------------------------------------------------------------ 令牌 --- */

/**
 * 本地访问令牌。
 *
 * 边车开了访问控制后，/api/* 与 /mcp 都要求 X-WS-Token；页面自己没法读 config.json，
 * 所以通过 /api/auth/token 引导获取 —— 那个接口只认工作站自己的页面来源（Origin 白名单），
 * 别的网页拿不到。令牌只放内存，不放 localStorage：换牌子重启后自然重新取，避免用到过期值。
 */
let token: string | null = null
let tokenPromise: Promise<string | null> | null = null

async function ensureToken(force = false): Promise<string | null> {
  if (!force && token) return token
  if (!force && tokenPromise) return tokenPromise
  tokenPromise = (async () => {
    try {
      const res = await fetch(`${base}/api/auth/token`, { headers: { Accept: 'application/json' } })
      // 403 = 当前页面来源不在白名单（或边车没开访问控制时也能拿到）
      if (!res.ok) return null
      const j: any = await res.json().catch(() => null)
      token = typeof j?.token === 'string' && j.token ? j.token : null
      return token
    } catch {
      return null
    } finally {
      tokenPromise = null
    }
  })()
  return tokenPromise
}

/* ------------------------------------------------------------ 请求 --- */

export interface SidecarResult<T = any> {
  ok: boolean
  data?: T
  error?: string
  status?: number
}

async function call<T = any>(
  path: string,
  { method = 'GET', body, timeout = 30000 }: { method?: string; body?: unknown; timeout?: number } = {},
  retried = false,
): Promise<SidecarResult<T>> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeout)
  try {
    const t = await ensureToken()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (t) headers['X-WS-Token'] = t
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    })
    // 令牌被换过（比如改过 config.json）→ 清掉重取一次再试，别让用户看到莫名的 401
    if (res.status === 401 && !retried) {
      const fresh = await ensureToken(true)
      if (fresh) return call<T>(path, { method, body, timeout }, true)
    }
    const text = await res.text()
    let json: any
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    if (!res.ok) {
      return { ok: false, status: res.status, error: json?.error ?? `HTTP ${res.status}`, data: json }
    }
    return { ok: json?.ok !== false, data: json, error: json?.ok === false ? json?.error : undefined, status: res.status }
  } catch (err: any) {
    const msg =
      err?.name === 'AbortError'
        ? `请求超时（${timeout}ms）`
        : '连不上边车服务（可能没启动）。运行 npm run server 或双击 启动工作站.cmd'
    return { ok: false, error: msg, status: 0 }
  } finally {
    clearTimeout(timer)
  }
}

export const api = {
  health: () => call('/api/health', { timeout: 4000 }),
  overview: () => call('/api/overview', { timeout: 40000 }),

  /* NewAPI */
  /** 用量快照：服务端缓存，打开秒回；refresh=true 手动刷新（出网一轮） */
  newapiSnapshot: (refresh = false) =>
    call(`/api/newapi/snapshot${refresh ? '?refresh=1' : ''}`, { timeout: refresh ? 60000 : 15000 }),
  newapiSummary: () => call('/api/newapi/summary', { timeout: 60000 }),
  newapiBalance: () => call('/api/newapi/balance'),
  newapiTokens: () => call('/api/newapi/tokens'),
  newapiSpendToday: () => call('/api/newapi/spend/today', { timeout: 60000 }),
  newapiLogs: (pageSize = 30) => call(`/api/newapi/logs?pageSize=${pageSize}`, { timeout: 40000 }),

  /* 工作站自身（面板）。页面在「运行与自启」`#/service` */
  /** 当前边车进程：端口 / PID / node / 项目根 / 配置文件路径 */
  panelSidecar: () => call('/api/panel/sidecar', { timeout: 15000 }),
  /** 面板状态 + 自启位体检（编码 / 路径 / 用的哪个 node） */
  panelStatus: () => call('/api/panel/status', { timeout: 15000 }),
  /** 面板自启位操作：enable（生成/修复）· disable · remove · open-startup */
  panelAutostart: (action: 'enable' | 'disable' | 'remove' | 'open-startup') =>
    call('/api/panel/autostart', { method: 'POST', body: { action }, timeout: 20000 }),

  /* pguard —— 工作台的进程守护引擎 */
  /** 引擎状态：跑没跑、演练还是真打、实时 CPU/内存、阈值、今天的审计、最近一拍的判定说明 */
  pguardStatus: () => call('/api/pguard/status', { timeout: 30000 }),
  /** 引擎启停（停只是不判定，不去动已经在跑的进程） */
  pguardEngine: (on: boolean) => call('/api/pguard/engine', { method: 'POST', body: { on }, timeout: 30000 }),
  /** 暂停/恢复判定（采样继续） */
  pguardPause: (on: boolean, reason?: string) =>
    call('/api/pguard/pause', { method: 'POST', body: { on, reason }, timeout: 20000 }),
  /** 立即跑一轮判定 */
  pguardTick: () => call('/api/pguard/tick', { method: 'POST', timeout: 60000 }),
  /** 演练开关：关掉之后规则会真的动手，页面上会弹确认 */
  pguardSetDryRun: (on: boolean) =>
    call('/api/pguard/dry-run', { method: 'POST', body: { on }, timeout: 30000 }),
  /** 改规则阈值（服务端白名单放行） */
  pguardSettings: (patch: Record<string, unknown>) =>
    call('/api/pguard/settings', { method: 'POST', body: patch, timeout: 20000 }),
  /** 审计记录 */
  pguardJournal: (opts: { limit?: number; acted?: boolean; rule?: string; outcome?: string } = {}) => {
    const q = new URLSearchParams()
    if (opts.limit) q.set('limit', String(opts.limit))
    if (opts.acted) q.set('acted', '1')
    if (opts.rule) q.set('rule', opts.rule)
    if (opts.outcome) q.set('outcome', opts.outcome)
    const s = q.toString()
    return call(`/api/pguard/journal${s ? `?${s}` : ''}`, { timeout: 20000 })
  },
  /** 进程表（工作台自己采样，含开发工具标记与保护判定） */
  pguardProcesses: (limit = 60) => call(`/api/pguard/processes?limit=${limit}`, { timeout: 60000 }),
  /** 名单增删 */
  pguardLists: (body: { list: 'whitelist' | 'blacklist'; action: 'add' | 'remove' | 'toggle'; entry?: unknown; index?: number }) =>
    call('/api/pguard/lists', { method: 'POST', body, timeout: 20000 }),
  /** 手动释放某个进程的工作集（可逆动作） */
  pguardTrim: (pid: number) => call('/api/pguard/trim', { method: 'POST', body: { pid }, timeout: 60000 }),
  /** 清系统待机列表（提权，会弹一次 UAC，所以超时给得宽） */
  pguardPurgeStandby: () => call('/api/pguard/purge-standby', { method: 'POST', timeout: 180000 }),
  /** 引擎自己的运行日志尾部 */
  pguardLog: (lines = 40) => call(`/api/pguard/log?lines=${lines}`, { timeout: 20000 }),

  /* 进程守护补页：端口 / 智能体 */
  /** 端口与连接。listenOnly 默认只看 LISTENING */
  procPorts: (opts: { listenOnly?: boolean; q?: string } = {}) => {
    const q = new URLSearchParams()
    if (opts.listenOnly === false) q.set('listen', '0')
    if (opts.q) q.set('q', opts.q)
    const s = q.toString()
    return call(`/api/procscan/ports${s ? `?${s}` : ''}`, { timeout: 30000 })
  },
  /** 智能体会话（以智能体进程为根的子树，到 shell 为止） */
  procAgents: () => call('/api/procscan/agents', { timeout: 40000 }),
  /** 结束一个进程：必须先过保护层（被拒会带回原因），每次留审计 */
  procEnd: (pid: number, opts: { tree?: boolean; force?: boolean } = {}) =>
    call('/api/procscan/end', { method: 'POST', body: { pid, ...opts }, timeout: 40000 }),
  /** 结束整个智能体会话（逐个成员过保护层） */
  procEndSession: (pid: number) =>
    call('/api/procscan/end-session', { method: 'POST', body: { pid }, timeout: 90000 }),
  /** 工作台自己记的结束动作审计 */
  procActions: (limit = 50) => call(`/api/procscan/actions?limit=${limit}`, { timeout: 20000 }),

  /* 看板 */
  day: (date?: string) => call(`/api/dashboard/day${date ? `?date=${date}` : ''}`),
  patchDay: (date: string, patch: Record<string, unknown>) => call(`/api/dashboard/day?date=${date}`, { method: 'PATCH', body: patch }),
  recentDays: (limit = 14) => call(`/api/dashboard/recent?limit=${limit}`),
  /** 月历：某个月（YYYY-MM）的每日记录摘要，键为 YYYY-MM-DD */
  dashboardCalendar: (month?: string) => call(`/api/dashboard/calendar${month ? `?month=${month}` : ''}`),
  /**
   * 校历：某个月（YYYY-MM）每天的学校安排（是否上课 / 放假 / 考试周 / 第几教学周）。
   * 与 dashboardCalendar 是两个来源：那个是「我留了什么痕迹」，这个是「学校怎么安排」。
   */
  schoolCalendar: (month?: string) => call(`/api/calendar/school${month ? `?month=${month}` : ''}`),
  addPlan: (text: string, date?: string) => call(`/api/dashboard/plan${date ? `?date=${date}` : ''}`, { method: 'POST', body: { text } }),
  updatePlan: (id: string, patch: Record<string, unknown>, date?: string) =>
    call(`/api/dashboard/plan/update${date ? `?date=${date}` : ''}`, { method: 'POST', body: { id, patch } }),
  removePlan: (id: string, date?: string) => call(`/api/dashboard/plan/remove${date ? `?date=${date}` : ''}`, { method: 'POST', body: { id } }),
  addNote: (text: string, date?: string) => call(`/api/dashboard/note${date ? `?date=${date}` : ''}`, { method: 'POST', body: { text } }),
  removeNote: (id: string, date?: string) => call(`/api/dashboard/note/remove${date ? `?date=${date}` : ''}`, { method: 'POST', body: { id } }),

  /* 每日一句（句子库自备；指针做完才走，规则在 server/lib/english-daily.mjs） */
  englishDaily: () => call('/api/english/daily'),
  englishDailyComplete: (day: number, rating: 'good' | 'half' | 'lost') =>
    call('/api/english/daily/complete', { method: 'POST', body: { day, rating } }),
  /** 句子库：每天一句的摘要 + 自评状态 */
  englishDailyLibrary: () => call('/api/english/daily/library'),
  /** 单日详情（重练抽屉） */
  englishDailyDay: (day: number) => call(`/api/english/daily/day?day=${day}`),
  /** 打卡日志：最近 N 天做没做 */
  englishDailyLog: (days = 35) => call(`/api/english/daily/log?days=${days}`),

  /* AI */
  aiSummary: (date?: string) => call('/api/ai/summary', { method: 'POST', body: { date }, timeout: 180000 }),
  /** 今天的行动建议：由昨天的总结 + 今天的计划 / 记录 / 校历现算（单独存档） */
  aiToday: (date?: string) => call('/api/ai/today', { method: 'POST', body: { date }, timeout: 180000 }),
  /** 总结卡整包：回顾（三级降级）+ 今天的建议存档 */
  aiDaily: (date?: string) => call(`/api/ai/daily${date ? `?date=${date}` : ''}`),
  aiReview: (date?: string) => call('/api/ai/review', { method: 'POST', body: { date }, timeout: 180000 }),
  aiAsk: (question: string, history: { role: string; content: string }[] = []) =>
    call('/api/ai/ask', { method: 'POST', body: { question, history }, timeout: 180000 }),
  aiContext: () => call('/api/ai/context', { timeout: 60000 }),

  /* 背单词（数据存在 server/data/vocab/，与智能体读写同一份） */
  /** 词单 + 学情一次拿全，附带两端版本号（写回时用 baseRev 防并发覆盖） */
  vocabSnapshot: () => call('/api/vocab/snapshot', { timeout: 20000 }),
  /** 词单整体替换（前端写回） */
  vocabPutLists: (lists: unknown[], baseRev?: number, source = 'web') =>
    call('/api/vocab/lists', { method: 'POST', body: { lists, baseRev, source }, timeout: 30000 }),
  /** 学情整体替换（前端写回） */
  vocabPutProgress: (payload: Record<string, unknown>, baseRev?: number, source = 'web') =>
    call('/api/vocab/progress', { method: 'PUT', body: { ...payload, baseRev, source }, timeout: 30000 }),
  vocabListSummaries: () => call('/api/vocab/lists'),
  vocabList: (id: string) => call(`/api/vocab/list?id=${encodeURIComponent(id)}`),
  vocabExport: (id: string) => call(`/api/vocab/export?id=${encodeURIComponent(id)}`),
  /** 由智能体/MCP 写入后的场景：细粒度加词（text 走服务端解析器） */
  vocabAddWords: (body: { listId?: string; listName?: string; text?: string; words?: unknown[]; mode?: string }) =>
    call('/api/vocab/words', { method: 'POST', body, timeout: 30000 }),
  vocabProgress: () => call('/api/vocab/progress'),
  vocabDue: (limit = 20) => call(`/api/vocab/due?limit=${limit}`),
  vocabAdvice: () => call('/api/vocab/advice'),
  vocabSessions: (limit = 10) => call(`/api/vocab/sessions?limit=${limit}`),

  /* 规划台（长期目标：项目 + 备考清单 + 倒计时；存在 server/data/plan.json，
     与智能体读写同一份 —— 每日复盘可以把项目进度直接写进去） */
  /** 面板全量：关键日期（含 daysLeft）+ 项目 + 备考（含完成度）+ meta.rev */
  planPanel: () => call('/api/plan/panel', { timeout: 20000 }),
  /** 部分保存：只传要改的那几节（exams / projects / prep），带 baseRev 防并发覆盖 */
  planSave: (payload: {
    exams?: unknown[]
    projects?: unknown[]
    prep?: unknown[]
    baseRev?: number
    source?: string
  }) => call('/api/plan/save', { method: 'POST', body: payload, timeout: 20000 }),
  /** 单个项目细粒度更新（前端一般用整体保存，这个是给脚本/智能体的） */
  planUpsertProject: (payload: Record<string, unknown>) =>
    call('/api/plan/project', { method: 'POST', body: payload, timeout: 20000 }),
  /** 关键日期细粒度更新 */
  planUpsertExam: (payload: Record<string, unknown>) =>
    call('/api/plan/exam', { method: 'POST', body: payload, timeout: 20000 }),


  /* 配置 */
  config: () => call('/api/config', { timeout: 15000 }),
  /** 改配置：服务端白名单式放行，被拒字段会在 rejected 里点名 */
  patchConfig: (patch: Record<string, unknown>) =>
    call('/api/config', { method: 'PATCH', body: { patch }, timeout: 20000 }),

  /* 知识库（库是本地一个普通目录，路径在设置页里配） */
  /** 总览：页面数与类型分布、原始资料份数、还没编译的料、最近一次操作日期 */
  wikiStatus: () => call('/api/wiki/status', { timeout: 15000 }),
  /** 文件清单（含 raw 源文件）：root = wiki / sources / all */
  wikiTree: (root: 'wiki' | 'sources' | 'all' = 'wiki') => call(`/api/wiki/tree?root=${root}`, { timeout: 15000 }),
  /** 页面列表；type 可筛 concept / entity / source / query / comparison / synthesis */
  wikiPages: (type?: string) => call(`/api/wiki/pages${type ? `?type=${encodeURIComponent(type)}` : ''}`, { timeout: 15000 }),
  /** 读一页：正文 + frontmatter + 出链 + 反链 */
  wikiPage: (path: string) => call(`/api/wiki/page?path=${encodeURIComponent(path)}`, { timeout: 20000 }),
  /** 存一页（服务端会先备份旧版本） */
  wikiSave: (path: string, content: string) =>
    call('/api/wiki/page', { method: 'POST', body: { path, content }, timeout: 30000 }),
  /** 新建一页（只生成 frontmatter 骨架，重名会被拒） */
  wikiCreate: (payload: { type: string; slug: string; title?: string }) =>
    call('/api/wiki/create', { method: 'POST', body: payload, timeout: 20000 }),
  /** 改名/移动页面（原子 rename，目标存在则拒绝；不会自动修别处的双链） */
  wikiRename: (from: string, to: string) => call('/api/wiki/rename', { method: 'POST', body: { from, to }, timeout: 20000 }),
  /** 检索。mode: lexical=纯词法（快、可解释）/ auto=词法+语义融合 / semantic=只走向量 */
  wikiSearch: (
    query: string,
    opts: { topK?: number; scope?: 'wiki' | 'sources'; includeContent?: boolean; mode?: 'lexical' | 'auto' | 'semantic' } = {},
  ) => call('/api/wiki/search', { method: 'POST', body: { query, ...opts }, timeout: 60000 }),
  /** 双链图谱 */
  wikiGraph: (opts: { q?: string; type?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams(
      Object.entries(opts)
        .filter(([, v]) => v !== '' && v !== undefined)
        .map(([k, v]) => [k, String(v)]),
    )
    return call(`/api/wiki/graph${qs.toString() ? `?${qs.toString()}` : ''}`, { timeout: 30000 })
  },
  /** 结构体检（死链 / 孤立页 / 缺 frontmatter / 索引不同步 / 料没编译） */
  wikiLint: () => call('/api/wiki/lint', { timeout: 30000 }),
  /** 把没进 index.md 的页面补进去；write=false 只看要补哪些 */
  wikiIndexSync: (write = true) => call('/api/wiki/index-sync', { method: 'POST', body: { write }, timeout: 30000 }),
  /** 往 wiki/log.md 追加记录 */
  wikiLog: (lines: string[], date?: string) =>
    call('/api/wiki/log', { method: 'POST', body: { lines, date }, timeout: 20000 }),
  /** 抓外部链接（X 长文）落成 raw/sources 里的源文件，只加不覆盖 */
  wikiFetch: (url: string, opts: { slug?: string; overwrite?: boolean } = {}) =>
    call('/api/wiki/fetch', { method: 'POST', body: { url, ...opts }, timeout: 90000 }),
  /** 编译入库（dryRun 只回计划不落盘）。模型要写多页，超时放宽到 5 分钟 */
  wikiIngest: (source: string, opts: { dryRun?: boolean; model?: string; types?: string } = {}) =>
    call('/api/wiki/ingest', { method: 'POST', body: { source, ...opts }, timeout: 300000 }),
  /** 基于库内页面问答（回答会标依据；库里没有的它会说没有）—— 会话式见 wikiChatStream */
  wikiAsk: (question: string, opts: { topK?: number; history?: { role: string; content: string }[] } = {}) =>
    call('/api/wiki/ask', { method: 'POST', body: { question, ...opts }, timeout: 240000 }),

  /* 多库：切库只换当前目录，从不删文件 */
  wikiProjects: () => call('/api/wiki/projects', { timeout: 20000 }),
  wikiSetProject: (dir: string) => call('/api/wiki/projects/set', { method: 'POST', body: { dir }, timeout: 30000 }),
  wikiAddProject: (dir: string, name?: string) =>
    call('/api/wiki/projects/add', { method: 'POST', body: { dir, name }, timeout: 20000 }),
  wikiRemoveProject: (dir: string) => call('/api/wiki/projects/remove', { method: 'POST', body: { dir }, timeout: 20000 }),
  /** 把空目录初始化为知识库（只补缺，不覆盖已有文件） */
  wikiInitProject: (dir: string, name?: string) =>
    call('/api/wiki/projects/init', { method: 'POST', body: { dir, name }, timeout: 60000 }),

  /* 会话式问答 */
  wikiSessions: (limit = 50) => call(`/api/wiki/chat/sessions?limit=${limit}`, { timeout: 20000 }),
  wikiSession: (id: string) => call(`/api/wiki/chat/session?id=${encodeURIComponent(id)}`, { timeout: 20000 }),
  wikiNewSession: (title?: string) => call('/api/wiki/chat/new', { method: 'POST', body: { title }, timeout: 20000 }),
  wikiRenameSession: (id: string, title: string) =>
    call('/api/wiki/chat/rename', { method: 'POST', body: { id, title }, timeout: 20000 }),
  wikiDeleteSession: (id: string) => call('/api/wiki/chat/delete', { method: 'POST', body: { id }, timeout: 20000 }),
  /** 库内技能（.workstation-kb/skills/*.md），问答时可勾选注入 */
  wikiSkills: () => call('/api/wiki/chat/skills', { timeout: 20000 }),

  /* 入库队列 + 源目录监听 */
  wikiQueue: (limit = 100) => call(`/api/wiki/queue?limit=${limit}`, { timeout: 20000 }),
  /** kind: file（本地文件，先解析）/ url（X 链接）/ raw（已在 raw/ 里的源文件） */
  wikiQueueAdd: (payload: { kind: 'file' | 'url' | 'raw'; target: string; title?: string; ingest?: boolean }) =>
    call('/api/wiki/queue/add', { method: 'POST', body: payload, timeout: 30000 }),
  wikiQueueRemove: (id: string) => call('/api/wiki/queue/remove', { method: 'POST', body: { id }, timeout: 20000 }),
  wikiQueueClear: (status = 'done') =>
    call('/api/wiki/queue/clear', { method: 'POST', body: { status }, timeout: 20000 }),
  /** 跑一轮队列（抽文本 + 调模型编译，很慢，超时给到 10 分钟） */
  wikiQueueRun: (limit = 3) => call('/api/wiki/queue/run', { method: 'POST', body: { limit }, timeout: 600000 }),
  /**
   * 把拖进来的文件传给边车（原样二进制上传，落临时目录后排队）。
   * 浏览器读不到本地文件的真实路径，所以「已知路径的文件」应直接用 wikiQueueAdd({kind:'file'})。
   */
  wikiUpload: async (file: File, ingest = true): Promise<SidecarResult<any>> => {
    try {
      const t = await ensureToken()
      const res = await fetch(`${base}/api/wiki/upload?name=${encodeURIComponent(file.name)}&ingest=${ingest ? '1' : '0'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', ...(t ? { 'X-WS-Token': t } : {}) },
        body: file,
      })
      const json = await res.json().catch(() => null)
      return { ok: res.ok && json?.ok !== false, status: res.status, data: json, error: json?.error ?? (res.ok ? undefined : `HTTP ${res.status}`) }
    } catch (err: any) {
      return { ok: false, status: 0, error: err?.message ?? '上传失败（边车没起来？）' }
    }
  },
  wikiWatch: () => call('/api/wiki/watch', { timeout: 20000 }),  wikiWatchScan: (enqueue = true) => call('/api/wiki/watch/scan', { method: 'POST', body: { enqueue }, timeout: 60000 }),
  wikiWatchSettings: (patch: Record<string, unknown>) =>
    call('/api/wiki/watch/settings', { method: 'POST', body: patch, timeout: 20000 }),
  /** 解析环境自检：pandoc / LibreOffice / Python / pdftotext 各自是否可用 */
  wikiEnvironment: () => call('/api/wiki/environment', { timeout: 30000 }),

  /* 语义检索（嵌入端点 + 本地向量索引） */
  wikiEmbed: () => call('/api/wiki/embed', { timeout: 20000 }),
  wikiEmbedProbe: () => call('/api/wiki/embed/probe', { timeout: 30000 }),
  /** 建索引：不传 path 就建全库（一页约 0.3s，整库几十秒） */
  wikiEmbedBuild: (opts: { path?: string; force?: boolean } = {}) =>
    call('/api/wiki/embed/build', { method: 'POST', body: opts, timeout: 600000 }),
  wikiEmbedDrop: () => call('/api/wiki/embed/drop', { method: 'POST', timeout: 20000 }),
  /** 列嵌入端点上能选的模型（可带端点/key，用于「先试后存」） */
  wikiEmbedModels: (opts: { endpoint?: string; apiKey?: string; extraHeaders?: Record<string, string> } = {}) =>
    call('/api/wiki/embed/models', { method: 'POST', body: opts, timeout: 30000 }),

  /* 体检动作：create-page（补缺页骨架）/ compile（丢进队列编译）/ ignore / sync-index */
  wikiReviewAction: (payload: { id?: string; action: string; target?: string; path?: string; from?: string }) =>
    call('/api/wiki/review/action', { method: 'POST', body: payload, timeout: 120000 }),
  wikiReviewIgnored: () => call('/api/wiki/review/ignored', { timeout: 20000 }),

  /* 模型配置（预设 / 任务路由 / 连通测试） */
  wikiLlm: () => call('/api/wiki/llm', { timeout: 20000 }),
  wikiLlmPresets: () => call('/api/wiki/llm/presets', { timeout: 20000 }),
  /** patch：{ activePresetId?, taskRouting?, reasoning?, maxContextSize?, config?: {id, baseUrl, model, apiKey, apiMode, maxContextSize} } */
  wikiLlmSave: (patch: Record<string, unknown>) => call('/api/wiki/llm', { method: 'POST', body: patch, timeout: 30000 }),
  wikiLlmTest: (id?: string) => call(`/api/wiki/llm/test${id ? `?id=${encodeURIComponent(id)}` : ''}`, { timeout: 120000 }),
  /** 某个任务（chat / ingest）这一档路由下能用的模型 —— 名字得是该端点认的 */
  wikiLlmModels: (task: 'chat' | 'ingest' = 'chat') =>
    call(`/api/wiki/llm/models?task=${task}`, { timeout: 30000 }),

  /* 检索：网络搜索（7 家 provider）+ 本机文件（AnyTXT） */
  wikiSearchConfig: () => call('/api/wiki/search-config', { timeout: 20000 }),
  wikiSearchConfigSave: (patch: Record<string, unknown>) =>
    call('/api/wiki/search-config', { method: 'POST', body: patch, timeout: 30000 }),
  wikiSearchTest: () => call('/api/wiki/search-config/test', { timeout: 60000 }),
  /** 网络搜索一次（结果 {title,url,snippet,source}） */
  wikiWebSearch: (q: string, limit?: number) =>
    call(`/api/wiki/websearch?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ''}`, { timeout: 60000 }),
  wikiAnyTxtStatus: () => call('/api/wiki/anytxt', { timeout: 30000 }),
  wikiAnyTxtSearch: (q: string, limit?: number) =>
    call(`/api/wiki/anytxt/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ''}`, { timeout: 60000 }),

  /* 云端文档解析（MinerU）：状态 / 保存设置 / 测连通 */
  wikiMineru: () => call('/api/wiki/mineru', { timeout: 20000 }),
  wikiMineruSave: (patch: Record<string, unknown>) => call('/api/wiki/mineru', { method: 'POST', body: patch, timeout: 20000 }),
  wikiMineruTest: () => call('/api/wiki/mineru/test', { timeout: 60000 }),

  /* 语音随记（上传音频 → 转写后端 → 大模型总结） */
  /** 整体状态：转写后端配没配、最近的任务、记录条数 */
  memoStatus: () => call('/api/memo/status', { timeout: 15000 }),
  /** 转写后端状态 + 支持的音频格式（页面据此显示引导或操作区） */
  memoAsr: () => call('/api/memo/asr', { timeout: 15000 }),
  /** 上传音频（二进制走 octet-stream，不塞 JSON），返回落盘的绝对路径 */
  memoUpload: (name: string, file: Blob) =>
    fetch(`${base}/api/memo/upload?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', ...(token ? { 'X-WS-Token': token } : {}) },
      body: file,
    }).then(async (res) => {
      const j: any = await res.json().catch(() => null)
      return { ok: res.ok, data: j, error: res.ok ? undefined : (j?.error ?? `HTTP ${res.status}`) } as any
    }),
  /** 起一个转写任务，立刻返回 jobId（转写与总结在后台跑） */
  memoTranscribe: (path: string, name?: string) =>
    call('/api/memo/transcribe', { method: 'POST', body: { path, name }, timeout: 30000 }),
  /** 轮询一个任务；转写完成后顺手带上落成的记录 */
  memoJob: (id: string) => call(`/api/memo/job?id=${encodeURIComponent(id)}`, { timeout: 30000 }),
  /** 总结用哪个模型（清单与知识库问答同源） */
  memoModels: () => call('/api/memo/models', { timeout: 20000 }),
  memoSetModel: (model: string) => call('/api/memo/model', { method: 'POST', body: { model }, timeout: 20000 }),
  /** 给 AI 的提示词模板（四段；`{{transcript}}` 占位符，空串 = 回默认） */
  memoPrompts: () => call('/api/memo/prompts', { timeout: 20000 }),
  memoSetPrompts: (prompts: Record<string, string>) =>
    call('/api/memo/prompts', { method: 'POST', body: prompts, timeout: 20000 }),
  memoRecords: (limit = 50) => call(`/api/memo/records?limit=${limit}`, { timeout: 20000 }),
  memoRecord: (id: string) => call(`/api/memo/record?id=${encodeURIComponent(id)}`, { timeout: 20000 }),
  /** 一条记录的 Markdown 全文 + 建议文件名（「复制」和「导出 MD」都用它） */
  memoExport: (id: string) => call(`/api/memo/export?id=${encodeURIComponent(id)}`, { timeout: 20000 }),
  memoRename: (id: string, title: string) =>
    call('/api/memo/rename', { method: 'POST', body: { id, title }, timeout: 20000 }),
  memoDelete: (id: string) => call('/api/memo/delete', { method: 'POST', body: { id }, timeout: 20000 }),
  memoSummarize: (id: string, model = '') =>
    call('/api/memo/summarize', { method: 'POST', body: { id, model }, timeout: 300000 }),

  // ↓ 新接口加在这里（与 server/index.mjs 里那条 route() 一一对应；
  //   加完顺手看一眼 docs/EXTENDING.md §3.3 的三条约定：只在这里发请求、别裸 fetch、超时按任务时长给）
}

export type MemoSummaryEvent =
  | { type: 'start'; id?: string; model?: string; mode?: string; chunks?: number }
  | { type: 'stage'; phase?: 'part' | 'merge'; index?: number; total?: number; chars?: number; title?: string; running?: boolean; failed?: boolean }
  | { type: 'reasoning'; text: string; chars?: number }
  | { type: 'tick'; elapsedSec: number; phase?: string; reasoningChars?: number }
  | { type: 'delta'; text: string }
  | { type: 'done'; id?: string; title?: string; record?: any }
  | { type: 'error'; error: string }
  | { type: 'end' }

/**
 * 语音随记的流式总结：边生成边回调 Markdown 增量，服务端在结束时已经解析并落盘。
 * 停止录音后走这条（不然要盯着空屏干等十几秒）；「重新总结」也走它。
 *
 * 读流那套（POST + 空行分帧 + 半帧容错）在 core/sse.ts，这里只管把失败翻成事件。
 */
export async function memoSummarizeStream(
  id: string,
  onEvent: (e: MemoSummaryEvent) => void,
  signal?: AbortSignal,
  model = '',
): Promise<void> {
  await readSseStream(`${base}/api/memo/summarize/stream`, { id, model }, onEvent, {
    signal,
    getToken: ensureToken,
    onFailure: (f) => {
      if (f.kind === 'http') onEvent({ type: 'error', error: `边车返回 HTTP ${f.status}` })
      else if (f.kind === 'no-body') onEvent({ type: 'error', error: '边车没有返回流（当前环境不支持流式读取）' })
      else if (f.kind === 'exception') onEvent({ type: 'error', error: f.error?.message ?? '流式请求失败' })
      /* abort（自己点的停止）：静默，什么都不发 */
    },
  })
}

/* --------------------------------------------------- 连接状态（全局） --- */

export type SidecarState = 'unknown' | 'online' | 'offline'

const state = ref<SidecarState>('unknown')
const info = ref<Record<string, any> | null>(null)
let probing: Promise<boolean> | null = null

export function sidecarState() {
  return state
}
export function sidecarInfo() {
  return info
}

/** 探测边车是否可用（并发调用只探一次） */
export async function ensureSidecar(force = false): Promise<boolean> {
  if (!force && state.value === 'online') return true
  if (probing) return probing
  probing = (async () => {
    const r = await api.health()
    if (r.ok) {
      state.value = 'online'
      info.value = r.data ?? null
      return true
    }
    state.value = 'offline'
    return false
  })()
  try {
    return await probing
  } finally {
    probing = null
  }
}

/** 在组件里用：等待边车就绪；未就绪时给出可复制的启动提示 */
export function sidecarHint(): string {
  return '在项目根目录运行 npm run server，或双击 启动工作站.cmd'
}

/* ------------------------------------------------- 流式（知识库问答） --- */

/** 知识库问答的一帧。字段与边车 lib/wiki-chat.mjs 的 onEvent 一一对应 */
export interface WikiChatEvent {
  type: 'tool' | 'delta' | 'reasoning' | 'done' | 'error' | 'end'
  /** tool：工具名（检索 / 补检索） */
  name?: string
  detail?: string
  text?: string
  error?: string
  sessionId?: string
  sessionTitle?: string
  references?: { path: string; title: string; type?: string; score?: number; via?: string; kind?: string; snippet?: string }[]
  usage?: any
  elapsedMs?: number
  partial?: boolean
  contextChars?: number
}

/**
 * 知识库流式问答：边车把「检索 → 补检索 → 逐字作答」按帧下发。
 * 与语音随记那条流同一套读法（都在 core/sse.ts）。
 */
export async function wikiChatStream(
  body: {
    message: string
    sessionId?: string
    /** 重试：message 可以不传 —— 服务端会取会话里最后一条用户消息重跑，并替换掉旧回复 */
    regen?: boolean
    model?: string
    skills?: string[]
    deep?: boolean
    topK?: number
    /** 检索来源开关：库内永远开，网络 / 本机文件按需 */
    tools?: { web?: boolean; anytxt?: boolean }
    retrieval?: {
      webTopK?: number
      anyTxtTopK?: number
      /** 检索模式：auto（有索引就混合）/ lexical（只词法）/ semantic（只语义） */
      mode?: 'auto' | 'lexical' | 'semantic'
      /** 上下文预算（字）：覆盖 config 的 wiki.maxChars */
      maxChars?: number
      /** 回答输出上限（token）：覆盖 config 的 wiki.chatMaxTokens */
      chatMaxTokens?: number
    }
  },
  onEvent: (e: WikiChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  await readSseStream(`${base}/api/wiki/chat/stream`, body, onEvent, {
    signal,
    getToken: ensureToken,
    onFailure: (f) => {
      if (f.kind === 'http') {
        onEvent({ type: 'error', error: `边车返回 HTTP ${f.status}${f.text ? `：${f.text.slice(0, 200)}` : ''}` })
      } else if (f.kind === 'no-body') {
        onEvent({ type: 'error', error: '边车没有返回流（当前环境不支持流式读取）' })
      } else if (f.kind === 'abort') {
        onEvent({ type: 'end' })
      } else if (f.kind === 'exception') {
        onEvent({ type: 'error', error: f.error?.message ?? '流式请求失败' })
      }
    },
  })
}
