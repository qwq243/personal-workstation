/**
 * 语音随记。
 * 入口 `#/memo`（边车 `server/lib/memo.mjs` + `/api/memo/*`）。
 */
import type { WorkstationModule } from '@/core/types'
import { cfgFilled, cfgGet } from '@/core/appconfig'

export const memoModule: WorkstationModule = {
  id: 'memo',
  name: '语音随记',
  description: '传一段录音，自动转成文字并起标题、写摘要，存成一条可回看的记录。',
  icon: 'Microphone',
  color: '#e11d48',
  category: 'office',
  order: 26,
  homePath: '/memo',
  /** 转写后端没配就不显示（「没配 = 不显示」是内核约定，见 core/appconfig.ts） */
  visible: () => cfgGet('asr.provider') !== 'none' && cfgFilled('asr.baseUrl'),
  routes: [
    {
      path: '/memo',
      name: 'memo',
      component: () => import('./MemoView.vue'),
      meta: { title: '语音随记', icon: 'Microphone', hideInNav: true },
    },
  ],
}
