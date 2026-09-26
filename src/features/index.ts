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
import { guardModule } from './guard/module'
import { wikiModule } from './wiki/module'
import { memoModule } from './memo/module'

export function registerAllModules(): void {
  // 办公组（order 5）：每日看板 → 日历日程 → 模型用量 → 规划台
  registerModule(dashboardModule)
  registerModule(calendarModule)
  registerModule(usageModule)
  registerModule(planModule)
  registerModule(vocabModule)
  registerModule(wikiModule)
  registerModule(memoModule)
  registerModule(guardModule)
  // ↓ 下一个功能加在这里
}
