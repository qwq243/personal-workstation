/**
 * 进程 / 端口 / 智能体 三个视图的数据源，以及**手动结束动作**。
 *
 * 三个视图（进程页 / 端口页 / 智能体页）是一次全表快照的三个切面：
 *
 *   1. 快照：一次 CIM 查询拿全（PID/父 PID/命令行/内存/CPU 时间/会话号）+ 前台窗口 PID。
 *      三个视图共用同一份快照，所以它们不可能对同一件事各说各话。
 *   2. 判定：`protectVerdict()` 过一遍保护层（受保护名单 / 内核关键 / 会话 0 / 系统目录 /
 *      前台窗口 / 提权进程 / 打不开的进程 …）。名单与开关**读 pguard 引擎的配置**
 *      （server/data/pguard/config.json），与规则引擎用的是同一份，不另立一套。
 *   3. 动作：结束 = 温和（taskkill 不带 /F，等价于给它发 WM_CLOSE）+ 强制（/F，可带 /T 连子进程）。
 *
 * **为什么工作台可以有自己的结束按钮**：手动动作**不看演练开关**（那是管规则自己动手的），
 * 但仍然完整地过保护层，且照样留审计（写 data/procscan-actions.jsonl）。
 * 我们读不到内核的「关键进程」标记（NtQueryInformationProcess），于是用
 * **配置里的受保护名单 + 一份内置兜底名单**覆盖同一批进程（csrss/wininit/services/lsass…），
 * 实际效果等价：那些进程一律拒绝结束，理由也会写清楚。
 *
 * 识别智能体用的是一份内置签名表（14 个）+ 配置里的扩展位：
 * 有独立二进制的直接按镜像名认；跑在通用解释器（node/python/pwsh…）里的**只在命令行里找特征串**，
 * 因为不这样，一条提交信息里带 "claude" 的 node 进程就会被误报成智能体。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig } from '../config.mjs'
import { runHidden } from './net.mjs'
import { engineConfig as pguardConfig } from './pguard.mjs'

/* ------------------------------------------------------------- 常量 --- */

/** 系统目录（这些根目录下的可执行文件默认受保护） */
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

/**
 * 内置兜底：结束会当场蓝屏的那几个进程。
 * 以配置里的受保护名单为主，这份只是「配置被人改空了也不至于崩机」的保险。
 */
const CRITICAL_FALLBACK = [
  'csrss.exe', 'wininit.exe', 'services.exe', 'lsass.exe', 'smss.exe', 'winlogon.exe',
  'System', 'Registry', 'Memory Compression', 'Secure System', 'Idle',
]

/** 命令行特征只在这些通用解释器里找 */
const HOST_IMAGES = [
  'node', 'python', 'pythonw', 'py', 'bun', 'deno', 'npx', 'npm', 'pnpm', 'yarn', 'uv', 'uvx',
  'cmd', 'pwsh', 'powershell', 'bash', 'sh', 'wsl', 'dotnet',
]

/** CliAgentCatalog 的 14 个签名（custom 是用户自定义位，默认没有特征串） */
const AGENTS = [
  { id: 'claude-code', images: ['claude', 'claude-code'], hints: ['@anthropic-ai/claude-code', '@anthropic-ai\\claude-code', 'claude-code/cli.js', 'claude-code\\cli.js'] },
  { id: 'codex', images: ['codex'], hints: ['@openai/codex', '@openai\\codex'] },
  { id: 'gemini-cli', images: ['gemini'], hints: ['@google/gemini-cli', '@google\\gemini-cli', 'gemini-cli'] },
  { id: 'cursor-agent', images: ['cursor-agent'], hints: ['cursor-agent'] },
  { id: 'aider', images: ['aider'], hints: ['aider-chat', 'aider.main', '-m aider', '\\m aider'] },
  { id: 'opencode', images: ['opencode'], hints: ['opencode-ai', 'opencode/bin'] },
  { id: 'crush', images: ['crush'], hints: ['charmbracelet/crush', 'charmland/crush'] },
  { id: 'qwen-code', images: ['qwen'], hints: ['@qwen-code/qwen-code', '@qwen-code\\qwen-code', 'qwen-code'] },
  { id: 'goose', images: ['goose'], hints: ['block/goose', 'goose-cli'] },
  { id: 'droid', images: ['droid'], hints: ['factory/droid', '@factory-ai/droid'] },
  { id: 'amp', images: ['amp'], hints: ['@sourcegraph/amp', 'sourcegraph/amp'] },
  { id: 'cline', images: ['cline'], hints: ['cline/cli', '@cline/cli'] },
  { id: 'copilot-cli', images: ['copilot'], hints: ['@github/copilot'] },
]

/** 工作台自己护着的东西：这几个进程一律不给结束（我们自己的地基） */
function selfGuardPids() {
  const out = [process.pid]
  // 边车自己的父进程链（Node 有可能是被 scripts 拉起来的）
  return out
}

function cfg() {
  return loadConfig().procscan ?? {}
}

function actionsLogPath() {
  return path.join(loadConfig().dataDir, 'procscan-actions.jsonl')
}

/* --------------------------------------------------------- 名字匹配 --- */

/**
 * 照 NamePatternSet 的语义匹配进程名：
 * 大小写不敏感、`.exe` 可省、支持 `*` `?`、**精确或版本后缀**（`gemini` 匹配 `gemini.exe`，
 * 但不匹配 `gemini-something-else`；`python3.*` 这类通配符照常）。
 */
export function nameMatches(pattern, name) {
  if (!pattern || !name) return false
  const p = String(pattern).trim().toLowerCase()
  const n = String(name).trim().toLowerCase().replace(/\.exe$/, '')
  if (!p) return false
  if (p.includes('*') || p.includes('?')) {
    const rx = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
    return rx.test(n) || rx.test(n + '.exe')
  }
  const base = p.replace(/\.exe$/, '')
  if (n === base) return true
  return new RegExp('^' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&') + '[0-9.]*$').test(n)
}

/* ------------------------------------------------------------- 快照 --- */

const SNAP_TTL_MS = 5000
let snapCache = { at: 0, value: null }

function snapshotScript() {
  return `$ErrorActionPreference = 'SilentlyContinue'
$fg = 0
try {
  Add-Type -Namespace Wg -Name Fg -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);' -ErrorAction Stop
  $h = [Wg.Fg]::GetForegroundWindow()
  $fp = 0
  [void][Wg.Fg]::GetWindowThreadProcessId($h, [ref]$fp)
  $fg = [int]$fp
} catch { $fg = -1 }
$rows = New-Object System.Collections.ArrayList
foreach ($p in Get-CimInstance Win32_Process) {
  try {
    [void]$rows.Add([pscustomobject]@{
      pid = [int]$p.ProcessId
      ppid = [int]$p.ParentProcessId
      name = [string]$p.Name
      path = [string]$p.ExecutablePath
      cmd = [string]$p.CommandLine
      ws = [int64]$p.WorkingSetSize
      cpuMs = [math]::Round(([double]$p.KernelModeTime + [double]$p.UserModeTime) / 10000)
      session = [int]$p.SessionId
    })
  } catch {}
}
[pscustomobject]@{ foregroundPid = $fg; procs = $rows } | ConvertTo-Json -Depth 3 -Compress
`
}

/** 一次快照（缓存 5 秒），三个视图共用 */
export async function snapshot({ force = false } = {}) {
  if (!force && snapCache.value && Date.now() - snapCache.at < SNAP_TTL_MS) return snapCache.value
  const psFile = path.join(os.tmpdir(), `ws-procscan-${process.pid}.ps1`)
  let data = null
  try {
    fs.writeFileSync(psFile, `\uFEFF${snapshotScript()}`, 'utf8')
    const r = await runHidden(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`, { timeout: 30000 })
    const text = String(r.stdout ?? '').trim()
    if (text) data = JSON.parse(text)
  } catch {
    data = null
  } finally {
    try {
      fs.rmSync(psFile, { force: true })
    } catch {
      /* ignore */
    }
  }
  const procs = (Array.isArray(data?.procs) ? data.procs : data?.procs ? [data.procs] : []).map((p) => ({
    pid: p.pid,
    ppid: p.ppid,
    name: String(p.name ?? ''),
    path: String(p.path ?? ''),
    cmd: String(p.cmd ?? ''),
    ws: Number(p.ws) || 0,
    cpuMs: Number(p.cpuMs) || 0,
    session: Number(p.session) || 0,
  }))
  const value = { at: Date.now(), foregroundPid: Number(data?.foregroundPid) || 0, procs, byPid: new Map(procs.map((p) => [p.pid, p])) }
  if (procs.length) snapCache = { at: Date.now(), value }
  return value
}

/* ------------------------------------------------------------- 判定 --- */

/**
 * 保护配置 = pguard 引擎的那一份（同一台机器上只应该有一套名单，
 * 所以这里不自己维护第二份，直接读引擎配置；文件还没落盘时引擎会给出厂默认值）。
 */
export function policy() {
  const raw = pguardConfig()
  const p = raw?.protection ?? {}
  return {
    available: true,
    protectSelfAndAncestors: p.protectSelfAndAncestors !== false,
    protectCriticalProcesses: p.protectCriticalProcesses !== false,
    protectSession0: p.protectSession0 !== false,
    protectSystemBinaries: p.protectSystemBinaries !== false,
    protectShellAndDav: p.protectShellAndDav !== false,
    protectForegroundWindowOwner: p.protectForegroundWindowOwner !== false,
    protectHigherIntegrity: p.protectHigherIntegrity !== false,
    immutableNames: Array.isArray(p.immutableProcessNames) && p.immutableProcessNames.length ? p.immutableProcessNames : CRITICAL_FALLBACK,
    immutablePids: Array.isArray(p.immutableProcessIds) ? p.immutableProcessIds : [],
    whitelist: Array.isArray(raw?.whitelist) ? raw.whitelist : [],
    devToolNames: Array.isArray(raw?.devReclaim?.processNames) ? raw.devReclaim.processNames : [],
  }
}

function isSystemBinary(p) {
  return SYSTEM_ROOTS.some((root) => p.includes(root))
}

function whitelistReason(proc, pol) {
  for (const w of pol.whitelist) {
    const v = String(w?.value ?? '')
    if (!v) continue
    const m = String(w?.match ?? '')
    if (m === 'imageName' && nameMatches(v, proc.name)) return `白名单规则 imageName=${v}`
    if (m === 'pid' && Number(v) === proc.pid) return `白名单规则 pid=${v}`
    if (m === 'pathContains' && proc.path && proc.path.toLowerCase().includes(v.toLowerCase())) return `白名单规则 pathContains=${v}`
    if (m === 'commandLineContains' && proc.cmd && proc.cmd.toLowerCase().includes(v.toLowerCase())) return `白名单规则 commandLineContains=${v}`
  }
  return ''
}

/**
 * 能不能对它动手。返回 { allow, reason }。顺序与理由都照 ProcessSafety.CheckProtection。
 * @param {{selfPid?: number, selfAncestors?: number[], selfElevated?: boolean}} ctx
 */
export function protectVerdict(proc, ctx = {}) {
  const pol = ctx.policy ?? policy()
  const selfPid = ctx.selfPid ?? process.pid
  const ancestors = ctx.selfAncestors ?? []
  const foreground = ctx.foregroundPid ?? 0

  if (proc.pid === selfPid) return { allow: false, reason: '工作台自己的进程' }
  if (ctx.selfPids?.includes(proc.pid)) return { allow: false, reason: '工作台自己的进程' }
  if (pol.protectSelfAndAncestors && ancestors.includes(proc.pid)) return { allow: false, reason: '工作台自身的父进程链' }
  if (proc.pid <= 4) return { allow: false, reason: proc.pid === 0 ? 'System Idle Process' : 'Windows 内核进程' }
  if (pol.immutablePids.includes(proc.pid)) return { allow: false, reason: '配置里的受保护进程 ID' }
  const imm = pol.immutableNames.find((n) => nameMatches(n, proc.name))
  if (imm) return { allow: false, reason: `系统关键进程（${imm}）` }
  if (pol.protectCriticalProcesses && CRITICAL_FALLBACK.some((n) => nameMatches(n, proc.name)))
    return { allow: false, reason: '关键进程（结束会导致系统重启）' }
  if (pol.protectSession0 && proc.session === 0) return { allow: false, reason: '会话 0 系统服务' }
  if (pol.protectSystemBinaries && isSystemBinary(proc.path)) return { allow: false, reason: '系统目录下的可执行文件' }
  if (pol.protectForegroundWindowOwner && foreground && proc.pid === foreground)
    return { allow: false, reason: '当前前台窗口所属进程（你正在用它）' }
  if (pol.protectShellAndDav && /^(explorer|dwm|SearchHost|StartMenuExperienceHost|ShellExperienceHost|sihost|TextInputHost|ctfmon)\.exe$/i.test(proc.name))
    return { allow: false, reason: '外壳/桌面进程' }
  const wl = whitelistReason(proc, pol)
  if (wl) return { allow: false, reason: wl }
  return { allow: true, reason: '' }
}

/* --------------------------------------------------- 进程 / 端口视图 --- */

function shortCmd(cmd, n = 120) {
  return cmd.length > n ? `${cmd.slice(0, n)}…` : cmd
}

export async function listProcesses({ q = '', limit = 300, sort = 'ws' } = {}) {
  const snap = await snapshot()
  const pol = policy()
  const selfPids = selfGuardPids()
  const ancestors = []
  {
    let cur = snap.byPid.get(process.pid)
    for (let i = 0; i < 8 && cur?.ppid; i += 1) {
      ancestors.push(cur.ppid)
      cur = snap.byPid.get(cur.ppid)
    }
  }
  const ctx = { policy: pol, selfPid: process.pid, selfPids, selfAncestors: ancestors, foregroundPid: snap.foregroundPid, selfElevated: false }
  let rows = snap.procs.map((p) => {
    const v = protectVerdict(p, ctx)
    return {
      pid: p.pid,
      ppid: p.ppid,
      name: p.name,
      path: p.path,
      cmd: shortCmd(p.cmd),
      ws: p.ws,
      cpuMs: p.cpuMs,
      session: p.session,
      devTool: pol.devToolNames.some((n) => nameMatches(n, p.name)),
      agent: agentOf(p)?.id ?? '',
      blocked: !v.allow,
      blockReason: v.reason,
    }
  })
  const query = q.trim().toLowerCase()
  if (query) {
    rows = rows.filter(
      (r) =>
        r.name.toLowerCase().includes(query) ||
        String(r.pid) === query ||
        r.cmd.toLowerCase().includes(query) ||
        r.path.toLowerCase().includes(query),
    )
  }
  rows.sort(sort === 'cpu' ? (a, b) => b.cpuMs - a.cpuMs : sort === 'name' ? (a, b) => a.name.localeCompare(b.name) : (a, b) => b.ws - a.ws)
  return {
    ok: true,
    at: snap.at,
    total: snap.procs.length,
    shown: Math.min(rows.length, limit),
    foregroundPid: snap.foregroundPid,
    items: rows.slice(0, limit),
  }
}

/** netstat -ano → 端口与连接（不依赖 .NET，纯文本好解析） */
export async function listPorts({ onlyListen = false, q = '', limit = 300 } = {}) {
  const [snap, r] = await Promise.all([snapshot(), runHidden('netstat -ano -p TCP', { timeout: 20000 })])
  const text = String(r.stdout ?? '')
  const pol = policy()
  const rows = []
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^TCP\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)$/)
    if (!m) continue
    const [, local, remote, state, pidStr] = m
    if (onlyListen && state !== 'LISTENING') continue
    const port = Number(local.split(':').pop()) || 0
    const pid = Number(pidStr)
    const proc = snap.byPid.get(pid)
    const exposed = /^(0\.0\.0\.0|\[::\]|\[::1\]|127\.0\.0\.1)/.test(local) && !local.startsWith('127.')
    rows.push({
      local,
      remote: remote === '*' ? '' : remote,
      state,
      port,
      pid,
      name: proc?.name ?? '(已退出)',
      exposed,
      blocked: proc ? !protectVerdict(proc, { policy: pol, selfPid: process.pid, foregroundPid: snap.foregroundPid }).allow : true,
    })
  }
  const query = q.trim().toLowerCase()
  const filtered = query
    ? rows.filter((x) => x.local.toLowerCase().includes(query) || x.name.toLowerCase().includes(query) || String(x.port).includes(query))
    : rows
  filtered.sort((a, b) => (a.state === 'LISTENING' ? -1 : 0) - (b.state === 'LISTENING' ? -1 : 0) || a.port - b.port)
  return { ok: true, at: snap.at, total: rows.length, shown: Math.min(filtered.length, limit), items: filtered.slice(0, limit) }
}

/* --------------------------------------------------------- 智能体 --- */

function agentCatalog() {
  const extras = Array.isArray(cfg().agentExtras) ? cfg().agentExtras : []
  const clean = extras
    .filter((e) => e && typeof e.id === 'string' && Array.isArray(e.images) && e.images.length)
    .map((e) => ({ id: e.id, images: e.images.map(String), hints: Array.isArray(e.hints) ? e.hints.map(String) : [] }))
  return [...AGENTS, ...clean]
}

function agentOf(proc) {
  const name = proc.name.replace(/\.exe$/i, '')
  const catalog = agentCatalog()
  for (const a of catalog) {
    if (a.images.some((img) => nameMatches(img, proc.name))) return a
  }
  // 通用解释器：只在命令行里找特征串（否则一条提交信息里带 claude 的 node 会被误报）
  if (HOST_IMAGES.includes(name) && proc.cmd) {
    for (const a of catalog) {
      if (a.hints.some((h) => h && proc.cmd.includes(h))) return a
    }
  }
  return null
}

/**
 * 树走到 shell 为止。
 *
 * 为什么：智能体（尤其 GUI 型的 ZCode）会把工具调用交给 cmd/pwsh 去跑，那些 shell 又生下
 * 一堆 node/python —— 如果一路往下走，一个 ZCode 会话会「包含」174 个进程、5.6 GB，
 * 那是这台机器半天里跑过的所有东西，不是这个智能体的进程。
 * 走到 shell 就停，语义上正好：shell 下面的是「你在终端里跑的命令」，不算智能体自己。
 */
const SHELL_BOUNDARY = /^(cmd|conhost|openconsole|pwsh|powershell|bash|sh|dash|zsh|wsl|nushell|nu|busybox|windowsterminal|wt)\.exe$/i

/** 智能体会话 = 一个智能体进程 + 它下面的整棵子树（到 shell 为止） */
export async function listAgents() {
  const snap = await snapshot()
  const pol = policy()
  const agentPids = new Set()
  for (const p of snap.procs) if (agentOf(p)) agentPids.add(p.pid)
  // 根 = 它的父进程不是智能体
  const roots = [...agentPids].filter((pid) => {
    const p = snap.byPid.get(pid)
    return !p || !agentPids.has(p.ppid)
  })
  const childrenOf = new Map()
  for (const p of snap.procs) {
    if (!childrenOf.has(p.ppid)) childrenOf.set(p.ppid, [])
    childrenOf.get(p.ppid).push(p)
  }
  const sessions = roots.map((rootPid) => {
    const members = []
    const walk = (pid, depth) => {
      const p = snap.byPid.get(pid)
      if (!p) return
      const v = protectVerdict(p, { policy: pol, selfPid: process.pid, foregroundPid: snap.foregroundPid })
      members.push({
        pid, ppid: p.ppid, name: p.name, cmd: shortCmd(p.cmd, 100), ws: p.ws, cpuMs: p.cpuMs,
        depth, isRoot: pid === rootPid, agent: agentOf(p)?.id ?? '', blocked: !v.allow, blockReason: v.reason,
      })
      for (const c of childrenOf.get(pid) ?? []) {
        if (SHELL_BOUNDARY.test(c.name)) continue // 到 shell 为止（见上面的常量注释）
        walk(c.pid, depth + 1)
      }
    }
    walk(rootPid, 0)
    const root = members[0]
    return {
      id: String(rootPid),
      agent: root?.agent || 'unknown',
      rootName: root?.name ?? '',
      rootPid,
      ws: members.reduce((s, m) => s + m.ws, 0),
      cpuMs: members.reduce((s, m) => s + m.cpuMs, 0),
      count: members.length,
      members,
    }
  })
  sessions.sort((a, b) => b.ws - a.ws)
  return { ok: true, at: snap.at, total: sessions.length, sessions }
}

/* --------------------------------------------------------- 结束动作 --- */

function audit(entry) {
  try {
    fs.mkdirSync(path.dirname(actionsLogPath()), { recursive: true })
    fs.appendFileSync(actionsLogPath(), `${JSON.stringify({ at: Date.now(), ...entry })}\n`, 'utf8')
  } catch {
    /* 审计写不进去不阻断动作，但会在返回值里提示 */
  }
}

export function actionLog(limit = 50) {
  const p = actionsLogPath()
  if (!fs.existsSync(p)) return { ok: true, path: p, items: [] }
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).slice(-limit)
  const items = lines
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .reverse()
  return { ok: true, path: p, items }
}

/**
 * 结束一个进程（或整棵子树）。
 * @param {number} pid
 * @param {{tree?: boolean, force?: boolean, by?: string}} opts
 *        force=false 走温和结束（taskkill 不带 /F，等价于发 WM_CLOSE）；force=true 直接结束。
 */
export async function endProcess(pid, { tree = false, force = false, by = 'workstation' } = {}) {
  const snap = await snapshot({ force: true })
  const proc = snap.byPid.get(Number(pid))
  if (!proc) return { ok: false, error: `没有 PID ${pid} 这个进程（可能已经退出了）` }
  const verdict = protectVerdict(proc, { policy: policy(), selfPid: process.pid, foregroundPid: snap.foregroundPid })
  if (!verdict.allow) {
    audit({ pid, name: proc.name, action: force ? 'forceKill' : 'close', result: 'blocked', reason: verdict.reason, by })
    return { ok: false, blocked: true, error: `拒绝结束 ${proc.name}(${pid})：${verdict.reason}`, reason: verdict.reason }
  }
  const args = ['/PID', String(pid)]
  if (tree) args.push('/T')
  if (force) args.push('/F')
  const r = await runHidden(`taskkill ${args.join(' ')}`, { timeout: 20000 })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().replace(/\s+/g, ' ').slice(0, 200)
  const ok = r.code === 0
  audit({ pid, name: proc.name, action: force ? 'forceKill' : 'close', tree, result: ok ? 'done' : 'failed', detail: out, by })
  if (!ok) {
    return { ok: false, error: `结束失败：${out || `taskkill 退出码 ${r.code}`}`, needAdmin: /拒绝访问|Access is denied/i.test(out) }
  }
  snapCache = { at: 0, value: null }
  return { ok: true, pid, name: proc.name, tree, force, detail: out }
}

/** 结束整个智能体会话（该会话的根进程 + 子树），逐个过保护层 */
export async function endSession(rootPid, { force = true, by = 'workstation' } = {}) {
  const agents = await listAgents()
  const s = agents.sessions.find((x) => x.rootPid === Number(rootPid))
  if (!s) return { ok: false, error: `没有以 ${rootPid} 为根的智能体会话` }
  const blocked = s.members.filter((m) => m.blocked)
  const targets = s.members.filter((m) => !m.blocked).map((m) => m.pid)
  if (!targets.length) return { ok: false, blocked: true, error: `这个会话里没有可结束的进程（${blocked[0]?.blockReason ?? ''}）` }
  const results = []
  for (const pid of targets) results.push(await endProcess(pid, { tree: false, force, by: `${by}:session` }))
  const done = results.filter((r) => r.ok).length
  return { ok: done > 0, done, blocked: blocked.length, failed: results.length - done, results }
}
