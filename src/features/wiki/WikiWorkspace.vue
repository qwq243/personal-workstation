<script setup lang="ts">
/**
 * 「库」入口：把**读与查**这几件同级的事收进一个页面（概览 / 页面 / 搜索 / 图谱 / 体检）。
 *
 * 为什么收：原来它们是 8 个平级子项，侧边栏一展开就把别的分组挤下去，
 * 而且「搜一个词」「看一眼图谱」本来就不是两次独立的「去某页」——
 * 它们都是「在这份库里找东西」。现在侧边栏只有 4 个入口（库 / 问答 / 入库 / 设置）。
 *
 * 标签仍走 URL（?tab=…），所以旧的深链一个都没断：
 *   /wiki/browse、/wiki/search、/wiki/graph、/wiki/review 都落到这里并打开对应标签。
 */
import { onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WikiShell from './WikiShell.vue'
import OverviewPanel from './panels/OverviewPanel.vue'
import PagesPanel from './panels/PagesPanel.vue'
import SearchPanel from './panels/SearchPanel.vue'
import GraphPanel from './panels/GraphPanel.vue'
import ReviewPanel from './panels/ReviewPanel.vue'
import { refresh, status } from './store'

const route = useRoute()
const router = useRouter()

const TABS = [
  { id: 'overview', label: '概览', icon: 'FolderOpened' },
  { id: 'pages', label: '页面', icon: 'Notebook' },
  { id: 'search', label: '搜索', icon: 'Files' },
  { id: 'graph', label: '图谱', icon: 'DataLine' },
  { id: 'review', label: '体检', icon: 'WarningFilled' },
]
const tab = ref('overview')

function fromRoute(): string {
  const t = String(route.query.tab ?? '')
  if (TABS.some((x) => x.id === t)) return t
  // 兼容旧路径：/wiki/browse → pages，/wiki/search → search，以此类推
  const p = route.path
  if (p.endsWith('/browse') || p.startsWith('/wiki/p/')) return 'pages'
  if (p.endsWith('/search')) return 'search'
  if (p.endsWith('/graph')) return 'graph'
  if (p.endsWith('/review')) return 'review'
  return 'overview'
}

function setTab(id: string) {
  tab.value = id
  // 表里用 ?tab= 记状态；页面深链（?path=/?slug=）在切标签时清掉，避免「切到搜索还带着旧页面」
  const query: Record<string, string> = { ...(route.query as Record<string, string>), tab: id }
  delete query.path
  delete query.slug
  delete query.type
  void router.replace({ path: '/wiki', query })
}

const SUBTITLE: Record<string, string> = {
  overview: '这份库现在长什么样：页面构成、最近记录、待办',
  pages: '读一页、改一页 —— 正文里的 [[双链]] 可以直接跳',
  search: '词法搜词、语义搜意思，也可以融合',
  graph: '双链关系图；虚线圈 = 链了但还没建的页',
  review: '死链 / 孤立页 / 索引不同步 / 料没编译，每项都带动作',
}

onMounted(async () => {
  tab.value = fromRoute()
  if (!status.value) await refresh()
})

watch(
  () => [route.query.tab, route.path, route.query.path],
  () => {
    const t = fromRoute()
    if (t !== tab.value) tab.value = t
  },
)
</script>

<template>
  <WikiShell title="库" :subtitle="SUBTITLE[tab]" icon="FolderOpened" :tabs="TABS" :tab="tab" @update:tab="setTab">
    <OverviewPanel v-if="tab === 'overview'" @go="setTab" />
    <PagesPanel v-else-if="tab === 'pages'" />
    <SearchPanel v-else-if="tab === 'search'" />
    <GraphPanel v-else-if="tab === 'graph'" />
    <ReviewPanel v-else-if="tab === 'review'" />
  </WikiShell>
</template>
