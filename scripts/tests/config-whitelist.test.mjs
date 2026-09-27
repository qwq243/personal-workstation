/**
 * 配置白名单的一致性护栏（node:test，零依赖、不连网、不读真实数据）。
 *
 *   npm test          # 或 node --test scripts/tests/
 *
 * 为什么需要它：**配置项有三份，加一项要同时改三处**，而漏一处不会报错、
 * 只会在某个页面上表现为「保存永远失败」或「这一项谁也改不动」：
 *
 *   1. `server/config.mjs` 的 `DEFAULTS`                   —— 这一项存在，且有出厂值
 *   2. `server/lib/config-editable.mjs` 的两张白名单      —— 页面上改得动
 *   3. `server/config.example.json`                        —— 别人知道有这一项、怎么填
 *
 * 已知真实踩过的两个漏项（都是「改不动」且原因不好猜）：
 *   - `docparse.tools`：页面有四个输入框并会 PATCH 上去，白名单里只有 `docparse.mineru`
 *     → 永远回「已保存，但这些字段被拒绝：docparse.tools」；
 *   - `outputLanguage`：它是**标量**（值是字符串），却被留在分节白名单里写成空数组
 *     `outputLanguage: []` → 分发处的分节循环按 `typeof v !== 'object'` 判形状，
 *     字符串一律被拒 → 「输出语言」保存必然失败，而且看不出是形状问题。
 *
 * 本文件把上面两类形状都变成硬断言：**加了配置项却忘了挂白名单，`npm test` 会红**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULTS } from '../../server/config.mjs'
import { CONFIG_EDITABLE, CONFIG_EDITABLE_SCALARS } from '../../server/lib/config-editable.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const EXAMPLE_PATH = path.join(ROOT, 'server', 'config.example.json')

/** 模板里的注释键：`"// xxx"` 是说明位，`_readme` 是总说明 */
function isCommentKey(k) {
  return k.startsWith('//') || k === '_readme'
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/* ------------------------------------------------- ① 模板 ↔ DEFAULTS --- */

test('config.example.json 里的每一项都能在 DEFAULTS 里找到（模板不写不存在的项）', () => {
  const example = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8'))
  const declared = Object.keys(example).filter((k) => !isCommentKey(k))
  const unknown = declared.filter((k) => !(k in DEFAULTS))
  assert.deepEqual(
    unknown,
    [],
    `模板里有 DEFAULTS 中不存在的顶层项：${unknown.join('、')}。` +
      `要么是拼错了，要么是忘了在 server/config.mjs 的 DEFAULTS 里加这一节。`,
  )
})

test('config.example.json 是合法 JSON，且注释键不参与配置', () => {
  const example = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8'))
  // `//` 开头的键只是说明位；`_readme` 是全篇总说明。程序不读模板，但别把它们当配置项。
  for (const k of Object.keys(example)) {
    if (isCommentKey(k)) continue
    assert.ok(!k.startsWith('_'), `顶层项 ${k} 用了下划线命名，容易被当成注释键`)
  }
})

/* --------------------------------------- ② 分节白名单 ↔ DEFAULTS --- */

test('CONFIG_EDITABLE 的每一项都是「非空数组」（空数组 = 该项根本改不动）', () => {
  const bad = Object.entries(CONFIG_EDITABLE)
    .filter(([, fields]) => !Array.isArray(fields) || fields.length === 0)
    .map(([section, fields]) => `${section}: ${JSON.stringify(fields)}`)
  assert.deepEqual(
    bad,
    [],
    '这几节在白名单里形状不对：' +
      `${bad.join('；')}。\n` +
      '  空数组是「标量项被误挂在分节表里」的典型形状 —— 标量请移到 ' +
      'CONFIG_EDITABLE_SCALARS（server/lib/config-editable.mjs）。',
  )
})

test('CONFIG_EDITABLE 的分节名都真实存在于 DEFAULTS，且确实是对象（分节）', () => {
  for (const section of Object.keys(CONFIG_EDITABLE)) {
    assert.ok(section in DEFAULTS, `白名单里的分节 ${section} 在 DEFAULTS 里不存在`)
    assert.ok(
      isPlainObject(DEFAULTS[section]),
      `${section} 在 DEFAULTS 里不是对象（是 ${JSON.stringify(DEFAULTS[section])}）——` +
        `标量项不能放在 CONFIG_EDITABLE 里，要放进 CONFIG_EDITABLE_SCALARS`,
    )
  }
})

test('CONFIG_EDITABLE 里放行的每个字段都真实存在于 DEFAULTS 的对应分节', () => {
  const missing = []
  for (const [section, fields] of Object.entries(CONFIG_EDITABLE)) {
    for (const f of fields) {
      if (!(f in DEFAULTS[section])) missing.push(`${section}.${f}`)
    }
  }
  assert.deepEqual(
    missing,
    [],
    `白名单放行了 DEFAULTS 里不存在的字段：${missing.join('、')}。\n` +
      '  放行一个不存在的字段不会报错，只会让 PATCH 把垃圾写进 config.json。',
  )
})

test('CONFIG_EDITABLE 每一节内部没有重复字段', () => {
  for (const [section, fields] of Object.entries(CONFIG_EDITABLE)) {
    assert.equal(new Set(fields).size, fields.length, `${section} 的字段列表里有重复项`)
  }
})

/* --------------------------------------- ③ 标量白名单 ↔ DEFAULTS --- */

test('CONFIG_EDITABLE_SCALARS 里的每一项都在 DEFAULTS 里，且**确实是标量**', () => {
  const problems = []
  for (const key of CONFIG_EDITABLE_SCALARS) {
    if (!(key in DEFAULTS)) {
      problems.push(`${key}（DEFAULTS 里没有）`)
      continue
    }
    const v = DEFAULTS[key]
    if (typeof v === 'object' && v !== null) {
      problems.push(`${key}（DEFAULTS 里是 ${Array.isArray(v) ? '数组' : '对象'}，不是标量）`)
    }
  }
  assert.deepEqual(
    problems,
    [],
    `标量白名单里有不合规的项：${problems.join('、')}。\n` +
      '  标量项的值必须是字符串 / 数字 / 布尔 —— 是对象的话它属于 CONFIG_EDITABLE。',
  )
})

test('两张白名单不重叠（同一个顶层键不能既是分节又是标量）', () => {
  const overlap = Object.keys(CONFIG_EDITABLE).filter((k) => CONFIG_EDITABLE_SCALARS.has(k))
  assert.deepEqual(overlap, [], `同一个键同时进了两张白名单：${overlap.join('、')}`)
})

/* ------------------------------------- ④ 页面上真在用的那几项能改 --- */

test('设置页 PATCH 的顶层标量（outputLanguage / startupDir）都在标量白名单里', () => {
  // 这几个是「页面直接发一个字符串下来」的键。它们**必须**在 SCALARS 里，
  // 否则 PATCH 会走分节循环、被 `typeof v !== 'object'` 拒掉 —— outputLanguage 就是这么坏的。
  const usedByPages = ['outputLanguage', 'startupDir']
  for (const k of usedByPages) {
    assert.ok(
      CONFIG_EDITABLE_SCALARS.has(k),
      `${k} 不在 CONFIG_EDITABLE_SCALARS 里：页面发 ${JSON.stringify({ [k]: '…' })} 会被 PATCH 拒绝`,
    )
  }
})

test('outputLanguage 是标量、不出现在分节白名单里（回归：曾经的 outputLanguage: []）', () => {
  assert.equal(
    Object.prototype.hasOwnProperty.call(CONFIG_EDITABLE, 'outputLanguage'),
    false,
    'outputLanguage 是标量（DEFAULTS 里是字符串），不能挂在 CONFIG_EDITABLE 下',
  )
  assert.equal(typeof DEFAULTS.outputLanguage, 'string')
  assert.equal(DEFAULTS.outputLanguage, 'Chinese')
})
