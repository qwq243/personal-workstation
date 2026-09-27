#!/usr/bin/env node
/**
 * 加一个功能模块 —— 一条命令把「三步法」里那些手改动作全做完。
 *
 *   node scripts/new-feature.mjs <id> [选项]        （选项见 --help）
 *
 * 例：
 *   node scripts/new-feature.mjs reading --name 阅读笔记 --icon Reading --group study
 *   node scripts/new-feature.mjs reading --name 阅读笔记 --icon Reading --group study --api --config
 *   node scripts/new-feature.mjs reading --name 阅读笔记 --icon Reading --dry-run
 *
 * 它会做这些事（骨架取自 `src/features/_template/`，所以改模板这里跟着改）：
 *   ① 建 `src/features/<id>/module.ts` 与 `src/features/<id>/<Pascal>Home.vue`；
 *   ② 在 `src/features/index.ts` 的锚点处插 `import` 与 `registerModule()`；
 *   ③ 把 `--icon` 的名字**同时**插进 `src/main.ts` 的两处白名单（靠 `// ↓ 新图标加在这里` 锚点，
 *      两处本来就不一致就报错退出 —— 那正是「图标空白但构建照样过」的成因）；
 *   ④ `--api`：再生成 `server/lib/<id>.mjs`（createJsonStore 骨架）、在 `server/index.mjs` 挂
 *      两条路由、在 `src/core/sidecar.ts` 加两条客户端方法，并把页面里那两行注释放开；
 *   ⑤ `--config`：在 `server/config.mjs`、`server/lib/config-editable.mjs`、
 *      `server/config.example.json` 三处各插一条（漏一处 `npm test` 会点名）。
 *
 * 四条设计决定，别改：
 *  1. **先规划、后落盘**。锚点先在内存里找齐、冲突先查完，任何一步不成立就整体不动
 *     —— 半途失败留下的是「注册了但没图标」这种最难查的状态。
 *  2. **所有插入都是「一次算好下标，再按从后往前应用」**（`applyEdits`）。
 *     边插边重算下标是这个脚本最容易出 bug 的地方，上一个版本就栽在这儿。
 *  3. **不猜**：图标名要能在 `@element-plus/icons-vue` 里找到才放行；id / 路由 path / 路由 name
 *     撞车直接拒绝。判据用的是 `scripts/lib/feature-scan.mjs` —— 和契约测试同一套。
 *  4. **换行符跟着目标文件走**。工作树可能是 CRLF（本仓库在 Windows 上就是），
 *     插进去的必须是同一种，否则 diff 里会混出满屏噪声。
 */
import fs from 'node:fs'
import path from 'node:path'

import { ROOT, findAnchorLine, matchBracket, scanMainIcons, scanModules, scanRegistered } from './lib/feature-scan.mjs'

/* --------------------------------------------------------------- 参数 --- */

const GROUPS = ['growth', 'office', 'study', 'todo', 'campus']
const MODULE_OPTIONS = ['name', 'desc', 'icon', 'group', 'order', 'path']

function usage(code = 0) {
  console.log(
    `
用法：node scripts/new-feature.mjs <id> [选项]

  <id>                功能的英文短名。同时是目录名 / 路由前缀 / localStorage 命名空间，
                      定下就别改。只允许小写字母、数字与连字符，必须以字母开头。
  --name <中文名>     侧边栏与卡片上显示的名字（缺省 = 用 id）
  --desc <一句话>     功能卡片上的一句话说明
  --icon <图标名>     Element Plus 图标名（如 Reading）。必须是 @element-plus/icons-vue
                      的真实导出；缺省用 Grid。
  --group <组>        归组：${GROUPS.join(' / ')}。不填 = 置顶入口（不参与分组）
  --order <数字>      组内排序，越小越靠前。缺省自动取该组当前最大值 +1
  --path <路由>       首页路由，缺省 /<id>
  --api               连边车一起生成（server/lib/<id>.mjs + 路由 + 客户端方法）
  --config            连配置一起生成（DEFAULTS + 白名单 + config.example.json）
  --dry-run           只打印会改哪些文件，不落盘
  -h, --help          看这段

生成完：
  npm run build && npm run typecheck && npm test
  npm run dev:all     # 打开侧边栏看新条目
`.trim(),
  )
  process.exit(code)
}

function parseArgs(argv) {
  const out = { id: null, flags: {} }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') usage(0)
    if (a === '--api') { out.flags.api = true; continue }
    if (a === '--config') { out.flags.config = true; continue }
    if (a === '--dry-run') { out.flags.dryRun = true; continue }
    if (a.startsWith('--')) {
      const key = a.slice(2)
      if (!MODULE_OPTIONS.includes(key)) {
        console.error(`未知选项：${a}（--help 看用法）`)
        process.exit(2)
      }
      const val = argv[++i]
      if (val === undefined) { console.error(`选项 ${a} 缺值`); process.exit(2) }
      out.flags[key] = val
      continue
    }
    rest.push(a)
  }
  out.id = rest[0] ?? null
  if (!out.id) usage(2)
  return out
}

/* --------------------------------------------------------------- 工具 --- */

const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n')
const toLines = (text) => text.split(/\r?\n/)
/** 文本里某个下标在第几行（0 起） */
const lineIndexAt = (text, index) => text.slice(0, index).split(/\r?\n/).length - 1
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/')

const pascal = (id) => id.split(/[-_]/).filter(Boolean).map((s) => s[0].toUpperCase() + s.slice(1)).join('')
const camel = (id) => {
  const p = pascal(id)
  return p ? p[0].toLowerCase() + p.slice(1) : p
}

/**
 * 在「按字母序排好的名字列表」里算出该往哪插一个名字。
 * 返回的是**基于原文的下标 + 要插的片段**，由 `applyEdits` 统一应用。
 * `[from, to)` 是名字列表的范围（不含 `import` 关键字与 `from '…'`）。
 */
function sortInsertAt(text, from, to, name) {
  const region = text.slice(from, to)
  const tokens = [...region.matchAll(/\b([A-Z][A-Za-z0-9]*)\b/g)]
  if (!tokens.length) return null
  if (tokens.some((t) => t[1] === name)) return null // 已经在里面了
  const lower = name.toLowerCase()
  const target = tokens.find((t) => t[1].toLowerCase() > lower)
  if (target) return { at: from + target.index, snippet: `${name}, ` }
  const last = tokens[tokens.length - 1]
  return { at: from + last.index + last[1].length, snippet: `, ${name}` }
}

/** 按下标**从后往前**应用所有插入，这样前面的下标不会被插进去的内容顶掉 */
function applyEdits(text, edits) {
  let out = text
  for (const e of [...edits].filter(Boolean).sort((a, b) => b.at - a.at)) {
    out = out.slice(0, e.at) + e.snippet + out.slice(e.at)
  }
  return out
}

/** 往第 line 行之前插若干行（行号基于原文） */
function insertLinesAt(text, line, lines) {
  const arr = toLines(text)
  arr.splice(line, 0, ...lines)
  return arr.join(eolOf(text))
}

/* ------------------------------------------------------------ 规划阶段 --- */

const args = parseArgs(process.argv.slice(2))
const id = args.id
const f = args.flags
const problems = []

if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(id)) problems.push(`id 不合法：${id}（只允许小写字母 / 数字 / 连字符，且以字母开头）`)
if (id.startsWith('_')) problems.push(`id 不能以下划线开头（那是「这不是模块」的目录约定）：${id}`)

const group = f.group ?? null
if (group && !GROUPS.includes(group)) problems.push(`--group 只能是：${GROUPS.join(' / ')}（收到 ${group}）`)
const icon = f.icon ?? 'Grid'
if (!/^[A-Z][A-Za-z0-9]*$/.test(icon)) problems.push(`--icon 要给 Element Plus 的图标名（形如 Reading），收到：${icon}`)
const orderGiven = f.order !== undefined ? Number(f.order) : null
if (orderGiven !== null && (!Number.isInteger(orderGiven) || orderGiven < 0)) problems.push(`--order 要给非负整数，收到：${f.order}`)

const mods = scanModules(ROOT)
const existing = mods.filter((m) => !m.isTemplate)
const ids = new Set(existing.map((m) => m.id))
const allPaths = new Set(mods.flatMap((m) => m.routes.map((r) => r.path)))
const allRouteNames = new Set(mods.flatMap((m) => m.routes.map((r) => r.name)))

const routePath = f.path ? (f.path.startsWith('/') ? f.path : `/${f.path}`) : `/${id}`
if (ids.has(id)) problems.push(`id 已被占用：${id}（已有模块：${[...ids].sort().join(', ')}）`)
if (allPaths.has(routePath)) problems.push(`路由已被占用：${routePath}`)
if (allRouteNames.has(`${id}-home`)) problems.push(`路由 name 已被占用：${id}-home`)

const moduleDir = path.join(ROOT, 'src', 'features', id)
const moduleFile = path.join(moduleDir, 'module.ts')
const pageFile = path.join(moduleDir, `${pascal(id)}Home.vue`)
if (fs.existsSync(moduleDir)) problems.push(`目录已存在：src/features/${id}/`)

const sameGroup = existing.filter((m) => (group ? m.category === group : !m.category))
const order = orderGiven ?? (sameGroup.length ? Math.max(...sameGroup.map((m) => m.order ?? 100)) + 1 : 10)

const cfg = {
  id,
  camel: camel(id),
  name: f.name ?? id,
  desc: f.desc ?? '一句话说明这个功能干什么（改这一行）',
  icon,
  group,
  order,
  path: routePath,
}

const TEMPLATE_DIR = path.join(ROOT, 'src', 'features', '_template')
const tplModule = path.join(TEMPLATE_DIR, 'module.ts')
const tplPage = path.join(TEMPLATE_DIR, 'TemplateHome.vue')
/** 模板里那句「占位说明」的原文 —— 字符串替换的第 8 条认的就是它（见模板目录的 README.md） */
const DESC_TOKEN = '一句话说明这个功能干什么（改这一行）'
for (const p of [tplModule, tplPage]) if (!fs.existsSync(p)) problems.push(`模板缺失：${rel(p)}`)

// 图标名要真存在（拿已装的包对一下；包不在就只提示，不阻断）
let iconNote = ''
try {
  const icons = await import('@element-plus/icons-vue')
  if (!(icon in icons)) problems.push(`@element-plus/icons-vue 里没有这个导出：${icon}（名字写错的话连「空白图标」都不会有）`)
} catch {
  iconNote = '没能加载 @element-plus/icons-vue 校验图标名 —— 先 npm install 更稳'
}

/* ---- 读要改的文件，先找齐锚点 ---- */

const F = {
  index: path.join(ROOT, 'src', 'features', 'index.ts'),
  main: path.join(ROOT, 'src', 'main.ts'),
  sidecar: path.join(ROOT, 'src', 'core', 'sidecar.ts'),
  serverIndex: path.join(ROOT, 'server', 'index.mjs'),
  configMjs: path.join(ROOT, 'server', 'config.mjs'),
  configEditable: path.join(ROOT, 'server', 'lib', 'config-editable.mjs'),
  configExample: path.join(ROOT, 'server', 'config.example.json'),
}
const reads = new Map()
const read = (p) => {
  if (!reads.has(p)) reads.set(p, fs.readFileSync(p, 'utf8'))
  return reads.get(p)
}

const A = {
  indexImport: '// ↓ 新模块 import 加在这里',
  indexRegister: '// ↓ 下一个功能加在这里',
  icon: '// ↓ 新图标加在这里',
  sidecarApi: '// ↓ 新接口加在这里',
  serverRoute: '// ↓ 新接口加在这里',
  defaults: '// ↓ 新配置分节加在这里',
  editable: '// ↓ 新分节加在这里',
  example: '"// ↓ 新配置写在这里"',
}

const anchors = {}
function needAnchor(label, file, needle) {
  const at = findAnchorLine(read(file), needle)
  if (!at) problems.push(`锚点找不到：${rel(file)} 里的「${needle}」`)
  anchors[label] = at
}
needAnchor('indexImport', F.index, A.indexImport)
needAnchor('indexRegister', F.index, A.indexRegister)
needAnchor('sidecarApi', F.sidecar, A.sidecarApi)
needAnchor('serverRoute', F.serverIndex, A.serverRoute)
if (f.api) {
  const all = [...read(F.serverIndex).matchAll(/^import \* as [A-Za-z0-9_$]+ from '\.\/lib\/[^']+\.mjs'/gm)]
  if (!all.length) problems.push(`在 ${rel(F.serverIndex)} 里找不到 \`import * as x from './lib/x.mjs'\` 这类导入行`)
  else anchors.serverImport = { at: all[all.length - 1].index + all[all.length - 1][0].length, snippet: '' }
}
if (f.config) {
  needAnchor('defaults', F.configMjs, A.defaults)
  needAnchor('editable', F.configEditable, A.editable)
  needAnchor('example', F.configExample, A.example)
}

// 图标那两处：`findAnchorLine` 只给第一处，这里要两处都拿到
const mainText = read(F.main)
const iconAnchors = []
for (let from = 0; ; ) {
  const at = mainText.indexOf(A.icon, from)
  if (at < 0) break
  iconAnchors.push(at)
  from = at + A.icon.length
}
let iconEdits = []
if (iconAnchors.length < 2) {
  problems.push(`${rel(F.main)} 里的「${A.icon}」锚点应有 2 处（import 与 ICONS），实际 ${iconAnchors.length} 处`)
} else {
  const scan = scanMainIcons(ROOT)
  const onlyImport = [...scan.imported].filter((x) => !scan.keys.has(x))
  const onlyIcons = [...scan.keys].filter((x) => !scan.imported.has(x))
  if (onlyImport.length || onlyIcons.length) {
    problems.push(
      `${rel(F.main)} 的两处图标白名单**本来就不一致**，先修好再来：` +
        `只在 import 里：${onlyImport.join('、') || '无'}；只在 ICONS 里：${onlyIcons.join('、') || '无'}`,
    )
  } else {
    const importBrace = mainText.indexOf('{', iconAnchors[0])
    const importClose = mainText.indexOf(`} from '@element-plus/icons-vue'`, iconAnchors[0])
    const iconsBrace = mainText.indexOf('{', iconAnchors[1])
    const iconsClose = iconsBrace > 0 ? matchBracket(mainText, iconsBrace, '{', '}') : -1
    if (importClose < 0 || iconsClose < 0) {
      problems.push(`${rel(F.main)} 的白名单结构认不出来（期望 \`import {…} from '@element-plus/icons-vue'\` 与一个 ICONS 对象字面量）`)
    } else {
      iconEdits = [
        sortInsertAt(mainText, importBrace + 1, importClose, icon),
        sortInsertAt(mainText, iconsBrace + 1, iconsClose, icon),
      ].filter(Boolean)
    }
  }
}

/* ---- 模板渲染 + 自检（也放在规划阶段：问题和其他冲突一起报、一起中止） ---- */

const pageText = render(read(tplPage), cfg, { config: !!f.config })
const moduleText = render(read(tplModule), cfg, { config: !!f.config })
{
  // 真踩过：朴素的 `/template` 替换把 `</template>` 改成了 `</reading>`，生成的 .vue 语法错误。
  // 所以这一步是硬检查 —— 宁可在这里中止，也别让人 build 到一半看到 SFC 报错。
  const sfcErrors = await checkSfc(pageText)
  if (sfcErrors === null) problems.push('校验页面用的 @vue/compiler-sfc 加载不到 —— 先 npm install 再生成')
  else if (sfcErrors.length) problems.push(`${pascal(id)}Home.vue 模板替换后不是合法 SFC：${sfcErrors.join('；')}`)
}
const libFile = path.join(ROOT, 'server', 'lib', `${id}.mjs`)
if (f.api && fs.existsSync(libFile)) problems.push(`文件已存在：${rel(libFile)}`)

if (problems.length) {
  console.error('\n生成中止，什么都没改：\n')
  for (const p of problems) console.error(`  ✗ ${p}`)
  if (ids.size) console.error(`\n已有模块 id：${[...ids].sort().join(', ')}`)
  process.exit(2)
}

/* ---- 把每个文件的新内容算出来（内存里），再统一落盘 ---- */

const writes = []

// ① 新模块两个文件
writes.push({ file: pageFile, content: pageText, kind: 'new' })
writes.push({ file: moduleFile, content: moduleText, kind: 'new' })

// ② features/index.ts：先插 register（行号更靠后），再插 import
{
  const text = read(F.index)
  const withRegister = insertLinesAt(text, lineIndexAt(text, anchors.indexRegister.lineStart), [`  registerModule(${cfg.camel}Module)`])
  const afterImport = insertLinesAt(withRegister, lineIndexAt(text, anchors.indexImport.lineStart) + 1, [`import { ${cfg.camel}Module } from './${id}/module'`])
  writes.push({ file: F.index, content: afterImport, kind: 'edit' })
}

// ③ src/main.ts 两处图标
if (iconEdits.length) writes.push({ file: F.main, content: applyEdits(mainText, iconEdits), kind: 'edit' })

// ④ --api
if (f.api) {
  writes.push({ file: libFile, content: libSkeleton(cfg), kind: 'new' })

  {
    const text = read(F.serverIndex)
    const importEdit = { at: anchors.serverImport.at, snippet: `${eolOf(text)}import * as ${cfg.camel} from './lib/${id}.mjs'` }
    const routeEdit = { at: anchors.serverRoute.lineStart, snippet: routeBlock(cfg).map((l) => `${l}${eolOf(text)}`).join('') }
    writes.push({ file: F.serverIndex, content: applyEdits(text, [importEdit, routeEdit]), kind: 'edit' })
  }
  {
    const text = read(F.sidecar)
    const edit = { at: anchors.sidecarApi.lineStart, snippet: clientBlock(cfg).map((l) => `${l}${eolOf(text)}`).join('') }
    writes.push({ file: F.sidecar, content: applyEdits(text, [edit]), kind: 'edit' })
  }
  // 页面里那两行注释放开
  {
    const idx = writes.findIndex((w) => w.file === pageFile)
    writes[idx].content = toLines(writes[idx].content)
      .map((l) => {
        const t = l.trim()
        if (t === '// const r = await api.templateItems()') return `  const r = await api.${cfg.camel}Items()`
        if (t === '// if (r.ok) items.value = r.data?.items ?? []') return '  if (r.ok) items.value = r.data?.items ?? []'
        return l
      })
      .join(eolOf(writes[idx].content))
  }
}

// ⑤ --config 三处
if (f.config) {
  {
    const text = read(F.configMjs)
    writes.push({
      file: F.configMjs,
      kind: 'edit',
      content: insertLinesAt(text, lineIndexAt(text, anchors.defaults.lineStart), [
        '  /**',
        `   * ${cfg.name}：库目录留空 = 该模块不在侧边栏显示`,
        '   *',
        `   * 「没配 = 不显示」是内核约定（见 src/core/appconfig.ts）；模块侧对应`,
        `   * \`visible: () => cfgFilled('${cfg.camel}.dir')\`（生成器已在 module.ts 里放开这一行）。`,
        '   */',
        `  ${cfg.camel}: { dir: '' },`,
      ]),
    })
  }
  {
    const text = read(F.configEditable)
    writes.push({
      file: F.configEditable,
      kind: 'edit',
      content: insertLinesAt(text, lineIndexAt(text, anchors.editable.lineStart), [
        `  // ${cfg.name}（new-feature.mjs 生成：值是对象 → 放这张分节表；值是标量才放下面那张）`,
        `  ${cfg.camel}: ['dir'],`,
      ]),
    })
  }
  {
    const text = read(F.configExample)
    writes.push({
      file: F.configExample,
      kind: 'edit',
      content: insertLinesAt(text, lineIndexAt(text, anchors.example.lineStart), [
        `  "// ${cfg.camel}": "${cfg.name}：dir 留空则该模块从侧边栏隐藏（路径写正斜杠）",`,
        `  "${cfg.camel}": { "dir": "" },`,
      ]),
    })
  }
}

/* ---- 落盘 ---- */

if (f.dryRun) {
  console.log('\n--dry-run：只列会改哪些文件，什么都没写。\n')
  for (const w of writes) console.log(`  ${w.kind === 'new' ? '新建' : '修改'}  ${rel(w.file)}`)
  console.log(`\n模块：id=${cfg.id}  name=${cfg.name}  icon=${cfg.icon}  route=${cfg.path}  group=${cfg.group ?? '（置顶）'}  order=${cfg.order}`)
  process.exit(0)
}

for (const w of writes) {
  fs.mkdirSync(path.dirname(w.file), { recursive: true })
  fs.writeFileSync(w.file, w.content, 'utf8')
}

/* ---- 落盘后自检：用契约测试那套判据再读一遍 ---- */

const after = scanModules(ROOT).find((m) => m.id === cfg.id)
const afterReg = scanRegistered(ROOT)
const afterIcons = scanMainIcons(ROOT)
const selfCheck = []
if (!after) selfCheck.push('新模块文件读不回来（模板替换可能出错）')
else {
  if (after.routes.length !== 1) selfCheck.push(`期望 1 条路由，实际 ${after.routes.length}`)
  if (after.icon !== cfg.icon) selfCheck.push(`module.ts 里的 icon 是 ${after.icon}，期望 ${cfg.icon}`)
  if (after.id !== cfg.id) selfCheck.push(`module.ts 里的 id 是 ${after.id}，期望 ${cfg.id}`)
  if (cfg.group && after.category !== cfg.group) selfCheck.push(`module.ts 里的 category 是 ${after.category}，期望 ${cfg.group}`)
  if (!cfg.group && after.category) selfCheck.push(`没传 --group，但 module.ts 里有 category=${after.category}`)
  if (after.order !== cfg.order) selfCheck.push(`module.ts 里的 order 是 ${after.order}，期望 ${cfg.order}`)
  if (f.config && !after.cfgPaths.includes(`${cfg.camel}.dir`)) {
    selfCheck.push(`--config 传了，但 visible() 里没看到 cfgFilled('${cfg.camel}.dir')`)
  }
  if (!after.routes.every((r) => r.component && fs.existsSync(path.join(moduleDir, r.component.replace('./', ''))))) {
    selfCheck.push('路由指向的 .vue 文件对不上')
  }
  if (!afterIcons.keys.has(cfg.icon)) selfCheck.push(`图标 ${cfg.icon} 没进 src/main.ts 的 ICONS 映射`)
  if (!afterIcons.imported.has(cfg.icon)) selfCheck.push(`图标 ${cfg.icon} 没进 src/main.ts 的 import`)
  if (!afterReg.registered.has(`${cfg.camel}Module`)) selfCheck.push(`registerModule(${cfg.camel}Module) 没插进 src/features/index.ts`)
}

console.log('\n已生成：\n')
for (const w of writes) console.log(`  ${w.kind === 'new' ? '新建' : '修改'}  ${rel(w.file)}`)
console.log(`\n模块：id=${cfg.id}  name=${cfg.name}  icon=${cfg.icon}  route=${cfg.path}`)
console.log(`      group=${cfg.group ?? '（置顶，不参与分组）'}  order=${cfg.order}  注册表：${afterReg.registered.size} 个模块`)
if (iconNote) console.log(`  ! ${iconNote}`)
if (f.api) console.log(`\n接口骨架：GET /api/${id}/items 与 POST /api/${id}/item（server/lib/${id}.mjs，按需改）`)
if (f.config) console.log(`配置骨架：${cfg.camel}.dir（DEFAULTS + 白名单 + config.example.json 三处都加了）`)

if (selfCheck.length) {
  console.error('\n⚠️  自检发现问题，请手工看一眼：')
  for (const s of selfCheck) console.error(`   ✗ ${s}`)
}

console.log(
  [
    '',
    '下一步：',
    '  npm run build && npm run typecheck && npm test',
    '  npm run dev:all                     # 打开侧边栏看新条目',
    `侧边栏 / 首页的条目数应该从 ${afterReg.registered.size - 1} 变成 ${afterReg.registered.size}。`,
    `要撤掉这次生成：删掉 src/features/${id}/ 目录${f.api ? ` 与 server/lib/${id}.mjs` : ''}，再按上面标「修改」的那几个文件手工回退。`,
    '',
  ].join('\n'),
)

/* ------------------------------------------------------------- 自检 --- */

/**
 * 用 `@vue/compiler-sfc` 解析一遍生成的页面，返回错误信息数组。
 * 包加载不到时返回 `null`（调用方据此提示「先 npm install」，而不是假装通过）。
 *
 * 为什么值得做：模板替换是纯文本操作，最容易出的就是把标签/引号改坏，
 * 而那种坏法在 `npm run build` 才暴露 —— 那时用户已经以为生成成功了。
 */
async function checkSfc(source) {
  let parse
  try {
    ;({ parse } = await import('@vue/compiler-sfc'))
  } catch {
    return null
  }
  const { errors } = parse(source, { filename: 'generated.vue' })
  return errors.map((e) => (typeof e === 'string' ? e : e.message))
}

/* ------------------------------------------------------- 生成的内容 --- */

/** `src/features/_template/` → 真值。分两步：先是字符串替换，再是整行处理（见模板的 README.md） */function render(templateText, c, { config = false } = {}) {
  return renderLines(renderStrings(templateText, c), c, { config })
}

/** 第 1~9 条：字符串替换。**顺序有意义** —— 长串必须早于 `'template'` */
function renderStrings(templateText, c) {
  let out = templateText
  out = out.split('TemplateHome').join(`${pascal(c.id)}Home`)
  out = out.split('templateModule').join(`${c.camel}Module`)
  out = out.split("'template-home'").join(`'${c.id}-home'`)
  out = out.split("'template'").join(`'${c.id}'`)
  out = out.split('template.dir').join(`${c.camel}.dir`)
  /**
   * 路由字面量：`'/template'`、`#/template`、`homePath: '/template'`。
   * ⚠️ **不能用朴素的 `split('/template')`** —— 它会把 `</template>` 也换成 `</reading>`，
   * 于是生成的 .vue 直接语法错误（真踩过，见本文件末尾的 SFC 自检）。
   * 所以用「前面不能是 `<` 或字母数字、后面不能是 `-` 或字母数字」来限定。
   */
  out = out.replace(/(?<![<\w])\/template(?![-\w])/g, `/${c.path.replace(/^\//, '')}`)
  out = out.split('功能模板').join(c.name)
  out = out.split(DESC_TOKEN).join(c.desc)
  // 图标名在 .ts 里是单引号、在 .vue 的模板属性里是双引号 —— 两种都要换，否则页面头部会留着模板的 Grid
  out = out.split("'Grid'").join(`'${c.icon}'`)
  out = out.split('"Grid"').join(`"${c.icon}"`)
  return out
}

/**
 * 第 10~13 条：整行处理。
 *
 * 判据是「这一行去掉前导空白后以什么开头」——刻意不用 `$` 锚定行尾：
 * 本仓库工作树是 CRLF，`$` 在 `\r` 前不成立（`//.*$` 那个坑就是这么踩的）。
 */
function renderLines(text, c, { config = false } = {}) {
  const lines = toLines(text).map((line) => {
    const t = line.trim()
    // 10. order：总是覆盖成算出来的号
    if (/^order:\s*\d+,/.test(t)) return `  order: ${c.order},`
    // 11. category：只有带 --group 才放开
    if (c.group && t.startsWith('// category:')) return `  category: '${c.group}',`
    // 12/13. visible 与它的 import：只有带 --config 才放开
    if (config && t.startsWith('// visible: () => cfgFilled(')) return `  ${t.slice(3)}`
    if (config && t.startsWith('// import { cfgFilled }')) return t.slice(3)
    return line
  })
  return lines.join(eolOf(text))
}

/** `server/lib/<id>.mjs` 的骨架（照 docs/EXTENDING.md §3.1） */
function libSkeleton(c) {
  return `/**
 * ${c.name} —— ${c.id} 模块的边车能力。
 *
 * 「一件事一个文件」的能力库：server/index.mjs 里那两条 \`/api/${c.id}/*\` 路由只是它的薄封装。
 * **只 import \`node:\` 内置模块与相对路径** —— 边车零第三方依赖是硬约束（docs/ARCHITECTURE.md §5）。
 */
import path from 'node:path'
import { dataDir } from '../config.mjs'
import { createJsonStore } from './jsonstore.mjs'

const VERSION = 1

const store = createJsonStore({
  name: '${c.id}',
  file: () => path.join(dataDir(), '${c.id}.json'),
  version: VERSION,
  empty: () => ({ version: VERSION, rev: 0, updatedAt: 0, items: [] }),
  migrate: (raw) => ({
    version: VERSION,
    rev: raw.rev,
    updatedAt: raw.updatedAt,
    items: Array.isArray(raw.items) ? raw.items : [],
  }),
  backupDir: () => path.join(dataDir(), 'backups'),
})

export function list({ limit = 200 } = {}) {
  return { ok: true, items: store.read().items.slice(0, limit) }
}

export function add(text) {
  const t = String(text ?? '').trim()
  if (!t) return { ok: false, error: '内容不能为空' }
  const cur = store.read()
  const item = { id: \`i_\${Date.now().toString(36)}\`, text: t.slice(0, 500), at: Date.now() }
  const { data, conflict } = store.write({ items: [item, ...cur.items] }, { baseRev: cur.rev, source: 'web' })
  return { ok: true, item, rev: data.rev, conflict: conflict?.copy ?? null }
}
`
}

/** `server/index.mjs` 里要插的两条路由 */
function routeBlock(c) {
  return [
    '',
    `/* --- ${c.name}（new-feature.mjs 生成的骨架，按需改） --- */`,
    '',
    `route('GET', /^\\/api\\/${c.id}\\/items$/, (req, { query }) => ${c.camel}.list({ limit: Number(query.limit) || 200 }))`,
    `/** 失败也返回 200 + { ok:false, error }（本仓库统一风格），见 docs/EXTENDING.md §3.2 */`,
    `route('POST', /^\\/api\\/${c.id}\\/item$/, (req, { body }) => ${c.camel}.add(String(body?.text ?? '')))`,
    '',
  ]
}

/** `src/core/sidecar.ts` 里要插的两条客户端方法 */
function clientBlock(c) {
  return [
    '',
    `  /* ${c.name}（new-feature.mjs 生成的骨架，按需改） */`,
    `  ${c.camel}Items: (limit = 200) => call(\`/api/${c.id}/items?limit=\${limit}\`),`,
    `  ${c.camel}Add: (text: string) => call('/api/${c.id}/item', { method: 'POST', body: { text } }),`,
    '',
  ]
}
