/**
 * 模块定义（`module.ts`）—— 一个功能模块的**唯一入口**。
 *
 * 它怎么被用上：`src/features/index.ts` 里 `registerModule(<x>Module)` 一行，
 * 侧边栏条目 / 首页功能卡片 / 路由表就全出来了（三样都由注册表派生，见 `src/core/registry.ts`）。
 * 本目录的 `README.md` 讲「演示值 → 你的值」的对应表；完整步骤见 docs/EXTENDING.md §2。
 */
import type { WorkstationModule } from '@/core/types'
// import { cfgFilled } from '@/core/appconfig'   // 要「没配就不显示」时放开这行（生成器带 --config 会自动放开）

export const templateModule: WorkstationModule = {
  /** 唯一标识：同时是路由前缀与 localStorage 命名空间，**定下就别改**（见 docs/EXTENDING.md §1.1） */
  id: 'template',
  name: '功能模板',
  description: '一句话说明这个功能干什么（改这一行）',
  /**
   * Element Plus 图标名（如 'Reading'）或一个 emoji。
   * ⚠️ 用图标名时必须同时加进 `src/main.ts` 的白名单**两处**（import 与 ICONS），
   *    漏了的表现是「那块空白」而构建照样过 —— 见该文件里 `// ↓ 新图标加在这里` 锚点。
   */
  icon: 'Grid',
  /** 卡片主色（只用于顶部描边 / 徽标 / 统计数字，不做大面积填充），见 docs/design-system.md */
  color: '#0ea5e9',
  // category: 'study',   // 归组：growth / office / study / todo / campus。不写 = 置顶入口（生成器带 --group 会放开这行）
  order: 100, // 同组内越小越靠前；生成器按该组当前最大值 +1 覆盖它
  homePath: '/template',
  // visible: () => cfgFilled('template.dir'),   // 「没配 = 不显示」是内核约定，见 src/core/appconfig.ts（生成器带 --config 会放开）
  routes: [
    {
      path: '/template',
      name: 'template-home',
      component: () => import('./TemplateHome.vue'),
      /**
       * meta 约定（见 docs/EXTENDING.md §1.2）：
       *  - 带 `title` 且没 `hideInNav` 的路由 → 自动进侧边栏的二级菜单，顺序 = 数组顺序；
       *  - 单页模块惯例是给唯一那条路由加 `hideInNav: true`，避免二级项与功能名重复。
       */
      meta: { title: '功能模板', icon: 'Grid', hideInNav: true },
    },
  ],

  /* ↓ 下面两项也是可选的，按需放开；都是**同步**函数，别在里面发请求（要数据先备好 store / 缓存） */

  // stats: () => [{ label: '条目', value: 0 }],       // 首页功能卡片上的数字
  // badge: () => null,                                // 侧边栏条目右上角的胶囊文案
}
