/**
 * 规划台 —— 长期目标：项目管理 + 备考清单 + 关键日期倒计时。
 *
 * 和「每日看板」的分工（避免两处重复）：
 *   dashboard.mjs —— 今天这一天：课表、待办、计划、复盘。
 *   plan.mjs      —— 这个学期要推进到哪：项目进度、备考阶段、硬时间点。
 *
 * 数据存 server/data/plan.json（createJsonStore：原子写 / .bak 回退 / 每日快照 / rev 并发控制），
 * 与前端共用同一份 —— 所以 MCP / 智能体可以直接往里写：把每日对话复盘整理出的项目进度
 * 落到这里，面板就自动更新，不需要从浏览器里改。
 *
 * 倒计时的口径：daysLeft 一律按**本地日历日**算（今天 = 0，明天 = 1，已过去为负）。
 * 服务端算一份给 MCP / 文本场景用；前端每次渲染现算一份，跨天不用重启就准。
 */
import path from 'node:path'
import { loadConfig } from '../config.mjs'
import { createJsonStore, todayStr } from './jsonstore.mjs'

export function dataDir() {
  return process.env.WS_DATA_DIR || loadConfig().dataDir
}
export function backupDir() {
  return path.join(dataDir(), 'backups')
}
const PLAN_FILE = () => path.join(dataDir(), 'plan.json')

const VERSION = 1

/** 条目的默认来源标记；每条记录都能带自己的 `source`，面板上会显示「这条是哪来的」 */
export const DEFAULT_SOURCE = 'manual'

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 乱码拒写（2026-09-15 事故）：外部会话把「锟斤拷 / U+FFFD」文本经 MCP 写入 plan.json，
 * 信息当场不可逆丢失，只能按复盘语义人工重建。入口层直接拒绝这类文本，让写入方当场报错，
 * 而不是让乱码静默入库。
 */
const MOJIBAKE_RE = /锟斤拷|�{2,}/
export function hasMojibake(v) {
  if (typeof v === 'string') return MOJIBAKE_RE.test(v)
  if (Array.isArray(v)) return v.some(hasMojibake)
  if (isPlainObject(v)) return Object.values(v).some(hasMojibake)
  return false
}

/**
 * 首次运行（plan.json 还不存在）时的初始内容 —— **出厂是空的**。
 *
 * 这里以前预置过一份写死的项目清单与考试日期（含某次对话复盘里的结论）。
 * 那些是个人信息 + 一次性结论，不该由代码替使用者决定，所以清空成空结构。
 *
 * 页面「规划台」会给空态引导：`exams` 加关键日期（考试 / 报名截止），
 * `projects` 加项目与下一步，`prep` 加备考清单。
 * 每条都可以带 `source` 字段（自由文本，写「这条是哪来的」），面板上会显示出来。
 */
function seed() {
  return {
    version: VERSION,
    exams: [],
    projects: [],
    prep: [],
  }
}

/* ------------------------------------------------------------ 归一化 --- */

function normStep(raw, i) {
  const r = isPlainObject(raw) ? raw : { text: raw }
  return {
    id: String(r.id || `s${i + 1}`),
    text: String(r.text ?? '').trim(),
    done: !!r.done,
  }
}

function normSteps(list) {
  return (Array.isArray(list) ? list : []).map(normStep).filter((s) => s.text)
}

function normExam(raw, i) {
  const r = isPlainObject(raw) ? raw : {}
  return {
    id: String(r.id || `exam${i + 1}`),
    name: String(r.name || '未命名时间点'),
    date: DATE_RE.test(r.date) ? r.date : '',
    time: typeof r.time === 'string' ? r.time : '',
    /** exam = 考试；deadline = 报名/材料这类截止 */
    kind: r.kind === 'deadline' ? 'deadline' : 'exam',
    /** pinned = 在倒计时区用大卡展示（最重要的那一两个日期） */
    pinned: !!r.pinned,
    /** 官方公告的值 = true；推算值 = false（提醒用户这个数是要改的） */
    official: !!r.official,
    prepId: typeof r.prepId === 'string' ? r.prepId : '',
    note: typeof r.note === 'string' ? r.note : '',
    source: typeof r.source === 'string' ? r.source : '',
  }
}

const PRIORITIES = ['P0', 'P1', 'P2', 'P3']
const STATUSES = ['active', 'waiting', 'paused', 'done']

function normProject(raw, i) {
  const r = isPlainObject(raw) ? raw : {}
  const pr = Number(r.progress)
  return {
    id: String(r.id || `proj${i + 1}`),
    name: String(r.name || '未命名项目'),
    priority: PRIORITIES.includes(r.priority) ? r.priority : 'P2',
    status: STATUSES.includes(r.status) ? r.status : 'active',
    deadline: DATE_RE.test(r.deadline) ? r.deadline : '',
    progress: Number.isFinite(pr) ? Math.max(0, Math.min(100, Math.round(pr))) : 0,
    stage: typeof r.stage === 'string' ? r.stage : '',
    note: typeof r.note === 'string' ? r.note : '',
    source: typeof r.source === 'string' ? r.source : '',
    next: normSteps(r.next),
    updatedAt: Number(r.updatedAt) || 0,
  }
}

function normPrep(raw, i) {
  const r = isPlainObject(raw) ? raw : {}
  return {
    id: String(r.id || `prep${i + 1}`),
    name: String(r.name || '备考'),
    examId: typeof r.examId === 'string' ? r.examId : '',
    stage: typeof r.stage === 'string' ? r.stage : '',
    note: typeof r.note === 'string' ? r.note : '',
    source: typeof r.source === 'string' ? r.source : '',
    items: normSteps(r.items),
  }
}

/**
 * 结构迁移 / 归一化。
 *
 * 两个要点：
 *   1. rev / updatedAt / savedBy 必须原样带出来 —— 它们是 jsonstore 的并发控制字段，
 *      被 migrate 丢掉的话 rev 永远读成 0，baseRev 校验就废了（每次写入都被当「无冲突」）。
 *   2. 数组字段「存在就按存在的来」—— 空数组是用户的真实意图（他清空了），
 *      只有整个字段缺失（老文件 / 首次运行）才回落到种子。
 */
function migrate(raw) {
  const d = isPlainObject(raw) ? raw : {}
  const s = seed()
  return {
    version: VERSION,
    rev: Number(d.rev) || 0,
    updatedAt: Number(d.updatedAt) || 0,
    savedBy: typeof d.savedBy === 'string' ? d.savedBy : null,
    exams: Array.isArray(d.exams) ? d.exams.map(normExam) : s.exams.map(normExam),
    projects: Array.isArray(d.projects) ? d.projects.map(normProject) : s.projects.map(normProject),
    prep: Array.isArray(d.prep) ? d.prep.map(normPrep) : s.prep.map(normPrep),
  }
}

const store = createJsonStore({
  name: 'plan',
  file: PLAN_FILE,
  version: VERSION,
  empty: seed,
  migrate,
  backupDir,
})

/* --------------------------------------------------------- 倒计时 --- */

function utcDay(s) {
  const [y, m, d] = String(s).split('-').map(Number)
  if (!y || !m || !d) return NaN
  return Date.UTC(y, m - 1, d)
}

/**
 * 目标日期距今天还有几天。今天 = 0，明天 = 1，已经过去为负。
 * 用 UTC 归一化后再相减：只比「日历日」，不受时区与夏令时影响。
 */
export function daysLeft(date, from = todayStr()) {
  if (!DATE_RE.test(String(date ?? ''))) return null
  const a = utcDay(from)
  const b = utcDay(date)
  if (Number.isNaN(a) || Number.isNaN(b)) return null
  return Math.round((b - a) / 86400000)
}

/* ------------------------------------------------------------ 读 --- */

/** 项目排序：没完成的在前 → P0 优先 → 有截止的在前且更早的优先 → 进度高的在前 */
function projectRank(a, b) {
  const ad = a.status === 'done' ? 1 : 0
  const bd = b.status === 'done' ? 1 : 0
  if (ad !== bd) return ad - bd
  const ap = PRIORITIES.indexOf(a.priority)
  const bp = PRIORITIES.indexOf(b.priority)
  if (ap !== bp) return ap - bp
  const aDead = a.deadline || '9999-99-99'
  const bDead = b.deadline || '9999-99-99'
  if (aDead !== bDead) return aDead.localeCompare(bDead)
  return b.progress - a.progress
}

/**
 * 面板全量数据：关键日期（带天数）+ 项目 + 备考（带完成度）。
 * daysLeft 在服务端算一份，方便 MCP / 纯文本场景直接读；前端仍会自己现算，跨天自动前进。
 */
export function panel() {
  const d = store.read()
  const today = todayStr()

  const exams = d.exams.map((e) => ({ ...e, daysLeft: daysLeft(e.date, today) }))
  const examById = new Map(exams.map((e) => [e.id, e]))

  const hero = exams.filter((e) => e.pinned)
  const milestones = exams
    .filter((e) => !e.pinned)
    .sort((a, b) => (a.date || '9999-99-99').localeCompare(b.date || '9999-99-99'))

  const projects = d.projects.map((p) => ({ ...p, daysLeft: daysLeft(p.deadline, today) })).sort(projectRank)

  const prep = d.prep.map((s) => {
    const total = s.items.length
    const done = s.items.filter((x) => x.done).length
    return {
      ...s,
      total,
      done,
      progress: total ? Math.round((done / total) * 100) : 0,
      exam: (s.examId && examById.get(s.examId)) || null,
    }
  })

  const summary = store.summary()
  return {
    ok: true,
    today,
    hero,
    milestones,
    exams,
    projects,
    prep,
    meta: {
      rev: summary.rev,
      updatedAt: summary.updatedAt,
      savedBy: summary.savedBy,
      file: summary.file,
      exists: summary.exists,
    },
  }
}

/* ------------------------------------------------------------ 写 --- */

/**
 * 部分保存：只替换传进来的那几节，没传的保持原样。
 * baseRev 带上读到时的版本号 —— 与磁盘不一致说明别处（另一个窗口 / 一个智能体）也改过，
 * 旧版本会被另存为 .conflict 副本，不会静默消失。
 */
export function save(patch = {}, { baseRev, source = 'web' } = {}) {
  const cur = store.read()
  const next = {
    exams: Array.isArray(patch.exams) ? patch.exams.map(normExam) : cur.exams,
    projects: Array.isArray(patch.projects) ? patch.projects.map(normProject) : cur.projects,
    prep: Array.isArray(patch.prep) ? patch.prep.map(normPrep) : cur.prep,
  }
  const { data, conflict, prevRev } = store.write(next, { baseRev, source })
  return { ...panel(), rev: data.rev, prevRev, conflict: conflict ?? null }
}

/**
 * 单个项目的细粒度更新（给智能体用：它不该被要求「读懂整个数组再写回」）。
 * 按 id 或名称匹配；都不存在就新建。next 是「下一步清单」，
 * addNext 追加、doneNext 勾掉（按 id 或文本匹配）。
 */
export function upsertProject(input = {}) {
  if (hasMojibake(input)) {
    return { ok: false, error: '文本含乱码（锟斤拷 / U+FFFD），疑似上游编码错读，已拒写；请把原文按 UTF-8 重新粘贴' }
  }
  const cur = store.read()
  const list = cur.projects.map((p) => ({ ...p, next: [...p.next] }))

  const key = String(input.id ?? input.name ?? '').trim()
  const i = key ? list.findIndex((p) => p.id === key || p.name === key) : -1

  const target = i >= 0 ? list[i] : normProject({ id: input.id || uid('p'), name: input.name ?? '未命名项目' })
  if (i < 0 && !input.name) return { ok: false, error: '新建项目必须给 name（或给一个已存在的 id / name 来更新）' }

  for (const f of ['name', 'priority', 'status', 'deadline', 'stage', 'note', 'source']) {
    if (input[f] !== undefined) target[f] = input[f]
  }
  if (input.progress !== undefined) target.progress = input.progress

  if (Array.isArray(input.setNext)) target.next = normSteps(input.setNext)
  if (Array.isArray(input.addNext)) {
    target.next = [...target.next, ...input.addNext.map((t) => ({ id: uid('ns'), text: String(t), done: false }))]
  }
  if (Array.isArray(input.doneNext) && input.doneNext.length) {
    const hit = new Set(input.doneNext.map(String))
    target.next = target.next.map((n) => (hit.has(n.id) || hit.has(n.text) ? { ...n, done: true } : n))
  }
  if (Array.isArray(input.undoneNext) && input.undoneNext.length) {
    const hit = new Set(input.undoneNext.map(String))
    target.next = target.next.map((n) => (hit.has(n.id) || hit.has(n.text) ? { ...n, done: false } : n))
  }

  target.updatedAt = Date.now()
  const norm = normProject(target)
  if (i >= 0) list[i] = norm
  else list.push(norm)

  const { data, conflict } = store.write({ ...cur, projects: list }, { baseRev: input.baseRev, source: input.source ?? 'agent' })
  return { ...panel(), rev: data.rev, conflict: conflict ?? null, project: { ...norm, daysLeft: daysLeft(norm.deadline) } }
}

/**
 * 关键日期（考试 / 报名截止）的细粒度更新。
 * 最典型的用法：日期一开始是按惯例推算的，官方通知一发就把 official 改成 true 并更新日期。
 */
export function upsertExam(input = {}) {
  if (hasMojibake(input)) {
    return { ok: false, error: '文本含乱码（锟斤拷 / U+FFFD），疑似上游编码错读，已拒写；请把原文按 UTF-8 重新粘贴' }
  }
  const cur = store.read()
  const list = cur.exams.map((e) => ({ ...e }))

  const key = String(input.id ?? input.idOrName ?? input.name ?? '').trim()
  const i = key ? list.findIndex((e) => e.id === key || e.name === key) : -1
  if (i < 0 && !input.name) return { ok: false, error: '新建时间点必须给 name（或给一个已存在的 id / name 来更新）' }

  const target = i >= 0 ? list[i] : normExam({ id: input.id || uid('exam'), name: input.name })
  for (const f of ['name', 'date', 'time', 'kind', 'note', 'source', 'prepId']) {
    if (input[f] !== undefined) target[f] = input[f]
  }
  if (input.official !== undefined) target.official = !!input.official
  if (input.pinned !== undefined) target.pinned = !!input.pinned

  const norm = normExam(target)
  if (i >= 0) list[i] = norm
  else list.push(norm)

  const { data, conflict } = store.write({ ...cur, exams: list }, { baseRev: input.baseRev, source: input.source ?? 'agent' })
  return { ...panel(), rev: data.rev, conflict: conflict ?? null, exam: { ...norm, daysLeft: daysLeft(norm.date) } }
}

/** 备考清单里勾一条 / 加一条（同样给智能体用） */
export function updatePrep(input = {}) {
  if (hasMojibake(input)) {
    return { ok: false, error: '文本含乱码（锟斤拷 / U+FFFD），疑似上游编码错读，已拒写；请把原文按 UTF-8 重新粘贴' }
  }
  const cur = store.read()
  const list = cur.prep.map((p) => ({ ...p, items: [...p.items] }))
  const key = String(input.id ?? input.name ?? '').trim()
  const i = key ? list.findIndex((p) => p.id === key || p.name === key) : -1
  if (i < 0) return { ok: false, error: `没找到备考板块 ${key || '(空)'}` }

  const target = list[i]
  for (const f of ['name', 'stage', 'note', 'examId']) if (input[f] !== undefined) target[f] = input[f]
  if (Array.isArray(input.setItems)) target.items = normSteps(input.setItems)
  if (Array.isArray(input.addItems)) {
    target.items = [...target.items, ...input.addItems.map((t) => ({ id: uid('ns'), text: String(t), done: false }))]
  }
  for (const [field, flag] of [['doneItems', true], ['undoneItems', false]]) {
    if (!Array.isArray(input[field]) || !input[field].length) continue
    const hit = new Set(input[field].map(String))
    target.items = target.items.map((it) => (hit.has(it.id) || hit.has(it.text) ? { ...it, done: flag } : it))
  }

  const { data, conflict } = store.write({ ...cur, prep: list }, { baseRev: input.baseRev, source: input.source ?? 'agent' })
  return { ...panel(), rev: data.rev, conflict: conflict ?? null }
}

/** 存储自检（排查用） */
export function info() {
  return { ok: true, ...store.summary() }
}
