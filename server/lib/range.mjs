/**
 * 二进制文件按 Range 交给浏览器（`<audio>` / `<video>` / `<img>` 都用它）。
 *
 * 为什么要抽这一层：语音随记的原始录音、宽屏播放页那些都走同一件事 ——
 * **拖进度条靠 206 + Content-Range**，一次给完整文件的话每次跳转都得重下（几十 MB 起步）。
 * 抄第二份的时候就是第三次踩同一个坑（`memo.streamAudio` 是第一次）。
 *
 * 用法：`const done = sendFileRange(req, res, abs, { mime })`；返回 true 表示已经接管响应，
 * 路由层直接 `return 'handled'`。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 常见后缀 → MIME（够用就行，认不出的按二进制下发） */
const MIME = {
  // 音频
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.wma': 'audio/x-ms-wma',
  // 视频 / 短剧
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.flv': 'video/x-flv',
  // 图片（漫画页）
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  // 文本（小说）
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
}

export function mimeOf(file) {
  return MIME[path.extname(String(file ?? '')).toLowerCase()] ?? 'application/octet-stream'
}

/** 不合法/不可读 → 返回 null，由调用方决定怎么报错 */
export function statFile(file) {
  try {
    const abs = path.resolve(String(file ?? ''))
    const st = fs.statSync(abs)
    if (!st.isFile()) return null
    return { abs, size: st.size }
  } catch {
    return null
  }
}

/**
 * 把文件（或内存里的 Buffer）按 Range 发出去。已经接管响应时返回 true。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{file?: string, buffer?: Buffer, mime?: string, cache?: string, download?: string}} opts
 */
export function sendFileRange(req, res, opts = {}) {
  const mime = opts.mime || mimeOf(opts.file)
  const cache = opts.cache ?? 'private, max-age=600'
  const head = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': cache }
  if (opts.download) head['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(opts.download)}`

  // 内存里的字节（漫画从 zip 里解出来的那一页）：没得 Range，直接整体给
  if (opts.buffer) {
    res.writeHead(200, { ...head, 'Content-Length': String(opts.buffer.length) })
    res.end(opts.buffer)
    return true
  }

  const info = statFile(opts.file)
  if (!info) {
    res.statusCode = 404
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ ok: false, error: '文件不存在或读不到' }))
    return true
  }
  const size = info.size

  const range = String(req?.headers?.range ?? '')
  const m = range.match(/bytes=(\d*)-(\d*)/)
  if (m) {
    let start = m[1] ? Number(m[1]) : 0
    let end = m[2] ? Number(m[2]) : size - 1
    if (!m[1] && m[2]) {
      // `bytes=-500`：末尾 N 字节
      start = Math.max(0, size - Number(m[2]))
      end = size - 1
    }
    if (Number.isNaN(start) || Number.isNaN(end) || start >= size || end >= size || start > end) {
      res.writeHead(416, { ...head, 'Content-Range': `bytes */${size}` })
      res.end()
      return true
    }
    res.writeHead(206, {
      ...head,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
    })
    fs.createReadStream(info.abs, { start, end }).pipe(res)
    return true
  }

  res.writeHead(200, { ...head, 'Content-Length': String(size) })
  fs.createReadStream(info.abs).pipe(res)
  return true
}
