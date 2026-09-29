/**
 * 语音合成（edge-tts）：把一段文本合成为 mp3，给「每日一句」的整句朗读用。
 *
 * 工具目录自己备（仓库里带了一份可照抄的封装：tools/edge-tts/say.py），
 * 用 config.json 的 tts.dir 指过去；dir 留空 = 没配 —— 接口照常返回，
 * 前端拿不到就自己回落浏览器自带的朗读。
 *
 * 为什么是「子进程 + 落盘缓存」而不是常驻服务：
 *   - edge-tts 是 Python 包（Node 22 的原生 WebSocket 不支持自定义 header，
 *     重写它那套带 Sec-MS-GEC 签名的协议不划算），所以复用 asr.mjs 那套
 *     「工具目录 + .venv/Scripts/python.exe + spawn」；
 *   - 但合成的文本（每日一句这种）一天只变一次，**缓存命中后是纯读盘**，
 *     进程启动那点开销被摊平了，不值得再养一个常驻进程。
 *
 * 缓存：data/tts/<sha1(voice|rate|text)>.mp3，超 CACHE_MAX 条按 mtime 淘汰。
 * 同一句话的并发请求靠 inflight 去重，别让两个人同时点就起两个 Python。
 * 上游要联网；失败时把原因原样交给调用方（前端据此退回浏览器朗读）。
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, SERVER_DIR } from '../config.mjs'
import { sendFileRange } from './range.mjs'

const DATA_DIR = path.join(SERVER_DIR, 'data', 'tts')
const CACHE_DIR = path.join(DATA_DIR, 'cache')
const TMP_DIR = path.join(DATA_DIR, 'tmp')
const DEFAULT_TOOL_DIR = ''

const CACHE_MAX = 600
const SYNTH_TIMEOUT_MS = 30000
/** 一次朗读的文本上限：再长就不是「一句话」的场景了，别让接口变成开放 TTS 代理 */
export const MAX_TEXT = 800

/** 常用音色（edge-tts 官方有几百个，这里只列够用的；前端下拉与配置说明共用） */
export const VOICES = [
  { id: 'en-US-AriaNeural', label: '英语 · 女声（美音 Aria）' },
  { id: 'en-US-GuyNeural', label: '英语 · 男声（美音 Guy）' },
  { id: 'en-GB-SoniaNeural', label: '英语 · 女声（英音 Sonia）' },
  { id: 'zh-CN-XiaoxiaoNeural', label: '中文 · 女声（晓晓）' },
  { id: 'zh-CN-YunxiNeural', label: '中文 · 男声（云希）' },
]
const VOICE_IDS = new Set(VOICES.map((v) => v.id))

function conf() {
  const t = loadConfig()?.tts ?? {}
  return {
    dir: t.dir || DEFAULT_TOOL_DIR,
    voice: t.voice || 'en-US-AriaNeural',
    voiceZh: t.voiceZh || 'zh-CN-XiaoxiaoNeural',
    rate: t.rate || '+0%',
  }
}

function toolPaths() {
  const dir = conf().dir
  return {
    dir,
    python: path.join(dir, '.venv', 'Scripts', 'python.exe'),
    script: path.join(dir, 'say.py'),
  }
}

function ensureDirs() {
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  fs.mkdirSync(TMP_DIR, { recursive: true })
}

/** 音色：认识的用配置值，不认识的落回默认（防前端传个乱七八糟的字符串上去） */
function pickVoice(voice) {
  const v = String(voice ?? '').trim()
  if (VOICE_IDS.has(v)) return v
  const c = conf()
  if (c.voice && v === '__zh__') return c.voiceZh
  return c.voice
}

/** 语速：只接受 +N% / -N% （edge-tts 的格式），其它一律回默认 */
function pickRate(rate) {
  const r = String(rate ?? '').trim()
  if (/^[+-]\d{1,3}%$/.test(r)) return r
  return conf().rate
}

function looksLikeMp3(buf) {
  if (!buf || buf.length < 64) return false
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true // ID3
  return buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0 // MPEG 帧同步字
}

function cachePathFor(text, voice, rate) {
  const hash = crypto.createHash('sha1').update(`${voice}|${rate}|${text}`).digest('hex').slice(0, 20)
  return path.join(CACHE_DIR, `${hash}.mp3`)
}

function pruneCache() {
  let files = []
  try {
    files = fs
      .readdirSync(CACHE_DIR)
      .filter((f) => f.endsWith('.mp3'))
      .map((name) => {
        const p = path.join(CACHE_DIR, name)
        try {
          const st = fs.statSync(p)
          return { path: p, mtime: st.mtimeMs, size: st.size }
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.mtime - b.mtime)
  } catch {
    return
  }
  const extra = files.length - CACHE_MAX
  if (extra <= 0) return
  for (const f of files.slice(0, extra)) {
    try {
      fs.unlinkSync(f.path)
    } catch {
      /* ignore */
    }
  }
}

export function cacheStats() {
  try {
    const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.mp3'))
    let bytes = 0
    for (const f of files) {
      try {
        bytes += fs.statSync(path.join(CACHE_DIR, f)).size
      } catch {
        /* ignore */
      }
    }
    return { count: files.length, bytes }
  } catch {
    return { count: 0, bytes: 0 }
  }
}

/** 依赖齐不齐（venv 里的 python 与 say.py 都在才算装好） */
export function status() {
  const c = conf()
  const { dir, python, script } = toolPaths()
  const hasPython = fs.existsSync(python)
  const hasScript = fs.existsSync(script)
  return {
    ok: true,
    ready: !!dir && hasPython && hasScript,
    dir,
    hasPython,
    hasScript,
    voice: c.voice,
    voiceZh: c.voiceZh,
    rate: c.rate,
    voices: VOICES,
    cache: cacheStats(),
    note: !dir
      ? '还没配朗读工具目录（配置 tts.dir，仓库里带了一份 tools/edge-tts 可照抄）—— 前端会回落浏览器自带朗读'
      : hasPython && hasScript
        ? ''
        : `工具没装好：${!hasScript ? '缺 say.py；' : ''}${!hasPython ? `缺 ${path.join(dir, '.venv', 'Scripts', 'python.exe')}` : ''}`,
  }
}

/** 起一次 python 合成，等它退出 */
function runSynthesize({ textFile, outFile, voice, rate }) {
  const { dir, python, script } = toolPaths()
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(
        python,
        ['-u', script, '--text-file', textFile, '--out', outFile, '--voice', voice, '--rate', rate],
        { cwd: dir, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } },
      )
    } catch (e) {
      return resolve({ ok: false, error: `起不了 Python：${e.message}` })
    }
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经退了 */
      }
      resolve({ ok: false, error: `合成超时（${SYNTH_TIMEOUT_MS / 1000}s）` })
    }, SYNTH_TIMEOUT_MS)
    child.stdout?.on('data', (d) => {
      out += d.toString('utf-8')
    })
    child.stderr?.on('data', (d) => {
      err += d.toString('utf-8')
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, error: `Python 启动失败：${e.message}` })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code, stdout: out.trim(), stderr: err.trim() })
    })
  })
}

/** 同一句话并发只合成一次 */
const inflight = new Map()

/**
 * 合成一段文本，返回落盘路径。
 * @returns {Promise<{ok: boolean, file?: string, cached?: boolean, voice?: string, error?: string}>}
 */
export async function speak({ text, voice, rate } = {}) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!clean) return { ok: false, error: '没有可朗读的文本' }
  if (clean.length > MAX_TEXT) return { ok: false, error: `文本太长（${clean.length} > ${MAX_TEXT} 字）` }
  // 至少要有一个字母或汉字，别拿纯符号去打上游
  if (!/[\p{L}\p{Script=Han}]/u.test(clean)) return { ok: false, error: '没有可朗读的文本' }

  const v = pickVoice(voice)
  const r = pickRate(rate)
  const file = cachePathFor(clean, v, r)

  if (fs.existsSync(file)) {
    try {
      const buf = fs.readFileSync(file)
      if (looksLikeMp3(buf)) {
        // 命中就 touch 一下（LRU：常用的别被淘汰掉）
        const now = new Date()
        try {
          fs.utimesSync(file, now, now)
        } catch {
          /* ignore */
        }
        return { ok: true, file, cached: true, voice: v, bytes: buf.length }
      }
    } catch {
      /* 缓存坏了就走下面重新合成 */
    }
  }

  const key = `${v}|${r}|${clean}`
  if (inflight.has(key)) return inflight.get(key)

  const job = (async () => {
    ensureDirs()
    const stamp = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 7)}`
    const textFile = path.join(TMP_DIR, `${stamp}.txt`)
    const outFile = path.join(TMP_DIR, `${stamp}.mp3`)
    try {
      fs.writeFileSync(textFile, clean, 'utf-8')
      const r0 = await runSynthesize({ textFile, outFile, voice: v, rate: r })
      if (!r0.ok) {
        const detail = (r0.stderr || r0.stdout || '').split('\n').filter(Boolean).pop() || ''
        return { ok: false, error: r0.error ? `${r0.error}` : `合成失败${detail ? `：${detail}` : ''}`, voice: v }
      }
      const buf = fs.readFileSync(outFile)
      if (!looksLikeMp3(buf)) return { ok: false, error: '合成结果不是有效音频', voice: v }
      try {
        fs.renameSync(outFile, file)
      } catch {
        fs.copyFileSync(outFile, file)
      }
      pruneCache()
      return { ok: true, file, cached: false, voice: v, bytes: buf.length }
    } catch (e) {
      return { ok: false, error: e.message, voice: v }
    } finally {
      for (const f of [textFile, outFile]) {
        try {
          if (fs.existsSync(f)) fs.unlinkSync(f)
        } catch {
          /* ignore */
        }
      }
      inflight.delete(key)
    }
  })()

  inflight.set(key, job)
  return job
}

/** 把合成好的 mp3 按 Range 交给浏览器（与语音随记的音频同一个出口，别再抄一份） */
export function pipeAudio(req, res, file) {
  return sendFileRange(req, res, { file, mime: 'audio/mpeg', cache: 'private, max-age=604800' })
}

export const PATHS = { DATA_DIR, CACHE_DIR }
