#!/usr/bin/env node
/**
 * 页面宽度防回归检查 —— `npm run check:pages`（`npm run build` 之前自动跑）。
 *
 * 为什么要有它：页面宽度是**全站的一个决定**（`--ws-page-max` + `.ws-page` / `.wk-page`），
 * 可新建页面时最顺手的动作就是给根容器补一句 `max-width: 1120px; margin: 0 auto`——
 * 2026-09-27 用户看到的就是这个：每个新页面左右都白留 200 多 px（2560 屏上实测 242px）。
 * 与其靠记性，不如让这句话写不进去：**任何 ≥ 640px 的 max-width 都要写明理由**。
 *
 * 放行的两种写法：
 *   1. 那一行、或它上面两行之内有 `page-narrow: 理由` 注释
 *      （例：max-width 那行后面补「page-narrow: 聊天正文的阅读栏宽」）；
 *   2. 页面容器用 `.ws-page--narrow`（全站唯一的窄栏档，宽度在 index.css 里定义）。
 *
 * 只认 `max-width: <数字>px` 字面量：`@media (max-width: …)` 是断点、百分比是相对宽度，
 * 都不算「给页面上了一道固定宽度」。
 *
 * 顺带查一个会让整条规则**静默消失**的写法（2026-09-27 真踩过）：CSS 注释里又写了一对
 * 注释符号 —— 内层那对会把外层注释提前结束，紧随其后的第一条规则被解析器整条丢掉，
 * 构建不报错、页面就是没样式（当时把 `.ws-page` 整个丢了，页面直接顶到两边）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC = join(ROOT, 'src')
/** 低于它就只是小块的宽度（头像、徽标、说明段），不是「页面容器」那一档 */
const MIN_PX = 640
const MARKER = 'page-narrow:'
const WIDTH_RE = /max-width:\s*(\d+(?:\.\d+)?)px/g

const EXT = new Set(['.vue', '.css', '.scss', '.less'])

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (EXT.has(p.slice(p.lastIndexOf('.')))) out.push(p)
  }
  return out
}

const offenders = []
const allowed = []
const commentTraps = []

/**
 * 找出被「注释里又写了一对注释符号」提前结束的注释。
 *
 * 判据（不含糊、不会误报）：把注释逐个摘掉之后，**剩下的代码里不该再出现注释结束符**
 * —— 真出现了，说明那段注释在更早的结束符处就完了，剩下的半截文字会被解析器当代码，
 * 紧随其后的第一条规则被整条丢掉。构建不报错、页面就是没样式
 * （2026-09-27 这样丢过 `.ws-page`，页面顶到屏幕两边）。
 *
 * 只看 CSS 上下文：`.css` 整份文件；`.vue` 只看 `<style>` 块 —— 脚本/template 里的
 * 注释开头符是 JS/文本自己的事（`skills/*.md` 这种写法很常见，不是错）。
 */
function findCommentTraps(file, text) {
  // 只认**行首**的 <style>（SFC 里的样式块都写在行首）；注释里顺口提一句 `<style>`
  // 不该被当成样式块扫进来 —— 这里正是踩过的坑。
  const chunks = file.endsWith('.css')
    ? [{ text, at: 0 }]
    : [...text.matchAll(/^[ \t]*<style[^>]*>([\s\S]*?)^[ \t]*<\/style>/gm)].map((m) => ({
        text: m[1],
        at: m.index + m[0].indexOf(m[1]),
      }))
  for (const chunk of chunks) {
    const stray = strayTerminator(chunk.text)
    if (stray < 0) continue
    const line = text.slice(0, chunk.at + stray).split('\n').length
    commentTraps.push({ where: `${relative(ROOT, file).split(sep).join('/')}:${line}` })
  }
}

/** 摘掉所有正常注释后，第一个「多出来」的注释结束符在哪（返回该块的偏移，没有则 -1） */
function strayTerminator(css) {
  let i = 0
  while (i < css.length) {
    const open = css.indexOf('/*', i)
    if (open < 0) {
      const tail = css.indexOf('*/', i)
      return tail < 0 ? -1 : tail
    }
    const inCode = css.indexOf('*/', i)
    if (inCode >= 0 && inCode < open) return inCode
    const close = css.indexOf('*/', open + 2)
    if (close < 0) return -1 // 注释没闭合，是另一类错（vite 会 warn），这里不管
    i = close + 2
  }
  return -1
}

for (const file of walk(SRC)) {
  const text = readFileSync(file, 'utf8')
  findCommentTraps(file, text)
  const lines = text.split(/\r?\n/)
  lines.forEach((line, i) => {
    if (line.includes('@media')) return
    for (const m of line.matchAll(WIDTH_RE)) {
      const px = Number(m[1])
      if (px < MIN_PX) continue
      const near = [lines[i - 2] ?? '', lines[i - 1] ?? '', line].join('\n')
      const where = `${relative(ROOT, file).split(sep).join('/')}:${i + 1}`
      const entry = { where, px, line: line.trim() }
      if (near.includes(MARKER)) allowed.push(entry)
      else offenders.push(entry)
    }
  })
}

if (commentTraps.length) {
  console.error('\n✗ 样式注释检查没通过：注释里又写了一对注释符号\n')
  for (const t of commentTraps) console.error(`  ${t.where}`)
  console.error(
    [
      '',
      'CSS 注释在第一个 `*/` 就结束了 —— 注释里再写一对注释符号，外层会被提前结束，',
      '紧随其后的第一条规则被解析器整条丢掉（构建不报错，页面就是没样式；',
      '2026-09-27 这样丢过 `.ws-page`，页面直接顶到屏幕两边）。',
      '写法：注释里要提这个标记就写「page-narrow: 理由」，不要写完整的注释符号。',
      '',
    ].join('\n'),
  )
}

if (offenders.length) {
  console.error('\n✗ 页面宽度检查没通过：下面这些 max-width 没写理由\n')
  for (const o of offenders) {
    console.error(`  ${o.where}  →  max-width: ${o.px}px`)
    console.error(`      ${o.line}`)
  }
  console.error(
    [
      '',
      '规矩（详见 src/styles/index.css 顶部的「页面容器（宽度）」与 docs/design-system.md）：',
      `  · 页面根容器一律 .ws-page / .wk-page —— 宽度由 --ws-page-max 一处决定，别再写 max-width；`,
      `  · 真要收窄：整页用 .ws-page--narrow（唯一窄栏档），页内分栏也一样要说明；`,
      `  · 确实该保留这个宽度：在这一行附近加注释 /* ${MARKER} 为什么 */，本检查就放行。`,
      '',
    ].join('\n'),
  )
}

if (offenders.length || commentTraps.length) process.exit(1)

console.log(
  `✓ 页面宽度检查通过：没有无理由的宽幅 max-width（已注明理由的收窄 ${allowed.length} 处）`,
)
