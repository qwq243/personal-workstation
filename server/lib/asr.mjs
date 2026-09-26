/**
 * 转写后端 —— 只有一个实现：**OpenAI 兼容的 `/audio/transcriptions`**（whisper 接口）。
 *
 * 为什么只有一个：语音转写这件事的「标准接口」已经收敛到这一条（OpenAI 定的形状，
 * whisper.cpp / faster-whisper-server / 各种云厂商都照着实现），所以这里不做插件注册表，
 * 只留一个 provider；要换实现，换 baseUrl 就是了。
 *
 * 刻意**不包含**任何针对某个具体客户端做逆向的本机链路：那种东西换个版本就失效，
 * 还要求使用者装一整套别人的私有工具目录，不适合随代码分发。
 *
 * 配置（config.json）：
 *   asr.provider    'openai' | 'none'      —— none = 关掉转写
 *   asr.baseUrl     例如 http://127.0.0.1:8080/v1   （留空 = 未配置）
 *   asr.model       例如 whisper-1 / large-v3
 *   asr.language    可选，zh / en …（留空让服务端判断）
 *   asr.timeoutSec  单次请求超时（默认 600）
 * credentials.json 的 `asr.apiKey` 存密钥（本机服务不需要就留空）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../config.mjs'

export function conf() {
  const a = loadConfig().asr ?? {}
  return {
    provider: String(a.provider ?? 'openai') === 'none' ? 'none' : 'openai',
    baseUrl: String(a.baseUrl ?? '').replace(/\/+$/, ''),
    model: String(a.model ?? 'whisper-1'),
    language: String(a.language ?? ''),
    timeoutSec: Math.max(30, Number(a.timeoutSec) || 600),
    apiKey: String(a.apiKey ?? ''),
  }
}

/** 这台机器上转写可不可用（页面据此决定显示「去配置」还是操作区） */
export function status() {
  const c = conf()
  if (c.provider === 'none') return { ok: false, configured: false, reason: '转写已关闭（config.json 的 asr.provider = none）' }
  if (!c.baseUrl) return { ok: false, configured: false, reason: '还没填转写端点：设置 → 转写后端（config.json 的 asr.baseUrl）' }
  return { ok: true, configured: true, provider: c.provider, baseUrl: c.baseUrl, model: c.model, language: c.language, hasKey: !!c.apiKey }
}

/** 支持哪些音频扩展名（服务端一般只认这几种；别的先拦下来，省一次无用的上传） */
export const AUDIO_EXT = new Set(['.mp3', '.mp4', '.m4a', '.wav', '.webm', '.ogg', '.oga', '.flac', '.aac', '.opus', '.amr', '.wma', '.mov', '.mkv'])

function mimeOf(ext) {
  return (
    {
      '.mp3': 'audio/mpeg',
      '.mp4': 'video/mp4',
      '.m4a': 'audio/mp4',
      '.wav': 'audio/wav',
      '.webm': 'audio/webm',
      '.ogg': 'audio/ogg',
      '.oga': 'audio/ogg',
      '.flac': 'audio/flac',
      '.aac': 'audio/aac',
      '.opus': 'audio/opus',
      '.amr': 'audio/amr',
      '.wma': 'audio/x-ms-wma',
      '.mov': 'video/quicktime',
      '.mkv': 'video/x-matroska',
    }[ext] ?? 'application/octet-stream'
  )
}

/**
 * 转一个本地文件，返回 `{ ok, text, model, ms }` 或 `{ ok:false, error }`。
 *
 * 用 FormData + fetch：Node 18+ 自带 multipart 编码，不必自己拼 boundary。
 * 超时用 AbortController —— 长音频转写本来就慢，所以超时给得宽（默认 600s），
 * 但**必须有**，否则一个卡住的请求会一直挂着。
 */
export async function transcribeFile(absPath, { language, model, signal } = {}) {
  const c = conf()
  const st = status()
  if (!st.ok) return { ok: false, error: st.reason }
  if (!fs.existsSync(absPath)) return { ok: false, error: `找不到文件：${absPath}` }
  const ext = path.extname(absPath).toLowerCase()
  if (!AUDIO_EXT.has(ext)) {
    return { ok: false, error: `不支持的音频格式 ${ext || '(无扩展名)'}（支持：${[...AUDIO_EXT].join(' ')}）` }
  }

  const t0 = Date.now()
  const buf = await fs.promises.readFile(absPath)
  const form = new FormData()
  form.append('file', new Blob([buf], { type: mimeOf(ext) }), path.basename(absPath))
  form.append('model', String(model || c.model))
  const lang = String(language ?? c.language ?? '').trim()
  if (lang) form.append('language', lang)
  // response_format=json：只要正文，不要分段时间轴（时间轴服务端未必给得准，就不装了）
  form.append('response_format', 'json')

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), c.timeoutSec * 1000)
  if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true })
  try {
    const res = await fetch(`${c.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {},
      body: form,
      signal: ctrl.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      let msg = text.slice(0, 300)
      try {
        msg = JSON.parse(text)?.error?.message ?? msg
      } catch {
        /* 非 JSON 错误体 */
      }
      return { ok: false, status: res.status, error: `HTTP ${res.status}：${msg}`, ms: Date.now() - t0 }
    }
    let body = {}
    try {
      body = JSON.parse(text)
    } catch {
      return { ok: false, error: `响应不是 JSON：${text.slice(0, 200)}`, ms: Date.now() - t0 }
    }
    const out = String(body.text ?? body.result ?? '').trim()
    if (!out) return { ok: false, error: '转写结果是空的（音频里可能没有人声）', ms: Date.now() - t0 }
    return { ok: true, text: out, model: body.model ?? c.model, ms: Date.now() - t0 }
  } catch (err) {
    const aborted = err?.name === 'AbortError'
    return {
      ok: false,
      error: aborted ? `转写超时（>${c.timeoutSec}s）—— 音频太长或端点太慢，可调大 asr.timeoutSec` : err.message,
      ms: Date.now() - t0,
    }
  } finally {
    clearTimeout(timer)
  }
}
