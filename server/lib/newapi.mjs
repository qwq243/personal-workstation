/**
 * NewAPI 兼容面板 / 网关客户端（OpenAI 兼容层）。
 *
 * 两类凭据，用途不同，不要混：
 *  - 系统访问令牌（credentials.json 的 `newapi.token`）：调 /api/* 面板接口（余额、令牌、日志）。
 *  - sk- API Key（credentials.json 的 `llm.keys.workstation`）：调 /v1/chat/completions。
 *
 * 密钥都不在本模块内硬编码，也不去读别的程序的配置文件：
 * 一律走 server/config.json + server/credentials.json 这一条来源，避免多份副本不同步。
 */
import { loadConfig } from '../config.mjs'
import { request } from './net.mjs'

/** quota → 元（按上游默认 500000 quota = 1 元） */
export const QUOTA_PER_YUAN = 500000

export function quotaToYuan(q) {
  const n = Number(q) || 0
  return Math.round((n / QUOTA_PER_YUAN) * 10000) / 10000
}

function base() {
  const url = String(loadConfig().newapi.baseUrl ?? '')
  return url.replace(/\/+$/, '')
}

/** 面板系统令牌：credentials.json 的 newapi.token（留空则面板类接口如实报「没配」） */
export function newapiToken() {
  return String(loadConfig().newapi?.token ?? '')
}

function authHeaders() {
  return {
    Authorization: `Bearer ${newapiToken()}`,
    'Content-Type': 'application/json',
  }
}

/**
 * 面板类接口的请求入口。
 *
 * 端点没配时直接回一条看得懂的错，而不是把 `/api/user/self` 这种半截 URL 丢给 fetch
 * （它只会报 "Failed to parse URL"，看着像代码坏了，其实是没配）。
 * 令牌没配也在这里拦一次，理由同上：面板接口全要令牌。
 */
function panelRequest(url, opts = {}) {
  const fail = (msg) =>
    Promise.resolve({ ok: false, status: 0, error: msg, text: '', json: undefined, headers: new Headers() })
  if (!base()) return fail('还没填 NewAPI 地址：设置 → NewAPI 地址（config.json 的 newapi.baseUrl）')
  if (!newapiToken()) return fail('还没填 NewAPI 面板令牌：server/credentials.json 的 newapi.token')
  return request(url, opts)
}

/* ------------------------------------------------------------ AI 侧 --- */

/**
 * 「工作台 / workstation」这一档模型端点。
 *
 * 端点与密钥都来自**本机工作站自己的配置**，不再去读别的客户端的配置文件：
 *   baseURL —— server/config.json 的 `newapi.baseUrl`（设置页「模型」里填）
 *   apiKey  —— credentials.json 的 `llm.keys.workstation`（设置页里填，只落本机）
 * 模型清单是 `ai.models`（可选项，留空就让调用方直接用 `ai.model`）。
 *
 * 这样开源版不需要任何作者机器的路径，谁填谁的。
 */
export function aiProvider() {
  const all = loadConfig()
  const ai = all.ai ?? {}
  const baseURL = String(all.newapi?.baseUrl ?? '').replace(/\/+$/, '')
  const presetId = String(all.llm?.activePresetId ?? 'workstation')
  const apiKey = String(all.llm?.keys?.workstation ?? all.llm?.keys?.[presetId] ?? '')
  if (!baseURL) {
    return { ok: false, error: '还没填模型端点：设置 → 模型 → newapi.baseUrl' }
  }
  if (!apiKey) {
    return { ok: false, error: '还没填模型 API Key：设置 → 模型 → 工作台这一档的密钥' }
  }
  return { ok: true, name: ai.providerName || 'workstation', apiKey, baseURL, kind: 'openai' }
}

/** 可用模型名：`ai.models` 里声明的（留空返回空数组，调用方回落到 ai.model） */
export function aiModels() {
  const models = loadConfig().ai?.models
  return Array.isArray(models) ? models.filter((m) => typeof m === 'string' && m) : []
}

/**
 * OpenAI 兼容的对话补全。messages 为 [{role, content}]。
 * 返回 { ok, content, reasoning, usage, model } 或 { ok:false, error }。
 *
 * maxTokens 是**调用方**的事（走 lib/llm.mjs 的预算档位）；本层只在没人给时兜底，
 * 且兜底值必须够大 —— 思考模型与正文共用这份预算，给小了正文就是空串，而且不报错。
 */
export const FALLBACK_MAX_TOKENS = 8000

export async function chat(messages, { model, maxTokens, temperature, timeout = 120000, extraBody } = {}) {
  const ai = loadConfig().ai
  const prov = aiProvider()
  if (!prov.ok) return { ok: false, error: prov.error }

  const body = {
    model: model || ai.model,
    messages,
    max_tokens: maxTokens ?? FALLBACK_MAX_TOKENS,
    temperature: temperature ?? ai.temperature,
    ...(extraBody && typeof extraBody === 'object' ? extraBody : {}),
  }

  const res = await request(`${prov.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${prov.apiKey}` },
    body,
    timeout,
  })

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: res.error || `HTTP ${res.status}`,
      detail: res.json?.error?.message ?? res.text?.slice(0, 400),
    }
  }
  const data = res.json
  const choice = data?.choices?.[0]
  return {
    ok: true,
    content: choice?.message?.content ?? '',
    reasoning: choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? undefined,
    usage: data?.usage,
    model: data?.model,
    provider: prov.name,
  }
}

/**
 * 流式对话：逐帧回调 onDelta，返回完整文本。
 *
 * 为什么知识库的问答需要它：带工具调用的问答要跑好几轮（检索 → 读页 → 作答），
 * 非流式的话页面只能干等十几秒；有了增量就先出字，工具轮次也走 onEvent 报给页面。
 * 帧格式与知识库问答那条流一致（data: <json>），前端复用同一套解析。
 */
export async function chatStream(messages, { model, maxTokens, temperature, timeout = 300000, signal, onDelta, onEvent, extraBody } = {}) {
  const ai = loadConfig().ai
  const prov = aiProvider()
  if (!prov.ok) return { ok: false, error: prov.error }
  const body = {
    model: model || ai.model,
    messages,
    max_tokens: maxTokens ?? FALLBACK_MAX_TOKENS,
    temperature: temperature ?? ai.temperature,
    stream: true,
    ...(extraBody && typeof extraBody === 'object' ? extraBody : {}),
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true })
  let text = ''
  let usage = null
  try {
    const res = await fetch(`${prov.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${prov.apiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok || !res.body) {
      const raw = await res.text().catch(() => '')
      let msg = raw.slice(0, 300)
      try {
        msg = JSON.parse(raw)?.error?.message ?? msg
      } catch {
        /* 非 JSON 错误体：原文带回去 */
      }
      return { ok: false, status: res.status, error: `HTTP ${res.status}`, detail: msg }
    }
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const frames = buf.split('\n\n')
      buf = frames.pop() ?? ''
      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data:'))
        if (!line) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let json
        try {
          json = JSON.parse(payload)
        } catch {
          continue
        }
        const choice = json?.choices?.[0]
        const delta = choice?.delta?.content ?? ''
        if (delta) {
          text += delta
          onDelta?.(delta)
        }
        const reasoning = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning
        if (reasoning) onEvent?.({ type: 'reasoning', text: reasoning })
        if (json?.usage) usage = json.usage
      }
    }
    return { ok: true, content: text, usage, model: body.model, provider: prov.name }
  } catch (err) {
    // 已经出了字就当成成功（半截回答也比整段丢掉好用），页面按 ok+partial 处理
    const aborted = err?.name === 'AbortError'
    if (text) return { ok: true, content: text, partial: true, error: aborted ? '超时中断' : err.message }
    return { ok: false, error: aborted ? `请求超时（${timeout}ms）` : err.message }
  } finally {
    clearTimeout(timer)
  }
}

/* -------------------------------------------------------- 面板接口 --- */

/** 账户余额（/api/user/self） */
export async function balance() {
  const res = await panelRequest(`${base()}/api/user/self`, { headers: authHeaders(), timeout: 15000 })
  if (!res.ok) {
    return { ok: false, status: res.status, error: res.error || `HTTP ${res.status}`, detail: res.json?.message ?? res.text?.slice(0, 300) }
  }
  const d = res.json?.data ?? {}
  return {
    ok: true,
    username: d.username,
    quota: d.quota,
    usedQuota: d.used_quota,
    requestCount: d.request_count,
    quotaYuan: quotaToYuan(d.quota),
    usedYuan: quotaToYuan(d.used_quota),
    group: d.group,
    raw: d,
  }
}

/** 各 API 密钥列表（/api/token/）——含每个密钥的累计花费（used_quota） */
export async function tokens() {
  const res = await panelRequest(`${base()}/api/token/?p=0&size=100`, { headers: authHeaders(), timeout: 15000 })
  if (!res.ok) return { ok: false, status: res.status, error: res.error || `HTTP ${res.status}` }
  const items = res.json?.data?.items ?? res.json?.data ?? []
  return {
    ok: true,
    items: items.map((t) => ({
      id: t.id,
      name: t.name,
      keyMasked: t.key,
      status: t.status,
      group: t.group,
      usedQuota: t.used_quota,
      usedYuan: quotaToYuan(t.used_quota),
      remainQuota: t.remain_quota,
      unlimited: t.unlimited_quota,
    })),
  }
}

/**
 * 条数查询的超时（毫秒）。条数是次要指标，给个上限，别让它无限拖住花费。
 * page_size=0 之后实测最慢的令牌 1.2s，8s 是安全余量。
 */
const COUNT_TIMEOUT_MS = 8000

/**
 * 今日花费按密钥（/api/log/self/stat?token_name=，大小写不敏感）。
 *
 * 每个令牌两个请求：stat 给花费，log 给条数。stat 只返回 {quota,rpm,tpm}，
 * 没有条数，所以条数只能单独查 total，省不掉。
 *
 * ## page_size 必须写 0，不能写 1（这是本函数唯一的坑）
 * 原来条数查询写的是 `p=1&page_size=1`。并发查一批令牌时，总会遇到少数令牌很慢
 * （最慢的打满超时），Promise.all 等最慢的那个，于是本函数被恒定拖到十几秒 ——
 * 它同时在 gatherContext（AI 总结/复盘）和 /api/newapi/summary（MCP 的 get_balance）的路径上，
 * 是「ai.today 要 30–40s」里非模型的那一半。
 *
 * 改成 `page_size=0` 后，同样的令牌：最慢的从打满超时降到 1s 出头，
 * **total 与 page_size=1 逐条一致**（逐个核对过）。
 * 也就是说这是上游「取 0 行只要计数」和「取 1 行顺带计数」的代价差，不是数据量问题，
 * 换写法即可，不需要把条数降级成「未知」。
 *
 * 单个令牌失败不影响其它令牌：花费失败时该条 quota=0 并带 error 字段；
 * 条数取不到记 null（未知）而不是 0 —— 记 0 等于假装「今天没调用」。
 */
export async function todaySpendByToken({ startTimestamp } = {}) {
  const start = startTimestamp ?? startOfTodayUnix()
  const tk = await tokens()
  if (!tk.ok) return tk

  const end = start + 86400
  const results = await Promise.all(
    tk.items.map(async (t) => {
      const q = `token_name=${encodeURIComponent(t.name)}&start_timestamp=${start}&end_timestamp=${end}`
      const [res, cnt] = await Promise.all([
        panelRequest(`${base()}/api/log/self/stat?${q}`, { headers: authHeaders(), timeout: 15000 }),
        // page_size=0：只要 total，不要行。见上面注释，别改回 1。
        panelRequest(`${base()}/api/log/self?p=1&page_size=0&type=2&${q}`, {
          headers: authHeaders(),
          timeout: COUNT_TIMEOUT_MS,
        }),
      ])
      let quota = 0
      if (res.ok) quota = Number(res.json?.data?.quota) || 0
      const count = cnt.ok ? Number(cnt.json?.data?.total) || 0 : null
      return {
        name: t.name,
        group: t.group,
        quota,
        yuan: quotaToYuan(quota),
        count,
        ...(res.ok ? {} : { error: res.error || `HTTP ${res.status}` }),
      }
    }),
  )

  results.sort((a, b) => b.quota - a.quota)
  const total = results.reduce((s, x) => s + x.quota, 0)
  return { ok: true, start, total, totalYuan: quotaToYuan(total), items: results }
}

/** 最近日志（/api/log/self） */
export async function recentLogs({ startTimestamp, pageSize = 50, tokenName } = {}) {
  const start = startTimestamp ?? startOfTodayUnix()
  let url = `${base()}/api/log/self?p=0&page_size=${pageSize}&start_timestamp=${start}&type=0`
  if (tokenName) url += `&token_name=${encodeURIComponent(tokenName)}`
  const res = await panelRequest(url, { headers: authHeaders(), timeout: 20000 })
  if (!res.ok) return { ok: false, status: res.status, error: res.error || `HTTP ${res.status}` }
  const d = res.json?.data ?? {}
  const items = (d.items ?? d.data ?? []).map(normalizeLog)
  return { ok: true, total: d.total ?? items.length, items }
}

/* --- 聚合原语（供 usage-cache 定时同步用，页面不必逐条拉日志自己算） --- */

/** 单条日志的失败判定（把上游常见的几种失败口径归一）：
 *  type=5 就是失败日志；流式回包状态非 ok 也算失败；content 非空是错误文本。 */
export function failMarkOf(l) {
  if (Number(l?.type) === 5) return '失败'
  let st = ''
  try {
    const j = JSON.parse(l?.other || '{}')
    st = (j.stream_status || {}).status || ''
  } catch {}
  if (st && st !== 'ok') return '失败'
  if (typeof l?.content === 'string' && l.content.trim()) return '错误'
  return null
}

function normalizeLog(l) {
  return {
    id: l.id,
    time: l.created_at,
    model: l.model_name,
    tokenName: l.token_name,
    promptTokens: l.prompt_tokens,
    completionTokens: l.completion_tokens,
    quota: l.quota,
    yuan: quotaToYuan(l.quota),
    useTime: l.use_time,
    isStream: l.is_stream,
    type: l.type,
    fail: failMarkOf(l),
    content: typeof l.content === 'string' ? l.content.slice(0, 120) : undefined,
  }
}

/** 当日总花费（/api/log/self/stat 不带 token_name —— 1 次请求就有总额，不必按密钥逐个查） */
export async function todayStat({ startTimestamp } = {}) {
  const start = startTimestamp ?? startOfTodayUnix()
  const res = await panelRequest(
    `${base()}/api/log/self/stat?start_timestamp=${start}&end_timestamp=${start + 86400}`,
    { headers: authHeaders(), timeout: 15000 },
  )
  if (!res.ok) return { ok: false, status: res.status, error: res.error || `HTTP ${res.status}` }
  const d = res.json?.data ?? {}
  const quota = Number(d.quota) || 0
  return { ok: true, quota, yuan: quotaToYuan(quota) }
}

/**
 * 日志计数（type=2 消费 / type=5 失败 —— total 由接口给出，不受「拉多少条」限制）。
 *
 * page_size 必须是 0：本函数只要 total，不要任何行。写 1 会让上游把行取回来再丢弃，
 * 实测 type=5 的计数 8.5s → 0.6s（total 一致）。这个在 usage-cache 轻量层里每 60 秒跑一次，
 * 所以改这里等于每分钟少一次 8 秒的等待。同一坑见 todaySpendByToken 的注释。
 */
export async function logCount(type, { startTimestamp } = {}) {
  const start = startTimestamp ?? startOfTodayUnix()
  const res = await panelRequest(
    `${base()}/api/log/self?p=1&page_size=0&type=${type}&start_timestamp=${start}&end_timestamp=${start + 86400}`,
    { headers: authHeaders(), timeout: 15000 },
  )
  if (!res.ok) return { ok: false, status: res.status, error: res.error || `HTTP ${res.status}` }
  return { ok: true, total: Number(res.json?.data?.total) || 0 }
}

/** 官方聚合看板（/api/data/self）：模型×小时的 quota/count/prompt_tokens/cache_tokens。
 *  小时花费、模型分布、缓存命中率全部从这里出 —— 1 次请求替代「拉 200 条日志自己聚合」。 */
export async function usageSeries({ startTimestamp } = {}) {
  const start = startTimestamp ?? startOfTodayUnix()
  const res = await panelRequest(
    `${base()}/api/data/self?start_timestamp=${start}&end_timestamp=${start + 86400}`,
    { headers: authHeaders(), timeout: 20000 },
  )
  if (!res.ok) return { ok: false, status: res.status, error: res.error || `HTTP ${res.status}` }
  return { ok: true, rows: res.json?.data ?? [] }
}

/** 消费（type=2）与失败（type=5）两类日志各拉一份，各自带 total */
export async function recentLogsTyped({ startTimestamp, pageSize = 50 } = {}) {
  const start = startTimestamp ?? startOfTodayUnix()
  const fetchType = async (type) => {
    const res = await panelRequest(
      `${base()}/api/log/self?p=1&page_size=${pageSize}&type=${type}&start_timestamp=${start}&end_timestamp=${start + 86400}`,
      { headers: authHeaders(), timeout: 20000 },
    )
    if (!res.ok) return { ok: false, status: res.status, error: res.error || `HTTP ${res.status}` }
    const d = res.json?.data ?? {}
    return { ok: true, total: Number(d.total) || 0, items: (d.items ?? d.data ?? []).map(normalizeLog) }
  }
  const [consume, fail] = await Promise.all([fetchType(2), fetchType(5)])
  return { consume, fail }
}

export function startOfTodayUnix() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return Math.floor(d.getTime() / 1000)
}

/** 汇总卡片：余额 + 今日花费 + 最近日志（一次调用给前端） */
export async function summary() {
  const [bal, spend, logs] = await Promise.all([
    balance(),
    todaySpendByToken(),
    recentLogs({ pageSize: 20 }),
  ])
  return {
    ok: bal.ok,
    balance: bal,
    todaySpend: spend.ok ? spend : { ok: false, error: spend.error },
    recentLogs: logs.ok ? logs : { ok: false, error: logs.error },
    ai: (() => {
      const p = aiProvider()
      return p.ok ? { ok: true, name: p.name, baseURL: p.baseURL, models: aiModels() } : { ok: false, error: p.error }
    })(),
    checkedAt: Date.now(),
  }
}

export { QUOTA_PER_YUAN as quotaPerYuan }
