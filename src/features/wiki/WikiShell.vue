<script setup lang="ts">
/**
 * 知识库的共享壳层：页面头 + 库信息条 +（可选）标签条 + 内容。
 *
 * 为什么要它：8 个界面各写一遍「标题 + 一堆状态数字」的结果是同一件事八种写法，
 * 数字散落各处、切库要回设置页。现在所有知识库页面顶上都是同一条信息条 ——
 * 当前库、页面数、未编译的料、向量索引、队列一眼看全，点数字就跳到对应位置。
 *
 * 标签条用于把「读与查」这类同级视图收进一个入口（见 module.ts 的层级说明）。
 */
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '@/core/sidecar'
import { embedStatus, loadProjects, loading, pendingRaw, projects, queue, refresh, status } from './store'

const props = defineProps<{
  title: string
  subtitle?: string
  icon?: string
  /** 标签条：给了就渲染，激活项用 v-model:tab 同步 */
  tabs?: { id: string; label: string; icon?: string }[]
  tab?: string
}>()
const emit = defineEmits<{ (e: 'update:tab', v: string): void }>()

const router = useRouter()

const libName = computed(() => {
  const active = projects.value?.projects?.find((p: any) => p.active)
  return active?.name ?? String(status.value?.root ?? '').split('/').pop() ?? '（未指定）'
})
const libPath = computed(() => String(status.value?.root ?? ''))
const multi = computed(() => (projects.value?.projects?.length ?? 0) > 1)
const queueOpen = computed(() => (queue.value?.counts?.pending ?? 0) + (queue.value?.counts?.parsing ?? 0) + (queue.value?.counts?.extracting ?? 0) + (queue.value?.counts?.ingesting ?? 0))
const queueErr = computed(() => queue.value?.counts?.error ?? 0)

async function reload() {
  await refresh()
  await loadProjects()
  const q = await api.wikiQueue(20)
  if (q.ok) queue.value = q.data
}

async function switchLib(dir: string) {
  const r = await api.wikiSetProject(dir)
  if (r.ok) await reload()
}
function onTab(id: string) {
  emit('update:tab', id)
}

onMounted(() => {
  if (!status.value) void reload()
})
</script>

<template>
  <div class="wk-page">
    <PageHeader :title="title" :subtitle="subtitle" :icon="icon">
      <template #actions>
        <slot name="actions" />
        <el-button size="small" :loading="loading" @click="reload">刷新</el-button>
      </template>
    </PageHeader>

    <!-- 库信息条：每个知识库页面都有，看一眼就知道「现在读的是哪个库、它什么状态」。
         形态与看板一致 —— 一张白卡，左边是「这是什么」，右边是状态。 -->
    <div class="libbar">
      <span class="libbar__name">
        <el-icon><FolderOpened /></el-icon>
        {{ libName }}
      </span>
      <span class="libbar__path ws-mono" :title="libPath">{{ libPath }}</span>

      <el-select
        v-if="multi"
        :model-value="libPath"
        size="small"
        class="libbar__switch"
        placeholder="切换知识库"
        @change="switchLib($event as string)"
      >
        <el-option v-for="p in projects?.projects ?? []" :key="p.dir" :label="p.name" :value="p.dir" />
      </el-select>
      <button v-else class="wk-chip" @click="router.push('/wiki/settings')">库设置</button>

      <span class="libbar__spacer" />

      <span class="libbar__stat">页面 <b>{{ status?.pages?.total ?? 0 }}</b></span>
      <span class="libbar__stat">原始资料 <b>{{ status?.sources ?? 0 }}</b></span>
      <span class="libbar__stat" :title="`向量索引 ${embedStatus?.indexed ?? 0}/${embedStatus?.pages ?? 0} 页`">
        索引 <b>{{ embedStatus?.indexed ?? 0 }}/{{ embedStatus?.pages ?? 0 }}</b>
      </span>
      <button
        v-if="pendingRaw.length"
        class="wk-chip wk-chip--warn"
        title="还有料没编译成页面，点这里去入库"
        @click="router.push('/wiki/ingest')"
      >
        {{ pendingRaw.length }} 份未编译
      </button>
      <button v-if="queueErr" class="wk-chip wk-chip--warn" title="入库队列有失败项" @click="router.push('/wiki/ingest')">
        队列 {{ queueErr }} 失败
      </button>
      <button v-else-if="queueOpen" class="wk-chip" title="入库队列在跑" @click="router.push('/wiki/ingest')">
        队列 {{ queueOpen }} 进行中
      </button>
    </div>

    <!-- 视图切换：跟看板「周 / 月」同一种控件（同一入口内的视图变化用开关，不用侧边栏） -->
    <div v-if="tabs?.length" class="tabrow">
      <el-radio-group :model-value="tab" size="small" @update:model-value="onTab($event as string)">
        <el-radio-button v-for="t in tabs" :key="t.id" :value="t.id">{{ t.label }}</el-radio-button>
      </el-radio-group>
    </div>

    <slot />
  </div>
</template>

<style scoped>
/* 库信息条：与看板同类——白卡 + 一层极浅阴影。左边「这是什么」，右边状态。
   状态用 12px 灰字 + 主色数字，不再是一排胶囊（胶囊多了像工具栏，看不出主次）。 */
.libbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  background: var(--ws-panel);
  border: 1px solid var(--ws-border);
  border-radius: var(--ws-radius-lg);
  box-shadow: var(--ws-shadow-1);
}
.libbar__name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--ws-fs-base);
  font-weight: 650;
  color: var(--ws-text);
}
.libbar__name :deep(.el-icon) {
  color: var(--ws-accent);
}
.libbar__path {
  max-width: 380px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  color: var(--ws-text-3);
}
.libbar__switch {
  width: 160px;
}
.libbar__spacer {
  flex: 1 1 auto;
}
.libbar__stat {
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-3);
  white-space: nowrap;
}
.libbar__stat b {
  font-weight: 650;
  color: var(--ws-text);
  font-variant-numeric: tabular-nums;
}

/* 视图切换：控制项自己占一行、靠左（看板里「周 / 月」在卡片头，这里视图更多，
   单列一行更稳，也避免库信息条被挤成两行）。 */
.tabrow {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: -6px;
}
</style>
