/**
 * 模型用量 —— NewAPI 的余额、消费与请求日志（入口 `#/office/usage`）。
 *
 * 约束：边车读的是 NewAPI `/api/log/self`，这条接口不返回错误码，分不出真失败 ——
 * 页面只按可观测特征标记异常（耗时过长、花费显著高于当日均值），不假装是真失败。
 */
import type { WorkstationModule } from '@/core/types'

export const usageModule: WorkstationModule = {
  id: 'office-usage',
  name: '模型用量',
  description: 'NewAPI 余额与消费：今天花了多少、哪个密钥在烧、跑的都是什么模型、有哪些异常请求。',
  icon: 'Coin',
  color: '#d97706',
  category: 'ai',
  order: 21,
  homePath: '/office/usage',
  routes: [
    {
      path: '/office/usage',
      name: 'office-usage',
      component: () => import('./UsageView.vue'),
      meta: { title: '模型用量', icon: 'Coin', hideInNav: true },
    },
  ],
}
