/**
 * 工作站内核类型定义
 * 所有功能模块（feature）都实现 WorkstationModule 接口，向内核注册自己。
 */
import type { RouteRecordRaw } from 'vue-router'

/** 功能模块可以向首页贡献的小指标，例如「已掌握 128 词」 */
export interface ModuleStat {
  label: string
  value: string | number
  /** 可选颜色（hex），用于强调数值 */
  color?: string
}

/** 大模块分组标识。首页「全部应用」与侧边栏都按它归组；没有 category 的功能视为置顶入口（当前是「进程守护」与「运行与自启」）。 */
export type ModuleGroupId = 'growth' | 'office' | 'study' | 'todo' | 'campus'

export interface ModuleGroupMeta {
  id: ModuleGroupId
  /** 大模块名，显示在侧边栏与「全部应用」页 */
  name: string
  /** 排序权重，越小越靠前 */
  order: number
  /** Element Plus 图标组件名 */
  icon: string
  color: string
}

/**
 * 大模块顺序即导航顺序：成长 → 办公 → 学习 → 待办 → 校内
 * （最后一组只是给校内类模块预留的空位，出厂没有模块用它）。
 *
 * 组的排序权重取 3/5/10/20/30 这样的**稀疏号段**，是为了给后来加的分组留插队位置
 * （想插在办公和学习之间就用 6~9）。单个模块的 `order` 同理：同组内按 10 上下递增留缝 ——
 * 办公组现值 看板 20、日历 21、用量 22、规划台 24、随记 26；学习组 vocab 30、wiki 31；
 * 置顶区（没有 category）guard 7、service 8。要插队就取中间的空号，不必重排别人。
 */
export const MODULE_GROUPS: ModuleGroupMeta[] = [
  { id: 'growth', name: '成长', order: 3, icon: 'Opportunity', color: '#166534' },
  { id: 'office', name: '办公', order: 5, icon: 'Briefcase', color: '#0f766e' },
  { id: 'study', name: '学习', order: 10, icon: 'Reading', color: '#4f46e5' },
  { id: 'todo', name: '待办', order: 20, icon: 'Finished', color: '#0ea5e9' },
  { id: 'campus', name: '校内', order: 30, icon: 'Compass', color: '#8b5cf6' },
]

export function getModuleGroup(id: ModuleGroupId): ModuleGroupMeta | undefined {
  return MODULE_GROUPS.find((g) => g.id === id)
}

/**
 * 功能模块图标：Element Plus 图标组件名（如 'Notebook'），或一个 emoji 字符串
 *
 * ---------------------------------------------------------------------------
 * 目录约定（`src/features/` 下怎么摆文件）—— 照这个来，别照目录名猜
 *
 *   1. **一个目录装一个模块** → 模块定义就叫 `module.ts`。
 *      例：`dashboard/` `plan/` `vocab/` `wiki/` `memo/` `guard/` `service/`。
 *      目录名与模块 `id` 保持一致（`id` 同时也是路由前缀与 localStorage 命名空间）。
 *
 *   2. **一个目录装多个模块** → 每个模块一个 `<模块 id>.module.ts`，**不要**出现 `module.ts`。
 *      例：`office/` 里是 `calendar.module.ts`（id=calendar）与 `usage.module.ts`（id=office-usage）。
 *      注册时按文件路径 import，`src/features/index.ts` 里能一眼看出谁是谁。
 *
 *   3. **只被别处引用的共享组件** → 放 `src/features/<域>/`，但**不要**给它起模块文件。
 *      例：`settings/` 只有 `LlmSection.vue` / `EmbeddingSection.vue` / `SearchSection.vue`，
 *      被 `src/views/SettingsView.vue` 引用，它自身不是一个功能模块（没有入口、不上侧边栏）。
 *      这类目录里的组件也不是「内核组件」—— 内核级的复用件在 `src/components/`。
 *
 * 为什么要有这条约定：模块的**入口**只有一处（`src/features/index.ts`），
 * 而 `src/features/` 下同时住着「模块」和「共享组件」两类东西。
 * 上面三条是「看文件名就知道它是不是一个模块」的最小判据。
 * 加模块的完整步骤（含要动的其它文件）见 `docs/EXTENDING.md` §2。
 * ---------------------------------------------------------------------------
 */
export interface WorkstationModule {
  /** 唯一标识，用作路由 / 存储命名空间，需保持稳定，不要随意改 */
  id: string
  /** 功能名称（中文），显示在侧边栏与功能卡片上 */
  name: string
  /** 一句话说明，显示在功能卡片上 */
  description: string
  /** Element Plus 图标组件名（如 'Notebook'）或 emoji */
  icon: string
  /** 卡片主色，建议用 hex，如 '#4f46e5'。缺省使用主题主色 */
  color?: string
  /** 所属大模块（成长 / 办公 / 学习 / 待办 / 校内）。不填 = 置顶入口，不参与分组 */
  category?: ModuleGroupId
  /** 排序权重，越小越靠前 */
  order?: number
  /** 功能首页路径，点击卡片 / 侧边栏进入 */
  homePath: string
  /** 该功能的子路由，path 需写完整绝对路径（如 /vocab/study）。
   *  带 meta.title 的路由会自动出现在侧边栏二级菜单里；
   *  不想出现在导航里的路由加 meta.hideInNav = true。 */
  routes: RouteRecordRaw[]
  /** 可选：返回 false 时在侧边栏与首页隐藏该功能（例如依赖的环境不可用） */
  visible?: () => boolean
  /** 可选：向首页贡献若干指标数字 */
  stats?: () => ModuleStat[]
  /** 可选：功能卡片右上角的状态胶囊文案 */
  badge?: () => string | null
}
