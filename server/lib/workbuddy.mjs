/**
 * WorkBuddy2API 网关客户端（把上游账号包成 OpenAI 兼容 API）。
 *
 * 网关**不随本仓库分发**：自己装一份，把目录填进 `config.workbuddy.dir`（监听地址默认
 * 127.0.0.1:7863，可用 `config.workbuddy.baseUrl` 改）。目录留空时本模块所有动作都给
 * 同一句提示（见 needsDir），不假装能用。
 *
 * 三个数据源各管一件事：
 *  - `/status`    账号池状态：每个号的积分、冷却 / 熔断 / 停用、在途请求。纯内存，毫秒级。
 *  - `/v1/stats`  网关自己记的调用统计：请求数、成功失败、token、缓存命中、销号积分。
 *  - `credit.exe` 回上游查**真实积分包**（/v2/billing/meter/get-user-resource）：
 *                 remain / used / size 与套餐数。要出网约 1.6s，所以只走缓存后台刷。
 *
 * 为什么不直接调上游查积分：realm 路由（国内版 / 国际版各一个域名）与多账号遍历、
 * 200ms 间隔防限流都在 credit.exe 里，重写一遍只会多一处不同步。这里复用它的 JSON 输出。
 *
 * API key 不落在本模块：从网关自己的 config.json 读，保持单一来源。
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../config.mjs'
import { request, runHidden, spawnHidden, isPortOpen, pidOnPort, killPid, sleep } from './net.mjs'
import * as autostart from './autostart.mjs'

let mem = null
let refreshing = false
/** 正在跑的那一轮积分刷新（wait=true 的调用者等它） */
let refreshPromise = null
/** 模型清单刷新的并发锁 */
let modelsBusy = false

/** 缓存落盘位置：与 NewAPI 用量缓存同目录 */
function cacheFile() {
  const dir = process.env.WS_DATA_DIR || loadConfig().dataDir
  return path.join(dir, 'workbuddy-cache.json')
}

/* --------------------------------------------------------- 网关配置 --- */

/**
 * 网关根目录（Windows 路径）。由 `config.workbuddy.dir` 指定，**留空 = 没配**。
 * 没配时不去拼 `/config.json` 这种怪路径，一律先返回下面那句提示。
 */
function gatewayDir() {
  return String(loadConfig().workbuddy?.dir ?? '').replace(/\\/g, '/')
}

/** 网关目录没配时的统一提示（返回空串 = 配了） */
function needsDir() {
  return gatewayDir()
    ? ''
    : '还没配网关目录：到「网关配置」页填 config.workbuddy.dir（网关是你自己装的那一份，不随本仓库分发）'
}

/* ------------------------------------------------------- 账号池主机清单 --- */

/**
 * 账号池可以有多台机器：本机那份 + `config.workbuddy.hosts[]` 里的远端主机。
 *
 * 远端直接给 baseUrl —— 网关在那边怎么监听、怎么让本机够得到（局域网地址、隧道域名、
 * 内网主机名都行）是你自己的事，本仓库不假定用哪种网络把两台机器连起来。
 *
 * 远端的 api key 不写在 config.json 里，值放 credentials.json 的
 * `llm.keys['workbuddy-<id>']`：与站点其它密钥同一处，config.json 保持「可以随便贴给人看」。
 */
export function hosts() {
  const cfg = loadConfig().workbuddy ?? {}
  const list = [
    {
      id: 'local',
      name: cfg.label || '本机',
      kind: 'local',
      baseUrl: String(cfg.baseUrl ?? 'http://127.0.0.1:7863').replace(/\/+$/, ''),
      note: '',
    },
  ]
  for (const h of Array.isArray(cfg.hosts) ? cfg.hosts : []) {
    if (!h?.id || !h?.baseUrl) continue
    list.push({
      id: String(h.id),
      name: String(h.name ?? h.id),
      kind: 'remote',
      baseUrl: String(h.baseUrl).replace(/\/+$/, ''),
      note: String(h.note ?? ''),
      // 需要跨机做的事（查真实积分包、触发活动任务、读那边排程）都靠这几项：
      // ssh = 用哪个 SSH 别名连过去；三个 *Script = 那边机器上的脚本路径，留空 = 不支持这件事。
      ssh: String(h.ssh ?? ''),
      creditScript: String(h.creditScript ?? ''),
      runScript: String(h.runScript ?? ''),
      scheduleScript: String(h.scheduleScript ?? ''),
    })
  }
  return list
}

/** 按 id 取主机；id 不认识就退回本机（页面拿到的是永远可用的东西） */
function pickHost(host) {
  const id = typeof host === 'string' ? host : host?.id
  const list = hosts()
  return list.find((h) => h.id === id) ?? list[0]
}

/** 主机基础地址，末尾不带斜杠 */
function base(host) {
  return pickHost(host).baseUrl
}

/**
 * 读本机网关的 api_key。文件不存在 / 解析失败都返回空串——上层据此提示「未配置」，
 * 而不是把异常抛到页面。
 */
function apiKey() {
  try {
    const raw = fs.readFileSync(path.join(gatewayDir(), 'config.json'), 'utf8')
    return JSON.parse(raw)?.api_key ?? ''
  } catch {
    return ''
  }
}

/** 该主机的 api key：本机读网关自己的 config.json，远端读 credentials 的 llm.keys[workbuddy-<id>] */
function hostKey(host) {
  const item = pickHost(host)
  if (item.kind === 'local') return apiKey()
  return loadConfig().llm?.keys?.[`workbuddy-${item.id}`] ?? ''
}

function authHeaders(host) {
  return { Authorization: `Bearer ${hostKey(host)}`, 'Content-Type': 'application/json' }
}

/**
 * 跨池矩阵：把每台账号池主机的账号摊在一张表里，用来发现「同一个号同时在两个池里」。
 *
 * 为什么要专门做这件事：同一个账号被两处使用，一是上游可能按异常登录风控，
 * 二是定时的 token 保活会从两边各刷一次 —— 轮换式 refreshToken 下互相顶掉，
 * 谁先刷谁把对方挤下线。搬号做实验时不容易发现，摊开看最直观。
 *
 * 每台主机单独超时、失败只标记该行，不拖垮整张表。
 */
export async function matrix() {
  const list = hosts()
  const rows = await Promise.all(
    list.map(async (h) => {
      const alive = await reachable(h)
      if (!alive.ok) return { id: h.id, name: h.name, kind: h.kind, ok: false, error: alive.error, accounts: [] }
      const st = await status(h)
      return {
        id: h.id,
        name: h.name,
        kind: h.kind,
        ok: !!st.ok,
        error: st.ok ? null : st.error ?? null,
        accounts: (st.accounts ?? []).map((a) => ({ uid: a.uid, nickname: a.nickname, realm: a.realm, credits: a.credits ?? 0 })),
      }
    }),
  )
  // 出现在 ≥2 台主机上的 uid
  const seen = new Map()
  for (const r of rows) for (const a of r.accounts) seen.set(a.uid, (seen.get(a.uid) ?? 0) + 1)
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([uid]) => {
    const hostIds = rows.filter((r) => r.accounts.some((a) => a.uid === uid)).map((r) => r.id)
    const nick = rows.flatMap((r) => r.accounts).find((a) => a.uid === uid)?.nickname ?? uid.slice(0, 8)
    return { uid, nickname: nick, hosts: hostIds }
  })
  return { ok: true, hosts: rows, duplicates }
}

/**
 * 只能在本机做的手术（查真实积分包要走本机的 credit.exe；日志、启停、配置同理）。
 * 远端主机不是不能读数据，只是这些动作在那边没有对应物 —— 明说比静默失败强。
 */
function localOnly(host, what) {
  const item = pickHost(host)
  if (item.kind === 'local') return null
  return { ok: false, error: `${what}只能在本机账号池上做（${item.name} 是远端主机）`, host: item.id }
}

/**
 * 连接凭据（给页面「怎么用」那张表用）。
 *
 * 与其他密钥同一个立场：**明文只在服务端**，且只在明确要的时候才下发。
 * reveal=false（默认）只给掩码 + 首尾各 4 位，页面显示的就是这个；
 * reveal=true 才带明文（页面点「显示」或「复制」时才请求，不随页面加载一起发）。
 * key 缺失（网关还没生成 config.json）时返 ok:false，页面显示「未配置」而不是空白。
 */
export function credential({ reveal = false, host } = {}) {
  const guard = localOnly(host, '看网关连接凭据') || needsDir()
  if (guard) return { ok: false, error: guard, gatewayDir: gatewayDir() }
  const key = apiKey()
  if (!key) {
    return {
      ok: false,
      error: `读不到网关 api_key（检查 ${gatewayDir()}/config.json）`,
      baseUrl: `${base()}/v1`,
      gatewayDir: gatewayDir(),
    }
  }
  return {
    ok: true,
    baseUrl: `${base()}/v1`,
    gatewayDir: gatewayDir(),
    length: key.length,
    // 掩码：保留首尾各 4 位，便于肉眼比对是不是同一把；中间一律打点
    masked: key.length > 12 ? `${key.slice(0, 4)}${'•'.repeat(12)}${key.slice(-4)}` : '•'.repeat(12),
    ...(reveal ? { key } : {}),
  }
}

/** 网关是否在跑（503 也可能是「服务活着但没有可用账号」，所以不能用 HTTP 状态码判断） */
export async function reachable(host) {
  const res = await request(`${base(host)}/healthz`, { timeout: 4000 })
  // healthz 在 0 个可用账号时返回 503，但那份 JSON 本身就是「网关活着」的证据
  if (res.json?.service === 'workbuddy2api') return { ok: true, data: res.json }
  if (res.status === 0) {
    const item = pickHost(host)
    return {
      ok: false,
      error:
        item.kind === 'local'
          ? '网关没在跑（在网关目录跑它自己的启动脚本，或用本页的「启动网关」）'
          : `${item.name} 联系不上（检查那边的网关在不在跑、这个地址通不通：${item.baseUrl}）`,
    }
  }
  return { ok: false, error: res.error || `网关响应异常（HTTP ${res.status}）` }
}

/* ------------------------------------------------------------- 拉取 --- */

/** 账号池状态（网关内存，快） */
export async function status(host) {
  const res = await request(`${base(host)}/status`, { headers: authHeaders(host), timeout: 8000 })
  if (!res.ok) {
    return { ok: false, status: res.status, error: res.error || `HTTP ${res.status}`, detail: res.json?.error }
  }
  const d = res.json ?? {}
  const accounts = (d.accounts ?? []).map((a) => ({
    uid: a.uid,
    nickname: a.nickname,
    realm: a.realm,
    credits: a.credits ?? 0,
    cooling: !!a.cooling,
    coolingUntil: a.until,
    disabled: !!a.disabled,
    manualDisabled: !!a.manual_disabled,
    inFlight: a.in_flight ?? 0,
    consecutiveFails: a.consecutive_fails ?? 0,
    breakerFails: a.breaker_fails ?? 0,
    lastSuccess: a.last_success,
    lastErr: a.last_err,
    // 每个账号每天的模型限额：6004 是这个模型今天用满了，恢复时间是上游给的重置墙钟；
    // 「全部模型」是 14018 额度用尽，要等次日签到。普通短冷却不在这个列表里。
    limits: (a.rate_limited_models ?? []).map((m) => ({
      model: m.model,
      until: m.until,
      resetAt: m.reset_at,
      reason: m.reason,
      daily: m.daily !== false,
    })),
  }))
  return {
    ok: true,
    healthy: d.healthy ?? 0,
    total: d.total ?? accounts.length,
    cooling: d.cooling ?? 0,
    disabled: d.disabled ?? 0,
    inFlightFull: d.in_flight_full ?? 0,
    stickySessions: d.sticky_sessions ?? 0,
    realmTotals: d.realm_totals ?? {},
    redisMode: d.redis_mode ?? '',
    accounts,
  }
}

/**
 * 支持的模型清单（网关 `/v1/models` 透出，元数据很全：上下文、输出上限、
 * 是否支持图片 / 推理，以及描述里的积分倍率 `[x0.00 credit]`）。
 *
 * 模型集合基本不变，所以缓存在内存 + 落盘（10 分钟），不跟着页面刷新去问。
 * 倍率从 description 里解析出来单独给个字段 —— 页面要按它排序（免费的排最前），
 * 让前端去正则匹配中文描述里的数字太脆。
 */
export function models() {
  if (!mem) loadDisk()
  const age = Date.now() - (mem?.modelsAt ?? 0)
  if (mem?.models?.length && age < MODELS_SEC * 1000) {
    return { ok: true, items: mem.models, at: mem.modelsAt, stale: false }
  }
  refreshModels() // 过期先返回旧值，后台补一轮
  if (mem?.models?.length) return { ok: true, items: mem.models, at: mem.modelsAt, stale: true }
  return { ok: false, error: '模型清单还没取到（网关未启动时会一直为空）' }
}

/** 真的去网关拉一次模型清单（内部用；失败保留旧值） */
export async function fetchModels(host) {
  const res = await request(`${base(host)}/v1/models`, { headers: authHeaders(host), timeout: 12000 })
  if (!res.ok) {
    return { ok: false, status: res.status, error: res.error || `HTTP ${res.status}` }
  }
  const items = (res.json?.data ?? []).map((m) => {
    const id = m.id ?? ''
    // 「[x0.00 credit]」→ 0；描述里没有倍率的（如部分老模型）给 null，不假造成 0
    const mult = /\[x([\d.]+)\s*credit\]/i.exec(m.description ?? '')
    return {
      id,
      model: id.includes(':') ? id.slice(id.indexOf(':') + 1) : id, // 去掉 realm 前缀，供直接填客户端
      realmId: id.split(':')[0] || 'cn',
      name: m.name ?? '',
      multiplier: mult ? Number(mult[1]) : null,
      context: m.context_length ?? m.max_allowed_size ?? null,
      maxOutput: m.max_output_tokens ?? null,
      images: !!m.supports_images,
      reasoning: !!m.supports_reasoning,
      toolCall: !!m.supports_tool_call,
      description: m.description ?? '',
    }
  })
  // 倍率升序（免费最前），没有倍率的排最后；同倍率按名字稳定排序
  items.sort((a, b) => {
    const am = a.multiplier == null ? Infinity : a.multiplier
    const bm = b.multiplier == null ? Infinity : b.multiplier
    return am - bm || a.model.localeCompare(b.model)
  })
  return { ok: true, items }
}

/** 后台刷新模型清单（带并发锁；失败保留旧值） */
export function refreshModels({ force = false } = {}) {
  if (modelsBusy) return { started: false, reason: 'busy' }
  const age = Date.now() - (mem?.modelsAt ?? 0)
  if (!force && mem?.models?.length && age < MODELS_SEC * 1000) return { started: false, reason: 'fresh' }
  modelsBusy = true
  fetchModels()
    .then((r) => {
      if (r.ok) mem = { ...(mem ?? { version: 1 }), version: 1, models: r.items, modelsAt: Date.now() }
      saveDisk()
    })
    .catch((err) => console.warn('[workbuddy] 模型清单刷新失败（保留旧缓存）:', err.message))
    .finally(() => {
      modelsBusy = false
    })
  return { started: true }
}

/**
 * 网关自己的调用统计。数字按本地日（UTC+8）落在网关的 data/metrics.json，
 * 重启不丢。day 形如 2026-09-22；缺省是今天。days 是有记录的日期，新的在前。
 */
export async function stats(day = '', host) {
  const qs = /^\d{4}-\d{2}-\d{2}$/.test(day) ? `?day=${day}` : ''
  const res = await request(`${base(host)}/v1/stats${qs}`, { headers: authHeaders(host), timeout: 8000 })
  if (!res.ok) {
    return { ok: false, status: res.status, error: res.error || `HTTP ${res.status}` }
  }
  const d = res.json ?? {}
  const t = d.total ?? {}
  return {
    ok: true,
    since: d.since,
    day: d.day ?? '',
    days: d.days ?? [],
    uptimeSec: d.uptime_sec ?? 0,
    requests: t.requests ?? 0,
    success: t.success ?? 0,
    failed: t.failed ?? 0,
    streaming: t.streaming ?? 0,
    avgTtfbMs: t.avg_ttfb_ms ?? 0,
    avgLatencyMs: t.avg_latency_ms ?? 0,
    tokensPerSec: t.tokens_per_sec ?? 0,
    promptTokens: t.prompt_tokens ?? 0,
    completionTokens: t.completion_tokens ?? 0,
    totalTokens: t.total_tokens ?? 0,
    cacheHitTokens: t.cache_hit_tokens ?? 0,
    cacheHitRate: t.cache_hit_rate ?? 0,
    credit: t.credit ?? 0,
    creditPerReq: t.credit_per_req ?? 0,
    models: (d.models ?? []).map((m) => ({
      model: m.model,
      requests: m.requests ?? 0,
      success: m.success ?? 0,
      failed: m.failed ?? 0,
      totalTokens: m.total_tokens ?? 0,
      credit: m.credit ?? 0,
      avgLatencyMs: m.avg_latency_ms ?? 0,
    })),
  }
}

/**
 * 真实积分包（出网，约 1.6s）。跑 credit.exe -json 拿它的 stdout。
 * 进程不存在 / 超时都返回 ok:false，不抛出。
 */
/* ------------------------------------------------ 远端积分缓存（按主机） --- */

/**
 * 远端积分要经 SSH 去那台机器上跑 credit.exe，慢（十几秒到一分钟）。
 * 所以和本机同一套「先给缓存、过期后台刷」，只是**缓存按主机分开**（内存 + 落盘各一份）——
 * 两台池子的积分绝不能混进同一份文件，否则页面显示的是别人的账。
 */
const remoteMem = new Map() // hostId -> { credit, creditAt }
const remoteBusy = new Set() // 正在跑的那几台主机（并发锁）

function remoteCacheFile(id) {
  const dir = process.env.WS_DATA_DIR || loadConfig().dataDir
  return path.join(dir, `workbuddy-cache-${id}.json`)
}

function loadRemoteDisk(id) {
  if (remoteMem.has(id)) return remoteMem.get(id)
  let v = { credit: null, creditAt: 0, lastError: null }
  try {
    const raw = JSON.parse(fs.readFileSync(remoteCacheFile(id), 'utf8'))
    v = { credit: raw?.credit ?? null, creditAt: raw?.creditAt ?? 0, lastError: raw?.lastError ?? null }
  } catch {
    /* 首次没有缓存文件是正常的 */
  }
  remoteMem.set(id, v)
  return v
}

function saveRemoteDisk(id, v) {
  try {
    const f = remoteCacheFile(id)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    const tmp = `${f}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...v }))
    fs.renameSync(tmp, f)
  } catch {
    /* 缓存落盘失败不影响服务 */
  }
}

/** 打包给页面/看板看的远端积分视图：永远先给缓存 + 更新时间，过期在后台补 */
export function remoteCreditView(item) {
  const v = loadRemoteDisk(item.id)
  const fresh = !!v.credit?.ok && Date.now() - v.creditAt < CREDIT_SEC * 1000
  if (!fresh) refreshRemoteCredit(item)
  return {
    ...(v.credit ?? { ok: false, error: `${item.name} 的积分还没取到（第一次要等它跑一轮）` }),
    at: v.creditAt,
    stale: !fresh,
    lastError: v.lastError ?? null,
  }
}

/** 后台/同步刷新某台远端主机的积分（失败保留旧值 + 记错误，别把页面打空） */
export function refreshRemoteCredit(item, { force = false, wait = false } = {}) {
  const cur = loadRemoteDisk(item.id)
  const fresh = !!cur.credit?.ok && Date.now() - cur.creditAt < CREDIT_SEC * 1000
  if (!force && fresh) return { started: false, reason: 'fresh' }
  if (remoteBusy.has(item.id)) return { started: false, reason: 'busy' }
  remoteBusy.add(item.id)
  const job = remoteCredits(item)
    .then((r) => {
      const v = loadRemoteDisk(item.id)
      let next
      if (r.ok) {
        next = { credit: r, creditAt: Date.now(), lastError: null }
      } else if (v.credit?.ok) {
        // 这次没查到、但手里有上次成功的值：**保留旧值 + 旧时间戳**，只把错误记下来。
        // 时间戳不动是有意的 —— 页面上「N 分钟前更新」要如实反映积分是哪一刻的。
        next = { credit: v.credit, creditAt: v.creditAt, lastError: r.error ?? '查询失败' }
      } else {
        next = { credit: r, creditAt: Date.now(), lastError: r.error ?? '查询失败' }
      }
      remoteMem.set(item.id, next)
      saveRemoteDisk(item.id, next)
      return r
    })
    .catch((err) => ({ ok: false, error: err.message }))
    .finally(() => {
      remoteBusy.delete(item.id)
    })
  return wait ? job : { started: true }
}

/**
 * 远端账号池的真实积分包：走已有的 SSH 通道，在**那台机器上**跑它自己的 credit.exe。
 *
 * 为什么这么绕：积分要遍历账号、按 realm 打上游、还要控速，重写一遍只会多一处不同步；
 * 而 credit.exe 本来就在那台机器上（部署账号池时一起带过去的）。执行的脚本由配置给
 * （`hosts[].creditScript`），脚本名与任务名之外不拼任何输入，所以不是通用远程执行面。
 *
 * 远端结果**不进本机缓存**：两台池子的积分不该共用一份落盘缓存。
 */
async function remoteCredits(item) {
  if (!item.ssh) {
    return { ok: false, error: `${item.name} 没配 SSH 别名（config.workbuddy.hosts[].ssh），取不到真实积分包` }
  }
  if (!item.creditScript) {
    return {
      ok: false,
      error: `${item.name} 没配取积分的脚本（config.workbuddy.hosts[].creditScript），取不到真实积分包`,
    }
  }
  // 路径由配置给：可能带空格，所以用 \" 转义后再套一层引号传给 ssh
  const remoteCmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${String(item.creditScript).replace(/"/g, '\\"')}"`
  const r = await runHidden(`ssh -o BatchMode=yes -o ConnectTimeout=15 ${item.ssh} "${remoteCmd}"`, { timeout: 150000 })
  const line = (r.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop() ?? ''
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    const msg = (r.stderr ?? '').trim() || '远端积分查询没有返回可解析的 JSON'
    return { ok: false, error: msg.slice(0, 300) }
  }
  const t = parsed.total ?? {}
  return {
    ok: true,
    remote: true,
    ts: parsed.ts,
    total: {
      remain: t.remain ?? 0,
      used: t.used ?? 0,
      size: t.size ?? 0,
      accounts: t.accounts ?? 0,
      ok: t.ok ?? 0,
      failed: t.failed ?? 0,
    },
    accounts: (parsed.accounts ?? []).map((a) => ({
      uid: a.uid,
      nickname: a.nickname,
      remain: a.remain ?? 0,
      used: a.used ?? 0,
      size: a.size ?? 0,
      packages: a.packages ?? 0,
      ok: !!a.ok,
      error: a.error,
    })),
  }
}

export async function credits(host) {
  const item = pickHost(host)
  // 远端：先给上次的（页面立刻有数），过期在后台补一轮
  if (item.kind === 'remote') return remoteCreditView(item)
  const dir = gatewayDir()
  const exe = path.join(dir, 'credit.exe').replace(/\//g, '\\')
  if (!fs.existsSync(exe)) {
    return { ok: false, error: needsDir() || `找不到 ${exe}（先在网关目录跑 build.cmd 编译）` }
  }
  // 网关路径可能带空格甚至非 ASCII 字符：引号包住，交给 shell
  const r = await runHidden(`"${exe}" -json`, { cwd: dir, timeout: 60000 })
  const line = (r.stdout ?? '').trim().split('\n').pop() ?? ''
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    return { ok: false, error: r.stderr?.trim() || '积分查询没有返回可解析的 JSON' }
  }
  const t = parsed.total ?? {}
  return {
    ok: true,
    ts: parsed.ts,
    total: {
      remain: t.remain ?? 0,
      used: t.used ?? 0,
      size: t.size ?? 0,
      accounts: t.accounts ?? 0,
      ok: t.ok ?? 0,
      failed: t.failed ?? 0,
    },
    accounts: (parsed.accounts ?? []).map((a) => ({
      uid: a.uid,
      nickname: a.nickname,
      remain: a.remain ?? 0,
      used: a.used ?? 0,
      size: a.size ?? 0,
      packages: a.packages ?? 0,
      ok: !!a.ok,
      error: a.error,
    })),
  }
}

/* --------------------------------------------------------- 请求日志 --- */

/** 网关日志文件（由 start-workbuddy2api.cmd 的 PowerShell 重定向写入） */
function logFile() {
  return path.join(gatewayDir(), 'data', 'server.out.log').replace(/\//g, '\\')
}

/**
 * 解析一行请求日志。网关输出格式（定宽表格，字段用 | 分隔）：
 *
 *   | #128 | 13:53:31 | deepseek-v4.1-flash | stream | 200 | 🍂(44ad20ac) | TTFB=3004ms | tok=227 | 57.5tok/s | total=4.0s |
 *
 * 缺值一律是 `-`（TTFB 对 sync 请求没有、流式可能拿不到 tok）。
 * 解析失败返回 null，由调用方跳过 —— 表头/分隔行/半截行都不该让整页崩掉。
 */
function parseLogLine(line) {
  const raw = line.trim()
  if (!raw.startsWith('|')) return null
  // 去掉首尾竖线后按 | 切；模型名与账号名里不会出现竖线（网关自己拼的定宽列）
  const cols = raw.replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim())
  if (cols.length < 10) return null
  const [seqRaw, time, model, mode, statusRaw, account, ttfb, tok, rate, total] = cols
  const seq = Number(seqRaw.replace('#', ''))
  if (!Number.isFinite(seq)) return null
  const status = Number(statusRaw)
  // 账号列形如 `昵称(uid8)`；没拿到账号时网关会写别的，取不到括号就整列当名字
  const m = /^(.*)\(([0-9a-f]{8})\)$/.exec(account)
  const num = (s, re) => {
    const g = re.exec(s)
    return g ? Number(g[1]) : null
  }
  return {
    seq,
    time, // HH:MM:SS（网关只写时间，不写日期）
    model,
    stream: mode === 'stream',
    status: Number.isFinite(status) ? status : null,
    ok: Number.isFinite(status) && status < 400,
    account: m ? m[1] : account,
    uid8: m ? m[2] : '',
    ttfbMs: num(ttfb, /TTFB=(\d+)ms/),
    tokens: num(tok, /tok=(\d+)/),
    tokensPerSec: num(rate, /([\d.]+)tok\/s/),
    totalSec: num(total, /total=([\d.]+)s/),
  }
}

/**
 * 读请求日志（最新的在前）。
 *
 * 日志文件被 `start-workbuddy2api.cmd` 用 `-RedirectStandardOutput` 每次启动**覆盖**，
 * 所以它只覆盖「网关本次运行」—— 界面里也要如实这么标，别让用户以为这是历史全量。
 * 网关重启后序号从 #001 重新开始。
 *
 * 文件正在被写入：只读不写，末尾半行解析不出来会被跳过。
 */
export function logs({ limit = 200, keyword = '', onlyFail = false, host } = {}) {
  const guard = localOnly(host, '读网关日志') || needsDir()
  if (guard) return { ok: false, error: guard, items: [], file: gatewayDir() }
  const file = logFile()
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return {
      ok: false,
      error: `读不到网关日志（${file}）：${err.code === 'ENOENT' ? '还没启动过网关' : err.message}`,
      items: [],
      file,
    }
  }
  const items = []
  for (const line of text.split(/\r?\n/)) {
    const it = parseLogLine(line)
    if (it) items.push(it)
  }
  const total = items.length
  const failed = items.filter((i) => !i.ok).length
  let out = items
  if (onlyFail) out = out.filter((i) => !i.ok)
  const kw = keyword.trim().toLowerCase()
  if (kw) {
    out = out.filter(
      (i) => i.model.toLowerCase().includes(kw) || i.account.toLowerCase().includes(kw),
    )
  }
  out = out.slice(-Math.max(1, limit)).reverse() // 最新在前
  let size = 0
  let mtime = 0
  try {
    const st = fs.statSync(file)
    size = st.size
    mtime = st.mtimeMs
  } catch {
    /* 刚被删除之类，忽略 */
  }
  return { ok: true, items: out, total, failed, file, size, mtime }
}

/* --------------------------------------------------------- 服务端控制 ---
   网关是个独立进程（不是边车的子模块），所以这里管三件事：看它在不在、
   拉起来、停掉。启动脚本用网关自带的 cmd（里面是 PowerShell Start-Process，
   PID 写 wb2api.pid、stdout/stderr 各自重定向）—— 不自己拼启动命令，
   免得和上游脚本的行为分叉。
*/

function gatewayPort() {
  try {
    return Number(new URL(base()).port || 7863)
  } catch {
    return 7863
  }
}

/** 网关进程状态：端口 + PID + 版本 + 健康 */
export async function service(host) {
  const guard = localOnly(host, '看网关服务状态')
  if (guard) return guard
  const port = gatewayPort()
  const running = await isPortOpen(port)
  const pid = running ? await pidOnPort(port) : null
  let health = null
  if (running) {
    const h = await reachable()
    health = h.ok ? h.data : { ok: false, error: h.error }
  }
  return {
    ok: true,
    running,
    port,
    pid,
    baseUrl: base(),
    dir: gatewayDir(),
    health,
    // 自启位（独立于面板自启：网关也能自己开机起，但默认走「随面板启动」）
    autostart: autostart.state(loadConfig().workbuddy?.autostartVbs ?? 'WorkBuddy2API.vbs'),
    // 面板启动时是否一并拉起（config.workbuddy.autoStart）
    autoStartWithPanel: loadConfig().workbuddy?.autoStart !== false,
    logFile: logFile(),
  }
}

/**
 * 启动网关：调网关自己的 start-workbuddy2api.cmd。
 * 已在跑就直接返回 alreadyRunning（脚本本身也会拒绝重复启动）。
 * 启动后轮询端口，最多等 20 秒 —— 网关启动很快（秒级），等不到就如实报。
 *
 * dir/port 可覆盖，仅供测试（在临时目录起一个不影响在跑实例的副本用）。
 */
export async function startService({ dir: dirOverride, port: portOverride, host } = {}) {
  const guard = localOnly(host, '启动网关') || needsDir()
  if (guard) return { ok: false, error: guard }
  const cfg = loadConfig().workbuddy ?? {}
  const port = portOverride ?? gatewayPort()
  if (await isPortOpen(port)) return { ok: true, alreadyRunning: true, port }

  const dir = (dirOverride ?? gatewayDir()).replace(/\\/g, '/')
  const cmd = path.join(dir, cfg.startCmd ?? 'start-workbuddy2api.cmd').replace(/\//g, '\\')
  if (!fs.existsSync(cmd)) {
    return { ok: false, error: `找不到启动脚本：${cmd}` }
  }
  spawnHidden(`"${cmd}"`, { cwd: dir })

  for (let i = 0; i < 20; i++) {
    await sleep(1000)
    if (await isPortOpen(port)) {
      return { ok: true, started: true, port, waitedMs: (i + 1) * 1000 }
    }
  }
  return {
    ok: false,
    port,
    error: '启动脚本已执行，但 20 秒内端口没就绪。到网关目录手动跑 start-workbuddy2api.cmd 看报错',
  }
}

/** 停止网关：先跑网关的 stop 脚本（会校验 PID 所属进程，避免误杀），再兜底按端口杀 */
export async function stopService({ dir: dirOverride, port: portOverride, host } = {}) {
  const guard = localOnly(host, '停止网关') || needsDir()
  if (guard) return { ok: false, error: guard }
  const cfg = loadConfig().workbuddy ?? {}
  const port = portOverride ?? gatewayPort()
  const dir = (dirOverride ?? gatewayDir()).replace(/\\/g, '/')
  const cmd = path.join(dir, cfg.stopCmd ?? 'stop-workbuddy2api.cmd').replace(/\//g, '\\')
  if (fs.existsSync(cmd)) {
    const r = await runHidden(`"${cmd}"`, { cwd: dir, timeout: 20000 })
    if (r.code !== 0 && r.stderr) {
      console.warn('[workbuddy] 停止脚本返回非 0:', r.stderr.trim().slice(0, 200))
    }
  }
  // 脚本靠 wb2api.pid 认定进程；PID 文件丢了就按端口兜底
  for (let i = 0; i < 6; i++) {
    if (!(await isPortOpen(port))) return { ok: true, stopped: true, port }
    await sleep(700)
  }
  const pid = await pidOnPort(port)
  if (pid) {
    await killPid(pid)
    for (let i = 0; i < 6; i++) {
      if (!(await isPortOpen(port))) return { ok: true, stopped: true, port, byPid: pid }
      await sleep(700)
    }
  }
  return { ok: false, error: `停止命令已执行，但端口 ${port} 仍被占用（可能没权限结束该进程）`, port }
}

/**
 * 生成/修复网关的独立自启位（VBS）。
 * 默认不用它 —— 默认走「随面板启动」（面板自己开机起，再把网关一并拉起），
 * 这样自启入口只有一处。留着这个入口是为了「不想开面板、只跑网关」的场景。
 */
export function setAutostart(enabled, host) {
  const guard = localOnly(host, '改开机自启') || needsDir()
  if (guard) return { ok: false, error: guard }
  const name = loadConfig().workbuddy?.autostartVbs ?? 'WorkBuddy2API.vbs'
  if (!enabled) return autostart.setEnabled(name, false)
  const cfg = loadConfig().workbuddy ?? {}
  const dir = gatewayDir()
  const content = autostart.buildSilentVbs({
    title: 'WorkBuddy2API 网关 静默自启',
    cwd: dir,
    command: `"${path.join(dir, cfg.startCmd ?? 'start-workbuddy2api.cmd').replace(/\//g, '\\')}"`,
    logFile: path.join(dir, 'data', 'autostart.log').replace(/\//g, '\\'),
  })
  return autostart.writeVbs(name, content)
}

/** 随面板启动：面板起来时如果网关没在跑就拉一把（受 config.workbuddy.autoStart 控制） */
export async function ensureStarted() {
  if (loadConfig().workbuddy?.autoStart === false) {
    return { ok: true, skipped: 'autoStart=false' }
  }
  return startService()
}

/** 给「怎么用」卡用的网关目录（前端只读展示） */
export function gatewayInfo() {
  return { dir: gatewayDir(), baseUrl: base(), logFile: logFile() }
}

/* ------------------------------------------------------------- 缓存 --- */

/** 积分查询要出网，不跟着页面刷新走：后台定时同步，页面永远先画缓存 */
export const CREDIT_SEC = Math.max(60, Number(process.env.WB_CREDIT_SEC) || 300)

/** 模型清单基本不变，缓存久一点（10 分钟） */
export const MODELS_SEC = Math.max(60, Number(process.env.WB_MODELS_SEC) || 600)

function saveDisk() {
  if (!mem) return
  try {
    const f = cacheFile()
    fs.mkdirSync(path.dirname(f), { recursive: true })
    const tmp = `${f}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(mem))
    fs.renameSync(tmp, f)
  } catch {
    /* 缓存落盘失败不影响服务 */
  }
}

function loadDisk() {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'))
    if (raw && raw.version === 1) mem = raw
  } catch {
    mem = null
  }
}

/** 组装快照：账号池 + 统计（都便宜，实时拉）+ 积分（走缓存，过期后台刷） */
export async function snapshot({ force = false, host } = {}) {
  const item = pickHost(host)

  // 远端主机：池状态、统计、模型清单都从那边的网关现拉；真实积分包要那边机器上的 credit.exe，
  // 那几块留空（页面按 remote 标记隐藏），不拿本机缓存冒充远端数据。
  if (item.kind === 'remote') {
    const alive = await reachable(item)
    if (!alive.ok) {
      return { ok: false, host: item.id, hostName: item.name, remote: true, error: alive.error, checkedAt: Date.now() }
    }
    const [st, sm, md] = await Promise.all([status(item), stats('', item), fetchModels(item)])
    const cv = remoteCreditView(item) // 有缓存就先给，没有就触发后台补
    return {
      ok: true,
      host: item.id,
      hostName: item.name,
      remote: true,
      baseUrl: item.baseUrl,
      gateway: alive.data,
      status: st,
      stats: sm,
      models: md.ok ? md.items : [],
      modelsAt: Date.now(),
      credit: cv.ok ? cv : null,
      creditAt: cv.at ?? 0,
      creditAgeMs: Date.now() - (cv.at ?? 0),
      creditStale: !!cv.stale,
      lastError: md.ok ? null : md.error ?? null,
      checkedAt: Date.now(),
    }
  }

  if (!mem) loadDisk()

  const alive = await reachable()
  if (!alive.ok) {
    return {
      ok: false,
      error: alive.error,
      cached: mem?.credit ? { credit: mem.credit, at: mem.creditAt } : null,
      checkedAt: Date.now(),
    }
  }

  const [st, sm] = await Promise.all([status(), stats()])

  // 积分：手动刷新时同步等一轮（页面转圈），否则过期就返回旧值 + 后台刷
  const creditAge = Date.now() - (mem?.creditAt ?? 0)
  const creditFresh = mem?.credit?.ok && creditAge < CREDIT_SEC * 1000
  if (force) {
    await refreshCredit({ force: true, wait: true })
  } else if (!creditFresh) {
    refreshCredit()
  }
  // 模型清单也顺手补一轮（不阻塞）：万一预热失败，打开页面就能自愈
  if (!mem?.models?.length) refreshModels()

  return {
    ok: true,
    host: item.id,
    hostName: item.name,
    remote: false,
    baseUrl: item.baseUrl,
    gateway: alive.data,
    status: st,
    stats: sm,
    models: mem?.models ?? [],
    modelsAt: mem?.modelsAt ?? 0,
    credit: mem?.credit ?? null,
    creditAt: mem?.creditAt ?? 0,
    creditAgeMs: Date.now() - (mem?.creditAt ?? 0),
    creditStale: !!mem?.credit?.ok && !creditFresh,
    lastError: mem?.lastError ?? null,
    checkedAt: Date.now(),
  }
}

/* --------------------------------------------------- 汇聚（本机 + 远端） --- */

/**
 * 把**多台账号池**（本机 + 各远端主机）的积分与调用汇到一份，供「模型用量」页那张卡用。
 *
 * 为什么要有它：账号池可以在好几台机器上跑，只看本机会漏掉远端那半 —— 而这个页面的意思
 * 就是「一眼看全」。各台单独取（`snapshot({host})`），单台失败只标那一台，不拖垮汇总。
 *
 * 缓存 60s：远端要过一层网络（SSH / 隧道都算），页面 60s 一刷没必要每轮都去问它。
 */
let mergedMem = { at: 0, data: null }
const MERGED_SEC = 60

export async function merged({ force = false } = {}) {
  if (!force && mergedMem.data && Date.now() - mergedMem.at < MERGED_SEC * 1000) return mergedMem.data

  const list = hosts()
  const parts = await Promise.all(
    list.map(async (h) => {
      const s = await snapshot({ host: h.id })
      return {
        id: h.id,
        name: h.name,
        kind: h.kind,
        baseUrl: h.baseUrl,
        ok: !!s.ok,
        error: s.ok ? '' : s.error || '取不到',
        // 积分：远端是 SSH 查出来缓存的（慢），所以可能只有上一次的值
        credit: s.credit?.ok ? s.credit.total : null,
        creditAt: s.creditAt ?? 0,
        creditStale: !!s.creditStale,
        stats: s.ok ? s.stats : null,
        accountsTotal: s.status?.total ?? null,
        accountsOk: s.status?.ok ?? null,
      }
    }),
  )

  const num = (v) => Number(v) || 0
  const withCredit = parts.filter((p) => p.credit)
  const withStats = parts.filter((p) => p.stats)
  const sumBy = (arr, f) => arr.reduce((n, x) => n + num(f(x)), 0)

  const promptTokens = sumBy(withStats, (p) => p.stats.promptTokens)
  const cacheTokens = sumBy(withStats, (p) => p.stats.cacheHitTokens)
  const reqAll = sumBy(withStats, (p) => p.stats.requests)

  const total = {
    hosts: { total: parts.length, ok: parts.filter((p) => p.ok).length, down: parts.filter((p) => !p.ok).length },
    credit: withCredit.length
      ? {
          remain: sumBy(withCredit, (p) => p.credit.remain),
          used: sumBy(withCredit, (p) => p.credit.used),
          size: sumBy(withCredit, (p) => p.credit.size),
          accounts: sumBy(withCredit, (p) => p.credit.accounts),
          ok: sumBy(withCredit, (p) => p.credit.ok),
          failed: sumBy(withCredit, (p) => p.credit.failed),
        }
      : null,
    stats: withStats.length
      ? {
          requests: reqAll,
          success: sumBy(withStats, (p) => p.stats.success),
          failed: sumBy(withStats, (p) => p.stats.failed),
          totalTokens: sumBy(withStats, (p) => p.stats.totalTokens),
          credit: sumBy(withStats, (p) => p.stats.credit),
          // 两个比率都按总量重算：各台比率直接平均会失真
          cacheHitRate: promptTokens > 0 ? cacheTokens / promptTokens : 0,
          avgTtfbMs: reqAll > 0 ? sumBy(withStats, (p) => p.stats.avgTtfbMs * num(p.stats.requests)) / reqAll : 0,
          avgLatencyMs: reqAll > 0 ? sumBy(withStats, (p) => p.stats.avgLatencyMs * num(p.stats.requests)) / reqAll : 0,
        }
      : null,
  }

  const data = { ok: true, at: Date.now(), hosts: parts, total }
  mergedMem = { at: Date.now(), data }
  return data
}

/**
 * 后台刷新积分（带并发锁；失败保留旧值，别让一次网络抖动把页面打空）。
 * wait=true 时等这一轮结束才返回，供「手动刷新」按钮用。
 */
export function refreshCredit({ force = false, wait = false, host } = {}) {
  const item = pickHost(host)
  if (item.kind === 'remote') return refreshRemoteCredit(item, { force: true, wait })
  if (refreshing) return wait ? refreshPromise : { started: false, reason: 'busy' }
  const age = Date.now() - (mem?.creditAt ?? 0)
  if (!force && mem?.credit?.ok && age < CREDIT_SEC * 1000) {
    return { started: false, reason: 'fresh' }
  }
  refreshing = true
  refreshPromise = credits()
    .then((r) => {
      // 查询失败时保留上一次成功的值：页面继续显示旧积分 + 时间戳，比空白有用
      if (r.ok || !mem?.credit?.ok) {
        // 展开旧 mem：积分与模型清单共用同一份缓存对象，
        // 直接换新对象会把模型清单一起抹掉（两把锁各写各的字段）
        mem = { ...(mem ?? {}), version: 1, credit: r, creditAt: Date.now() }
      } else {
        mem = { ...mem, lastError: r.error, lastErrorAt: Date.now() }
      }
      saveDisk()
      return r
    })
    .catch((err) => {
      console.warn('[workbuddy] 积分刷新失败（保留旧缓存）:', err.message)
      return { ok: false, error: err.message }
    })
    .finally(() => {
      refreshing = false
      refreshPromise = null
    })
  return wait ? refreshPromise : { started: true }
}

/** 启动预热：边车起来就把积分拉一次，页面首次打开不必等 */
export function warmup() {
  loadDisk()
  const age = Date.now() - (mem?.creditAt ?? 0)
  if (!mem?.credit?.ok || age > CREDIT_SEC * 1000) refreshCredit()
  const mAge = Date.now() - (mem?.modelsAt ?? 0)
  if (!mem?.models?.length || mAge > MODELS_SEC * 1000) refreshModels()
}

/**
 * 给看板用的**零出网**摘要：只读积分缓存 + 网关内存状态。
 *
 * 为什么不做成完整 snapshot：看板的 /api/overview 是要秒回的（它还带磁盘缓存与
 * stale-while-revalidate）。积分查询 1.6s 会把它拖垮，所以这里只用已有缓存，
 * 缓存没就绪就返回 ok:false —— 看板少一张卡片，比整体卡住好。
 * ?refresh 的积分刷新由定时器和详情页负责。
 */
export async function quick() {
  if (!mem) loadDisk()
  const alive = await reachable()
  if (!alive.ok) return { ok: false, error: alive.error }
  const st = await status()
  const credit = mem?.credit ?? null
  return {
    ok: true,
    healthy: st.healthy ?? 0,
    total: st.total ?? 0,
    cooling: st.cooling ?? 0,
    disabled: st.disabled ?? 0,
    remain: credit?.ok ? credit.total?.remain ?? 0 : null,
    size: credit?.ok ? credit.total?.size ?? 0 : null,
    used: credit?.ok ? credit.total?.used ?? 0 : null,
    accounts: credit?.ok ? credit.accounts ?? [] : [],
    creditAt: mem?.creditAt ?? 0,
    creditStale: !credit?.ok,
    // 模型数只给个计数：看板卡片不列模型，但「支持 N 个模型」是有用的
    modelCount: mem?.models?.length ?? 0,
  }
}

/** 定时同步：按 CREDIT_SEC 周期后台刷新积分，按 MODELS_SEC 刷模型清单 */
export function startScheduler() {
  warmup()
  const creditTimer = setInterval(() => refreshCredit(), CREDIT_SEC * 1000)
  creditTimer.unref?.()
  const modelsTimer = setInterval(() => refreshModels({ force: true }), MODELS_SEC * 1000)
  modelsTimer.unref?.()
  return { creditTimer, modelsTimer }
}

/** 这台主机的 key 配了没有（只给路由器做提示用，不返回值本身） */
export function hasKey(host) {
  return !!hostKey(host)
}

export { gatewayDir, base as gatewayBase }
