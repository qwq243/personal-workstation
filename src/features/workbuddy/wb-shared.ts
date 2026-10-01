/**
 * WorkBuddy 子页共用的小工具（格式化 + 状态判定）。
 *
 * 为什么单独一份而不是继续放在 WorkbuddyView.vue 里：账号池、任务、测聊三页都要用
 * 同一套口径（同一个账号在三个页面里必须显示同样的颜色和措辞），复制三份必然会漂。
 * 额度概览页保持原样不动 —— 它已经在跑，没必要为了去重而冒回归风险。
 *
 * ElMessage 在这里显式导入：auto-import 只扫 .vue，这个 .ts 不写导入就是未定义。
 * 代价是引用本文件的页面不会再被注入 message 的样式（vite.config.ts 里写过这个坑）。
 * 所以 message 的样式在 main.ts 里全局引了一份，不靠各页面自己带。
 */
import { ElMessage } from 'element-plus'

/* ------------------------------------------------------------- 数字 --- */

export function num(n?: number | null) {
  if (n == null) return '—'
  return Number(n).toLocaleString('zh-CN')
}

/** 大数字缩写：12345 → 1.2万 */
export function compact(n?: number | null) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '—'
  if (Math.abs(v) >= 10000) return `${(v / 10000).toFixed(1)}万`
  return v.toLocaleString('zh-CN')
}

export function percent(n?: number | null, digits = 1) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '—'
  return `${(v * 100).toFixed(digits)}%`
}

/** 秒 → 人话（用于冷却剩余、运行时长） */
export function dur(sec?: number | null) {
  const v = Number(sec)
  if (!Number.isFinite(v) || v <= 0) return '—'
  if (v < 60) return `${Math.round(v)} 秒`
  if (v < 3600) return `${Math.floor(v / 60)} 分钟`
  if (v < 86400) return `${(v / 3600).toFixed(1)} 小时`
  return `${(v / 86400).toFixed(1)} 天`
}

/** 毫秒 → 一位小数的秒（测聊的耗时用；比「1 分钟」有信息量） */
export function latency(ms?: number | null) {
  const v = Number(ms)
  if (!Number.isFinite(v) || v <= 0) return '—'
  const sec = v / 1000
  if (sec < 60) return `${sec.toFixed(1)} 秒`
  return `${(sec / 60).toFixed(1)} 分钟`
}

/* ------------------------------------------------------------- 时间 --- */

/** Go 的零值时间会被序列化成 0001-01-01 —— 一律当「没有」处理 */
function isZeroTime(iso?: string) {
  return !iso || iso.startsWith('0001-') || iso.startsWith('0000-')
}

export function timeOf(iso?: string) {
  if (isZeroTime(iso)) return ''
  const d = new Date(iso as string)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** unix 秒 → MM-DD HH:mm（凭证有效期是秒） */
export function timeOfSec(sec?: number | null) {
  const v = Number(sec)
  if (!Number.isFinite(v) || v <= 0) return ''
  const d = new Date(v * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 毫秒时间戳 → MM-DD HH:mm（文件 mtime 是毫秒） */
export function timeOfMs(ms?: number | null) {
  const v = Number(ms)
  if (!Number.isFinite(v) || v <= 0) return ''
  return timeOf(new Date(v).toISOString())
}

export function agoOf(ms?: number | null) {
  if (!ms) return ''
  const s = Math.max(0, Math.round((Date.now() - Number(ms)) / 1000))
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  return `${Math.floor(s / 3600)} 小时前`
}

/** 凭证还剩多少天（负数 = 已过期） */
export function daysLeft(expiresAt?: number | null) {
  const v = Number(expiresAt)
  if (!Number.isFinite(v) || v <= 0) return null
  return Math.floor((v * 1000 - Date.now()) / 86400000)
}

/* --------------------------------------------------------- 状态判定 --- */

/** 剩余比例（总量未知时给 null，页面显示「—」而不是假的 0%） */
export function pct(remain?: number | null, size?: number | null) {
  if (!size) return null
  return Math.round((Number(remain) / Number(size)) * 100)
}

/** 按剩余比例给色调：<20% 危险、<50% 警示、其余正常 */
export function tone(p: number | null) {
  if (p == null) return 'muted'
  if (p < 20) return 'danger'
  if (p < 50) return 'warn'
  return 'ok'
}

/**
 * 账号状态一句话。判序有意如此：手动停用 → 系统禁用 → 冷却 → 凭证过期 → 未加载 → 可用。
 * 「未加载」放最后但必须存在：加了号没重启网关时，账号看着正常却根本不在池里。
 */
export function stateOf(a: any) {
  if (a?.manualDisabled) return { text: '手动停用', tone: 'muted' }
  if (a?.disabled) return { text: '已禁用', tone: 'danger' }
  if (a?.cooling) return { text: '冷却中', tone: 'warn' }
  if (a?.expired) return { text: '凭证过期', tone: 'danger' }
  if (a?.hasFile && !a?.inPool) return { text: '未加载', tone: 'warn' }
  return { text: '可用', tone: 'ok' }
}

/** realm 显示成中文（网关把上游分成国内版 / 国际版两块） */
export function realmLabel(realm?: string) {
  if (!realm) return '—'
  return realm === 'global' ? '国际版' : '国内版'
}

/* --------------------------------------------------------------- 剪贴板 --- */

/** 转发到全站统一的实现（三层兜底，手机从 http 地址进来也能复制） */
export { copyText } from '@/core/clipboard'
