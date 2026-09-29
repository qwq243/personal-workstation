/**
 * 做题本（每日一题）—— 一题一份，题干在上、下面留白手写。
 *
 * 两本册子同一套版式（`book.css` / `print-sheet.css`）：
 *   数学 `#/zuotiben` + `#/zuotiben/print`（一本按日期，题是智能体灌进来的）
 *   英语 `#/zuotiben/sentence` + `#/zuotiben/sentence-print`（一本按 Day 区间，句子来自可导入的每日一句素材）
 *
 * 四条路由都 `hideInNav`：这一行在侧边栏是**单页**（没有展开箭头），点进去就是做题本；
 * 英语那本从做题本右上角或看板卡片进（2026-09-29 定的入口）。
 *
 * 为什么单开一个功能而不是塞进背单词/规划台：题目的**呈现形式**本身就是这个功能的重点
 * （2026-09-27 定：给题不许聚合成一条消息），它得有自己的一题一页版式。
 *
 * 关于 `visible`：这里**故意不设门槛**。内核约定「没配 = 不显示」针对的是「整个功能都靠那个
 * 外部目录/服务才能跑」的情况（如知识库要 `wiki.dir`）；做题本不是 —— 题目本让智能体直接灌题
 * 就能用，题库池（`zuotiben.pool.*`）只是「推荐同类题」的加分项，句库也只是可选的一本册子。
 * 所以没配时由页面出空态、由 `list_problem_pool` 回「没配题库目录」，而不是把整个功能从侧边栏
 * 藏掉（藏掉的话，没买题册的人连题目本都找不到）。
 */
import type { WorkstationModule } from '@/core/types'

export const zuotibenModule: WorkstationModule = {
  id: 'zuotiben',
  name: '做题本',
  description: '每日一题：一题一份，题干在上、下面留白手写；一题一页打印出来在平板上做（另有英语每日一句）。',
  icon: 'EditPen',
  color: '#7c3aed',
  category: 'study',
  order: 10,
  homePath: '/zuotiben',
  routes: [
    {
      path: '/zuotiben',
      name: 'zuotiben',
      component: () => import('./ZuotibenView.vue'),
      meta: { title: '做题本', icon: 'EditPen', hideInNav: true },
    },
    {
      path: '/zuotiben/print',
      name: 'zuotiben-print',
      component: () => import('./ZuotibenPrint.vue'),
      meta: { title: '打印', icon: 'Printer', hideInNav: true },
    },
    {
      path: '/zuotiben/sentence',
      name: 'zuotiben-sentence',
      component: () => import('./SentenceBook.vue'),
      meta: { title: '每日一句', icon: 'Reading', hideInNav: true },
    },
    {
      path: '/zuotiben/sentence-print',
      name: 'zuotiben-sentence-print',
      component: () => import('./SentenceBookPrint.vue'),
      meta: { title: '每日一句打印', icon: 'Printer', hideInNav: true },
    },
  ],
}
