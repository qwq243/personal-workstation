/**
 * AI 每日总结 · 按天存档 + 读取降级 + 倒计时。
 *
 * 为什么要有这个：看板上的「AI 总结」以前是**点一次生成一次、不落盘** ——
 * 关掉页面就没了，第二天打开还是空的。但这份东西真正的用法是**第二天回头看**，
 * 所以必须按天存下来。
 *
 * 每天存两份，职责不同 ——
 *   recap「昨天」：那天发生了什么的回顾（第二天早上回看昨天）
 *   today「今天」：由昨天的回顾 + 今天的计划与临近截止推出来的行动建议
 *
 * 数据存 server/data/ai-summaries.json：
 *   days[date] = { recap: {...}, today: {...} }
 * 老格式（直接挂 content）在 migrate 里包成 recap，不会丢。
 *
 * recap 只有一个来源：**存档**（AI 生成过的那份）。前身还有「读复盘文件 / 读早报」两级降级 ——
 * 那两级依赖一个私人定时任务产出的目录，开源版已经去掉。所以没生成过就是「还没生成」，
 * 不假装有内容；页面上的按钮会引导你去生成。
 * 「today」同理 —— 它只能现算（要的是今天的事实），没生成就是不生成。
 *
 * 倒计时来自规划台（plan.json）的**主线考试**（pinned），由数据直接渲染，AI 不参与 ——
 * 日期这种事不能让模型背。
 */
import path from 'node:path'
import { loadConfig } from '../config.mjs'
import { createJsonStore, todayStr } from './jsonstore.mjs'
import * as plan from './plan.mjs'

export function dataDir() {
  return process.env.WS_DATA_DIR || loadConfig().dataDir
}
function backupDir() {
  return path.join(dataDir(), 'backups')
}
const FILE = () => path.join(dataDir(), 'ai-summaries.json')

const VERSION = 1
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
/** 往前找多少天（降级查找的上限，避免一次请求扫全目录） */
const LOOKBACK = 14
/** 存档只留最近 180 天，别让文件无限长 */
const KEEP_DAYS = 180

const store = createJsonStore({
  name: 'ai-summaries',
  file: FILE,
  version: VERSION,
  backupDir,
  empty: () => ({ version: VERSION, rev: 0, updatedAt: 0, days: {} }),
  /**
   * migrate 必须把 rev / updatedAt / savedBy 原样带出，否则 baseRev 校验会静默失效。
   * 兼容两件事：老格式（days[date] 直接挂 content）包成 recap；半截记录补齐字段。
   */
  migrate: (raw) => {
    const rawDays = raw?.days && typeof raw.days === 'object' && !Array.isArray(raw.days) ? raw.days : {}
    const days = {}
    for (const [k, v] of Object.entries(rawDays)) {
      if (!v || typeof v !== 'object') continue
      if (v.recap || v.today) {
        days[k] = { recap: v.recap ?? null, today: v.today ?? null }
      } else if (v.content) {
        days[k] = {
          recap: { content: v.content, model: v.model, provider: v.provider, usage: v.usage, generatedAt: v.generatedAt },
          today: null,
        }
      }
    }
    return { version: VERSION, rev: 0, updatedAt: 0, ...raw, days }
  },
})

/* --------------------------------------------------------------- 工具 --- */

export function shiftDate(date, n) {
  const d = new Date(`${date}T00:00:00`)
  d.setDate(d.getDate() + n)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 相对今天的说法，给界面直接用 */
function relOf(date) {
  const t = todayStr()
  if (date === t) return 'today'
  if (date === shiftDate(t, -1)) return 'yesterday'
  if (date === shiftDate(t, 1)) return 'tomorrow'
  return date < t ? 'past' : 'future'
}

/** 把 markdown 文件里的某一节压成纯文本 */
function sectionToText(sec) {
  if (!sec) return ''
  const parts = []
  if (sec.text?.length) parts.push(sec.text.join('\n'))
  if (sec.items?.length) parts.push(sec.items.join('\n'))
  return parts.filter(Boolean).join('\n')
}

function pickSection(sections, re) {
  return (sections ?? []).find((s) => re.test(String(s.title ?? '')))
}

function normEntry(e) {
  return e && e.content
    ? { content: String(e.content), model: e.model ?? null, provider: e.provider ?? null, usage: e.usage ?? null, generatedAt: Number(e.generatedAt) || null }
    : null
}

/* --------------------------------------------------------------- 写入 --- */

/**
 * 存档一份 AI 生成结果。
 * @param {'recap'|'today'} kind 存到哪一栏（两栏互不覆盖，同一天可以各有一份）
 */
export function save(date, payload = {}, { kind = 'recap', source = 'web' } = {}) {
  const d = DATE_RE.test(String(date ?? '')) ? date : todayStr()
  if (!payload?.content) return { ok: false, error: '没有内容可存' }
  if (kind !== 'recap' && kind !== 'today') return { ok: false, error: `未知的存档类型：${kind}` }

  const cur = store.read()
  const days = { ...(cur.days ?? {}) }
  const cell = { ...(days[d] ?? {}) }
  cell[kind] = {
    content: String(payload.content),
    model: payload.model ?? null,
    provider: payload.provider ?? null,
    usage: payload.usage ?? null,
    generatedAt: Number(payload.generatedAt) || Date.now(),
  }
  days[d] = cell
  // 只留最近 KEEP_DAYS 天
  const keep = Object.keys(days).sort().slice(-KEEP_DAYS)
  const trimmed = {}
  for (const k of keep) trimmed[k] = days[k]
  store.write({ ...cur, days: trimmed }, { source })
  return { ok: true, date: d, kind, days: Object.keys(trimmed).length }
}

/* --------------------------------------------------------------- 读取 --- */

function rawCell(date) {
  const days = store.read().days ?? {}
  return days[date] ?? null
}

/**
 * 「昨天」的回顾：只读存档。
 * @param {string} date 精确到天，不做自动回退（回退由 recapLatest 负责）
 */
export function recapFor(date) {
  if (!DATE_RE.test(String(date ?? ''))) return { ok: false, error: '日期格式不对' }
  const a = normEntry(rawCell(date)?.recap)
  if (a) return { ok: true, date, rel: relOf(date), source: 'archive', title: 'AI 总结', ...a }
  return { ok: false, date, rel: relOf(date), error: '这一天还没有生成过总结' }
}

/** 最近一次有内容的回顾（从**昨天**开始往前找：今天还没过完，不该有「回顾」） */
export function recapLatest() {
  const t = todayStr()
  for (let i = 1; i <= LOOKBACK; i += 1) {
    const r = recapFor(shiftDate(t, -i))
    if (r.ok) return r
  }
  return { ok: false, error: '最近还没有生成过总结，先去生成一次' }
}

/** 「今天」的行动建议存档（只能现算，没有降级） */
export function todayFor(date) {
  const a = normEntry(rawCell(date)?.today)
  return a ? { ok: true, date, rel: relOf(date), source: 'archive', title: '今日建议', ...a } : null
}

/**
 * 倒计时：规划台里被标成**主线**（pinned）的那几个日期。
 * 从 plan.json 读，AI 不参与 —— 日期不能靠模型背。
 */
export function countdowns() {
  try {
    return plan
      .panel()
      .hero.map((e) => ({ id: e.id, name: e.name, date: e.date, daysLeft: e.daysLeft, kind: e.kind, note: e.note, official: e.official }))
      .filter((e) => Number.isFinite(e.daysLeft))
  } catch {
    return []
  }
}

/**
 * 看板「AI 总结」卡要的全部东西，一次取走。
 * @param {string} [date] 指定看哪天的回顾；省略 = 最近一次有内容的（通常就是昨天）
 */
export function view(date) {
  const today = todayStr()
  const recap = DATE_RE.test(String(date ?? '')) ? recapFor(date) : recapLatest()
  const brief = todayFor(today)
  return {
    ok: recap.ok || !!brief,
    date: today,
    recap,
    today: brief ?? { ok: false, date: today, error: '还没有生成今天的建议' },
    countdowns: countdowns(),
  }
}

/** 存储自检（排查用） */
export function status() {
  const s = store.summary()
  const days = store.read().days ?? {}
  return {
    ...s,
    dates: Object.keys(days).sort(),
    recapDates: Object.keys(days).filter((k) => days[k]?.recap).sort(),
    todayDates: Object.keys(days).filter((k) => days[k]?.today).sort(),
  }
}
