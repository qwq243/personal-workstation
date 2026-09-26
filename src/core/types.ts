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

/** 大模块分组标识。首页「全部应用」与侧边栏都按它归组；没有 category 的功能视为置顶入口（如服务与自启）。 */
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

/** 大模块顺序即导航顺序：成长 → 办公 → 学习 → 待办 → 教务（最后一组留给使用者自己加的教务类模块，出厂没有） */
export const MODULE_GROUPS: ModuleGroupMeta[] = [
  { id: 'growth', name: '成长', order: 3, icon: 'Opportunity', color: '#166534' },
  { id: 'office', name: '办公', order: 5, icon: 'Briefcase', color: '#0f766e' },
  { id: 'study', name: '学习', order: 10, icon: 'Reading', color: '#4f46e5' },
  { id: 'todo', name: '待办', order: 20, icon: 'Finished', color: '#0ea5e9' },
  { id: 'campus', name: '教务', order: 30, icon: 'Compass', color: '#8b5cf6' },
]

export function getModuleGroup(id: ModuleGroupId): ModuleGroupMeta | undefined {
  return MODULE_GROUPS.find((g) => g.id === id)
}

/** 功能模块图标：Element Plus 图标组件名（如 'Notebook'），或一个 emoji 字符串 */
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
  /** 所属大模块（成长 / 办公 / 学习 / 待办 / 教务）。不填 = 置顶入口，不参与分组 */
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
