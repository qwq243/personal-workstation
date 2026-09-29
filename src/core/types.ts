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

/**
 * 大模块分组标识。首页「全部应用」与侧边栏都按它归组。
 *
 * 分组的判据是**一句话能说清成员为什么在一起**：
 *   本机 = 这台机器在跑的东西 · 日常 = 每天要看的执行面 · 学习 = 备考与资料 ·
 *   智能体 = AI 那一侧（模型用量）· 工具 = 干杂事的器具。
 * 只对某一台机器成立的分组（各自那套外部系统的入口）不带 —— 空组不下发，
 * 留在表里只会让人以为哪儿还有入口。
 *
 * ⚠️ `category` 是**必填**：侧边栏与「全部应用」都只渲染分组里的功能，
 * 不填就等于这个功能在导航里彻底消失（`registry.ts` 里加了启动告警兜这个坑）。
 */
export type ModuleGroupId = 'local' | 'office' | 'study' | 'ai' | 'tools'

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

/** 大模块顺序即导航顺序：本机 → 日常 → 学习 → 智能体 → 工具 */
export const MODULE_GROUPS: ModuleGroupMeta[] = [
  { id: 'local', name: '本机', order: 2, icon: 'Monitor', color: '#64748b' },
  { id: 'office', name: '日常', order: 5, icon: 'Sunny', color: '#0f766e' },
  { id: 'study', name: '学习', order: 10, icon: 'Reading', color: '#4f46e5' },
  { id: 'ai', name: '智能体', order: 12, icon: 'Cpu', color: '#7c3aed' },
  { id: 'tools', name: '工具', order: 14, icon: 'Tools', color: '#0891b2' },
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
 *      例：`dashboard/` `plan/` `vocab/` `wiki/` `memo/` `processguard/` `service/`。
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
  /** 所属大模块（本机 / 日常 / 学习 / 智能体 / 工具）。
   *  **必填** —— 侧边栏与「全部应用」只渲染分组里的功能，不填这个功能就哪儿都不出现 */
  category?: ModuleGroupId
  /** 排序权重，越小越靠前 */
  order?: number
  /** 功能首页路径，点击卡片 / 侧边栏进入 */
  homePath: string
  /** 该功能的子路由，path 需写完整绝对路径（如 /vocab/study）。
   *  带 meta.title 的路由会自动出现在侧边栏二级菜单里；
   *  不想出现在导航里的路由加 meta.hideInNav = true。 */
  routes: RouteRecordRaw[]
  /** 可选：返回 false 时在侧边栏与首页隐藏该功能（例如依赖的环境还没配 —— 见 core/appconfig.ts） */
  visible?: () => boolean
  /** 可选：向首页贡献若干指标数字 */
  stats?: () => ModuleStat[]
  /** 可选：功能卡片右上角的状态胶囊文案 */
  badge?: () => string | null
}
