/**
 * 进程守护：CPU 越过阈值时释放开发工具进程的内存、结束失控进程，并按周期回收内存。
 *
 * 入口 `#/process-guard`；引擎 `server/lib/pguard.mjs`，阈值与名单在 `server/data/pguard/config.json`。
 */
import type { WorkstationModule } from '@/core/types'

export const guardModule: WorkstationModule = {
  /** id 要短（它同时是本地存储的命名空间）；路由路径保留更好读的 /process-guard */
  id: 'guard',
  name: '进程守护',
  description: '按 CPU 阈值释放开发工具内存、结束失控进程，并定时回收内存；出厂演练模式，只记录不动手。另带端口与智能体两个视图。',
  icon: 'Timer',
  color: '#d97706',
  category: 'local',
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
