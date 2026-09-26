/**
 * 文档解析：把本机的 pdf / docx / xlsx / pptx 等文件抽成 markdown 文本，供知识库导入。
 *
 * 各通道的能力边界（实测过一圈，别指望一条命令打天下）：
 *   · pandoc 读 docx / html / csv，**读不了 pptx 与 xlsx**；
 *   · LibreOffice 是万金油但慢（单文件 3.8s），而且 **必须用 soffice.com 不能用 soffice.exe**
 *     （.exe 是 GUI 子系统程序，在无控制台环境会挂死到超时）；
 *   · PDF 走 pdftotext（Xpdf 或 poppler 都行；真实 PDF 正常，自造缺字体的会失败）；
 *   · pptx / xlsx 交给 Python 库（python-pptx / openpyxl，200ms 级）最省事；
 *   · 扫描版 PDF 没有可用 OCR —— 这类文件会明确报「抽不出文字」，而不是给一份空文档充数，
 *     或者直接开云端解析（MinerU）把 OCR 交给它。
 *
 * **工具在哪**：优先读 config.json 的 `docparse.tools.{pandoc,soffice,python,pdftotext}`；
 * 那一项为空时按 PATH（where/which）找；再找不到就回落几个本机常见安装位。
 * 全都没有时，报错必须点名「缺哪个工具 + 用哪句话装它」，不能只说「抽不出文字」。
 *
 * 输出统一按 UTF-8 读、去 BOM、把 CRLF 归一成 LF（soffice 的 txt 带 BOM，漏了会在正文里留一个看不见的字符）。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { loadConfig } from '../config.mjs'
import * as cloud from './wiki-cloud.mjs'

/** 各工具的安装提示（报错文案里点名，别让用户猜） */
export const TOOL_HINTS = {
  pandoc: '装 pandoc（https://pandoc.org/installing.html），或把可执行文件路径填进设置页的 docparse.tools.pandoc',
  soffice: '装 LibreOffice，或把 soffice.com 的路径填进设置页的 docparse.tools.soffice（注意要 .com 不是 .exe）',
  python: '装 Python 3，或把解释器路径填进设置页的 docparse.tools.python（并 pip install python-pptx openpyxl pypdf）',
  pdftotext: '装 Xpdf / poppler-utils，或把 pdftotext 的路径填进设置页的 docparse.tools.pdftotext',
}

/** 找不到时的常见安装位（只作为最后兜底，不再写死某一台机器的路径） */
const FALLBACK_PATHS = {
  pandoc: ['C:/Program Files/Pandoc/pandoc.exe'],
  soffice: ['C:/Program Files/LibreOffice/program/soffice.com'],
  python: ['python3.exe', 'python.exe'],
  pdftotext: ['C:/Program Files/poppler/bin/pdftotext.exe'],
}

let toolCache = null

function which(name) {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    const out = execFileSync(cmd, [name], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const first = out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0]
    return first && fs.existsSync(first) ? first : ''
  } catch {
    return ''
  }
}

/** 解析一个工具的路径：配置项 → PATH → 常见安装位；都没有返回 '' */
function resolveTool(name) {
  const fromCfg = loadConfig().docparse?.tools?.[name]
  if (fromCfg && fs.existsSync(String(fromCfg))) return String(fromCfg)
  const fromPath = which(name)
  if (fromPath) return fromPath
  for (const cand of FALLBACK_PATHS[name] ?? []) {
    if (fs.existsSync(cand) || which(cand)) return fs.existsSync(cand) ? cand : which(cand)
  }
  return ''
}

/** 本机可用的外部通道；**每次进程内只解析一遍**（解析要 spawn where，别在热路径上做） */
export function tools({ force = false } = {}) {
  if (toolCache && !force) return toolCache
  toolCache = {}
  for (const name of ['pandoc', 'soffice', 'python', 'pdftotext']) toolCache[name] = resolveTool(name)
  return toolCache
}

/** 兼容旧写法：`TOOLS.pandoc` 这种取值照旧能用（惰性取一次） */
export const TOOLS = new Proxy({}, { get: (_t, k) => tools()[k] ?? '' })

/** 直接读文本的扩展名（不走外部程序） */
const PLAIN = new Set(['.md', '.markdown', '.mdx', '.txt', '.org', '.log', '.json', '.yaml', '.yml'])
/** 支持导入的全部扩展名（与桌面端 sourceWatch 的 includeExtensions 对齐） */
export const SUPPORTED = new Set([
  ...PLAIN,
  '.html', '.htm', '.csv', '.rtf',
  '.docx', '.doc',
  '.xlsx', '.xls',
  '.pptx', '.ppt',
  '.pdf',
  // 图片也能进库：走云端 OCR 把图里的文字抽出来（本地通道对图片无能为力）
  '.png', '.jpg', '.jpeg', '.webp',
])
/** 本机抽不出文字的（写明原因，别让用户以为是自己操作错了） */
export const UNSUPPORTED_NOTE = {
  '.pdf': '本地 PDF 通道只能抽文本层（表格会塌、图片拿不到），扫描版更是抽不出来 —— 开云端解析（MinerU）即可解决',
}

function run(exe, args, { timeout = 120000, cwd } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(exe, args, { windowsHide: true, cwd })
    } catch (err) {
      return resolve({ code: -1, out: '', err: String(err?.message ?? err), ms: 0 })
    }
    const t0 = Date.now()
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill(), timeout)
    child.stdout?.on('data', (d) => (out += d.toString('utf8')))
    child.stderr?.on('data', (d) => (err += d.toString('utf8')))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, out, err: String(e?.message ?? e), ms: Date.now() - t0 })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, err, ms: Date.now() - t0 })
    })
  })
}

function readText(file) {
  const buf = fs.readFileSync(file)
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  return buf.slice(bom ? 3 : 0).toString('utf8').replace(/\r\n/g, '\n')
}

/** 通道可用性（跑一次、缓存住；面板的「环境」一栏也读它） */
let availCache = null
export async function availability({ force = false } = {}) {
  if (availCache && !force) return availCache
  const t = tools({ force })
  const checks = {}
  for (const name of ['pandoc', 'soffice', 'python', 'pdftotext']) {
    checks[name] = !!t[name]
    if (!t[name]) checks[name + 'Hint'] = TOOL_HINTS[name]
  }
  if (checks.python) {
    const r = await run(t.python, ['-X', 'utf8', '-c', 'import importlib.util as u;print("".join(k for k in ["fitz","pypdf","pypdfium2","docx","openpyxl","pptx"] if u.find_spec(k)))'])
    checks.pythonLibs = r.code === 0 ? r.out.trim() : ''
  }
  availCache = checks
  return checks
}

/** 输出文件名的临时目录（每个任务一个，避免并发时互相覆盖） */
async function workDir() {
  const dir = path.join(os.tmpdir(), `wiki-parse-${process.pid}-${Date.now().toString(36)}`)
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

async function cleanup(dir) {
  try {
    await fsp.rm(dir, { recursive: true, force: true })
  } catch {
    /* 临时目录清不掉不影响主流程 */
  }
}

/** pandoc 把任意它能读的格式转 GFM */
async function viaPandoc(src, from) {
  const r = await run(TOOLS.pandoc, ['-f', from, '-t', 'gfm', src], { timeout: 60000 })
  if (r.code !== 0 || !r.out.trim()) return { ok: false, error: r.err.trim() || `pandoc 退出码 ${r.code}` }
  return { ok: true, text: r.out.replace(/\r\n/g, '\n'), via: `pandoc(${from}→gfm)`, ms: r.ms }
}

/** LibreOffice 转换；target 形如 'md' 或 'csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,true' */
async function viaSoffice(src, target) {
  const dir = await workDir()
  try {
    // 并发时必须给独立 profile：共用默认 profile 时第二个任务会静默退出（实测）
    const profile = `file:///${path.join(os.tmpdir(), `lo-${process.pid}-${Date.now().toString(36)}`).replace(/\\/g, '/')}`
    const r = await run(
      TOOLS.soffice,
      [`-env:UserInstallation=${profile}`, '--headless', '--norestore', '--convert-to', target, '--outdir', dir, src],
      { timeout: 180000 },
    )
    const made = fs.readdirSync(dir).filter((f) => !f.startsWith('.'))
    if (r.code !== 0 || !made.length) {
      return { ok: false, error: r.err.trim().split('\n').filter((l) => !l.includes('platform independent libraries')).join(' ').slice(0, 200) || `soffice 退出码 ${r.code}（该格式可能不支持）` }
    }
    return { ok: true, text: readText(path.join(dir, made[0])), via: `libreoffice(${target.split(':')[0]})`, file: path.join(dir, made[0]), ms: r.ms, dir }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

/**
 * 用 Python 库抽文本。script 里用 `{src}` 占位；各库都打 stdout，编码统一 utf-8。
 * （中文脚本走 -c 容易被命令行代码页糟蹋，所以这里把脚本读成 utf-8 临时文件再执行。）
 *
 * 占位替换成 **JSON 字符串字面量**（带引号），不是裸路径 —— 早先直接塞路径进去，
 * 生成的是 `load_workbook(C:/x/t.xlsx)`，语法错误 → 静默回落到 LibreOffice，白等 10 秒。
 */
async function viaPython(script, src) {
  const dir = await workDir()
  try {
    const py = path.join(dir, 'parse.py')
    await fsp.writeFile(py, script.replace(/\{src\}/g, JSON.stringify(src.replace(/\\/g, '/'))), 'utf8')
    const r = await run(TOOLS.python, ['-X', 'utf8', py], { timeout: 120000 })
    if (r.code !== 0 || !r.out.trim()) return { ok: false, error: (r.err || '').trim().split('\n').slice(-3).join(' ').slice(0, 300) || `python 退出码 ${r.code}` }
    return { ok: true, text: r.out.replace(/\r\n/g, '\n'), via: 'python', ms: r.ms }
  } finally {
    await cleanup(dir)
  }
}

const PY_PDF = `import sys
try:
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument({src})
    out = []
    for i in range(len(doc)):
        out.append(doc[i].get_textpage().get_text_range())
    sys.stdout.write("\\n\\n".join(out))
except Exception:
    from pypdf import PdfReader
    r = PdfReader({src})
    sys.stdout.write("\\n\\n".join((p.extract_text() or "") for p in r.pages))
`

const PY_PPTX = `from pptx import Presentation
import sys
out = []
p = Presentation({src})
for i, slide in enumerate(p.slides, 1):
    out.append(f"## Slide {i}")
    for shape in slide.shapes:
        if shape.has_text_frame and shape.text_frame.text.strip():
            out.append(shape.text_frame.text.strip())
        if getattr(shape, "has_table", False) and shape.has_table:
            for row in shape.table.rows:
                out.append(" | ".join(c.text.strip() for c in row.cells))
sys.stdout.write("\\n\\n".join(out))
`

const PY_XLSX = `import openpyxl, sys
wb = openpyxl.load_workbook({src}, data_only=True)
out = []
for ws in wb.worksheets:
    out.append(f"## {ws.title}")
    for row in ws.iter_rows(values_only=True):
        cells = ["" if c is None else str(c) for c in row]
        if any(c.strip() for c in cells):
            out.append(" | ".join(cells).strip())
sys.stdout.write("\\n\\n".join(out))
`

const PY_DOCX = `import sys
from docx import Document
d = Document({src})
out = []
for p in d.paragraphs:
    if p.text.strip():
        out.append(p.text.strip())
for t in d.tables:
    for row in t.rows:
        out.append(" | ".join(c.text.strip() for c in row.cells))
sys.stdout.write("\\n\\n".join(out))
`

/**
 * 抽一份文件的文本。返回 { ok, text, via, ms, images? } 或 { ok:false, error }。
 *
 * **云端优先**（MinerU，见 wiki-cloud.mjs）：pdf/docx/ppt/xls 这些 MinerU 能吃的类型先送云端 ——
 * 它能出真表格、抽图片、OCR 扫描件，本地通道做不到这三件事。云端不可用（没令牌/关掉了/网络不通）
 * 或解析失败时，**自动回落到本地通道**，并把云端的失败原因挂在返回值的 cloudError 里（页面/队列能看到）。
 *
 * 本地通道按格式分派（各条都是实测过的）：
 *   docx → pandoc（200ms）→ python-docx → LibreOffice
 *   xlsx → openpyxl → LibreOffice(csv)
 *   pptx → python-pptx → LibreOffice(html 去标签)
 *   pdf  → pdftotext（Xpdf）→ pypdfium2/pypdf
 *   html/csv/rtf → pandoc
 */
export async function extract(absPath, { onProgress } = {}) {
  const ext = path.extname(absPath).toLowerCase()
  const avail = await availability()
  if (!fs.existsSync(absPath)) return { ok: false, error: `文件不存在：${absPath}` }
  if (!SUPPORTED.has(ext)) {
    return { ok: false, error: `不支持的类型 ${ext}（支持：${[...SUPPORTED].join(' ')}）` }
  }
  const size = fs.statSync(absPath).size
  if (size > 200 * 1024 * 1024) return { ok: false, error: `文件太大（${Math.round(size / 1048576)} MB，上限 200 MB）` }

  if (PLAIN.has(ext)) {
    const text = readText(absPath)
    return { ok: true, text, via: 'plain', ms: 0 }
  }

  // ---- 云端优先 ----
  if (cloud.CLOUD_TYPES.has(ext)) {
    const ready = await cloud.available()
    if (ready.ok) {
      const r = await cloud.parseFile(absPath, { onProgress })
      if (r.ok) return { ok: true, text: r.markdown, images: r.images, via: r.via, ms: r.ms, pages: r.pages }
      // 云端失败不当成终局：本地还有通道，带着原因往下走
      onProgress?.({ phase: 'fallback', detail: `云端失败，改用本地通道：${r.error}` })
      var cloudError = r.error
    } else {
      var cloudError = ready.error
    }
  }

  const local = await extractLocal(absPath, { ext, avail })
  if (local.ok && cloudError) local.cloudError = cloudError
  else if (!local.ok && cloudError) local.error = `${local.error}；云端也没成功：${cloudError}`
  return local
}

/**
 * 一个通道都没成功时，把「缺哪些工具、怎么装」一并说出来。
 * 只说「抽不出文字」等于把排障丢给用户 —— 那句话在开源版里是不可接受的。
 */
function missingToolsNote(avail, names) {
  const miss = names.filter((n) => !avail[n])
  if (!miss.length) return ''
  return `缺少工具：${miss.map((n) => `${n}（${TOOL_HINTS[n]}）`).join('；')}`
}

/** 本地通道（云端关掉/失败时的回落，也可以单独用） */
async function extractLocal(absPath, { ext, avail }) {
  if (ext === '.pdf') {
    const tries = []
    if (avail.pdftotext) {
      const r = await run(TOOLS.pdftotext, ['-enc', 'UTF-8', absPath, '-'], { timeout: 120000 })
      const text = r.out.replace(/\r\n/g, '\n')
      if (r.code === 0 && text.replace(/[\s\f]/g, '').length > 20) return { ok: true, text, via: 'pdftotext', ms: r.ms }
      tries.push(`pdftotext: ${r.err.trim().slice(0, 120) || '几乎没抽出文字'}`)
    }
    if (avail.python) {
      const r = await viaPython(PY_PDF, absPath)
      if (r.ok && r.text.replace(/\s/g, '').length > 20) return { ...r, via: 'python(pypdfium2/pypdf)' }
      tries.push(`python: ${r.error ?? '几乎没抽出文字'}`)
    }
    const miss = missingToolsNote(avail, ['pdftotext', 'python'])
    return { ok: false, error: `${UNSUPPORTED_NOTE['.pdf']}${miss ? `。${miss}` : ''}（${tries.join('；')}）` }
  }

  if (ext === '.docx' || ext === '.doc') {
    if (avail.pandoc) {
      const r = await viaPandoc(absPath, ext === '.docx' ? 'docx' : 'doc')
      if (r.ok) return r
    }
    if (avail.python && ext === '.docx') {
      const r = await viaPython(PY_DOCX, absPath)
      if (r.ok) return { ...r, via: 'python-docx' }
    }
    const r = await viaSoffice(absPath, 'md')
    if (r.ok) return r
    return {
      ok: false,
      error:
        'docx 解析失败：pandoc / python-docx / libreoffice 都没成功。' +
        missingToolsNote(avail, ['pandoc', 'python', 'soffice']),
    }
  }

  if (ext === '.xlsx' || ext === '.xls') {
    if (avail.python) {
      const r = await viaPython(PY_XLSX, absPath)
      if (r.ok) return { ...r, via: 'openpyxl' }
    }
    const r = await viaSoffice(absPath, 'csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,true')
    if (r.ok) return r
    return {
      ok: false,
      error: 'xlsx 解析失败：openpyxl 与 libreoffice 都没成功。' + missingToolsNote(avail, ['python', 'soffice']),
    }
  }

  if (ext === '.pptx' || ext === '.ppt') {
    if (avail.python && ext === '.pptx') {
      const r = await viaPython(PY_PPTX, absPath)
      if (r.ok) return { ...r, via: 'python-pptx' }
    }
    const r = await viaSoffice(absPath, 'html')
    if (r.ok) {
      const text = r.text
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>|<\/div>|<\/h\d>|<\/li>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
      return { ok: true, text, via: 'libreoffice(html→去标签)', ms: r.ms }
    }
    return {
      ok: false,
      error: 'pptx 解析失败：python-pptx 与 libreoffice 都没成功。' + missingToolsNote(avail, ['python', 'soffice']),
    }
  }

  // html / csv / rtf 这类交给 pandoc
  if (avail.pandoc) {
    const from = ext === '.csv' ? 'csv' : ext === '.rtf' ? 'rtf' : 'html'
    const r = await viaPandoc(absPath, from)
    if (r.ok) return r
  }
  if (ext === '.csv') return { ok: true, text: readText(absPath), via: 'plain(csv)', ms: 0 }
  if (ext === '.html' || ext === '.htm') {
    const text = readText(absPath)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s{2,}/g, ' ')
    return { ok: true, text, via: 'html(去标签)', ms: 0 }
  }
  return {
    ok: false,
    error: `没有可用通道解析 ${ext}。` + missingToolsNote(avail, ['pandoc', 'soffice', 'python', 'pdftotext']),
  }
}

/**
 * 把抽出的文本存成 raw/sources 里的 markdown 源文件（与 wiki-fetch 同一套命名与头部约定）。
 * 云端解析还会带回来图片：落到 `raw/assets/<同名目录>/`，并把正文里的 `images/xxx.jpg`
 * 改写成库内相对路径（`raw/assets/<名>/xxx.jpg`）—— 这样页面里的 /api/wiki/asset 能直接显示，
 * 库也不会因为外链失效而丢图。
 */
export async function saveExtracted(dir, { absPath, text, via, title, slug, images = [] }) {
  const base = String(title || path.basename(absPath, path.extname(absPath))).trim()
  const name = String(slug || base)
    .toLowerCase()
    .replace(/[·:：,，。!！?？”'“”''、/\\|<>*]+/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || `doc-${Date.now().toString(36)}`
  const rel = `raw/sources/${name}.md`
  const abs = path.join(dir, rel.split('/').join(path.sep))
  if (fs.existsSync(abs)) return { ok: false, error: `同名源文件已存在：${rel}`, path: rel, exists: true }

  let body = String(text).trim()
  let savedImages = 0
  let referenced = 0
  if (images.length) {
    const assetRel = `raw/assets/${name}`
    const assetAbs = path.join(dir, assetRel.split('/').join(path.sep))
    await fsp.mkdir(assetAbs, { recursive: true })
    for (const im of images) {
      const safe = String(im.name).replace(/[\\/:*?"<>|]/g, '_')
      await fsp.writeFile(path.join(assetAbs, safe), im.data)
      savedImages += 1
    }
    // MinerU 正文里引用的是 images/xxx.jpg；本地通道没有图，所以这里只改存在的引用。
    // 有的文档一张都不引用（那些是版面渲染出的页块图）：图仍按原始资料一并存下来，
    // 但头部要写清「存了几张、正文引用几张」，免得看着像丢了东西。
    body = body.replace(/!\[([^\]]*)\]\((?:\.\/)?images\/([^)]+)\)/g, (_m, alt, file) => {
      referenced += 1
      const safe = String(file).replace(/[\\/:*?"<>|]/g, '_')
      return `![${alt}](${assetRel}/${safe})`
    })
  }

  const today = new Date().toISOString().slice(0, 10)
  const head = [
    '---',
    `title: ${base}`,
    'type: raw-source',
    `origin: ${absPath.replace(/\\/g, '/')}`,
    'author: 本地文件',
    `published: ${(fs.existsSync(absPath) ? fs.statSync(absPath).mtime : new Date()).toISOString().slice(0, 10)}`,
    `fetched: ${today}`,
    `via: ${via}`,
    ...(savedImages ? [`assets: 存 ${savedImages} 张，正文引用 ${referenced} 张（raw/assets/${name}/）`] : []),
    '---',
    '',
    `# ${base}`,
    '',
  ]
  await fsp.mkdir(path.dirname(abs), { recursive: true })
  await fsp.writeFile(abs, `${head.join('\n')}${body}\n`, 'utf8')
  return { ok: true, path: rel, abs, title: base, chars: body.length, via, images: savedImages }
}
