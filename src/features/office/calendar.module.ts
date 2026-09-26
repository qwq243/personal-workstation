/**
 * 日历日程 —— 把「每周固定的课表」和「每天不同的计划 / 记录」放在同一张日历上看。
 *
 * 和「每日看板」分工：看板只看今天这一天；这里回答「这一周/这一月我的时间被什么占着」。
 * 数据全部来自边车（overview 给整周课表，dashboard/calendar 给每天的记录摘要），
 * 页面本身不存任何数据，改计划/记录直接写回 server/data/dashboard.json。
 */
import type { WorkstationModule } from '@/core/types'

export const calendarModule: WorkstationModule = {
  id: 'calendar',
  name: '日历日程',
  description: '月/周两种视图看课表与计划：哪天满课、哪天有截止、哪天记了东西；点开某天看当天全部详情。',
  icon: 'Calendar',
  color: '#0f766e',
  category: 'office',
  order: 21,
  homePath: '/office/calendar',
  routes: [
    {
      path: '/office/calendar',
      name: 'office-calendar',
      component: () => import('./CalendarView.vue'),
      // 单页模块，不在侧边栏挂二级菜单（避免与功能名重复）
      meta: { title: '日历日程', icon: 'Calendar', hideInNav: true },
    },
  ],
}
