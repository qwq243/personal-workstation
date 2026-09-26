/**
 * 模型配置（按已退役的桌面端那套移植）。
 *
 * 桌面端把「用哪个模型」拆成三层，这里照搬：
 *   1. **预设（preset）**：厂商 + 建议 baseUrl + 建议模型 + 上下文窗口，选中即预填，省得记每个厂商的地址；
 *   2. **每预设一份配置**：apiKey / baseUrl / model / apiMode / maxContextSize / reasoning 各存一份，
 *      换预设不会把上一家的 key 弄丢；
 *   3. **任务路由（taskRouting）**：对话与编译（ingest）可以各点一个预设 ——
 *      便宜模型编译、强模型对话，或反过来。
 *
 * 与桌面端的两处差异（有意）：
 *   · 多一个内置预设 `workstation`：直接用工作台的 ai.*（NewAPI + provider），出厂就能跑，不用先配 key；
 *   · **没有 CLI 传输**（claude-code / codex-cli 那类）：那要靠本机 CLI 子进程，工作台不做这条。
 *
 * apiKey 存在 credentials.json（SECRET_PATHS 里的 ['wiki','llm','keys']），config.json 只留结构。
 */
import fs from 'node:fs'
import { loadConfig, saveConfig } from '../config.mjs'

/** 内置预设：baseUrl 只填我有把握的官方地址；模型名留给用户填（各家模型迭代太快，写死不合适） */
export const PRESETS = [
  { id: 'workstation', label: '跟随工作台', hint: '用工作台的 ai.*（NewAPI + provider），不用单独配 key', provider: 'workstation' },
  { id: 'openai', label: 'OpenAI', provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiMode: 'chat_completions', suggestedContextSize: 128000 },
  { id: 'anthropic', label: 'Anthropic (Claude)', provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiMode: 'anthropic_messages', suggestedContextSize: 200000 },
  { id: 'google', label: 'Google Gemini', provider: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiMode: 'chat_completions', suggestedContextSize: 1000000 },
  { id: 'azure', label: 'Azure OpenAI', provider: 'azure', baseUrl: '', apiMode: 'chat_completions', azureApiVersion: '2024-10-21', hint: '要自己填资源端点，并带上 api-version' },
  { id: 'ollama', label: 'Ollama（本机）', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', apiMode: 'chat_completions', hint: '本机 ollama serve 默认端口' },
  { id: 'deepseek', label: 'DeepSeek', provider: 'custom', baseUrl: 'https://api.deepseek.com/v1', apiMode: 'chat_completions', suggestedContextSize: 128000 },
  { id: 'moonshot', label: 'Moonshot / Kimi', provider: 'custom', baseUrl: 'https://api.moonshot.cn/v1', apiMode: 'chat_completions', suggestedContextSize: 256000 },
  { id: 'zhipu', label: '智谱 GLM', provider: 'custom', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiMode: 'chat_completions', suggestedContextSize: 128000 },
  { id: 'dashscope', label: '阿里百炼 / 通义', provider: 'custom', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiMode: 'chat_completions', suggestedContextSize: 128000 },
  { id: 'siliconflow', label: 'SiliconFlow 硅基流动', provider: 'custom', baseUrl: 'https://api.siliconflow.cn/v1', apiMode: 'chat_completions', suggestedContextSize: 128000 },
  { id: 'openrouter', label: 'OpenRouter', provider: 'custom', baseUrl: 'https://openrouter.ai/api/v1', apiMode: 'chat_completions', suggestedContextSize: 128000 },
  { id: 'xai', label: 'xAI Grok', provider: 'custom', baseUrl: 'https://api.x.ai/v1', apiMode: 'chat_completions', suggestedContextSize: 128000 },
  { id: 'groq', label: 'Groq', provider: 'custom', baseUrl: 'https://api.groq.com/openai/v1', apiMode: 'chat_completions', suggestedContextSize: 128000 },
  { id: 'minimax', label: 'MiniMax', provider: 'minimax', baseUrl: 'https://api.minimax.chat/v1', apiMode: 'chat_completions', suggestedContextSize: 200000 },
  { id: 'custom', label: '自定义（OpenAI 兼容）', provider: 'custom', baseUrl: '', apiMode: 'chat_completions', hint: '任何 OpenAI 兼容端点' },
]

export function allPresets() {
  const c = cfg()
  const custom = (c.customPresets ?? []).map((p) => ({ ...p, custom: true }))
  return [...PRESETS, ...custom]
}

export function preset(id) {
  return allPresets().find((p) => p.id === id) ?? null
}

export function cfg() {
  // 全站统一（2026-09-24 从 wiki.llm 搬上来）
  const l = loadConfig().llm ?? {}
  return {
    activePresetId: String(l.activePresetId ?? 'workstation'),
    configs: l.configs && typeof l.configs === 'object' ? l.configs : {},
    keys: l.keys && typeof l.keys === 'object' ? l.keys : {},
    customPresets: Array.isArray(l.customPresets) ? l.customPresets : [],
    taskRouting: { chat: '', ingest: '', ...(l.taskRouting ?? {}) },
    reasoning: normalizeReasoning(l.reasoning),
    maxContextSize: Number(l.maxContextSize) || 128000,
  }
}

/**
 * 思考档位：auto / off / low / medium / high（对齐桌面端的 reasoning effort 分档）。
 * 老配置里只有 auto/off，其它值（含空）一律归到 auto —— 由模型自己决定。
 */
export function normalizeReasoning(v) {
  const s = String(v ?? 'auto').toLowerCase()
  return ['auto', 'off', 'low', 'medium', 'high'].includes(s) ? s : 'auto'
}

/**
 * 把档位翻成各家协议能懂的字段（OpenAI 兼容线协议）。
 * NewAPI 这类中转对 reasoning_effort 是透传的，不支持的模型会忽略，不会报错；
 * off 不发任何字段（很多端点对「显式关」反而挑刺，缺省就是让模型自己定）。
 */
/**
 * 思考档位 → 请求体字段。
 *
 * `off` **必须真发点什么**：原先这里 `off` 直接返回 `{}`，等于「关思考」只是不发参数、
 * 上游默认照旧开思考 —— 而思考量是从同一个 max_tokens 里扣的，于是「我明明关了思考」
 * 却还是拿到空正文。在几个 OpenAI 兼容端点上把几种写法挨个试了一遍：
 *   thinking:{type:'disabled'} → 思考 0 token（有效）
 *   reasoning_effort:'none'    → 思考 94 token（没关掉）
 *   enable_thinking:false / chat_template_kwargs / reasoning:{enabled:false} → 都没用
 * 所以用 `thinking:{type:'disabled'}`。OpenAI 兼容端点对不认识的字段一般是忽略，
 * 真遇到严格校验的端点报 400，把这一档调回「自动」即可。
 */
export function reasoningFields(level) {
  const l = normalizeReasoning(level)
  if (l === 'off') return { thinking: { type: 'disabled' } }
  if (l === 'auto') return {}
  return { reasoning_effort: l }
}

/** 某个预设的配置（含 apiKey，来自 secrets 合并后的 config） */
export function presetConfig(id) {
  const c = cfg()
  const p = preset(id)
  const own = c.configs[id] ?? {}
  return {
    id,
    preset: p,
    baseUrl: String(own.baseUrl ?? p?.baseUrl ?? '').replace(/\/+$/, ''),
    model: String(own.model ?? ''),
    apiKey: String(own.apiKey ?? c.keys[id] ?? ''),
    apiMode: String(own.apiMode ?? p?.apiMode ?? 'chat_completions'),
    maxContextSize: Number(own.maxContextSize) || Number(p?.suggestedContextSize) || c.maxContextSize,
    reasoning: normalizeReasoning(own.reasoning ?? c.reasoning),
    azureApiVersion: String(own.azureApiVersion ?? p?.azureApiVersion ?? ''),
  }
}

/**
 * 解析「这次任务用哪个模型」。task 传 'chat' / 'ingest'。
 * 返回的 baseUrl/apiKey 一定是可用的（跟随工作台时取自 newapi.aiProvider()，与全局是同一份配置）。
 */
export function resolve(task = 'chat') {
  const c = cfg()
  const routed = String(c.taskRouting[task] ?? '') || c.activePresetId
  const id = routed === 'workstation' ? 'workstation' : routed
  const pc = presetConfig(id)

  if (id === 'workstation' || pc.preset?.provider === 'workstation') {
    // 跟随工作台：不自己读密钥，交给 newapi.aiProvider()（它读 config.json 的 newapi.baseUrl + credentials.json 的 llm.keys）
    return {
      ok: true,
      presetId: 'workstation',
      label: '跟随工作台',
      followWorkstation: true,
      model: pc.model || '',
      maxContextSize: pc.maxContextSize,
      reasoning: pc.reasoning,
    }
  }
  if (!pc.baseUrl) return { ok: false, error: `预设「${pc.preset?.label ?? id}」还没填端点地址（设置 → 模型）` }
  if (!pc.model) return { ok: false, error: `预设「${pc.preset?.label ?? id}」还没填模型名（设置 → 模型）` }
  const needsKey = pc.preset?.provider !== 'custom-local' && !pc.apiKey
  if (needsKey && !/localhost|127\.0\.0\.1/.test(pc.baseUrl)) {
    return { ok: false, error: `预设「${pc.preset?.label ?? id}」还没填 API Key（设置 → 模型）` }
  }
  return {
    ok: true,
    presetId: id,
    label: pc.preset?.label ?? id,
    followWorkstation: false,
    baseUrl: pc.baseUrl,
    apiKey: pc.apiKey,
    model: pc.model,
    apiMode: pc.apiMode,
    maxContextSize: pc.maxContextSize,
    reasoning: pc.reasoning,
    azureApiVersion: pc.azureApiVersion,
  }
}

/** 面板要看的全量：每个预设的状态（配置齐不齐 / 是否在用 / 给哪个任务在用） */
export function overview() {
  const c = cfg()
  const tasks = { chat: resolve('chat'), ingest: resolve('ingest') }
  const items = allPresets().map((p) => {
    const pc = presetConfig(p.id)
    const configured = p.id === 'workstation' ? true : !!pc.baseUrl && !!pc.model
    return {
      id: p.id,
      label: p.label,
      hint: p.hint ?? '',
      provider: p.provider ?? 'custom',
      custom: !!p.custom,
      baseUrl: pc.baseUrl,
      model: pc.model,
      hasKey: !!pc.apiKey,
      apiMode: pc.apiMode,
      maxContextSize: pc.maxContextSize,
      reasoning: pc.reasoning,
      configured,
      active: p.id === c.activePresetId,
      usedBy: Object.entries(tasks).filter(([, r]) => r.ok && r.presetId === p.id).map(([k]) => k),
    }
  })
  return {
    ok: true,
    activePresetId: c.activePresetId,
    taskRouting: c.taskRouting,
    reasoning: c.reasoning,
    maxContextSize: c.maxContextSize,
    presets: items,
    resolved: {
      chat: { ok: tasks.chat.ok, presetId: tasks.chat.presetId, label: tasks.chat.label, model: tasks.chat.model, error: tasks.chat.error },
      ingest: { ok: tasks.ingest.ok, presetId: tasks.ingest.presetId, label: tasks.ingest.label, model: tasks.ingest.model, error: tasks.ingest.error },
    },
  }
}

/** 连通性测试（对照桌面端的做法：发一条最小对话请求，看能不能拿回内容） */
export async function test(id) {
  const pc = presetConfig(id ?? cfg().activePresetId)
  if (pc.preset?.provider === 'workstation' || pc.id === 'workstation') {
    const { aiProvider, chat } = await import('./newapi.mjs')
    const prov = aiProvider()
    if (!prov.ok) return { ok: false, error: prov.error }
    const t0 = Date.now()
    // 90s：NewAPI 上模型冷启动实测能到 30s+，太短会把「慢」误报成「连不上」
    const r = await chat([{ role: 'user', content: 'ping' }], { maxTokens: 16, temperature: 0, timeout: 90000 })
    return {
      ok: r.ok,
      ms: Date.now() - t0,
      model: r.model ?? loadConfig().ai?.model,
      baseUrl: prov.baseURL,
      via: 'workstation',
      error: r.ok ? undefined : r.detail || r.error || `请求失败（HTTP ${r.status ?? '—'}）`,
    }
  }
  if (!pc.baseUrl) return { ok: false, error: '还没填端点地址' }
  const t0 = Date.now()
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 60000)
    const headers = { 'Content-Type': 'application/json' }
    let url = `${pc.baseUrl}/chat/completions`
    let body = { model: pc.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16, temperature: 0 }
    if (pc.apiMode === 'anthropic_messages') {
      url = `${pc.baseUrl}/messages`
      headers['anthropic-version'] = '2023-06-01'
      headers['x-api-key'] = pc.apiKey
      body = { model: pc.model, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }
    } else {
      headers.Authorization = `Bearer ${pc.apiKey}`
    }
    if (pc.azureApiVersion) url += `?api-version=${encodeURIComponent(pc.azureApiVersion)}`
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal })
    clearTimeout(timer)
    const text = await res.text()
    const ms = Date.now() - t0
    if (!res.ok) {
      let msg = text.slice(0, 220)
      try {
        msg = JSON.parse(text)?.error?.message ?? msg
      } catch {
        /* 非 JSON 错误体 */
      }
      return { ok: false, ms, status: res.status, model: pc.model, baseUrl: pc.baseUrl, error: `HTTP ${res.status}：${msg}` }
    }
    return { ok: true, ms, model: pc.model, baseUrl: pc.baseUrl, apiMode: pc.apiMode, sample: text.slice(0, 120) }
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, model: pc.model, baseUrl: pc.baseUrl, error: err?.name === 'AbortError' ? '请求超时（60s）' : err.message }
  }
}

/**
 * 列「这个任务这一档路由下能用的模型」——问答页的模型下拉就用它。
 *
 * 为什么必须跟着**路由**走：chat 指向哪个预设，模型名就得是那个端点认的名字。
 * 比如 chat 指到某家中转时，选项必须是那家中转认的名字；拿「跟随工作台」那家的模型名
 * （deepseek-v4.1-flash 这种）去问网关，只会 404 —— 看着像「模型选错了」，其实是取错了清单。
 *
 * 跟随工作台时不问端点，直接用「工作台」这一档配置里的模型表（`newapi.aiModels()`，与全局同一份配置）；
 * 自定义预设则问它的 `/v1/models`（OpenAI 兼容），端点不认这条路就如实报错。
 */
export async function models(task = 'chat') {
  const r = resolve(task)
  if (!r.ok) return { ok: false, error: r.error }
  if (r.followWorkstation) {
    const { aiProvider, aiModels } = await import('./newapi.mjs')
    const prov = aiProvider()
    return {
      ok: true,
      task,
      via: 'workstation',
      provider: prov.ok ? prov.name : loadConfig().ai?.providerName ?? '',
      default: loadConfig().ai?.model ?? '',
      models: aiModels(),
    }
  }
  const t0 = Date.now()
  try {
    const res = await fetch(`${r.baseUrl}/models`, {
      headers: r.apiKey ? { Authorization: `Bearer ${r.apiKey}` } : {},
      signal: AbortSignal.timeout(15000),
    })
    const text = await res.text()
    if (!res.ok) {
      let msg = text.slice(0, 160)
      try {
        msg = JSON.parse(text)?.error?.message ?? msg
      } catch {
        /* 非 JSON 错误体 */
      }
      return { ok: false, task, via: r.presetId, error: `HTTP ${res.status}：${msg}` }
    }
    const json = JSON.parse(text)
    const ids = (json?.data ?? json?.models ?? [])
      .map((m) => String(m?.id ?? m?.name ?? ''))
      .filter(Boolean)
    return {
      ok: true,
      task,
      via: r.presetId,
      provider: r.label,
      default: r.model,
      ms: Date.now() - t0,
      models: [...new Set(ids)],
    }
  } catch (err) {
    return {
      ok: false,
      task,
      via: r.presetId,
      error: err?.name === 'TimeoutError' ? '端点超时（15s）' : err.message,
    }
  }
}

/** 保存配置：keys 走 secrets（config.mjs 的 SECRET_PATHS 已覆盖 wiki.llm.keys） */
export function save(patch = {}) {
  const w = {}
  for (const k of ['activePresetId', 'reasoning', 'maxContextSize', 'customPresets']) {
    if (patch[k] !== undefined) w[k] = patch[k]
  }
  if (patch.taskRouting && typeof patch.taskRouting === 'object') w.taskRouting = patch.taskRouting
  if (patch.config && typeof patch.config === 'object') {
    const cur = cfg().configs
    const id = String(patch.config.id ?? '')
    if (!id) return { ok: false, error: '缺预设 id' }
    const one = { ...(cur[id] ?? {}) }
    for (const f of ['baseUrl', 'model', 'apiMode', 'maxContextSize', 'reasoning', 'azureApiVersion']) {
      if (patch.config[f] !== undefined) one[f] = patch.config[f]
    }
    const keys = { ...cfg().keys }
    if (patch.config.apiKey !== undefined) {
      const k = String(patch.config.apiKey).trim()
      if (k && !k.startsWith('****')) keys[id] = k
    }
    w.configs = { ...cur, [id]: one }
    w.keys = keys
  }
  saveConfig({ llm: w })
  return { ok: true, ...overview() }
}

/* ------------------------------------------------- 通用调用（按预设） --- */

/**
 * 按解析结果调一次对话（非流式）。
 *
 * 三种情况：
 *   · 跟随工作台 → 交给 newapi.chat（密钥取 credentials.json 的 `llm.keys`，与全局同一份配置）
 *   · OpenAI 兼容线协议（绝大多数厂商）→ 直接 POST {baseUrl}/chat/completions
 *   · Anthropic messages → POST {baseUrl}/messages（x-api-key + anthropic-version）
 * 返回形状与 newapi.chat 一致：{ ok, content, usage, model, error, detail }
 */
export async function chatOnce(r, messages, { maxTokens = 1600, temperature = 0.3, timeout = 180000 } = {}) {
  if (!r?.ok) return { ok: false, error: r?.error ?? '没有可用的模型配置' }
  if (r.followWorkstation) {
    const { chat } = await import('./newapi.mjs')
    return chat(messages, { maxTokens, temperature, timeout, model: r.model || undefined, extraBody: reasoningFields(r.reasoning) })
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const headers = { 'Content-Type': 'application/json' }
    let url = `${r.baseUrl}/chat/completions`
    let body
    if (r.apiMode === 'anthropic_messages') {
      url = `${r.baseUrl}/messages`
      headers['anthropic-version'] = '2023-06-01'
      if (r.apiKey) headers['x-api-key'] = r.apiKey
      body = {
        model: r.model,
        max_tokens: maxTokens,
        temperature,
        messages: messages.filter((m) => m.role !== 'system').concat(messages.filter((m) => m.role === 'system').map((m) => ({ role: 'user', content: m.content }))),
        ...anthropicThinking(r.reasoning, maxTokens),
      }
    } else {
      if (r.apiKey) headers.Authorization = `Bearer ${r.apiKey}`
      body = { model: r.model, messages, max_tokens: maxTokens, temperature, ...reasoningFields(r.reasoning) }
    }
    if (r.azureApiVersion) url += `?api-version=${encodeURIComponent(r.azureApiVersion)}`
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal })
    const text = await res.text()
    if (!res.ok) {
      let detail = text.slice(0, 300)
      try {
        const j = JSON.parse(text)
        detail = j?.error?.message ?? j?.message ?? detail
      } catch {
        /* 非 JSON 错误体 */
      }
      return { ok: false, status: res.status, error: `HTTP ${res.status}`, detail, presetId: r.presetId }
    }
    const json = JSON.parse(text)
    const content = json?.choices?.[0]?.message?.content ?? json?.content?.[0]?.text ?? ''
    return { ok: true, content, usage: json?.usage ?? null, model: json?.model ?? r.model, presetId: r.presetId }
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? `请求超时（${timeout}ms）` : err.message, presetId: r.presetId }
  } finally {
    clearTimeout(timer)
  }
}

/** Anthropic 的 thinking 字段：档位 → budget_tokens（不能≥max_tokens，留一半给正文） */
export function anthropicThinking(level, maxTokens) {
  const l = normalizeReasoning(level)
  if (l === 'auto' || l === 'off') return {}
  const budget = { low: 2048, medium: 8192, high: 32768 }[l]
  return { thinking: { type: 'enabled', budget_tokens: Math.min(budget, Math.max(1024, Math.floor(maxTokens / 2))) } }
}

/**
 * 按解析结果流式对话。三种情况全是真流式：
 *   · 跟随工作台 → newapi.chatStream（OpenAI 兼容 SSE）
 *   · OpenAI 兼容 → {baseUrl}/chat/completions（SSE，delta.content / delta.reasoning_content）
 *   · Anthropic messages → {baseUrl}/messages（SSE，event 分帧：thinking_delta / text_delta）
 * 返回 { ok, content, partial?, streaming:true }
 */
export async function chatStreamVia(r, messages, { maxTokens = 1600, temperature = 0.3, timeout = 300000, signal, onDelta, onEvent } = {}) {
  if (!r?.ok) return { ok: false, error: r?.error ?? '没有可用的模型配置' }
  if (r.followWorkstation) {
    const { chatStream } = await import('./newapi.mjs')
    return chatStream(messages, { maxTokens, temperature, timeout, signal, onDelta, onEvent, model: r.model || undefined, extraBody: reasoningFields(r.reasoning) })
  }
  const anthropic = r.apiMode === 'anthropic_messages'
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true })
  let text = ''
  try {
    const headers = { 'Content-Type': 'application/json' }
    let url = `${r.baseUrl}/chat/completions`
    let body
    if (anthropic) {
      url = `${r.baseUrl}/messages`
      headers['anthropic-version'] = '2023-06-01'
      if (r.apiKey) headers['x-api-key'] = r.apiKey
      body = {
        model: r.model,
        max_tokens: maxTokens,
        temperature,
        stream: true,
        messages: messages.filter((m) => m.role !== 'system').concat(messages.filter((m) => m.role === 'system').map((m) => ({ role: 'user', content: m.content }))),
        ...anthropicThinking(r.reasoning, maxTokens),
      }
    } else {
      if (r.apiKey) headers.Authorization = `Bearer ${r.apiKey}`
      body = { model: r.model, messages, max_tokens: maxTokens, temperature, stream: true, ...reasoningFields(r.reasoning) }
    }
    if (r.azureApiVersion) url += `?api-version=${encodeURIComponent(r.azureApiVersion)}`
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok || !res.body) {
      const raw = await res.text().catch(() => '')
      return { ok: false, status: res.status, error: `HTTP ${res.status}`, detail: raw.slice(0, 300), presetId: r.presetId }
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
        try {
          const j = JSON.parse(payload)
          if (anthropic) {
            // Anthropic SSE：content_block_delta 里 delta.type 区分正文与思考
            const d = j?.delta ?? {}
            if (j?.type === 'content_block_delta') {
              if (d.type === 'text_delta' && d.text) {
                text += d.text
                onDelta?.(d.text)
              } else if (d.type === 'thinking_delta' && d.thinking) {
                onEvent?.({ type: 'reasoning', text: d.thinking })
              }
            }
          } else {
            const delta = j?.choices?.[0]?.delta?.content ?? ''
            if (delta) {
              text += delta
              onDelta?.(delta)
            }
            const reasoning = j?.choices?.[0]?.delta?.reasoning_content
            if (reasoning) onEvent?.({ type: 'reasoning', text: reasoning })
          }
        } catch {
          /* 半帧 */
        }
      }
    }
    return { ok: true, content: text, model: r.model, presetId: r.presetId, streaming: true }
  } catch (err) {
    if (text) return { ok: true, content: text, partial: true, error: err?.name === 'AbortError' ? '超时中断' : err.message }
    return { ok: false, error: err?.name === 'AbortError' ? `请求超时（${timeout}ms）` : err.message, presetId: r.presetId }
  } finally {
    clearTimeout(timer)
  }
}
