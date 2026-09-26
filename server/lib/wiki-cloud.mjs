/**
 * 云端文档解析（MinerU）—— 全站统一的**首选解析通道**。
 *
 * 为什么值得上云端（实测的本地能力边界）：
 *   · 本地 pdf 通道（pdftotext / pypdfium2）只抽得到文本层 —— 表格会塌成一行行碎字；
 *     云端输出是真 <table>，行列表头全在；图片也只有云端会一并抽出来。
 *   · **扫描版 PDF 本地完全没辙**（没有可用的 OCR 后端），云端开着 OCR 就能吃。
 * 所以：云端优先（默认开），失败或关掉时自动回落到本地通道 —— 离线也能用，只是质量降级。
 *
 * 两件事要说清楚（都不是小事）：
 *   1. **文档会上传到第三方云端**（mineru.net）解析。页面上明确标注，不偷偷传；
 *      介意就把 `docparse.mineru.enabled` 关掉，只用本机通道。
 *   2. 令牌是敏感项：存在 `server/credentials.json` 的 `docparse.mineru.token`
 *      （不进 config.json，也**不从任何别的程序**的配置里读 —— 那是跨应用读私有文件，
 *      对方改结构就崩；只有一个来源，就是这一处）。
 *
 * 接口（v4，2026-09-24 实测可用）：
 *   POST {endpoint}/file-urls/batch   → { batch_id, file_urls[] }（拿预签名上传地址）
 *   PUT  file_urls[0]                 → 上传原文件（不带鉴权头）
 *   GET  {endpoint}/extract-results/batch/{batch_id} → 轮询 state: pending/running/done/failed
 *   GET  full_zip_url                 → zip 里是 full.md + images/*
 * zip 用自带的解析器读（见下）—— 本项目边车零第三方依赖，不能为了解压引库。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { loadConfig } from '../config.mjs'

/** MinerU 能吃的类型（其余类型走本地通道，没必要上传） */
export const CLOUD_TYPES = new Set(['.pdf', '.docx', '.doc', '.ppt', '.pptx', '.xls', '.xlsx', '.png', '.jpg', '.jpeg'])

export function conf() {
  // 全站统一（2026-09-24 从 wiki.mineru 搬到 docparse.mineru）
  const m = loadConfig().docparse?.mineru ?? {}
  return {
    enabled: m.enabled !== false,
    endpoint: String(m.endpoint ?? 'https://mineru.net/api/v4').replace(/\/+$/, ''),
    modelVersion: String(m.modelVersion ?? 'vlm'),
    language: String(m.language ?? 'ch'),
    isOcr: m.isOcr !== false,
    timeoutSec: Math.max(30, Number(m.timeoutSec) || 300),
    token: String(m.token ?? ''),
  }
}

/* ------------------------------------------------------------ 令牌 --- */

/**
 * 取令牌：**只有一个来源** —— server/credentials.json 的 `docparse.mineru.token`。
 *
 * 以前它还去读一个别的桌面应用的配置文件来「迁一次」。跨应用读别人的私有文件
 * 既不可预期（对方改结构就崩）也不该由开源版继承，已经拿掉；
 * 需要迁移历史令牌的话，用一次性脚本 `scripts/import-mineru-token.mjs`（默认不跑）。
 */
export function token() {
  return String(conf().token ?? '')
}

/** 令牌状态（给页面看，不回显明文） */
export function tokenStatus() {
  const t = token()
  return { has: !!t, tail: t ? t.slice(-4) : '', source: t ? 'credentials.json' : '未配置' }
}

/* ------------------------------------------------------------ 调用 --- */

const probeCache = { at: 0, value: null }

/** 云端可用性：有令牌 + 接口能连上（结果缓存 60s，页面刷新不会每次都打网络） */
export async function available({ force = false } = {}) {
  if (!force && probeCache.value && Date.now() - probeCache.at < 60000) return probeCache.value
  const c = conf()
  if (!c.enabled) {
    probeCache.value = { ok: false, reason: 'disabled', error: '云端解析被关掉了（设置 → 文档解析）' }
    probeCache.at = Date.now()
    return probeCache.value
  }
  const t = token()
  if (!t) {
    probeCache.value = { ok: false, reason: 'no-token', error: '还没配 MinerU 令牌（设置 → 文档解析）' }
    probeCache.at = Date.now()
    return probeCache.value
  }
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    // GET /extract-results/batch/probe：鉴权对了会回「任务不存在」之类的业务错，鉴权错才是 401
    const res = await fetch(`${c.endpoint}/extract-results/batch/healthcheck`, {
      headers: { Authorization: `Bearer ${t}` },
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    const ok = res.status !== 401 && res.status !== 403
    probeCache.value = ok
      ? { ok: true, endpoint: c.endpoint, modelVersion: c.modelVersion, isOcr: c.isOcr }
      : { ok: false, reason: 'token', error: `云端返回 ${res.status}（令牌可能失效）` }
  } catch (err) {
    probeCache.value = { ok: false, reason: 'network', error: `连不上 mineru.net：${err.message}` }
  }
  probeCache.at = Date.now()
  return probeCache.value
}

async function api(pathname, { method = 'GET', body, token: t, timeout = 30000 } = {}) {
  const c = conf()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(`${c.endpoint}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${t}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* 非 JSON：下面按错误文本回传 */
    }
    return { status: res.status, ok: res.ok, json, text }
  } catch (err) {
    const msg = err?.name === 'AbortError' ? `请求超时（${timeout}ms）` : err.message
    return { status: 0, ok: false, json: null, text: msg, network: true }
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------ zip --- */

/**
 * 极简 zip 读取器：只用中央目录 + zlib.inflateRawSync。
 * 支持 stored(0) 与 deflate(8) 两种压缩方式（MinerU 的 zip 就是这两种），
 * zip64 与加密不处理 —— 遇到就报错，不猜。
 */
export function unzip(buf) {
  const eocd = (() => {
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) return i
    }
    return -1
  })()
  if (eocd < 0) throw new Error('不是有效的 zip（找不到中央目录）')
  const count = buf.readUInt16LE(eocd + 10)
  let ptr = buf.readUInt32LE(eocd + 16)
  const out = new Map()
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break
    const method = buf.readUInt16LE(ptr + 10)
    const compSize = buf.readUInt32LE(ptr + 20)
    const nameLen = buf.readUInt16LE(ptr + 28)
    const extraLen = buf.readUInt16LE(ptr + 30)
    const commentLen = buf.readUInt16LE(ptr + 32)
    const localOff = buf.readUInt32LE(ptr + 42)
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen)
    if (compSize === 0xffffffff) throw new Error(`zip64 条目暂不支持：${name}`)
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`zip 局部头损坏：${name}`)
    const lNameLen = buf.readUInt16LE(localOff + 26)
    const lExtraLen = buf.readUInt16LE(localOff + 28)
    const dataStart = localOff + 30 + lNameLen + lExtraLen
    const raw = buf.subarray(dataStart, dataStart + compSize)
    let data
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = zlib.inflateRawSync(raw)
    else throw new Error(`zip 压缩方式不支持（${method}）：${name}`)
    out.set(name, data)
    ptr += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/* ------------------------------------------------------------ 解析 --- */

/**
 * 把一个文件送云端解析，返回 markdown 与抽出的图片。
 * onProgress({phase, detail}) 会报「已上传 / 正在解析 N/M 页 / 正在取结果」，交给队列项显示。
 */
export async function parseFile(absPath, { isOcr, language, modelVersion, onProgress } = {}) {
  const c = conf()
  const t = token()
  if (!t) return { ok: false, error: '没有 MinerU 令牌' }
  const name = path.basename(absPath)
  const size = fs.statSync(absPath).size
  if (size > 200 * 1024 * 1024) return { ok: false, error: `文件太大（${Math.round(size / 1048576)} MB，云端上限 200 MB）` }

  const t0 = Date.now()
  onProgress?.({ phase: 'prepare', detail: '申请上传地址' })
  const req = await api('/file-urls/batch', {
    method: 'POST',
    token: t,
    body: {
      enable_formula: true,
      language: language || c.language,
      model_version: modelVersion || c.modelVersion,
      files: [{ name, is_ocr: isOcr ?? c.isOcr }],
    },
  })
  if (!req.ok || req.json?.code !== 0) {
    return { ok: false, error: `申请上传地址失败：${req.json?.msg ?? req.text?.slice(0, 200) ?? req.status}` }
  }
  const batchId = req.json.data.batch_id
  const putUrl = req.json.data.file_urls?.[0]
  if (!putUrl) return { ok: false, error: '云端没给上传地址' }

  onProgress?.({ phase: 'upload', detail: `上传 ${Math.round(size / 1024)} KB` })
  try {
    const put = await fetch(putUrl, { method: 'PUT', body: fs.readFileSync(absPath) })
    if (!put.ok) return { ok: false, error: `上传失败：HTTP ${put.status}` }
  } catch (err) {
    return { ok: false, error: `上传失败：${err.message}` }
  }

  onProgress?.({ phase: 'parse', detail: '云端解析中' })
  const deadline = Date.now() + c.timeoutSec * 1000
  let result = null
  let lastDetail = ''
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000))
    const r = await api(`/extract-results/batch/${batchId}`, { token: t, timeout: 20000 })
    const it = r.json?.data?.extract_result?.[0]
    if (!it) continue
    if (it.progress?.extracted_pages) {
      const detail = `${it.progress.extracted_pages}/${it.progress.total_pages} 页`
      if (detail !== lastDetail) {
        lastDetail = detail
        onProgress?.({ phase: 'parse', detail })
      }
    }
    if (it.state === 'done') {
      result = it
      break
    }
    if (it.state === 'failed') return { ok: false, error: `云端解析失败：${it.err_msg ?? '未知原因'}` }
  }
  if (!result) return { ok: false, error: `云端解析超时（${c.timeoutSec}s）` }
  if (!result.full_zip_url) return { ok: false, error: '云端没返回结果包' }

  onProgress?.({ phase: 'fetch', detail: '取回结果' })
  let zipBuf
  try {
    const z = await fetch(result.full_zip_url)
    if (!z.ok) return { ok: false, error: `取结果失败：HTTP ${z.status}` }
    zipBuf = Buffer.from(await z.arrayBuffer())
  } catch (err) {
    return { ok: false, error: `取结果失败：${err.message}` }
  }

  let entries
  try {
    entries = unzip(zipBuf)
  } catch (err) {
    return { ok: false, error: `解包失败：${err.message}` }
  }
  const mdName = [...entries.keys()].find((n) => n.toLowerCase() === 'full.md') ?? [...entries.keys()].find((n) => n.endsWith('.md'))
  if (!mdName) return { ok: false, error: '结果包里没有 markdown' }
  const markdown = entries.get(mdName).toString('utf8')
  const images = [...entries.entries()]
    .filter(([n]) => /^images\/[^/]+$/.test(n))
    .map(([n, data]) => ({ name: path.posix.basename(n), data }))

  return {
    ok: true,
    via: `mineru 云端（${modelVersion || c.modelVersion}${(isOcr ?? c.isOcr) ? '+OCR' : ''}）`,
    markdown,
    images,
    pages: result.progress?.total_pages ?? 0,
    ms: Date.now() - t0,
  }
}

/** 给设置页的「测云端」：走鉴权+连通那一步（不真上传文件），只看令牌有没有效 */
export async function test() {
  const t = token()
  if (!t) return { ok: false, error: '还没有 MinerU 令牌（见下方填写框）' }
  const t0 = Date.now()
  // 文件名只是占位：这一步云端只校验令牌与参数，不做解析（用 .pdf 后缀是因为它会按扩展名挑解析器，
  // 早先用 healthcheck.txt 会被判「不支持的类型」而看起来像鉴权失败）
  const r = await api('/file-urls/batch', {
    method: 'POST',
    token: t,
    body: {
      enable_formula: false,
      language: conf().language,
      model_version: conf().modelVersion,
      files: [{ name: 'healthcheck.pdf', is_ocr: false }],
    },
  })
  const ok = r.ok && r.json?.code === 0
  probeCache.value = ok ? { ok: true } : { ok: false, reason: 'error', error: r.json?.msg ?? r.text?.slice(0, 200) }
  probeCache.at = Date.now()
  return {
    ok,
    ms: Date.now() - t0,
    modelVersion: conf().modelVersion,
    isOcr: conf().isOcr,
    error: ok ? undefined : `云端返回 ${r.status}：${r.json?.msg ?? r.text?.slice(0, 200)}`,
  }
}
