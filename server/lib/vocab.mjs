/**
 * 背单词：服务端存储 + 业务逻辑。
 *
 * 为什么要有这个模块（原来词单只活在浏览器 localStorage 里）：
 *   localStorage 是浏览器独占的，智能体、MCP、命令行脚本都碰不到 ——
 *   于是「今天复习的单词」只能靠人手工粘进网页。把它搬到 server/data/vocab/ 之后，
 *   智能体可以一条工具调用就把词录进去，网页与智能体读写的是同一份数据。
 *
 * 存储分两个文件，刻意不合并：
 *   data/vocab/lists.json    —— 词单与词条。低频写（智能体导入、人手工编辑）。
 *   data/vocab/progress.json —— 学情：每词对错、连对、练习历史、设置。高频写（每答一题）。
 * 分开的好处：答题时不必反复重写整份词单；智能体改词也不会踩到学情；
 * 各自独立做快照与冲突留证，出了一边的问题不会牵连另一边。
 *
 * 文件格式（lists.json）：
 *   { version, rev, updatedAt, savedBy, lists: [{ id, name, description, source, createdAt, updatedAt, words: [...] }] }
 * 词条字段与前端 types.ts 的 VocabWord 一一对应，前端拿过去能直接用。
 *
 * 测试用 `WS_DATA_DIR` 指定数据根目录即可把数据写到别处（不会碰真实数据）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { loadConfig } from '../config.mjs'
import { createJsonStore } from './jsonstore.mjs'
import { requestBytes } from './net.mjs'
import { dueBucket, dueRank, fmtDue, isMastered, mergeStats, termKey, viewStat } from './srs.mjs'

const LISTS_VERSION = 1
const PROGRESS_VERSION = 1
/** 与前端 DEFAULT_SETTINGS 保持一致 */
const DEFAULT_SETTINGS = { masterStreak: 2, strictSpelling: true }

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

export function dataDir() {
  return process.env.WS_DATA_DIR || loadConfig().dataDir
}
function vocabDir() {
  return path.join(dataDir(), 'vocab')
}
function backupDir() {
  return path.join(dataDir(), 'backups')
}

let seq = 0
export function newId(prefix = 'w') {
  seq += 1
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}${Math.random().toString(36).slice(2, 5)}`
}

/* ------------------------------------------------------------ 归一化 --- */

function normalizeWord(w) {
  const out = {
    id: String(w.id ?? '') || newId('w'),
    term: String(w.term ?? '').trim(),
    meaning: String(w.meaning ?? '').trim() || '（未填写释义）',
  }
  for (const k of ['phonetic', 'pos', 'example', 'exampleZh', 'note']) {
    if (typeof w[k] === 'string' && w[k].trim()) out[k] = w[k].trim()
  }
  if (Array.isArray(w.examples)) {
    const seen = new Set()
    out.examples = w.examples
      .filter(isPlainObject)
      .map((ex) => ({ en: String(ex.en ?? '').trim(), zh: typeof ex.zh === 'string' && ex.zh.trim() ? ex.zh.trim() : undefined, source: typeof ex.source === 'string' ? ex.source : undefined }))
      .filter((ex) => {
        if (!ex.en) return false
        const k = ex.en.toLowerCase().replace(/\s+/g, ' ')
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })
    if (!out.example && out.examples[0]) {
      out.example = out.examples[0].en
      if (out.examples[0].zh) out.exampleZh = out.examples[0].zh
    }
  } else if (out.example) {
    out.examples = [{ en: out.example, zh: out.exampleZh }]
  }
  if (Array.isArray(w.meaningAliases) && w.meaningAliases.length) {
    out.meaningAliases = w.meaningAliases.map((x) => String(x)).filter(Boolean)
  }
  if (Array.isArray(w.tags) && w.tags.length) out.tags = w.tags.map((x) => String(x)).filter(Boolean)
  if (Number(w.addedAt)) out.addedAt = Number(w.addedAt)
  if (typeof w.addedBy === 'string' && w.addedBy) out.addedBy = w.addedBy
  if (w.goal === 'read' || w.goal === 'listen' || w.goal === 'write') out.goal = w.goal
  return out
}

const LIST_SOURCES = ['builtin', 'user', 'import']

function normalizeList(l) {
  const now = Date.now()
  const words = Array.isArray(l.words) ? l.words.filter(isPlainObject).map(normalizeWord) : []
  return {
    id: String(l.id ?? '') || newId('list'),
    name: String(l.name ?? '').trim() || '未命名词单',
    description: typeof l.description === 'string' ? l.description : '',
    source: LIST_SOURCES.includes(l.source) ? l.source : 'user',
    createdAt: Number(l.createdAt) || now,
    updatedAt: Number(l.updatedAt) || now,
    // 清理空词条（term 为空的）
    words: words.filter((w) => w.term),
  }
}

function migrateLists(raw) {
  const d = { version: LISTS_VERSION, rev: 0, updatedAt: 0, lists: [], ...raw }
  d.version = LISTS_VERSION
  d.rev = Number(d.rev) || 0
  d.updatedAt = Number(d.updatedAt) || 0
  d.lists = Array.isArray(d.lists) ? d.lists.filter(isPlainObject).map(normalizeList) : []
  return d
}

function normalizeStat(s) {
  return viewStat(s)
}

function richerText(a, b) {
  const A = String(a ?? '').trim()
  const B = String(b ?? '').trim()
  if (!A || A === '（未填写释义）') return B || A
  if (!B || B === '（未填写释义）') return A
  return B.length > A.length ? B : A
}

function enrichWord(target, incoming) {
  let n = 0
  const next = { ...target }
  for (const k of ['phonetic', 'pos', 'note']) {
    const v = richerText(next[k], incoming[k])
    if (v && v !== next[k]) {
      next[k] = v
      n += 1
    }
  }
  const incomingExamples = [
    ...(Array.isArray(incoming.examples) ? incoming.examples : []),
    ...(incoming.example ? [{ en: incoming.example, zh: incoming.exampleZh }] : []),
  ]
  const seen = new Set((next.examples || []).map((ex) => String(ex.en).toLowerCase().replace(/\s+/g, ' ')))
  if (next.example) seen.add(String(next.example).toLowerCase().replace(/\s+/g, ' '))
  const extra = []
  for (const ex of incomingExamples) {
    const t = String(ex.en ?? '').trim()
    if (!t) continue
    const k = t.toLowerCase().replace(/\s+/g, ' ')
    if (seen.has(k)) continue
    seen.add(k)
    extra.push({ en: t, zh: ex.zh ? String(ex.zh).trim() : undefined, source: ex.source })
  }
  if (extra.length) {
    next.examples = [...(next.examples || (next.example ? [{ en: next.example, zh: next.exampleZh }] : [])), ...extra]
    if (!next.example) {
      next.example = extra[0].en
      next.exampleZh = extra[0].zh
    }
    n += extra.length
  }
  const meaning = richerText(next.meaning, incoming.meaning)
  if (meaning !== next.meaning) {
    next.meaning = meaning
    n += 1
  }
  const tags = [...new Set([...(next.tags || []), ...(incoming.tags || [])].filter(Boolean))]
  if (tags.length !== (next.tags || []).length) {
    next.tags = tags
    n += 1
  }
  return { word: next, n }
}

function findByTerm(lists, term, exceptListId) {
  const k = termKey(term)
  if (!k) return null
  for (const l of lists) {
    if (exceptListId && l.id === exceptListId) continue
    const word = l.words.find((w) => termKey(w.term) === k)
    if (word) return { list: l, word }
  }
  return null
}

function normalizeSession(s) {
  const answers = Array.isArray(s.answers)
    ? s.answers.filter(isPlainObject).map((a) => ({
        wordId: String(a.wordId ?? ''),
        term: String(a.term ?? ''),
        meaning: String(a.meaning ?? ''),
        phonetic: typeof a.phonetic === 'string' ? a.phonetic : undefined,
        type: a.type,
        given: String(a.given ?? ''),
        expected: String(a.expected ?? ''),
        correct: !!a.correct,
        at: Number(a.at) || 0,
      }))
    : []
  const wrong = Array.isArray(s.wrong)
    ? s.wrong.filter(isPlainObject)
    : answers.filter((a) => !a.correct).map((a) => ({ wordId: a.wordId, term: a.term, meaning: a.meaning, phonetic: a.phonetic }))
  return {
    id: String(s.id ?? '') || newId('s'),
    listId: String(s.listId ?? ''),
    listName: String(s.listName ?? ''),
    startedAt: Number(s.startedAt) || 0,
    finishedAt: Number(s.finishedAt) || 0,
    updatedAt: Number(s.updatedAt) || Number(s.finishedAt) || Number(s.startedAt) || 0,
    status: s.status === 'running' || s.status === 'abandoned' || s.status === 'done' ? s.status : (s.finishedAt ? 'done' : 'abandoned'),
    order: typeof s.order === 'string' ? s.order : undefined,
    planned: Number(s.planned) || undefined,
    total: Number(s.total) || answers.length,
    correct: Number(s.correct) || answers.filter((a) => a.correct).length,
    types: Array.isArray(s.types) ? s.types : [...new Set(answers.map((a) => a.type).filter(Boolean))],
    wrong,
    answers,
  }
}

function normalizeActive(raw) {
  if (!isPlainObject(raw) || !Array.isArray(raw.questions) || !raw.questions.length) return null
  return {
    sessionId: String(raw.sessionId ?? ''),
    listId: String(raw.listId ?? ''),
    listName: String(raw.listName ?? ''),
    form: isPlainObject(raw.form) ? raw.form : {},
    questions: raw.questions,
    cursor: Number(raw.cursor) || 0,
    revealed: !!raw.revealed,
    input: String(raw.input ?? ''),
    chosenIndex: raw.chosenIndex == null ? null : Number(raw.chosenIndex),
    lastCorrect: !!raw.lastCorrect,
    answers: Array.isArray(raw.answers) ? raw.answers.filter(isPlainObject) : [],
    startedAt: Number(raw.startedAt) || 0,
    updatedAt: Number(raw.updatedAt) || Date.now(),
  }
}

function migrateProgress(raw) {
  const d = { version: PROGRESS_VERSION, rev: 0, updatedAt: 0, stats: {}, sessions: [], settings: { ...DEFAULT_SETTINGS }, ...raw }
  d.version = PROGRESS_VERSION
  d.rev = Number(d.rev) || 0
  d.updatedAt = Number(d.updatedAt) || 0
  const stats = {}
  if (isPlainObject(d.stats)) {
    for (const [k, v] of Object.entries(d.stats)) {
      if (isPlainObject(v)) stats[k] = normalizeStat({ ...v, wordId: v.wordId || k })
    }
  }
  d.stats = stats
  d.sessions = Array.isArray(d.sessions) ? d.sessions.filter(isPlainObject).map(normalizeSession).slice(0, 200) : []
  d.settings = { ...DEFAULT_SETTINGS, ...(isPlainObject(d.settings) ? d.settings : {}) }
  d.active = normalizeActive(d.active)
  d.plan = isPlainObject(d.plan) ? d.plan : null
  return d
}

/* -------------------------------------------------------------- 存储 --- */

const listsStore = createJsonStore({
  name: 'vocab-lists',
  file: () => path.join(vocabDir(), 'lists.json'),
  version: LISTS_VERSION,
  empty: () => ({ version: LISTS_VERSION, rev: 0, updatedAt: 0, lists: [] }),
  migrate: migrateLists,
  backupDir,
})

const progressStore = createJsonStore({
  name: 'vocab-progress',
  file: () => path.join(vocabDir(), 'progress.json'),
  version: PROGRESS_VERSION,
  empty: () => ({ version: PROGRESS_VERSION, rev: 0, updatedAt: 0, stats: {}, sessions: [], settings: { ...DEFAULT_SETTINGS }, active: null, plan: null }),
  migrate: migrateProgress,
  backupDir,
})

export function readLists() {
  return listsStore.read().lists
}
export function readProgress() {
  return progressStore.read()
}

/** 词单 + 学情一次给全（前端启动时用；智能体也可用来掌握全局） */
export function snapshot() {
  const listsData = listsStore.read()
  const progressData = progressStore.read()
  return {
    ok: true,
    lists: listsData.lists,
    listsRev: listsData.rev,
    listsUpdatedAt: listsData.updatedAt,
    progress: { stats: progressData.stats, sessions: progressData.sessions, settings: progressData.settings, active: progressData.active ?? null, plan: progressData.plan ?? null },
    progressRev: progressData.rev,
    progressUpdatedAt: progressData.updatedAt,
    files: { lists: listsStore.summary(), progress: progressStore.summary() },
  }
}

/** 整体替换词单（前端写回用）；返回 conflict 信息便于提示「智能体也改过」 */
export function writeLists(lists, opts = {}) {
  const clean = (Array.isArray(lists) ? lists : []).filter(isPlainObject).map(normalizeList)
  const { data, conflict, prevRev } = listsStore.write({ lists: clean }, { ...opts, source: opts.source ?? 'web' })
  return { ok: true, lists: data.lists, rev: data.rev, updatedAt: data.updatedAt, conflict, prevRev }
}

/** 整体替换学情（前端写回用） */
export function writeProgress(progress, opts = {}) {
  const body = {
    stats: isPlainObject(progress?.stats) ? progress.stats : {},
    sessions: Array.isArray(progress?.sessions) ? progress.sessions : [],
    settings: isPlainObject(progress?.settings) ? progress.settings : { ...DEFAULT_SETTINGS },
    active: normalizeActive(progress?.active),
    plan: isPlainObject(progress?.plan) ? progress.plan : null,
  }
  const { data, conflict, prevRev } = progressStore.write(body, { ...opts, source: opts.source ?? 'web' })
  return {
    ok: true,
    progress: { stats: data.stats, sessions: data.sessions, settings: data.settings, active: data.active ?? null, plan: data.plan ?? null },
    rev: data.rev,
    updatedAt: data.updatedAt,
    conflict,
    prevRev,
  }
}

/* ---------------------------------------------------------- 文本解析 --- */

/**
 * 把粘贴文本解析成词条 —— 与前端 src/features/vocab/parser.ts 同一套书写规则。
 *
 * 支持的行格式（可混用）：
 *   1. conceal
 *   2. conceal 隐藏
 *   3. conceal\t隐藏，隐瞒
 *   4. conceal | 隐藏 | 例句
 *   5. conceal /kənˈsiːl/ v. 隐藏，隐瞒
 *   6. 1. conceal  - v. 隐藏 ; 隐瞒
 *   7. conceal,隐藏,She could not conceal her disappointment.
 *
 * 说明：两份实现（TS / JS）不可避免要各写一份 —— 前端跑在浏览器里，边车跑在 Node 里，
 * 项目坚持「服务端零第三方依赖、不共享构建产物」。改动任一份时请对照另一份同步。
 */
function stripLeadingNumber(line) {
  return line.replace(/^\s*[（(]?\d{1,3}[）).、,:：]?\s*/, '')
}

const POS_RE =
  /(^|[\s,;|、])[（(]?((?:n|v|vt|vi|adj|adv|prep|conj|pron|art|num|int|interj|aux|abbr|phr|modal)\.(?:\s*&\s*(?:n|v|adj|adv|prep|conj|pron)\.?)?)[）)]?/i

function extractPhonetic(line) {
  const m = line.match(/[/\[]([^/\][]+)[/\]]/)
  if (!m) return { rest: line }
  const idx = m.index ?? 0
  return { rest: (line.slice(0, idx) + ' ' + line.slice(idx + m[0].length)).trim(), phonetic: m[1].trim() }
}

function extractPos(line) {
  const m = line.match(POS_RE)
  if (!m) return { rest: line }
  const pos = m[2].replace(/\s+/g, ' ').trim()
  const idx = m.index ?? 0
  return { rest: (line.slice(0, idx) + ' ' + line.slice(idx + m[0].length)).trim(), pos }
}

/**
 * 不带点的词性只能从「词尾」识别，且只认不容易和单词本身混淆的几个缩写
 * （art / num / int 这类本身可能是词条，不在此列）。
 */
const DOTLESS_POS = ['adj', 'adv', 'prep', 'conj', 'pron', 'interj', 'abbr', 'modal', 'phr']
const DOTLESS_POS_RE = new RegExp(`\\s+(${DOTLESS_POS.join('|')})\\.?$`, 'i')

function hasChinese(s) {
  return /[\u4e00-\u9fff]/.test(s)
}

export function parseWordText(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  const words = []
  let skipped = 0
  let bare = 0
  const seen = new Set()

  for (const rawLine of lines) {
    let line = stripLeadingNumber(rawLine)
    // 注释行：`#` / `//` 开头的整行都跳过。
    // 不能只认「单独一个 # 的那一行」—— 那样 `# 注释行` 会被当成词条吃进去（term 变成 `# 注释行`）。
    // 词条不可能以 # 或 // 开头，所以这个判断是安全的。
    if (/^(#{1,6}|\/\/)\s*/.test(line)) continue
    // markdown 列表符号：`- `、`* `、`• ` 去掉前缀（智能体常按列表格式给词）
    line = line.replace(/^\s*(?:[-*•])\s+/, '').trim()
    if (!line) continue

    const ph = extractPhonetic(line)
    line = ph.rest
    const po = extractPos(line)
    line = po.rest
    let finalPos = po.pos

    let term = ''
    let meaning = ''
    let example = ''

    if (line.includes('|')) {
      const parts = line.split('|').map((p) => p.trim()).filter(Boolean)
      term = parts[0] ?? ''
      meaning = parts[1] ?? ''
      example = parts[2] ?? ''
    } else if (line.includes('\t')) {
      const parts = line.split('\t').map((p) => p.trim()).filter(Boolean)
      term = parts[0] ?? ''
      meaning = parts[1] ?? ''
      example = parts[2] ?? ''
    } else if (hasChinese(line) && /[A-Za-z]/.test(line)) {
      // 有中文：以第一个中文字符为界切分 —— 这样才认得出带空格的短语（appeal to sb 吸引某人）
      const cut = line.search(/[\u4e00-\u9fff]/)
      term = line.slice(0, cut).trim()
      meaning = line.slice(cut).trim()
    } else {
      // 整行没中文：可能只有单词、也可能是英文解释。有显式分隔符才切，否则整行当词条。
      const sep = line.match(/^(.+?)\s*(?:[—–]{1,2}|::|[:：]|\s-\s)\s*(.+)$/)
      if (sep) {
        term = sep[1].trim()
        meaning = sep[2].trim()
      } else {
        term = line.trim()
      }
    }

    term = term.replace(/[\s,;，；、|—–\-]+$/, '').trim()
    term = term.replace(/[.。]+$/, '').trim()

    // 释义尾巴上挂着一整句英文 → 剥出来当例句
    if (!example && meaning && hasChinese(meaning)) {
      const tail = meaning.match(/\s+([A-Z][A-Za-z'’,.\- ]{14,}[.!?])\s*$/)
      if (tail && hasChinese(meaning.slice(0, tail.index))) {
        example = tail[1].trim()
        meaning = meaning.slice(0, tail.index).trim()
      }
    }

    meaning = meaning.replace(/^[\s:：\-—–,;，；]+/, '').trim()
    // 一行里写了多个词性（`fair adj. 公平的 n. 集市`）时，POS_RE 只吃掉第一个，
    // 剩下的词性缩写会留在释义开头 —— 这里循环剥掉，免得释义里混着 `n. `
    for (;;) {
      const head = meaning.match(/^\(?(?:n|v|vt|vi|adj|adv|prep|conj|pron|art|num|int|interj|aux|abbr|phr|modal)\.\s*/i)
      if (!head) break
      meaning = meaning.slice(head[0].length).trim()
    }

    // 兜底：`distinguished adj` 这种词尾没带点的词性，收尾时再剥一次
    // （顺序与前端 parser.ts 一致：先剥词性，再判有效性）
    if (!finalPos) {
      const tail = term.match(DOTLESS_POS_RE)
      if (tail) {
        finalPos = tail[1]
        term = term.slice(0, tail.index).trim()
      }
    }

    if (!term || !/[A-Za-z\u4e00-\u9fff]/.test(term)) {
      skipped += 1
      continue
    }

    const key = term.toLowerCase()
    const existing = words.find((w) => w.term.toLowerCase() === key)
    if (existing) {
      if (example) {
        const k = example.toLowerCase().replace(/\s+/g, ' ')
        const has = (existing.examples || []).some((ex) => String(ex.en).toLowerCase().replace(/\s+/g, ' ') === k)
        if (!has) {
          existing.examples = [...(existing.examples || []), { en: example, source: 'import' }]
          if (!existing.example) existing.example = example
        }
      }
      skipped += 1
      continue
    }
    seen.add(key)
    if (!meaning) bare += 1

    words.push(
      normalizeWord({
        term,
        phonetic: ph.phonetic,
        pos: finalPos,
        meaning: meaning || '',
        example: example || undefined,
        examples: example ? [{ en: example, source: 'import' }] : [],
      }),
    )
  }

  return { words, stats: { parsed: words.length, skipped, bare } }
}

/* ------------------------------------------------------------ 词单操作 --- */

export function listById(id) {
  return readLists().find((l) => l.id === id) ?? null
}

/** 按 id 或名称找词单（名称忽略大小写与首尾空格）—— 智能体通常只知道名字 */
export function findList(key) {
  if (!key) return null
  const lists = readLists()
  const k = String(key).trim()
  return lists.find((l) => l.id === k) ?? lists.find((l) => l.name.toLowerCase() === k.toLowerCase()) ?? null
}

export function createList({ name, description = '', source = 'user', text, words, baseRev } = {}) {
  const empty = normalizeList({
    id: newId('list'),
    name: name || `导入词单 ${new Date().toLocaleDateString('zh-CN')}`,
    description,
    source,
    words: [],
  })
  const lists = [empty, ...readLists()]
  const r0 = writeLists(lists, { baseRev, source: 'http' })
  if ((Array.isArray(words) && words.length) || (text && String(text).trim())) {
    const added = addWords({ listId: empty.id, text, words, source, baseRev: r0.rev, createIfMissing: false })
    const list = findList(empty.id)
    return {
      ok: true,
      list,
      added: added.added,
      skipped: (added.skippedDuplicate || 0) + (added.skippedGlobal || 0) + (added.skippedInvalid || 0),
      skippedDuplicate: added.skippedDuplicate,
      skippedGlobal: added.skippedGlobal,
      enriched: added.enriched,
      rev: added.rev,
      lists: added.ok ? undefined : r0.lists,
    }
  }
  return { ok: true, list: empty, added: 0, skipped: 0, rev: r0.rev, lists: r0.lists }
}

export function updateList({ id, name, description, words, text, mode, baseRev } = {}) {
  const lists = readLists()
  const idx = lists.findIndex((l) => l.id === id || l.name === id)
  if (idx === -1) return { ok: false, error: `没有找到词单：${id}` }
  const cur = lists[idx]

  if (typeof name === 'string' && name.trim()) cur.name = name.trim()
  if (typeof description === 'string') cur.description = description

  if (Array.isArray(words) || typeof text === 'string') {
    const parsed = Array.isArray(words)
      ? { words: words.filter(isPlainObject).map(normalizeWord), stats: { parsed: words.length, skipped: 0, bare: 0 } }
      : parseWordText(text)
    cur.words = mode === 'replace' ? parsed.words : cur.words.concat(parsed.words)
  }
  cur.updatedAt = Date.now()
  const r = writeLists(lists, { baseRev, source: 'http' })
  return { ok: true, list: cur, rev: r.rev, lists: r.lists }
}

export function removeList(id, { baseRev } = {}) {
  const lists = readLists()
  const target = lists.find((l) => l.id === id || l.name === id)
  if (!target) return { ok: false, error: `没有找到词单：${id}` }
  if (target.source === 'builtin') return { ok: false, error: '内置词单不能删除（可以复制一份再改）' }
  const r = writeLists(
    lists.filter((l) => l.id !== target.id),
    { baseRev, source: 'http' },
  )
  return { ok: true, removed: target.id, name: target.name, rev: r.rev, lists: r.lists }
}

/**
 * 给词单加词 —— 智能体的主入口。
 * listId / listName 两者都可省略：省略时若恰好只有一个词单就用它，否则新建一个（默认名「未分类」）。
 * 支持 `text`（粘贴文本，服务端解析）或 `words`（结构化数组，字段同 VocabWord）。
 */
export function addWords({ listId, listName, text, words, mode = 'append', source = 'agent', baseRev, createIfMissing = true } = {}) {
  const parsed = Array.isArray(words) && words.length
    ? { words: words.filter(isPlainObject).map(normalizeWord), stats: { parsed: words.length, skipped: 0, bare: 0 } }
    : parseWordText(text ?? '')

  if (!parsed.words.length) {
    return { ok: false, error: '没有解析出任何词条（检查 text 是否为空，或 words 是否为数组）' }
  }
  const by = ['agent', 'import', 'user', 'web', 'builtin'].includes(source) ? source : 'agent'
  const now = Date.now()
  parsed.words = parsed.words.map((w) => ({ ...w, addedAt: w.addedAt || now, addedBy: w.addedBy || by }))

  const lists = readLists()
  let target = null
  if (listId || listName) {
    const key = listId || listName
    target = lists.find((l) => l.id === key) ?? lists.find((l) => l.name.toLowerCase() === String(key).toLowerCase()) ?? null
  } else if (lists.length === 1) {
    target = lists[0]
  }

  let created = false
  if (!target) {
    if (!createIfMissing) return { ok: false, error: `没有找到词单：${listId || listName || '(未指定，且当前有多个词单)'}` }
    target = normalizeList({
      id: newId('list'),
      name: listName || listId || '未分类',
      description: '智能体录入',
      source: 'import',
      words: [],
    })
    lists.unshift(target)
    created = true
  }

  let added = 0
  let skippedDup = 0
  let skippedGlobal = 0
  let enriched = 0
  const fresh = []
  if (mode === 'replace') {
    const existing = new Set()
    const kept = []
    for (const w of parsed.words) {
      const k = termKey(w.term)
      if (!k || existing.has(k)) {
        skippedDup += 1
        continue
      }
      const hit = findByTerm(lists, w.term, target.id)
      if (hit) {
        const e = enrichWord(hit.word, w)
        hit.word = Object.assign(hit.word, e.word)
        enriched += e.n
        skippedGlobal += 1
        continue
      }
      existing.add(k)
      kept.push(w)
    }
    target.words = kept
    added = kept.length
  } else {
    const existing = new Set(target.words.map((w) => termKey(w.term)))
    for (const w of parsed.words) {
      const k = termKey(w.term)
      if (!k) continue
      if (existing.has(k)) {
        const cur = target.words.find((x) => termKey(x.term) === k)
        if (cur) {
          const e = enrichWord(cur, w)
          Object.assign(cur, e.word)
          enriched += e.n
        }
        skippedDup += 1
        continue
      }
      const hit = findByTerm(lists, w.term, target.id)
      if (hit) {
        const e = enrichWord(hit.word, w)
        Object.assign(hit.word, e.word)
        enriched += e.n
        skippedGlobal += 1
        continue
      }
      existing.add(k)
      fresh.push(w)
    }
    target.words = target.words.concat(fresh)
    added = fresh.length
  }
  target.updatedAt = Date.now()

  const r = writeLists(lists, { baseRev, source })
  return {
    ok: true,
    listId: target.id,
    listName: target.name,
    created,
    added,
    skippedDuplicate: skippedDup,
    skippedGlobal,
    enriched,
    skippedInvalid: parsed.stats.skipped,
    bare: parsed.stats.bare,
    totalWords: target.words.length,
    rev: r.rev,
    conflict: r.conflict,
    words: mode === 'replace' ? target.words.slice(0, added) : fresh,
  }
}

export function removeWords({ listId, wordIds, wordId, baseRev } = {}) {
  const lists = readLists()
  const target = lists.find((l) => l.id === listId || l.name === listId)
  if (!target) return { ok: false, error: `没有找到词单：${listId}` }
  const ids = new Set([...(Array.isArray(wordIds) ? wordIds : []), ...(wordId ? [wordId] : [])].map(String))
  const terms = new Set([...ids].filter((x) => /[A-Za-z]/.test(x)).map((x) => x.toLowerCase()))
  const before = target.words.length
  target.words = target.words.filter((w) => !ids.has(w.id) && !terms.has(w.term.toLowerCase()))
  target.updatedAt = Date.now()
  const r = writeLists(lists, { baseRev, source: 'http' })
  return { ok: true, listId: target.id, removed: before - target.words.length, totalWords: target.words.length, rev: r.rev }
}

/** 查词：可按词单、关键词（词或释义）过滤 */
export function searchWords({ listId, q, limit = 200 } = {}) {
  let lists = readLists()
  if (listId) lists = lists.filter((l) => l.id === listId || l.name === listId)
  const kw = String(q ?? '').trim().toLowerCase()
  const cap = Number(limit) > 0 ? Number(limit) : 0
  const out = []
  for (const l of lists) {
    for (const w of l.words) {
      if (kw && !(w.term.toLowerCase().includes(kw) || w.meaning.toLowerCase().includes(kw))) continue
      out.push({ ...w, listId: l.id, listName: l.name })
      if (cap && out.length >= cap) break
    }
    if (cap && out.length >= cap) break
  }
  return { ok: true, count: out.length, words: out }
}

export function listSummaries() {
  const lists = readLists()
  return {
    ok: true,
    count: lists.length,
    lists: lists.map((l) => ({
      id: l.id,
      name: l.name,
      description: l.description,
      source: l.source,
      words: l.words.length,
      updatedAt: l.updatedAt,
      sample: l.words.slice(0, 3).map((w) => w.term),
    })),
  }
}

/** 导出为「term\t释义」文本，便于智能体一次性读走全表 */
export function exportListText(listId) {
  const list = findList(listId)
  if (!list) return { ok: false, error: `没有找到词单：${listId}` }
  const text = list.words
    .map((w) => {
      const head = [w.term, w.phonetic ? `/${w.phonetic}/` : '', w.pos ?? ''].filter(Boolean).join(' ')
      return `${head}\t${w.meaning}`
    })
    .join('\n')
  return { ok: true, listId: list.id, name: list.name, count: list.words.length, text }
}

/* -------------------------------------------------------------- 学情 --- */

/** 学情汇总：智能体用来判断「哪些词该复习了」 */
export function progressSummary() {
  const p = progressStore.read()
  const lists = readLists()
  const wordById = new Map()
  for (const l of lists) for (const w of l.words) wordById.set(w.id, { ...w, listId: l.id, listName: l.name })

  const stats = Object.values(p.stats)
  const answered = stats.reduce((s, x) => s + x.right + x.wrong, 0)
  const correct = stats.reduce((s, x) => s + x.right, 0)
  const master = Number(p.settings.masterStreak) || 2

  const wrongRanked = stats
    .filter((s) => s.wrong > 0)
    .sort((a, b) => b.wrong - b.right - (a.wrong - a.right) || (b.lastWrongAt ?? 0) - (a.lastWrongAt ?? 0))

  const totalWords = lists.reduce((s, l) => s + l.words.length, 0)
  const due = dueQueue({ limit: 0 }).counts
  return {
    ok: true,
    lists: lists.length,
    totalWords,
    uniqueTerms: due.unique,
    mastered: stats.filter((s) => isMastered(s, master)).length,
    masterStreak: master,
    answered,
    correct,
    accuracy: answered ? Math.round((correct / answered) * 100) : 0,
    sessions: p.sessions.length,
    lastSessionAt: p.sessions[0]?.finishedAt ?? null,
    due,
    /** 还没做过题的词（智能体可以据此安排今天的复习范围） */
    untouched: due.new,
    /** 错题优先：错得多、连对为 0 的排前面 */
    wrongTop: wrongRanked.slice(0, 20).map((s) => ({
      wordId: s.wordId,
      term: s.term,
      meaning: wordById.get(s.wordId)?.meaning ?? '',
      listName: wordById.get(s.wordId)?.listName ?? '',
      right: s.right,
      wrong: s.wrong,
      streak: s.streak,
      interval: viewStat(s).interval,
      dueAt: viewStat(s).dueAt || null,
      lastSeen: s.lastSeen || null,
    })),
  }
}

function uniqueWordIndex() {
  const lists = readLists()
  const p = progressStore.read()
  const byTerm = new Map()
  for (const l of lists) {
    for (const w of l.words) {
      const k = termKey(w.term)
      if (!k) continue
      const stat = viewStat(p.stats[w.id], w.id, w.term)
      const prev = byTerm.get(k)
      if (!prev) {
        byTerm.set(k, { term: w.term, wordId: w.id, listId: l.id, listName: l.name, word: w, stat, copies: 1 })
      } else {
        prev.copies += 1
        prev.stat = mergeStats(prev.stat, stat)
      }
    }
  }
  return { lists, progress: p, byTerm }
}

/** 今日该复习的词（逾期 + 学习中），再补新词。limit=0 只返回计数。 */
export function dueQueue({ limit = 20, includeNew = true } = {}) {
  const now = Date.now()
  const { byTerm } = uniqueWordIndex()
  const counts = { overdue: 0, learning: 0, new: 0, upcoming: 0, mature: 0, unique: byTerm.size, dueToday: 0 }
  const items = []
  for (const row of byTerm.values()) {
    const bucket = dueBucket(row.stat, now)
    counts[bucket] += 1
    items.push({ ...row, bucket, dueLabel: fmtDue(row.stat, now), rank: dueRank(row.stat, now) })
  }
  counts.dueToday = counts.overdue + counts.learning
  items.sort((a, b) => a.rank - b.rank)
  const queue = items.filter((x) => x.bucket === 'overdue' || x.bucket === 'learning' || (includeNew && x.bucket === 'new'))
  const cap = Number(limit) > 0 ? Number(limit) : 0
  const sliced = cap ? queue.slice(0, cap) : queue
  return {
    ok: true,
    counts,
    count: sliced.length,
    words: sliced.map((x) => ({
      term: x.term,
      meaning: x.word.meaning,
      phonetic: x.word.phonetic,
      pos: x.word.pos,
      listName: x.listName,
      listId: x.listId,
      wordId: x.wordId,
      copies: x.copies,
      bucket: x.bucket,
      due: x.dueLabel,
      interval: x.stat.interval,
      ease: x.stat.ease,
      streak: x.stat.streak,
      right: x.stat.right,
      wrong: x.stat.wrong,
      dueAt: x.stat.dueAt || null,
    })),
  }
}

/**
 * 给智能体的复习建议：今天练什么、先别录哪些重复词、哪些词缺释义。
 * 这是「智能体喂词 → 工作站考察」闭环的读入口。
 */
export function reviewAdvice({ limit = 15 } = {}) {
  const now = Date.now()
  const due = dueQueue({ limit, includeNew: true })
  const { byTerm, lists } = uniqueWordIndex()
  const dups = []
  const bare = []
  for (const l of lists) {
    const seen = new Set()
    for (const w of l.words) {
      const k = termKey(w.term)
      if (!w.meaning || w.meaning === '（未填写释义）') bare.push({ term: w.term, listName: l.name })
      if (seen.has(k)) dups.push({ term: w.term, listName: l.name, reason: '本词单重复' })
      seen.add(k)
    }
  }
  for (const row of byTerm.values()) {
    if (row.copies > 1) dups.push({ term: row.term, listName: row.listName, reason: `全库 ${row.copies} 份` })
  }

  const dueToday = due.counts.dueToday
  const recNew = Math.min(10, due.counts.new)
  const recDue = Math.min(limit, dueToday || recNew)
  const lines = [
    `今日到期 ${dueToday}（逾期 ${due.counts.overdue} + 学习中 ${due.counts.learning}），新词 ${due.counts.new}，稳固 ${due.counts.mature}；全库去重后 ${due.counts.unique} 个词。`,
    dueToday > 0
      ? `建议今天先把 ${recDue} 个到期词过一遍（到期优先），新词最多再加 ${recNew} 个，别把队列堆爆。`
      : `今天没有到期词。可以导入最多 ${Math.max(8, recNew)} 个新词，或把缺释义的词补全。`,
    dups.length ? `重复词 ${dups.length} 处，导入前请先 list_vocab_lists / get_vocab_words 查重；调用 add_vocab_words 会自动跳过全库已有词。` : '词库目前没有跨词单重复。',
    bare.length ? `有 ${bare.length} 个词缺释义，只能做拼写，建议补 meaning。` : '',
  ].filter(Boolean)

  return {
    ok: true,
    advice: lines.join('\n'),
    recommend: { due: recDue, newWords: recNew, skipImportIfDueOver: 40 },
    due: due.counts,
    queue: due.words,
    duplicates: dups.slice(0, 20),
    missingMeaning: bare.slice(0, 20),
    generatedAt: now,
  }
}

/** 清掉跨词单重复词：保留最早那份，学情合并到保留项上。dryRun 只报告不改。 */
export function dedupeLists({ dryRun = true, baseRev } = {}) {
  const lists = readLists()
  const p = progressStore.read()
  const first = new Map()
  const report = []
  let removed = 0
  for (const l of lists) {
    const kept = []
    const seen = new Set()
    for (const w of l.words) {
      const k = termKey(w.term)
      if (!k) continue
      if (seen.has(k)) {
        report.push({ term: w.term, from: l.name, action: '本词单重复，删除' })
        removed += 1
        continue
      }
      const hit = first.get(k)
      if (hit && hit.listId !== l.id) {
        const e = enrichWord(hit.word, w)
        Object.assign(hit.word, e.word)
        const a = p.stats[hit.wordId]
        const b = p.stats[w.id]
        if (a || b) p.stats[hit.wordId] = mergeStats(a, b)
        report.push({ term: w.term, from: l.name, keepIn: hit.listName, action: '全库重复，合并到已有词' })
        removed += 1
        continue
      }
      seen.add(k)
      if (!hit) first.set(k, { listId: l.id, listName: l.name, word: w, wordId: w.id })
      kept.push(w)
    }
    l.words = kept
    l.updatedAt = Date.now()
  }
  if (dryRun) return { ok: true, dryRun: true, removed, report }
  const lr = writeLists(lists, { baseRev, source: 'agent' })
  const pr = writeProgress({ stats: p.stats, sessions: p.sessions, settings: p.settings }, { source: 'agent' })
  return { ok: true, dryRun: false, removed, report, listsRev: lr.rev, progressRev: pr.rev }
}

/** 练习历史：给智能体溯源「哪天练了什么、答了什么」 */
export function listSessions({ limit = 10, includeAnswers = false } = {}) {
  const p = progressStore.read()
  const cap = Math.max(1, Math.min(Number(limit) || 10, 50))
  const items = p.sessions.slice(0, cap).map((s) => {
    const row = {
      id: s.id,
      listName: s.listName,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      status: s.status,
      order: s.order,
      planned: s.planned,
      total: s.total,
      correct: s.correct,
      types: s.types,
      wrong: (s.wrong || []).map((w) => w.term),
    }
    if (includeAnswers) row.answers = s.answers || []
    return row
  })
  return {
    ok: true,
    count: items.length,
    active: p.active
      ? {
          sessionId: p.active.sessionId,
          listName: p.active.listName,
          answered: (p.active.answers || []).length,
          planned: (p.active.questions || []).length,
          updatedAt: p.active.updatedAt,
        }
      : null,
    sessions: items,
  }
}

/* ------------------------------------------------------------ 发音 --- */

/**
 * 英文单词发音走有道词典公开音频（免密钥）：
 *   https://dict.youdao.com/dictvoice?audio=WORD&type=2
 * type=1 英音，type=2 美音。浏览器直连会被 CORS 挡住，所以边车代拉，
 * 落盘到 data/vocab/audio/ 后下次直接读缓存。外网挂了才让前端退回系统朗读。
 */
const YOUDAO_VOICE = 'https://dict.youdao.com/dictvoice'
const ACCENTS = { us: 2, uk: 1 }
const AUDIO_MAX_BYTES = 512 * 1024
const AUDIO_CACHE_MAX = 400

function audioDir() {
  return path.join(vocabDir(), 'audio')
}

export function speakableTerm(term) {
  return String(term ?? '')
    .replace(/\b(sb|sth|oneself)\b/gi, '')
    .replace(/[()（）[\]【】]/g, ' ')
    .replace(/[/|·•]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function audioCacheKey(term, accent) {
  const spoken = speakableTerm(term)
  const hash = crypto.createHash('sha1').update(`${accent}:${spoken.toLowerCase()}`).digest('hex').slice(0, 16)
  return { spoken, file: path.join(audioDir(), `${accent}-${hash}.mp3`) }
}

function pruneAudioCache() {
  const dir = audioDir()
  if (!fs.existsSync(dir)) return
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.mp3'))
    .map((name) => {
      const p = path.join(dir, name)
      try {
        return { path: p, mtime: fs.statSync(p).mtimeMs }
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.mtime - b.mtime)
  const extra = files.length - AUDIO_CACHE_MAX
  if (extra <= 0) return
  for (const f of files.slice(0, extra)) {
    try {
      fs.unlinkSync(f.path)
    } catch {
      /* ignore */
    }
  }
}

function looksLikeMp3(buf) {
  if (!buf || buf.length < 32) return false
  // ID3 头，或 MPEG 帧同步字 0xFFEx
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true
  return false
}

/**
 * 拉一份单词发音。命中缓存就直接读盘；否则去有道拉，成功才落盘。
 * 调用方负责把 buffer 写进 HTTP 响应（或把 error 转成 JSON）。
 */
export async function fetchWordAudio(term, accent = 'us') {
  const acc = ACCENTS[accent] ? accent : 'us'
  const { spoken, file } = audioCacheKey(term, acc)
  if (!spoken || !/[A-Za-z]/.test(spoken) || spoken.length > 80) {
    return { ok: false, error: '没有可朗读的英文' }
  }

  if (fs.existsSync(file)) {
    try {
      const buffer = fs.readFileSync(file)
      if (looksLikeMp3(buffer)) return { ok: true, buffer, cached: true, spoken, accent: acc }
    } catch {
      /* 缓存坏了就重新拉 */
    }
  }

  const url = `${YOUDAO_VOICE}?audio=${encodeURIComponent(spoken)}&type=${ACCENTS[acc]}`
  const r = await requestBytes(url, {
    timeout: 8000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) WorkstationVocab/0.1' },
  })
  if (!r.ok || !looksLikeMp3(r.buffer) || r.buffer.length > AUDIO_MAX_BYTES) {
    return { ok: false, error: r.error || `发音源返回异常（HTTP ${r.status}）`, spoken }
  }
  try {
    fs.mkdirSync(audioDir(), { recursive: true })
    fs.writeFileSync(file, r.buffer)
    pruneAudioCache()
  } catch {
    /* 缓存写失败不影响本次播放 */
  }
  return { ok: true, buffer: r.buffer, cached: false, spoken, accent: acc }
}

export const PATHS = {
  vocabDir,
  listsFile: () => path.join(vocabDir(), 'lists.json'),
  progressFile: () => path.join(vocabDir(), 'progress.json'),
  backupDir,
  audioDir,
  dataDir,
}
