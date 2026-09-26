/**
 * 间隔重复（SuperMemo-2，Anki 同源）。
 *
 * 为什么用 SM-2 而不是 FSRS：零依赖、字段少、和现有「对/错」作答天然对齐。
 * 间隔按艾宾浩斯先密后疏：1 天 → 6 天 → interval × 难度系数。
 * 答错就把间隔打回 1 天（lapse），系数下限 1.3，不会无限变难。
 *
 * 本文件是纯函数，不碰 DOM / store；服务端 server/lib/srs.mjs 保持同一套规则。
 */
import type { QuestionType, WordStat } from './types'

export const DAY_MS = 86_400_000

export type DueBucket = 'overdue' | 'learning' | 'new' | 'upcoming' | 'mature'

/** viewStat 之后这些字段一定有数 */
export type HydratedStat = WordStat & {
  ease: number
  interval: number
  repetitions: number
  dueAt: number
  lapses: number
}

export function termKey(term: string): string {
  return String(term ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!?]+$/g, '')
    .trim()
}

function clampEase(ef: number): number {
  return Math.max(1.3, Math.round(ef * 100) / 100)
}

/** 把对/错 + 作答前连对次数，映射成 SM-2 的 0–5 质量分 */
export function qualityFromAnswer(correct: boolean, streakBefore: number): number {
  if (!correct) return 1
  if (streakBefore >= 2) return 5
  if (streakBefore === 1) return 4
  return 3
}

export function emptyStat(wordId: string, term = ''): HydratedStat {
  return {
    wordId,
    term,
    right: 0,
    wrong: 0,
    streak: 0,
    lastSeen: 0,
    ease: 2.5,
    interval: 0,
    repetitions: 0,
    dueAt: 0,
    lapses: 0,
    typeStats: {},
  }
}

/**
 * 给老学情补上 SM-2 字段。不改传入对象，返回一份完整视图。
 * 推断规则：连对次数当成已经毕业的复习次数；最近答错过的立刻到期。
 */
export function viewStat(raw?: Partial<WordStat> | null, wordId = '', term = ''): HydratedStat {
  const base = emptyStat(wordId || String(raw?.wordId ?? ''), term || String(raw?.term ?? ''))
  if (!raw) return base
  const out: HydratedStat = {
    ...base,
    ...raw,
    wordId: String(raw.wordId || wordId || base.wordId),
    term: String(raw.term || term || ''),
    right: Number(raw.right) || 0,
    wrong: Number(raw.wrong) || 0,
    streak: Number(raw.streak) || 0,
    lastSeen: Number(raw.lastSeen) || 0,
    typeStats: raw.typeStats && typeof raw.typeStats === 'object' ? { ...raw.typeStats } : {},
  }
  const hasSrs = Number(raw.ease) > 0 && raw.interval != null && raw.repetitions != null && raw.dueAt != null
  if (hasSrs) {
    out.ease = clampEase(Number(raw.ease) || 2.5)
    out.interval = Math.max(0, Number(raw.interval) || 0)
    out.repetitions = Math.max(0, Number(raw.repetitions) || 0)
    out.dueAt = Number(raw.dueAt) || 0
    out.lapses = Number(raw.lapses) || 0
    return out
  }
  out.ease = 2.5
  out.lapses = out.wrong
  if (out.streak <= 0 && out.right + out.wrong === 0) {
    out.interval = 0
    out.repetitions = 0
    out.dueAt = 0
  } else if (out.streak <= 0) {
    out.interval = 1
    out.repetitions = 0
    out.dueAt = out.lastWrongAt || out.lastSeen || Date.now()
  } else if (out.streak === 1) {
    out.interval = 1
    out.repetitions = 1
    out.dueAt = (out.lastSeen || Date.now()) + DAY_MS
  } else {
    out.repetitions = Math.min(out.streak, 8)
    out.interval = Math.min(60, Math.round(6 * Math.pow(2.5, Math.max(0, out.repetitions - 2))))
    out.dueAt = (out.lastSeen || Date.now()) + out.interval * DAY_MS
  }
  return out
}

/** 一次作答后的新学情。streakBefore 必须是作答前的连对次数。 */
export function applyAnswer(
  prev: Partial<WordStat> | null | undefined,
  opts: { wordId: string; term: string; correct: boolean; type?: QuestionType; now?: number },
): HydratedStat {
  const now = opts.now ?? Date.now()
  const cur = viewStat(prev, opts.wordId, opts.term)
  const streakBefore = cur.streak
  const q = qualityFromAnswer(opts.correct, streakBefore)

  if (opts.correct) {
    cur.right += 1
    cur.streak = streakBefore + 1
  } else {
    cur.wrong += 1
    cur.streak = 0
    cur.lastWrongAt = now
    cur.lapses = (cur.lapses || 0) + (cur.repetitions > 0 ? 1 : 0)
  }

  let { ease, interval, repetitions } = cur
  if (q >= 3) {
    if (repetitions <= 0) interval = 1
    else if (repetitions === 1) interval = 6
    else interval = Math.max(1, Math.round(interval * ease))
    repetitions += 1
  } else {
    repetitions = 0
    interval = 1
  }
  ease = clampEase(ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)))

  cur.ease = ease
  cur.interval = interval
  cur.repetitions = repetitions
  cur.dueAt = now + interval * DAY_MS
  cur.lastSeen = now
  cur.lastResult = opts.correct
  cur.term = opts.term
  cur.wordId = opts.wordId
  if (opts.type) {
    cur.lastType = opts.type
    const ts = cur.typeStats ?? {}
    const row = ts[opts.type] ?? { right: 0, wrong: 0 }
    if (opts.correct) row.right += 1
    else row.wrong += 1
    ts[opts.type] = row
    cur.typeStats = ts
  }
  return cur
}

export function dueBucket(stat: WordStat | undefined, now = Date.now()): DueBucket {
  const s = viewStat(stat)
  if (s.right + s.wrong === 0 && s.repetitions === 0) return 'new'
  if (s.repetitions < 2) return s.dueAt <= now ? 'overdue' : 'learning'
  if (s.dueAt <= now) return 'overdue'
  if (s.interval >= 21) return 'mature'
  return 'upcoming'
}

/** 越小越该先练：逾期 → 学习中 → 新词 → 未到期 */
export function dueRank(stat: WordStat | undefined, now = Date.now()): number {
  const s = viewStat(stat)
  const bucket = dueBucket(s, now)
  const overdueBy = now - (s.dueAt || 0)
  switch (bucket) {
    case 'overdue':
      return -1e15 - overdueBy
    case 'learning':
      return -1e12 + (s.dueAt || 0)
    case 'new':
      return 0
    case 'upcoming':
      return s.dueAt || now + DAY_MS
    default:
      return (s.dueAt || now) + 1e12
  }
}

export function weakestTypes(stat?: WordStat | null): QuestionType[] {
  const ts = viewStat(stat).typeStats ?? {}
  return (Object.entries(ts) as [QuestionType, { right: number; wrong: number }][])
    .filter(([, v]) => v.wrong > v.right)
    .sort((a, b) => b[1].wrong - b[1].right - (a[1].wrong - a[1].right))
    .map(([k]) => k)
}

export function isMastered(stat: WordStat | undefined, masterStreak = 2): boolean {
  const s = viewStat(stat)
  return s.interval >= 21 || s.streak >= Math.max(masterStreak, 3)
}

export function fmtDue(stat: WordStat | undefined, now = Date.now()): string {
  const s = viewStat(stat)
  const bucket = dueBucket(s, now)
  if (bucket === 'new') return '新词'
  if (bucket === 'overdue') {
    const days = Math.max(1, Math.round((now - s.dueAt) / DAY_MS))
    return days <= 1 ? '今日到期' : `逾期 ${days} 天`
  }
  if (bucket === 'learning') return '学习中'
  const days = Math.max(0, Math.round((s.dueAt - now) / DAY_MS))
  if (days <= 0) return '今日到期'
  if (days === 1) return '明天'
  return `${days} 天后`
}
