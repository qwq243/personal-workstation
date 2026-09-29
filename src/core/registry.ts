/**
 * 功能注册表 —— 工作站唯一的扩展点。
 *
 * 新增一个功能只需要三步：
 *   1. 在 src/features/<你的功能>/ 下写好自己的模块对象（实现 WorkstationModule）
 *   2. 在该目录的 module.ts 里 export 出来
 *   3. 到 src/features/index.ts 里加一行 registerModule(xxxModule)
 *
 * 侧边栏、首页功能卡片、路由表都由本注册表自动派生，不需要改动其它文件。
 */
import type { RouteRecordRaw } from 'vue-router'
import type { ModuleGroupMeta, WorkstationModule } from './types'
import { MODULE_GROUPS, getModuleGroup } from './types'

const registry = new Map<string, WorkstationModule>()

export function registerModule(mod: WorkstationModule): void {
  if (registry.has(mod.id)) {
    console.warn(`[registry] 功能 id 重复，已覆盖：${mod.id}`)
  }
  // `category` 不填 / 写错，功能会**静默消失**在侧边栏与「全部应用」里（那里只渲染分组内的功能）。
  // 这类「页面好好的、导航里找不到」最难查，所以注册时就喊一声。
  if (!mod.category) {
    console.warn(`[registry] 功能「${mod.name}」（${mod.id}）没有 category，不会出现在导航里`)
  } else if (!getModuleGroup(mod.category)) {
    console.warn(`[registry] 功能「${mod.name}」（${mod.id}）的 category 不存在：${mod.category}`)
  }
  registry.set(mod.id, mod)
}

/** 按 order 升序返回所有（可见的）功能模块 */
export function getModules(): WorkstationModule[] {
  return [...registry.values()]
    .filter((m) => (m.visible ? m.visible() : true))
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
}

export function getModule(id: string): WorkstationModule | undefined {
  return registry.get(id)
}

export interface ModuleGroup {
  group: ModuleGroupMeta
  modules: WorkstationModule[]
}

/** 按大模块归组；空组不下发，组的先后由 MODULE_GROUPS 的 order 决定 */
export function getGroupedModules(): ModuleGroup[] {
  const all = getModules()
  return MODULE_GROUPS.slice()
    .sort((a, b) => a.order - b.order)
    .map((group) => ({ group, modules: all.filter((m) => m.category === group.id) }))
    .filter((g) => g.modules.length > 0)
}

/** 汇总所有功能的路由，交给 vue-router */
export function collectRoutes(): RouteRecordRaw[] {
  return getModules().flatMap((m) => m.routes)
}
