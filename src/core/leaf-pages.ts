/**
 * 侧边栏的**导航树模型** —— 叶子页面（= 能置顶的那些行）与「置顶」列表都从这里出。
 *
 * 规矩（2026-09-28 用户定）：**只有叶子页面能置顶**，而且叶子 = 侧边栏里**没有展开箭头**的那些行
 * （点它就直接打开这一页）。带箭头的行是「入口」，点它还要连带展开子页，所以**不给图钉**。
 *
 * ⚠️ 别再用「路由 path 的前缀」判断叶子（那是 2026-09-28 之前的写法，两个方向都翻过车）：
 *   1. 子页面不在同一前缀下时判错：随手记的首页 `/todo` 与子页 `/paper/plugins`
 *      这类组合，两行的 path 没有嵌套关系，于是「入口」被判成叶子、
 *      右边多出一颗不该有的图钉。
 *   2. 反方向也漏：所有单页功能的路由都标了 `meta.hideInNav`（它本来就是给自己挂二级菜单用的），
 *      前缀那套写法把它们全排除在叶子之外 —— 规划台 / 做题本 / 知识库这些
 *      **最该置顶的页面反而没有图钉**。
 *
 * 所以判断依据只有一处：**这一行有没有子页面**（= 这里导出的 `subRows()`）。
 * 侧边栏（`shell/AppShell.vue`）与「全部应用」（`views/HomeView.vue`）共用本文件，不许各写一份。
 */
import { getModules } from './registry'
import type { WorkstationModule } from './types'

export interface NavSubRow {
  path: string
  title: string
}

/**
 * 某个功能的二级页 = 带 `meta.title`、没标 `hideInNav`、且**不是它自己首页**的路由。
 *
 * 排除首页这一步别省：单页功能只有一条路由，不过滤的话它会给自己挂一个展开箭头，
 * 点开是它自己（2026-09-28 发现）。
 */
export function subRows(mod: WorkstationModule): NavSubRow[] {
  const seen = new Set<string>()
  return (mod.routes ?? [])
    .filter((r: any) => !r.meta?.hideInNav && r.meta?.title && typeof r.path === 'string')
    .filter((r: any) => r.path !== mod.homePath)
    .map((r: any) => ({ path: r.path as string, title: r.meta.title as string }))
    .filter((item) => (seen.has(item.path) ? false : (seen.add(item.path), true)))
}

/** 这一行有没有展开箭头（有子页面的入口行不给图钉，点它要连带展开） */
export function hasSubRows(mod: WorkstationModule): boolean {
  return subRows(mod).length > 0
}

export interface LeafPage {
  path: string
  title: string
  icon: string
  moduleId: string
}

/** 全部叶子页面：没有子页面的功能行（整行就是一页）+ 各功能里最下层的那些子页 */
export function leafPages(): LeafPage[] {
  const out: LeafPage[] = []
  for (const m of getModules()) {
    const subs = subRows(m)
    if (!subs.length) {
      // 单页功能：整行就是一页，标题用功能名（与侧边栏显示的那一行完全一致）
      out.push({ path: m.homePath, title: m.name, icon: m.icon, moduleId: m.id })
      continue
    }
    // 图标沿用所属功能的图标 —— 收起侧栏时置顶行只剩图标，没图标就是一行空白
    for (const s of subs) {
      if (subs.some((o) => o.path !== s.path && o.path.startsWith(s.path + '/'))) continue
      out.push({ path: s.path, title: s.title, icon: m.icon, moduleId: m.id })
    }
  }
  return out
}

export function leafMap(): Map<string, LeafPage> {
  return new Map(leafPages().map((x) => [x.path, x]))
}

/** 把「置顶 path 列表」解析成可渲染的条目（顺序 = 用户点进来的顺序；找不到的跳过） */
export function pinnedEntries(pinnedPaths: string[]): LeafPage[] {
  const map = leafMap()
  return pinnedPaths.map((p) => map.get(p)).filter(Boolean) as LeafPage[]
}

/**
 * 推荐置顶的几页 —— 只在**从没点过置顶**时当默认值用（`core/ui.ts`），
 * 设置页那颗「用推荐置顶」按钮也读它。挑选依据 = 每天都要开的备考三件套 + 计划与资讯：
 *   做题本（每日一题）· 每日一句 · 单词练习 · 规划台 · 资讯
 */
export const RECOMMENDED_PINS: string[] = ['/zuotiben', '/vocab/daily', '/vocab/study', '/plan', '/news']
