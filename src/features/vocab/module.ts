/**
 * 英语学习功能模块定义（原「背单词」，2026-09-26 扩成英语学习）。
 * 首页路径 /vocab（单词总览）；子页面：
 *   每日一句 / 句子库（句库要自己导入，见 docs/每日一句导入.md）
 *   单词练习 / 词单管理 / 错题本 / 训练计划（单词部分，数据在 server/data/vocab/）
 *
 * 侧边栏二级项的顺序 = routes 顺序：句子在前（每天都要过一遍），单词在后。
 * 模块首页仍指 /vocab（单词总览，词库统计那页）。
 */
import type { WorkstationModule } from '@/core/types'
import { useVocabStore } from './store'

export const vocabModule: WorkstationModule = {
  id: 'vocab',
  name: '英语学习',
  description: '每日一句（写翻译 → 核对 → 自评打卡，做完才走）+ 单词（词单、错题本、训练计划）。',
  icon: 'Notebook',
  color: '#4f46e5',
  category: 'study',
  order: 30,
  homePath: '/vocab',
  badge: () => {
    const store = useVocabStore()
    return store.wrongBook.length ? `错题 ${store.wrongBook.length}` : null
  },
  stats: () => {
    const store = useVocabStore()
    return [
      { label: '词条', value: store.totalWords },
      { label: '已掌握', value: store.masteredCount, color: '#16a34a' },
      { label: '正确率', value: `${store.accuracy}%` },
    ]
  },
  routes: [
    {
      path: '/vocab/daily',
      name: 'english-daily',
      component: () => import('./SentenceDaily.vue'),
      meta: { title: '每日一句', icon: 'Reading' },
    },
    {
      path: '/vocab/library',
      name: 'english-library',
      component: () => import('./SentenceLibrary.vue'),
      meta: { title: '句子库', icon: 'List' },
    },
    {
      path: '/vocab',
      name: 'vocab-home',
      component: () => import('./VocabHome.vue'),
      meta: { title: '单词总览', icon: 'DataBoard' },
    },
    {
      path: '/vocab/study',
      name: 'vocab-study',
      component: () => import('./VocabStudy.vue'),
      meta: { title: '单词练习', icon: 'EditPen' },
    },
    {
      path: '/vocab/lists',
      name: 'vocab-lists',
      component: () => import('./VocabLists.vue'),
      meta: { title: '词单管理', icon: 'Files' },
    },
    {
      path: '/vocab/wrong',
      name: 'vocab-wrong',
      component: () => import('./VocabWrong.vue'),
      meta: { title: '错题本', icon: 'WarningFilled' },
    },
    {
      path: '/vocab/plan',
      name: 'vocab-plan',
      component: () => import('./VocabPlan.vue'),
      meta: { title: '训练计划', icon: 'Flag' },
    },
  ],
}
