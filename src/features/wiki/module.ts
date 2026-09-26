/**
 * 知识库。页面名用中文、id 与文件名用英文领域名（wiki ↔ `server/lib/wiki*.mjs`）。
 *
 * **层级（2026-09-24 整理）**：侧边栏只留 4 个入口，同级视图收进页内标签 ——
 *   库     `/wiki`          概览 · 页面 · 搜索 · 图谱 · 体检（五个同级视图，同一个入口）
 *   问答   `/wiki/chat`     会话式流式问答（信息密度与交互都跟别的页不同，独立成页）
 *   入库   `/wiki/ingest`   抓链接 / 导文件 / 队列 / 源目录监听
 *   设置   `/wiki/settings` 多库 / 文档解析 / 模型 / 语义检索 / 环境
 * 早先是 8 个平级子项，侧边栏一展开就把别的分组挤下去。旧路径全部保留为
 * hideInNav 的深链（`/wiki/browse`、`/wiki/search`、`/wiki/graph`、`/wiki/review`、
 * `/wiki/p/:slug`），落到同一个工作区并打开对应标签 —— 已发出去的链接不会断。
 */
import type { WorkstationModule } from '@/core/types'
import { cfgFilled } from '@/core/appconfig'

const WORKSPACE = () => import('./WikiWorkspace.vue')

export const wikiModule: WorkstationModule = {
  id: 'wiki',
  name: '知识库',
  description: '抓文入库、编译成互链页面、语义检索、双链图谱、会话问答、结构体检。',
  /** 库目录是本模块唯一的必需配置：没填就在侧边栏藏着，别让人点进去看一页报错 */
  visible: () => cfgFilled('wiki.dir'),
  icon: 'FolderOpened',
  color: '#7c3aed',
  category: 'study',
  order: 31,
  homePath: '/wiki',
  routes: [
    { path: '/wiki', name: 'wiki-home', component: WORKSPACE, meta: { title: '库', icon: 'FolderOpened' } },
    { path: '/wiki/chat', name: 'wiki-chat', component: () => import('./WikiChatView.vue'), meta: { title: '问答', icon: 'ChatDotRound' } },
    { path: '/wiki/ingest', name: 'wiki-ingest', component: () => import('./WikiIngestView.vue'), meta: { title: '入库', icon: 'Upload' } },
    { path: '/wiki/settings', name: 'wiki-settings', component: () => import('./WikiSettingsView.vue'), meta: { title: '设置', icon: 'Setting' } },
    // 旧深链（不进侧边栏）：落到工作区的对应标签
    { path: '/wiki/browse', name: 'wiki-browse', component: WORKSPACE, meta: { title: '页面', hideInNav: true } },
    { path: '/wiki/search', name: 'wiki-search', component: WORKSPACE, meta: { title: '搜索', hideInNav: true } },
    { path: '/wiki/graph', name: 'wiki-graph', component: WORKSPACE, meta: { title: '图谱', hideInNav: true } },
    { path: '/wiki/review', name: 'wiki-review', component: WORKSPACE, meta: { title: '体检', hideInNav: true } },
    { path: '/wiki/p/:slug', name: 'wiki-page', component: WORKSPACE, meta: { title: '页面', hideInNav: true } },
  ],
}
