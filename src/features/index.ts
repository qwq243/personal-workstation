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
import { serviceModule } from './service/module'
import { wikiModule } from './wiki/module'
import { memoModule } from './memo/module'
// ↓ 新模块 import 加在这里（三步法的第 1 步；图标别忘了 src/main.ts 的两处锚点）

export function registerAllModules(): void {
  // 侧边栏顺序由两层决定：大模块分组的 order（见 core/types.ts 的 MODULE_GROUPS），
  // 组内按各模块的 order 升序。这里只列「注册」，排序在 registry.ts 里做。
  // 置顶区（没有 category 的）：进程守护 → 运行与自启。
  registerModule(dashboardModule)
  registerModule(calendarModule)
  registerModule(usageModule)
  registerModule(planModule)
  registerModule(vocabModule)
  registerModule(wikiModule)
  registerModule(memoModule)
  registerModule(guardModule)
  registerModule(serviceModule)
  // ↓ 下一个功能加在这里（新图标别忘了 src/main.ts 的白名单，两处）
}
