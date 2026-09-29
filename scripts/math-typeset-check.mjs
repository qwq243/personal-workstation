/**
 * 公式排版回归：math-typeset 改动后，拿真实知识库内容跑一遍不变式。
 *
 * 为什么要这个脚本：`typesetMath` 是知识库所有页面共用的排版函数（`WikiMarkdown` 调它），
 * 改一处就可能把 180 多个页面弄花。库里 **99% 的内容是没有 $ 的老写法**（裸上下标 + 中文夹公式），
 * 所以真正要守住的是「老路径别动」。
 *
 * 不变式：
 *   1. 输出里不能再有哨兵 \x01 —— 实体占位必须全部还原；
 *   2. **不含 $ 的内容不许出现 KaTeX 段** —— 数学段只在 $...$ 里触发；
 *   3. 不许抛异常（KaTeX 失败要回退成裸文本，不能带崩整页）；
 *   4. demath 对实体文本恒等 —— 这是「实体占位挪到数学段之后」保持等价的前提。
 *
 * 用法：
 *   node --experimental-strip-types scripts/math-typeset-check.mjs [知识库根目录...]
 * 不给参数时默认扫工作区下这三个库。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { typesetMath, demath } = await import(
  pathToFileURL(path.join(ROOT, 'src/features/wiki/math-typeset.ts')).href
)

/** 默认扫仓库里的示例库；换库就把目录（含 wiki/ 子目录）作为参数传进来 */
const DEFAULT_ROOTS = [path.join(ROOT, 'KnowledgeBase', 'wiki')]
const roots = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_ROOTS

function collect(dir, out) {
  let ents = []
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of ents) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) collect(p, out)
    else if (e.name.endsWith('.md')) out.push(p)
  }
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const files = []
for (const r of roots) collect(r, files)

let withDollar = 0
let withEntity = 0
let styled = 0
const bad = []

for (const f of files) {
  const raw = fs.readFileSync(f, 'utf8')
  if (raw.includes('$')) withDollar++
  if (/&(?:[a-zA-Z]+|#\d+);/.test(raw)) withEntity++
  let out = ''
  try {
    out = typesetMath(esc(raw))
  } catch (e) {
    bad.push(['抛异常', f, e?.message])
    continue
  }
  if (out.includes('\x01')) bad.push(['占位符没还原', f])
  if (!raw.includes('$') && out.includes('wmd__katex')) bad.push(['无 $ 却出现 KaTeX', f])
  if (out.includes('wmd__math')) styled++
}

const entSample = '&amp; &gt; &lt; &#39; &#x1D434;'
const demathIdentical = demath(entSample) === entSample

console.log(`知识库 md 文件: ${files.length}`)
console.log(`  含 $ 的: ${withDollar}`)
console.log(`  含 HTML 实体的: ${withEntity}`)
console.log(`  排版出数学段的: ${styled}`)
console.log(`demath 对实体文本恒等: ${demathIdentical ? '是' : '否 ← 有问题'}`)
console.log(`不变式违例: ${bad.length}`)
for (const [why, f, m] of bad.slice(0, 8)) console.log('  ✗', why, '|', f, m ?? '')

// 一条 md 都没扫到不算失败：这个脚本只有在真读到页面时才谈得上验证（换库就把目录当参数传进来）
if (!files.length) {
  console.log('\n没扫到 md 文件 —— 把库目录（含 wiki/ 子目录）作为参数传进来，例如：')
  console.log('  node --experimental-strip-types scripts/math-typeset-check.mjs D:/我的知识库/wiki')
  process.exit(0)
}

const pass = bad.length === 0 && demathIdentical
console.log(pass ? '\n✅ 通过：知识库渲染路径没被弄坏' : '\n❌ 需要复查')
process.exit(pass ? 0 : 1)
