/**
 * 模型用量 —— NewAPI 的余额、消费与请求日志（网页版）。
 *
 * 页面结构的基本思路（前身是一个同名插件的「余额/用量」页）：
 * 同样的信息层级 —— 顶部余额 + 今日花费、小时花费、模型分布、密钥用量、请求日志。
 * 但**不照搬它的配色**（插件是自绘蓝色渐变 + 硬编码红绿），这里走工作站设计令牌：
 * 靛蓝主色渐变、软底语义色、卡片圆角与阴影统一。
 *
 * 一条要诚实的地方：
 *   边车拿的是 NewAPI `/api/log/self`，这条接口**不返回错误码**，分不出真失败。
 *   所以这里不用「失败」这个词，改成按可观测的异常特征标记：
 *   耗时过长、花费显著高于当日均值 —— 并在页面上写明这一点，不假装是真失败。
 */
import type { WorkstationModule } from '@/core/types'

export const usageModule: WorkstationModule = {
  id: 'office-usage',
  name: '模型用量',
  description: 'NewAPI 余额与消费：今天花了多少、哪个密钥在烧、跑的都是什么模型、有哪些异常请求。',
  icon: 'Coin',
  color: '#d97706',
  category: 'office',
  order: 22,
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
