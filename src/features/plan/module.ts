/**
 * 规划台 —— 长期目标：项目推进 + 备考清单 + 关键日期倒计时（入口 `#/plan`）。
 *
 * 数据在 `server/data/plan.json`，页面与智能体都能读写。
 */
import type { WorkstationModule } from '@/core/types'

export const planModule: WorkstationModule = {
  id: 'plan',
  name: '规划台',
  description: '项目进度与下一步、备考清单、关键日期倒计时；智能体也能往里写。',
  icon: 'Flag',
  color: '#4f46e5',
  category: 'office',
  order: 24,
  homePath: '/plan',
  routes: [
    {
      path: '/plan',
      name: 'plan-board',
      component: () => import('./PlanBoard.vue'),
      // 单页模块，不再在侧边栏挂二级菜单
      meta: { title: '规划台', icon: 'Flag', hideInNav: true },
    },
  ],
}
