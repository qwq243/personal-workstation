/**
 * 进程守护：CPU 越过阈值时释放开发工具进程的内存、结束失控进程，并按固定周期回收内存。
 *
 * 为什么独立成模块：它跟「服务与自启」是同一家族（本机后台服务：启停 + 状态），
 * 但它有自己的配置与审计日志，塞进那一页会把那页撑爆。放在置顶区，排在「服务与自启」后面。
 */
import type { WorkstationModule } from '@/core/types'

export const guardModule: WorkstationModule = {
  /** id 要短（它同时是本地存储的命名空间）；路由路径保留更好读的 /process-guard */
  id: 'guard',
  name: '进程守护',
  description: '按 CPU 阈值释放开发工具内存、结束失控进程，并定时回收内存；出厂演练模式，只记录不动手。另带端口与智能体两个视图。',
  icon: 'Timer',
  color: '#d97706',
  order: 7,
  homePath: '/process-guard',
  routes: [
    {
      path: '/process-guard',
      name: 'process-guard',
      component: () => import('./GuardView.vue'),
      meta: { title: '进程守护', icon: 'Timer', hideInNav: true },
    },
  ],
}
