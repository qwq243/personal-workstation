/**
 * 语音随记。三个子页面：转写（`#/memo`）/ 记录（`#/memo/records`）/ 配置（`#/memo/settings`）。
 * 边车 `server/lib/memo.mjs` + `hotwords.mjs`，接口 `/api/memo/*`。
 */
import type { WorkstationModule } from '@/core/types'
import { cfgFilled, cfgGet } from '@/core/appconfig'

export const memoModule: WorkstationModule = {
  id: 'memo',
  name: '语音随记',
  description: '传一段录音，自动转成文字并起标题、写摘要，存成一条可回看的记录。',
  icon: 'Microphone',
  color: '#e11d48',
  category: 'tools',
  order: 30,
  homePath: '/memo',
  /** 转写后端没配就不显示（「没配 = 不显示」是内核约定，见 core/appconfig.ts） */
  visible: () => cfgGet('asr.provider') !== 'none' && cfgFilled('asr.baseUrl'),
  routes: [
    {
      path: '/memo',
      name: 'memo',
      component: () => import('./MemoView.vue'),
      // 首页不挂导航项：它就是这个功能的入口行（点行进来的就是它），子页才需要在导航里单列
      meta: { title: '转写', icon: 'Microphone', hideInNav: true },
    },
    {
      path: '/memo/records',
      name: 'memo-records',
      component: () => import('./MemoRecordsView.vue'),
      meta: { title: '记录', icon: 'Notebook' },
    },
    {
      path: '/memo/settings',
      name: 'memo-settings',
      component: () => import('./MemoSettingsView.vue'),
      meta: { title: '配置', icon: 'Setting' },
    },
  ],
}
