/**
 * 检索层：网络搜索（7 家 provider）+ 本机文件搜索（AnyTXT）。
 *
 * 请求形状、字段映射、结果上限都按各家公开的 API 文档写。
 *
 * **没有代理客户端封装**：这里用 Node 的 fetch；要在代理后面跑就在 config.json 的
 * wiki.network.proxy 里填地址，这里会按需包一层（见 fetchJson）。
 *
 * 部分 provider 在受限网络下可能不可达（超时 / 403 这类）：选哪家由用户定，
 * 这里只如实报错，不做「悄悄换一家」。
 *
 * 结果统一成 { title, url, snippet, source }。
 */
import { loadConfig, saveConfig } from '../config.mjs'

const TIMEOUT_MS = 20000

export const PROVIDERS = [
  { id: 'none', label: '不用网络搜索', hint: '问答只用库内页面与本地文件', keyKind: 'none' },
  { id: 'ollama', label: 'Ollama Web Search', hint: 'ollama.com 的联网搜索 API，需要 Ollama API key', keyKind: 'key', defaultUrl: 'https://ollama.com' },
  { id: 'tavily', label: 'Tavily', hint: '通用网络搜索', keyKind: 'key' },
  { id: 'serpapi', label: 'SerpApi', hint: 'Google / Bing / DuckDuckGo / Scholar / News / 图片 / 视频 / YouTube', keyKind: 'key' },
  { id: 'searxng', label: 'SearXNG', hint: '自建元搜索（JSON API），不用 key', keyKind: 'url' },
  { id: 'firecrawl', label: 'Firecrawl', hint: '匿名或带 key 都行', keyKind: 'optional-key' },
  { id: 'brave', label: 'Brave Search', hint: '独立索引', keyKind: 'key' },
  { id: 'bocha', label: 'Bocha 博查', hint: '中文与全球网页搜索', keyKind: 'key' },
]

export const SERPAPI_ENGINES = [
  { value: 'google', label: 'Google Web' },
  { value: 'google_news', label: 'Google News' },
  { value: 'google_scholar', label: 'Google Scholar' },
  { value: 'google_patents', label: 'Google Patents' },
  { value: 'bing', label: 'Bing' },
  { value: 'duckduckgo', label: 'DuckDuckGo' },
  { value: 'google_images', label: 'Google Images' },
  { value: 'google_videos', label: 'Google Videos' },
  { value: 'youtube', label: 'YouTube' },
]
export const SEARXNG_CATEGORIES = ['general', 'news', 'science', 'it', 'images', 'videos', 'files', 'map', 'music', 'social media']

const DEFAULTS = {
  provider: 'none',
  apiKey: '',
  serpApiEngine: 'google',
  searXngUrl: '',
  searXngCategories: ['general'],
  ollamaUrl: 'https://ollama.com',
  providerConfigs: {},
  defaultSource: 'wiki',
  maxResults: 10,
  anyTxt: { enabled: false, endpoint: 'http://127.0.0.1:9920/', filterDir: '', filterExt: '', limit: 20 },
}

export function cfg() {
  // 全站统一（2026-09-24 从 wiki.search 搬上来）
  const s = loadConfig().search ?? {}
  return {
    ...DEFAULTS,
    ...s,
    anyTxt: { ...DEFAULTS.anyTxt, ...(s.anyTxt ?? {}) },
    searXngCategories: Array.isArray(s.searXngCategories) && s.searXngCategories.length ? s.searXngCategories : DEFAULTS.searXngCategories,
  }
}

export function save(patch = {}) {
  const w = {}
  for (const k of ['provider', 'serpApiEngine', 'searXngUrl', 'searXngCategories', 'ollamaUrl', 'defaultSource', 'maxResults', 'providerConfigs']) {
    if (patch[k] !== undefined) w[k] = patch[k]
  }
  if (patch.anyTxt && typeof patch.anyTxt === 'object') w.anyTxt = patch.anyTxt
  if (patch.apiKey !== undefined) {
    const k = String(patch.apiKey).trim()
    if (k && !k.startsWith('****')) w.apiKey = k
  }
  saveConfig({ search: w })
  return { ok: true, ...status() }
}

/** 一个 provider 的生效配置（当前 provider 的 override 优先，其次根级配置） */
function resolved() {
  const c = cfg()
  const id = String(c.provider ?? 'none').toLowerCase()
  const ov = (c.providerConfigs ?? {})[id] ?? {}
  return {
    ...c,
    provider: id,
    apiKey: String(ov.apiKey ?? c.apiKey ?? ''),
    serpApiEngine: String(ov.serpApiEngine ?? c.serpApiEngine ?? 'google'),
    searXngUrl: String(ov.searXngUrl ?? c.searXngUrl ?? ''),
    searXngCategories: ov.searXngCategories ?? c.searXngCategories,
    ollamaUrl: String(ov.ollamaUrl ?? c.ollamaUrl ?? 'https://ollama.com'),
  }
}

export function hasProvider() {
  const r = resolved()
  if (r.provider === 'none' || !r.provider) return false
  if (['tavily', 'serpapi', 'brave', 'bocha'].includes(r.provider)) return !!r.apiKey
  if (r.provider === 'searxng') return !!r.searXngUrl.trim()
  if (r.provider === 'ollama') return !!r.apiKey.trim()
  return true // firecrawl 允许匿名
}

export function status() {
  const c = cfg()
  const r = resolved()
  return {
    ok: true,
    provider: r.provider,
    providers: PROVIDERS,
    serpApiEngine: r.serpApiEngine,
    serpApiEngines: SERPAPI_ENGINES,
    searXngUrl: r.searXngUrl,
    searXngCategories: r.searXngCategories,
    searxngCategoryOptions: SEARXNG_CATEGORIES,
    ollamaUrl: r.ollamaUrl,
    hasKey: !!r.apiKey,
    keyTail: r.apiKey ? r.apiKey.slice(-4) : '',
    defaultSource: c.defaultSource,
    maxResults: c.maxResults,
    ready: hasProvider(),
    anyTxt: c.anyTxt,
    builtinOnly: false,
  }
}

/* ------------------------------------------------------------ HTTP --- */

/** 统一的请求：按 config 里的代理走（填了才用），超时 20s，返 { status, json, text } */
async function fetchJson(url, { method = 'GET', headers = {}, body } = {}) {
  const proxy = loadConfig().network?.proxy
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const opts = { method, headers: { Accept: 'application/json', ...headers }, signal: ctrl.signal }
    if (body !== undefined) {
      opts.body = JSON.stringify(body)
      opts.headers['Content-Type'] = 'application/json'
    }
    // Node 的原生 fetch 不认简易代理配置；要真走代理必须用 undici 的 ProxyAgent。
    // 这里按需动态加载（只有用户填了代理才会需要），拿不到就当直连并如实提示。
    if (proxy?.enabled && proxy?.url) {
      try {
        const { ProxyAgent, setGlobalDispatcher } = await import('undici')
        setGlobalDispatcher(new ProxyAgent(proxy.url))
      } catch {
        /* 没有 undici（Node 自带其实有）：退回直连 */
      }
    }
    const res = await fetch(url, opts)
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* 非 JSON：调用方按 text 报错 */
    }
    return { status: res.status, ok: res.ok, json, text }
  } catch (err) {
    const msg = err?.name === 'AbortError' ? `请求超时（${TIMEOUT_MS / 1000}s）` : err.message
    return { status: 0, ok: false, json: null, text: msg, network: true }
  } finally {
    clearTimeout(timer)
  }
}

function pick(obj, keys) {
  for (const k of keys) {
    const v = k.split('.').reduce((o, kk) => (o == null ? o : o[kk]), obj)
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

/** 把各家形状不一的结果抹平成同一套字段 */
function norm(item, source) {
  const meta = item?.metadata ?? {}
  return {
    title: pick(item, ['title']) || pick(meta, ['title']) || 'Untitled',
    url: pick(item, ['url', 'link']) || pick(meta, ['sourceURL', 'url']) || pick(item, ['original', 'thumbnail']),
    snippet: pick(item, ['snippet', 'content', 'description']) || pick(meta, ['description']) || pick(item, ['summary', 'markdown']),
    source,
  }
}

const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '')
  } catch {
    return 'web'
  }
}

/* ------------------------------------------------------ 各 provider --- */

async function viaFirecrawl(query, r, limit) {
  const base = String(r.providerConfigs?.firecrawl?.baseUrl ?? 'https://api.firecrawl.dev').replace(/\/+$/, '')
  const headers = r.apiKey ? { Authorization: `Bearer ${r.apiKey}` } : {}
  const res = await fetchJson(`${base}/v2/search`, { method: 'POST', headers, body: { query, limit } })
  if (!res.ok || res.json?.success === false) {
    return { ok: false, error: res.json?.error ?? res.json?.error?.message ?? `Firecrawl 返回 ${res.status}：${res.text.slice(0, 200)}` }
  }
  /* 两种返回形状都要认（2026-09-26 实测）：
       /v2/search → data: { web: [...] }   ← 现在走的就是这条，原先只认数组，取到对象后在
                                             items.slice 上炸成「接口内部出错：items.slice is not a function」
       /v1/search → data: [ ... ] */
  const d = res.json?.data
  const items = Array.isArray(d)
    ? d
    : (d?.web ?? d?.results ?? res.json?.results ?? [])
  if (!Array.isArray(items)) return { ok: false, error: 'Firecrawl 返回的形状不认识（既不是数组，也没有 data.web）' }
  return { ok: true, items: items.slice(0, limit).map((i) => norm(i, 'firecrawl')) }
}

async function viaSearxng(query, r, limit) {
  if (!r.searXngUrl.trim()) return { ok: false, error: '还没填 SearXNG 实例地址' }
  let base = r.searXngUrl.trim().replace(/\/+$/, '')
  if (!/\/search$/.test(base)) base += '/search'
  const cats = (r.searXngCategories ?? ['general']).join(',')
  const url = `${base}?q=${encodeURIComponent(query)}&format=json&categories=${encodeURIComponent(cats)}`
  const res = await fetchJson(url)
  if (!res.ok) return { ok: false, error: `SearXNG 返回 ${res.status}：${res.text.slice(0, 200)}` }
  if (!Array.isArray(res.json?.results)) return { ok: false, error: `SearXNG 没返回 results（是不是没开 JSON 格式？）` }
  return { ok: true, items: res.json.results.slice(0, limit).map((i) => norm(i, 'searxng')) }
}

async function viaTavily(query, r, limit) {
  if (!r.apiKey) return { ok: false, error: 'Tavily 需要 API key' }
  const res = await fetchJson('https://api.tavily.com/search', { method: 'POST', body: { api_key: r.apiKey, query, max_results: limit } })
  if (!res.ok) return { ok: false, error: `Tavily 返回 ${res.status}：${res.text.slice(0, 200)}` }
  return { ok: true, items: (res.json?.results ?? []).slice(0, limit).map((i) => norm(i, 'tavily')) }
}

async function viaOllama(query, r, limit) {
  if (!r.apiKey) return { ok: false, error: 'Ollama Web Search 需要 Ollama API key（ollama.com 上的账号）' }
  const base = r.ollamaUrl.replace(/\/+$/, '').replace(/\/api$/, '')
  const res = await fetchJson(`${base}/api/web_search`, { method: 'POST', headers: { Authorization: `Bearer ${r.apiKey}` }, body: { query, max_results: limit } })
  if (!res.ok) return { ok: false, error: `Ollama 返回 ${res.status}：${res.text.slice(0, 200)}` }
  return { ok: true, items: (res.json?.results ?? []).slice(0, limit).map((i) => norm(i, 'ollama')) }
}

async function viaBrave(query, r, limit) {
  if (!r.apiKey) return { ok: false, error: 'Brave 需要订阅 token' }
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(limit, 20)}`
  const res = await fetchJson(url, { headers: { 'X-Subscription-Token': r.apiKey } })
  if (!res.ok) return { ok: false, error: `Brave 返回 ${res.status}：${res.text.slice(0, 200)}` }
  return { ok: true, items: (res.json?.web?.results ?? []).slice(0, limit).map((i) => norm(i, 'brave')) }
}

async function viaBocha(query, r, limit) {
  if (!r.apiKey) return { ok: false, error: 'Bocha 需要 API key' }
  const res = await fetchJson('https://api.bocha.cn/v1/web-search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${r.apiKey}` },
    body: { query, count: Math.min(Math.max(limit, 1), 50), summary: true },
  })
  if (!res.ok) return { ok: false, error: `Bocha 返回 ${res.status}：${res.text.slice(0, 200)}` }
  const pages = res.json?.data?.webPages?.value ?? res.json?.webPages?.value ?? []
  return {
    ok: true,
    items: pages.slice(0, limit).map((i) => ({ title: i.name ?? 'Untitled', url: i.url ?? '', snippet: i.summary ?? i.snippet ?? '', source: 'bocha' })),
  }
}

async function viaSerpapi(query, r, limit) {
  if (!r.apiKey) return { ok: false, error: 'SerpApi 需要 API key' }
  const engine = r.serpApiEngine || 'google'
  const url = `https://serpapi.com/search?engine=${encodeURIComponent(engine)}&q=${encodeURIComponent(query)}&api_key=${encodeURIComponent(r.apiKey)}&num=${limit}`
  const res = await fetchJson(url)
  if (!res.ok) return { ok: false, error: `SerpApi 返回 ${res.status}：${res.text.slice(0, 200)}` }
  for (const key of ['organic_results', 'news_results', 'images_results', 'video_results', 'videos_results', 'shopping_results']) {
    const arr = res.json?.[key]
    if (Array.isArray(arr) && arr.length) return { ok: true, items: arr.slice(0, limit).map((i) => norm(i, 'serpapi')) }
  }
  return { ok: false, error: `SerpApi 的 ${engine} 没有返回结果` }
}

/** 按当前 provider 搜一次。maxResults 会被裁剪到各家的上限（Bocha 50，其余 20） */
export async function webSearch(query, { maxResults } = {}) {
  const q = String(query ?? '').trim()
  if (!q) return { ok: false, error: '查询为空' }
  const r = resolved()
  if (r.provider === 'none') return { ok: false, error: '还没选网络搜索 provider（设置 → 网络搜索）' }
  const limit = Math.max(1, Math.min(Number(maxResults) || r.maxResults || 10, r.provider === 'bocha' ? 50 : 20))
  const fn = { firecrawl: viaFirecrawl, searxng: viaSearxng, tavily: viaTavily, ollama: viaOllama, brave: viaBrave, bocha: viaBocha, serpapi: viaSerpapi }[r.provider]
  if (!fn) return { ok: false, error: `不支持的 provider：${r.provider}` }
  const t0 = Date.now()
  const out = await fn(q, r, limit)
  if (!out.ok) return { ok: false, provider: r.provider, error: out.error, ms: Date.now() - t0 }
  const items = out.items.filter((i) => i.url)
  return {
    ok: true,
    provider: r.provider,
    query: q,
    ms: Date.now() - t0,
    total: items.length,
    results: items.map((i) => ({ ...i, source: hostOf(i.url) || i.source })),
  }
}

/* ---------------------------------------------------------- AnyTXT --- */

function anyTxtEndpoint() {
  const e = String(cfg().anyTxt.endpoint ?? '').trim().replace(/\/+$/, '')
  return e || 'http://127.0.0.1:9920'
}

/** AnyTXT 本机检测：起没起（未装就是连不上，如实报，不假装有结果） */
export async function anyTxtStatus() {
  const endpoint = anyTxtEndpoint()
  const res = await fetchJson(`${endpoint}/`, { method: 'POST', body: { id: 1, jsonrpc: '2.0', method: 'ATRpcServer.Searcher.V1.GetResult', params: { input: { pattern: 'test', limit: '1', offset: 0, order: 0, filterExt: '*', lastModifyBegin: 0, lastModifyEnd: 0 } } } })
  if (res.network) return { ok: true, running: false, endpoint, error: `连不上 ${endpoint}（AnyTXT 没装或服务没起）` }
  return { ok: true, running: res.status > 0, endpoint, httpStatus: res.status, raw: res.json ? 'json' : 'text' }
}

/** 本机文件搜索（AnyTXT 的 JSON-RPC 调用形状） */
export async function anyTxtSearch(query, { maxResults } = {}) {
  const c = cfg()
  const q = String(query ?? '').trim()
  if (!q) return { ok: false, error: '查询为空' }
  if (c.anyTxt.enabled === false) return { ok: false, error: '本机文件搜索没开（设置 → 网络搜索 → 本机文件）' }
  const limit = Math.max(1, Math.min(Number(maxResults) || c.anyTxt.limit || 20, 100))
  const endpoint = anyTxtEndpoint()
  const input = {
    pattern: q,
    filterExt: c.anyTxt.filterExt?.trim() || '*',
    lastModifyBegin: 0,
    lastModifyEnd: Date.now(),
    limit: String(limit),
    offset: 0,
    order: 0,
  }
  if (c.anyTxt.filterDir?.trim()) input.filterDir = c.anyTxt.filterDir.trim()
  const res = await fetchJson(endpoint, {
    method: 'POST',
    body: { id: 1, jsonrpc: '2.0', method: 'ATRpcServer.Searcher.V1.GetResult', params: { input } },
  })
  if (res.network) return { ok: false, error: `连不上 AnyTXT（${endpoint}）：${res.text.slice(0, 160)}。装好 AnyTXT 并让它常驻即可。` }
  if (!res.ok) return { ok: false, error: `AnyTXT 返回 ${res.status}：${res.text.slice(0, 200)}` }
  if (res.json?.error) return { ok: false, error: `AnyTXT 报错：${JSON.stringify(res.json.error).slice(0, 200)}` }
  const raw = res.json?.result?.items ?? res.json?.result?.[0]?.items ?? res.json?.items ?? []
  const items = (Array.isArray(raw) ? raw : []).slice(0, limit).map((i) => ({
    title: i.path ? String(i.path).split(/[\\/]/).pop() : 'Untitled',
    url: `file:///${String(i.path ?? '').replace(/\\/g, '/').replace(/^\/*/, '')}`,
    snippet: String(i.fragment ?? i.snippet ?? '').slice(0, 240),
    source: 'AnyTXT',
  }))
  return { ok: true, total: items.length, results: items, endpoint }
}

/** 一次性测当前搜索 provider（面板的「测搜索」按钮） */
export async function test() {
  const c = cfg()
  if (!hasProvider()) {
    return { ok: false, error: c.provider === 'none' ? '还没选 provider' : '这个 provider 的必填项还没填齐' }
  }
  const t0 = Date.now()
  const r = await webSearch('知识库 检索 测试', { maxResults: 3 })
  return r.ok
    ? { ok: true, provider: r.provider, ms: Date.now() - t0, sample: r.results.slice(0, 3).map((x) => x.title) }
    : { ok: false, provider: r.provider, ms: Date.now() - t0, error: r.error }
}
