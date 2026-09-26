/** 每日看板功能模块：今日 / 趋势 / AI。
 *  从置顶入口挪进「办公」分组 —— 办公组统一放每天的台面工作（看板、日历、模型用量、规划台），
 *  看板本身只做当天的浓缩视图，深度内容在各自页面。
 *
 *  **开源版只带骨架**：课表 / 待办 / 早报那几类卡的数据源因人而异，已经整块摘掉；
 *  要加自己的卡，看 DashboardHome.vue 顶部的说明。 */
import type { WorkstationModule } from '@/core/types'

export const dashboardModule: WorkstationModule = {
  id: 'dashboard',
  name: '每日看板',
  description: '今天的计划与记录、连续记录天数、模型花了多少，AI 给要点和建议（数据源自己能加卡）。',
  icon: 'DataBoard',
  color: '#0ea5e9',
  category: 'office',
  order: 20, // 办公组内第一项：这是每天的入口
  homePath: '/dashboard',
  routes: [
    {
      path: '/dashboard',
      name: 'dashboard-home',
      component: () => import('./DashboardHome.vue'),
      meta: { title: '今日', icon: 'Sunny' },
    },
    {
      path: '/dashboard/trend',
      name: 'dashboard-trend',
      component: () => import('./DashboardTrend.vue'),
      meta: { title: '趋势与记录', icon: 'TrendCharts' },
    },
    {
      path: '/dashboard/ai',
      name: 'dashboard-ai',
      component: () => import('./DashboardAI.vue'),
      meta: { title: 'AI 助手', icon: 'ChatDotRound' },
    },
  ],
}
