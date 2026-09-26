/**
 * localStorage 统一封装：所有数据都挂在 `workstation.` 命名空间下，
 * 方便整体备份 / 导出 / 清理，也避免和别的站点 key 撞车。
 */
const NS = 'workstation'

export function nsKey(key: string): string {
  return `${NS}.${key}`
}

export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(nsKey(key))
    if (raw === null) return fallback
    return JSON.parse(raw) as T
  } catch (err) {
    console.warn(`[storage] 读取失败：${key}`, err)
    return fallback
  }
}

export function saveJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(nsKey(key), JSON.stringify(value))
  } catch (err) {
    console.warn(`[storage] 写入失败：${key}`, err)
  }
}

export function removeJSON(key: string): void {
  try {
    localStorage.removeItem(nsKey(key))
  } catch {
    /* ignore */
  }
}

/** 列出本工作站所有已存储的 key（去掉命名空间前缀） */
export function listKeys(): string[] {
  const out: string[] = []
  for (let i = 0; i < localStorage.length; i += 1) {
    const k = localStorage.key(i)
    if (k && k.startsWith(`${NS}.`)) out.push(k.slice(NS.length + 1))
  }
  return out.sort()
}

/** 导出全部工作站数据为可下载的对象 */
export function exportAll(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of listKeys()) out[key] = loadJSON(key, null)
  return out
}

/** 从导出对象恢复数据（覆盖同名 key） */
export function importAll(data: Record<string, unknown>): number {
  let n = 0
  for (const [key, value] of Object.entries(data ?? {})) {
    saveJSON(key, value)
    n += 1
  }
  return n
}

/** 估算已用空间（字节） */
export function usedBytes(): number {
  let total = 0
  for (const key of listKeys()) {
    total += nsKey(key).length + (localStorage.getItem(nsKey(key))?.length ?? 0)
  }
  return total * 2 // UTF-16
}
