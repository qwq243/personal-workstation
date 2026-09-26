/**
 * 单词发音：优先走边车代理的有道词典 MP3（真人朗读、有缓存），
 * 外网/边车不可用时退回浏览器 SpeechSynthesis（不依赖外网，音质一般）。
 *
 * 短语里的 sb / sth 会先剥掉再朗读，避免把占位符念出来。
 */
import { sidecarBase, sidecarToken } from '@/core/sidecar'

export type Accent = 'us' | 'uk'

let currentAudio: HTMLAudioElement | null = null
let currentObjectUrl: string | null = null
/** 1 帧静音 wav：在点击回调里先播一下，后续异步拉到的 MP3 才不会被浏览器拦 */
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA='

export function unlockAudio() {
  if (typeof Audio === 'undefined') return
  if (!currentAudio) currentAudio = new Audio()
  try {
    currentAudio.muted = true
    currentAudio.src = SILENT_WAV
    void currentAudio.play().then(() => {
      if (currentAudio) currentAudio.muted = false
    }).catch(() => {})
  } catch {
    /* ignore */
  }
}

function speakable(term: string): string {
  return String(term ?? '')
    .replace(/\b(sb|sth|oneself)\b/gi, '')
    .replace(/[()（）[\]【】]/g, ' ')
    .replace(/[/|·•]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function stopAudio() {
  if (currentAudio) {
    currentAudio.pause()
    currentAudio.removeAttribute('src')
    currentAudio.load()
  }
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl)
    currentObjectUrl = null
  }
}

function stopSpeech() {
  try {
    window.speechSynthesis?.cancel()
  } catch {
    /* ignore */
  }
}

export function stopSpeaking() {
  stopAudio()
  stopSpeech()
}

function pickEnglishVoice(): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis?.getVoices?.() ?? []
  return (
    voices.find((v) => /en-US/i.test(v.lang) && /google|microsoft|samantha|aria/i.test(v.name)) ||
    voices.find((v) => /en-US/i.test(v.lang)) ||
    voices.find((v) => /^en[-_]/i.test(v.lang))
  )
}

function speakLocal(text: string, accent: Accent): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!window.speechSynthesis) {
      reject(new Error('本机没有语音引擎'))
      return
    }
    stopSpeech()
    const u = new SpeechSynthesisUtterance(text)
    u.lang = accent === 'uk' ? 'en-GB' : 'en-US'
    const voice = pickEnglishVoice()
    if (voice) u.voice = voice
    u.rate = 0.92
    u.onend = () => resolve()
    u.onerror = () => reject(new Error('系统朗读失败'))
    window.speechSynthesis.speak(u)
  })
}

async function fetchYoudao(text: string, accent: Accent): Promise<Blob> {
  const t = sidecarToken()
  const qs = new URLSearchParams({ q: text, accent })
  if (t) qs.set('token', t)
  const res = await fetch(`${sidecarBase()}/api/vocab/audio?${qs.toString()}`, {
    headers: t ? { 'X-WS-Token': t } : {},
  })
  const ct = res.headers.get('content-type') || ''
  if (!res.ok || !ct.includes('audio')) {
    let msg = `HTTP ${res.status}`
    try {
      const j = await res.json()
      if (j?.error) msg = j.error
    } catch {
      /* 非 JSON 就算了 */
    }
    throw new Error(msg)
  }
  const blob = await res.blob()
  if (!blob.size) throw new Error('空音频')
  return blob
}

function playBlob(blob: Blob): Promise<void> {
  stopSpeech()
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl)
    currentObjectUrl = null
  }
  const url = URL.createObjectURL(blob)
  currentObjectUrl = url
  const audio = currentAudio ?? new Audio()
  currentAudio = audio
  audio.muted = false
  audio.src = url
  return new Promise((resolve, reject) => {
    audio.onended = () => resolve()
    audio.onerror = () => reject(new Error('音频播放失败'))
    audio.play().catch(reject)
  })
}

/**
 * 朗读一个英文词或短语。
 * 返回 true 表示走了有道真人发音，false 表示退回系统朗读。
 */
export async function speakTerm(term: string, accent: Accent = 'us'): Promise<boolean> {
  const text = speakable(term)
  if (!text) throw new Error('没有可朗读的英文')
  stopSpeech()
  if (currentAudio) currentAudio.pause()
  try {
    const blob = await fetchYoudao(text, accent)
    await playBlob(blob)
    return true
  } catch {
    await speakLocal(text, accent)
    return false
  }
}
