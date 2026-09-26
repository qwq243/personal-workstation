/**
 * 单词文本导入解析器。
 *
 * 目标是「怎么粘都能用」，逐行处理，尽量从每行里榨出 term / 音标 / 词性 / 释义 / 例句。
 * 支持的行格式（可混用）：
 *   1. conceal
 *   2. conceal 隐藏
 *   3. conceal\t隐藏，隐瞒
 *   4. conceal | 隐藏 | 例句
 *   5. conceal /kənˈsiːl/ v. 隐藏，隐瞒
 *   6. 1. conceal   - v. 隐藏 ; 隐瞒
 *   7. conceal,隐藏,She could not conceal her disappointment.
 */
import type { VocabWord } from './types'

let seq = 0
export function newId(prefix = 'w'): string {
  seq += 1
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}`
}

/** 去掉行首编号：`1.` `1、` `1)` `(1)` `-` 等 */
function stripLeadingNumber(line: string): string {
  return line.replace(/^\s*[（(]?\d{1,3}[）).、,:：]?\s*/, '')
}

/** 提取音标：/.../ 或 [...] */
function extractPhonetic(line: string): { rest: string; phonetic?: string } {
  const m = line.match(/[/\[]([^/\][]+)[/\]]/)
  if (!m) return { rest: line }
  return { rest: (line.slice(0, m.index) + ' ' + line.slice((m.index ?? 0) + m[0].length)).trim(), phonetic: m[1].trim() }
}

/** 提取词性缩写（标准写法带点，如 `n.` / `adj.` / `n. & v.`，也兼容 （v.） 加括号） */
const POS_RE =
  /(^|[\s,;|、])[（(]?((?:n|v|vt|vi|adj|adv|prep|conj|pron|art|num|int|interj|aux|abbr|phr|modal)\.(?:\s*&\s*(?:n|v|adj|adv|prep|conj|pron)\.?)?)[）)]?/i

/**
 * 不带点的词性只能从「词尾」识别，且只认不容易和单词本身混淆的几个缩写。
 * 像 art / num / int 这些本身可能是词条的词（art 艺术），不在此列，避免把词条吃掉。
 */
const DOTLESS_POS = ['adj', 'adv', 'prep', 'conj', 'pron', 'interj', 'abbr', 'modal', 'phr']
const DOTLESS_POS_RE = new RegExp(`\\s+(${DOTLESS_POS.join('|')})\\.?$`, 'i')

function extractPos(line: string): { rest: string; pos?: string } {
  const m = line.match(POS_RE)
  if (!m) return { rest: line }
  const pos = m[2].replace(/\s+/g, ' ').trim()
  const idx = m.index ?? 0
  const rest = (line.slice(0, idx) + ' ' + line.slice(idx + m[0].length)).trim()
  return { rest, pos }
}

/** 判断一段文本是否更像英文例句（含较多英文单词且以大写/字母开头、有空格） */
function looksLikeSentence(s: string): boolean {
  const letters = (s.match(/[A-Za-z]/g) ?? []).length
  const spaces = (s.match(/\s/g) ?? []).length
  return letters >= 12 && spaces >= 3 && /\b(the|a|an|is|was|were|to|of|and|she|he|it|they|we|i|you|his|her|not|with|that|in|on|for)\b/i.test(s)
}

function hasChinese(s: string): boolean {
  return /[\u4e00-\u9fff]/.test(s)
}

export interface ParseStats {
  parsed: number
  skipped: number
  /** 只有单词、没有释义的条数（仍可用来做拼写练习） */
  bare: number
}

export interface ParseResult {
  words: VocabWord[]
  stats: ParseStats
}

/**
 * 把一段文本解析成词条数组。
 * @param text 原始粘贴内容
 */
export function parseWordText(text: string): ParseResult {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  const words: VocabWord[] = []
  let skipped = 0
  let bare = 0
  const seen = new Set<string>()

  for (const rawLine of lines) {
    let line = stripLeadingNumber(rawLine)
    // 注释行：`#` / `//` 开头的整行都跳过。
    // 不能只认「单独一个 # 的那一行」—— 那样 `# 注释行` 会被当成词条吃进去（term 变成 `# 注释行`）。
    // 词条不可能以 # 或 // 开头，所以这个判断是安全的。
    if (/^(#{1,6}|\/\/)\s*/.test(line)) continue
    // markdown 列表符号：`- `、`* `、`• ` 去掉前缀（智能体常按列表格式给词）
    line = line.replace(/^\s*(?:[-*•])\s+/, '').trim()
    if (!line) continue

    // 先取出音标
    const ph = extractPhonetic(line)
    line = ph.rest

    // 再取词性
    const po = extractPos(line)
    line = po.rest
    let finalPos: string | undefined = po.pos

    // 选分隔符切分：| 优先，其次 tab，其次 第一个逗号/分号/破折号/多空格
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
    } else {
      // 没有显式分隔符：以「第一个中文字符」为界切分。
      // 这样才认得出带空格的短语（do away with sth 废除），
      // 而不会在第一处空格就把 term 截成 "do"。
      if (hasChinese(line) && /[A-Za-z]/.test(line)) {
        const cut = line.search(/[\u4e00-\u9fff]/)
        term = line.slice(0, cut).trim()
        meaning = line.slice(cut).trim()
      } else {
        // 整行没有中文：可能只写了单词，也可能是英文解释。
        // 有显式分隔符（` - `、`—`、`::`、`：`）才切分，否则整行当作词条 ——
        // 这样 `appeal to sb` 这种带空格的短语不会被第一个空格截成 `appeal`。
        // （服务端 server/lib/vocab.mjs 的解析器与此一致）
        const sep = line.match(/^(.+?)\s*(?:[—–]{1,2}|::|[:：]|\s-\s)\s*(.+)$/)
        if (sep) {
          term = sep[1].trim()
          meaning = sep[2].trim()
        } else {
          term = line.trim()
        }
      }

      // 去掉 term 尾部的分隔符，如 "reward," 里的逗号
      term = term.replace(/[\s,;，；、|—–\-]+$/, '').trim()

      // 从 meaning 里再剥出一段英文例句（如果释义后面跟了整句英文）
      if (meaning) {
        const segs = meaning.split(/[;；]/).map((s) => s.trim()).filter(Boolean)
        const ruo = segs.filter((s) => !hasChinese(s) && looksLikeSentence(s))
        if (ruo.length) {
          example = ruo[0]
          meaning = segs.filter((s) => s !== ruo[0]).join('; ')
        }
      }
    }

    // 释义尾巴上若还挂着一整句英文，把它剥出来当例句
    // 例：「隐藏，隐瞒 She concealed her disappointment.」
    if (!example && meaning && hasChinese(meaning)) {
      const tail = meaning.match(/\s+([A-Z][A-Za-z'’,.\- ]{14,}[.!?])\s*$/)
      if (tail && hasChinese(meaning.slice(0, tail.index))) {
        example = tail[1].trim()
        meaning = meaning.slice(0, tail.index).trim()
      }
    }

    term = term.trim().replace(/[.。]+$/, '').trim()
    meaning = meaning.trim().replace(/^[\s:：\-—–,;，；]+/, '').trim()
    // 一行里写了多个词性（`fair adj. 公平的 n. 集市`）时，POS_RE 只吃掉第一个，
    // 剩下的词性缩写会留在释义开头 —— 这里循环剥掉，免得释义里混着 `n. `
    // （服务端 server/lib/vocab.mjs 的解析器有同样的处理，两份逻辑要保持一致）
    for (;;) {
      const head = meaning.match(/^\(?(?:n|v|vt|vi|adj|adv|prep|conj|pron|art|num|int|interj|aux|abbr|phr|modal)\.\s*/i)
      if (!head) break
      meaning = meaning.slice(head[0].length).trim()
    }

    // 兜底：`distinguished adj` 这种没带点的词性，收尾时再剥一次
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

    const dedupKey = term.toLowerCase()
    const existing = words.find((w) => w.term.toLowerCase() === dedupKey)
    if (existing) {
      if (example) {
        const key = example.toLowerCase().replace(/\s+/g, ' ')
        const has = (existing.examples ?? []).some((ex) => ex.en.toLowerCase().replace(/\s+/g, ' ') === key)
        if (!has) {
          existing.examples = [...(existing.examples ?? []), { en: example, source: 'import' }]
          if (!existing.example) existing.example = example
        }
      }
      skipped += 1
      continue
    }
    seen.add(dedupKey)

    if (!meaning) bare += 1

    words.push({
      id: newId('w'),
      term,
      phonetic: ph.phonetic,
      pos: finalPos,
      meaning: meaning || '（未填写释义）',
      example: example || undefined,
      examples: example ? [{ en: example, source: 'import' }] : [],
      tags: [],
    })
  }

  return { words, stats: { parsed: words.length, skipped, bare } }
}

/** 把纯单词列表（每行一个词）快速转成词条 */
export function parseTermOnly(text: string): VocabWord[] {
  return text
    .split(/\r?\n/)
    .map((l) => stripLeadingNumber(l.trim()))
    .filter((l) => /^[A-Za-z][A-Za-z'’\- ]*$/.test(l))
    .map((term) => ({ id: newId('w'), term, meaning: '（未填写释义）' }))
}

/** 导出词单为「term\t释义」文本，便于传给别人或在别处编辑 */
export function exportWordsToText(words: VocabWord[]): string {
  return words
    .map((w) => {
      const head = [w.term, w.phonetic ? `/${w.phonetic}/` : '', w.pos ?? ''].filter(Boolean).join(' ')
      const extra = (w.examples ?? []).map((ex) => ex.en).filter((en) => en && en !== w.example)
      return `${head}\t${w.meaning}${w.example ? `\t${w.example}` : ''}${extra.length ? `\t${extra.join(' | ')}` : ''}`
    })
    .join('\n')
}

/** 导出为带 BOM 的 CSV，方便 Excel 打开不乱码 */
export function exportWordsToCSV(words: VocabWord[]): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  const header = 'term,phonetic,pos,meaning,example,exampleZh,examples,note,tags'
  const rows = words.map((w) =>
    [
      w.term,
      w.phonetic ?? '',
      w.pos ?? '',
      w.meaning,
      w.example ?? '',
      w.exampleZh ?? '',
      (w.examples ?? []).map((ex) => ex.en).join(' | '),
      w.note ?? '',
      (w.tags ?? []).join(' '),
    ]
      .map(esc)
      .join(','),
  )
  return `\uFEFF${[header, ...rows].join('\n')}`
}
