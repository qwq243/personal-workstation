/**
 * 做题本 —— 每日一题的载体。
 *
 * 为什么要这个东西（2026-09-27 定）：题目**不能一堆聚合在一条消息里**，
 * 要按「做题本」的样子给：**一题一份、题干在上、下面留够写的位置**，
 * 能一题一页打印出来在平板上手写。纸面形状（打印页也照着它排）：
 *   页眉左 = 来源，右 = 日期范围；题号写成「N.【月.日】」；题干后跟出处；
 *   下面整页留白手写；页脚 = 页码。
 *
 * 本模块只管**数据**：题目怎么存、怎么按天取、怎么标做过/做错。
 * 渲染（一题一页的版式、公式排版）在前端 `src/features/zuotiben/`，
 * 因为公式排版管线（`math-typeset.ts` + KaTeX）在那边，服务端重写一份等于两套要同时维护。
 *
 * 一天的题就是一天的册子；周末/成批的题按天分开存，不混成一个大列表 ——
 * 混在一起就退化成「聚合」，正是要避免的那种。
 */
import path from 'node:path'
import { createJsonStore, todayStr } from './jsonstore.mjs'
import { dataDir } from './plan.mjs'

const FILE = () => path.join(dataDir(), 'zuotiben.json')

/** 一天最多留多少题（防上游一次性灌爆；正常一天 10 题上下） */
const MAX_PER_DAY = 60
/** 整个库最多留多少天的记录 */
const MAX_DAYS = 400

const KINDS = new Set(['choice', 'fill', 'solve'])

/* ------------------------------------------------------------- 归一化 --- */

/**
 * 填空横线规范化（2026-09-29）。
 *
 * OCR 的书里填空位常写作 `\_\_\_\_`（LaTeX 转义下划线）。这套前端渲染管线只在 `$...$`
 * 里认 LaTeX，裸文本里的 `\_` 会**原样显示成反斜杠**（`则 <表达式> = \_\_\_\_`），而且
 * 「展开答案回填空位」的正则（`answer-inline.ts` 的 `_{3,}|＿{3,}`）也匹配不到它。
 * 所以统一还原：
 *   - `$...\_\_\_...$`（横线写在数学模式里）：把横线挪到 `$` 外写成裸下划线
 *     —— `$<表达式> = \_\_\_\_$` → `$<表达式> =$ ____`（KaTeX 里 `____` 会当连续下标报错，不能留在模式内）
 *   - 其余 `\_` 序列：直接还原成裸下划线
 */
export function normalizeBlanks(s) {
  return String(s ?? '')
    .replace(/\$([^$\n]*?)((?:\\_){2,})([^$\n]*)\$/g, (_m, pre, us, post) => {
      const n = us.length / 2
      return `$${String(pre).trimEnd()}$ ${'_'.repeat(n)}${post}`
    })
    .replace(/\\_/g, '_')
}

/** 出处统一成「(1997年2)」这种带括号的形状；已经是括号开头就不动 */
function normOrigin(s) {
  const t = String(s ?? '').trim()
  if (!t) return ''
  return /^[（(]/.test(t) ? t : `(${t})`
}

/** 日期标签【月.日】；给了就用给的，没给就从日期推 */
function normTag(s, date) {
  const t = String(s ?? '').trim()
  if (t) return t
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ''))
  return m ? `${Number(m[2])}.${Number(m[3])}` : ''
}

/** 没写 kind 就按有没有选项猜：有选项＝选择题、题干里有横线或「求/证明」＝填空、其余算解答 */
function guessKind(raw, options) {
  // 注意取 raw.kind 而不是 String(raw)：传进来的是整个题对象，
  // 早先写成 String(raw) 会拿到 "[object Object]"，于是**显式传的 kind 被静默忽略**、
  // 「解答/证明题」只能被猜成「填空」。
  const k = String(raw?.kind ?? '').trim().toLowerCase()
  if (KINDS.has(k)) return k
  if (options.length >= 2) return 'choice'
  return /_{3,}|＿{3,}|求|证明/.test(String(raw?.stem ?? '')) ? 'fill' : 'solve'
}

/**
 * 溯源：这道题从哪本书、哪一篇、哪一章、第几题来。
 *
 * 为什么单独存一份结构化 ref 而不只留 `origin` 那句话：`origin` 是**给人看的**（印在题号旁），
 * ref 是**给程序用的** —— 「推荐同类题」要按章筛、「别重复出题」要比对已做过的章+题号、
 * 要回查原文得知道落在题库目录哪个文件的哪一章。两者不能互相替代。
 */
function normRef(raw) {
  if (!raw) return null
  if (typeof raw === 'string') {
    const label = raw.trim()
    return label ? { label, book: '', part: '', chapter: 0, chapterTitle: '', no: 0, files: [] } : null
  }
  const o = raw ?? {}
  const book = String(o.book ?? '').trim()
  const part = String(o.part ?? '').trim()
  const chapter = Math.max(0, Number(o.chapter) || 0)
  const no = Math.max(0, Number(o.no) || 0)
  const chapterTitle = String(o.chapterTitle ?? '').trim()
  const files = (Array.isArray(o.files) ? o.files : []).map(String).filter(Boolean).slice(0, 4)
  let label = String(o.label ?? '').trim()
  if (!label) {
    label = [book, part ? `·${part}` : '', chapter ? ` 第${chapter}章` : '', no ? ` 第${no}题` : '']
      .join('')
      .trim()
  }
  if (!label && !book && !chapter && !no) return null
  return { label, book, part, chapter, chapterTitle, no, files }
}

function cleanProblem(raw = {}, i = 0, date = todayStr()) {
  const stem = normalizeBlanks(String(raw?.stem ?? raw?.text ?? '')).trim()
  if (!stem) return null
  const options = (Array.isArray(raw?.options) ? raw.options : [])
    .map((o) => normalizeBlanks(String(o ?? '')).trim())
    .filter(Boolean)
    .slice(0, 8)
  return {
    id: String(raw?.id ?? '').trim() || `p${Date.now().toString(36)}${i}${Math.random().toString(36).slice(2, 6)}`,
    date,
    /** 当天的序号，1 起 */
    no: Number(raw?.no) > 0 ? Math.floor(Number(raw.no)) : i + 1,
    /** 【月.日】标签 */
    tag: normTag(raw?.tag, date),
    /** 出处，如 (1997年2) */
    origin: normOrigin(raw?.origin),
    stem,
    options,
    kind: guessKind({ kind: raw?.kind, stem }, options),
    /** 考点/章节，用来在列表里分组或回查 */
    topic: String(raw?.topic ?? '').trim(),
    /** 溯源：出处落到书/篇/章/题，供「推荐同类」按章筛、回查原文 */
    ref: normRef(raw?.ref),
    answer: normalizeBlanks(String(raw?.answer ?? '')).trim(),
    solution: normalizeBlanks(String(raw?.solution ?? '')).trim(),
    /** 备注 / 做错原因（用户自己在页面上写；解析是标准解析，别把两者的用途混起来） */
    note: String(raw?.note ?? '').trim(),
    /** 做题状态：没在纸上做过就别勾 */
    done: raw?.done === true,
    /** 做错标记 —— 攒起来就是错题本 */
    wrong: raw?.wrong === true,
    source: String(raw?.source ?? 'agent').slice(0, 24),
    createdAt: Number(raw?.createdAt) || Date.now(),
  }
}

/** 只保留 YYYY-MM-DD，其它一律落到今天 */
function normDate(s) {
  const t = String(s ?? '').trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : todayStr()
}

function empty() {
  return { version: 1, rev: 0, updatedAt: 0, days: [], scope: defaultScope() }
}

/**
 * 「已学到哪儿」—— 推荐/出新题时的过滤器。
 *
 * 为什么要有它：需求是「**去除还没学过的题**，再出一些我来选」。
 * 光看播放进度推不出可用的章号（视频按讲分、题库按章分，还不是一一对应），
 * 所以单独存一份、由智能体在核过进度后写入，人就看得见依据是什么。
 */
function defaultScope() {
  return { chapters: [], lectures: [], note: '', updatedAt: 0 }
}

function normScope(raw) {
  const o = raw && typeof raw === 'object' ? raw : {}
  const nums = (v, max = 40) =>
    (Array.isArray(v) ? v : [])
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n) && n > 0 && n <= max)
      .sort((a, b) => a - b)
  return {
    /** 题册基础篇的章号（推荐同类的过滤依据） */
    chapters: [...new Set(nums(o.chapters))],
    /** 讲义讲到第几讲（给人看、也给「讲义对应哪几章」留线索） */
    lectures: [...new Set(nums(o.lectures, 40))],
    note: String(o.note ?? '').slice(0, 300),
    updatedAt: Number(o.updatedAt) || 0,
  }
}

/** days 存成数组（按日期倒序），每条带自己的 problems —— 比对象好排序，也少一层键 */
function migrate(raw) {
  const days = (Array.isArray(raw?.days) ? raw.days : [])
    .filter((d) => d && /^\d{4}-\d{2}-\d{2}$/.test(String(d.date ?? '')))
    .map((d) => ({
      date: String(d.date),
      /** 页眉左：这册子的来源 */
      source: String(d.source ?? '每日一题做题本').slice(0, 40),
      /** 页眉右：默认留空，渲染时按日期推 */
      range: String(d.range ?? '').slice(0, 40),
      note: String(d.note ?? '').slice(0, 200),
      problems: (Array.isArray(d.problems) ? d.problems : [])
        .map((p, i) => cleanProblem(p, i, String(d.date)))
        .filter(Boolean)
        .slice(0, MAX_PER_DAY),
      updatedAt: Number(d.updatedAt) || 0,
    }))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, MAX_DAYS)
  return {
    version: 1,
    rev: Number(raw?.rev) || 0,
    updatedAt: Number(raw?.updatedAt) || 0,
    savedBy: raw?.savedBy,
    days,
    scope: normScope(raw?.scope),
  }
}

const store = createJsonStore({
  name: 'zuotiben',
  file: FILE,
  version: 1,
  backupDir: () => path.join(dataDir(), 'backups'),
  empty,
  migrate,
})

/* ---------------------------------------------------------------- 读 --- */

/** 某一天的册子（没有就回一个空的壳，前端好渲染） */
export function getDay(date = todayStr()) {
  const d = normDate(date)
  const hit = store.read().days.find((x) => x.date === d)
  return (
    hit ?? { date: d, source: '每日一题做题本', range: '', note: '', problems: [], updatedAt: 0 }
  )
}

/** 有记录的日期（新到旧），带题数与做过/做错统计 */
export function listDays() {
  return store.read().days.map((d) => ({
    date: d.date,
    source: d.source,
    total: d.problems.length,
    done: d.problems.filter((p) => p.done).length,
    wrong: d.problems.filter((p) => p.wrong).length,
    updatedAt: d.updatedAt,
  }))
}

/** 一段日期内的所有题，按日期升序拼平（给「本周错题」这类用） */
export function listRange({ from = '', to = '' } = {}) {
  const days = store.read().days.filter((d) => (!from || d.date >= from) && (!to || d.date <= to))
  return days
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .flatMap((d) => d.problems.map((p) => ({ ...p, date: d.date, daySource: d.source })))
}

export function stats() {
  const days = store.read().days
  const all = days.flatMap((d) => d.problems)
  return { dayCount: days.length, total: all.length, done: all.filter((p) => p.done).length, wrong: all.filter((p) => p.wrong).length }
}

/** 已学范围（推荐同类的过滤器）。人/智能体都能读，知道「凭什么只推这几章」。 */
export function getScope() {
  return store.read().scope ?? defaultScope()
}

export function setScope({ chapters, lectures, note } = {}) {
  const cur = store.read()
  const next = normScope({
    chapters: chapters !== undefined ? chapters : cur.scope?.chapters,
    lectures: lectures !== undefined ? lectures : cur.scope?.lectures,
    note: note !== undefined ? note : cur.scope?.note,
    updatedAt: Date.now(),
  })
  store.write({ ...cur, scope: next }, { source: 'agent' })
  return { ok: true, scope: next }
}

/**
 * 作答情况总结 —— 给智能体写「这次做得怎么样」用的事实底稿。
 *
 * 只出**可核对的事实**（哪几题对、哪几题错、错在哪、你自己写的备注），
 * 不下结论、不猜原因 —— 「总结」这句话让模型说，事实由这里给。
 */
export function review({ date = '', from = '', to = '' } = {}) {
  let days = store.read().days
  if (date) days = days.filter((d) => d.date === normDate(date))
  else if (from || to) days = days.filter((d) => (!from || d.date >= from) && (!to || d.date <= to))
  else days = days.slice(0, 1) // 不给范围就默认最近有记录的一天

  const flat = days
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .flatMap((d) => d.problems.map((p) => ({ ...p, date: d.date })))

  const result = (p) => (!p.done ? 'left' : p.wrong ? 'wrong' : 'right')
  const byTopicMap = new Map()
  for (const p of flat) {
    const key = p.topic || '(未标考点)'
    const t = byTopicMap.get(key) ?? { topic: key, total: 0, right: 0, wrong: 0, left: 0 }
    t.total++
    t[result(p)]++
    byTopicMap.set(key, t)
  }
  const byChapterMap = new Map()
  for (const p of flat) {
    const ch = p.ref?.chapter || 0
    const key = ch ? `第${ch}章 ${p.ref?.chapterTitle ?? ''}`.trim() : '(未标出处)'
    const t = byChapterMap.get(key) ?? { chapter: ch, title: p.ref?.chapterTitle ?? '', total: 0, right: 0, wrong: 0, left: 0 }
    t.total++
    t[result(p)]++
    byChapterMap.set(key, t)
  }

  const wrongList = flat
    .filter((p) => p.wrong)
    .map((p) => ({
      date: p.date,
      no: p.no,
      topic: p.topic,
      ref: p.ref?.label ?? '',
      chapter: p.ref?.chapter ?? 0,
      stem: p.stem.length > 80 ? `${p.stem.slice(0, 80)}…` : p.stem,
      answer: p.answer,
      /** 用户自己写的「为什么错」——总结里最有价值的一段 */
      note: p.note,
    }))

  return {
    ok: true,
    range: { from: days.at(-1)?.date ?? '', to: days[0]?.date ?? '', days: days.length },
    total: flat.length,
    right: flat.filter((p) => result(p) === 'right').length,
    wrong: flat.filter((p) => result(p) === 'wrong').length,
    left: flat.filter((p) => result(p) === 'left').length,
    byDay: days.map((d) => {
      const r = (f) => d.problems.filter(f).length
      return {
        date: d.date,
        total: d.problems.length,
        right: d.problems.filter((p) => p.done && !p.wrong).length,
        wrong: r((p) => p.wrong),
        left: d.problems.filter((p) => !p.done).length,
      }
    }),
    byTopic: [...byTopicMap.values()].sort((a, b) => b.wrong - a.wrong || b.total - a.total),
    byChapter: [...byChapterMap.values()].sort((a, b) => a.chapter - b.chapter),
    wrongList,
    /** 做错的题各自出自哪一章 —— 「推荐同类」直接拿这个当筛选条件 */
    wrongChapters: [...new Set(flat.filter((p) => p.wrong && p.ref?.chapter).map((p) => p.ref.chapter))].sort((a, b) => a - b),
    /** 已做过的题（章+题号），推荐时用来去重 */
    doneRefs: flat.map((p) => (p.ref?.chapter && p.ref?.no ? `jc${p.ref.chapter}-${p.ref.no}` : '')).filter(Boolean),
    scope: getScope(),
  }
}

/** 已做过的题在题库里的 id（`jc<章>-<题号>`），推荐同类时要排掉，别重复出题 */
export function doneIds() {
  const out = new Set()
  for (const d of store.read().days) {
    for (const p of d.problems) {
      if (p.ref?.chapter && p.ref?.no) out.add(`jc${p.ref.chapter}-${p.ref.no}`)
    }
  }
  return [...out]
}

/* ---------------------------------------------------------------- 写 --- */

/**
 * 往某天追加题。**同一天重复调用会接着往后编号**，所以可以「先给 5 道、做完再给 5 道」。
 * 也可以 update：传进来的题带了已存在的 id 就改它，不再新加一条。
 */
export function addProblems({ date = todayStr(), problems = [], source = 'agent', sourceLabel = '', note = '' } = {}) {
  const d = normDate(date)
  const incoming = (Array.isArray(problems) ? problems : []).filter((p) => p && (p.stem || p.text))
  if (!incoming.length) return { ok: false, error: '没给题目（每条至少要有 stem）' }

  const cur = store.read()
  const days = cur.days.map((x) => ({ ...x, problems: [...x.problems] }))
  let day = days.find((x) => x.date === d)
  if (!day) {
    day = { date: d, source: sourceLabel || '每日一题做题本', range: '', note: '', problems: [], updatedAt: 0 }
    days.push(day)
  }
  if (sourceLabel && !day.source) day.source = sourceLabel
  if (note) day.note = note

  const added = []
  const updated = []
  for (const raw of incoming) {
    const id = String(raw?.id ?? '').trim()
    const hit = id ? day.problems.findIndex((p) => p.id === id) : -1
    if (hit >= 0) {
      const merged = cleanProblem({ ...day.problems[hit], ...raw }, hit, d)
      merged.no = day.problems[hit].no
      day.problems[hit] = merged
      updated.push(merged)
      continue
    }
    if (day.problems.length >= MAX_PER_DAY) break
    const p = cleanProblem({ ...raw, source: raw?.source ?? source }, day.problems.length, d)
    if (!p) continue
    day.problems.push(p)
    added.push(p)
  }
  day.updatedAt = Date.now()

  const { data, conflict } = store.write({ ...cur, days }, { source })
  return { ok: true, date: d, added, updated, total: day.problems.length, rev: data.rev, conflict: conflict ?? null }
}

/** 改一条题（做题状态、答案、解析、考点） */
export function updateProblem({ date = todayStr(), id = '', patch = {} } = {}) {
  const d = normDate(date)
  const key = String(id ?? '').trim()
  if (!key) return { ok: false, error: '没给题目 id' }
  const cur = store.read()
  const days = cur.days.map((x) => ({ ...x, problems: [...x.problems] }))
  const day = days.find((x) => x.date === d)
  const i = day ? day.problems.findIndex((p) => p.id === key) : -1
  if (i < 0) return { ok: false, error: `没找到题 ${key}（${d}）` }
  const merged = cleanProblem({ ...day.problems[i], ...patch, id: key }, i, d)
  merged.no = day.problems[i].no
  day.problems[i] = merged
  day.updatedAt = Date.now()
  store.write({ ...cur, days }, { source: String(patch?.source ?? 'agent') })
  return { ok: true, problem: merged }
}

export function removeProblem({ date = todayStr(), id = '', source = 'agent' } = {}) {
  const d = normDate(date)
  const key = String(id ?? '').trim()
  const cur = store.read()
  const days = cur.days
    .map((x) => (x.date === d ? { ...x, problems: x.problems.filter((p) => p.id !== key), updatedAt: Date.now() } : x))
    .filter((x) => x.problems.length > 0)
  const gone = cur.days.find((x) => x.date === d)?.problems.some((p) => p.id === key)
  if (!gone) return { ok: false, error: `没找到题 ${key}（${d}）` }
  store.write({ ...cur, days }, { source })
  return { ok: true, date: d }
}

/** 清掉某天（整册删；留空的日子也会从列表里消失） */
export function clearDay({ date = '', source = 'agent' } = {}) {
  const d = normDate(date)
  const cur = store.read()
  const days = cur.days.filter((x) => x.date !== d)
  if (days.length === cur.days.length) return { ok: false, error: `${d} 本来就没有记录` }
  store.write({ ...cur, days }, { source })
  return { ok: true, date: d }
}

/* ------------------------------------------------------------ 页眉用 --- */

/** 一册做题本的页眉右：默认是这天的「年月」；跨天册子给范围（形如 2026.05.01 - 2026.05.31） */
export function rangeLabel(date = todayStr()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normDate(date))
  if (!m) return ''
  const [y, mo] = [m[1], m[2]]
  const last = new Date(Number(y), Number(mo), 0).getDate()
  return `${y}.${mo}.01 - ${y}.${mo}.${String(last).padStart(2, '0')}`
}

export function info() {
  return { ok: true, ...store.summary() }
}
