/**
 * 资讯（`#/news`）—— 采集器产物的阅读面。
 *
 * 页面上要有：总的 AI 总结、批次概要轮播（每批定时跑的简报）、关注时间线（可展开）、
 * 点击溯源（看案卷）。**来源不分成块**：合并成一条流，只打来源标签，官方来源单独高亮。
 *
 * 数据来自边车 `server/lib/newsfeed.mjs`（只读采集器的产物：`out/`、`timeline/`、`cases/`）；
 * **采集本身不在这里做** —— 采集器是独立进程（本机计划任务 / 定时器都行），
 * 产物目录由 `collector.dir` 指定，契约见 `docs/news-contract.md`。
 */
import type { WorkstationModule } from '@/core/types'
import { cfgFilled } from '@/core/appconfig'

export const newsModule: WorkstationModule = {
  id: 'news',
  name: '资讯',
  description: '把外网源的更新合成一条流，再概括成同类事件：来源可点、能溯源、能看时间线，每批有 AI 总结。',
  icon: 'Promotion',
  color: '#0ea5e9',
  category: 'study',
  order: 13,
  homePath: '/news',
  /** 采集器产物目录是本模块唯一的必需配置：没填就藏着，别让人点进去看一页空（「没配 = 不显示」） */
  visible: () => cfgFilled('collector.dir'),
  routes: [
    { path: '/news', name: 'news-home', component: () => import('./NewsView.vue'), meta: { title: '资讯', icon: 'Promotion' } },
  ],
}
