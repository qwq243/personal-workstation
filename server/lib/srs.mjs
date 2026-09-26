/**
 * 间隔重复（SuperMemo-2）—— 与前端 src/features/vocab/srs.ts 同一套规则。
 * 服务端用来算今日到期、给智能体复习建议、合并重复词的学情。
 */
export const DAY_MS = 86_400_000

export function termKey(term) {
  return String(term ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!?]+$/g, '')
    .trim()
}

function clampEase(ef) {
  return Math.max(1.3, Math.round(ef * 100) / 100)
}

export function qualityFromAnswer(correct, streakBefore) {
  if (!correct) return 1
  if (streakBefore >= 2) return 5
  if (streakBefore === 1) return 4
  return 3
}

export function emptyStat(wordId, term = '') {
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

export function viewStat(raw, wordId = '', term = '') {
  const base = emptyStat(wordId || String(raw?.wordId ?? ''), term || String(raw?.term ?? ''))
  if (!raw || typeof raw !== 'object') return base
  const out = {
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

export function applyAnswer(prev, { wordId, term, correct, type, now = Date.now() } = {}) {
  const cur = viewStat(prev, wordId, term)
  const streakBefore = cur.streak
  const q = qualityFromAnswer(!!correct, streakBefore)
  if (correct) {
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
  cur.lastResult = !!correct
  cur.term = term
  cur.wordId = wordId
  if (type) {
    cur.lastType = type
    const ts = cur.typeStats ?? {}
    const row = ts[type] ?? { right: 0, wrong: 0 }
    if (correct) row.right += 1
    else row.wrong += 1
    ts[type] = row
    cur.typeStats = ts
  }
  return cur
}

export function dueBucket(stat, now = Date.now()) {
  const s = viewStat(stat)
  if (s.right + s.wrong === 0 && s.repetitions === 0) return 'new'
  if (s.repetitions < 2) return s.dueAt <= now ? 'overdue' : 'learning'
  if (s.dueAt <= now) return 'overdue'
  if (s.interval >= 21) return 'mature'
  return 'upcoming'
}

export function dueRank(stat, now = Date.now()) {
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

export function isMastered(stat, masterStreak = 2) {
  const s = viewStat(stat)
  return s.interval >= 21 || s.streak >= Math.max(masterStreak, 3)
}

export function fmtDue(stat, now = Date.now()) {
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

export function mergeStats(a, b) {
  const A = viewStat(a)
  const B = viewStat(b)
  const richer = (A.repetitions || 0) >= (B.repetitions || 0) ? A : B
  const typeStats = { ...(A.typeStats || {}) }
  for (const [k, v] of Object.entries(B.typeStats || {})) {
    const cur = typeStats[k] ?? { right: 0, wrong: 0 }
    typeStats[k] = { right: cur.right + (v.right || 0), wrong: cur.wrong + (v.wrong || 0) }
  }
  return {
    ...richer,
    right: A.right + B.right,
    wrong: A.wrong + B.wrong,
    streak: Math.max(A.streak, B.streak),
    lastSeen: Math.max(A.lastSeen || 0, B.lastSeen || 0),
    lastWrongAt: Math.max(A.lastWrongAt || 0, B.lastWrongAt || 0) || undefined,
    lapses: (A.lapses || 0) + (B.lapses || 0),
    typeStats,
  }
}
