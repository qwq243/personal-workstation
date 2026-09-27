/**
 * 校历（学校教学日历）。
 *
 * 为什么要单独有这个：课程快照里只有「星期几上什么课」，**一点日期信息都没有** ——
 * 它不知道国庆放假、不知道这周是第几周、更不知道 11 月有校运会。所以：
 *   - 「今天第几教学周」以前靠课程快照里的 week 猜（会 stale），现在由学期起始日现算；
 *   - 「哪天不上课」由本文件的事件区间决定，而不是把每周固定的课硬排在假期上。
 *
 * 数据放在 server/data/school-calendar.json（首次读取时播种）—— 仓库里那份是**示例数据**
 * （`school` 字段写的是「示例大学」），换成你自己学校的校历就行。
 * 想改（换学年、调放假）直接编辑那个 JSON 即可，不需要动代码。
 *
 * 两类事实要分清，别混：
 *   1. **校历明写的**（学期起止、周数、报到、校运会、军训、期末、寒暑假）—— 直接抄，准确。
 *   2. **法定节假日**——校历只写「按国家规定执行」。已公布的（2026 部分）抄国办发明电，
 *      未公布的（2027 部分）按农历/公历惯例推算并标 `estimated: true`，界面上会提示「待定」。
 *      这是刻意的：宁可显示「待国务院通知」也不假装精确。
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../config.mjs'
import { readJSON } from './net.mjs'

const FILE = () => path.join(loadConfig().dataDir, 'school-calendar.json')

/** 内置校历（播种用）。改数据请改 server/data/school-calendar.json，不要改这里。 */
/**
 * 内置校历 —— **出厂是空的**。
 *
 * 这个模块的价值是**算法**（教学周现算、假期不排课、调休处理），不是某一所学校的日期。
 * 具体日期写进 `server/data/school-calendar.json`（字段语义见 docs/校历格式.md）：
 * 文件不存在时会按这个空结构播种一份出来，照着填就行。
 *
 * 为什么不留一份示例数据：校历是「学校发布文本」的转录，校与校完全不同；
 * 在代码里留一份别的学校的日期，只会让人以为「怎么算出来是错的」。
 */
const SEED = { version: 1, school: '', note: '', semesters: [], holidays: [], workdays: [] }

/** 事件种类 → 优先级（数字越小越优先）。同一天撞上多个事件时取优先级最高的那个。 */
const EVENT_RANK = { vacation: 1, exam: 2, event: 3, register: 4 }

function pad(n) {
  return String(n).padStart(2, '0')
}
function dateStr(y, m, d) {
  return `${y}-${pad(m)}-${pad(d)}`
}
function dowOf(date) {
  // 0=周日 … 6=周六
  return new Date(`${date}T00:00:00`).getDay()
}
function diffDays(a, b) {
  return Math.round((new Date(`${a}T00:00:00`) - new Date(`${b}T00:00:00`)) / 86400000)
}

/* --------------------------------------------------------------- 读取 --- */

let cache = null

/** 读校历（带进程内缓存）。文件不存在/坏了就用空结构播种（自己在页面/文件里填）。 */
export function readSpec() {
  if (cache) return cache
  const file = FILE()
  let data = null
  if (fs.existsSync(file)) {
    try {
      data = readJSON(file)
    } catch {
      data = null
    }
  }
  if (!data || !Array.isArray(data.semesters) || !data.semesters.length) {
    data = JSON.parse(JSON.stringify(SEED))
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    } catch {
      /* 播种失败就用内存里的种子，功能不受影响 */
    }
  }
  cache = data
  return data
}

/** 测试/热重载用：丢掉缓存 */
export function reload() {
  cache = null
}

/* --------------------------------------------------------------- 判定 --- */

/** 这一天属于哪个学期（教学周内才算；假期/考试周没有学期归属） */
function teachingSemester(date, spec) {
  for (const s of spec.semesters ?? []) {
    if (date >= s.start && date <= s.end) return s
  }
  return null
}

/**
 * 一天的校历标记。返回：
 *   kind     holiday | vacation | exam | event | register | workday | teaching | rest
 *   label    显示用文案（「国庆节」「寒假」…）
 *   suspend  这一天是否停课（true = 不要排课）
 *   week     教学周序号（只在教学周内有值）
 *   term     学期名（第一学期 / 第二学期）
 *   tag      叠加标签（不改变 kind，如「军训」）
 */
export function markOf(date, spec = readSpec()) {
  const dow = dowOf(date)

  // 收集当天的事件，分成「覆盖型」（改变当天性质）与「叠加型」（只贴标签）
  const overrides = []
  const tags = []
  for (const s of spec.semesters ?? []) {
    for (const e of s.events ?? []) {
      if (date < e.start || date > e.end) continue
      if (e.overlay) tags.push(e)
      else overrides.push({ rank: EVENT_RANK[e.kind] ?? 9, e, s })
    }
  }
  const tag = tags.length ? tags.map((e) => e.tag ?? e.name).join('、') : null
  const tagNote = tags.map((e) => e.note).filter(Boolean).join('；') || null

  // 1. 调休上班日：法定「周末要上班」，优先级最高（它反而要上课）
  const wd = (spec.workdays ?? []).find((w) => w.date === date)
  if (wd) {
    return { kind: 'workday', label: wd.name ?? '调休上课', suspend: false, week: null, term: termNameOf(date, spec), tag }
  }

  // 2. 法定节假日
  const hol = (spec.holidays ?? []).find((h) => date >= h.start && date <= h.end)
  if (hol) {
    return {
      kind: 'holiday',
      label: hol.name,
      suspend: true,
      week: null,
      term: termNameOf(date, spec),
      estimated: !!hol.estimated,
      source: hol.source ?? null,
      tag,
    }
  }

  // 3. 校历覆盖型事件（寒暑假 / 考试周 / 校运会 / 报到）—— 取优先级最高的那个
  if (overrides.length) {
    overrides.sort((a, b) => a.rank - b.rank)
    const { e, s } = overrides[0]
    // 停课与否：事件自己说了算（军训就不停课，因为它是新生的安排），没说就默认停
    const suspend = e.suspend ?? e.kind !== 'event'
    return {
      kind: e.kind,
      label: e.name,
      suspend,
      week: null,
      term: s.name,
      note: e.note ?? null,
      tag,
    }
  }

  // 4. 教学周内的工作日 → 上课
  const sem = teachingSemester(date, spec)
  if (sem && dow >= 1 && dow <= 5) {
    return {
      kind: 'teaching',
      label: tag ? `上课 · ${tag}` : '上课',
      suspend: false,
      week: Math.floor(diffDays(date, sem.start) / 7) + 1,
      term: sem.name,
      tag,
      note: tagNote,
    }
  }

  // 5. 剩下的是周末（教学周内的周六日），以及学年之外的日子
  return {
    kind: 'rest',
    label: dow === 0 || dow === 6 ? '周末' : '假期',
    suspend: true,
    week: null,
    term: termNameOf(date, spec),
    tag,
  }
}

/** 这一天属于哪个学期（按学期教学区间 + 相邻区间夹逼），只用于显示归属 */
function termNameOf(date, spec) {
  const sems = [...(spec.semesters ?? [])].sort((a, b) => (a.start < b.start ? -1 : 1))
  for (const s of sems) if (date >= s.start && date <= s.end) return s.name
  // 教学区之外：取日期落在其「上一学期结束 ~ 下一学期开始」之间的那个后续学期
  for (const s of sems) if (date < s.start) return s.name
  return sems[sems.length - 1]?.name ?? null
}

/**
 * 某个月的每日标记，给日历视图用。
 * 顺带回一份当月涉及的学期与节假日清单（前端显示图例/说明用）。
 */
export function monthMarks(month) {
  const spec = readSpec()
  const [y, m] = String(month).split('-').map(Number)
  if (!y || !m) return { ok: false, error: 'month 需要是 YYYY-MM' }
  const dim = new Date(y, m, 0).getDate()
  const days = {}
  for (let d = 1; d <= dim; d += 1) {
    const date = dateStr(y, m, d)
    days[date] = markOf(date, spec)
  }
  const inMonth = (a, b) => !(b < `${month}-01` || a > `${month}-31`)
  return {
    ok: true,
    month,
    school: spec.school,
    academicYear: spec.academicYear,
    note: spec.note,
    days,
    semesters: (spec.semesters ?? [])
      .filter((s) => inMonth(s.start, s.end) || (s.events ?? []).some((e) => inMonth(e.start, e.end)))
      .map((s) => ({ id: s.id, name: s.name, start: s.start, end: s.end, weeks: s.weeks })),
    holidays: (spec.holidays ?? []).filter((h) => inMonth(h.start, h.end)),
  }
}

/** 整份校历（设置页 / MCP 想读全量时用） */
export function fullSpec() {
  return readSpec()
}
