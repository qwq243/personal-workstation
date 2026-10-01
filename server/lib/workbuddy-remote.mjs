/**
 * 远端账号池的任务触发与排程读取。
 *
 * 与「查真实积分」同一条思路：本机不重写上游调用，而是**经 SSH 在那台机器上跑它自己的脚本**。
 * 两个脚本的路径都来自配置：`hosts[].runScript`（触发任务）与 `hosts[].scheduleScript`（读排程），
 * 留空 = 那台机器不支持这件事，调用方会拿到一句明确提示。任务名走白名单，除任务名外不接受
 * 任何参数 —— 这不是通用远程执行面。
 *
 * 为什么排程也要读远端：那边的定时（每类任务各有自己的 hours 段）跑在它自己的网关进程里，
 * 面板要能显示「那台机器上的任务开着没有、几点跑」，而不是拿本机的排程冒充。
 */
import { spawn } from 'node:child_process'
import { runHidden } from './net.mjs'
import { hosts } from './workbuddy.mjs'
import { TASKS, EXTRA_ACTIONS } from './workbuddy-activity.mjs'

/** 允许触发的任务（与远端那个触发脚本的 switch 一致，逐项对应本机的任务表） */
export const REMOTE_TASKS = ['checkin', 'activity', 'travel', 'keepalive', 'trial', 'credits', 'school', 'cat', 'all']

const RUN_KEEP = 20 // 内存里留最近 20 次

/** 任务标题（页面用 run.title 渲染）：本机活动模块的元数据直接复用 */
const TITLE_BY_ID = new Map([...TASKS, ...EXTRA_ACTIONS].map((t) => [t.id, t.label]))

function hostOf(hostId) {
  const list = hosts()
  return list.find((h) => h.id === hostId) ?? null
}

/** 远端运行记录：hostId -> [{ id, task, startedAt, endedAt, status, lines, exit }] */
const runsByHost = new Map()
let seq = 0

function pushRun(hostId, rec) {
  const list = runsByHost.get(hostId) ?? []
  list.unshift(rec)
  runsByHost.set(hostId, list.slice(0, RUN_KEEP))
  return rec
}

function findRun(id) {
  for (const list of runsByHost.values()) {
    const hit = list.find((r) => r.id === id)
    if (hit) return hit
  }
  return null
}

/** 触发一次远端任务（后台跑，输出实时落进记录，页面轮询就能看到进度） */
export function startRemoteTask(hostId, task) {
  const host = hostOf(hostId)
  if (!host) return { ok: false, error: `不认识的账号池主机：${hostId}` }
  if (host.kind !== 'remote') return { ok: false, error: '这是本机主机，请用本机那条接口' }
  if (!host.ssh) return { ok: false, error: `${host.name} 没配 SSH 别名（config.workbuddy.hosts[].ssh），触发不了` }
  if (!host.runScript) {
    return { ok: false, error: `${host.name} 没配触发脚本（config.workbuddy.hosts[].runScript），触发不了` }
  }
  if (!REMOTE_TASKS.includes(task)) return { ok: false, error: `不支持的任务：${task}` }

  const rec = pushRun(hostId, {
    id: `r${Date.now().toString(36)}-${++seq}`,
    host: hostId,
    hostName: host.name,
    task,
    // 字段名跟本机 run 记录对齐（页面只有一套渲染）
    title: `${TITLE_BY_ID.get(task) ?? task}（${host.name}）`,
    uidPrefix: '',
    startedAt: Date.now(),
    finishedAt: 0,
    running: true,
    error: null,
    deltaTotal: null,
    lines: [],
  })

  // 配置里给的脚本 + 白名单任务名；用参数数组传，不走 shell 拼接
  // （脚本路径由配置给、可能带空格，所以包上双引号整段交给那边的 PowerShell）
  const remoteCmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${host.runScript}"`
  const child = spawn(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host.ssh, remoteCmd, '-Task', task],
    { windowsHide: true },
  )
  const onChunk = (buf) => {
    for (const line of String(buf).split(/\r?\n/)) {
      if (line.trim()) rec.lines.push(line.replace(/\s+$/, ''))
    }
    if (rec.lines.length > 800) rec.lines.splice(0, rec.lines.length - 800)
  }
  child.stdout?.on('data', onChunk)
  child.stderr?.on('data', onChunk)
  child.on('error', (err) => {
    rec.lines.push('启动 ssh 失败：' + err.message)
    rec.error = '启动 ssh 失败：' + err.message
    rec.running = false
    rec.finishedAt = Date.now()
  })
  child.on('close', (code) => {
    rec.exit = code
    rec.running = false
    rec.finishedAt = Date.now()
    if (code !== 0) rec.error = `远端脚本退出码 ${code}（输出见下面原文）`
  })
  return { ok: true, run: rec }
}

export function remoteRuns(hostId, { limit = 20 } = {}) {
  // 形状与本机 runsList 对齐（页面只认 data.runs），别多包一层
  return { ok: true, runs: (runsByHost.get(hostId) ?? []).slice(0, limit) }
}

export function remoteRunGet(id) {
  const rec = findRun(id)
  return rec ? { ok: true, run: rec } : { ok: false, error: '没有这次运行记录（可能已过期或被重启清掉）' }
}

/* --------------------------------------------------------- 排程读取 --- */

const schedCache = new Map() // hostId -> { at, data }

/** 读远端网关的排程段（跑它自己的 config.json；缓存 5 分钟，避免每次开页面都 SSH） */
export async function remoteSchedule(hostId, { force = false } = {}) {
  const host = hostOf(hostId)
  if (!host) return { ok: false, error: `不认识的账号池主机：${hostId}` }
  if (host.kind !== 'remote') return { ok: false, error: '这是本机主机，请用本机那条接口' }
  if (!host.ssh) return { ok: false, error: `${host.name} 没配 SSH 别名（config.workbuddy.hosts[].ssh），读不到排程` }
  if (!host.scheduleScript) {
    return { ok: false, error: `${host.name} 没配读排程的脚本（config.workbuddy.hosts[].scheduleScript），读不到排程` }
  }

  const hit = schedCache.get(hostId)
  if (!force && hit && Date.now() - hit.at < 5 * 60 * 1000) return { ok: true, ...hit.data, cached: true }

  // 脚本路径由配置给、可能带空格：包上双引号，再把内层引号转义一层交给 ssh
  const remoteCmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${String(host.scheduleScript).replace(/"/g, '\\"')}"`
  const r = await runHidden(
    `ssh -o BatchMode=yes -o ConnectTimeout=15 ${host.ssh} "${remoteCmd}"`,
    { timeout: 60000 },
  )
  const line = (r.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop() ?? ''
  try {
    const sched = JSON.parse(line)
    // 整理成与本机 schedule() 同形状，页面不用为远端写第二套渲染：
    // 开关与时间来自那边的 config.json；**nextAt 给 null** —— 下次触发是那边进程内的排程，
    // 硬算一个时间出来只会误导（那边网关没起来时更是假的）。
    const shape = (t) => ({
      id: t.id,
      label: t.label,
      hint: t.hint,
      enabledKey: t.enabledKey ?? null,
      hoursKey: t.hoursKey ?? null,
      enabled: t.enabledKey ? !!sched[t.enabledKey] : true,
      hours: t.hoursKey ? sched[t.hoursKey] ?? [] : [],
      nextAt: null,
    })
    // 顶层直接展开：页面把返回的 data 当排程对象用（与本机 schedule() 同形状）
    const data = {
      remote: true,
      host: hostId,
      hostName: host.name,
      tasks: TASKS.map(shape),
      extra: EXTRA_ACTIONS.map(shape),
      // 远端没有「本机那套步间等待/限流闸」，一键完成直接放行
      chain: { canStart: true, blockReason: '' },
      at: Date.now(),
    }
    schedCache.set(hostId, { at: Date.now(), data })
    return { ok: true, ...data }
  } catch {
    return { ok: false, error: (r.stderr ?? '').trim().slice(0, 200) || '读不到那台机器的排程（脚本没输出 JSON）' }
  }
}
