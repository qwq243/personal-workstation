/**
 * 边车访问控制 —— Origin 白名单 + 本地令牌。
 *
 * 为什么需要（原来的洞）：
 *   边车只监听 127.0.0.1，但「只听回环」挡不住浏览器 —— 你打开的任何网页都能
 *   fetch('http://127.0.0.1:5278/api/...') 读到看板、记录、余额，甚至写脏数据。
 *   原来的响应头还挂着 `Access-Control-Allow-Origin: *`，等于对全世界的网页开放。
 *
 * 两道闸：
 *   1) Origin 白名单 —— 浏览器发起的跨源请求一定带 Origin；不在白名单里直接 403。
 *      没有 Origin 头的（curl / MCP 客户端 / 本机脚本）不算跨源，放行。
 *   2) 本地令牌 —— /api/*（除两个白名单接口）与 /mcp 都要求 X-WS-Token。
 *      恶意网页过不了第 1 关，所以拿不到令牌；令牌只存在本机 config.json 里。
 *
 * 注意这里能防的和不能防的：
 *   能防 —— 浏览器里的网页（含被注入的 XSS）读写你的本地数据。
 *   防不住 —— 本机上的恶意程序（它能直接读 config.json）。这类风险要靠系统层权限，
 *             不是应用层加个 token 能解决的，别假装能。
 */
import { loadConfig } from '../config.mjs'

/** 不需要令牌的接口（健康探测用于「边车是否在线」判定，必须免鉴权） */
const TOKEN_EXEMPT = new Set(['/api/health', '/api/auth/token'])

export function authConfig() {
  return loadConfig().auth ?? {}
}

export function authEnabled() {
  return authConfig().enabled !== false
}

/**
 * 来源是否允许。
 * @param {string|undefined} origin 请求的 Origin 头
 */
export function originAllowed(origin) {
  if (!origin) return true // 非浏览器请求（无 Origin），交由令牌把关
  const list = authConfig().allowedOrigins ?? []
  return list.includes(origin)
}

/** 该路径是否需要令牌 */
export function needsToken(pathname) {
  if (!authEnabled()) return false
  if (TOKEN_EXEMPT.has(pathname)) return false
  if (pathname === '/mcp') return true
  return pathname.startsWith('/api/')
}

/** 从请求里取令牌：X-WS-Token / Authorization: Bearer / ?token= */
export function tokenFromRequest(req, query) {
  const header = req.headers['x-ws-token']
  if (typeof header === 'string' && header) return header
  const auth = req.headers.authorization
  if (typeof auth === 'string' && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim()
  const q = query?.token
  if (typeof q === 'string' && q) return q
  return ''
}

/** 令牌是否正确（比较用等长常量时间思路，避免长度差异早退） */
export function tokenValid(req, query) {
  if (!authEnabled()) return true
  const expected = authConfig().token
  if (!expected) return false
  const got = tokenFromRequest(req, query)
  if (!got || got.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

/** 统一的 401 响应体，附带怎么拿到令牌的提示 */
export function unauthorizedBody(pathname) {
  return {
    ok: false,
    error: '未授权：缺少或错误的本地令牌',
    hint: '页面会自动通过 /api/auth/token 获取；手工调用请带 X-WS-Token，值见 server/config.json 的 auth.token',
    path: pathname,
  }
}
