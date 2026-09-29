/**
 * 注册表契约测试 —— 盯住这套结构里**最脆的三条隐式约定**。
 *
 *   npm test          # 或 node --test "scripts/tests/*.test.mjs"
 *
 * 三条约定都只存在于「代码怎么写」里，没有任何编译期检查，而漏了它们**构建照样过**：
 *
 *   ① 每个模块文件都被 `src/features/index.ts` 注册
 *      —— 漏了 = 页面在注册表里根本不存在（侧边栏没条目、路由没这条），只有你点开才发现；
 *   ② 模块用到的图标名都在 `src/main.ts` 的两处白名单里，且**两处一致**
 *      —— 漏了 = 侧边栏 / 页面里那块空白 + 一条 Vue 警告；`ICONS` 是运行时按字符串解析的，
 *         打包器看不见，所以漏了不会报错（见 src/main.ts 的注释：不能改成 `import * as Icons`，
 *         那会让 294 个图标全部进包）；
 *   ③ 路由 `path` / `name` 全局唯一、`component` 是懒加载函数、指向的 `.vue` 真存在
 *      —— 重名只在运行时警告，静态 import 会把整个模块塞进首屏包。
 *
 * 解析走 `scripts/lib/feature-scan.mjs`（文本级、零依赖、**不执行**模块代码），
 * 生成器 `scripts/new-feature.mjs` 用的是同一套判据 —— 两边不会各说各话。
 *
 * 配置白名单的三方对账（`DEFAULTS` ↔ 两张白名单 ↔ `config.example.json`）在
 * **`scripts/tests/config-whitelist.test.mjs`** 里，这里不重复一份（两处断言同一件事，
 * 迟早会有一处先漂）。本文件只额外断言「模块 `visible()` 里引用的配置项真的存在」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  ROOT,
  registeredFiles,
  scanGroupIcons,
  scanGroupIds,
  scanMainIcons,
  scanModules,
  scanRegistered,
} from '../lib/feature-scan.mjs'
import { DEFAULTS } from '../../server/config.mjs'

/** 参与「必须被注册」检查的模块（模板目录以下划线开头，本来就不该注册） */
const modules = scanModules(ROOT)
const real = modules.filter((m) => !m.isTemplate)
const templates = modules.filter((m) => m.isTemplate)

/** Element Plus 图标名的形状；emoji 之类不参与白名单检查 */
const iconLike = (name) => typeof name === 'string' && /^[A-Z][A-Za-z0-9]*$/.test(name)

/* ------------------------------------------------ ① 注册表 --- */

test('src/features 下每个模块文件都被 src/features/index.ts 注册', () => {
  const registered = registeredFiles(ROOT)
  const missing = real.filter((m) => !registered.has(path.normalize(m.abs))).map((m) => m.rel)
  assert.deepEqual(
    missing,
    [],
    `这几个模块文件没被注册：${missing.join('、')}。\n` +
      '  页面在注册表里不存在 = 侧边栏没条目、路由没这条，而 `npm run build` 照样过。\n' +
      '  修法：在 src/features/index.ts 的 `// ↓ 新模块 import 加在这里` 与 ' +
      '`// ↓ 下一个功能加在这里` 两个锚点处各加一行；或者直接用 `node scripts/new-feature.mjs`。',
  )
})

test('注册表里的每个 registerModule 都能落到一个真实文件，且导出的常量名对得上', () => {
  const { imported, registered, notImported } = scanRegistered(ROOT)
  assert.deepEqual(notImported, [], `这些在 registerModule(...) 里出现了但没 import：${notImported.join('、')}`)

  const byFile = new Map(real.map((m) => [path.normalize(m.abs), m]))
  const problems = []
  for (const [abs, local] of registeredFiles(ROOT)) {
    const mod = byFile.get(abs)
    if (!mod) {
      problems.push(`${local} 指向的文件不在 src/features 下的模块文件里`)
      continue
    }
    if (mod.exportName !== local) problems.push(`${mod.rel} 导出的常量叫 ${mod.exportName}，但注册的是 ${local}`)
  }
  assert.deepEqual(problems, [], problems.join('\n'))
  assert.ok(registered.size > 0, '一个模块都没注册？')
  assert.ok(imported.size > 0)
})

test('模块 id 唯一、且形状合法（小写字母/数字/连字符，不以 _ 开头）', () => {
  const seen = new Map()
  const dup = []
  const bad = []
  for (const m of real) {
    if (!m.id) bad.push(m.rel)
    else if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(m.id)) bad.push(`${m.rel}（id=${m.id}）`)
    if (m.id) {
      if (seen.has(m.id)) dup.push(`${m.id}（${seen.get(m.id)} 与 ${m.rel}）`)
      else seen.set(m.id, m.rel)
    }
  }
  assert.deepEqual(bad, [], `id 缺失或形状不对：${bad.join('、')}`)
  assert.deepEqual(dup, [], `id 重复（注册表里后一个会覆盖前一个）：${dup.join('、')}`)
})

/* ------------------------------------------------ ② 图标白名单 --- */

test('src/main.ts 的两处图标白名单必须一致（import 与 ICONS 映射）', () => {
  const { imported, keys, anchors } = scanMainIcons(ROOT)
  assert.equal(anchors.length, 2, 'src/main.ts 里应有 2 个 `// ↓ 新图标加在这里` 锚点（import 与 ICONS 各一个）')
  const onlyImport = [...imported].filter((x) => !keys.has(x)).sort()
  const onlyIcons = [...keys].filter((x) => !imported.has(x)).sort()
  assert.deepEqual(onlyImport, [], `这些只在 import 里、没进 ICONS 映射：${onlyImport.join('、')}`)
  assert.deepEqual(onlyIcons, [], `这些只在 ICONS 映射里、没 import：${onlyIcons.join('、')}`)
})

test('模块 / 路由 / 分组用到的图标名都在白名单里（emoji 除外）', () => {
  const { keys } = scanMainIcons(ROOT)
  const used = new Map() // 图标名 → 用它的地方
  const note = (icon, where) => {
    if (!iconLike(icon)) return // emoji 或别的写法：不参与白名单检查
    if (!used.has(icon)) used.set(icon, [])
    used.get(icon).push(where)
  }
  for (const m of modules) {
    note(m.icon, `${m.rel} 的 icon`)
    for (const r of m.routes) note(r.icon, `${m.rel} 的 meta.icon`)
  }
  for (const g of scanGroupIcons(ROOT).icons) note(g, 'core/types.ts 的 MODULE_GROUPS')

  const missing = [...used.keys()].filter((i) => !keys.has(i)).sort()
  const detail = missing.map((i) => `  ${i} ← ${used.get(i).join('、')}`).join('\n')
  assert.deepEqual(
    missing,
    [],
    `这些图标没进 src/main.ts 的白名单（漏了 = 那块空白，而构建照样过）：\n${detail}\n` +
      '  修法：往 src/main.ts 的两个 `// ↓ 新图标加在这里` 锚点各加一行（import 与 ICONS 都要）；\n' +
      '  模板目录的 README.md 里也写了这一条。',
  )
})

/* ------------------------------------------------ ③ 路由 --- */

test('每个模块至少一条路由，homePath 是绝对路径，且在组内 order 不撞号', () => {
  const problems = []
  for (const m of real) {
    if (!m.routes.length) problems.push(`${m.rel} 没有任何路由`)
    if (!m.homePath || !m.homePath.startsWith('/')) problems.push(`${m.rel} 的 homePath 不是绝对路径：${m.homePath}`)
  }
  assert.deepEqual(problems, [], problems.join('\n'))

  // order 号段约定：同组内不重复（置顶区 = 没有 category 的那些）
  // 模板不参与 —— 它固定 100，不该因为别人也取 100 而报错
  const groups = new Map()
  for (const m of real) {
    const key = m.category ?? '（置顶）'
    if (!groups.has(key)) groups.set(key, new Map())
    const bucket = groups.get(key)
    const o = m.order ?? 100
    if (bucket.has(o)) bucket.get(o).push(m.rel)
    else bucket.set(o, [m.rel])
  }
  const clashes = []
  for (const [g, bucket] of groups) {
    for (const [o, rels] of bucket) if (rels.length > 1) clashes.push(`${g} 组 order=${o}：${rels.join('、')}`)
  }
  assert.deepEqual(clashes, [], `同组内 order 撞号（侧边栏顺序会变得看运气）：\n  ${clashes.join('\n  ')}`)
})

test('路由 path 全局唯一、name 全局唯一', () => {
  const paths = new Map()
  const names = new Map()
  const dupPath = []
  const dupName = []
  for (const m of modules) {
    for (const r of m.routes) {
      if (!r.path) continue
      if (paths.has(r.path)) dupPath.push(`${r.path}（${paths.get(r.path)} 与 ${m.rel}）`)
      else paths.set(r.path, m.rel)
      if (r.name) {
        if (names.has(r.name)) dupName.push(`${r.name}（${names.get(r.name)} 与 ${m.rel}）`)
        else names.set(r.name, m.rel)
      }
    }
  }
  assert.deepEqual(dupPath, [], `路由 path 重复（后来者覆盖前者，页面会打不开）：${dupPath.join('、')}`)
  assert.deepEqual(dupName, [], `路由 name 重复（vue-router 会告警并覆盖）：${dupName.join('、')}`)
})

test('每条路由的 component 都是懒加载，且指向真实存在的 .vue', () => {
  const problems = []
  for (const m of modules) {
    for (const r of m.routes) {
      if (!r.component) {
        problems.push(`${m.rel} 的 ${r.path ?? '（无 path）'}：component 既不是 () => import('./X.vue')，也不是文件内 const X = () => import('./X.vue')`)
        continue
      }
      if (!r.component.startsWith('.')) {
        problems.push(`${m.rel} 的 ${r.path}：component 指向 ${r.component}，看起来不是相对路径`)
        continue
      }
      const abs = path.resolve(path.dirname(m.abs), r.component)
      if (!fs.existsSync(abs)) problems.push(`${m.rel} 的 ${r.path}：文件不存在 → ${r.component}`)
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'))
})

/* --------------------------------- ④ visible() 引用的配置项要真存在 --- */

test('模块 visible() 里 cfgFilled/cfgGet 引用的配置项都在 DEFAULTS 里存在', () => {
  const get = (obj, dotted) => dotted.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj)
  const missing = []
  for (const m of real) {
    for (const p of m.cfgPaths) {
      if (get(DEFAULTS, p) === undefined) missing.push(`${m.rel} → ${p}`)
    }
  }
  assert.deepEqual(
    missing,
    [],
    `这些配置项在模块里被当作存在去读，但 DEFAULTS 里没有：${missing.join('、')}\n` +
      '  「没配 = 不显示」的前提是这一项真的存在；不存在的项 `cfgFilled()` 永远为 false，模块会永远隐藏。',
  )
})

test('模块 category 只能是 MODULE_GROUPS 里有的那几个', () => {
  // 真实来源是 core/types.ts 的 MODULE_GROUPS（这里读一遍，别再手抄一份）
  const allowed = new Set(scanGroupIds(ROOT))
  const bad = real.filter((m) => m.category && !allowed.has(m.category)).map((m) => `${m.rel}（category=${m.category}）`)
  assert.deepEqual(bad, [], `分组 id 不在 MODULE_GROUPS 里，模块不会出现在任何分组：${bad.join('、')}`)
})

/* ------------------------------------------------ ⑤ 模板本身别烂掉 --- */

test('_template 目录仍然是一个「形状合法」的模块（图标在白名单、路由指向真实文件）', () => {
  assert.equal(templates.length, 1, '应当恰好有一个下划线开头的模板目录（src/features/_template/）')
  const t = templates[0]
  assert.ok(t.id, '模板里的 id 读不出来')
  assert.ok(t.routes.length, '模板里没有路由')
  const { keys } = scanMainIcons(ROOT)
  for (const [label, icon] of [['icon', t.icon], ...t.routes.map((r) => [`meta.icon(${r.path})`, r.icon])]) {
    if (!iconLike(icon)) continue
    assert.ok(keys.has(icon), `模板的 ${label}（${icon}）不在白名单里 —— 生成出来的模块也会是空白图标`)
  }
  for (const r of t.routes) {
    assert.ok(r.component, `模板的 ${r.path} 认不出 component`)
    assert.ok(
      fs.existsSync(path.resolve(path.dirname(t.abs), r.component)),
      `模板的 ${r.path} 指向的文件不存在：${r.component}`,
    )
  }
})

test('src/features 下没有空目录（空目录 = 半拉子模块，注册表看不见它）', () => {
  const dir = path.join(ROOT, 'src', 'features')
  const empty = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const sub = path.join(dir, e.name)
    if (!fs.readdirSync(sub).length) empty.push(e.name)
  }
  assert.deepEqual(empty, [], `这些目录是空的（删掉，或者把模块文件补上）：${empty.join('、')}`)
})
