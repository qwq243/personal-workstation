/**
 * 前端能读到的边车配置快照。
 *
 * 为什么要有它：模块的 `visible()` 是**同步**的，而配置要从边车取（异步）。
 * 所以启动时先拉一次存在这里，`visible()` 只读内存。
 *
 * 约定（内核级，不是每个页面自己判空）：**没配 = 不显示**。
 * 一个模块依赖的目录 / 端点还没填时，它就该从侧边栏消失，而不是点进去看一页报错。
 * 没加载完时一律当「可见」—— 慢启动期间侧边栏不该闪一下又变。
 */
import { api } from './sidecar'

let snapshot: Record<string, any> | null = null
let loaded = false

/** 已加载到的配置整包；还没加载或边车不在时返回 null */
export function appConfig(): Record<string, any> | null {
  return snapshot
}

/** 配置是否已经取过一次（无论成功失败） */
export function appConfigLoaded(): boolean {
  return loaded
}

/** 取一次配置并缓存。边车不在也不报错 —— 调用方按「没配」处理 */
export async function loadAppConfig(): Promise<void> {
  if (loaded) return
  try {
    const r = await api.config()
    const c = (r.data as any)?.config
    if (c && typeof c === 'object') snapshot = c
  } catch {
    /* 边车不在：snapshot 保持 null，所有 visible() 都当可见 */
  } finally {
    loaded = true
  }
}

/** 读配置里的点分路径，例如 `cfgGet('wiki.dir')`。没加载时返回 undefined */
export function cfgGet(path: string): unknown {
  if (!snapshot) return undefined
  let cur: any = snapshot
  for (const k of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = cur[k]
  }
  return cur
}

/** 配置里这一项是否已填（能通过 profile 检查就返回 true）。未加载时按「已填」处理 */
export function cfgFilled(path: string): boolean {
  if (!snapshot) return true
  const v = cfgGet(path)
  if (typeof v === 'string') return v.trim() !== ''
  if (typeof v === 'number') return Number.isFinite(v)
  return v !== undefined && v !== null
}

/** 测试用：清掉缓存（页面里用不到） */
export function resetAppConfigCache(): void {
  snapshot = null
  loaded = false
}
