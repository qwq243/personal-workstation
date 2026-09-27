/**
 * 语音随记的热词库：分类 → 词表（词 + 常见错写别名 + 来源 + 命中次数）。
 *
 * 用途两个：① 纠错 —— 别名在本地先做一遍确定性替换，再把词表交给模型复核；
 * ② 打标签 —— 提示词里要求标签优先从词表里挑，录音整理出来的主题词也回填到这里。
 *
 * 单一来源：出厂预设写在本文（`PRESETS`，**通用词，不含任何身份信息**），用户改动落
 * `server/data/memo/hotwords.json`。词库空时 `ensureSeeded()` 先铺三个起步分类 ——
 * 否则开局一个可用的词都没有，纠错那一步等于没开。
 */
import path from 'node:path'
import { dataDir } from '../config.mjs'
import { createJsonStore } from './jsonstore.mjs'

const FILE = () => path.join(dataDir(), 'memo', 'hotwords.json')

export const SOURCES = ['preset', 'auto', 'manual']

/** 出厂预设包：只读，导入后才进用户词库（这是「示例」，照着换成自己的词就是） */
export const PRESETS = [
  {
    id: 'preset-common-typos',
    name: '常见同音错写',
    note: '中文里最容易写/听混的那几对，装上就能明显少错',
    terms: [
      { term: '登录', aliases: ['登陆', '登路'] },
      { term: '账户', aliases: ['帐户'] },
      { term: '阈值', aliases: ['阀值', '域值'] },
      { term: '部署', aliases: ['布署'] },
      { term: '服务器', aliases: ['服务气'] },
      { term: '授权', aliases: ['受权'] },
      { term: '验证码', aliases: ['验正码'] },
      { term: '概率', aliases: ['盖率'] },
      { term: '账户余额', aliases: ['帐户于额'] },
      { term: '折扣', aliases: ['折口'] },
      { term: '性能', aliases: ['姓能'] },
      { term: '内存', aliases: ['内纯'] },
    ],
  },
  {
    id: 'preset-tech',
    name: '技术与工程',
    note: '写代码 / 聊架构时的固定说法',
    terms: [
      { term: '微服务', aliases: [] },
      { term: '容器化', aliases: [] },
      { term: '灰度发布', aliases: ['灰度发部'] },
      { term: '幂等', aliases: ['密等'] },
      { term: '中间件', aliases: [] },
      { term: '缓存击穿', aliases: [] },
      { term: '熔断', aliases: [] },
      { term: '限流', aliases: [] },
      { term: '可观测性', aliases: [] },
      { term: '单元测试', aliases: [] },
      { term: '回归测试', aliases: [] },
      { term: '技术债', aliases: ['技术宅'] },
      { term: '接口', aliases: [] },
      { term: '重构', aliases: ['重够'] },
    ],
  },
  {
    id: 'preset-ai',
    name: 'AI 与模型',
    note: '和模型打交道时最常见的一批词',
    terms: [
      { term: '大语言模型', aliases: [] },
      { term: '提示词', aliases: ['提示慈', '题词'] },
      { term: '上下文', aliases: [] },
      { term: '微调', aliases: [] },
      { term: '向量检索', aliases: [] },
      { term: '知识库', aliases: [] },
      { term: '智能体', aliases: ['智能题'] },
      { term: '检索增强', aliases: ['检索争强'] },
      { term: '幻觉', aliases: [] },
      { term: '温度参数', aliases: [] },
      { term: '工作流', aliases: [] },
      { term: '评测集', aliases: [] },
    ],
  },
  {
    id: 'preset-research',
    name: '学术研究',
    note: '开题、访谈、实验设计里的固定说法',
    terms: [
      { term: '文献综述', aliases: [] },
      { term: '研究问题', aliases: [] },
      { term: '访谈提纲', aliases: [] },
      { term: '半结构化访谈', aliases: [] },
      { term: '受访者', aliases: ['受访这'] },
      { term: '编码', aliases: [] },
      { term: '主题分析', aliases: [] },
      { term: '扎根理论', aliases: ['扎根里论'] },
      { term: '信度', aliases: [] },
      { term: '效度', aliases: [] },
      { term: '量表', aliases: [] },
      { term: '预实验', aliases: [] },
      { term: '对照组', aliases: [] },
      { term: '样本量', aliases: [] },
    ],
  },
  {
    id: 'preset-teach',
    name: '教学与课程',
    note: '上课、备课、评课',
    terms: [
      { term: '教学设计', aliases: [] },
      { term: '学情分析', aliases: [] },
      { term: '形成性评价', aliases: [] },
      { term: '混合式教学', aliases: [] },
      { term: '翻转课堂', aliases: [] },
      { term: '课程标准', aliases: [] },
      { term: '课堂观察', aliases: [] },
    ],
  },
  {
    id: 'preset-health',
    name: '医学与健康',
    note: '临床与健康话题里的书面词',
    terms: [
      { term: '循证医学', aliases: ['寻证医学'] },
      { term: '临床路径', aliases: [] },
      { term: '随访', aliases: [] },
      { term: '依从性', aliases: ['医从性'] },
      { term: '鉴别诊断', aliases: [] },
      { term: '适应症', aliases: ['适应正'] },
      { term: '禁忌症', aliases: [] },
      { term: '预后', aliases: [] },
    ],
  },
]

/** 词库空的时候先铺这三个（其余预设包按需导入） */
const SEED_IDS = ['preset-common-typos', 'preset-research', 'preset-ai']

const store = createJsonStore({
  name: 'memo-hotwords',
  file: FILE,
  version: 1,
  backupDir: () => path.join(dataDir(), 'backups'),
  empty: () => ({ version: 1, rev: 0, updatedAt: 0, categories: [] }),
  migrate: (raw) => ({
    version: 1,
    rev: Number(raw?.rev) || 0,
    updatedAt: Number(raw?.updatedAt) || 0,
    savedBy: raw?.savedBy,
    categories: Array.isArray(raw?.categories) ? raw.categories.map(normalizeCategory) : [],
  }),
})

const MAX_TERMS = 400
const MAX_CATEGORIES = 40

function slugId(name) {
  const ascii = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `cat-${ascii || Math.random().toString(36).slice(2, 8)}`
}

function cleanTerm(item = {}) {
  const term = String(item.term ?? '').trim().replace(/\s+/g, ' ')
  const aliases = Array.isArray(item.aliases) ? item.aliases : String(item.aliases ?? '').split(/[、,，;；/|\n]/)
  return {
    term,
    aliases: [...new Set(aliases.map((a) => String(a).trim()).filter((a) => a && a !== term))].slice(0, 12),
    note: String(item.note ?? '').trim().slice(0, 120),
    source: SOURCES.includes(item.source) ? item.source : 'manual',
    hits: Math.max(0, Number(item.hits) || 0),
    addedAt: Number(item.addedAt) || Date.now(),
    lastUsedAt: Number(item.lastUsedAt) || 0,
  }
}

function normalizeCategory(raw = {}) {
  const name = String(raw.name ?? '').trim() || '未命名分类'
  const terms = (Array.isArray(raw.terms) ? raw.terms : [])
    .map(cleanTerm)
    .filter((item) => item.term)
    .slice(0, MAX_TERMS)
  return {
    id: String(raw.id ?? '').trim() || slugId(name),
    name,
    note: String(raw.note ?? '').trim().slice(0, 160),
    terms,
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  }
}

function read() {
  return store.read()
}

function write(data, patch) {
  return store.write({ ...data, ...patch, updatedAt: Date.now() }, { baseRev: data.rev, source: 'hotwords' })
}

/** 列表：分类（带词数）+ 预设包（带词数，附前几个词给页面预览） */
export function list() {
  const data = read()
  const categories = data.categories.map((cat) => ({
    id: cat.id,
    name: cat.name,
    note: cat.note,
    count: cat.terms.length,
    auto: cat.terms.filter((t) => t.source === 'auto').length,
    manual: cat.terms.filter((t) => t.source === 'manual').length,
    preset: cat.terms.filter((t) => t.source === 'preset').length,
    terms: cat.terms,
    updatedAt: cat.updatedAt,
  }))
  return {
    ok: true,
    categories,
    presets: PRESETS.map((preset) => ({
      id: preset.id,
      name: preset.name,
      note: preset.note,
      count: preset.terms.length,
      sample: preset.terms.slice(0, 6).map((t) => t.term),
      terms: preset.terms,
    })),
    total: categories.reduce((n, c) => n + c.count, 0),
  }
}

export function addCategory({ name, note = '', terms = [] } = {}) {
  const clean = String(name ?? '').trim()
  if (!clean) return { ok: false, error: '分类名不能为空' }
  const data = read()
  if (data.categories.length >= MAX_CATEGORIES) return { ok: false, error: `分类最多 ${MAX_CATEGORIES} 个` }
  if (data.categories.some((cat) => cat.name === clean)) return { ok: false, error: `已经有「${clean}」这个分类了` }
  const category = normalizeCategory({ id: slugId(clean), name: clean, note, terms })
  data.categories.push(category)
  write(data, { categories: data.categories })
  return { ok: true, category: { ...category, count: category.terms.length }, ...list() }
}

export function updateCategory(id, patch = {}) {
  const data = read()
  const category = data.categories.find((cat) => cat.id === id)
  if (!category) return { ok: false, error: `没有这个分类：${id}` }
  if ('name' in patch) {
    const name = String(patch.name ?? '').trim()
    if (!name) return { ok: false, error: '分类名不能为空' }
    if (data.categories.some((cat) => cat.name === name && cat.id !== id)) return { ok: false, error: `已经有「${name}」了` }
    category.name = name
  }
  if ('note' in patch) category.note = String(patch.note ?? '').trim().slice(0, 160)
  category.updatedAt = Date.now()
  write(data, { categories: data.categories })
  return { ok: true, ...list() }
}

export function removeCategory(id) {
  const data = read()
  const rest = data.categories.filter((cat) => cat.id !== id)
  if (rest.length === data.categories.length) return { ok: false, error: `没有这个分类：${id}` }
  write(data, { categories: rest })
  return { ok: true, removed: id, ...list() }
}

/** 加词；同分类里已有同名词就把别名并进去（自动学到的常见写法不该被丢掉） */
export function addTerm(categoryId, item = {}) {
  const next = cleanTerm(item)
  if (!next.term) return { ok: false, error: '词不能为空' }
  const data = read()
  const category = data.categories.find((cat) => cat.id === categoryId)
  if (!category) return { ok: false, error: `没有这个分类：${categoryId}` }
  const existing = category.terms.find((t) => t.term === next.term)
  if (existing) {
    existing.aliases = [...new Set([...existing.aliases, ...next.aliases])].slice(0, 12)
    if (next.note && !existing.note) existing.note = next.note
    // 手工登记的来源优先（预设/自动不该把手加的降级）
    if (next.source === 'manual') existing.source = 'manual'
  } else {
    if (category.terms.length >= MAX_TERMS) return { ok: false, error: `「${category.name}」最多 ${MAX_TERMS} 个词` }
    category.terms.push(next)
  }
  category.updatedAt = Date.now()
  write(data, { categories: data.categories })
  return { ok: true, ...list() }
}

export function addTerms(categoryId, items = [], source = 'manual') {
  const data = read()
  const category = data.categories.find((cat) => cat.id === categoryId)
  if (!category) return { ok: false, error: `没有这个分类：${categoryId}` }
  let added = 0
  let merged = 0
  for (const raw of items) {
    const next = cleanTerm({ ...(typeof raw === 'string' ? { term: raw } : raw), source })
    if (!next.term) continue
    const existing = category.terms.find((t) => t.term === next.term)
    if (existing) {
      const before = existing.aliases.length
      existing.aliases = [...new Set([...existing.aliases, ...next.aliases])].slice(0, 12)
      if (existing.aliases.length !== before) merged += 1
      continue
    }
    if (category.terms.length >= MAX_TERMS) break
    category.terms.push(next)
    added += 1
  }
  category.updatedAt = Date.now()
  write(data, { categories: data.categories })
  return { ok: true, added, merged, ...list() }
}

export function updateTerm(categoryId, term, patch = {}) {
  const data = read()
  const category = data.categories.find((cat) => cat.id === categoryId)
  if (!category) return { ok: false, error: `没有这个分类：${categoryId}` }
  const target = category.terms.find((t) => t.term === term)
  if (!target) return { ok: false, error: `分类里没有「${term}」` }
  if ('term' in patch) {
    const name = String(patch.term ?? '').trim()
    if (!name) return { ok: false, error: '词不能为空' }
    if (category.terms.some((t) => t.term === name && t !== target)) return { ok: false, error: `分类里已经有「${name}」` }
    target.term = name
  }
  if ('aliases' in patch) target.aliases = cleanTerm({ term: target.term, aliases: patch.aliases }).aliases
  if ('note' in patch) target.note = String(patch.note ?? '').trim().slice(0, 120)
  if ('source' in patch && SOURCES.includes(patch.source)) target.source = patch.source
  category.updatedAt = Date.now()
  write(data, { categories: data.categories })
  return { ok: true, ...list() }
}

export function removeTerm(categoryId, term) {
  const data = read()
  const category = data.categories.find((cat) => cat.id === categoryId)
  if (!category) return { ok: false, error: `没有这个分类：${categoryId}` }
  const rest = category.terms.filter((t) => t.term !== term)
  if (rest.length === category.terms.length) return { ok: false, error: `分类里没有「${term}」` }
  category.terms = rest
  category.updatedAt = Date.now()
  write(data, { categories: data.categories })
  return { ok: true, ...list() }
}

export function moveTerm(fromId, toId, term) {
  const data = read()
  const from = data.categories.find((cat) => cat.id === fromId)
  const to = data.categories.find((cat) => cat.id === toId)
  if (!from || !to) return { ok: false, error: '分类不存在' }
  const index = from.terms.findIndex((t) => t.term === term)
  if (index < 0) return { ok: false, error: `分类里没有「${term}」` }
  const [item] = from.terms.splice(index, 1)
  const existing = to.terms.find((t) => t.term === item.term)
  if (existing) existing.aliases = [...new Set([...existing.aliases, ...item.aliases])].slice(0, 12)
  else to.terms.push(item)
  from.updatedAt = to.updatedAt = Date.now()
  write(data, { categories: data.categories })
  return { ok: true, ...list() }
}

/** 按预设包导入到一个分类 */
export function importPreset(categoryId, presetId) {
  const preset = PRESETS.find((item) => item.id === presetId)
  if (!preset) return { ok: false, error: `没有这个预设包：${presetId}` }
  const data = read()
  const category = data.categories.find((cat) => cat.id === categoryId)
  if (!category) return { ok: false, error: `没有这个分类：${categoryId}` }
  let added = 0
  let merged = 0
  for (const item of preset.terms) {
    const next = cleanTerm({ ...item, source: 'preset' })
    const existing = category.terms.find((t) => t.term === next.term)
    if (existing) {
      const before = existing.aliases.length
      existing.aliases = [...new Set([...existing.aliases, ...next.aliases])].slice(0, 12)
      if (existing.aliases.length !== before) merged += 1
      continue
    }
    if (category.terms.length >= MAX_TERMS) break
    category.terms.push(next)
    added += 1
  }
  category.updatedAt = Date.now()
  write(data, { categories: data.categories })
  return { ok: true, added, merged, preset: preset.name, ...list() }
}

/** 词库空的时候先铺几个起步分类 */
export function ensureSeeded() {
  const data = read()
  if (data.categories.length) return { ok: true, seeded: 0 }
  let seeded = 0
  for (const preset of PRESETS) {
    if (!SEED_IDS.includes(preset.id)) continue
    const category = normalizeCategory({
      id: slugId(preset.name),
      name: preset.name,
      note: preset.note,
      terms: preset.terms.map((t) => ({ ...t, source: 'preset' })),
    })
    data.categories.push(category)
    seeded += 1
  }
  if (seeded) write(data, { categories: data.categories })
  return { ok: true, seeded }
}

/** 按名字或 id 找一个分类（页面传名字、记录里传 id 都能用） */
export function findCategory(ref) {
  const key = String(ref ?? '').trim()
  if (!key) return null
  return read().categories.find((cat) => cat.id === key || cat.name === key) ?? null
}

/** 一批分类的合并词表（一次会话/一次整理算一次，之后用返回值） */
export function termsOf(refs = []) {
  const data = read()
  const picked = []
  for (const ref of refs) {
    const key = String(ref ?? '').trim()
    const cat = data.categories.find((c) => c.id === key || c.name === key)
    if (cat) picked.push(cat)
  }
  const terms = []
  const seen = new Set()
  for (const cat of picked) {
    for (const item of cat.terms) {
      if (seen.has(item.term)) continue
      seen.add(item.term)
      terms.push({ term: item.term, aliases: item.aliases, note: item.note, categoryId: cat.id, categoryName: cat.name })
    }
  }
  return { categories: picked.map((c) => ({ id: c.id, name: c.name })), terms }
}

/** 正则转义：别名里可能有 . + ( ) 这类字符 */
function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 确定性纠错：把已知错写（别名）换成正名。
 *
 * 两个坑都在这里：① 别名之间会互相覆盖（「订单」是「订单中心」的前缀）；② 别名会命中已经写对的正名内部。
 * 所以先把正名挖成占位符，再**一趟**扫别名（长的排前面），最后还原。
 */
export function applyAliases(text, terms = []) {
  const out = String(text ?? '')
  if (!out) return { text: out, hits: [] }
  const pairs = []
  const seen = new Set()
  for (const item of terms) {
    const term = String(item.term ?? '').trim()
    if (!term) continue
    for (const alias of item.aliases ?? []) {
      const key = String(alias ?? '').trim()
      if (!key || key === term || seen.has(key)) continue
      seen.add(key)
      pairs.push({ alias: key, term })
    }
  }
  if (!pairs.length) return { text: out, hits: [] }

  const canon = [...new Set(pairs.map((p) => p.term))]
  let masked = out
  canon.forEach((term, i) => {
    masked = masked.split(term).join(`\u0000${i}\u0000`)
  })

  pairs.sort((a, b) => b.alias.length - a.alias.length)
  const map = new Map(pairs.map((p) => [p.alias, p.term]))
  const hits = new Set()
  const scanned = masked.replace(new RegExp(pairs.map((p) => escapeRe(p.alias)).join('|'), 'g'), (match) => {
    const term = map.get(match)
    if (!term) return match
    hits.add(term)
    return term
  })
  const restored = scanned.replace(/\u0000(\d+)\u0000/g, (_, i) => canon[Number(i)] ?? '')
  return { text: restored, hits: [...hits] }
}

/** 命中记账：这篇里真正用上的词 +1（页面按命中排序，常用的自然浮上来） */
export function recordHits(terms = []) {
  const wanted = new Set(terms.map((t) => String(t ?? '').trim()).filter(Boolean))
  if (!wanted.size) return { ok: true, hits: 0 }
  const data = read()
  let hits = 0
  const now = Date.now()
  for (const cat of data.categories) {
    for (const item of cat.terms) {
      if (!wanted.has(item.term)) continue
      item.hits += 1
      item.lastUsedAt = now
      hits += 1
    }
  }
  if (hits) write(data, { categories: data.categories })
  return { ok: true, hits }
}

/** 提示词里的词表：一行一个词，带别名（空词表返回空串，提示词里整段略去） */
export function promptBlock(terms = []) {
  const lines = []
  for (const item of terms.slice(0, 120)) {
    const term = String(item.term ?? '').trim()
    if (!term) continue
    const aliases = (item.aliases ?? []).filter(Boolean)
    const cat = item.categoryName ? `（${item.categoryName}）` : ''
    lines.push(aliases.length ? `${term}${cat} ← 常见错写：${aliases.join('、')}` : `${term}${cat}`)
  }
  return lines.join('\n')
}

/**
 * 一个动作入口：页面与 MCP 都发 `{action, …}` 过来，分支只写在这里。
 * 形状约定：categoryId / toCategoryId 传 id 或名字都认；term 加词时可以给字符串，也可以给 {term, aliases, note}。
 */
export function act(payload = {}) {
  const action = String(payload.action ?? 'list').trim()
  const categoryId = idOf(payload.categoryId ?? payload.id ?? '')
  switch (action) {
    case 'list':
      return list()
    case 'category-add':
      return addCategory({ name: payload.name, note: payload.note })
    case 'category-update':
      return updateCategory(categoryId, payload.patch ?? {})
    case 'category-remove':
      return removeCategory(categoryId)
    case 'term-add':
      return addTerm(categoryId, typeof payload.term === 'string' ? { term: payload.term } : payload.term ?? {})
    case 'terms-add':
      return addTerms(categoryId, payload.terms ?? [], payload.source ?? 'manual')
    case 'term-update':
      return updateTerm(categoryId, String(payload.oldTerm ?? payload.term ?? ''), payload.patch ?? {})
    case 'term-remove':
      return removeTerm(categoryId, String(typeof payload.term === 'string' ? payload.term : payload.term?.term ?? ''))
    case 'term-move':
      return moveTerm(categoryId, idOf(payload.toCategoryId), String(payload.term ?? ''))
    case 'import-preset':
      return importPreset(categoryId, String(payload.presetId ?? ''))
    default:
      return { ok: false, error: `不认识的动作：${action}` }
  }
}

/** 分类引用（id 或名字）→ 真实 id；找不到就原样返回（下层会报「没有这个分类」） */
function idOf(ref) {
  return findCategory(ref)?.id ?? String(ref ?? '').trim()
}

export function dir() {
  return { file: FILE() }
}
