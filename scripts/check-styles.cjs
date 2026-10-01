#!/usr/bin/env node
/**
 * 样式加载门禁：静态扫源码，拦住「样式写了、页面却加载不到」这类**肉眼看不见**的毛病。
 *
 * 为什么要有它：2026-10-01 用户截图报「娱乐 · 音乐」那张卡没内边距 ——
 * 根因是这一页**漏引了 `features/ent/ent.css`**（六个兄弟页都引了）。路由是懒加载的，
 * 所以「先进过别的娱乐页」时样式在、「冷启动直接进这一页」时整页掉样式 —— 同一页两种长相，
 * 手工点一遍是碰不到的。同一天还查出两处同类：
 *   · 组件用了只在**别的组件 scoped 样式**里定义的类（父组件的 scope 标记只落在子组件根节点上，
 *     子组件里面的节点吃不到）—— 共用组件的卡头、某个播放器里的 .tiny 就这么丢的；
 *   · `memo.css` 把 `@keyframes` 挂在了选择器下面（`.memo @keyframes …`），非法语法，
 *     构建时被 esbuild 整块丢掉，录音按钮的脉冲 / 光标闪烁一直没动。
 *
 * 三条断言（纯静态，不起浏览器，一两百毫秒跑完）：
 *   1. 家族样式要被用到它的**路由页**引进来（子组件由页面带进来，不单独要求）。
 *   2. 模板里用到的类，不能「只定义在别的文件的 scoped 样式里」。
 *   3. 不许出现「选择器 + @keyframes」这种非法嵌套（动画名本来就是全局的）。
 *
 * 用法：node scripts/check-styles.cjs   （退出码 0 = 全过，1 = 有问题）
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'src')

/* ------------------------------------------------------------- 小工具 -- */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '')
const read = (p) => strip(fs.readFileSync(p, 'utf8'))
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/')
const classNames = (t) => new Set([...t.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]))

/**
 * 模板里用到的类：`class="a b"` 与 `:class="{ 'a': cond }"` 里的**字面量**。
 * **挂在组件标签上的类不算** —— 父组件的 scoped 样式够得着子组件根节点，
 * `<SidecarOffline class="pad">` 那种写法是合法的，别误报。
 */
function usedClasses(tpl) {
  const used = new Set()
  for (const m of tpl.matchAll(/<([A-Za-z][\w-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g)) {
    const [, tag, attrs] = m
    if (/^[A-Z]/.test(tag)) continue
    for (const a of attrs.matchAll(/\bclass\s*=\s*"([^"]*)"/g)) {
      for (const c of a[1].split(/\s+/)) if (/^[a-zA-Z][\w-]*$/.test(c)) used.add(c)
    }
    for (const a of attrs.matchAll(/\bclass\s*=\s*'([^']*)'/g)) {
      for (const c of a[1].split(/\s+/)) if (/^[a-zA-Z][\w-]*$/.test(c)) used.add(c)
    }
    // 动态 :class 只取**引号里的字面量**：`{ 'is-on': tab === 'hot' }` 取到 is-on，
    // 而 `preview ? 'a' : ''` 里的 preview 是变量名，别当成类（searchPanel 就被这么误报过）
    for (const a of attrs.matchAll(/:class\s*=\s*"([^"]*)"/g)) {
      for (const q of a[1].matchAll(/'([^']*)'|"([^"]*)"/g)) {
        for (const c of (q[1] ?? q[2]).split(/\s+/)) if (/^[a-zA-Z][\w-]*$/.test(c)) used.add(c)
      }
    }
  }
  return used
}

/** 模板**根元素**上的类：父组件能用 scoped 规则给它上样式，不该被断言 2 判为「够不着」 */
function rootClasses(tpl) {
  const first = tpl.match(/<([A-Za-z][\w-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/)
  if (!first) return new Set()
  const set = new Set()
  for (const a of first[2].matchAll(/(?::class|class)\s*=\s*"([^"]*)"/g)) {
    for (const c of a[1].split(/\s+/)) if (/^[a-zA-Z][\w-]*$/.test(c)) set.add(c)
  }
  return set
}

/* --------------------------------------------------- 全量样式定义索引 -- */
const allFiles = walk(SRC)
const cssFiles = allFiles.filter((f) => f.endsWith('.css'))
const vueFiles = allFiles.filter((f) => f.endsWith('.vue'))
const mainTs = fs.readFileSync(path.join(SRC, 'main.ts'), 'utf8')
/** main.ts 全局引的样式：任何页面都能用，不归本门禁管 */
const globalCssNames = new Set([...mainTs.matchAll(/import\s+'([^']*\.css)'/g)].map((m) => path.basename(m[1])))

/** 每个文件的 <style> 块（.css 整份算一块） */
const styleBlocks = new Map() // 文件 → [{ scoped, body, label }]
const cssClassCache = new Map()
const classesOfCss = (f) => {
  if (!cssClassCache.has(f)) cssClassCache.set(f, classNames(read(f)))
  return cssClassCache.get(f)
}
for (const f of cssFiles) {
  styleBlocks.set(f, [{ scoped: false, body: read(f), label: rel(f) }])
}
for (const f of vueFiles) {
  const raw = fs.readFileSync(f, 'utf8')
  styleBlocks.set(
    f,
    [...raw.matchAll(/<style([^>]*)>([\s\S]*?)<\/style>/g)].map(([, attrs, body]) => ({
      scoped: /\bscoped\b/.test(attrs),
      body: strip(body),
      label: rel(f),
    })),
  )
}
/** 类 → 定义处 [{ file, scoped }] */
const defs = new Map()
for (const [f, blocks] of styleBlocks) {
  for (const b of blocks) {
    for (const c of classNames(b.body)) {
      if (!defs.has(c)) defs.set(c, [])
      defs.get(c).push({ file: f, scoped: b.scoped })
    }
  }
}

/* -------------------------------------------- 路由页清单（从源码取） -- */
const routePages = new Set()
const routeSources = [
  ...allFiles.filter((f) => /module[\w.-]*\.ts$/.test(f) && f.includes(`${path.sep}features${path.sep}`)),
  path.join(SRC, 'router', 'index.ts'),
]
for (const f of routeSources) {
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/import\(\s*'([^']+\.vue)'\s*\)/g)) {
    routePages.add(path.resolve(path.dirname(f), m[1]))
  }
}

const problems = []

/* ------------------------------------------------------ 断言 1：家族样式 -- */
/** 家族样式 = 没被 main.ts 全局引、由各页自己引的 css（ent / memo / book / print-sheet…） */
const familyCss = cssFiles.filter((f) => !globalCssNames.has(path.basename(f)))
for (const page of routePages) {
  if (!fs.existsSync(page)) continue
  const raw = fs.readFileSync(page, 'utf8')
  const used = usedClasses(raw.split('<style', 1)[0])
  const ownCls = new Set()
  for (const b of styleBlocks.get(page) || []) for (const c of classNames(b.body)) ownCls.add(c)
  const imported = new Set([
    ...[...raw.matchAll(/@import\s+'([^']+)'/g)].map((m) => path.basename(m[1])),
    ...[...raw.matchAll(/import\s+'([^']*\.css)'/g)].map((m) => path.basename(m[1])),
  ])
  for (const css of familyCss) {
    // 只管同目录的家族样式（跨模块借用由断言 2 管），引过了、或页面自己定义了同名类就不算
    if (path.dirname(css) !== path.dirname(page) || imported.has(path.basename(css))) continue
    const hits = [...used].filter((c) => classesOfCss(css).has(c) && !ownCls.has(c))
    if (hits.length >= 3) {
      problems.push(
        `${rel(page)} 用了 ${path.basename(css)} 里的 ${hits.length} 个类` +
          `（${hits.slice(0, 5).join('、')}${hits.length > 5 ? '…' : ''}）却没引它` +
          ` —— 路由是懒加载的，冷启动进这一页会整页掉样式`,
      )
    }
  }
}

/* ------------------------------ 断言 2：只活在**父组件** scoped 样式里的类 -- */
/** 谁渲染了谁：`import X from './X.vue'` + 模板里的 `<X` —— 只认父子关系，
 *  同名撞车（CalendarView 的 .dt、VocabLists 的 .preview）不算，那本来就不该生效。 */
const importToFile = new Map() // 组件文件 → 它 import 进来的组件名 → 文件
for (const f of vueFiles) {
  const m = new Map()
  const raw = fs.readFileSync(f, 'utf8')
  for (const im of raw.matchAll(/import\s+(\w+)\s+from\s+'([^']+\.vue)'/g)) {
    m.set(im[1], path.resolve(path.dirname(f), im[2]))
  }
  importToFile.set(f, m)
}
const parentsOf = new Map() // 子组件文件 → Set(父组件文件)
for (const f of vueFiles) {
  const tpl = fs.readFileSync(f, 'utf8').split('<style', 1)[0]
  for (const [name, file] of importToFile.get(f)) {
    if (!new RegExp(`<${name}[\\s/>]`).test(tpl)) continue
    if (!parentsOf.has(file)) parentsOf.set(file, new Set())
    parentsOf.get(file).add(f)
  }
}
for (const f of vueFiles) {
  const parents = parentsOf.get(f)
  if (!parents || !parents.size) continue
  const raw = fs.readFileSync(f, 'utf8')
  const tpl = raw.split('<style', 1)[0]
  const used = usedClasses(tpl)
  const root = rootClasses(tpl)
  const ownCls = new Set()
  for (const b of styleBlocks.get(f) || []) for (const c of classNames(b.body)) ownCls.add(c)
  const bad = []
  for (const c of used) {
    if (ownCls.has(c) || root.has(c)) continue
    const where = defs.get(c)
    if (!where || !where.length) continue // 全站都没定义：多半是纯语义类，不归这里管
    if (where.some((d) => !d.scoped)) continue // 有非 scoped 的定义（全局样式）就行
    // 只有「定义在**渲染它的那个父组件**的 scoped 样式里」才算够不着
    const byParent = new Set([...parents].filter((p) => (styleBlocks.get(p) || []).some((b) => b.scoped && classNames(b.body).has(c))))
    if (!byParent.size) continue
    bad.push(`${c}（只在父组件 ${rel([...byParent][0])} 的 scoped 样式里）`)
  }
  if (bad.length) {
    problems.push(
      `${rel(f)} 用了只定义在父组件 scoped 样式里的类：` +
        `${bad.slice(0, 4).join('、')}${bad.length > 4 ? ` 等 ${bad.length} 个` : ''}` +
        ` —— 父组件的 scope 标记只落在子组件根节点，里面的节点吃不到，得自己带一份`,
    )
  }
}

/* -------------------------------------- 断言 3：选择器下的 @keyframes -- */
for (const blocks of styleBlocks.values()) {
  for (const b of blocks) {
    for (const m of b.body.matchAll(/([^\s{};][^{};]*?)\s*@keyframes\s+([\w-]+)/g)) {
      if (m[1].trim().startsWith('@')) continue
      problems.push(`${b.label} 里 "${m[1].trim()}" 下面挂了 @keyframes ${m[2]} —— 非法嵌套，构建时会被整块丢掉`)
    }
  }
}

/* --------------------------------------------------------------- 输出 -- */
if (problems.length) {
  console.error(`✗ 样式加载检查未通过（${problems.length} 条）：\n`)
  for (const p of problems) console.error(`  · ${p}`)
  console.error('\n改法：家族样式照兄弟页补一行  <style>@import \'./xxx.css\';</style>')
  console.error('      组件自己的类写进它自己的 <style scoped>；@keyframes 提到顶层。')
  process.exit(1)
}
console.log(
  `✓ 样式加载检查通过：${routePages.size} 个路由页 · ${familyCss.length} 份家族样式 · 没有「定义了却加载不到」的类`,
)
