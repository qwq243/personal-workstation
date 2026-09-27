/**
 * 单实例闸：边车启动时**先把旧的自己收掉**，保证同一时刻只有一个在工作。
 *
 * 为什么需要它：重启边车的方式不止一种（`scripts/restart-sidecar.py`、面板的「重建」、
 * 开机自启的 .lnk、手动 `node server/index.mjs`）。每种都会起一个新进程 + 一个新控制台窗口，
 * 而旧进程只在「还占着 5278」时才会被顺带杀掉 —— 一旦旧实例因为别的原因不再监听端口
 * （端口被别人抢了、启动时报错退出到一半、被留在别的端口上跑测试），它就变成孤儿：
 * 窗口挂着、进程活着、下一次重启再叠一个。实测攒到过 4 个。
 *
 * 三条硬约束（都在代码里落死）：
 *   1. **只认自己的入口文件**：命令行里必须出现**本项目的 `server/index.mjs` 绝对路径**
 *      （两种斜杠都认）才动手。别的 node 一律不碰 —— 一台机器上往往还跑着别的服务
 *      （接口服务、别的智能体进程、MCP…），误杀它们的代价远大于多一个进程。
 *      ⚠ 必须是**绝对路径**：放宽成 `server/index.mjs` 这种片段的话，同一台机器上两份
 *      checkout（一份在用、一份在改）就会互相误杀 —— 这个坑真踩过：后启动的那份
 *      把先启动的那份当成「旧的自己」收掉了，而两份其实是两个不同的项目。
 *   2. **不杀正在干活的自己**：一次性 CLI 模式不走这里。
 *   3. **抢不到端口就退出**，而不是硬占：端口被**非本边车**的进程占着时只报错退出，
 *      让人去决定（绝不替用户杀陌生进程）。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF_ENTRY = fileURLToPath(import.meta.url) // .../server/lib/singleton.mjs
const SERVER_DIR = path.dirname(path.dirname(SELF_ENTRY))
/** 本项目的边车入口，绝对路径的两种斜杠写法 */
const ENTRY_SLASH = path.join(SERVER_DIR, 'index.mjs').replace(/\\/g, '/')
const ENTRY_BACKSLASH = path.join(SERVER_DIR, 'index.mjs')

function run(exe, args, timeout = 15000) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    const p = spawn(exe, args, { windowsHide: true })
    const timer = setTimeout(() => p.kill(), timeout)
    p.stdout?.on('data', (d) => (out += d.toString('utf8')))
    p.stderr?.on('data', (d) => (err += d.toString('utf8')))
    p.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, out, err: String(e.message ?? e) })
    })
    p.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, err })
    })
  })
}

/** 列出所有 node 进程（pid + 命令行）。拿不到（没权限/没 powershell）就返回空表，不阻断启动 */
export async function listNodeProcesses() {
  const cmd =
    'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'
  const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd])
  if (r.code !== 0 || !r.out.trim()) return []
  let parsed = null
  try {
    parsed = JSON.parse(r.out.trim())
  } catch {
    return []
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed]
  return arr
    .filter((x) => x && x.ProcessId)
    .map((x) => ({ pid: Number(x.ProcessId), cmd: String(x.CommandLine ?? '') }))
}

/** 是不是「**本项目**的边车」：命令行里出现的是我们这个入口文件的绝对路径 */
export function isSelfInstance(cmdLine) {
  const c = String(cmdLine ?? '')
  return c.replace(/\\/g, '/').includes(ENTRY_SLASH) || c.includes(ENTRY_BACKSLASH)
}

/** 找出除自己以外的所有边车实例 */
export async function findDuplicates() {
  const all = await listNodeProcesses()
  return all.filter((p) => p.pid !== process.pid && isSelfInstance(p.cmd))
}

export async function killPid(pid) {
  const r = await run('taskkill', ['/F', '/PID', String(pid)])
  return { ok: r.code === 0, out: (r.out || r.err).trim().slice(0, 160) }
}

/** 探测端口上是谁：返回 { ok, pid } —— 用 netstat（Windows 自带，不依赖第三方） */
async function listenersOf(port) {
  const r = await run('netstat', ['-ano', '-p', 'TCP'])
  const pids = new Set()
  for (const line of (r.out || '').split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length >= 5 && parts[1].endsWith(`:${port}`) && parts[3] === 'LISTENING') pids.add(Number(parts[4]))
  }
  return [...pids].filter((n) => Number.isFinite(n) && n > 0)
}

/** 等端口放掉（最多 waitMs） */
async function waitPortFree(port, waitMs = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < waitMs) {
    const pids = await listenersOf(port)
    if (!pids.length) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

/**
 * 启动前调用：回收旧实例、确认端口空出来。
 * 返回 { ok, reaped: [{pid, killed, note}], portFree, foreign? } —— ok=false 时调用方应当退出。
 */
export async function enforce({ port = 5278, log = () => {} } = {}) {
  const reaped = []

  // ① 先收「同一个入口」的旧实例（哪怕它已经没在监听端口）
  const dups = await findDuplicates()
  for (const d of dups) {
    const r = await killPid(d.pid)
    reaped.push({ pid: d.pid, killed: r.ok, note: r.out })
    log(r.ok ? `已回收旧边车 PID ${d.pid}` : `旧边车 PID ${d.pid} 回收失败：${r.out}`)
  }

  // ② 端口上如果还挂着东西，看清是不是自己人
  let pids = await listenersOf(port)
  const foreign = []
  for (const pid of pids) {
    const all = await listNodeProcesses()
    const hit = all.find((x) => x.pid === pid)
    if (hit && isSelfInstance(hit.cmd)) {
      const r = await killPid(pid)
      reaped.push({ pid, killed: r.ok, note: r.out })
      log(r.ok ? `已回收占用 ${port} 的旧边车 PID ${pid}` : `占用 ${port} 的旧边车 PID ${pid} 回收失败：${r.out}`)
    } else {
      foreign.push({ pid, cmd: hit?.cmd ?? '(非 node 或拿不到命令行)' })
    }
  }

  if (foreign.length) {
    // 有一种情况会走到这里，但不是「别人的进程」：旧实例是用**相对路径**起的
    // （`cd 工程目录 && node server/index.mjs`），命令行里没有绝对路径可认。
    // 拿不准就不动手（见文件头第 1 条），但要把话说清楚，别让人以为端口被陌生程序占了。
    // 判据要认「空格分隔」：真实命令行是 `node.exe server/index.mjs`，`server` 前面是空格不是斜杠。
    // 这里只决定提示文案，**不动手**；自动回收那条判据另有一套绝对路径规则，别拿这条去放宽它。
    const hint = foreign.some((f) => /(^|[\s\\/])server[\\/]index\.mjs/i.test(String(f.cmd)))
      ? '其中有的命令行只写了相对的 server/index.mjs —— 那**很可能就是本项目**的另一份/旧一份实例，' +
        '但相对路径认不出是哪一份，所以这里不动手。用 `tasklist` 看它的 PID，确认后自己结束；' +
        '或者干脆改 config.json 的 port。'
      : '不会替你杀陌生进程：确认是它就该改 config.json 的 port，或自己结束它。'
    return {
      ok: false,
      reaped,
      portFree: false,
      foreign,
      error: `端口 ${port} 被不是本边车的进程占着（PID ${foreign.map((f) => f.pid).join('、')}）。${hint}`,
    }
  }

  const free = await waitPortFree(port)
  return { ok: free, reaped, portFree: free, error: free ? undefined : `端口 ${port} 仍被占着（已回收自己人但没放掉）` }
}
