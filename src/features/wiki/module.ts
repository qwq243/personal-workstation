/**
 * 知识库：抓文入库 → 编译成互链页面 → 语义检索 / 双链图谱 / 会话问答 / 结构体检。
 *
 * 侧边栏只留 4 个入口（库 / 问答 / 入库 / 设置），同级视图收进页内标签，不再拆平级子项。
 * 旧路径（`/wiki/browse`、`/wiki/search`、`/wiki/graph`、`/wiki/review`、`/wiki/p/:slug`）
 * 全部保留为 hideInNav 深链，落到同一工作区并打开对应标签 —— 已发出去的链接不许断。
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
  order: 12,
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
