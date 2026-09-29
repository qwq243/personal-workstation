/**
 * 功能总装配处 —— 加新功能只改这个文件。
 *
 *   import { xxxModule } from './xxx/module'
 *   registerModule(xxxModule)
 *
 * 关于 `visible`：模块自己可以在环境不满足时返回 false（例如「依赖的目录还没配」），
 * 内核会把它从侧边栏与首页隐掉 —— 见 src/core/types.ts 的 WorkstationModule.visible。
 * 「没配 = 不显示」是内核约定，不要让每个页面各自判空。
 */
import { registerModule } from '@/core/registry'
import { dashboardModule } from './dashboard/module'
import { planModule } from './plan/module'
import { calendarModule } from './office/calendar.module'
import { usageModule } from './office/usage.module'
import { vocabModule } from './vocab/module'
import { zuotibenModule } from './zuotiben/module'
import { newsModule } from './news/module'
import { guardModule } from './guard/module'
import { serviceModule } from './service/module'
import { wikiModule } from './wiki/module'
import { memoModule } from './memo/module'
// ↓ 新模块 import 加在这里（三步法的第 1 步；图标别忘了 src/main.ts 的两处锚点）

export function registerAllModules(): void {
  // 侧边栏顺序由两层决定：大模块分组的 order（见 core/types.ts 的 MODULE_GROUPS），
  // 组内按各模块的 order 升序。这里只列「注册」，排序在 registry.ts 里做。
  // 本机组（order 6–9）：这台机器在跑的东西 —— 进程守护 → 运行与自启
  registerModule(guardModule)
  registerModule(serviceModule)
  // 学习组（order 10–19）：备考与资料 —— 做题本 → 英语学习 → 知识库 → 资讯
  registerModule(zuotibenModule)
  registerModule(vocabModule)
  registerModule(wikiModule)
  registerModule(newsModule)
  // 智能体组（order 20–29）：模型那一侧
  registerModule(usageModule)
  // 工具组（order 30–39）：干杂事的器具
  registerModule(memoModule)
  // 日常组（order 40–49）：每天要看的执行面 —— 每日看板 → 日历日程 → 规划台
  registerModule(dashboardModule)
  registerModule(calendarModule)
  registerModule(planModule)
  // ↓ 下一个功能加在这里（新图标别忘了 src/main.ts 的白名单，两处）
}
