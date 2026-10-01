/**
 * WorkBuddy —— 上游账号池的额度与运维：额度概览 / 账号池 / 活动管理 / 测聊 / 网关配置五个子页。
 *
 * 数据源是**自己装的那份** WorkBuddy2API 网关（不随本仓库分发），它把上游账号包成
 * OpenAI 兼容 API 并自己记账；目录填在 `config.workbuddy.dir`，没填就整个功能不显示。
 * 约束：账号运维一律走网关自带 CLI（signin_bin / activity_bin / travel_bin / keepalive_bin /
 * trial_bin / credit / login），不重写上游调用。
 */
import type { WorkstationModule } from '@/core/types'
import { cfgFilled } from '@/core/appconfig'

export const workbuddyModule: WorkstationModule = {
  id: 'office-workbuddy',
  name: 'WorkBuddy',
  description: '上游账号池：积分与调用情况，外加账号池运维、活动任务与开关、测聊与网关配置。',
  icon: 'Wallet',
  color: '#7c3aed',
  category: 'ai',
  order: 22,
  homePath: '/office/workbuddy',
  /** 网关目录是本模块唯一的必需配置：没填就藏着，别让人点进去看一页空（「没配 = 不显示」） */
  visible: () => cfgFilled('workbuddy.dir'),
  routes: [
    {
      path: '/office/workbuddy',
      name: 'office-workbuddy',
      component: () => import('./WorkbuddyView.vue'),
      meta: { title: '额度概览', icon: 'Wallet' },
    },
    {
      path: '/office/workbuddy/accounts',
      name: 'office-workbuddy-accounts',
      component: () => import('./WorkbuddyAccounts.vue'),
      meta: { title: '账号池', icon: 'User' },
    },
    {
      path: '/office/workbuddy/tasks',
      name: 'office-workbuddy-tasks',
      component: () => import('./WorkbuddyTasks.vue'),
      meta: { title: '活动管理', icon: 'AlarmClock' },
    },
    {
      path: '/office/workbuddy/chat',
      name: 'office-workbuddy-chat',
      component: () => import('./WorkbuddyChat.vue'),
      meta: { title: '测聊', icon: 'ChatDotRound' },
    },
    {
      path: '/office/workbuddy/config',
      name: 'office-workbuddy-config',
      component: () => import('./WorkbuddyConfig.vue'),
      meta: { title: '网关配置', icon: 'Setting' },
    },
  ],
}
