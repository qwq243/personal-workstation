/**
 * 入库队列 + 源目录监听。
 *
 * 「导入」拆成两件事：源目录监听（盯文件夹，发现新文件）与
 * 入库队列（排队解析 → 编译），两件事共用一份状态：
 *   · 队列      server/data/wiki-queue.json
 *   · 监听记录  server/data/wiki-watch.json（记 absPath + mtime，用于识别「新增或改过」）
 *
 * 一条队列项的生命周期：
 *   pending → parsing（外部程序抽文本）→ extracted（写成 raw/sources/*.md）
 *           → ingesting（模型编译成 wiki 页面）→ done / error
 * 每一步的结果都写回队列项（via / pages / message），所以页面刷新后能看到进行到哪了。
 *
 * 关于「解析失败的 PDF」，队列不重试也不假装成功：状态停在 error 并写明原因
 * （本机没有可用 OCR），人看一眼就知道该换文件还是补工具。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { loadConfig, saveConfig } from '../config.mjs'
import { writeAtomic } from './jsonstore.mjs'
import * as wiki from './wiki.mjs'
import * as parse from './wiki-parse.mjs'
import * as cloud from './wiki-cloud.mjs'
import { fetchToSource } from './wiki-fetch.mjs'

function dataFile(name) {
  return path.join(loadConfig().dataDir, name)
}
const QUEUE_FILE = () => dataFile('wiki-queue.json')
const WATCH_FILE = () => dataFile('wiki-watch.json')

function readJson(file, empty) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return raw ?? empty
  } catch {
    return empty
  }
}
function writeJson(file, data) {
  writeAtomic(file, JSON.stringify(data, null, 1))
}

const newId = () => `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

/* ------------------------------------------------------------ 队列 --- */

export function list({ limit = 200 } = {}) {
  const d = readJson(QUEUE_FILE(), { version: 1, items: [] })
  const items = (d.items ?? []).slice(-limit).reverse()
  return {
    ok: true,
    total: items.length,
    counts: items.reduce((acc, i) => ((acc[i.status] = (acc[i.status] ?? 0) + 1), acc), {}),
    items,
    running: !!running,
  }
}

function mutate(fn) {
  const d = readJson(QUEUE_FILE(), { version: 1, items: [] })
  const out = fn(d)
  if (d.items.length > 500) d.items = d.items.slice(-500)
  d.updatedAt = new Date().toISOString()
  writeJson(QUEUE_FILE(), d)
  return out
}

/**
 * 加一条。kind：
 *   'file' 本地文件（pdf/docx/xlsx/pptx/md/txt/html/csv）→ 先解析
 *   'url'  外部链接（X 长文）→ 先抓取
 *   'raw'  已经在 raw/sources 里的源文件 → 直接编译
 */
export function add({ kind, target, title, ingest = true } = {}) {
  const k = String(kind ?? '').trim()
  const t = String(target ?? '').trim()
  if (!['file', 'url', 'raw'].includes(k)) return { ok: false, error: `未知类型：${k}` }
  if (!t) return { ok: false, error: 'target 为空' }
  if (k === 'file' && !fs.existsSync(t)) return { ok: false, error: `文件不存在：${t}` }
  if (k === 'file') {
    const ext = path.extname(t).toLowerCase()
    if (!parse.SUPPORTED.has(ext)) return { ok: false, error: `不支持 ${ext}（支持：${[...parse.SUPPORTED].join(' ')}）` }
  }
  return mutate((d) => {
    const dup = d.items.find((i) => i.kind === k && i.target === t && ['pending', 'parsing', 'extracted', 'ingesting'].includes(i.status))
    if (dup) return { ok: true, item: dup, duplicate: true }
    const item = {
      id: newId(),
      kind: k,
      target: t,
      title: String(title || path.basename(t)).slice(0, 80),
      ingest: ingest !== false,
      status: 'pending',
      message: '',
      via: '',
      source: '',
      pages: [],
      addedAt: new Date().toISOString(),
    }
    d.items.push(item)
    return { ok: true, item }
  })
}

export function remove(id) {
  return mutate((d) => {
    const before = d.items.length
    d.items = d.items.filter((i) => i.id !== id)
    return { ok: d.items.length < before }
  })
}

export function clear({ status = 'done' } = {}) {
  return mutate((d) => {
    const before = d.items.length
    d.items = status === 'all' ? [] : d.items.filter((i) => i.status !== status)
    return { ok: true, removed: before - d.items.length }
  })
}

function update(id, patch) {
  return mutate((d) => {
    const it = d.items.find((i) => i.id === id)
    if (!it) return { ok: false, error: '队列项不存在' }
    Object.assign(it, patch)
    return { ok: true, item: it }
  })
}

/** 状态机：pending → parsing → extracted → ingesting → done / error */
async function processItem(item, { onEvent } = {}) {
  const root = wiki.root()
  const emit = (status, message, extra = {}) => {
    update(item.id, { status, message, ...extra })
    onEvent?.({ id: item.id, status, message, title: item.title })
  }
  try {
    let sourceRel = item.source
    if (item.kind === 'file') {
      emit('parsing', '正在抽文本…')
      // 云端解析会跑一阵：把它的阶段（上传 / 解析 N/M 页 / 取回）实时写进队列项，页面看得见进度
      const got = await parse.extract(item.target, {
        onProgress: (ev) => {
          const detail = ev.phase === 'parse' ? `云端解析中 ${ev.detail}` : String(ev.detail ?? '')
          emit('parsing', detail)
        },
      })
      if (!got.ok) {
        emit('error', got.error)
        return { ok: false, error: got.error }
      }
      const saved = await parse.saveExtracted(root, {
        absPath: item.target,
        text: got.text,
        via: got.via,
        title: item.title,
        images: got.images ?? [],
      })
      if (!saved.ok) {
        emit('error', saved.error)
        return { ok: false, error: saved.error }
      }
      sourceRel = saved.path
      const extra = [
        `${saved.chars} 字`,
        got.via,
        saved.images ? `${saved.images} 张图` : '',
        got.cloudError ? `（云端没成，走的本地：${String(got.cloudError).slice(0, 60)}）` : '',
      ]
        .filter(Boolean)
        .join(' · ')
      emit('extracted', `已抽成 ${saved.path}（${extra}）`, { source: saved.path, via: got.via, chars: saved.chars })
    } else if (item.kind === 'url') {
      emit('parsing', '正在抓取…')
      const got = await fetchToSource(item.target, { dir: root })
      if (!got.ok) {
        emit('error', got.error)
        return { ok: false, error: got.error }
      }
      sourceRel = got.path
      emit('extracted', `已抓成 ${got.path}（${got.chars} 字，${got.via}）`, { source: got.path, via: got.via, chars: got.chars })
    } else {
      sourceRel = item.target
      emit('extracted', `直接用已有源文件 ${sourceRel}`)
    }

    if (!item.ingest) {
      emit('done', '只入库为原始资料（未编译）')
      return { ok: true, source: sourceRel }
    }

    emit('ingesting', '正在编译成 wiki 页面…')
    const res = await wiki.ingest(sourceRel, { model: loadConfig().wiki?.model || undefined })
    if (!res.ok) {
      emit('error', `编译失败：${res.error}`)
      return { ok: false, error: res.error }
    }
    emit('done', `新建 ${res.written?.length ?? 0} 页${res.warnings?.length ? `（注意：${res.warnings.join('；')}）` : ''}`, {
      pages: res.written ?? [],
      source: sourceRel,
    })
    return { ok: true, source: sourceRel, pages: res.written ?? [] }
  } catch (err) {
    emit('error', err.message)
    return { ok: false, error: err.message }
  }
}

let running = false
/**
 * 跑队列。默认串行：模型编译是主要耗时，并发反而更容易撞上提供方的限流，
 * 而且串行时「当前在编哪一份」一目了然。opts.limit 控制这一轮最多处理几条。
 */
export async function run({ limit = 10, onEvent } = {}) {
  if (running) return { ok: false, error: '队列已经在跑了' }
  running = true
  const results = []
  try {
    for (let i = 0; i < limit; i++) {
      const d = readJson(QUEUE_FILE(), { version: 1, items: [] })
      const next = d.items.find((x) => ['pending', 'extracted'].includes(x.status))
      if (!next) break
      if (next.status === 'extracted' && next.ingest === false) {
        update(next.id, { status: 'done', message: '只入库为原始资料（未编译）' })
        continue
      }
      results.push(await processItem(next, { onEvent }))
      onEvent?.({ id: next.id, status: 'settled' })
    }
  } finally {
    running = false
  }
  return { ok: true, processed: results.length, results }
}

/* ------------------------------------------------------------ 监听 --- */

const DEFAULT_EXCLUDE_DIRS = ['.git', '.svn', '.hg', '.obsidian', '.idea', '.vscode', 'node_modules', '.cache', '__pycache__', '.trash']

function watchSettings() {
  const w = loadConfig().wiki ?? {}
  return {
    /** 监听哪些目录；留空 = 只盯当前库的 raw/sources（默认行为） */
    dirs: Array.isArray(w.watchDirs) ? w.watchDirs : [],
    enabled: w.watchEnabled === true,
    autoIngest: w.watchAutoIngest === true,
    intervalMin: Math.max(5, Number(w.watchIntervalMin) || 30),
    maxFileSizeMb: Math.max(1, Number(w.watchMaxFileSizeMb) || 100),
    excludeDirs: Array.isArray(w.watchExcludeDirs) && w.watchExcludeDirs.length ? w.watchExcludeDirs : DEFAULT_EXCLUDE_DIRS,
  }
}

function walkDir(dir, { excludeDirs, maxSize, out = [], depth = 0 } = {}) {
  if (depth > 6) return out
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.isDirectory()) continue
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (excludeDirs.includes(e.name)) continue
      walkDir(abs, { excludeDirs, maxSize, out, depth: depth + 1 })
      continue
    }
    const ext = path.extname(e.name).toLowerCase()
    if (!parse.SUPPORTED.has(ext)) continue
    let st
    try {
      st = fs.statSync(abs)
    } catch {
      continue
    }
    if (st.size > maxSize) continue
    out.push({ path: abs.replace(/\\/g, '/'), size: st.size, mtime: st.mtimeMs })
  }
  return out
}

/**
 * 扫一遍监听目录，找出「新增或改过」的受支持文件。
 * opts.enqueue=true 时直接把它们加进队列（autoIngest 时连跑一起触发）。
 */
export async function scan({ enqueue = false, onEvent } = {}) {
  const s = watchSettings()
  const root = wiki.root()
  const dirs = (s.dirs.length ? s.dirs : [path.join(root, 'raw', 'sources')]).map((d) => String(d).replace(/\\/g, '/'))
  const maxSize = s.maxFileSizeMb * 1024 * 1024
  const state = readJson(WATCH_FILE(), { version: 1, seen: {}, lastScan: '' })
  const seen = state.seen ?? {}
  const found = []
  const dirReport = []
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      dirReport.push({ dir, exists: false, files: 0 })
      continue
    }
    const files = walkDir(dir, { excludeDirs: s.excludeDirs, maxSize })
    dirReport.push({ dir, exists: true, files: files.length })
    for (const f of files) {
      const prev = seen[f.path]
      if (prev && Math.abs(prev.mtime - f.mtime) < 1) continue
      // raw/sources 里的 .md 就是源文件本身，放进队列按 'raw' 处理（直接编译，不再解析）
      const inRawSources = f.path.startsWith(path.join(root, 'raw', 'sources').replace(/\\/g, '/'))
      found.push({ ...f, kind: inRawSources && f.path.endsWith('.md') ? 'raw' : 'file' })
    }
  }

  const added = []
  if (enqueue) {
    for (const f of found) {
      const r = add({ kind: f.kind, target: f.path, title: path.basename(f.path, path.extname(f.path)) })
      if (r.ok) added.push(r.item)
      seen[f.path] = { mtime: f.mtime, size: f.size, at: new Date().toISOString() }
    }
  }
  state.seen = seen
  state.lastScan = new Date().toISOString()
  writeJson(WATCH_FILE(), state)

  const result = {
    ok: true,
    enabled: s.enabled,
    autoIngest: s.autoIngest,
    dirs: dirReport,
    newFiles: found.map((f) => ({ path: f.path, kind: f.kind, size: f.size })),
    enqueued: added.length,
    lastScan: state.lastScan,
  }
  onEvent?.(result)
  return result
}

/** 改监听设置（走配置白名单，写 config.json） */
export function setSettings(patch = {}) {
  const w = {}
  if ('enabled' in patch) w.watchEnabled = patch.enabled === true
  if ('autoIngest' in patch) w.watchAutoIngest = patch.autoIngest === true
  if ('intervalMin' in patch) w.watchIntervalMin = Math.max(5, Number(patch.intervalMin) || 30)
  if ('maxFileSizeMb' in patch) w.watchMaxFileSizeMb = Math.max(1, Number(patch.maxFileSizeMb) || 100)
  if ('dirs' in patch) w.watchDirs = (Array.isArray(patch.dirs) ? patch.dirs : []).map((d) => String(d).replace(/\\/g, '/')).filter(Boolean)
  if ('excludeDirs' in patch) w.watchExcludeDirs = (Array.isArray(patch.excludeDirs) ? patch.excludeDirs : []).map(String).filter(Boolean)
  saveConfig({ wiki: w })
  return { ok: true, ...watchSettings() }
}

export function status() {
  const s = watchSettings()
  const state = readJson(WATCH_FILE(), { version: 1, seen: {}, lastScan: '' })
  const root = wiki.root()
  const dirs = s.dirs.length ? s.dirs : [path.join(root, 'raw', 'sources').replace(/\\/g, '/')]
  return {
    ok: true,
    ...s,
    dirsResolved: dirs,
    tracked: Object.keys(state.seen ?? {}).length,
    lastScan: state.lastScan ?? '',
  }
}

/** 监听目录的定时代跑（边车启动时挂上；intervalMin 可调） */
let timer = null
export function startScheduler({ onEvent } = {}) {
  stopScheduler()
  const s = watchSettings()
  if (!s.enabled) return { ok: true, skipped: '监听没开' }
  const tick = async () => {
    try {
      const r = await scan({ enqueue: true })
      if (r.newFiles.length) {
        console.log(` 知识库监听: 发现 ${r.newFiles.length} 个新文件，已入队`)
        if (watchSettings().autoIngest) await run({ limit: 5, onEvent })
      }
    } catch (err) {
      console.warn('[wiki.watch] 扫描失败:', err.message)
    }
  }
  timer = setInterval(tick, s.intervalMin * 60 * 1000)
  timer.unref?.()
  // 启动后 60 秒先跑一次（等其它子系统起稳）
  const kick = setTimeout(tick, 60 * 1000)
  kick.unref?.()
  return { ok: true, intervalMin: s.intervalMin }
}

export function stopScheduler() {
  if (timer) clearInterval(timer)
  timer = null
}

/* ------------------------------------------------------------ 杂项 --- */

/** 环境自检：解析通道是否可用（面板「设置 → 解析环境」用） */
export async function environment() {
  const [local, cloudInfo] = await Promise.all([parse.availability(), cloud.available()])
  return {
    ok: true,
    ...local,
    cloud: { ...cloudInfo, ...cloud.tokenStatus(), modelVersion: cloud.conf().modelVersion, isOcr: cloud.conf().isOcr, endpoint: cloud.conf().endpoint },
  }
}
