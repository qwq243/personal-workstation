/**
 * pguard —— 工作台自带的进程守护引擎。
 *
 * 本引擎是自研实现，规则语义见下（逐条）：
 *
 *   · 整机 CPU 过阈值要有**迟滞**：≥ triggerPercent 持续 triggerSustainSeconds 才「上膛」，
 *     ≤ releasePercent 持续 min(triggerSustainSeconds,10)s 才「撤膛」，中间那段保持现状（防抖）。
 *   · 单进程要被处理，得同时满足：CPU ≥ processThresholdPercent 且**持续**够久、进程年龄够、
 *     （按配置）没有可见窗口。候选按 CPU 降序，先处理最贵的。
 *   · 开发工具回收：按「空闲时长」分两步 —— 先轻后重，**释放内存是可逆的、结束不是**，
 *     所以 idleSeconds 先 trim，killAfterIdleSeconds 才动结束（按 action 配置）。
 *   · 定时内存释放：可用内存低于触发线才动手；目标是「配置里的名单 ∪ 开发工具」，还要看工作集下限、
 *     CPU 上限、可见窗口、系统目录，最后过一遍保护层。
 *   · 三道闸按固定顺序问：**白名单 → 受保护 → （黑名单是唯一能越过这三层的东西，出厂空）**。
 *     保护层里 pid 自身/父进程链、pid ≤ 4、内核关键进程、会话 0、系统目录、前台窗口、提权进程、
 *     打不开的进程，任一条命中就「已阻止」。
 *
 * 三处**有意与常规实现不同**（都是这台机器上的硬约束，不是偷懒）：
 *   1. **待机列表清理不能自动做**：它需要 SeProfileSingleProcessPrivilege = 提权，而边车是普通用户
 *      身份跑的；提着 UAC 每 5 分钟问一次没人点。所以它降级成面板上一个「人点一下 → 弹一次 UAC」
 *      的按钮，周期动作只做「释放工作集」。
 *   2. **单进程细分只在整机过线之后才采**（平时只读 os.cpus()，零 spawn）。代价是要晚几秒才
 *      开始累计「单进程持续超线」，换来的是平时不烧 CPU。
 *   3. **出厂是演练模式**：规则照常评估、照常写审计，但不动手。
 *
 * 审计写 `server/data/pguard/actions.jsonl`（camelCase + 字符串枚举 + outcomeText 中文）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../config.mjs'
import { runHidden, sleep } from './net.mjs'
import { killProcess, machineCpuPercent, closeWindows, foregroundPid, purgeStandbyList, snapshot, topByCpu, trimProcesses } from './procs.mjs'

const SERVER_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
/** 审计文件最多读这么多（再多就只统计尾部） */
const JOURNAL_TAIL_BYTES = 4 * 1024 * 1024
/** 引擎自己那本人类可读的流水账，超过就轮转一次 */
const LOG_MAX_BYTES = 2 * 1024 * 1024

/* --------------------------------------------------------------- 路径 --- */

export function dataDir() {
  const conf = loadConfig().pguard ?? {}
  return conf.dataDir ? String(conf.dataDir) : path.join(SERVER_DIR, 'data', 'pguard')
}
export function configPath() {
  return path.join(dataDir(), 'config.json')
}
export function journalPath() {
  return path.join(dataDir(), 'actions.jsonl')
}
export function logPath() {
  return path.join(dataDir(), 'engine.log')
}

/* --------------------------------------------------------------- 配置 --- */

/**
 * 出厂默认。数值照它 2026-09-23 的出厂值抄（也是它 README 里写的那些闸门），
 * 只有 `memory.purgeStandbyList` 是 false —— 理由见文件头第 1 条。
 */
const DEFAULTS = {
  enabled: true,
  dryRun: true,
  monitor: {
    /** 平时多久采一次全进程表（秒）—— 只用来算「开发工具空闲了多久」 */
    slowSampleSeconds: 30,
    /** 整机过线后多久采一次（秒）—— 单进程「持续超线」靠它累计 */
    hotSampleSeconds: 2.5,
  },
  cpuGuard: {
    enabled: true,
    triggerPercent: 80,
    triggerSustainSeconds: 10,
    releasePercent: 60,
    processThresholdPercent: 20,
    processSustainSeconds: 15,
    minProcessAgeSeconds: 30,
    action: 'gracefulClose', // trim | gracefulClose | kill
    gracefulCloseGraceMs: 3000,
    killProcessTree: true,
    skipProcessesWithVisibleWindow: true,
    maxActionsPerCycle: 3,
    maxActionsPerHour: 20,
    processCooldownSeconds: 120,
  },
  devReclaim: {
    enabled: true,
    /** 空闲多久先释放内存 */
    idleSeconds: 300,
    /** 空闲多久才考虑结束 */
    killAfterIdleSeconds: 900,
    minWorkingSetMb: 150,
    idleCpuPercent: 0.5,
    action: 'trimThenKill', // trim | trimThenKill | gracefulClose | kill
    skipProcessesWithVisibleWindow: true,
    skipIfDescendantActive: true,
    minProcessAgeSeconds: 120,
    /** 每轮最多对它动几次手（照它的配置） */
    maxActionsPerCycle: 5,
    processNames: [
      'bash', 'bun', 'cargo', 'clang', 'clang++', 'cmake', 'conda', 'deno', 'docker', 'dotnet',
      'esbuild', 'eslint', 'flutter', 'g++', 'gcc', 'git', 'go', 'gopls', 'gradle', 'java',
      'javac', 'jest', 'make', 'mvn', 'mypy', 'ninja', 'node', 'npm', 'npx', 'nuget', 'perl',
      'php', 'pip', 'pip3', 'playwright', 'pnpm', 'poetry', 'prettier', 'py', 'pytest', 'python',
      'python3', 'python3.*', 'pythonw', 'rollup', 'ruby', 'ruff', 'rust-analyzer', 'rustc',
      'tsc', 'tsx', 'uv', 'uvx', 'vite', 'webpack', 'yarn',
    ],
  },
  memory: {
    enabled: true,
    intervalSeconds: 300,
    trimWorkingSets: true,
    /** 它出厂是 true，我们做不到无人值守提权 → 默认关，面板上有手动按钮 */
    purgeStandbyList: false,
    minWorkingSetMb: 150,
    maxCpuPercentForWorkingSetTrim: 5,
    includeSystemBinaries: false,
    trimAllAccessibleProcesses: false,
    skipVisibleWindowProcesses: true,
    /** 可用内存低于这个百分比才动手（0 = 不设门槛） */
    triggerWhenFreeMemoryBelowPercent: 25,
    targetProcessNames: [
      'dotnet', 'esbuild', 'gopls', 'java', 'node', 'python', 'python3.*', 'rust-analyzer',
      'tsc', 'uv', 'uvx', 'VBCSCompiler', 'vite', 'webpack',
    ],
  },
  protection: {
    immutableProcessNames: [
      'AggregatorHost.exe', 'ApplicationFrameHost.exe', 'audiodg.exe', 'conhost.exe', 'csrss.exe',
      'ctfmon.exe', 'dllhost.exe', 'dwm.exe', 'explorer.exe', 'fontdrvhost.exe', 'Idle', 'LogonUI.exe',
      'lsaiso.exe', 'lsass.exe', 'Memory Compression', 'MsMpEng.exe', 'NisSrv.exe', 'OpenConsole.exe',
      'Registry', 'RuntimeBroker.exe', 'SearchHost.exe', 'Secure System', 'SecurityHealthService.exe',
      'SecurityHealthSystray.exe', 'services.exe', 'ShellExperienceHost.exe', 'sihost.exe',
      'smartscreen.exe', 'smss.exe', 'spoolsv.exe', 'StartMenuExperienceHost.exe', 'svchost.exe',
      'System', 'SystemSettings.exe', 'taskhostw.exe', 'TextInputHost.exe', 'wininit.exe',
      'winlogon.exe', 'wlanext.exe', 'WmiPrvSE.exe', 'WUDFHost.exe',
    ],
    protectSelfAndAncestors: true,
    protectSession0: true,
    protectSystemBinaries: true,
    protectForegroundWindowOwner: true,
    protectHigherIntegrity: true,
  },
  blacklist: {
    enabled: true,
    cooldownSeconds: 120,
    maxActionsPerCycle: 3,
    maxActionsPerHour: 20,
    minProcessAgeSeconds: 20,
    /** 出厂空 —— 它是唯一能越过白名单/保护层的东西，所以默认一条都不配 */
    entries: [],
  },
  whitelist: [
    { enabled: true, match: 'imageName', value: 'Code.exe', note: '默认白名单' },
    { enabled: true, match: 'imageName', value: 'WindowsTerminal.exe', note: '默认白名单' },
    { enabled: true, match: 'imageName', value: 'powershell.exe', note: '默认白名单' },
    { enabled: true, match: 'imageName', value: 'pwsh.exe', note: '默认白名单' },
    { enabled: true, match: 'imageName', value: 'cmd.exe', note: '默认白名单' },
    { enabled: true, match: 'imageName', value: 'explorer.exe', note: '默认白名单' },
    { enabled: true, match: 'imageName', value: 'msedgewebview2.exe', note: '默认白名单' },
  ],
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}
function merge(base, patch) {
  const out = isPlainObject(base) ? { ...base } : {}
  for (const [k, v] of Object.entries(patch ?? {})) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? merge(out[k], v) : v
  }
  return out
}

let cfgCache = { at: 0, mtime: 0, value: null }

/** 读引擎配置：文件不存在就用出厂默认（**不落盘** —— 第一次真正改设置时才写） */
export function engineConfig({ force = false } = {}) {
  const p = configPath()
  let mtime = 0
  try {
    mtime = fs.statSync(p).mtimeMs
  } catch {
    /* 文件还没有 */
  }
  if (!force && cfgCache.value && cfgCache.mtime === mtime && Date.now() - cfgCache.at < 5000) return cfgCache.value
  let file = null
  if (mtime) {
    try {
      file = JSON.parse(fs.readFileSync(p, 'utf8'))
    } catch {
      file = null
    }
  }
  const value = merge(DEFAULTS, file ?? {})
  cfgCache = { at: Date.now(), mtime, value }
  return value
}

function writeConfig(next) {
  const p = configPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, p)
  cfgCache = { at: 0, mtime: 0, value: null }
}

/** 改配置（深合并）。键是白名单式的，见 EDITABLE —— 面板与 MCP 都只能碰这些。 */
export function setSettings(patch = {}) {
  const applied = {}
  const rejected = []
  for (const [key, raw] of Object.entries(patch ?? {})) {
    const type = EDITABLE[key]
    if (!type) {
      rejected.push(key)
      continue
    }
    if (type === 'boolean') applied[key] = raw === true || raw === 'true' || raw === 1 || raw === '1'
    else {
      const n = Number(raw)
      if (!Number.isFinite(n)) {
        rejected.push(key)
        continue
      }
      applied[key] = n
    }
  }
  if (!Object.keys(applied).length) return { ok: false, error: '没有可改的项', rejected }
  const nested = {}
  for (const [key, value] of Object.entries(applied)) {
    const parts = key.split('.')
    if (parts.length === 2) nested[parts[0]] = { ...(nested[parts[0]] ?? {}), [parts[1]]: value }
    else nested[parts[0]] = value
  }
  const next = merge(engineConfig(), nested)
  try {
    writeConfig(next)
  } catch (err) {
    return { ok: false, error: `写配置失败：${err.message}`, rejected }
  }
  logLine('info', `设置已更新：${Object.entries(applied).map(([k, v]) => `${k}=${v}`).join('、')}`)
  return { ok: true, applied, rejected }
}

/**
 * 可改项白名单。**放行的是「看得见的旋钮」，不是安全网**：
 * 受保护名单、黑名单的「豁免保护」这类能拆掉护栏的东西不走这里（要动就去
 * server/data/pguard/config.json 手改，那是「你亲手写下的规则」而不是一次点击）。
 */
const EDITABLE = {
  enabled: 'boolean',
  dryRun: 'boolean',
  'monitor.slowSampleSeconds': 'number',
  'monitor.hotSampleSeconds': 'number',
  'cpuGuard.enabled': 'boolean',
  'cpuGuard.triggerPercent': 'number',
  'cpuGuard.triggerSustainSeconds': 'number',
  'cpuGuard.releasePercent': 'number',
  'cpuGuard.processThresholdPercent': 'number',
  'cpuGuard.processSustainSeconds': 'number',
  'cpuGuard.minProcessAgeSeconds': 'number',
  'cpuGuard.gracefulCloseGraceMs': 'number',
  'cpuGuard.skipProcessesWithVisibleWindow': 'boolean',
  'cpuGuard.maxActionsPerCycle': 'number',
  'cpuGuard.maxActionsPerHour': 'number',
  'cpuGuard.processCooldownSeconds': 'number',
  'devReclaim.enabled': 'boolean',
  'devReclaim.idleSeconds': 'number',
  'devReclaim.killAfterIdleSeconds': 'number',
  'devReclaim.minWorkingSetMb': 'number',
  'devReclaim.idleCpuPercent': 'number',
  'devReclaim.minProcessAgeSeconds': 'number',
  'devReclaim.skipProcessesWithVisibleWindow': 'boolean',
  'devReclaim.skipIfDescendantActive': 'boolean',
  'memory.enabled': 'boolean',
  'memory.intervalSeconds': 'number',
  'memory.trimWorkingSets': 'boolean',
  'memory.purgeStandbyList': 'boolean',
  'memory.minWorkingSetMb': 'number',
  'memory.maxCpuPercentForWorkingSetTrim': 'number',
  'memory.triggerWhenFreeMemoryBelowPercent': 'number',
  'memory.skipVisibleWindowProcesses': 'boolean',
  'blacklist.enabled': 'boolean',
  'blacklist.minProcessAgeSeconds': 'number',
  'protection.protectForegroundWindowOwner': 'boolean',
  'protection.protectSystemBinaries': 'boolean',
}

/* ----------------------------------------------------------- 名单与匹配 --- */

/** 名字归一：小写、去目录、去 .exe（照它的 NamePatternSet） */
function normName(raw) {
  let s = String(raw ?? '').trim().toLowerCase()
  if (!s) return ''
  const slash = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
  if (slash >= 0) s = s.slice(slash + 1)
  if (s.endsWith('.exe')) s = s.slice(0, -4)
  return s
}

function globMatch(pattern, name) {
  const re = new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
  )
  return re.test(name)
}

/** 名字集合：精确与通配分桶（常见情况是纯字符串比较） */
function nameSet(patterns) {
  const exact = []
  const wild = []
  for (const raw of patterns ?? []) {
    const v = normName(raw)
    if (!v) continue
    if (v.includes('*') || v.includes('?')) wild.push(v)
    else exact.push(v)
  }
  return (name) => {
    const n = normName(name)
    if (!n) return false
    if (exact.includes(n)) return true
    return wild.some((w) => globMatch(w, n))
  }
}

const SYSTEM_ROOTS = [
  '\\Windows\\System32',
  '\\Windows\\SysWOW64',
  '\\Windows\\WinSxS',
  '\\Windows\\SystemApps',
  '\\Windows\\servicing',
  '\\Windows\\ImmersiveControlPanel',
  '\\Windows\\Boot',
  '\\$WINDOWS.~BT',
]
function isSystemBinary(imagePath) {
  if (!imagePath) return false
  const p = String(imagePath)
  return SYSTEM_ROOTS.some((r) => p.toLowerCase().includes(r.toLowerCase()))
}

/** 名单条目支持的匹配方式（面板、MCP 与 listsOp 共用同一份） */
const MATCH_KINDS = ['imageName', 'path', 'pathContains', 'commandLineContains', 'pid']

/**
 * 白名单一条怎么算命中：imageName（名字，支持通配）/ path、pathContains（镜像全路径包含）/
 * commandLineContains（命令行包含，用来区分同一个 node.exe 下的不同服务）/ pid。
 */
function whitelistHit(entry, proc) {
  if (!entry || entry.enabled === false) return false
  const value = String(entry.value ?? '')
  if (!value) return false
  if (entry.match === 'pid') return Number(value) === Number(proc.pid)
  if (entry.match === 'path' || entry.match === 'pathContains') {
    return String(proc.imagePath ?? '').toLowerCase().includes(value.toLowerCase())
  }
  if (entry.match === 'commandLineContains') {
    return String(proc.cmd ?? '').toLowerCase().includes(value.toLowerCase())
  }
  return nameSet([value])(proc.name)
}

/* ------------------------------------------------------------- 审计 --- */

function ensureDir() {
  fs.mkdirSync(dataDir(), { recursive: true })
}

function logLine(level, text) {
  try {
    ensureDir()
    const p = logPath()
    try {
      if (fs.statSync(p).size > LOG_MAX_BYTES) fs.renameSync(p, `${p}.1`)
    } catch {
      /* 还没有文件 */
    }
    fs.appendFileSync(p, `${new Date().toISOString()} [${level.toUpperCase().padEnd(5)}] ${text}\n`, 'utf8')
  } catch {
    /* 日志写不进去不该影响守护本身 */
  }
}

export function readLog(lines = 40) {
  try {
    const p = logPath()
    if (!fs.existsSync(p)) return { path: p, exists: false, tail: [] }
    const text = fs.readFileSync(p, 'utf8')
    return { path: p, exists: true, tail: text.split('\n').filter(Boolean).slice(-lines) }
  } catch {
    return { path: logPath(), exists: false, tail: [] }
  }
}

const OUTCOME_TEXT = {
  blocked: '已阻止',
  simulated: '演练',
  trimmed: '已释放内存',
  closed: '已关闭',
  killed: '已结束',
  failed: '失败',
}

/** 一条审计 = 一行 JSONL。字段与它的 actions.jsonl 一致，连大小写都照抄。 */
function journalAppend(rec) {
  const row = {
    timestamp: new Date(rec.at ?? Date.now()).toISOString(),
    rule: rec.rule,
    outcome: rec.outcome,
    pid: rec.pid ?? 0,
    processName: rec.name ?? '',
    ...(rec.imagePath ? { imagePath: rec.imagePath } : {}),
    cpuPercent: Math.round((rec.cpu ?? 0) * 10) / 10,
    workingSetBytes: rec.ws ?? 0,
    detail: rec.detail ?? '',
    outcomeText: OUTCOME_TEXT[rec.outcome] ?? rec.outcome,
  }
  try {
    ensureDir()
    fs.appendFileSync(journalPath(), `${JSON.stringify(row)}\n`, 'utf8')
  } catch (err) {
    logLine('error', `审计写不进去：${err.message}`)
  }
  return row
}

function readJournalTail(maxBytes = JOURNAL_TAIL_BYTES) {
  const p = journalPath()
  if (!fs.existsSync(p)) return { lines: [], sampled: false, size: 0, modifiedAt: 0 }
  let size = 0
  let modifiedAt = 0
  try {
    const st = fs.statSync(p)
    size = st.size
    modifiedAt = st.mtimeMs
  } catch {
    return { lines: [], sampled: false, size: 0, modifiedAt: 0 }
  }
  const start = Math.max(0, size - maxBytes)
  let text = ''
  try {
    const fd = fs.openSync(p, 'r')
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)
    text = buf.toString('utf8')
  } catch {
    return { lines: [], sampled: false, size, modifiedAt }
  }
  if (start > 0) {
    const nl = text.indexOf('\n')
    text = nl === -1 ? '' : text.slice(nl + 1)
  }
  return { lines: text.split('\n').filter((l) => l.trim()), sampled: start > 0, size, modifiedAt }
}

function parseRecord(line) {
  try {
    const r = JSON.parse(line)
    const at = Date.parse(r.timestamp ?? '')
    return {
      at: Number.isFinite(at) ? at : 0,
      rule: String(r.rule ?? ''),
      outcome: String(r.outcome ?? ''),
      outcomeText: String(r.outcomeText ?? OUTCOME_TEXT[r.outcome] ?? r.outcome ?? ''),
      pid: Number(r.pid) || 0,
      name: String(r.processName ?? ''),
      imagePath: String(r.imagePath ?? ''),
      cpuPercent: Number(r.cpuPercent) || 0,
      workingSetBytes: Number(r.workingSetBytes) || 0,
      detail: String(r.detail ?? ''),
    }
  } catch {
    return null
  }
}

function journalStats(limit = 30) {
  const { lines, sampled, size, modifiedAt } = readJournalTail()
  const all = lines.map(parseRecord).filter(Boolean)
  const today = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const todayStr = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`
  const localDay = (ts) => {
    const d = new Date(ts)
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
  const todayRecords = all.filter((r) => r.at && localDay(r.at) === todayStr)
  const byOutcome = {}
  let releasedBytes = 0
  for (const r of todayRecords) {
    byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1
    if (r.outcome === 'trimmed') releasedBytes += r.workingSetBytes
  }
  return {
    path: journalPath(),
    exists: size > 0,
    sizeBytes: size,
    modifiedAt,
    sampled,
    total: all.length,
    todayCount: todayRecords.length,
    todayByOutcome: byOutcome,
    todayActed: (byOutcome.killed ?? 0) + (byOutcome.trimmed ?? 0) + (byOutcome.closed ?? 0),
    todayReleasedBytes: releasedBytes,
    lastAt: all.length ? all[all.length - 1].at : 0,
    recent: all.slice(-Math.max(1, limit)).reverse(),
  }
}

/** 审计查询（面板与 MCP 都走这里） */
export function journal({ limit = 80, onlyActed = false, rule = '', outcome = '' } = {}) {
  const all = readJournalTail().lines.map(parseRecord).filter(Boolean)
  let items = all
  if (onlyActed) items = items.filter((r) => ['killed', 'trimmed', 'closed'].includes(r.outcome))
  if (rule) items = items.filter((r) => r.rule === rule)
  if (outcome) items = items.filter((r) => r.outcome === outcome)
  return { ok: true, total: all.length, shown: Math.min(items.length, limit), items: items.slice(-limit).reverse() }
}

/* ---------------------------------------------------- 引擎运行时状态 --- */

const state = {
  running: false,
  paused: false,
  startedAt: 0,
  ticks: 0,
  lastTickAt: 0,
  lastSampleAt: 0,
  lastSnapshotAt: 0,
  cpuPercent: null,
  memFreePercent: null,
  procCount: null,
  armed: false,
  overSince: 0,
  normalSince: 0,
  lastMemoryPassAt: 0,
  lastPurgeAt: 0,
  actionsThisSession: 0,
  killedThisSession: 0,
  trimmedThisSession: 0,
  blockedThisSession: 0,
  lastError: '',
  lastDecision: '',
  timer: null,
  busy: false,
}

/** 每个 pid 的台账：连续超线起点、冷却、空闲起点 */
const track = {
  busySince: new Map(),
  cooldownUntil: new Map(),
  idleSince: new Map(),
  lastTrimAt: new Map(),
}
let actionLog = []
let tickLog = []

function hourActions() {
  const cut = Date.now() - 3600 * 1000
  actionLog = actionLog.filter((t) => t >= cut)
  return actionLog.length
}

/* --------------------------------------------------------- 规则判定 --- */

/** 整机 CPU 迟滞状态机（照它的 CpuTriggerState） */
function updateArmed(cpuPercent, cfg, now) {
  const g = cfg.cpuGuard
  if (cpuPercent >= g.triggerPercent) {
    state.normalSince = 0
    if (!state.overSince) state.overSince = now
    if (g.triggerSustainSeconds <= 0 || (now - state.overSince) / 1000 >= g.triggerSustainSeconds) state.armed = true
  } else if (cpuPercent <= g.releasePercent) {
    state.overSince = 0
    if (!state.normalSince) state.normalSince = now
    if (g.triggerSustainSeconds <= 0 || (now - state.normalSince) / 1000 >= Math.min(g.triggerSustainSeconds, 10)) state.armed = false
  } else {
    // 迟滞带内：保持现状，但把两个待完成的计时都停掉，免得用陈旧的读数完成转换
    state.overSince = 0
    state.normalSince = 0
  }
  return state.armed
}

function protectedVerdict(proc, cfg, { foregroundPid: fgPid, selfPid }) {
  const pr = cfg.protection
  if (proc.pid === selfPid) return '工作台边车自身进程'
  if (pr.protectSelfAndAncestors && selfAncestors.has(proc.pid)) return '工作台自己的父进程链'
  if (proc.pid <= 4) return proc.pid === 0 ? 'System Idle Process' : 'Windows 内核进程'
  if (nameSet(pr.immutableProcessNames)(proc.name)) return `系统关键进程（${proc.name}）`
  if (pr.protectSession0 && proc.sessionId === 0) return '会话 0 系统服务'
  if (pr.protectSystemBinaries && isSystemBinary(proc.imagePath)) return '系统目录下的可执行文件'
  if (pr.protectForegroundWindowOwner && fgPid && proc.pid === fgPid) return '当前前台窗口所属进程'
  if (proc.pid === process.pid) return '工作台边车自身进程'
  return ''
}

/** 白名单命中说明（照它的说法：规则写了 note 就把 note 带上） */
function whitelistReason(entry) {
  return entry.note ? `白名单规则 ${entry.match}=${entry.value}（${entry.note}）` : `白名单规则 ${entry.match}=${entry.value}`
}

const selfAncestors = new Set([process.pid, Number(process.ppid) || 0].filter(Boolean))

function fmtBytes(n) {
  const v = Number(n) || 0
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(1)} GB`
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`
  if (v >= 1024) return `${Math.round(v / 1024)} KB`
  return `${v} B`
}

/* ------------------------------------------------------------ 一轮 --- */

/**
 * 跑一轮：采样 → 判定 → （非演练时才）动手 → 写审计。
 * 一个 tick 里的动作共用一个预算（每轮 3 个 / 每小时 20 个，照它的闸门）。
 */
export async function tick({ force = false, source = 'timer' } = {}) {
  if (!state.running || state.paused) return { ok: false, error: state.running ? '已暂停' : '引擎没在跑' }
  if (state.busy) return { ok: false, error: '上一轮还没跑完' }
  state.busy = true
  const now = Date.now()
  const cfg = engineConfig()
  const decisions = []
  /** 这一拍「为什么没动手」的说明 —— 面板直接展示，不用去猜 */
  const tickNotes = []
  try {
    state.ticks += 1
    state.lastTickAt = now
    let cpu = machineCpuPercent()
    // 首次调用没有基线（差值算不出来）—— 补半秒再采一次，免得首屏永远写着「CPU —%」
    if (cpu === null && state.cpuPercent === null) {
      await sleep(520)
      cpu = machineCpuPercent()
    }
    if (cpu !== null) state.cpuPercent = cpu
    const armed = cpu === null ? state.armed : updateArmed(cpu, cfg, now)
    tickNotes.push(
      armed
        ? `整机 CPU ${state.cpuPercent}% 已过判定线，正在盯单进程（≥${cfg.cpuGuard.processThresholdPercent}% 持续 ${cfg.cpuGuard.processSustainSeconds}s）`
        : `整机 CPU ${state.cpuPercent ?? '—'}% 没过判定线（≥${cfg.cpuGuard.triggerPercent}% 才细看单进程）`,
    )

    const slowDue = now - state.lastSnapshotAt >= cfg.monitor.slowSampleSeconds * 1000
    const hotDue = armed && now - state.lastSnapshotAt >= cfg.monitor.hotSampleSeconds * 1000
    if (!slowDue && !hotDue && !force) return { ok: true, idle: true, cpuPercent: state.cpuPercent, armed }

    const memTotal = os.totalmem()
    const memFree = os.freemem()
    state.memFreePercent = Math.round((memFree / memTotal) * 1000) / 10

    const snap = await snapshot()
    if (!snap) {
      state.lastError = '进程采样失败（PowerShell 没输出）'
      logLine('warn', state.lastError)
      return { ok: false, error: state.lastError }
    }
    const prev = lastSnap
    lastSnap = snap
    state.lastSnapshotAt = snap.at
    state.lastSampleAt = snap.at
    state.procCount = snap.processes

    const top = topByCpu(prev, snap, 30)
    const cpuByPid = new Map(top.map((t) => [t.pid, t]))
    const wsByPid = new Map(snap.procs.map((p) => [p.pid, p.ws ?? 0]))
    const ctx = { selfPid: process.pid, foregroundPid: 0 }

    /* --- 1) 开发工具回收（按空闲时长；先轻后重） --- */
    const devCands = []
    if (cfg.devReclaim.enabled) {
      const isDev = nameSet(cfg.devReclaim.processNames)
      for (const p of snap.procs) {
        if (!isDev(p.name)) continue
        const t = cpuByPid.get(p.pid)
        const idle = !t || t.cpu <= cfg.devReclaim.idleCpuPercent
        if (idle) {
          if (!track.idleSince.has(p.pid)) track.idleSince.set(p.pid, snap.at)
        } else {
          track.idleSince.delete(p.pid)
        }
        const since = track.idleSince.get(p.pid)
        if (!since) continue
        const idleSeconds = (snap.at - since) / 1000
        if (idleSeconds < cfg.devReclaim.idleSeconds) continue
        devCands.push({ proc: p, cpu: t?.cpu ?? 0, idleSeconds, ws: wsByPid.get(p.pid) ?? 0 })
      }
      devCands.sort((a, b) => b.ws - a.ws)
    }

    /* --- 2) CPU 守卫候选（整机上膛之后才细看单进程） --- */
    const cpuCands = []
    if (cfg.cpuGuard.enabled && armed) {
      for (const t of top) {
        if (t.cpu < cfg.cpuGuard.processThresholdPercent) {
          track.busySince.delete(t.pid)
          continue
        }
        if (!track.busySince.has(t.pid)) track.busySince.set(t.pid, snap.at)
        const busySeconds = (snap.at - track.busySince.get(t.pid)) / 1000
        if (busySeconds + 0.001 < cfg.cpuGuard.processSustainSeconds) continue
        cpuCands.push({ proc: { pid: t.pid, name: t.name }, cpu: t.cpu, busySeconds, ws: t.ws ?? 0 })
      }
      // 掉出视野的 pid 清台账，免得长跑内存越滚越大
      for (const pid of [...track.busySince.keys()]) if (!snap.byPid.has(pid)) track.busySince.delete(pid)
    } else if (!armed) {
      track.busySince.clear()
    }

    /* --- 3) 定时内存释放（可用内存低于触发线才动手） --- */
    const memoryDue =
      cfg.memory.enabled && (force || now - state.lastMemoryPassAt >= cfg.memory.intervalSeconds * 1000)
    let memPlan = null
    if (memoryDue) {
      state.lastMemoryPassAt = now
      const free = state.memFreePercent
      const floor = cfg.memory.triggerWhenFreeMemoryBelowPercent
      if (floor > 0 && free > floor) {
        memPlan = { skipReason: `可用内存 ${free}% 高于触发线 ${floor}%，本轮跳过`, targets: [] }
      } else {
        const isNamed = nameSet(cfg.memory.targetProcessNames)
        const isDev = nameSet(cfg.devReclaim.processNames)
        const minWs = cfg.memory.minWorkingSetMb * 1024 * 1024
        const targets = []
        for (const p of snap.procs) {
          const ws = wsByPid.get(p.pid) ?? 0
          if (ws < minWs) continue
          const c = cpuByPid.get(p.pid)?.cpu ?? 0
          if (c > cfg.memory.maxCpuPercentForWorkingSetTrim) continue
          if (!cfg.memory.trimAllAccessibleProcesses && !isNamed(p.name) && !isDev(p.name)) continue
          targets.push({ proc: p, ws, cpu: c })
        }
        targets.sort((a, b) => b.ws - a.ws)
        memPlan = { targets: targets.slice(0, 12), skipReason: targets.length ? '' : '没有符合条件的进程' }
      }
    }

    /* --- 到这里为止都只是「选」，真正动手前统一过闸 --- */
    const needsGate =
      cpuCands.length || (memPlan?.targets?.length ?? 0) || (cfg.devReclaim.enabled && devCands.length)
    const gate = await gateContext(collectPids(cpuCands, devCands, memPlan), snap, prev)

    let cycleActions = 0
    /** 每条规则各自的「每轮上限」分开算（照它的配置：CPU 守卫 3 / 开发工具回收 5 / 黑名单 3） */
    const cycleUsed = { cpuGuard: 0, devReclaim: 0, blacklist: 0 }
    const budgetOf = (bucket) =>
      bucket === 'devReclaim'
        ? cfg.devReclaim.maxActionsPerCycle
        : bucket === 'blacklist'
          ? cfg.blacklist.maxActionsPerCycle
          : cfg.cpuGuard.maxActionsPerCycle
    const act = async ({ proc, cpu, ws, rule, kind, detail, imagePath, bucket = 'cpuGuard' }) => {
      if (cycleUsed[bucket] >= budgetOf(bucket)) return { skipped: `每轮上限（${budgetOf(bucket)} 个）` }
      if (hourActions() >= cfg.cpuGuard.maxActionsPerHour) return { skipped: '每小时上限' }
      const until = track.cooldownUntil.get(proc.pid) ?? 0
      if (until > now) return { skipped: `冷却中（还有 ${Math.round((until - now) / 1000)}s）` }
      const row = { rule, pid: proc.pid, name: proc.name, imagePath, cpu, ws, detail }
      if (cfg.dryRun) {
        journalAppend({ ...row, outcome: 'simulated' })
        cycleActions += 1
        cycleUsed[bucket] += 1
        track.cooldownUntil.set(proc.pid, now + cfg.cpuGuard.processCooldownSeconds * 1000)
        return { outcome: 'simulated' }
      }
      let outcome = 'failed'
      let extra = ''
      if (kind === 'trim') {
        const r = await trimProcesses([proc.pid])
        const res = r.results?.[proc.pid] ?? r.results?.[String(proc.pid)]
        outcome = res === 'ok' ? 'trimmed' : res ? 'failed' : 'failed'
        if (res && String(res).startsWith('err')) extra = res === 'err5' ? '（权限不够：提权进程）' : `（${res}）`
        if (outcome === 'trimmed') state.trimmedThisSession += 1
      } else if (kind === 'close') {
        const r = await closeWindows([proc.pid], { graceMs: cfg.cpuGuard.gracefulCloseGraceMs })
        if (!r.ok) {
          outcome = 'failed'
          extra = `（${r.error}）`
        } else if ((r.alive ?? []).includes(proc.pid)) {
          const k = await killProcess(proc.pid)
          outcome = k.ok ? 'killed' : 'failed'
          extra = k.ok ? '（先请窗口关闭、超时后结束）' : '（结束失败：权限不够或进程已退出）'
          if (k.ok) state.killedThisSession += 1
        } else {
          outcome = 'closed'
          state.killedThisSession += 1
        }
      } else {
        const k = await killProcess(proc.pid)
        outcome = k.ok ? 'killed' : 'failed'
        if (!k.ok) extra = '（结束失败：权限不够或进程已退出）'
        if (k.ok) state.killedThisSession += 1
      }
      journalAppend({ ...row, outcome, detail: `${detail}${extra}` })
      cycleActions += 1
      cycleUsed[bucket] += 1
      state.actionsThisSession += 1
      actionLog.push(now)
      track.cooldownUntil.set(proc.pid, now + cfg.cpuGuard.processCooldownSeconds * 1000)
      logLine('warn', `[${OUTCOME_TEXT[outcome]}] ${rule} ${proc.name} (PID ${proc.pid}) · ${detail}${extra}`)
      return { outcome }
    }

    /* 3-0) 黑名单：它是唯一能越过白名单与保护层的东西（出厂空），但越不过「不可逾越的那几层」：
       自身进程 / pid ≤ 4 / 内核关键进程 / 打不开的进程。 */
    if (cfg.blacklist.enabled && (cfg.blacklist.entries ?? []).length) {
      for (const entry of cfg.blacklist.entries) {
        if (!entry || entry.enabled === false || !entry.value) continue
        if (cycleUsed.blacklist >= budgetOf('blacklist')) break
        const hit = snap.procs.find((p) => whitelistHit(entry, { pid: p.pid, name: p.name, imagePath: '' }))
        if (!hit) continue
        const p = enrich(hit, gate, { ws: wsByPid.get(hit.pid) ?? 0, cpu: 0 })
        if (p.pid === process.pid || p.pid <= 4) {
          decisions.push({ ...p, rule: 'blacklist', verdict: '已阻止（不可逾越：自身/内核进程）' })
          continue
        }
        if (!entry.exemptProtection && p.protected) {
          journalAppend({ rule: 'blacklist', outcome: 'blocked', pid: p.pid, name: p.name, imagePath: p.imagePath, cpu: 0, ws: p.ws, detail: `命中黑名单 ${entry.match}=${entry.value}，但${p.protected}` })
          state.blockedThisSession += 1
          decisions.push({ ...p, rule: 'blacklist', verdict: `已阻止（${p.protected}）` })
          continue
        }
        const detail = `命中黑名单 ${entry.match}=${entry.value}（${entry.exemptProtection ? '已豁免保护层' : '仍过保护层'}）`
        const r = await act({
          proc: p,
          cpu: 0,
          ws: p.ws,
          rule: 'blacklist',
          kind: entry.action === 'trim' ? 'trim' : 'kill',
          detail,
          imagePath: p.imagePath,
          bucket: 'blacklist',
        })
        decisions.push({ ...p, rule: 'blacklist', verdict: r.skipped ? `跳过（${r.skipped}）` : OUTCOME_TEXT[r.outcome], detail })
      }
    }

    /* 3-1) 开发工具：空闲够久 → 先释放内存；再久 → 结束 */
    for (const c of devCands) {
      if (cycleUsed.devReclaim >= budgetOf('devReclaim')) break
      const p = enrich(c.proc, gate, c)
      if (p.protected) {
        decisions.push({ ...p, rule: 'devReclaim', verdict: `已阻止（${p.protected}）` })
        state.blockedThisSession += 1
        continue
      }
      if (p.whitelisted) {
        decisions.push({ ...p, rule: 'devReclaim', verdict: `已阻止（${p.whitelisted}）` })
        continue
      }
      if (p.hasVisibleWindow && cfg.devReclaim.skipProcessesWithVisibleWindow) {
        decisions.push({ ...p, rule: 'devReclaim', verdict: '已阻止（有可见窗口）' })
        continue
      }
      if (p.ageSeconds < cfg.devReclaim.minProcessAgeSeconds) continue
      if (cfg.devReclaim.skipIfDescendantActive && gate?.activeDescendants?.has(p.pid)) {
        decisions.push({ ...p, rule: 'devReclaim', verdict: '已阻止（子进程还在忙）' })
        continue
      }
      const pastKill = c.idleSeconds >= cfg.devReclaim.killAfterIdleSeconds
      const step =
        cfg.devReclaim.action === 'trim'
          ? 'trim'
          : cfg.devReclaim.action === 'kill'
            ? 'kill'
            : cfg.devReclaim.action === 'gracefulClose'
              ? 'close'
              : pastKill
                ? 'kill'
                : 'trim'
      if (step === 'trim' && p.ws < cfg.devReclaim.minWorkingSetMb * 1024 * 1024) {
        decisions.push({ ...p, rule: 'devReclaim', verdict: `空闲 ${Math.round(c.idleSeconds)}s，占用 ${fmtBytes(p.ws)} 不够释放门槛` })
        continue
      }
      const detail =
        `空闲 ${Math.round(c.idleSeconds)}s（要求 ${cfg.devReclaim.idleSeconds}s），占用 ${fmtBytes(p.ws)}` +
        (step === 'kill' ? `，已超过结束门槛 ${cfg.devReclaim.killAfterIdleSeconds}s` : step === 'close' ? '，先请求窗口关闭' : '')
      const r = await act({ proc: p, cpu: c.cpu, ws: p.ws, rule: 'devReclaim', kind: step, detail, imagePath: p.imagePath, bucket: 'devReclaim' })
      decisions.push({ ...p, rule: 'devReclaim', verdict: r.skipped ? `跳过（${r.skipped}）` : OUTCOME_TEXT[r.outcome], detail })
    }

    /* 3-2) CPU 守卫：单进程持续超线 → 按动作处置 */
    for (const c of cpuCands) {
      if (cycleUsed.cpuGuard >= budgetOf('cpuGuard')) break
      const p = enrich(c.proc, gate, c)
      if (p.hasVisibleWindow && cfg.cpuGuard.skipProcessesWithVisibleWindow) {
        decisions.push({ ...p, rule: 'cpuGuard', verdict: '已阻止（有可见窗口）', detail: `CPU ${c.cpu}%` })
        continue
      }
      const wl = (cfg.whitelist ?? []).find((e) => whitelistHit(e, p))
      if (wl) {
        journalAppend({ rule: 'cpuGuard', outcome: 'blocked', pid: p.pid, name: p.name, imagePath: p.imagePath, cpu: c.cpu, ws: p.ws, detail: whitelistReason(wl) })
        state.blockedThisSession += 1
        decisions.push({ ...p, rule: 'cpuGuard', verdict: `已阻止（${whitelistReason(wl)}）`, detail: `CPU ${c.cpu}%` })
        continue
      }
      if (p.protected) {
        journalAppend({ rule: 'cpuGuard', outcome: 'blocked', pid: p.pid, name: p.name, imagePath: p.imagePath, cpu: c.cpu, ws: p.ws, detail: p.protected })
        state.blockedThisSession += 1
        decisions.push({ ...p, rule: 'cpuGuard', verdict: `已阻止（${p.protected}）`, detail: `CPU ${c.cpu}%` })
        continue
      }
      if (p.ageSeconds < cfg.cpuGuard.minProcessAgeSeconds) continue
      const kind = cfg.cpuGuard.action === 'trim' ? 'trim' : cfg.cpuGuard.action === 'kill' ? 'kill' : 'close'
      const detail = `CPU ${c.cpu}%（阈值 ${cfg.cpuGuard.processThresholdPercent}%），持续 ${Math.round(c.busySeconds)}s（要求 ${cfg.cpuGuard.processSustainSeconds}s）`
      const r = await act({ proc: p, cpu: c.cpu, ws: p.ws, rule: 'cpuGuard', kind, detail, imagePath: p.imagePath, bucket: 'cpuGuard' })
      decisions.push({ ...p, rule: 'cpuGuard', verdict: r.skipped ? `跳过（${r.skipped}）` : OUTCOME_TEXT[r.outcome], detail })
    }

    /* 3-3) 定时内存释放（可逆动作，不过 CPU 守卫那套预算） */
    if (memPlan) {
      if (!memPlan.targets?.length) {
        const why = memPlan.skipReason || '没有符合条件的进程'
        tickNotes.push(`定时内存释放跳过：${why}`)
        logLine('info', `定时内存释放跳过：${why}`)
      } else {
        const list = []
        for (const t of memPlan.targets) {
          const p = enrich(t.proc, gate, t)
          if (p.protected || p.hasVisibleWindow || p.whitelisted) continue
          list.push({ ...p, ws: t.ws, cpu: t.cpu })
        }
        if (!list.length) {
          const why = `${memPlan.targets.length} 个候选都被保护层或可见窗口挡下了`
          tickNotes.push(`定时内存释放跳过：${why}`)
          logLine('info', `定时内存释放跳过：${why}`)
        } else if (cfg.dryRun) {
          for (const p of list) decisions.push({ ...p, rule: 'memoryTrim', verdict: '演练', detail: `工作集 ${fmtBytes(p.ws)} · 定时内存释放` })
          journalAppend({
            rule: 'memoryTrim',
            outcome: 'simulated',
            pid: list[0].pid,
            name: list[0].name,
            cpu: 0,
            ws: list.reduce((s, x) => s + x.ws, 0),
            detail: `演练：本轮将释放 ${list.length} 个进程的工作集（合计 ${fmtBytes(list.reduce((s, x) => s + x.ws, 0))}）`,
          })
        } else {
          const r = await trimProcesses(list.map((x) => x.pid))
          let released = 0
          for (const p of list) {
            const res = r.results?.[p.pid] ?? r.results?.[String(p.pid)]
            const ok = res === 'ok'
            if (ok) released += p.ws
            journalAppend({
              rule: 'memoryTrim',
              outcome: ok ? 'trimmed' : 'failed',
              pid: p.pid,
              name: p.name,
              imagePath: p.imagePath,
              cpu: p.cpu,
              ws: p.ws,
              detail: `工作集 ${fmtBytes(p.ws)} · 定时内存释放${ok ? '' : res === 'err5' ? '（权限不够：提权进程）' : ''}`,
            })
            decisions.push({ ...p, rule: 'memoryTrim', verdict: ok ? '已释放内存' : '失败', detail: `工作集 ${fmtBytes(p.ws)}` })
            if (ok) state.trimmedThisSession += 1
          }
          if (released) {
            logLine('info', `定时内存释放：${list.length} 个进程，归还 ${fmtBytes(released)}`)
            tickNotes.push(`定时内存释放：归还 ${fmtBytes(released)}`)
          }
        }
      }
    }

    state.lastDecision = decisions.length ? `${decisions.length} 项判定` : '无事可做'
    tickLog = [{ at: snap.at, cpuPercent: state.cpuPercent, memFreePercent: state.memFreePercent, procCount: snap.processes, armed, source, decisions, notes: tickNotes }]
    return {
      ok: true,
      at: snap.at,
      cpuPercent: state.cpuPercent,
      memFreePercent: state.memFreePercent,
      processCount: snap.processes,
      armed,
      top: top.slice(0, 15),
      decisions,
      notes: tickNotes,
      dryRun: !!cfg.dryRun,
    }
  } catch (err) {
    state.lastError = err?.message ?? String(err)
    logLine('error', `tick 失败：${state.lastError}`)
    return { ok: false, error: state.lastError }
  } finally {
    state.busy = false
  }
}

let lastSnap = null

function collectPids(cpuCands, devCands, memPlan) {
  const set = new Set()
  for (const c of cpuCands) set.add(c.proc.pid)
  for (const c of devCands) set.add(c.proc.pid)
  for (const t of memPlan?.targets ?? []) set.add(t.proc.pid)
  return [...set]
}

/**
 * 动手前才做的「贵」检查，一次问清：进程年龄、镜像路径、有没有可见窗口、前台是谁、
 * 谁还有活着的子进程（开发工具回收要看这个）。平时不查 —— 这些每个都是几百毫秒。
 *
 * 子进程活跃度靠**懒查**：`Win32_Process` 的父子关系要一次 CIM 查询（约 1 秒），
 * 所以只在「有候选要动手」时才问，而不是每个 tick 都问 —— 它自己是用原生
 * NtQuerySystemInformation 每拍都拿父子表，我们没有那个廉价通道。
 */
async function gateContext(pids, snap, prev) {
  const ctx = { detail: new Map(), visible: new Set(), foreground: 0, activeDescendants: new Set() }
  if (!pids.length) return ctx
  const d = await snapshot({ pids })
  if (d) for (const [pid, x] of d.detail ?? []) ctx.detail.set(Number(pid), x)
  ctx.visible = await visibleWindowPids()
  ctx.foreground = await foregroundPid()
  try {
    const r = await runHidden(
      `powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"`,
      { timeout: 20000 },
    )
    const parsed = JSON.parse(String(r.stdout ?? '[]').trim() || '[]')
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    const children = new Map()
    for (const row of rows) {
      const pid = Number(row?.ProcessId)
      const parent = Number(row?.ParentProcessId)
      if (!pid || !parent) continue
      if (!children.has(parent)) children.set(parent, [])
      children.get(parent).push(pid)
    }
    const before = new Map((prev?.procs ?? []).map((p) => [p.pid, p.cpuMs ?? 0]))
    const after = new Map((snap?.procs ?? []).map((p) => [p.pid, p.cpuMs ?? 0]))
    const busy = (pid) => {
      const a = before.get(pid)
      const b = after.get(pid)
      return a !== undefined && b !== undefined && b - a > 50 // 50ms：约 0.5% 一个核，和 idleCpuPercent 同量级
    }
    const walk = (pid, depth = 0) => {
      if (depth > 4) return false
      for (const child of children.get(pid) ?? []) {
        if (busy(child)) return true
        if (walk(child, depth + 1)) return true
      }
      return false
    }
    for (const pid of pids) if (walk(pid)) ctx.activeDescendants.add(pid)
  } catch {
    /* 查不到子进程就算没有 —— 只会更保守地不动手，不会更激进 */
  }
  return ctx
}

/** 把候选进程补上「贵」信息（年龄、路径、命令行、可见窗口、保护与白名单判定） */
function enrich(proc, gate, c) {
  const detail = gate?.detail?.get(proc.pid)
  const startTime = detail?.startTime ? Date.parse(detail.startTime) : 0
  // gate.detail 是按 pid 二次查来的，可能缺项；候选进程自身就带着快照的 path/cmd，
  // 回落过去，否则 cmd/path 型白名单会在这一拍静默不命中（活服务会被判"该结束"）。
  const imagePath = detail?.path || proc?.path || ''
  const out = {
    pid: proc.pid,
    name: proc.name,
    ws: c?.ws ?? 0,
    imagePath,
    cmd: detail?.cmd || proc?.cmd || '',
    ageSeconds: startTime ? (Date.now() - startTime) / 1000 : Number.MAX_SAFE_INTEGER,
    hasVisibleWindow: gate?.visible?.has(proc.pid) ?? false,
  }
  out.protected = protectedVerdict(out, engineConfig(), { foregroundPid: gate?.foreground ?? 0, selfPid: process.pid })
  const wl = (engineConfig().whitelist ?? []).find((e) => whitelistHit(e, out))
  out.whitelisted = wl ? whitelistReason(wl) : ''
  return out
}

/** 有可见顶层窗口的 pid 集合（EnumWindows 一次问清；只在动手前调） */
async function visibleWindowPids() {
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class PgVis {
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] private static extern int GetWindowThreadProcessId(IntPtr hWnd, out int pid);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr hWnd, int index);
  public static string Pids() {
    HashSet<int> set = new HashSet<int>();
    EnumWindowsProc cb = delegate(IntPtr h, IntPtr l) {
      int p; GetWindowThreadProcessId(h, out p);
      if (p != 0 && IsWindowVisible(h) && GetWindow(h, 4) == IntPtr.Zero && (GetWindowLong(h, -20) & 0x80) == 0) set.Add(p);
      return true;
    };
    EnumWindows(cb, IntPtr.Zero);
    string[] parts = new string[set.Count]; int i = 0;
    foreach (int v in set) parts[i++] = v.ToString();
    return string.Join(",", parts);
  }
}
'@
Write-Output ("##PG##" + [PgVis]::Pids())
`
  const file = path.join(os.tmpdir(), `pguard-visible-${process.pid}.ps1`)
  try {
    fs.writeFileSync(file, `\uFEFF${script}`, 'utf8')
    const r = await runHidden(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${file}"`, { timeout: 20000 })
    const m = String(r.stdout ?? '').match(/##PG##(.*)/)
    if (!m) return new Set()
    return new Set(
      m[1]
        .split(',')
        .map((x) => Number(String(x).trim()))
        .filter((n) => n > 0),
    )
  } catch {
    return new Set()
  } finally {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------ 启停 --- */

export function isRunning() {
  return state.running
}

export function start({ immediate = true } = {}) {
  const cfg = engineConfig()
  if (!cfg.enabled) return { ok: false, error: '引擎在配置里被关掉了（pguard.enabled）' }
  if (state.running) return { ok: true, alreadyRunning: true }
  state.running = true
  state.paused = false
  state.startedAt = Date.now()
  state.lastError = ''
  const period = Math.max(1000, Math.round(cfg.monitor.hotSampleSeconds * 1000))
  state.timer = setInterval(() => {
    tick({ source: 'timer' }).catch((err) => logLine('error', `定时轮失败：${err?.message ?? err}`))
  }, period)
  state.timer.unref?.()
  logLine('info', `引擎已启动（演练=${cfg.dryRun ? '是' : '否'}，周期 ${period}ms，判定线 CPU≥${cfg.cpuGuard.triggerPercent}%）`)
  if (immediate) tick({ source: 'start' }).catch(() => {})
  return { ok: true, dryRun: !!cfg.dryRun }
}

export function stop({ reason = '手动停止' } = {}) {
  if (!state.running) return { ok: true, alreadyStopped: true }
  if (state.timer) clearInterval(state.timer)
  state.timer = null
  state.running = false
  state.armed = false
  state.overSince = 0
  state.normalSince = 0
  track.busySince.clear()
  logLine('info', `引擎已停止（${reason}）`)
  return { ok: true }
}

export function setPaused(on, reason = '') {
  state.paused = !!on
  logLine('info', on ? `已暂停判定${reason ? `（${reason}）` : ''}，采样继续` : '已恢复判定')
  return { ok: true, paused: state.paused }
}

/* ----------------------------------------------------------- 演练 --- */

/**
 * 切演练模式。
 *
 * 出厂是开的（dryRun 默认 true）。关掉之前请自己确认一件事：**同一台机器上不要再跑
 * 第二个做同样事情的守卫** —— 两个守卫各自动手一次会重复结束同一个进程。
 * 这条只是文档约束，代码里不再有互斥闸。
 */
export async function setDryRun(on) {
  const want = !!on
  const r = setSettings({ dryRun: want })
  if (!r.ok) return r
  logLine('warn', want ? '切回演练模式' : '关闭演练模式（真实执行）')
  return {
    ok: true,
    dryRun: want,
    hint: want
      ? '已回到演练模式：只记录不动手'
      : '已关掉演练模式：规则会真的释放内存/结束进程 —— 建议先翻一遍审计记录，确认命中过的东西你都不在意',
  }
}

/* --------------------------------------------------------- 手动动作 --- */

/**
 * 手动释放某个进程的工作集（可逆动作，仍然过保护层）。
 * 注意：**手动动作不看演练开关与预算**（那两样管的是「规则自己动手」），但仍会留审计。
 */
export async function trimPid(pid) {
  const id = Number(pid)
  if (!id) return { ok: false, error: '缺少 pid' }
  const snap = await snapshot({ pids: [id] })
  if (!snap) return { ok: false, error: '采样失败' }
  const proc = snap.byPid.get(id)
  if (!proc) return { ok: false, error: `进程 ${id} 不在了` }
  const gate = await gateContext([id], snap, null)
  const p = enrich(proc, gate)
  if (p.protected) return { ok: false, error: `保护层拦下了：${p.protected}` }
  const r = await trimProcesses([id])
  const res = r.results?.[id] ?? r.results?.[String(id)]
  if (res === 'ok') {
    journalAppend({ rule: 'memoryTrim', outcome: 'trimmed', pid: p.pid, name: p.name, imagePath: p.imagePath, cpu: 0, ws: p.ws, detail: `工作集 ${fmtBytes(p.ws)} · 手动释放内存` })
    state.trimmedThisSession += 1
    return { ok: true, released: p.ws }
  }
  const why = res === 'err5' ? '权限不够（提权进程，工作台不是管理员）' : String(res ?? '未知错误')
  return { ok: false, error: `释放失败：${why}` }
}

/** 清理系统待机列表（提权，会弹一次 UAC） */
export async function purgeStandby() {
  const r = await purgeStandbyList()
  if (r.ok) {
    state.lastPurgeAt = Date.now()
    journalAppend({ rule: 'memoryTrim', outcome: 'trimmed', pid: 0, name: '', cpu: 0, ws: 0, detail: '手动清理系统待机列表（提权执行）' })
    logLine('info', '已清理系统待机列表（提权）')
  }
  return r
}

/* ------------------------------------------------------------ 状态 --- */

export async function status({ journalLimit = 30 } = {}) {
  const cfg = engineConfig()
  const j = journalStats(journalLimit)
  const params = effectiveSentence(cfg)
  const notes = []
  if (!cfg.dryRun) notes.push('⚠ 现在不是演练：规则会真的释放内存、结束进程。')
  if (!fs.existsSync(configPath())) notes.push('引擎配置还没落盘（现在是出厂默认值，改一次设置就会写出来）')
  return {
    ok: true,
    kind: 'pguard',
    installed: true,
    running: state.running,
    paused: state.paused,
    dryRun: !!cfg.dryRun,
    elevated: false,
    startedAt: state.startedAt,
    ticks: state.ticks,
    lastTickAt: state.lastTickAt,
    lastSampleAt: state.lastSampleAt,
    lastError: state.lastError,
    lastDecision: state.lastDecision,
    armed: state.armed,
    cpuPercent: state.cpuPercent,
    memFreePercent: state.memFreePercent,
    memTotalBytes: os.totalmem(),
    memFreeBytes: os.freemem(),
    procCount: state.procCount,
    cpuCount: os.cpus().length,
    selfWorkingSetBytes: process.memoryUsage().rss,
    session: {
      records: j.todayCount,
      ended: state.killedThisSession,
      released: state.trimmedThisSession,
      blocked: state.blockedThisSession,
      simulated: j.todayByOutcome.simulated ?? 0,
    },
    config: cfg,
    params,
    journal: j,
    log: readLog(30),
    notes,
    paths: { config: configPath(), journal: journalPath(), log: logPath() },
    lastTick: tickLog[0] ?? null,
  }
}

/** 当前生效参数，拼成一句人话（照它概览页的说法） */
export function effectiveSentence(cfg = engineConfig()) {
  const g = cfg.cpuGuard
  const m = cfg.memory
  const d = cfg.devReclaim
  const actionText = g.action === 'gracefulClose' ? '先关窗口再结束' : g.action === 'kill' ? '直接结束' : '只释放内存'
  const devText = !d.enabled
    ? '开发进程回收已关。'
    : `开发进程空闲 ${d.idleSeconds}s 后释放内存、${d.killAfterIdleSeconds}s 后${
        d.action === 'trimThenKill' ? '结束' : d.action === 'gracefulClose' ? '先请求关窗口' : d.action === 'kill' ? '结束' : '仍只释放内存'
      }（释放门槛 ${d.minWorkingSetMb} MB）。`
  return {
    dryRun: !!cfg.dryRun,
    sentence:
      `整机 CPU ≥ ${g.triggerPercent}% 持续 ${g.triggerSustainSeconds}s 触发，≤ ${g.releasePercent}% 才解除；` +
      `单进程 ≥ ${g.processThresholdPercent}% 持续 ${g.processSustainSeconds}s 视为失控，动作：${actionText}。` +
      devText +
      ` 内存：每 ${m.intervalSeconds}s 一次，可用内存高于 ${m.triggerWhenFreeMemoryBelowPercent}% 时跳过。`,
    actionText,
    devText,
  }
}

/* ------------------------------------------------------------ 名单 --- */

/** 名单增删（白名单两向都可改；受保护名单只读 —— 那是安全网） */
export function listsOp({ list, action, entry, index } = {}) {
  if (list !== 'whitelist' && list !== 'blacklist') return { ok: false, error: '只支持 whitelist / blacklist' }
  const cfg = engineConfig({ force: true })
  const cur = { ...cfg, [list]: { ...(cfg[list] ?? {}) } }
  if (list === 'whitelist') {
    const arr = Array.isArray(cur.whitelist) ? [...cur.whitelist] : []
    if (action === 'add') {
      if (!entry?.value) return { ok: false, error: '缺少 value' }
      arr.push({
        enabled: true,
        match: MATCH_KINDS.includes(entry.match) ? entry.match : 'imageName',
        value: String(entry.value),
        note: String(entry.note ?? ''),
      })
    } else if (action === 'remove') {
      arr.splice(Number(index) || 0, 1)
    } else if (action === 'toggle') {
      const i = Number(index) || 0
      if (arr[i]) arr[i] = { ...arr[i], enabled: arr[i].enabled === false }
    } else return { ok: false, error: `不认识的动作 ${action}` }
    cur.whitelist = arr
  } else {
    const bl = { ...(cur.blacklist ?? {}) }
    const arr = Array.isArray(bl.entries) ? [...bl.entries] : []
    if (action === 'add') {
      if (!entry?.value) return { ok: false, error: '缺少 value' }
      arr.push({
        enabled: true,
        match: MATCH_KINDS.includes(entry.match) ? entry.match : 'imageName',
        value: String(entry.value),
        action: entry.action === 'trim' ? 'trim' : 'kill',
        exemptProtection: entry.exemptProtection === true,
        note: String(entry.note ?? ''),
      })
    } else if (action === 'remove') {
      arr.splice(Number(index) || 0, 1)
    } else if (action === 'toggle') {
      const i = Number(index) || 0
      if (arr[i]) arr[i] = { ...arr[i], enabled: arr[i].enabled === false }
    } else return { ok: false, error: `不认识的动作 ${action}` }
    bl.entries = arr
    cur.blacklist = bl
  }
  try {
    writeConfig(cur)
  } catch (err) {
    return { ok: false, error: `写入失败：${err.message}` }
  }
  logLine('info', `名单改动：${list} ${action}`)
  return { ok: true, counts: { whitelist: (cur.whitelist ?? []).length, blacklist: (cur.blacklist?.entries ?? []).length } }
}

/** 进程表（面板的「进程」页用）：CPU 排行 + 开发工具标记 + 保护判定 */
export async function processTable({ limit = 60 } = {}) {
  const before = await snapshot()
  await new Promise((r) => setTimeout(r, 700))
  const after = await snapshot()
  if (!after) return { ok: false, error: '采样失败' }
  const cfg = engineConfig()
  const isDev = nameSet(cfg.devReclaim.processNames)
  const top = topByCpu(before, after, limit)
  const gate = await gateContext(
    top.map((t) => t.pid),
    after,
    before,
  )
  const rows = top.map((t) => {
    const p = enrich({ pid: t.pid, name: t.name }, gate, { ws: t.ws })
    return {
      pid: t.pid,
      name: t.name,
      cpu: t.cpu,
      ws: t.ws,
      devTool: isDev(t.name),
      idleSeconds: track.idleSince.has(t.pid) ? Math.round((after.at - track.idleSince.get(t.pid)) / 1000) : null,
      protected: p.protected || '',
      whitelisted: p.whitelisted || '',
      selected: true,
    }
  })
  return {
    ok: true,
    at: after.at,
    cpuPercent: state.cpuPercent,
    memFreePercent: Math.round((after.memFreeBytes / after.memTotalBytes) * 1000) / 10,
    memUsedPercent: Math.round((1 - after.memFreeBytes / after.memTotalBytes) * 1000) / 10,
    processes: after.processes,
    rows,
  }
}
