/**
 * 规划台 —— 长期目标：项目推进 + 备考清单 + 关键日期倒计时。
 *
 * 和「每日看板」分工：看板管今天这一天（课表、待办、计划、复盘），
 * 这里管这个学期要推进到哪（项目到几成、备考到哪个阶段、哪个截止快到了）。
 * 2026-09-14 起归入「办公」分组（同组：每日看板 / 日历日程 / 模型用量）。
 * 数据存在 server/data/plan.json，智能体也能读写。
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
