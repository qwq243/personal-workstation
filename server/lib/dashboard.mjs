/**
 * 每日看板：计划 / 记录 / 心情 / 复盘 / 明日重点。
 *
 * 数据由本模块自己维护，存 server/data/dashboard.json，与前端 localStorage 分开：
 * 这样 MCP / 智能体也能读写同一份，不受浏览器限制。
 *
 * 它同时是「一切按天记录」的容器：其他模块（词单进度、模型用量、AI 总结）
 * 只往这一天挂数字，不往这个文件里塞正文。
 *
 * 关于「卡片」：开源版只带骨架与存储，看板上的卡片本身（课表 / 待办 / 早报…）
 * 依赖各人自己的数据源，按 src/features/dashboard/ 的写法自己加一张即可。
 */
import fs from 'node:fs'
import path from 'node:path'
import { dataDir } from '../config.mjs'
import { readJSON } from './net.mjs'

/* ----------------------------------------------------- 看板数据存储 --- */

/**
 * 安全边界说明（别把风险想错）：
 *   本模块的写入全是同步的（readFileSync / writeFileSync），Node 事件循环不会在一段同步代码
 *   中间切换，所以「Web 与 MCP 同时写导致互相覆盖」在当前实现下并不成立。
 *   真正会丢数据的是：writeFileSync 不是原子的。进程被杀（关机、任务管理器结束、崩溃）
 *   或磁盘满时，文件会停在「写了一半」的状态，下次读进来 JSON 解析失败 —— 而旧实现会
 *   静默回退成空看板，随后任何一次写入都会把空数据覆盖到磁盘上，等于今天以前全没了。
 *
 * 所以这里做四件事：
 *   1. 原子写：先写 .tmp 再 rename，读到的要么是旧完整内容、要么是新完整内容；
 *   2. 回退链：解析失败时依次尝试 .bak → 最近快照，而不是当空数据；
 *   3. 留证：坏文件另存 .corrupt-<时间>，不覆盖，方便人工抢救；
 *   4. 每日快照：data/backups/dashboard-YYYY-MM-DD.json，留最近 30 份。
 */

/** 本地日历日的 YYYY-MM-DD（**不用 toISOString** —— 那会按 UTC 切，晚上 8 点后会算成第二天） */
function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 当前数据结构版本；改结构时 +1，并在 migrate() 里补一步 */
const DASH_VERSION = 2
/** 快照保留份数 */
const BACKUP_KEEP = 30
/** 同一天的快照最多更新一次，超过这个间隔才重写 */
const SNAPSHOT_REFRESH_MS = 60 * 60 * 1000

const EMPTY_DASH = { version: DASH_VERSION, days: {}, updatedAt: 0 }

/** 内存里最后一份「确认可解析」的数据，用于写前留备份 */
let lastGood = null
/** 今天是否已经写过快照 */
let snapshotDay = null

function dashFile() {
  return path.join(dataDir(), 'dashboard.json')
}
function backupDir() {
  return path.join(dataDir(), 'backups')
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** 原子写：先写临时文件再 rename（同盘 rename 是原子的，不会被读者看到半截内容） */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * 结构迁移：每次改数据结构在这里加一步，保证老文件能升上来。
 * 现在 v1 → v2 只是显式打上版本号（结构本身没变），留着这个骨架给以后用。
 */
function migrate(raw) {
  const data = { ...EMPTY_DASH, ...raw }
  if (!isPlainObject(data.days)) data.days = {}
  const v = Number(data.version) || 1
  if (v < 2) data.version = 2
  return data
}

/** 最近一份可用的每日快照 */
function latestSnapshot() {
  try {
    const dir = backupDir()
    const files = fs.readdirSync(dir).filter((f) => /^dashboard-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()
    for (let i = files.length - 1; i >= 0; i -= 1) {
      const file = path.join(dir, files[i])
      const data = readJSON(file, null)
      if (isPlainObject(data)) return { file, data }
    }
  } catch {
    /* 没有快照目录就当没有 */
  }
  return null
}

/** 保留最近 BACKUP_KEEP 份快照 */
function pruneBackups(dir) {
  try {
    const files = fs.readdirSync(dir).filter((f) => /^dashboard-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()
    for (const f of files.slice(0, Math.max(0, files.length - BACKUP_KEEP))) {
      fs.unlinkSync(path.join(dir, f))
    }
  } catch {
    /* 清理失败不影响主流程 */
  }
}

/** 每天留一份快照；同一天超过 1 小时才刷新，兼顾「历史留存」与「够新」 */
function snapshotDaily(data) {
  const d = today()
  try {
    const dir = backupDir()
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `dashboard-${d}.json`)
    const fresh = fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < SNAPSHOT_REFRESH_MS
    if (snapshotDay === d && fresh) return
    writeAtomic(file, JSON.stringify(data, null, 2))
    snapshotDay = d
    pruneBackups(dir)
  } catch (err) {
    console.warn('[dashboard] 快照写入失败：', err.message)
  }
}

export function readDashboard() {
  const file = dashFile()
  const raw = readJSON(file, null)
  if (isPlainObject(raw)) {
    lastGood = migrate(raw)
    return lastGood
  }
  if (!fs.existsSync(file)) return { ...EMPTY_DASH }

  // 文件在、但解析不出来 —— 已经坏了。绝不能静默当空看板（那样下一次写入就把真数据盖掉了）。
  console.error(`[dashboard] ${file} 解析失败：文件可能被写坏（进程中断 / 磁盘满）`)

  // 坏文件先留证，不覆盖（万一自动回退也不理想，人工还能抢救）
  const keep = `${file}.corrupt-${Date.now()}`
  try {
    fs.copyFileSync(file, keep)
    console.error(`[dashboard] 坏文件已另存为 ${path.basename(keep)}`)
  } catch {
    /* 留证失败只能算了 */
  }

  // 两个候选来源补的「新旧程度」不同：.bak 是上一次写入前的内容，每日快照可能更新。
  // 不能撞上哪个用哪个 —— 按 updatedAt 取最新的一份，尽量少丢数据。
  const candidates = []
  const bak = readJSON(`${file}.bak`, null)
  if (isPlainObject(bak)) candidates.push({ from: 'dashboard.json.bak', data: bak })
  const snap = latestSnapshot()
  if (snap) candidates.push({ from: `每日快照 ${path.basename(snap.file)}`, data: snap.data })

  if (candidates.length) {
    candidates.sort((a, b) => (Number(b.data.updatedAt) || 0) - (Number(a.data.updatedAt) || 0))
    const best = candidates[0]
    console.error(`[dashboard] 已回退到${best.from}（${candidates.length} 份候选中取最新）`)
    lastGood = migrate(best.data)
    // 顺手把主文件修回来：否则之后每次读都要再走一遍回退，而且坏文件会被继续覆盖
    try {
      writeAtomic(file, JSON.stringify(lastGood, null, 2))
      console.error('[dashboard] 主文件已按回退数据修复')
    } catch (err) {
      console.error('[dashboard] 主文件修复失败：', err.message)
    }
    return lastGood
  }

  console.error('[dashboard] 没有任何可回退的副本，本次按空数据处理（坏文件已保留，请人工检查）')
  return { ...EMPTY_DASH }
}

export function writeDashboard(next) {
  const data = { ...next, version: DASH_VERSION, updatedAt: Date.now() }
  const file = dashFile()
  // 写前把「当前磁盘上那份」留作回退副本（它已被 readDashboard 验证过可解析）
  if (lastGood && fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, `${file}.bak`)
    } catch {
      /* 备份失败不阻断写入 */
    }
  }
  writeAtomic(file, JSON.stringify(data, null, 2))
  lastGood = data
  snapshotDaily(data)
  return data
}

function blankDay(date) {
  return {
    date,
    /** 今日计划（可勾选） */
    plans: [],
    /** 随手记录 */
    notes: [],
    /** 心情/状态（1-5）与一句话 */
    mood: null,
    moodNote: '',
    /** 复盘：今天做了什么 */
    done: '',
    /** 明日重点 */
    tomorrow: '',
    updatedAt: 0,
  }
}

export function getDay(date = today()) {
  const d = readDashboard()
  const day = d.days[date] ?? blankDay(date)
  return { date, ...day, days: undefined }
}

/** 合并式更新某一天（只覆盖传进来的字段） */
export function patchDay(date, patch) {
  const d = readDashboard()
  const cur = d.days[date] ?? blankDay(date)
  const next = { ...cur, ...patch, date, updatedAt: Date.now() }
  d.days[date] = next
  writeDashboard(d)
  return next
}

export function addPlan(date, text, extra = {}) {
  const day = getDay(date)
  const plan = {
    id: `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    text,
    done: false,
    source: extra.source ?? 'manual',
    createdAt: Date.now(),
    ...extra,
  }
  const plans = [...(day.plans ?? []), plan]
  patchDay(date, { plans })
  return plan
}

export function updatePlan(date, planId, patch) {
  const day = getDay(date)
  const plans = (day.plans ?? []).map((p) => (p.id === planId ? { ...p, ...patch } : p))
  patchDay(date, { plans })
  return plans.find((p) => p.id === planId) ?? null
}

export function removePlan(date, planId) {
  const day = getDay(date)
  const plans = (day.plans ?? []).filter((p) => p.id !== planId)
  patchDay(date, { plans })
  return { ok: true, plans }
}

export function addNote(date, text, extra = {}) {
  const day = getDay(date)
  const note = {
    id: `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    text,
    createdAt: Date.now(),
    ...extra,
  }
  const notes = [...(day.notes ?? []), note]
  patchDay(date, { notes })
  return note
}

export function removeNote(date, noteId) {
  const day = getDay(date)
  const notes = (day.notes ?? []).filter((n) => n.id !== noteId)
  patchDay(date, { notes })
  return { ok: true, notes }
}

/**
 * 某个月的「每日记录摘要」，给日历月视图用。
 *
 * 为什么不让前端用 recentDays：那个只从今天往回数，往后的日期（以及跨月查看历史）
 * 都覆盖不到。而 dashboard.json 里 days 是按日期全量存的，一次读取按前缀过滤最省。
 * 只回摘要不回原文 —— 月视图 42 个格子用不上正文，把 notes/plans 全文塞进响应纯属浪费。
 */
export function monthDays(month) {
  const d = readDashboard()
  const prefix = `${month}-`
  const days = {}
  for (const [date, day] of Object.entries(d.days ?? {})) {
    if (!date.startsWith(prefix)) continue
    const plans = day.plans ?? []
    days[date] = {
      plans: plans.length,
      plansDone: plans.filter((p) => p.done).length,
      notes: (day.notes ?? []).length,
      mood: day.mood ?? null,
      hasReview: !!day.done,
      hasTomorrow: !!day.tomorrow,
    }
  }
  return { ok: true, month, days, updatedAt: d.updatedAt ?? 0, today: today() }
}

/** 最近 N 天概览（给看板的趋势/连续记录用） */
export function recentDays(limit = 14) {
  const d = readDashboard()
  const out = []
  const base = new Date()
  for (let i = 0; i < limit; i += 1) {
    const dt = new Date(base.getTime() - i * 86400000)
    const p = (n) => String(n).padStart(2, '0')
    const date = `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`
    const day = d.days[date]
    out.push({
      date,
      exists: !!day,
      plans: day?.plans?.length ?? 0,
      plansDone: (day?.plans ?? []).filter((x) => x.done).length,
      notes: day?.notes?.length ?? 0,
      mood: day?.mood ?? null,
      hasReview: !!day?.done,
    })
  }
  return out
}

/** 连续记录天数（有计划或笔记或复盘就算「记过」） */
export function streak() {
  const days = recentDays(120)
  let n = 0
  for (const d of days) {
    const active = d.plans > 0 || d.notes > 0 || d.hasReview || d.mood != null
    if (!active) break
    n += 1
  }
  return n
}

export { today as todayStr }
