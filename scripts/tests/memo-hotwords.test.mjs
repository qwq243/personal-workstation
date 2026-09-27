/**
 * 语音随记的热词库 / 标签 / 自学逻辑（node:test）。
 *
 * 只测纯逻辑：不连网、不读真实数据目录、不碰用户文件（词库落在 dataDir 下的临时目录里，
 * 由 `WS_DATA_DIR` 指过去 —— 见文案：测试也不许写进用户的数据目录）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 必须在 import 业务模块**之前**设好：memo.mjs 在模块初始化时就会播种词库
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-memo-test-'))
process.env.WS_DATA_DIR = TMP

const hot = await import('../../server/lib/hotwords.mjs')
const memo = await import('../../server/lib/memo.mjs')

const cleanup = (name) => {
  for (const c of hot.list().categories) if (c.name === name) hot.removeCategory(c.id)
}

test('开局自动铺起步分类（否则纠错那一步等于没开）', () => {
  const cats = hot.list().categories.map((c) => c.name)
  assert.ok(cats.includes('常见同音错写'))
  assert.ok(cats.includes('学术研究'))
})

test('出厂预设不含任何身份信息（脱敏红线）', () => {
  const blob = JSON.stringify(hot.PRESETS)
  for (const bad of ['学号', '大学', '学院', 'QQ', 'qq.com', '@']) {
    assert.equal(blob.includes(bad), false, `预设里不该出现「${bad}」`)
  }
})

test('别名替换：一趟扫完，正名不会被自己的短别名二次改写', () => {
  const terms = [{ term: '登录', aliases: ['登陆'] }]
  assert.deepEqual(hot.applyAliases('先登陆再操作', terms), { text: '先登录再操作', hits: ['登录'] })
  // 「订单」是「订单中心」的前缀：已经写对的正名不许被自己的短别名改写
  const nested = [{ term: '订单中心', aliases: ['订单中心'] }]
  assert.equal(hot.applyAliases('订单中心上线', nested).text, '订单中心上线')
  const prefix = [{ term: '甲项目', aliases: ['甲'] }]
  assert.equal(hot.applyAliases('甲项目上线', prefix).text, '甲项目上线')
})

test('别名里有正则符号也不会炸', () => {
  const terms = [{ term: 'v2.0 (beta)', aliases: ['v2.0(beta)', 'v2-0'] }]
  assert.equal(hot.applyAliases('这版 v2.0(beta) 还行', terms).text, '这版 v2.0 (beta) 还行')
})

test('分类引用按 id 或名字都认（MCP 传名字、页面传 id）', () => {
  cleanup('自检分类')
  const made = hot.act({ action: 'category-add', name: '自检分类' })
  assert.equal(made.ok, true)
  const id = made.category.id
  assert.equal(hot.act({ action: 'term-add', categoryId: '自检分类', term: { term: '自检词', aliases: '自检辞' } }).ok, true)
  assert.deepEqual(hot.termsOf([id]).terms.map((t) => t.term), ['自检词'])
  assert.equal(hot.act({ action: 'term-remove', categoryId: '自检分类', term: '自检词' }).ok, true)
  assert.equal(hot.act({ action: 'category-remove', categoryId: id }).ok, true)
})

test('导入预设包：同名词并入别名而不是重复', () => {
  cleanup('自检导入')
  const made = hot.act({ action: 'category-add', name: '自检导入' })
  const id = made.category.id
  const first = hot.act({ action: 'import-preset', categoryId: id, presetId: 'preset-common-typos' })
  assert.equal(first.ok, true)
  assert.ok(first.added > 5)
  const again = hot.act({ action: 'import-preset', categoryId: id, presetId: 'preset-common-typos' })
  assert.equal(again.added, 0, '第二次导入不该再新增')
  hot.act({ action: 'category-remove', categoryId: id })
})

test('自学热词：整句/原文里没有的词都挡掉，只收真出现过的', () => {
  cleanup('自检自学')
  const cat = hot.addCategory({ name: '自检自学' })
  const record = {
    id: 'selfcheck',
    transcript: '这段说的是灰度与登录，先把它讲清楚。',
    hotwordTerms: [],
    hotwords: [],
    newTerms: [],
    tags: ['经验总结'],
    categoryId: cat.category.id,
    categoryName: '自检自学',
    sections: [
      {
        key: 'other',
        title: '术语与专名',
        items: [
          '本段未出现热词表内任何专名', // 整句：挡
          '灰度 ← 灰肚', // 正名在原文里：收，别名一并收下
          '量子纠缠 ← 量子九禅', // 原文里根本没有：挡
        ],
      },
    ],
    segments: [],
  }
  const r = memo.learnHotwords(record)
  const terms = r.added.map((t) => t.term)
  assert.deepEqual(terms, ['灰度', '经验总结'])
  const stored = hot.list().categories.find((c) => c.id === cat.category.id).terms
  assert.deepEqual(stored.find((t) => t.term === '灰度').aliases, ['灰肚'])
  hot.removeCategory(cat.category.id)
})

test('parseTermLine 认两种方向，且收干净空别名', () => {
  assert.deepEqual(memo.parseTermLine('正名 ← 错写'), { term: '正名', aliases: ['错写'] })
  assert.deepEqual(memo.parseTermLine('错写 → 正名'), { term: '正名', aliases: ['错写'] })
  assert.deepEqual(memo.parseTermLine('只有正名 |'), { term: '只有正名', aliases: [] })
})

test('总稿解析：标签与分类各归各的，不会混进栏目', () => {
  const doc = memo.parseSummaryDoc(
    '# 标题\n\n## 摘要\n一句摘要。\n\n## 标签\n部署\n登录\n\n## 分类\n新建：技术\n\n## 待办 / 下一步\n- 把部署脚本补上\n',
  )
  assert.deepEqual(doc.tags, ['部署', '登录'])
  assert.equal(doc.category, '新建：技术')
  assert.deepEqual(doc.sections.map((s) => s.title), ['待办 / 下一步'])
})

test('脱敏：临时目录用完就删（这条测试自己不写进用户数据目录）', () => {
  assert.ok(TMP.includes(os.tmpdir()) || TMP.startsWith(os.tmpdir()))
  fs.rmSync(TMP, { recursive: true, force: true })
})
