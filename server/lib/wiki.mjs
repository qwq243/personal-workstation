/**
 * 知识库（本地 markdown wiki 的读写实现）。
 *
 * 本仓库自带的实现：页面在 `#/wiki`，接口在 `/api/wiki/*`，智能体走 MCP 的 wiki_* 工具 ——
 * 一个入口就够，不用再单独开一个窗口。
 *
 * 库是个普通的本地文件夹（路径在设置里配），格式是一套通用的 markdown wiki 约定
 * （schema.md 定义的 wiki/ 六个类型的目录 + frontmatter + [[双链]]），
 * Obsidian 这类 Markdown 工具想打开也照样能开。raw/ 是不可变的原始资料，本模块只往里加、不修改。
 *
 * 两处实现取舍（有意为之）：
 *   - 向量检索换成词法检索（标题加权 + 中文二元切分）。不引入向量库依赖，先保证
 *     「搜得到、可解释」，真需要语义检索时再接 NewAPI 的 embedding。
 *   - 编译（ingest）走 NewAPI 的对话模型，产出严格 JSON 计划再落盘：默认只新建页面、
 *     不动已有页面，动之前一律先备份到 server/data/wiki-backups/。
 *     这样即使模型跑偏，库里也不会被写坏。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { loadConfig } from '../config.mjs'
import { writeAtomic } from './jsonstore.mjs'
import { chat } from './newapi.mjs'
import { chatGuarded } from './llm.mjs'
import * as llm from './wiki-llm.mjs'
import { fetchToSource } from './wiki-fetch.mjs'
import * as embed from './wiki-embed.mjs'

/** 页面类型 → 目录（与 schema.md 一致） */
export const TYPE_DIR = {
  entity: 'wiki/entities',
  concept: 'wiki/concepts',
  source: 'wiki/sources',
  query: 'wiki/queries',
  comparison: 'wiki/comparisons',
  synthesis: 'wiki/synthesis',
  overview: 'wiki',
}
export const PAGE_TYPES = Object.keys(TYPE_DIR)

/** index.md 的分节标题（同步索引时按它插入） */
const INDEX_SECTION = {
  entity: '## Entities',
  concept: '## Concepts',
  source: '## Sources',
  query: '## Queries',
  comparison: '## Comparisons',
  synthesis: '## Synthesis',
}

/** 可读的根：wiki/ 与 raw/ 两个目录 + 两份说明文件 */
const READABLE_ROOTS = ['wiki/', 'raw/']
const READABLE_FILES = ['schema.md', 'purpose.md']

/* ------------------------------------------------------------ 路径 --- */

export function root() {
  const st = projectsState()
  if (st.active) return String(st.active).replace(/\\/g, '/')
  const cfg = loadConfig()
  return String(cfg.wiki?.dir ?? '').replace(/\\/g, '/')
}

/* ------------------------------------------------------------ 多库 --- */

/**
 * 多库：一个知识库 = 一个目录，带上 .workstation-kb/project.json 的身份。
 *
 * ⚠️ 这个元数据目录名是**本项目自己的**：库本体那份 `wiki/` + `schema.md` + `[[双链]]` 是通用约定
 * （别的工具也认），但 `.workstation-kb/` 只有本项目认 —— 从别的知识库工具搬库过来时，
 * 元数据要自己搬（`project.json` 是库身份、`skills/` 是库内技能）。没有它也能用，
 * 只是这个库会被当成「还没初始化」，库内技能也读不到。
 *
 * 「当前是哪个库」存在 server/data/wiki-projects.json（与配置分开）：
 * 切库是高频动作，不该每次去改 config.json；config.json 里的 wiki.dir 只当默认值。
 * 注册进列表 ≠ 动磁盘：加库只登记路径，删库只取消登记 —— 本模块从不删除库文件。
 */
function projectsFile() {
  return path.join(loadConfig().dataDir, 'wiki-projects.json')
}

function projectsState() {
  try {
    const raw = JSON.parse(fs.readFileSync(projectsFile(), 'utf8'))
    if (raw && typeof raw === 'object') return { items: [], active: '', ...raw }
  } catch {
    /* 没登记过任何库 */
  }
  return { items: [], active: '' }
}

function saveProjectsState(st) {
  writeAtomic(projectsFile(), JSON.stringify(st, null, 1))
}

function projectName(dir) {
  try {
    return fs.readFileSync(path.join(dir, '.workstation-kb', 'project.json'), 'utf8') && path.basename(dir)
  } catch {
    return path.basename(dir)
  }
}

/** 库列表：登记的 + 配置里的默认库（去重），带页面数与是否可用 */
export function projects() {
  const st = projectsState()
  const def = String(loadConfig().wiki?.dir ?? '').replace(/\\/g, '/')
  const dirs = [...new Set([st.active, ...st.items.map((i) => i.dir), def].filter(Boolean))]
  const rootNow = root()
  const items = dirs.map((dir) => {
    const exists = fs.existsSync(dir)
    const isLib = exists && (fs.existsSync(path.join(dir, 'wiki')) || fs.existsSync(path.join(dir, '.workstation-kb')))
    const known = st.items.find((i) => i.dir === dir)
    return {
      id: known?.id ?? projectIdOf(dir),
      dir,
      name: known?.name ?? projectName(dir),
      active: dir === rootNow,
      exists,
      isLibrary: !!isLib,
      pages: dir === rootNow ? listPages().length : countPages(dir),
      language: known?.language ?? 'Chinese',
      lastOpened: known?.lastOpened ?? '',
    }
  })
  return { ok: true, active: rootNow, projects: items, configDefault: def }
}

function projectIdOf(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, '.workstation-kb', 'project.json'), 'utf8')).id ?? ''
  } catch {
    return ''
  }
}

function countPages(dir) {
  try {
    return walk(path.join(dir, 'wiki'), 'wiki').length
  } catch {
    return 0
  }
}

/** 登记一个库（只登记，不在磁盘上创建任何东西） */
export function addProject(dir, { name } = {}) {
  const d = String(dir ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (!d) return { ok: false, error: '目录为空' }
  const st = projectsState()
  if (!st.items.some((i) => i.dir === d)) {
    st.items.push({ id: projectIdOf(d) || `p${Date.now().toString(36)}`, dir: d, name: name ?? projectName(d), language: 'Chinese' })
  }
  saveProjectsState(st)
  return { ok: true, ...projects() }
}

/** 切换当前库（按目录或 id）；切完清缓存，后续读写都落在新库上 */
export function setProject(idOrDir) {
  const key = String(idOrDir ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  const st = projectsState()
  const def = String(loadConfig().wiki?.dir ?? '').replace(/\\/g, '/')
  const hit = st.items.find((i) => i.dir === key || i.id === key)
  const dir = hit?.dir ?? key
  if (!dir) return { ok: false, error: '没给库目录' }
  if (!fs.existsSync(dir)) return { ok: false, error: `目录不存在：${dir}` }
  if (!fs.existsSync(path.join(dir, 'wiki')) && !fs.existsSync(path.join(dir, '.workstation-kb'))) {
    return { ok: false, error: `${dir} 不像一个知识库（缺 wiki/ 与 .workstation-kb/）。要用它当库，先在设置里「初始化为知识库」。` }
  }
  if (hit) hit.lastOpened = new Date().toISOString()
  st.active = dir
  if (dir === def) st.active = '' // 默认库不必单独记
  saveProjectsState(st)
  invalidate()
  return { ok: true, active: root(), ...projects() }
}

/** 从列表里取消登记（不动磁盘上的文件） */
export function removeProject(idOrDir) {
  const key = String(idOrDir ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  const st = projectsState()
  const before = st.items.length
  st.items = st.items.filter((i) => i.dir !== key && i.id !== key)
  if (st.active === key) st.active = ''
  saveProjectsState(st)
  invalidate()
  return { ok: st.items.length < before }
}

const SCHEMA_TEMPLATE = `# Wiki Schema

## Page Types

| Type | Directory | Purpose |
|------|-----------|---------|
| entity | wiki/entities/ | Named things (people, tools, organizations, datasets) |
| concept | wiki/concepts/ | Ideas, techniques, phenomena, frameworks |
| source | wiki/sources/ | Papers, articles, talks, books, blog posts |
| query | wiki/queries/ | Open questions under active investigation |
| comparison | wiki/comparisons/ | Side-by-side analysis of related entities |
| synthesis | wiki/synthesis/ | Cross-cutting summaries and conclusions |
| overview | wiki/ | High-level project summary (one per project) |

## 命名约定

- 文件名 kebab-case；实体用官方名（openai.md），概念用名词短语（chain-of-thought.md），
  来源用 \`author-year-slug.md\`。

## Frontmatter

\`\`\`yaml
---
type: entity | concept | source | query | comparison | synthesis | overview
title: Human-readable title
tags: []
related: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
\`\`\`

## 双链与索引

- 页面之间用 \`[[page-slug]]\` 互链；每个实体/概念都应出现在 \`wiki/index.md\` 里。
- \`wiki/log.md\` 倒序记录每次入库与改动。
`

/**
 * 把一个目录初始化成知识库（建标准目录骨架）。
 * 只**补缺**：已有的文件一律不动 —— 万一目录里已经有一份手写的库，不会被我冲掉。
 */
export async function initProject(dir, { name, language = 'Chinese' } = {}) {
  const d = String(dir ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (!d) return { ok: false, error: '目录为空' }
  const created = []
  const today = new Date().toISOString().slice(0, 10)
  const writeIfAbsent = async (rel, content) => {
    const abs = path.join(d, rel.split('/').join(path.sep))
    if (fs.existsSync(abs)) return
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, content, 'utf8')
    created.push(rel)
  }
  try {
    for (const sub of ['wiki/entities', 'wiki/concepts', 'wiki/sources', 'wiki/queries', 'wiki/comparisons', 'wiki/synthesis', 'wiki', 'raw/sources', 'raw/assets', '.workstation-kb']) {
      await fsp.mkdir(path.join(d, sub.split('/').join(path.sep)), { recursive: true })
    }
    await writeIfAbsent('schema.md', SCHEMA_TEMPLATE)
    await writeIfAbsent(
      'purpose.md',
      `# Project Purpose\n\n## Goal\n\n<!-- 这个库想搞清楚什么 -->\n\n## Key Questions\n\n1.\n2.\n3.\n\n## Scope\n\n**In scope:**\n-\n\n**Out of scope:**\n-\n`,
    )
    await writeIfAbsent('wiki/index.md', '# Wiki Index\n\n## Entities\n\n## Concepts\n\n## Sources\n\n## Queries\n\n## Comparisons\n\n## Synthesis\n')
    await writeIfAbsent('wiki/log.md', `# Research Log\n\n## ${today}\n\n- 项目创建\n`)
    await writeIfAbsent('wiki/overview.md', `---\ntype: overview\ntitle: Project Overview\ntags: []\nrelated: []\n---\n\n# Overview\n\n<!-- 高层的现状总结，随理解加深更新 -->\n`)
    if (!fs.existsSync(path.join(d, '.workstation-kb', 'project.json'))) {
      await fsp.writeFile(
        path.join(d, '.workstation-kb', 'project.json'),
        JSON.stringify({ id: randomId(), createdAt: Date.now(), name: name ?? path.basename(d), language }, null, 2),
        'utf8',
      )
      created.push('.workstation-kb/project.json')
    }
  } catch (err) {
    return { ok: false, error: err.message }
  }
  addProject(d, { name })
  invalidate()
  return { ok: true, dir: d, created }
}

function randomId() {
  const hex = () => Math.floor(Math.random() * 16).toString(16)
  const seg = (n) => Array.from({ length: n }, hex).join('')
  return `${seg(8)}-${seg(4)}-4${seg(3)}-${seg(4)}-${seg(12)}`
}

export function backupDir() {
  return path.join(loadConfig().dataDir, 'wiki-backups')
}

/** 把外部传进来的相对路径折成安全的 POSIX 相对路径；越界直接抛错 */
function safeRel(rel, { forWrite = false } = {}) {
  const s = String(rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '').trim()
  if (!s) throw new Error('路径为空')
  if (s.includes('\0')) throw new Error('路径非法')
  const norm = path.posix.normalize(s)
  if (norm.startsWith('..') || norm.includes('/../')) throw new Error(`路径越界：${rel}`)
  if (!norm.endsWith('.md')) throw new Error('只处理 .md 文件')
  if (forWrite) {
    if (!norm.startsWith('wiki/')) throw new Error(`只允许写 wiki/ 下的页面（raw/ 是原始资料，只进不改）：${rel}`)
  } else if (!READABLE_ROOTS.some((p) => norm.startsWith(p)) && !READABLE_FILES.includes(norm)) {
    throw new Error(`只允许读 wiki/ 与 raw/：${rel}`)
  }
  return norm
}

export function absOf(rel) {
  const r = root()
  if (!r) throw new Error('还没配置知识库目录（config.json 的 wiki.dir）')
  return path.join(r, safeRel(rel).split('/').join(path.sep))
}

/* -------------------------------------------------------- frontmatter --- */

/** 解析 YAML 头（只支持 schema.md 用到的那几种：标量、数组、简单引号） */
export function parseFrontmatter(text) {
  const src = String(text ?? '')
  if (!src.startsWith('---')) return { data: {}, body: src, hasFrontmatter: false }
  const end = src.indexOf('\n---', 3)
  if (end < 0) return { data: {}, body: src, hasFrontmatter: false }
  const head = src.slice(3, end)
  const body = src.slice(end + 4).replace(/^\r?\n/, '')
  const data = {}
  for (const rawLine of head.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    let val = m[2].trim()
    if (val.startsWith('[') && val.endsWith(']')) {
      data[key] = val
        .slice(1, -1)
        .split(',')
        .map((x) => x.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
    } else if (/^".*"$/.test(val) || /^'.*'$/.test(val)) {
      data[key] = val.slice(1, -1)
    } else {
      data[key] = val
    }
  }
  return { data, body, hasFrontmatter: true }
}

function yamlValue(v) {
  if (Array.isArray(v)) return `[${v.map((x) => String(x)).join(', ')}]`
  if (v === undefined || v === null) return ''
  const s = String(v)
  return /[:#\[\]{}"']/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
}

export function stringifyFrontmatter(data, body) {
  const keys = ['type', 'title', 'tags', 'related', 'created', 'updated', 'authors', 'year', 'url', 'venue', 'origin', 'source_file']
  const lines = ['---']
  for (const k of keys) if (data[k] !== undefined && data[k] !== '') lines.push(`${k}: ${yamlValue(data[k])}`)
  for (const [k, v] of Object.entries(data)) {
    if (keys.includes(k) || v === undefined || v === '') continue
    lines.push(`${k}: ${yamlValue(v)}`)
  }
  lines.push('---', '')
  return `${lines.join('\n')}\n${String(body ?? '').replace(/^\r?\n/, '')}`
}

/* ------------------------------------------------------------ 扫描 --- */

function walk(dir, base = '') {
  const out = []
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const rel = base ? `${base}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel))
    else if (e.name.endsWith('.md')) out.push(rel)
  }
  return out
}

function typeOfPath(rel) {
  for (const [type, dir] of Object.entries(TYPE_DIR)) {
    if (type === 'overview') continue
    if (rel.startsWith(`${dir}/`)) return type
  }
  if (rel === 'wiki/overview.md') return 'overview'
  return 'other'
}

/** 页内 [[双链]] 的目标（去掉 |别名 与 #小标题） */
export function linksIn(body) {
  const out = []
  const src = String(body ?? '').replace(/```[\s\S]*?```/g, '')
  const re = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g
  let m
  while ((m = re.exec(src))) {
    const t = m[1].trim()
    if (t) out.push(t)
  }
  return [...new Set(out)]
}

/** 扫一遍 wiki/，每页给出渲染与检索需要的全部字段（内存缓存 5 秒，写操作会失效） */
let cache = { at: 0, pages: null }
export function invalidate() {
  cache = { at: 0, pages: null }
}

export function listPages({ force = false } = {}) {
  if (!force && cache.pages && Date.now() - cache.at < 5000) return cache.pages
  const r = root()
  const pages = []
  if (r && fs.existsSync(path.join(r, 'wiki'))) {
    for (const rel of walk(path.join(r, 'wiki'), 'wiki')) {
      let text = ''
      try {
        text = fs.readFileSync(path.join(r, rel.split('/').join(path.sep)), 'utf8')
      } catch {
        continue
      }
      const { data, body, hasFrontmatter } = parseFrontmatter(text)
      const stat = safeStat(path.join(r, rel.split('/').join(path.sep)))
      const links = linksIn(body)
      const h1 = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? ''
      const firstLine = body.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#')) ?? ''
      // index.md / log.md 是结构的两个索引文件（schema.md 里单列），不是内容页
      const isMeta = rel === 'wiki/index.md' || rel === 'wiki/log.md'
      pages.push({
        path: rel,
        slug: path.posix.basename(rel, '.md'),
        title: data.title || h1 || firstLine.slice(0, 60) || path.posix.basename(rel, '.md'),
        type: isMeta ? 'meta' : data.type || typeOfPath(rel),
        tags: data.tags ?? [],
        related: data.related ?? [],
        created: data.created ?? '',
        updated: data.updated ?? '',
        sourceFile: data.source_file ?? '',
        hasFrontmatter,
        links,
        chars: body.length,
        mtime: stat?.mtime?.toISOString?.() ?? '',
        summary: '',
        description: data.description ?? '',
        body,
      })
    }
    // 第二遍：摘要里的裸链要换成目标页的标题 —— 所以得先有全局的 slug/标题表
    const bySlug = new Map()
    for (const p of pages) {
      bySlug.set(p.slug.toLowerCase(), p.title)
      bySlug.set(p.title.toLowerCase(), p.title)
    }
    for (const p of pages) {
      p.summary = summarize(p.body, { resolve: (t) => bySlug.get(String(t).toLowerCase()) })
      delete p.body
    }
  }
  pages.sort((a, b) => a.path.localeCompare(b.path, 'zh'))
  cache = { at: Date.now(), pages }
  return pages
}

function safeStat(p) {
  try {
    return fs.statSync(p)
  } catch {
    return null
  }
}

/**
 * 一句话摘要（列表、index.md 的描述、检索片段兜底都用它）。
 *
 * 两条讲究：
 *   1. **双链换成能读的文字**：带别名的用别名；裸链 `[[tadao-ando]]` 用目标页的标题
 *      （由 opts.resolve 查），查不到才退回原文 —— 直接删掉会留下「， 设计。」这种空档，
 *      直接留 slug 又会写出「jaden 2026 ai aesthetics 1」这种噪音（两种情况都出过）。
 *   2. **断在句末**，不在半句话上截断；一句都读不完时才退化成截断加省略号。
 */
export function summarize(body, { limit = 90, resolve } = {}) {
  const flat = String(body ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_m, target, label) => {
      const t = String(target).trim()
      const text = (label && String(label).trim()) || (resolve ? resolve(t) : '') || t
      return ` ${text} `
    })
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}.*$/gm, ' ')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    // 只去 markdown 标记，**不碰下划线**：账号名 @Jaden_riku 里的下划线不是斜体语法
    .replace(/[`*~|#]/g, '')
    .replace(/^\s*---+\s*$/gm, ' ')
    .replace(/\s+/g, ' ')
    // 双链换标题后会在全角标点两侧留下空格（「， 安藤忠雄 … 设计」），紧一紧；
    // 但半角词与中文之间的空格保留（「AI 时代」该有那个空格）
    .replace(/([，。！？；：、）】》」”…])[ \t]+/g, '$1')
    .replace(/[ \t]+([，。！？；：、（【《「“])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  if (!flat) return ''
  if (flat.length <= limit) return flat
  const head = flat.slice(0, limit)
  const stop = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('；'))
  if (stop >= 20) return flat.slice(0, stop + 1)
  return `${head.trim()}…`
}

export function pageBySlug(slug) {
  const s = String(slug ?? '').trim().toLowerCase()
  const all = listPages()
  return all.find((p) => p.slug.toLowerCase() === s) ?? all.find((p) => p.title.toLowerCase() === s) ?? null
}

/* ------------------------------------------------------------ 概览 --- */

export function status() {
  const r = root()
  const exists = r ? fs.existsSync(r) : false
  const pages = exists ? listPages() : []
  const byType = {}
  for (const p of pages) byType[p.type] = (byType[p.type] ?? 0) + 1
  const raw = exists ? walk(path.join(r, 'raw'), 'raw') : []
  const sources = raw.filter((p) => p.startsWith('raw/sources/'))
  const rawFiles = sources.map((p) => {
    const st = safeStat(path.join(r, p.split('/').join(path.sep)))
    return { path: p, name: path.posix.basename(p), size: st?.size ?? 0, mtime: st?.mtime?.toISOString?.() ?? '' }
  })
  const known = new Set(pages.map((p) => p.slug))
  const claimed = new Set(pages.map((p) => p.sourceFile).filter(Boolean))
  const pending = sources.filter((s) => {
    if (claimed.has(s)) return false
    return !known.has(path.posix.basename(s, '.md'))
  })
  const log = readPage('wiki/log.md')
  const lastLog = log.ok ? (log.content.match(/^##\s+(\d{4}-\d{2}-\d{2})/m)?.[1] ?? '') : ''
  return {
    root: r,
    exists,
    projectId: projectId(),
    pages: { total: pages.length, byType },
    sources: sources.length,
    rawFiles,
    rawPending: pending.length,
    backlinks: pages.reduce((n, p) => n + p.links.length, 0),
    lastLog,
    types: PAGE_TYPES,
  }
}

export function projectId() {
  const r = root()
  const p = r ? path.join(r, '.workstation-kb', 'project.json') : ''
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')).id ?? ''
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------ 读写 --- */

export function tree({ root: treeRoot = 'wiki', recursive = true } = {}) {
  const r = root()
  const label = treeRoot === 'sources' ? 'raw/sources' : treeRoot === 'all' ? '' : 'wiki'
  const files = label ? walk(path.join(r, label), label) : [...walk(path.join(r, 'wiki'), 'wiki'), ...walk(path.join(r, 'raw'), 'raw')]
  const byPath = new Map(listPages().map((p) => [p.path, p]))
  const nodes = files.map((rel) => {
    const meta = byPath.get(rel)
    return {
      path: rel,
      name: path.posix.basename(rel),
      dir: path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel),
      type: meta?.type ?? (rel.startsWith('raw/') ? 'raw' : 'other'),
      title: meta?.title ?? path.posix.basename(rel, '.md'),
      chars: meta?.chars ?? 0,
      mtime: meta?.mtime ?? '',
    }
  })
  if (recursive) return { root: treeRoot, files: nodes }
  // 不递归时按目录给一层文件（供侧栏折叠用）
  const dirs = {}
  for (const n of nodes) (dirs[n.dir] ||= []).push(n)
  return { root: treeRoot, dirs: Object.entries(dirs).map(([dir, files]) => ({ dir, files })) }
}

export function readPage(rel) {
  try {
    const abs = absOf(rel)
    if (!fs.existsSync(abs)) return { ok: false, error: `没有这个文件：${rel}` }
    const text = fs.readFileSync(abs, 'utf8')
    const { data, body } = parseFrontmatter(text)
    return { ok: true, path: safeRel(rel), content: text, meta: data, body }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

/** 一页的完整视图：正文 + 出链 + 反链 */
export function pageDetail(rel) {
  const got = readPage(rel)
  if (!got.ok) return got
  const all = listPages()
  const norm = got.path.toLowerCase()
  const me = all.find((p) => p.path.toLowerCase() === norm)
  const backlinks = all
    .filter((p) => p.path !== got.path && p.links.some((l) => l.toLowerCase() === (me?.slug ?? '').toLowerCase() || l.toLowerCase() === (me?.title ?? '').toLowerCase()))
    .map((p) => ({ path: p.path, title: p.title, type: p.type }))
  const outlinks = (me?.links ?? []).map((l) => {
    const target = pageBySlug(l)
    return { target: l, exists: !!target, path: target?.path ?? '', title: target?.title ?? l }
  })
  return { ...got, page: me ?? null, backlinks, outlinks }
}

/** 写页面；默认先备份旧版本到 server/data/wiki-backups/ */
export async function writePage(rel, content, { backup = true } = {}) {
  let target
  try {
    target = safeRel(rel, { forWrite: true })
  } catch (err) {
    return { ok: false, error: err.message }
  }
  const abs = absOf(target)
  let backedUp = ''
  if (backup && fs.existsSync(abs)) {
    backedUp = await backupFile(target, abs)
  }
  await fsp.mkdir(path.dirname(abs), { recursive: true })
  const tmp = `${abs}.tmp-${process.pid}`
  await fsp.writeFile(tmp, content, 'utf8')
  await fsp.rename(tmp, abs)
  invalidate()
  return { ok: true, path: target, backedUp, chars: String(content).length }
}

/** 把一份文件按时间戳备份走，返回相对备份路径 */
export async function backupFile(rel, abs) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dir = path.join(backupDir(), stamp)
  await fsp.mkdir(path.join(dir, path.dirname(rel).split('/').join(path.sep)), { recursive: true })
  const dest = path.join(dir, rel.split('/').join(path.sep))
  await fsp.copyFile(abs ?? absOf(rel), dest)
  return `server/data/wiki-backups/${stamp}/${rel}`
}

/**
 * 重命名/移动页面（同一目录内改名、或换到另一个类型目录）。
 *
 * 为什么单独开一个接口，而不是「写新文件 + 删旧文件」：
 * 知识库对外**不提供删除**（误删一页比多一页难恢复得多），改名走内存里的 rename 才是
 * 一次原子动作；这里仍然先备份旧版本，且目标已存在时直接拒绝，不覆盖。
 * 注意：**不会自动修别处指向它的 [[双链]]** —— 断链由体检页报出来，人决定怎么改。
 */
export async function renamePage(from, to) {
  let a
  let b
  try {
    a = safeRel(from, { forWrite: true })
    b = safeRel(to, { forWrite: true })
  } catch (err) {
    return { ok: false, error: err.message }
  }
  if (a === b) return { ok: false, error: '新旧路径相同' }
  const src = absOf(a)
  const dst = absOf(b)
  if (!fs.existsSync(src)) return { ok: false, error: `没有这个文件：${a}` }
  if (fs.existsSync(dst)) return { ok: false, error: `目标已存在：${b}` }
  const backedUp = await backupFile(a, src)
  await fsp.mkdir(path.dirname(dst), { recursive: true })
  await fsp.rename(src, dst)
  invalidate()
  return { ok: true, from: a, to: b, backedUp }
}

/* ------------------------------------------------------------ 检索 --- */

const STOP = new Set(['的', '了', '是', '在', '和', '与', '也', '就', '都', '而', '及', '或', '一个', '一种'])

/** 中文按二元切分、英文按词切 —— 不分词的话「审美」这种查询在中文里永远命中不了整句 */
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase()
  const out = []
  const seg = s.match(/[\u4e00-\u9fff]+|[a-z0-9][a-z0-9+._-]*/g) ?? []
  for (const chunk of seg) {
    if (/^[\u4e00-\u9fff]+$/.test(chunk)) {
      if (chunk.length === 1) {
        if (!STOP.has(chunk)) out.push(chunk)
        continue
      }
      for (let i = 0; i < chunk.length - 1; i++) out.push(chunk.slice(i, i + 2))
      if (STOP.has(chunk)) continue
    } else {
      if (chunk.length < 2 || STOP.has(chunk)) continue
      out.push(chunk)
    }
  }
  return out
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0
  let n = 0
  let i = 0
  for (;;) {
    const at = haystack.indexOf(needle, i)
    if (at < 0) return n
    n += 1
    i = at + needle.length
  }
}

/**
 * 词法检索。打分刻意简单可解释：标题命中权重最高，其次是 tags/related，最后是正文词频，
 * 再按文档长度做一点归一（长页面不该因为字多就永远排前面）。
 */
export function search(query, { topK = 10, scope = 'wiki', includeContent = false } = {}) {
  const q = String(query ?? '').trim()
  if (!q) return { ok: false, error: '查询为空' }
  const r = root()
  const tokens = [...new Set(tokenize(q))]
  const pages = listPages()
  const items = []
  for (const p of pages) {
    if (scope === 'sources' && p.type !== 'source') continue
    let text = ''
    try {
      text = fs.readFileSync(path.join(r, p.path.split('/').join(path.sep)), 'utf8')
    } catch {
      continue
    }
    const lower = text.toLowerCase()
    const title = String(p.title ?? '').toLowerCase()
    const tagText = `${(p.tags ?? []).join(' ')} ${(p.related ?? []).join(' ')}`.toLowerCase()
    let score = 0
    let titleMatch = false
    if (title.includes(q.toLowerCase())) {
      score += 20
      titleMatch = true
    }
    for (const t of tokens) {
      score += countOccurrences(title, t) * 6
      score += countOccurrences(tagText, t) * 4
      score += Math.min(countOccurrences(lower, t), 12)
    }
    if (score <= 0) continue
    score = score / (1 + Math.log10(1 + p.chars / 800))
    // 摘要：取第一个命中词周围的窗口
    const body = text.replace(/^---[\s\S]*?---/, '')
    let at = -1
    for (const t of tokens) {
      const i = body.toLowerCase().indexOf(t)
      if (i >= 0 && (at < 0 || i < at)) at = i
    }
    const snippet = at >= 0 ? body.slice(Math.max(0, at - 60), at + 140).replace(/\s+/g, ' ').trim() : p.summary
    items.push({
      path: p.path,
      slug: p.slug,
      title: p.title,
      type: p.type,
      score: Number(score.toFixed(2)),
      titleMatch,
      snippet: snippet.length < body.length ? `…${snippet}…` : snippet,
      ...(includeContent ? { content: text } : {}),
    })
  }
  items.sort((a, b) => b.score - a.score)
  return { ok: true, mode: 'lexical', query: q, tokens: tokens.length, total: items.length, results: items.slice(0, topK) }
}

/* ------------------------------------------------------------ 图谱 --- */

/** 双链图：节点是页面，边是 [[双链]]；指向不存在的页面也给个虚节点（那正是要补的窟窿） */
export function graph({ q = '', type = '', limit = 300 } = {}) {
  const pages = listPages()
  const bySlug = new Map()
  for (const p of pages) {
    bySlug.set(p.slug.toLowerCase(), p)
    bySlug.set(p.title.toLowerCase(), p)
  }
  const nodes = new Map()
  const edges = []
  const add = (id, node) => {
    if (!nodes.has(id)) nodes.set(id, { id, ...node, links: 0 })
  }
  for (const p of pages) {
    if (type && p.type !== type) continue
    add(p.path, { label: p.title, type: p.type, path: p.path, missing: false })
  }
  for (const p of pages) {
    if (!nodes.has(p.path)) continue
    for (const l of p.links) {
      const target = bySlug.get(l.toLowerCase())
      const id = target?.path ?? `missing:${l}`
      if (!target) add(id, { label: l, type: 'missing', path: '', missing: true })
      if (target && !nodes.has(target.path)) continue
      edges.push({ source: p.path, target: id, from: p.title, to: target?.title ?? l, missing: !target })
      nodes.get(p.path).links += 1
      if (nodes.has(id)) nodes.get(id).links += 1
    }
  }
  let list = [...nodes.values()]
  if (q) {
    const ql = q.toLowerCase()
    list = list.filter((n) => n.label.toLowerCase().includes(ql) || n.id.toLowerCase().includes(ql))
    const keep = new Set(list.map((n) => n.id))
    // 保留命中节点的直接邻居，否则孤立点看不出关系
    for (const e of edges) {
      if (keep.has(e.source)) keep.add(e.target)
      if (keep.has(e.target)) keep.add(e.source)
    }
    list = [...nodes.values()].filter((n) => keep.has(n.id))
  }
  const keepIds = new Set(list.map((n) => n.id))
  const outEdges = edges.filter((e) => keepIds.has(e.source) && keepIds.has(e.target)).slice(0, 2000)
  return {
    ok: true,
    nodes: list.sort((a, b) => b.links - a.links).slice(0, limit),
    edges: outEdges,
    counts: { nodes: list.length, edges: outEdges.length, missing: list.filter((n) => n.missing).length },
  }
}

/* ------------------------------------------------------------ 体检 --- */

/**
 * 结构体检 —— 孤立页、死链、缺 frontmatter、索引不同步、料没编译。
 * 只报不动手：修不修由人决定（自动改页面风险太高）。
 */
export function lint() {
  const pages = listPages()
  const bySlug = new Map()
  for (const p of pages) {
    bySlug.set(p.slug.toLowerCase(), p)
    bySlug.set(p.title.toLowerCase(), p)
  }
  const inbound = new Map()
  for (const p of pages) for (const l of p.links) inbound.set(l.toLowerCase(), (inbound.get(l.toLowerCase()) ?? 0) + 1)

  const items = []
  const push = (kind, severity, title, detail, extra = {}) => items.push({ id: `${kind}:${extra.key ?? items.length}`, kind, severity, title, detail, ...extra })
  // index.md / log.md / overview.md 是库的结构文件（schema.md 里单列），不参与「缺 frontmatter」「孤立页」这些判定
  const meta = new Set(['wiki/index.md', 'wiki/log.md', 'wiki/overview.md'])

  // 死链
  for (const p of pages) {
    for (const l of p.links) {
      if (bySlug.has(l.toLowerCase())) continue
      push('dead-link', 'warn', `死链：${p.title} → ${l}`, `${p.path} 里的 [[${l}]] 没有对应页面`, { path: p.path, target: l, key: `${p.path}>${l}` })
    }
  }
  // 孤立页（没有任何页面链过来）
  for (const p of pages) {
    if (meta.has(p.path)) continue
    if ((inbound.get(p.slug.toLowerCase()) ?? 0) > 0 || (inbound.get(p.title.toLowerCase()) ?? 0) > 0) continue
    push('orphan', 'info', `孤立页：${p.title}`, `${p.path} 没有任何页面链接到它`, { path: p.path, key: p.path })
  }
  // 缺 frontmatter
  for (const p of pages) {
    if (meta.has(p.path)) continue
    if (p.hasFrontmatter && p.type && p.type !== 'other') continue
    push('no-frontmatter', 'warn', `缺 frontmatter：${p.title}`, `${p.path} 没有 schema.md 要求的 frontmatter（type/title/tags/related）`, { path: p.path, key: p.path })
  }
  // 索引不同步
  const index = readPage('wiki/index.md')
  if (index.ok) {
    const listed = new Set(linksIn(index.content).map((s) => s.toLowerCase()))
    for (const p of pages) {
      if (meta.has(p.path)) continue
      if (listed.has(p.slug.toLowerCase())) continue
      push('index-missing', 'info', `索引缺项：${p.title}`, `wiki/index.md 里没有 [[${p.slug}]]`, { path: 'wiki/index.md', target: p.slug, key: p.path })
    }
    for (const l of listed) {
      if (bySlug.has(l)) continue
      push('index-stale', 'warn', `索引指向不存在的页：${l}`, `wiki/index.md 里的 [[${l}]] 找不到对应页面`, { path: 'wiki/index.md', target: l, key: `idx>${l}` })
    }
  } else {
    push('index-missing-file', 'warn', '缺 wiki/index.md', '库里没有索引文件，页面列表页会少一份对照', { path: 'wiki/index.md', key: 'index' })
  }
  // 料没编译：raw/sources 里的文件没有任何 source 页认领（认领方式：source 页 frontmatter 的 source_file）
  const r = root()
  const claimed = new Set(pages.map((p) => p.sourceFile).filter(Boolean))
  for (const rel of walk(path.join(r, 'raw'), 'raw').filter((p) => p.startsWith('raw/sources/'))) {
    if (claimed.has(rel)) continue
    const slug = path.posix.basename(rel, '.md')
    const hit = pages.some((p) => p.type === 'source' && (p.slug === slug || (p.related ?? []).includes(slug)))
    if (hit) continue
    push('raw-pending', 'info', `料没编译：${path.posix.basename(rel)}`, `${rel} 还没有对应的 source 页（在「入库」里点一下就能编译成 wiki 页面）`, { path: rel, key: rel })
  }

  const order = { warn: 0, info: 1 }
  items.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9))
  // 忽略名单（人在体检页点过「忽略」的）不再出现，但要在响应里报个数，免得像凭空消失
  const ignored = new Set(reviewState().ignored)
  const visible = items.filter((i) => !ignored.has(i.id))
  const counts = visible.reduce((acc, i) => ((acc[i.kind] = (acc[i.kind] ?? 0) + 1), acc), {})
  return { ok: true, total: visible.length, hidden: items.length - visible.length, counts, items: visible }
}

/* ------------------------------------------------- 索引与日志维护 --- */

/** 往 wiki/index.md 的分节里补 [[条目]]，已有的一律不重复写；返回实际新增 */
export async function syncIndex({ write = false, entries } = {}) {
  const got = readPage('wiki/index.md')
  if (!got.ok) return { ok: false, error: got.error }
  const pages = listPages()
  const existing = new Set(linksIn(got.content).map((s) => s.toLowerCase()))
  const todo =
    entries ??
    pages
      .filter((p) => p.type !== 'overview' && p.path !== 'wiki/index.md' && p.path !== 'wiki/log.md')
      .filter((p) => !existing.has(p.slug.toLowerCase()))
      .map((p) => ({ type: p.type, slug: p.slug, title: p.title, description: p.description || p.summary }))
  if (!todo.length) return { ok: true, added: [], changed: false }
  if (!write) return { ok: true, added: todo, changed: false, dryRun: true }

  await backupFile('wiki/index.md')
  let text = got.content
  const added = []
  for (const e of todo) {
    const section = INDEX_SECTION[e.type]
    if (!section) continue
    const line = `- [[${e.slug}]] — ${e.description || e.title}`
    const at = text.indexOf(section)
    if (at < 0) {
      text = `${text.trimEnd()}\n\n${section}\n\n${line}\n`
    } else {
      // 插到该节标题之后、下一个二级标题之前
      const afterHead = text.indexOf('\n', at) + 1
      const nextSec = text.indexOf('\n## ', afterHead)
      const insertAt = nextSec < 0 ? text.length : nextSec
      const head = text.slice(0, insertAt).replace(/\s*$/, '\n')
      const tail = text.slice(insertAt)
      text = `${head}${line}\n${tail}`
    }
    added.push(e.slug)
  }
  const res = await writePage('wiki/index.md', text, { backup: false })
  return { ok: res.ok, added, changed: true, error: res.error }
}

/** 往 wiki/log.md 追加一条（倒序：新日期插在标题下第一条；同一天就并到那一节） */
export async function appendLog(lines, { date = today() } = {}) {
  const got = readPage('wiki/log.md')
  const list = (Array.isArray(lines) ? lines : [lines]).map((l) => String(l).replace(/^\s*-\s*/, '').trim()).filter(Boolean)
  if (!list.length) return { ok: false, error: '没有内容' }
  let text = got.ok ? got.content : '# Research Log\n'
  const bullets = list.map((l) => `- ${l}`)
  const head = `## ${date}`
  const at = text.indexOf(head)
  if (at >= 0) {
    const afterHead = text.indexOf('\n', at) + 1
    let end = text.indexOf('\n## ', afterHead)
    if (end < 0) end = text.length
    const block = text.slice(afterHead, end)
    const exists = new Set(block.split(/\r?\n/).map((l) => l.trim()))
    const fresh = bullets.filter((b) => !exists.has(b))
    if (!fresh.length) return { ok: true, added: [], changed: false }
    await backupFile('wiki/log.md')
    text = `${text.slice(0, end).replace(/\s*$/, '\n')}${fresh.join('\n')}\n${text.slice(end)}`
  } else {
    const titleEnd = text.startsWith('#') ? text.indexOf('\n') + 1 : 0
    await backupFile('wiki/log.md')
    text = `${text.slice(0, titleEnd)}\n${head}\n\n${bullets.join('\n')}\n${text.slice(titleEnd)}`
  }
  const res = await writePage('wiki/log.md', text, { backup: false })
  return { ok: res.ok, added: bullets, changed: true, error: res.error }
}

export function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/* ------------------------------------------------------------ 编译 --- */

function ingestPrompt({ source, sourceText, existing, schema, pageChars = '150–600' }) {
  const catalog = existing
    .filter((p) => p.type !== 'overview' && p.path !== 'wiki/log.md')
    .map((p) => `- ${p.slug} [${p.type}] ${p.title}：${p.summary.slice(0, 80)}`)
    .join('\n')
  return [
    {
      role: 'system',
      content: [
        '你是知识库编译员。把一份原始资料编译成互相链接的 wiki 页面，规则以 schema.md 为准。',
        '只输出 JSON（不要 markdown 代码块、不要解释），结构：',
        '{"pages":[{"path":"wiki/sources/<slug>.md","type":"source","title":"…","tags":["…"],"related":["<其他页面的 slug>"],"body":"markdown 正文"}],',
        ' "index":[{"type":"…","slug":"…","description":"一句话"}],"log":["一条动作记录"]}',
        '硬规则：',
        '1. 必须包含 1 个 type=source 的页面，path 为 wiki/sources/<slug>.md，slug 用英文 kebab-case，frontmatter 里写 origin（资料出处）。',
        '2. 概念建 wiki/concepts/<slug>.md（type=concept），实体（人、机构、作品、工具）建 wiki/entities/<slug>.md（type=entity）。',
        '3. 只写这份资料真正支撑得住的内容。不要编造事实、数字或引语；资料里没有的不写。',
        '4. 正文用 [[slug]] 互链：概念之间、概念与来源之间都要连上，避免孤立页。',
        `5. 每页正文 ${pageChars} 字，中文，具体、可检索；不要写「本文介绍了…」这种空话。`,
        '6. **不要输出 index.md / log.md 之外任何已有页面的改写**：已有页面一律不重写，只新建缺失的。',
        '7. 页面数量控制在 3–8 个：来源页 1 个 + 概念/实体若干（挑最值得单独立页的，宁少勿滥）。',
        '',
        'schema.md（节选）：',
        String(schema ?? '').slice(0, 2000),
        '',
        '库里已有页面（不要重复建，related 里可以直接引用这些 slug）：',
        catalog || '（空库）',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `资料路径：${source}\n\n===== 资料正文开始 =====\n${sourceText}\n===== 资料正文结束 =====`,
    },
  ]
}

function parseJsonLoose(text) {
  const s = String(text ?? '')
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1] : s
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON')
  return JSON.parse(body.slice(start, end + 1))
}

/**
 * 模型常在 body 开头再写一份 YAML frontmatter（提示词第 1 条要求它把 origin 写进 frontmatter，
 * 而写页面时下面还会**自己拼一份** frontmatter）—— 结果页面上会多出一段裸 YAML 正文。
 * 这里把开头那份干掉；只认「首行 --- 且块内有 key: value」的形状，
 * 免得把正文里真的用 --- 分节的内容也吃掉。
 */
function stripLeadingFrontmatter(body) {
  const s = String(body ?? '').replace(/^\uFEFF/, '')
  const m = s.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
  if (!m) return s
  const looksYaml = m[1].split(/\r?\n/).some((l) => /^[A-Za-z_][\w-]*\s*:/.test(l.trim()))
  return looksYaml ? s.slice(m[0].length) : s
}

/**
 * 把一份 raw/ 资料编译成 wiki 页面。
 *
 * 安全策略：默认只新建页面，已存在的路径跳过；写任何文件前先备份 index.md/log.md。
 * dryRun 只回计划不落盘 —— 先看一眼模型打算写什么，再决定要不要真写。
 */
export async function ingest(sourceRel, { dryRun = false, model, maxChars = 24000, types = 'all' } = {}) {
  let rel
  try {
    rel = safeRel(sourceRel)
  } catch (err) {
    return { ok: false, error: err.message }
  }
  const src = readPage(rel)
  if (!src.ok) return { ok: false, error: src.error }
  const text = src.content.slice(0, maxChars)
  const schema = readPage('schema.md')
  const existing = listPages()
  // 每页字数档位：wiki.ingestPageChars（'150–600' 短 / '400–1200' 中 / '800–2000' 长）
  const pageChars = String(loadConfig().wiki?.ingestPageChars ?? '150–600')
  const messages = ingestPrompt({ source: rel, sourceText: text, existing, schema: schema.ok ? schema.content : '', pageChars })

  // 模型走「任务路由」的 ingest 预设（设置 → 模型：可以让编译用便宜模型）
  const picked = llm.resolve('ingest')
  if (!picked.ok) return { ok: false, error: picked.error }
  /* 输出预算给到 16000：编译要吐一整份 JSON（页面正文都在里面），而思考型模型
     **先花几千 token 想**（实测 deepseek-v4.1-flash 想 3800~4500），那部分与正文
     共用 max_tokens。原先的 6000 会被思考吃光，正文只写一半就 finish_reason=length，
     拼出来的 JSON 缺右括号，parseJsonLoose 直接判「模型没有返回 JSON」。 */
  const res = picked.followWorkstation || model
    ? await chat(messages, { model: model || picked.model || undefined, maxTokens: 16000, temperature: 0.3, timeout: 300000 })
    : await llm.chatOnce(picked, messages, { maxTokens: 16000, temperature: 0.3, timeout: 300000 })
  if (!res.ok) return { ok: false, error: `模型调用失败：${res.error}`, detail: res.detail }

  let plan
  try {
    plan = parseJsonLoose(res.content)
  } catch (err) {
    return { ok: false, error: `解析模型的计划失败：${err.message}`, raw: String(res.content ?? '').slice(0, 800) }
  }

  const keepTypes = types === 'all' ? PAGE_TYPES : String(types).split(',').map((s) => s.trim())
  const wanted = []
  const skipped = []
  for (const p of Array.isArray(plan.pages) ? plan.pages : []) {
    let target
    try {
      target = safeRel(p.path, { forWrite: true })
    } catch (err) {
      skipped.push({ path: p.path, reason: err.message })
      continue
    }
    const type = PAGE_TYPES.includes(p.type) ? p.type : typeOfPath(target)
    if (!keepTypes.includes(type)) {
      skipped.push({ path: target, reason: `类型 ${type} 不在本次范围` })
      continue
    }
    const exists = fs.existsSync(absOf(target))
    if (exists) {
      skipped.push({ path: target, reason: '页面已存在（本模块不重写已有页，改动请手动编辑）' })
      continue
    }
    wanted.push({
      path: target,
      type,
      title: String(p.title ?? '').slice(0, 80),
      tags: Array.isArray(p.tags) ? p.tags.map((t) => String(t)) : [],
      related: Array.isArray(p.related) ? p.related.map((t) => String(t)) : [],
      body: stripLeadingFrontmatter(String(p.body ?? '').trim()),
    })
  }

  const report = {
    ok: true,
    source: rel,
    dryRun,
    model: res.model,
    plan: { pages: wanted.map((p) => ({ path: p.path, type: p.type, title: p.title, chars: p.body.length })), skipped },
    index: Array.isArray(plan.index) ? plan.index : [],
    log: Array.isArray(plan.log) ? plan.log : [],
    written: [],
    warnings: [],
  }
  if (dryRun) return report

  for (const p of wanted) {
    if (!p.body) {
      report.warnings.push(`${p.path} 正文为空，跳过`)
      continue
    }
    const fm = {
      type: p.type,
      title: p.title,
      tags: p.tags,
      related: p.related,
      created: today(),
      updated: today(),
      ...(p.type === 'source' ? { source_file: rel } : {}),
    }
    const out = await writePage(p.path, stringifyFrontmatter(fm, p.body))
    if (out.ok) report.written.push(p.path)
    else report.warnings.push(`${p.path} 写入失败：${out.error}`)
  }

  // 索引与日志最后补：先失效缓存，让 syncIndex 读到刚写进去的页面（否则描述会是旧的）
  invalidate()
  const idx = await syncIndex({ write: true })
  report.indexAdded = idx.added ?? []
  const logLines = report.log.length ? report.log : [`入库 ${rel} → 新建 ${report.written.length} 页`]
  const lg = await appendLog(logLines)
  report.logAdded = lg.added ?? []
  invalidate()
  return report
}

/* ------------------------------------------------------------ 问答 --- */

/**
 * 基于库里已有页面回答。
 * 先把命中的页面正文塞进上下文，再要求模型**只用给出的材料**回答并标出引用；
 * 材料不足就直说 —— 知识库最怕的是模型拿常识冒充库里的结论。
 */
export async function ask(question, { topK = 6, model, history = [] } = {}) {
  const q = String(question ?? '').trim()
  if (!q) return { ok: false, error: '问题为空' }
  const found = search(q, { topK, includeContent: true })
  if (!found.ok) return found
  if (!found.results.length) {
    return { ok: true, answer: '库里没有相关页面。可以先在「量」里添资料，再点「入库」把它编译成页面。', references: [], mode: 'no-hit' }
  }
  const ctx = found.results
    .map((r) => `### ${r.title} (${r.path})\n${String(r.content).slice(0, 4000)}`)
    .join('\n\n')
  const messages = [
    {
      role: 'system',
      content: [
        '你在回答关于本地知识库的问题。',
        '规则：只依据下面给出的库内页面作答；页面里没有的内容不要补充，也不要凭常识编造。',
        '回答末尾用一行列出依据：`依据：<页面标题>`。材料不足以回答时，直接说库里的哪一部分不够。',
        '回答控制在 400 字以内，中文。',
        '',
        '===== 库内页面 =====',
        ctx,
      ].join('\n'),
    },
    ...history.slice(-4).map((h) => ({ role: h.role === 'user' ? 'user' : 'assistant', content: String(h.content ?? '').slice(0, 2000) })),
    { role: 'user', content: q },
  ]
  // 走统一层：6 页材料塞进 system 后输入很大，预算按字数算（原写死 1200 会被思考吃光正文）
  const res = await chatGuarded(messages, {
    tier: 'normal',
    chars: messages.reduce((n, m) => n + String(m.content ?? '').length, 0),
    label: 'wiki.ask',
    model,
    temperature: 0.3,
    timeout: 180000,
  })
  if (!res.ok) return { ok: false, error: res.error, detail: res.detail }
  return {
    ok: true,
    mode: 'grounded',
    answer: res.content,
    references: found.results.map((r) => ({ path: r.path, title: r.title, type: r.type, score: r.score })),
    usage: res.usage,
  }
}

/** 抓一个 X 链接，落成 raw/sources 源文件（后续可再走 ingest 编译） */
export async function fetchSource(url, { slug, overwrite = false } = {}) {
  return fetchToSource(url, { dir: root(), slug, overwrite })
}

/* -------------------------------------------------------- 混合检索 --- */

/**
 * 混合检索：词法（总是可用、可解释）+ 语义（配了嵌入端点且建过索引时）。
 *
 * 合并用 RRF（reciprocal rank fusion）而不是加权求和：两边的分数量纲完全不同
 * （词法分是加权词频、语义分是余弦 0–1），按名次融合不用调参也不会被某一侧压死。
 * 语义那侧失败（端点不通/没索引）时不降级为错，只是不参与 —— 页面上会标注实际用了哪种。
 */
export async function searchHybrid(query, { topK = 8, includeContent = false, mode = 'auto' } = {}) {
  const lex = search(query, { topK: topK + 2, includeContent })
  // semantic = 强制只用语义；lexical = 强制只词法；auto = 有索引就混合、没有就词法
  const useSemantic = mode === 'semantic' || (mode === 'auto' && indexHasContent())
  let sem = null
  if (useSemantic) {
    const r = await embed.search(query, { topK: topK + 2 })
    if (r.ok) sem = r
  }
  if (!sem) {
    return { ...(lex.ok ? lex : { ok: true, total: 0, results: [] }), mode: lex.ok ? 'lexical' : 'none', semantic: sem ? true : false, semanticError: useSemantic && !sem ? '语义检索不可用（端点或索引）' : undefined }
  }
  const rank = (list) => new Map(list.map((r, i) => [r.path, { r, rank: i }]))
  const a = rank(lex.results ?? [])
  /* 语义命中要按**当前库**过滤：向量索引是全站一份（wiki-vectors.json 不按库分），
     不过滤的话在 A 库提问会捞到 B 库的页面 —— 多库就白分了。
     词法侧本来就是当前库的页面，两边口径一致后合并才有意义。 */
  const b = rank((sem.results ?? []).filter((r) => pageByPath(r.path)))
  const paths = new Set([...a.keys(), ...b.keys()])
  const merged = []
  for (const p of paths) {
    const inA = a.get(p)
    const inB = b.get(p)
    const score = (inA ? 1 / (60 + inA.rank) : 0) + (inB ? 1 / (60 + inB.rank) : 0)
    const base = inA?.r ?? {}
    const meta = pageByPath(p) ?? {}
    merged.push({
      path: p,
      slug: meta.slug ?? base.slug ?? path.posix.basename(p, '.md'),
      title: meta.title ?? base.title ?? path.posix.basename(p, '.md'),
      type: meta.type ?? base.type ?? 'other',
      score: Number((score * 1000).toFixed(2)),
      lexicalRank: inA ? inA.rank + 1 : null,
      semanticScore: inB ? inB.r.score : null,
      titleMatch: base.titleMatch === true,
      snippet: base.snippet || inB?.r.snippet || meta.summary || '',
      ...(includeContent ? { content: readPage(p).content } : {}),
    })
  }
  merged.sort((x, y) => y.score - x.score)
  return {
    ok: true,
    mode: mode === 'semantic' ? 'semantic' : 'hybrid',
    query,
    total: merged.length,
    results: merged.slice(0, topK),
    semantic: true,
    model: sem.model,
  }
}

function indexHasContent() {
  try {
    return Object.keys(embed.loadIndex().pages ?? {}).length > 0
  } catch {
    return false
  }
}

export function pageByPath(rel) {
  const p = String(rel ?? '').toLowerCase()
  return listPages().find((x) => x.path.toLowerCase() === p) ?? null
}

/** 带正文的页面（建索引、回答上下文都要它） */
export function pagesWithBody() {
  const r = root()
  return listPages()
    .filter((p) => p.type !== 'meta')
    .map((p) => {
      const got = readPage(p.path)
      return { ...p, body: got.ok ? got.body : '' }
    })
}

/* -------------------------------------------------------- 体检动作 --- */

function reviewFile() {
  return path.join(loadConfig().dataDir, 'wiki-review.json')
}

function reviewState() {
  try {
    const raw = JSON.parse(fs.readFileSync(reviewFile(), 'utf8'))
    return { ignored: [], ...raw }
  } catch {
    return { ignored: [] }
  }
}

function saveReviewState(st) {
  writeAtomic(reviewFile(), JSON.stringify(st, null, 1))
}

/**
 * 处理一条体检项。
 * 动作只做三件**可逆且明确**的事，其余一律不代劳：
 *   create-page —— 给死链补一页骨架（内容留空，等人写）
 *   compile     —— 把没编译的料丢进队列去编译（见 wiki-queue.mjs）
 *   ignore      —— 记进忽略名单，不再出现在体检里（可取消）
 *   sync-index  —— 把 index.md 补齐
 */
export async function reviewAction({ id, kind, action, path: rel, target, from } = {}) {
  const st = reviewState()
  if (action === 'ignore') {
    if (!id) return { ok: false, error: '缺 id' }
    if (!st.ignored.includes(id)) st.ignored.push(id)
    saveReviewState(st)
    return { ok: true, ignored: st.ignored.length, id }
  }
  if (action === 'unignore') {
    st.ignored = st.ignored.filter((x) => x !== id)
    saveReviewState(st)
    return { ok: true, ignored: st.ignored.length }
  }
  if (action === 'sync-index') {
    return syncIndex({ write: true })
  }
  if (action === 'create-page') {
    const slug = String(target ?? '').trim()
    if (!slug) return { ok: false, error: '缺 target（要新建的 slug）' }
    if (pageBySlug(slug)) return { ok: false, error: `已经有这一页了：${slug}` }
    const safe = slug
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fff-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
    const rel2 = `wiki/concepts/${safe}.md`
    const body = `# ${slug}\n\n> 由 ${from ? `[[${from}]]` : '库里其它页面'} 引用，尚未展开。补写时注意按 schema.md 给 frontmatter。\n`
    const out = await writePage(rel2, stringifyFrontmatter({ type: 'concept', title: slug, tags: [], related: from ? [from] : [], created: today(), updated: today() }, body))
    return { ...out, slug: safe }
  }
  if (action === 'compile') {
    // 交给队列模块处理（它会解析 → 编译），避免这里重复实现一遍
    const { add } = await import('./wiki-queue.mjs')
    const kind2 = String(rel ?? '').startsWith('raw/') ? 'raw' : 'file'
    return add({ kind: kind2, target: String(rel ?? ''), title: path.posix.basename(String(rel ?? ''), '.md') })
  }
  if (action === 'open-folder') {
    return { ok: true, path: rel ? path.join(root(), rel.split('/').join(path.sep)) : root() }
  }
  return { ok: false, error: `未知动作：${action}` }
}

export function reviewIgnored() {
  return { ok: true, ignored: reviewState().ignored }
}

/**
 * 库内图片的绝对路径（页面里 `![](raw/assets/x.png)` 这类引用要能显示）。
 * 只放行图像扩展名，仍然禁止越界 —— 这条通道是给 <img> 用的，不该能读走任意文件。
 */
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif', '.bmp'])
export function assetPath(rel) {
  const s = String(rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '').trim()
  if (!s || s.includes('\0')) return { ok: false, error: '路径为空' }
  const norm = path.posix.normalize(s)
  if (norm.startsWith('..') || norm.includes('/../')) return { ok: false, error: `路径越界：${rel}` }
  if (!READABLE_ROOTS.some((p) => norm.startsWith(p))) return { ok: false, error: `只允许读 wiki/ 与 raw/：${rel}` }
  const ext = path.posix.extname(norm).toLowerCase()
  if (!IMAGE_EXT.has(ext)) return { ok: false, error: `不是图片：${rel}` }
  const abs = path.join(root(), norm.split('/').join(path.sep))
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { ok: false, error: '图片不存在' }
  return { ok: true, abs, ext, rel: norm }
}

export const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
}
