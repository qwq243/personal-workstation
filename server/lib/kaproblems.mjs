/**
 * 考研题库池 —— 把「试题册 / 解析册」两份 markdown **按章拆成结构化题目**。
 *
 * 为什么需要它：要能「推荐同类题目」和「溯源」。两者都要求**按章检索**题库、并知道每道题的
 * 原文落在哪个文件的哪一章（`ref`）。那两份 md 多是 OCR / 转换出来的，结构稳定但不是标准格式，
 * 所以在**读取时按标题/题号正则切**，不预烤成中间数据 —— 这样题册换版本（重新导入、换文件）后
 * 这里不用跟着重建。
 *
 * **题干与解析都不随仓库分发**：自己买书后按本文件的解析规则（也写在 `docs/zuotiben-import.md`）
 * 把两份 md 做成同一种结构，再把路径填进配置：
 *   zuotiben.pool = { dir: '', problems: '', solutions: '' }
 * 没配（或指到的文件不在）时池子就是空的 —— `list_problem_pool` 直接说「没配题库目录」，
 * 不猜路径、不去翻别人机器上的目录。
 *
 * 认的结构（这是契约，别只改这边不改文档）：
 *   试题册：章标题 `# 第 3 章 <章标题>`，题目 `1. <题干>……`，选项 `(A) <选项>`
 *   解析册：章标题 `## 第 3 章 <章标题>`，题目 `## 1.【答案】 (A)`，下面接 `【解析】……`
 *
 * 两本都可能分成「基础篇 / 强化篇」两段（章号会从头再来一次），所以按「章号第一次出现」归到基础篇、
 * 重复出现的那一段归强化篇。**目前只认基础篇**（先做基础段就够用），
 * 强化篇原文切分同理，等真要用时再放开 —— 先别把用不上的解析成本摊上。
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../config.mjs'
// 填空横线规范化（材料里常写作 `\_\_\_\_`，直接进前端会显示成反斜杠）—— 与做题本入库同一套规则
import { normalizeBlanks } from './zuotiben.mjs'

/** 只认这一段（见文件头：强化篇等要用时再放开） */
const PART = '基础篇'

/** 读配置：不缓存 —— 改完配置不必重启边车 */
function cfg() {
  const p = loadConfig()?.zuotiben?.pool ?? {}
  return {
    dir: String(p.dir ?? '').trim(),
    problems: String(p.problems ?? '').trim(),
    solutions: String(p.solutions ?? '').trim(),
  }
}

/** 三样都填了才算配好：只填目录的话，不知道该读哪两份文件 */
function ready(c = cfg()) {
  return !!(c.dir && c.problems && c.solutions)
}

/** 题册标识（进 `ref` 用）：取试题册文件名，形如「某题册27版」 */
function bookName(c) {
  return path.basename(c.problems).replace(/\.md$/i, '') || '题库'
}

/** `ref.files` 的前缀：题库目录名（回查原文时先找这个目录） */
function dirLabel(c) {
  return path.basename(String(c.dir).replace(/[\\/]+$/, '')) || c.dir
}

/** 章标题：`# 第 3 章 <章标题>`（# 数量不定，空格不定） */
const CH_HEAD = /^#{0,3}\s*第\s*(\d{1,2})\s*章\s*(.*)$/
/**
 * 目录行长得跟章标题一样（`第1章 <章标题> …… 5`），必须先排掉 ——
 * 不排的话「第1章」的第一次出现会被算成目录那一行，真正的基础篇正文全被判成强化篇，
 * 于是整本一道题都解析不出来（2026-09-27 踩过）。
 */
const TOC_LINE = /…|\.{3,}/
/**
 * 解析册的题块起点。**四种标记都要认**（实测同一章里混着用）：
 *   `## 1.【答案】 (A)` —— 有答案，答案就在标记后面
 *   `4.【分析】<分析正文>…` —— 只有分析，没有单独给答案
 *   `8.【解析】<解析正文>……` / `9.【解析】 ……`
 * 只认 `【答案】` 的话，一章里会漏掉一半题（2026-09-27 踩过：一章 12 题只抓到 6 题）。
 */
const SOL_HEAD = /^#{0,3}\s*(\d{1,3})\s*[.．]\s*【(答案|解析|分析|证明|解)】\s*(.*)$/
/** 试题册的题块起点：`1. <题干>……`（行首数字＋点，且不是选项行） */
const PRB_HEAD = /^(\d{1,3})\s*[.．]\s+(\S.*)$/
/** 选项行（可能一行里塞了多个选项） */
const OPT_SPLIT = /[（(]?\s*([A-D])\s*[)）．.]\s*/g

let cache = null

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/)
}

function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/**
 * 按章标题把一份文件切成 [{chapter, title, start, end, part}]。
 *
 * 两个坑，都踩过：
 *  1. **目录行**长得跟章标题一样（`第1章 <章标题> …… 5`），先排掉（见 TOC_LINE）。
 *  2. **书眉**：解析册每页页眉都印一遍章名，原样抽出来 —— 于是同一章号会连续出现好几次。
 *     不合并的话章会被从中间截断（实测某章只剩前 4 题，因为几十行后就撞到「书眉」当成了新章）。
 *     所以「章号与上一段相同」直接跳过。
 *
 *  篇的判定：章号**回落**（15 之后又出现 1）就是下一篇开始。比「出现过就换代」稳 ——
 *  解析册里可能有一章没有解析、章号不连续，按「出现过」判会把后面全判错。
 */
function splitChapters(lines) {
  const heads = []
  for (let i = 0; i < lines.length; i++) {
    if (TOC_LINE.test(lines[i])) continue
    const m = CH_HEAD.exec(lines[i])
    if (m) heads.push({ chapter: Number(m[1]), title: String(m[2] ?? '').trim(), line: i })
  }
  const merged = []
  for (const h of heads) {
    const last = merged[merged.length - 1]
    if (last && last.chapter === h.chapter) continue // 书眉，不是新章
    merged.push({ ...h })
  }
  let part = PART
  let maxCh = 0
  return merged.map((h, idx) => {
    if (h.chapter < maxCh && part === PART) part = '强化篇'
    maxCh = Math.max(maxCh, h.chapter)
    return { ...h, part, end: idx + 1 < merged.length ? merged[idx + 1].line : lines.length }
  })
}

/** 把一行里的多个选项拆开：`(C) x  (D) y` → ['(C) x', '(D) y'] */
function splitOptions(line) {
  const marks = [...line.matchAll(OPT_SPLIT)]
  if (marks.length <= 1) return [line.trim()]
  const out = []
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i].index
    const to = i + 1 < marks.length ? marks[i + 1].index : line.length
    out.push(line.slice(from, to).trim())
  }
  return out
}

/** 题干里内嵌的选项起点：`(A)`；要求后面还有 (B) 才算数，免得把正文里的 (A) 当选项 */
const INLINE_OPT = /[（(]\s*([A-D])\s*[)）]/g

/**
 * 选项经常跟题干挤在同一行（`……（　）. (A) … (B) …`），
 * 光按「行首是不是 (A)」切会漏掉这一半题。这里再从题干里补一刀。
 */
function splitInlineOptions(stem, options) {
  if (options.length) return { stem, options }
  const marks = [...stem.matchAll(INLINE_OPT)]
  if (marks.length < 2) return { stem, options }
  const first = marks[0].index
  const tail = stem.slice(first)
  const letters = new Set([...tail.matchAll(INLINE_OPT)].map((m) => m[1]))
  if (letters.size < 2) return { stem, options }
  return { stem: stem.slice(0, first).trim(), options: splitOptions(tail) }
}

/** 试题册的一章 → [{no, stem, options}] */
function parseProblems(lines, ch) {
  const body = lines.slice(ch.line + 1, ch.end)
  const out = []
  let cur = null
  for (const raw of body) {
    const line = raw.trim()
    if (!line) continue
    const h = PRB_HEAD.exec(line)
    // 选项行不可能是题块起点（`A. …` 不匹配 PRB_HEAD，因为 A 不是数字）
    if (h) {
      if (cur) out.push(cur)
      cur = { no: Number(h[1]), stemLines: [h[2]], optionLines: [] }
      continue
    }
    if (!cur) continue
    if (/^[（(]?\s*[A-D]\s*[)）．.]/.test(line)) {
      cur.optionLines.push(...splitOptions(line))
      continue
    }
    cur.stemLines.push(line)
  }
  if (cur) out.push(cur)
  return out.map((p) => {
    const stem = p.stemLines.join(' ').replace(/\s+/g, ' ').trim()
    const options = p.optionLines.map((o) => o.replace(/\s+/g, ' ').trim()).filter(Boolean)
    return { no: p.no, ...splitInlineOptions(stem, options) }
  })
}

/** 解析册的一章 → { [no]: {answer, solution} } */
function parseSolutions(lines, ch) {
  const body = lines.slice(ch.line + 1, ch.end)
  const out = {}
  let curNo = 0
  let cur = null
  for (const raw of body) {
    const line = raw.trim()
    const h = SOL_HEAD.exec(line)
    if (h) {
      if (cur) out[curNo] = cur
      curNo = Number(h[1])
      const mark = h[2]
      const tail = String(h[3] ?? '').replace(/\s+/g, ' ').trim()
      // 【答案】把标记后面的内容当答案；【解析】/【分析】则是正文开头，没有单独答案
      cur =
        mark === '答案'
          ? { answer: tail, solLines: [] }
          : { answer: '', solLines: tail ? [tail] : [] }
      continue
    }
    if (!cur) continue
    // 【解析】标记本身不在正文里，去掉
    cur.solLines.push(line.replace(/^【解析】\s*/, ''))
  }
  if (cur) out[curNo] = cur
  for (const [k, v] of Object.entries(out)) {
    out[k] = { answer: v.answer, solution: v.solLines.join('\n').replace(/\n{3,}/g, '\n\n').trim() }
  }
  return out
}

/**
 * 懒解析 + 缓存。
 *
 * 失效判据是「**配置 + 两份文件的 mtime**」：换了文件、改了配置都不用重启边车。
 * 没配 / 文件不在时回一个**空池子**（`chapters: []`），不抛异常 ——
 * 「为什么是空的」由 `poolHint()` 用同一套文案说给人和智能体听。
 */
function pool() {
  const c = cfg()
  if (!ready(c)) return { stamp: 'unconfigured', configured: false, chapters: [], book: '', missing: [] }

  const abs = {
    problems: path.join(c.dir, c.problems),
    solutions: path.join(c.dir, c.solutions),
  }
  const missing = Object.entries(abs)
    .filter(([, p]) => !fs.existsSync(p))
    .map(([k]) => k)
  const stamp = `${c.dir}|${c.problems}|${c.solutions}|${mtime(abs.problems)}|${mtime(abs.solutions)}`
  if (cache && cache.stamp === stamp) return cache

  if (missing.length) {
    cache = { stamp, configured: true, chapters: [], book: bookName(c), missing }
    return cache
  }

  const pLines = readLines(abs.problems)
  const sLines = readLines(abs.solutions)
  const pChs = splitChapters(pLines).filter((ch) => ch.part === PART)
  const sChs = splitChapters(sLines).filter((ch) => ch.part === PART)
  const book = bookName(c)
  const dir = dirLabel(c)

  const chapters = pChs.map((pc) => {
    const sc = sChs.find((x) => x.chapter === pc.chapter)
    const sols = sc ? parseSolutions(sLines, sc) : {}
    const items = parseProblems(pLines, pc).map((p) => {
      const s = sols[p.no] ?? { answer: '', solution: '' }
      // 先规范化再判 kind：`\_\_\_\_` 还原成 `____` 之后才认得出这是填空题
      const stem = normalizeBlanks(p.stem)
      return {
        id: `jc${pc.chapter}-${p.no}`,
        book,
        part: PART,
        chapter: pc.chapter,
        chapterTitle: pc.title,
        no: p.no,
        stem,
        options: p.options,
        kind: p.options.length >= 2 ? 'choice' : /_{3,}|＿{3,}/.test(stem) ? 'fill' : 'solve',
        answer: normalizeBlanks(s.answer),
        solution: normalizeBlanks(s.solution),
        ref: {
          book,
          part: PART,
          chapter: pc.chapter,
          chapterTitle: pc.title,
          no: p.no,
          label: `${book}·${PART} 第${pc.chapter}章 第${p.no}题`,
          // 回查原文用：题库目录/哪份文件#第几章（docs/zuotiben-import.md 有字段说明）
          files: [`${dir}/${c.problems}#第${pc.chapter}章`, ...(sc ? [`${dir}/${c.solutions}#第${pc.chapter}章`] : [])],
        },
        /** 解析是不是拿到了（有些题解析册里缺，得让调用方知道，别假装有） */
        hasSolution: !!s.solution,
      }
    })
    return { chapter: pc.chapter, title: pc.title, part: PART, count: items.length, items }
  })

  cache = { stamp, configured: true, chapters, book, missing: [] }
  return cache
}

/* ------------------------------------------------------------------ 对外 --- */

/**
 * 池子为什么是空的（一行话，配了且文件都在时回空串）。
 *
 * 单独一个函数是因为这句话要被三个地方说同一遍：MCP 工具、HTTP 口、页面 ——
 * 各写一份的话总有地方说成「没有题目」这种让人以为「题用完了」的话。
 */
export function poolHint() {
  const c = cfg()
  if (!ready(c)) return '没配题库目录（配置项 zuotiben.pool.dir / problems / solutions 三样都要填）'
  const p = pool()
  if (p.missing.length) {
    const names = p.missing.map((k) => (k === 'problems' ? c.problems : c.solutions))
    return `题库文件不存在：${names.join('、')}（相对 zuotiben.pool.dir = ${c.dir}）`
  }
  return ''
}

export function listChapters() {
  return pool().chapters.map((c) => ({
    chapter: c.chapter,
    title: c.title,
    part: c.part,
    count: c.count,
    withSolution: c.items.filter((i) => i.hasSolution).length,
  }))
}

export function getChapter(chapter) {
  return pool().chapters.find((c) => c.chapter === Number(chapter)) ?? null
}

/**
 * 按章 + 关键词挑候选题。
 *
 * @param {object} o
 * @param {number[]} [o.chapters]  限定章（不给＝全部基础篇）
 * @param {string[]} [o.keywords]  任一命中即可（题干或解析里出现）；不给＝不筛
 * @param {string[]} [o.exclude]   排除的题 id（已经做过的）
 * @param {boolean}  [o.needSolution=true] 只要解析齐全的（解析缺的推出去是坑）
 * @param {number}   [o.limit=10]
 */
export function search({ chapters, keywords = [], exclude = [], needSolution = true, limit = 10 } = {}) {
  const chs = pool().chapters.filter((c) => !chapters?.length || chapters.includes(c.chapter))
  const ex = new Set(exclude)
  const kws = keywords.map((k) => String(k).trim()).filter(Boolean)
  const out = []
  for (const c of chs) {
    for (const it of c.items) {
      if (ex.has(it.id)) continue
      if (needSolution && !it.hasSolution) continue
      if (kws.length) {
        const hay = `${it.stem}\n${it.solution}`
        if (!kws.some((k) => hay.includes(k))) continue
      }
      out.push(it)
      if (out.length >= limit) return out
    }
  }
  return out
}

export function info() {
  const c = cfg()
  const p = pool()
  return {
    ok: true,
    /** 配没配（题册路径三样齐全）—— 页面上要区分「没配」与「配了但解析出来是空的」 */
    configured: p.configured,
    book: p.book ?? '',
    chapters: p.chapters.length,
    problems: p.chapters.reduce((n, ch) => n + ch.count, 0),
    withSolution: p.chapters.reduce((n, ch) => n + ch.items.filter((i) => i.hasSolution).length, 0),
    source: ready(c) && !p.missing.length ? `${c.problems} + ${c.solutions}` : '',
    /** 已经配好、文件也在，却一道题都没解析出来时的下一步提示（格式对不上，见 docs/zuotiben-import.md） */
    empty:
      ready(c) && !p.missing.length && !p.chapters.length
        ? '题库文件读到了，但没解析出题 —— 对照 docs/zuotiben-import.md 检查章标题 / 题块写法'
        : '',
    /** 「为什么是空的」那句话（没配或文件不在时非空） */
    hint: poolHint(),
  }
}
