/**
 * 静态扫描 `src/features/` 与内核的几个「约定」文件。
 *
 * 为什么要有它：这套结构最脆的三条约定都**只存在于代码的写法里**，没有任何编译期检查 ——
 *   ① 每个模块文件都被 `src/features/index.ts` 注册（漏了 = 页面在注册表里不存在，而 build 照样过）；
 *   ② 模块用到的图标名都在 `src/main.ts` 的两处白名单里（漏了 = 那块空白，build 照样过）；
 *   ③ 路由 path / name 全局唯一、component 是懒加载函数（重名只在运行时告警）。
 * 所以 `scripts/tests/module-contract.test.mjs` 把这三条变成断言，
 * `scripts/new-feature.mjs` 也用它来「先看会不会撞车，再动手写文件」。
 *
 * **刻意不走「导入 .ts 再读导出」那条路**：模块文件里 import 的是 `.vue`，
 * Node 跑不了；而 `--experimental-strip-types` 也只解决类型剥离、不解决 .vue。
 * 所以这里是**文本级解析**，判据取「本仓库模块文件的实际写法」
 * （单行对象 `{ path: '/wiki', … }`、多行对象、`component: () => import()`、
 * 以及 `const WORKSPACE = () => import()` 再复用 —— 这四种现有写法都能认）。
 * 新增模块照 `src/features/_template/` 抄就不会跑偏。
 *
 * 零依赖、只读文本、**不执行**任何模块里的代码。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const FEATURES_DIR = path.join(ROOT, 'src', 'features')
export const INDEX_TS = path.join(FEATURES_DIR, 'index.ts')
export const MAIN_TS = path.join(ROOT, 'src', 'main.ts')
export const TYPES_TS = path.join(ROOT, 'src', 'core', 'types.ts')

/* --------------------------------------------------------------- 小工具 --- */

/**
 * 去注释（保留换行，便于后续按行匹配）。
 *
 * 必须做这一步：`src/features/index.ts` 的文件头注释里就写着
 * `registerModule(xxxModule)` 当例子 —— 不剥注释，它会被当成一个真注册。
 */
export function stripComments(text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' ? '\n' : ' '
        i++
      }
      i += 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      out += c
      i++
      while (i < text.length) {
        out += text[i]
        if (text[i] === '\\') { out += text[i + 1] ?? ''; i += 2; continue }
        if (text[i] === q) { i++; break }
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}

/**
 * 从 `from`（应指向开括号）开始找配对的闭括号，返回**原始文本**里的下标。
 * 会跳过字符串与注释，所以 `'a]b'` 里的 `]` 不算数。
 */
export function matchBracket(text, from, open = '[', close = ']') {
  let depth = 0
  let i = from
  while (i < text.length) {
    const c = text[i]
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue }
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      i++
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue }
        if (text[i] === q) { i++; break }
        i++
      }
      continue
    }
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

/** 把 `{...},{...}` 文本按顶层对象切开（跳过字符串与注释） */
export function splitTopLevelObjects(region) {
  const out = []
  let i = 0
  while (i < region.length) {
    if (region[i] !== '{') { i++; continue }
    const end = matchBracket(region, i, '{', '}')
    if (end < 0) break
    out.push(region.slice(i, end + 1))
    i = end + 1
  }
  return out
}

/** `xxx: '字面量'` —— 前面的字符不能是字母/数字/下划线，这样 `homePath:` 不会被 `path:` 命中 */
const strField = (key) => new RegExp(`(?<![A-Za-z0-9_$])${key}:\\s*'([^']+)'`)
const numField = (key) => new RegExp(`(?<![A-Za-z0-9_$])${key}:\\s*(\\d+)`)

function firstString(text, re) {
  const m = text.match(re)
  return m ? m[1] : null
}
function firstNumber(text, re) {
  const m = text.match(re)
  return m ? Number(m[1]) : null
}

/* ------------------------------------------------------------ 模块文件 --- */

/** 列出 `src/features` 下的模块定义文件（`module.ts` 或 `<id>.module.ts`） */
export function listModuleFiles(root = ROOT) {
  const out = []
  const dir = path.join(root, 'src', 'features')
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const sub = path.join(dir, entry.name)
    for (const f of fs.readdirSync(sub)) {
      if (f === 'module.ts' || f.endsWith('.module.ts')) {
        const abs = path.join(sub, f)
        out.push({ abs, rel: path.relative(root, abs).split(path.sep).join('/'), dir: entry.name })
      }
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

/**
 * 一个模块文件里所有路由（`routes: [...]` 的每个对象）。
 *
 * `component` 支持两种写法：内联 `() => import('./X.vue')`，
 * 或者复用文件内定义的 `const WORKSPACE = () => import('./X.vue')`（wiki.module.ts 就是后者）。
 */
export function extractRoutes(text) {
  const at = text.indexOf('routes:')
  if (at < 0) return []
  const open = text.indexOf('[', at)
  if (open < 0) return []
  const end = matchBracket(text, open, '[', ']')
  if (end < 0) return []

  /** 文件内 `const X = () => import('…')` 的映射（拉取式 lazy 组件的复用写法） */
  const consts = new Map()
  for (const m of text.matchAll(/const\s+([A-Za-z0-9_$]+)\s*=\s*\(\)\s*=>\s*import\(\s*'([^']+)'\s*\)/g)) consts.set(m[1], m[2])

  return splitTopLevelObjects(text.slice(open + 1, end)).map((o) => {
    const inline = firstString(o, /component:\s*\(\)\s*=>\s*import\(\s*'([^']+)'\s*\)/)
    let component = inline
    if (!component) {
      const ident = firstString(o, /component:\s*([A-Za-z0-9_$]+)/)
      if (ident && consts.has(ident)) component = consts.get(ident)
      else if (ident) component = null // 认不出来：记为 null，由测试断言拦下
    }
    return {
      raw: o,
      path: firstString(o, strField('path')),
      name: firstString(o, strField('name')),
      component,
      componentExpr: firstString(o, /component:\s*([A-Za-z0-9_$]+|\(\)\s*=>\s*import\(\s*'[^']+'\s*\))/),
      title: firstString(o, strField('title')),
      icon: firstString(o, strField('icon')),
      hideInNav: /hideInNav:\s*true/.test(o),
    }
  })
}

/** 读一个模块文件里的关键字段 + 路由 */
export function readModuleFile(abs) {
  const text = fs.readFileSync(abs, 'utf8')
  const code = stripComments(text) // 只看没被注释掉的：模板里的 `// category: …` 不该被当成有分组
  return {
    text,
    exportName: firstString(code, /export const ([A-Za-z0-9_]+)/),
    id: firstString(code, strField('id')),
    name: firstString(code, strField('name')),
    icon: firstString(code, strField('icon')),
    category: firstString(code, strField('category')),
    order: firstNumber(code, numField('order')),
    homePath: firstString(code, strField('homePath')),
    /** `visible()` 里用到的配置项路径 —— 必须真在 DEFAULTS 里存在 */
    cfgPaths: [...code.matchAll(/cfgFilled\(\s*'([^']+)'\s*\)|cfgGet\(\s*'([^']+)'\s*\)/g)].map((m) => m[1] ?? m[2]),
    routes: extractRoutes(code),
  }
}

/** 扫全部模块文件（含 `_template`：它的图标与路由形状也值得被盯住） */
export function scanModules(root = ROOT) {
  return listModuleFiles(root).map((f) => ({ ...f, ...readModuleFile(f.abs), isTemplate: f.rel.includes('/_') }))
}

/* ------------------------------------------------- src/features/index.ts --- */

/** 注册表里「谁被注册了、从哪个文件 import 的」 */
export function scanRegistered(root = ROOT) {
  const file = path.join(root, 'src', 'features', 'index.ts')
  const code = stripComments(fs.readFileSync(file, 'utf8'))
  /** 本地名 → import 的来源说明符 */
  const imported = new Map()
  for (const m of code.matchAll(/import\s*\{\s*([A-Za-z0-9_]+)\s*\}\s*from\s*'([^']+)'/g)) imported.set(m[1], m[2])
  const registered = new Set([...code.matchAll(/registerModule\(\s*([A-Za-z0-9_]+)\s*\)/g)].map((m) => m[1]))
  /** 注册过但没 import 的（真会报错，单独报出来更好定位） */
  const notImported = [...registered].filter((n) => !imported.has(n))
  return { code, imported, registered, notImported, file }
}

/** 注册表里每个 `registerModule(x)` 对应的模块文件绝对路径 → 本地名 */
export function registeredFiles(root = ROOT) {
  const { imported, registered } = scanRegistered(root)
  const out = new Map()
  for (const local of registered) {
    const spec = imported.get(local)
    if (!spec) continue
    const abs = path.normalize(path.resolve(root, 'src', 'features', `${spec}.ts`))
    out.set(abs, local)
  }
  return out
}

/* ---------------------------------------------------------- src/main.ts --- */

const ICON_ANCHOR = '// ↓ 新图标加在这里'
const PASCAL = /\b([A-Z][A-Za-z0-9]*)\b/g

/**
 * 取出一个「图标列表」块里的 PascalCase 名字。
 *
 * 必须先剥注释：`ICONS` 那个锚点行里就写着「import 与 ICONS 两处」，
 * 不剥的话 `ICONS` 会被当成一个图标名混进 `imported` 集合。
 * 剥注释走 `stripComments()` 而不是按行 `//.*$` —— 本仓库工作树是 **CRLF**，
 * `$` 在 `\r` 前不成立，按行匹配会静默漏掉整条注释（这个坑真踩过一次）。
 */
function pascalNames(block) {
  const names = new Set()
  for (const line of stripComments(block).split('\n')) {
    for (const m of line.matchAll(PASCAL)) names.add(m[1])
  }
  return names
}

/**
 * `src/main.ts` 的两处图标白名单。
 *
 * 两处靠 `// ↓ 新图标加在这里` 锚点定位：第一处在 import 语句之前，第二处在 `ICONS` 映射之前。
 * `imported` / `keys` 两个集合**必须相等** —— 只在一处有，表现就是那块图标空白而构建照样过。
 */
export function scanMainIcons(root = ROOT) {
  const file = path.join(root, 'src', 'main.ts')
  const text = fs.readFileSync(file, 'utf8')
  const anchors = [...text.matchAll(new RegExp(ICON_ANCHOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))].map((m) => m.index)
  const out = { file, text, anchors, imported: new Set(), keys: new Set() }
  if (anchors.length < 2) return out

  // ① import 块：从第一个锚点之后，到 `} from '@element-plus/icons-vue'`
  const importEnd = text.indexOf(`} from '@element-plus/icons-vue'`, anchors[0])
  if (importEnd > 0) out.imported = pascalNames(text.slice(anchors[0], importEnd))

  // ② ICONS 映射：从第二个锚点之后找到 `= {`，再配对到 `}`
  const braceAt = text.indexOf('{', anchors[1])
  if (braceAt > 0) {
    const braceEnd = matchBracket(text, braceAt, '{', '}')
    if (braceEnd > 0) out.keys = pascalNames(text.slice(braceAt + 1, braceEnd))
  }
  return out
}

/* ------------------------------------------------- src/core/types.ts --- */

/** `MODULE_GROUPS` 里用的图标名（分组图标也吃同一份白名单） */
export function scanGroupIcons(root = ROOT) {
  const text = fs.readFileSync(path.join(root, 'src', 'core', 'types.ts'), 'utf8')
  const at = text.indexOf('export const MODULE_GROUPS')
  if (at < 0) return { text, icons: new Set() }
  // 注意用 `= [` 而不是 `[`：`MODULE_GROUPS: ModuleGroupMeta[]` 里的 `[]` 会先被 indexOf 找到
  const open = text.indexOf('= [', at)
  const end = open < 0 ? -1 : matchBracket(text, text.indexOf('[', open), '[', ']')
  const region = end > 0 ? text.slice(open, end) : ''
  return { text, icons: new Set([...region.matchAll(/icon:\s*'([^']+)'/g)].map((m) => m[1])) }
}

/** MODULE_GROUPS 里定义的全部分组 id（category 对账用；与图标同一份来源） */
export function scanGroupIds(root = ROOT) {
  const text = fs.readFileSync(path.join(root, 'src', 'core', 'types.ts'), 'utf8')
  const at = text.indexOf('export const MODULE_GROUPS')
  if (at < 0) return []
  const open = text.indexOf('= [', at)
  const end = open < 0 ? -1 : matchBracket(text, text.indexOf('[', open), '[', ']')
  const region = end > 0 ? text.slice(open, end) : ''
  return [...region.matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1])
}

/* --------------------------------------------------------- 锚点定位 --- */

/** 找一行注释锚点，返回它所在行的起止下标（插入时应插在这一行**之前**） */
export function findAnchorLine(text, needle) {
  const at = text.indexOf(needle)
  if (at < 0) return null
  const lineStart = text.lastIndexOf('\n', at) + 1
  let lineEnd = text.indexOf('\n', at)
  if (lineEnd < 0) lineEnd = text.length
  return { at, lineStart, lineEnd }
}
