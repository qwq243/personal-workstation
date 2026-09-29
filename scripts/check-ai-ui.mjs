#!/usr/bin/env node
/**
 * AI 界面收口门禁：不允许在套件（`src/ai/`）之外再手写对话骨架。
 *
 * 为什么需要它：这套东西最大的风险不是「写不出来」，而是**过一段时间又各写各的** ——
 * 收口前那几个页面就是这么来的（知识库的工具链是灰胶囊、随记的分段进度
 * 是自己画的一列），三份实现还都不太一样。规矩写进文档没人拦得住，写成门禁才拦得住。
 *
 * 两条规则：
 *   1. **组件里用了流式接口就必须走套件** —— `.vue` 里调 `wikiChatStream` /
 *      `memoSummarizeStream`，必须 import 了 `@/ai/` 的东西。
 *      光有气泡样式、事件却自己 switch 一遍，等于收口没收。
 *      （只查 `.vue`：`core/sidecar.ts`、`core/sse.ts` 是**定义**这些接口的地方，不是消费者。）
 *   2. **套件之外不许再定义对话外观类名** —— `bubble` / `reason(ing)` / `think(ing)` /
 *      `thought` / `typing` 这几个词正是那五类组件的语义，别处再出现基本就是又手画了一遍。
 *
 * 规则 2 只在**真正的类名语境**里匹配（`class="…"` 属性值、`:class` 表达式、样式选择器行），
 * 不匹配普通标识符 —— 否则 `last.reason`（数据字段）、`'thinking'`（事件枚举值）这类
 * 会被误报，而误报会让人很快开始无视这道门禁。
 *
 * 与项目里 `check:pages` 同一套做法：确实该保留的，在该行附近写 `ai-ui-allow: 理由` 放行。
 *
 * 用法：node scripts/check-ai-ui.mjs        退出码 0 = 干净，1 = 有违规
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'src')
const KIT = path.join(SRC, 'ai') // 套件自己不受这两条规则约束

const STREAM_APIS = ['wikiChatStream', 'memoSummarizeStream']

/** 对话外观类名 → 该用哪个组件 */
const BANNED = [
  { re: /(^|[-_])bubbles?([-_]|$)/i, what: '气泡 → Bubble / BubbleList' },
  { re: /(^|[-_])reason(ing)?([-_]|$)/i, what: '推理过程 → Thinking' },
  { re: /(^|[-_])think(ing)?([-_]|$)/i, what: '思考过程 → Thinking' },
  { re: /(^|[-_])thought(s)?([-_]|$)/i, what: '思维链 → ThoughtChain' },
  { re: /(^|[-_])typing([-_]|$)/i, what: '「正在输入」动画 → Bubble 的 loading' },
]

const ALLOW_MARK = 'ai-ui-allow:'

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) walk(p, out)
    else if (/\.(vue|ts|js|mjs)$/.test(name)) out.push(p)
  }
  return out
}

/** 该行附近（本行 + 上两行）有没有放行标记 */
const allowed = (lines, i) => [lines[i], lines[i - 1], lines[i - 2]].some((l) => l && l.includes(ALLOW_MARK))

/** 从一行里取出所有「类名语境」的标识符 */
function classTokens(line) {
  const out = []
  // class="a b" / :class="…"（含对象语法里的键）
  for (const m of line.matchAll(/(?::?class)\s*=\s*"([^"]*)"/g)) {
    out.push(...m[1].split(/[^\w-]+/).filter(Boolean))
  }
  // 样式选择器行：以点号开头（可有缩进），取第一个类名
  const sel = /^\s*\.([\w-]+)/.exec(line)
  if (sel) out.push(sel[1])
  return out
}

const problems = []

for (const file of walk(SRC)) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')
  if (file.startsWith(KIT)) continue
  const src = fs.readFileSync(file, 'utf8')
  const lines = src.split(/\r?\n/)

  // --- 规则 1：组件里用了流式接口就得走套件 ---
  if (rel.endsWith('.vue')) {
    const used = STREAM_APIS.filter((api) => new RegExp(`\\b${api}\\b`).test(src))
    if (used.length && !/from\s+['"]@\/ai\//.test(src)) {
      problems.push({ file: rel, line: 1, msg: `调了 ${used.join(' / ')} 但没走 src/ai 套件 —— 事件被自己 switch 了一遍` })
    }
  }

  // --- 规则 2：套件之外不许定义对话外观类名 ---
  lines.forEach((line, i) => {
    if (allowed(lines, i)) return
    const tokens = classTokens(line)
    if (!tokens.length) return
    for (const t of tokens) {
      const hit = BANNED.find((b) => b.re.test(t))
      if (hit) {
        problems.push({ file: rel, line: i + 1, msg: `类名 .${t} → ${hit.what}`, text: line.trim().slice(0, 90) })
        break
      }
    }
  })
}

if (problems.length) {
  console.log(`check-ai-ui：发现 ${problems.length} 处违规\n`)
  const byFile = {}
  for (const p of problems) (byFile[p.file] = byFile[p.file] || []).push(p)
  for (const [f, list] of Object.entries(byFile)) {
    console.log(`  ${f}`)
    for (const p of list.slice(0, 8)) console.log(`    ${p.line}: ${p.msg}${p.text ? `\n         ${p.text}` : ''}`)
    if (list.length > 8) console.log(`    …还有 ${list.length - 8} 处`)
    console.log()
  }
  console.log(`确实该保留的：在那一行附近注 \`${ALLOW_MARK} 为什么\`，门禁放行。`)
  process.exit(1)
}

console.log('check-ai-ui：通过（套件之外没有手写的对话骨架）')
