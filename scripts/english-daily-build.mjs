/**
 * 把 server/data/english/daily-sentence/parsed/*.md（MinerU 云端 OCR 产物）
 * 编译成句库 sentences.json，供边车 /api/english/daily 使用。
 *
 * 为什么编译而不是直接喂 markdown：展示与打卡要的是「一句一份」的结构化数据
 * （原句 / 词汇 / 结构划分 / 参考译文 / 语法重点），按天切好才能做指针与记录。
 * markdown 缓存在 parsed/ 里 —— 重跑本脚本不会重新上传 MinerU；
 * 只有新增 PDF 时才需要先跑 MinerU 批量解析。
 *
 * markdown 结构（用一段样例验证）：
 *   # 第 1 句 / Day01 / 【第 1 句】     ← 天的边界（按你材料里的写法改这一行的正则）
 *   <原句> 【<年份> Text <序号>】        ← 第一个 ## 之前
 *   ## 【你的翻译】                      ← 留白（纸上的练习框）
 *   ## 【词汇】    token n. 代币
 *   ## 【结构划分】①… ②…
 *   ## 【参考译文】
 *   ## 【语法重点】（部分天叫【翻译要点】/【翻译重点】，并入同一字段）
 *
 * OCR 的三个坑（2026-09-26 全踩过，都在这里兜）：
 *   1. 换行碎句会被 MinerU 误判成 `##` 小节标题（如「## 占优势的；显性的」其实是
 *      上一行 dominant 的释义续行）→ 只有**已知小节名**才算分节，其余 ## 行是正文；
 *   2. 词汇释义跨行断开 → 没解析出词头的行并回上一条词汇；
 *   3. 句尾试卷出处偶尔单独成行/成节（如「## 【<年份> Text<序号>】」）→ 按行扫出来回填 source。
 *
 * 用法：node scripts/english-daily-build.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIR = path.join(ROOT, 'server', 'data', 'english', 'daily-sentence')
const PARSED = path.join(DIR, 'parsed')
const OUT = path.join(DIR, 'sentences.json')

/** 水印与页眉噪音，如「公众号：××整理更新」这类，出现即丢 */
const NOISE_RE = /(公众号|扫码|关注我们|整理更新|更多资料|独家整理)/
const IMG_RE = /^!\[[^\]]*\]\([^)]*\)\s*$/
/** 真正的小节标题（其余 `##` 行都是 OCR 误判的正文续行，不当分节） */
const SECTION_NAMES = ['你的翻译', '词汇', '结构划分', '参考译文', '语法重点', '翻译要点', '翻译重点']
/** 语法重点的别名，统一并进 grammar 字段 */
const GRAMMAR_ALIASES = ['语法重点', '翻译要点', '翻译重点']
const SOURCE_LINE_RE = /^#{0,2}\s*【(20\d\d[^】]*)】\s*$/

function cleanLines(arr) {
  return arr.map((s) => s.trim()).filter((s) => s && !IMG_RE.test(s) && !NOISE_RE.test(s))
}

/** 按「# …DayNN」把一份 md 切成天；开头找不到天的部分（封面）丢弃 */
function splitDays(md) {
  const days = []
  let cur = null
  for (const line of md.split(/\r?\n/)) {
    const h = line.match(/^#\s+.*?Day\s*(\d+)/i)
    if (h) {
      cur = { day: Number(h[1]), lines: [] }
      days.push(cur)
      continue
    }
    if (cur) cur.lines.push(line)
  }
  return days
}

/** 第一个已知小节之前 = 原句区；其余 `##` 行一律当正文（剥掉误判的井号） */
function splitSections(lines) {
  const head = []
  const sections = new Map()
  let cur = null
  for (const raw of lines) {
    const h = raw.match(/^##\s*【(.+?)】\s*$/)
    if (h && SECTION_NAMES.includes(h[1].trim())) {
      cur = h[1].trim()
      if (!sections.has(cur)) sections.set(cur, [])
      continue
    }
    const line = raw.replace(/^#{1,6}\s+/, '')
    if (cur) sections.get(cur).push(line)
    else head.push(line)
  }
  return { head, sections }
}

/** 原句行拼成一段；句尾的试卷出处（【2005 Text 1】）拆成独立字段 */
function parseSentence(lines) {
  const text = cleanLines(lines).join(' ')
  const m = text.match(/^(.*?)\s*【([^【】]+)】\s*$/)
  return m ? { text: m[1].trim(), source: m[2].trim() } : { text, source: '' }
}

/**
 * 词汇行 → { term, pos, meaning }。
 * 带词性：`token n. 代币`；不带词性的短语：`as yet 到目前为止`；
 * 都匹配不上的是上一条释义的 OCR 续行 → 并回上一条（首条就保留原行）。
 */
function parseVocab(lines) {
  const out = []
  for (const line of cleanLines(lines)) {
    const withPos = line.match(
      /^([A-Za-z][A-Za-z'’\-. &]*?)\s+((?:(?:n|v|vt|vi|adj|adv|prep|conj|pron|art|aux|num|interj|phrase|pl)\.\s*(?:&\s*)?)+)([\s\S]+)$/,
    )
    const noPos = withPos ? null : line.match(/^([A-Za-z][A-Za-z'’\-. &]*?)\s*([\u4e00-\u9fff…].*)$/)
    if (withPos) out.push({ term: withPos[1].trim(), pos: withPos[2].trim(), meaning: withPos[3].trim() })
    else if (noPos) out.push({ term: noPos[1].trim(), pos: '', meaning: noPos[2].trim() })
    else if (out.length) out[out.length - 1].meaning += line
    else out.push({ term: '', pos: '', meaning: line })
  }
  return out
}

function dayCompleteness(item) {
  return (item.refTranslation ? 2 : 0) + (item.grammar.length ? 2 : 0) + Math.min(item.vocab.length, 8) + (item.source ? 1 : 0)
}

const files = fs.readdirSync(PARSED).filter((f) => f.toLowerCase().endsWith('.md')).sort()
if (!files.length) {
  console.error(`parsed/ 里没有 markdown，先跑 MinerU 批量解析（当前目录：${PARSED}）`)
  process.exit(1)
}

const days = new Map()
let blockCount = 0
const missing = { vocab: 0, structure: 0, refTranslation: 0, grammar: 0 }
for (const f of files) {
  const md = fs.readFileSync(path.join(PARSED, f), 'utf8')
  for (const d of splitDays(md)) {
    blockCount += 1
    // 散落的试卷出处标签行（正常在句尾；OCR 偶尔拆成独立行/独立节）先摘出来
    let tagSource = ''
    const body = []
    for (const line of d.lines) {
      const t = line.match(SOURCE_LINE_RE)
      if (t && !tagSource) {
        tagSource = t[1].trim()
        continue
      }
      body.push(line)
    }
    const { head, sections } = splitSections(body)
    const sent = parseSentence(head)
    if (!sent.text) {
      console.warn(`跳过 Day ${d.day}（${f}）：标题后没有原句`)
      continue
    }
    const grammarLines = GRAMMAR_ALIASES.flatMap((k) => cleanLines(sections.get(k) ?? []))
    const item = {
      day: d.day,
      text: sent.text,
      source: sent.source || tagSource,
      vocab: parseVocab(sections.get('词汇') ?? []),
      structure: cleanLines(sections.get('结构划分') ?? []),
      refTranslation: cleanLines(sections.get('参考译文') ?? []).join(''),
      grammar: grammarLines,
      file: f,
    }
    // 同一天撞车（PDF 里印了两遍 / 跨文件重复）：保留更完整的那份
    const prev = days.get(d.day)
    if (!prev || dayCompleteness(item) > dayCompleteness(prev)) days.set(d.day, item)
  }
}

const list = [...days.values()].sort((a, b) => a.day - b.day)
for (const d of list) {
  if (!d.vocab.length) missing.vocab += 1
  if (!d.structure.length) missing.structure += 1
  if (!d.refTranslation) missing.refTranslation += 1
  if (!d.grammar.length) missing.grammar += 1
  delete d.file
}

const maxDay = list.length ? list[list.length - 1].day : 0
const gaps = []
for (let d = 1; d <= maxDay; d += 1) if (!days.has(d)) gaps.push(d)
if (gaps.length) console.warn(`警告：Day 1..${maxDay} 里缺 ${gaps.join('、')}`)

const payload = {
  version: 1,
  builtAt: new Date().toISOString(),
  source: '导入自本地材料',
  total: list.length,
  maxDay,
  days: list,
}
fs.mkdirSync(path.dirname(OUT), { recursive: true })
const tmp = `${OUT}.tmp`
fs.writeFileSync(tmp, JSON.stringify(payload, null, 1), 'utf8')
fs.renameSync(tmp, OUT)
console.log(`built ${OUT}：${list.length} 天（Day1..${maxDay}），markdown 块 ${blockCount} 个（去重 ${blockCount - list.length}）`)
console.log(`段落缺失统计：${JSON.stringify(missing)}`)
