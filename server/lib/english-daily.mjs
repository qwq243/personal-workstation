/**
 * 每日一句（写翻译 → 核对 → 自评打卡）。
 *
 * **句库要自己导入** —— 这里只带数据结构与进度逻辑，不随仓库分发任何教材内容：
 * 买课后把原始文件放进 data/english/daily-sentence/raw/，跑解析器编译成 sentences.json
 * （步骤见 docs/每日一句导入.md）。
 *
 * 数据分两份，都在 data/english/daily-sentence/：
 *   sentences.json —— 句库（静态），由 scripts/english-daily-parse.mjs / english-daily-build.mjs 编译；
 *   progress.json  —— 进度（指针 + 每日打卡记录），本模块维护。
 *
 * 展示规则：
 *   指针【不自动】推进 —— 展示的永远是「第一个未完成的句子」；
 *   用户做完一次训练（写翻译 + 对照自评）才记一条当日记录，指针 +1；
 *   没做就停留。每天做没做，按本地日期记在 records 里。
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../config.mjs'
import { readJSON } from './net.mjs'

const dir = () => path.join(loadConfig().dataDir, 'english', 'daily-sentence')
const libFile = () => path.join(dir(), 'sentences.json')
const progressFile = () => path.join(dir(), 'progress.json')

/** 自评三档（打卡时选） */
const RATINGS = new Set(['good', 'half', 'lost'])

export function todayStr() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function addDays(n) {
  const d = new Date()
  d.setDate(d.getDate() + n)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 句库：进程内按 mtime 缓存（文件 ~200KB，别每次请求都重新 parse） */
let libCache = null
function loadLibrary() {
  const file = libFile()
  if (!fs.existsSync(file)) {
    return {
      ok: false,
      error:
        '还没有句库（server/data/english/daily-sentence/sentences.json 不存在）。' +
        '句库要自己导入 —— 把买来的材料放进同目录的 raw/，跑 scripts/english-daily-parse.mjs，' +
        '步骤见 docs/每日一句导入.md',
    }
  }
  const mtime = fs.statSync(file).mtimeMs
  if (libCache && libCache.mtime === mtime) return libCache.data
  const raw = readJSON(file, null)
  if (!raw || !Array.isArray(raw.days) || !raw.days.length) return { ok: false, error: '句库文件存在但内容为空或损坏' }
  const data = {
    ok: true,
    total: raw.total ?? raw.days.length,
    maxDay: raw.maxDay ?? raw.days.length,
    source: raw.source ?? '',
    builtAt: raw.builtAt ?? '',
    map: new Map(raw.days.map((d) => [Number(d.day), d])),
  }
  libCache = { mtime, data }
  return data
}

/* ---------------------------------------------------------- 进度存取 --- */

const EMPTY_PROGRESS = { version: 1, updatedAt: 0, pointer: 1, records: {} }

function loadProgress() {
  const raw = readJSON(progressFile(), null)
  if (!raw || typeof raw !== 'object') return { ...EMPTY_PROGRESS, records: {} }
  return {
    ...EMPTY_PROGRESS,
    ...raw,
    pointer: Math.max(1, Number(raw.pointer) || 1),
    records: raw.records && typeof raw.records === 'object' ? raw.records : {},
  }
}

/** 原子写（与 dashboard.mjs 同一套：先 .tmp 再 rename，防半截文件） */
function saveProgress(prog) {
  const file = progressFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ ...prog, version: 1, updatedAt: Date.now() }, null, 1), 'utf8')
  fs.renameSync(tmp, file)
}

/* ------------------------------------------------------------ 主逻辑 --- */

/** 连续打卡天数：从今天往回数 done 的日期；今天还没做不打断 streak（从昨天续） */
function streakOf(records) {
  let n = 0
  let i = records[todayStr()]?.done ? 0 : 1
  for (;; i += 1) {
    const rec = records[addDays(-i)]
    if (!rec?.done) break
    n += 1
    if (i > 400) break
  }
  return n
}

/** 主入口：当前句 + 进度 + 计划推算（卡片一次拉全） */
export function current() {
  const lib = loadLibrary()
  if (!lib.ok) return { ok: false, error: lib.error }
  const prog = loadProgress()

  const finished = prog.pointer > lib.maxDay
  const item = finished ? null : lib.map.get(prog.pointer)
  const completedCount = Math.min(prog.pointer - 1, lib.maxDay)

  const last7 = []
  for (let i = 0; i < 7; i += 1) {
    const date = addDays(-i)
    last7.push({ date, done: !!prog.records[date]?.done })
  }
  const recordDates = Object.keys(prog.records).filter((d) => prog.records[d]?.done).sort()
  const remaining = Math.max(0, lib.total - completedCount)
  const projectedFinish = remaining ? addDays(remaining - 1) : todayStr()

  return {
    ok: true,
    today: todayStr(),
    source: lib.source,
    total: lib.total,
    pointer: prog.pointer,
    finished,
    completedCount,
    item,
    /** 今天做没做（做了就展示下一个的「已做」态也给前端） */
    todayDone: !!prog.records[todayStr()]?.done,
    todayItems: prog.records[todayStr()]?.items ?? [],
    streak: streakOf(prog.records),
    startedAt: recordDates[0] ?? null,
    last7: last7.reverse(),
    plan: { pace: 1, remaining, projectedFinish },
  }
}

/**
 * 完成一次训练：记当日记录；完成的是当前句才把指针 +1。
 * 复训旧句子（day < pointer）只记录、不重复推进；day > pointer 不允许（还没展示过）。
 */
export function complete({ day, rating } = {}) {
  const lib = loadLibrary()
  if (!lib.ok) return { ok: false, error: lib.error }
  const prog = loadProgress()
  const d = Number(day)
  if (!lib.map.has(d)) return { ok: false, error: `句库里没有 Day ${d}` }
  if (d > prog.pointer) return { ok: false, error: `Day ${d} 还没轮到（当前是 Day ${prog.pointer}）` }
  const r = String(rating ?? '')
  if (!RATINGS.has(r)) return { ok: false, error: `rating 必须是 ${[...RATINGS].join('/')}` }

  const date = todayStr()
  const rec = prog.records[date] ?? { date, done: false, items: [] }
  rec.items.push({ day: d, rating: r, at: Date.now() })
  rec.done = true
  prog.records[date] = rec
  if (d === prog.pointer) prog.pointer = d + 1
  saveProgress(prog)
  return current()
}

/** 复位某天（误触）：删除当天的记录并把指针拉回第一个未完成句。暂时只给自己/MCP 用，不进前端 */
export function undoDate(date) {
  const prog = loadProgress()
  const rec = prog.records[date]
  if (!rec) return { ok: false, error: `${date} 没有记录` }
  delete prog.records[date]
  const lib = loadLibrary()
  const doneDays = new Set()
  for (const r of Object.values(prog.records)) for (const it of r.items ?? []) doneDays.add(Number(it.day))
  let p = 1
  while (p <= lib.maxDay && doneDays.has(p)) p += 1
  prog.pointer = p
  saveProgress(prog)
  return { ok: true, ...current() }
}

/* ------------------------------------------------- 句库 / 记录（页面用） --- */

/** 每天取最近一条记录（句库页的状态标记；同一天重练过就记最后一次的档位） */
function latestByDay(prog) {
  const byDay = new Map()
  for (const [date, rec] of Object.entries(prog.records)) {
    for (const it of rec.items ?? []) {
      const d = Number(it.day)
      const prev = byDay.get(d)
      if (!prev || (it.at ?? 0) >= (prev.at ?? 0)) byDay.set(d, { ...it, date })
    }
  }
  return byDay
}

/** 句子库：句库全景（Day 1 到材料最后一天）的摘要 + 完成/自评状态（句子库页） */
export function library() {
  const lib = loadLibrary()
  if (!lib.ok) return { ok: false, error: lib.error }
  const prog = loadProgress()
  const byDay = latestByDay(prog)
  const stats = { good: 0, half: 0, lost: 0 }
  for (const it of byDay.values()) if (stats[it.rating] != null) stats[it.rating] += 1
  const days = [...lib.map.values()]
    .sort((a, b) => a.day - b.day)
    .map((d) => {
      const rec = byDay.get(d.day)
      return {
        day: d.day,
        source: d.source ?? '',
        text: String(d.text ?? '').slice(0, 170),
        done: !!rec,
        rating: rec?.rating ?? null,
        at: rec?.at ?? null,
        current: d.day === prog.pointer,
      }
    })
  return { ok: true, source: lib.source, total: lib.total, pointer: prog.pointer, stats, days }
}

/** 单日详情（句子库点开某天看全文 / 再练一次） */
export function dayDetail(day) {
  const lib = loadLibrary()
  if (!lib.ok) return { ok: false, error: lib.error }
  const d = lib.map.get(Number(day))
  if (!d) return { ok: false, error: `句库里没有 Day ${day}` }
  const prog = loadProgress()
  const records = []
  for (const [date, rec] of Object.entries(prog.records)) {
    for (const it of rec.items ?? []) if (Number(it.day) === Number(day)) records.push({ date, ...it })
  }
  records.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
  return { ok: true, item: d, records, pointer: prog.pointer }
}

/** 打卡日志：最近 N 天每天做没做（每日一句页的打卡格子） */
export function log(days = 35) {
  const prog = loadProgress()
  const n = Math.min(Math.max(Number(days) || 35, 7), 120)
  const out = []
  for (let i = n - 1; i >= 0; i -= 1) {
    const date = addDays(-i)
    const rec = prog.records[date]
    out.push({
      date,
      done: !!rec?.done,
      items: (rec?.items ?? []).map((it) => ({ day: Number(it.day), rating: it.rating, at: it.at })),
    })
  }
  return { ok: true, today: todayStr(), days: out, streak: streakOf(prog.records) }
}
