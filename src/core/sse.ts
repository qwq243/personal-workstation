/**
 * 边车 SSE 流的公共读法（三条流式调用共用一份，别各写一遍）。
 *
 * 为什么不用 EventSource：它只能发 GET（对话体要 POST），也不能带自定义头
 * —— 边车的 X-WS-Token 就传不过去。所以这里手动读 ReadableStream，按 SSE 的
 * 「空行分帧」自己切：`data:` 后面那段 JSON 解析出来交给 onEvent，半帧丢掉下一轮补。
 *
 * 这一层只负责「解析出对象并交出去」，不规定帧的形状：
 * 语音随记 / 知识库是 `{ type: … }`，测聊是扁平字段（`{ delta }` / `{ done: true }`），
 * 各由调用方自己认。失败也不替调用方措辞 —— 经 onFailure 交回原因，
 * 由它决定发什么事件（那三条流的错误事件形状本来就不一样）。
 */

/** 解析好的一帧；形状由各自的流约定，这里不解释 */
export type SseEventHandler = (event: any) => void

/** 流没读成的原因，交给调用方翻译成自己的错误事件 */
export type SseFailure =
  | { kind: 'http'; status: number; /** 响应正文（读不出来就是空串） */ text: string }
  | { kind: 'no-body' }
  | { kind: 'abort' }
  | { kind: 'exception'; error: any }

export interface SseStreamOptions {
  /** 调用方的取消信号（页面「停止」按钮） */
  signal?: AbortSignal
  /** 额外请求头；Content-Type: application/json 已默认带上 */
  headers?: Record<string, string>
  /** 取访问令牌的路子（就是 call() 用的 ensureToken：拿到了才加 X-WS-Token） */
  getToken?: () => Promise<string | null>
  /** 整个过程的上限；超时按 abort 处理，不单独发事件（现在三个调用点都没传） */
  timeoutMs?: number
  /** 失败回调；abort 也会回调，要不要发声由调用方定 */
  onFailure?: (f: SseFailure) => void
}

/**
 * POST 一个 SSE 接口，把逐帧 JSON 交给 onEvent。
 *
 * 正常读完 / 被 abort / HTTP 非 200 / 拿不到 body，都正常 resolve：出错只走 onFailure，
 * 不在这里抛，也不替你发「error 事件」——三条流的错误事件形状不一样，措辞也在调用方那边。
 */
export async function readSseStream(
  url: string,
  body: unknown,
  onEvent: SseEventHandler,
  opts: SseStreamOptions = {},
): Promise<void> {
  const fail = (f: SseFailure) => opts.onFailure?.(f)

  // 可选的整体超时：借 AbortController 的语义，跟调用方给的 signal 并到一起（只有一个能进 fetch）
  let timer: ReturnType<typeof setTimeout> | null = null
  let signal = opts.signal
  if (opts.timeoutMs) {
    const ctl = new AbortController()
    timer = setTimeout(() => ctl.abort(), opts.timeoutMs)
    if (opts.signal) {
      if (opts.signal.aborted) ctl.abort()
      else opts.signal.addEventListener('abort', () => ctl.abort(), { once: true })
    }
    signal = ctl.signal
  }

  try {
    const t = opts.getToken ? await opts.getToken() : null
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...opts.headers }
    if (t) headers['X-WS-Token'] = t
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      fail({ kind: 'http', status: res.status, text })
      return
    }
    if (!res.body) {
      fail({ kind: 'no-body' })
      return
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const frames = buf.split('\n\n')
      buf = frames.pop() ?? ''
      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data:'))
        if (!line) continue
        try {
          onEvent(JSON.parse(line.slice(5).trim()))
        } catch {
          /* 半帧（上游把一帧拆成两个 chunk）：丢掉，下一轮会补全 */
        }
      }
    }
  } catch (err: any) {
    // 用户点「停止」是我们自己 abort 的，不算错误
    if (err?.name === 'AbortError') fail({ kind: 'abort' })
    else fail({ kind: 'exception', error: err })
  } finally {
    if (timer) clearTimeout(timer)
  }
}
