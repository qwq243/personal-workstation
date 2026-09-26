/**
 * 语义检索：调嵌入模型把页面切块编码，落一份本地向量索引，查询时按余弦相似度排序。
 *
 * 为什么要它：词法检索（wiki.mjs 里的中文二元切分）能搜到「词」，搜不到「意思」——
 * 比如「怎样训练看东西的眼力」这种问法，页面上写的是「比较」「观察」「经验」，
 * 一个共同词都没有。桌面端原本用 LanceDB 做这件事，这里不引向量库：
 * 页面规模是几十到几千页，一份 JSON + 暴力点积足够快（1000 块以内毫秒级），
 * 也没有二进制索引要维护。
 *
 * 嵌入端点独立配置（桌面端就是这么分的：对话一个模型、嵌入一个模型）：
 * 默认指本机那台 ollama 的 bge-m3（1024 维）。端点不可达时所有调用返回失败原因，
 * 检索自动退回词法 —— 不会假装有语义结果。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { loadConfig } from '../config.mjs'

/* ------------------------------------------------------------ 配置 --- */

export function cfg() {
  // 全站统一（2026-09-24 从 wiki.embedding 搬上来）
  const e = loadConfig().embedding ?? {}
  return {
    enabled: e.enabled !== false,
    endpoint: String(e.endpoint ?? ''),
    model: String(e.model ?? 'bge-m3'),
    apiKey: String(e.apiKey ?? ''),
    batchSize: Math.max(1, Number(e.batchSize) || 8),
    concurrency: Math.max(1, Number(e.concurrency) || 2),
    /** 每块字数与重叠：中文一个块 500 字左右语义比较完整，重叠 80 字防止切断关键句 */
    chunkChars: Math.max(200, Number(e.chunkChars) || 500),
    chunkOverlap: Math.max(0, Number(e.chunkOverlap) || 80),
    /** 参与索引的最大页面数（防手滑把整个硬盘导进来） */
    maxPages: Math.max(10, Number(e.maxPages) || 5000),
    /** 有的端点要 key（OpenAI / 硅基流动…），有的要额外头（自建网关的鉴权） */
    apiKey: String(e.apiKey ?? ''),
    extraHeaders: e.extraHeaders && typeof e.extraHeaders === 'object' ? e.extraHeaders : {},
    /** Gemini 的 output_dimensionality（OpenAI 兼容端点会忽略它） */
    outputDimensionality: Number(e.outputDimensionality) || 0,
  }
}

export function indexFile() {
  return path.join(loadConfig().dataDir, 'wiki-vectors.json')
}

/* ------------------------------------------------------------ 索引 --- */

function emptyIndex() {
  return { version: 1, model: '', dim: 0, updated: '', pages: {} }
}

/**
 * 索引对象在**进程内只有一份**（cached）。
 *
 * 为什么不是每次 loadIndex() 都从磁盘读：并发建索引时，每个工作协程都会
 * 读一份自己的快照、改完再写回 —— 后写的把先写的整片覆盖掉（实测：21 页 94 块
 * 只剩 1 页 5 块）。JS 是单线程，只要都改同一个对象就不会丢更新，落盘再合并。
 */
let cached = null

export function loadIndex() {
  if (cached) return cached
  try {
    const raw = JSON.parse(fs.readFileSync(indexFile(), 'utf8'))
    cached = raw?.pages ? raw : emptyIndex()
  } catch {
    cached = emptyIndex()
  }
  return cached
}

let saveTimer = null
function writeNow() {
  if (!cached) return
  cached.updated = new Date().toISOString()
  try {
    fs.mkdirSync(path.dirname(indexFile()), { recursive: true })
    const tmp = `${indexFile()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(cached), 'utf8')
    fs.renameSync(tmp, indexFile())
  } catch (err) {
    console.warn('[wiki.embed] 向量索引落盘失败:', err.message)
  }
}

/** 落盘合并抖动：一次批量索引会连续改很多次，攒 500ms 写一次 */
function saveIndex(idx) {
  cached = idx
  clearTimeout(saveTimer)
  saveTimer = setTimeout(writeNow, 500)
  saveTimer.unref?.()
}

export function flushIndex() {
  clearTimeout(saveTimer)
  saveTimer = null
  writeNow()
}

/* ------------------------------------------------------------ 切块 --- */

/**
 * 页面切块：按标题分段，再按字数硬切。
 * 先按 `## ` 标题切是为了让每块自带「这节在讲什么」的语义边界；
 * 段落之间留重叠，避免一个论点被切断后两边都搜不到。
 */
export function chunkPage(body) {
  const text = String(body ?? '')
    .replace(/^---[\s\S]*?---/, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .trim()
  const { chunkChars, chunkOverlap } = cfg()
  const sections = []
  let buf = []
  for (const line of text.split(/\r?\n/)) {
    if (/^#{1,6}\s/.test(line) && buf.length) {
      sections.push(buf.join('\n'))
      buf = [line]
    } else buf.push(line)
  }
  if (buf.length) sections.push(buf.join('\n'))
  const chunks = []
  for (const sec of sections) {
    const s = sec.trim()
    if (!s) continue
    if (s.length <= chunkChars) {
      chunks.push(s)
      continue
    }
    let i = 0
    while (i < s.length) {
      chunks.push(s.slice(i, i + chunkChars))
      if (i + chunkChars >= s.length) break
      i += chunkChars - chunkOverlap
    }
  }
  return chunks.slice(0, 40)
}

function hashOf(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16)
}

/* ------------------------------------------------------------ 嵌入 --- */

/**
 * 调嵌入端点。支持 OpenAI 兼容的 `{input: [...]}` 与 ollama 原生的 `{prompt}` 两种形状：
 * 先用 OpenAI 形状试，404/400 时退回 ollama 形状再试一次。
 */
export async function embed(texts, { timeout = 60000 } = {}) {
  const c = cfg()
  if (!c.enabled) return { ok: false, error: '语义检索没开（config.json 的 wiki.embedding.enabled）' }
  const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t ?? '').slice(0, 4000))
  if (!list.length) return { ok: true, vectors: [], model: c.model }

  const headers = { 'Content-Type': 'application/json', ...(c.extraHeaders ?? {}) }
  if (c.apiKey) headers.Authorization = `Bearer ${c.apiKey}`

  const post = async (url, bodyObj) => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeout)
    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(bodyObj), signal: ctrl.signal })
      const txt = await res.text()
      let json = null
      try {
        json = JSON.parse(txt)
      } catch {
        /* 非 JSON：下面按错误文本回传 */
      }
      return { status: res.status, ok: res.ok, json, txt }
    } catch (err) {
      const msg = err?.name === 'AbortError' ? `嵌入端点超时（${timeout}ms）` : err?.message ?? String(err)
      return { status: 0, ok: false, json: null, txt: msg, network: true }
    } finally {
      clearTimeout(timer)
    }
  }

  const base = c.endpoint.replace(/\/+$/, '')
  const first = { model: c.model, input: list }
  if (c.outputDimensionality) first.dimensions = c.outputDimensionality
  let r = await post(base, first)
  if (r.ok && Array.isArray(r.json?.data)) {
    const vectors = r.json.data.map((d) => d.embedding).filter(Array.isArray)
    if (vectors.length === list.length) return { ok: true, vectors, model: r.json.model ?? c.model, dim: vectors[0].length }
  }
  if (!r.network && [400, 404, 405].includes(r.status)) {
    // ollama 原生 /api/embeddings 只吃单条 prompt
    const alt = base.replace(/\/v1\/embeddings$/, '/api/embeddings')
    if (alt !== base) {
      const vectors = []
      for (const t of list) {
        const one = await post(alt, { model: c.model, prompt: t })
        const v = one.json?.embedding
        if (one.ok && Array.isArray(v)) vectors.push(v)
        else return { ok: false, error: `嵌入失败：${one.txt.slice(0, 200)}` }
      }
      return { ok: true, vectors, model: c.model, dim: vectors[0]?.length ?? 0, via: 'ollama' }
    }
  }
  const detail = r.json?.error?.message ?? r.json?.error ?? r.txt?.slice?.(0, 200) ?? ''
  return { ok: false, error: `嵌入端点返回 ${r.status}：${String(detail).slice(0, 200)}` }
}

/* ------------------------------------------------------------ 建索引 --- */

/** 索引一页；页面正文的 hash 没变就跳过（除了 force） */
export async function indexPage(pagePath, body, { force = false } = {}) {
  const c = cfg()
  const idx = loadIndex()
  const chunks = chunkPage(body)
  const head = hashOf(chunks.join('\u0000'))
  const prev = idx.pages[pagePath]
  if (!force && prev && prev.hash === head && prev.dim === prev.dim) return { ok: true, skipped: true, chunks: prev.chunks.length }
  if (!chunks.length) {
    delete idx.pages[pagePath]
    saveIndex(idx)
    return { ok: true, chunks: 0, empty: true }
  }
  const got = await embed(chunks)
  if (!got.ok) return got
  idx.pages[pagePath] = { hash: head, model: got.model, dim: got.dim, at: new Date().toISOString(), chunks, vectors: got.vectors }
  idx.model = got.model
  idx.dim = got.dim
  saveIndex(idx)
  return { ok: true, chunks: chunks.length, dim: got.dim, model: got.model }
}

/** 删掉已经不在库里的页面（改名/删除后清理） */
export function pruneIndex(livePaths) {
  const idx = loadIndex()
  const live = new Set(livePaths)
  let removed = 0
  for (const key of Object.keys(idx.pages)) {
    if (!live.has(key)) {
      delete idx.pages[key]
      removed += 1
    }
  }
  if (removed) saveIndex(idx)
  return removed
}

/**
 * 建整库索引：并发受控，逐页回调进度（页面用来显示进度条）。
 *
 * `keepPaths` = 「这次不该被清掉的页面」，默认就是本次要建的这些页。
 * 为什么要能单独指定：单页补索引（`/api/wiki/embed/build` 带了 `path`）时只建一页，
 * 若照默认拿这一页去 prune，**别的页的向量会被整片删掉**——建一页丢一库，还不报错。
 * 所以调用方（index.mjs 的路由）会把整库页表传进来。
 */
export async function indexAll(pages, { force = false, onProgress, keepPaths } = {}) {
  const c = cfg()
  const list = pages.slice(0, c.maxPages)
  const idx = loadIndex()
  const stale = list.filter((p) => {
    const prev = idx.pages[p.path]
    return force || !prev || prev.hash !== hashOf(chunkPage(p.body).join('\u0000'))
  })
  let done = 0
  let failed = 0
  let chunks = 0
  const errors = []
  const queue = [...stale]
  const workers = Array.from({ length: Math.min(c.concurrency, queue.length || 1) }, async () => {
    for (;;) {
      const p = queue.shift()
      if (!p) return
      const r = await indexPage(p.path, p.body, { force })
      done += 1
      if (r.ok) chunks += r.chunks ?? 0
      else {
        failed += 1
        if (errors.length < 3) errors.push(`${p.path}：${r.error}`)
      }
      onProgress?.({ done, total: stale.length, path: p.path, ok: r.ok })
    }
  })
  await Promise.all(workers)
  flushIndex()
  pruneIndex(keepPaths ?? pages.map((p) => p.path))
  return { ok: failed === 0, total: list.length, indexed: done - failed, skipped: list.length - stale.length, failed, chunks, errors }
}

/**
 * 比模型名时用这个归一：ollama 上报的是 `bge-m3:latest`，配置里写的是 `bge-m3` ——
 * 同一台服务上的同一个模型，不该被判成「换过模型」。只削这一种确定等价的后缀。
 */
const normModel = (m) => String(m ?? '').trim().replace(/:latest$/, '')

export function indexStatus(pages = []) {
  const c = cfg()
  const idx = loadIndex()
  // index.md / log.md 这类结构文件不参与检索，别算进「还有多少页没索引」
  const content = pages.filter((p) => p.type !== 'meta')
  const live = new Set(content.map((p) => p.path))
  const entries = Object.entries(idx.pages).filter(([k]) => live.has(k))
  const indexModel = String(idx.model ?? '')
  return {
    enabled: c.enabled,
    endpoint: c.endpoint,
    model: c.model,
    /** 索引是用哪个模型建的（切了模型这俩就不一样了） */
    indexModel,
    /** 换过模型：旧向量跟新查询的向量不在一个空间里，相似度是垃圾 —— 页面据此提示重建 */
    modelStale: !!indexModel && !!c.model && normModel(indexModel) !== normModel(c.model),
    indexed: entries.length,
    pages: content.length,
    pending: content.length - entries.length,
    chunks: entries.reduce((n, [, v]) => n + (v.chunks?.length ?? 0), 0),
    dim: idx.dim ?? 0,
    updated: idx.updated ?? '',
  }
}

/**
 * 列嵌入端点上的模型（设置页「模型」下拉用）。
 *
 * 端点存的是完整 embeddings 地址（`…/v1/embeddings`），所以先按 OpenAI 兼容的
 * `${origin}/v1/models` 问一次；ollama 原生那台不认这条路，再退回 `${origin}/api/tags`。
 * 两条都失败就如实报错 —— 模型名仍然手填得进（下拉是 allow-create），不因为列不出来就卡住。
 */
export async function listModels({ endpoint, apiKey, extraHeaders } = {}) {
  const c = cfg()
  const ep = String(endpoint || c.endpoint || '').trim()
  if (!ep) return { ok: false, error: '还没填端点' }
  let origin = ''
  try {
    origin = new URL(ep).origin
  } catch {
    return { ok: false, error: `端点不是合法 URL：${ep}` }
  }
  const key = String(apiKey || c.apiKey || '')
  const raw = extraHeaders && typeof extraHeaders === 'object' ? extraHeaders : c.extraHeaders
  const headers = { ...(raw ?? {}) }
  if (key) headers.Authorization = `Bearer ${key}`

  const tries = [
    { url: `${origin}/v1/models`, pick: (j) => (j?.data ?? []).map((m) => m?.id) },
    { url: `${origin}/api/tags`, pick: (j) => (j?.models ?? []).map((m) => m?.name) },
  ]
  const errors = []
  for (const t of tries) {
    try {
      const res = await fetch(t.url, { headers, signal: AbortSignal.timeout(15000) })
      const text = await res.text()
      if (!res.ok) {
        errors.push(`${t.url} → HTTP ${res.status}`)
        continue
      }
      const ids = (t.pick(JSON.parse(text)) ?? []).map((x) => String(x ?? '')).filter(Boolean)
      if (ids.length) return { ok: true, origin, via: t.url, models: [...new Set(ids)] }
      errors.push(`${t.url} → 列表为空`)
    } catch (err) {
      errors.push(`${t.url} → ${err.name === 'TimeoutError' ? '超时' : err.message}`)
    }
  }
  return { ok: false, error: `列不出模型（${errors.join('；')}）`, hint: '模型名仍可手填' }
}

/* ------------------------------------------------------------ 检索 --- */

function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** 语义检索：查询也过一遍嵌入，逐块算余弦，按页面取最高分 */
export async function search(query, { topK = 10, minScore = 0.3 } = {}) {
  const idx = loadIndex()
  const entries = Object.entries(idx.pages)
  if (!entries.length) return { ok: false, error: '还没有向量索引（先在「搜索」页建索引）' }
  /* 换过嵌入模型就直接拒答：不同模型的向量不在同一空间，余弦相似度会算出一堆看着像
     命中、其实毫无意义的页（维度还可能不同，cosine 只比到较短那个）。宁可报错让人重建，
     也不给假命中 —— 与「端点不通就退回词法、不假装有语义」是同一条原则。 */
  const c = cfg()
  if (idx.model && c.model && normModel(idx.model) !== normModel(c.model)) {
    return { ok: false, error: `向量索引是用「${idx.model}」建的，现在配的是「${c.model}」——先在「设置 → 语义检索」重建索引` }
  }
  const got = await embed([query])
  if (!got.ok) return got
  const qv = got.vectors[0]
  const hits = new Map()
  for (const [pagePath, rec] of entries) {
    let best = 0
    let bestChunk = ''
    for (let i = 0; i < rec.vectors.length; i++) {
      const s = cosine(qv, rec.vectors[i])
      if (s > best) {
        best = s
        bestChunk = rec.chunks[i] ?? ''
      }
    }
    if (best >= minScore) hits.set(pagePath, { score: best, snippet: bestChunk.slice(0, 240) })
  }
  const results = [...hits.entries()]
    .map(([pagePath, v]) => ({ path: pagePath, score: Number(v.score.toFixed(4)), snippet: v.snippet }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
  return { ok: true, mode: 'semantic', model: got.model, total: hits.size, results }
}

/** 嵌入端点的连通性自测（面板「设置」页用） */
export async function probe() {
  const c = cfg()
  const t0 = Date.now()
  const r = await embed(['知识库连通性测试'], { timeout: 15000 })
  return {
    ok: r.ok,
    endpoint: c.endpoint,
    model: r.model ?? c.model,
    dim: r.dim ?? 0,
    ms: Date.now() - t0,
    error: r.ok ? undefined : r.error,
  }
}

/* ------------------------------------------------------------ 清理 --- */

export async function drop() {
  await fsp.rm(indexFile(), { force: true })
  cached = emptyIndex()
  return { ok: true, file: indexFile() }
}
