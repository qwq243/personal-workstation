<script setup lang="ts">
/**
 * 功能模板 · 首页（`#/template`）—— 本仓库**联网页面的标准写法**，照抄就行。
 *
 * 四段结构（所有联网页面都是这个形状）：
 *   ① `ensureSidecar()` 探一次健康；探不到就显示 `SidecarOffline` 引导卡，**不白屏**；
 *   ② 数据从 `api.*` 拿（**不要在页面里裸 fetch**：令牌、超时、中文错误文案都在那边统一处理，
 *      见 docs/EXTENDING.md §3.3）；
 *   ③ 空态用 `EmptyState`，别显示一张空表格；
 *   ④ 要么给刷新按钮、要么轮询 —— 轮询要「先立刻打一次、终态停、onUnmounted 清掉」（§5.3）。
 *
 * 纯页面（数据全在浏览器里）就把 `api` / `ensureSidecar` / `SidecarOffline` 那几行删掉，
 * 其余保持不变。
 */
import { onMounted, ref } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import EmptyState from '@/components/EmptyState.vue'
import SidecarOffline from '@/components/SidecarOffline.vue'
import { api, ensureSidecar } from '@/core/sidecar'

const ready = ref(false)
const loading = ref(true)
const items = ref<any[]>([])

async function load() {
  loading.value = true
  ready.value = await ensureSidecar()
  if (!ready.value) {
    loading.value = false
    return
  }
  // ↓ 有后端接口时接在这里（生成器带 --api 会自动填好下面两行）
  // const r = await api.templateItems()
  // if (r.ok) items.value = r.data?.items ?? []
  loading.value = false
}

onMounted(load)
</script>

<template>
  <div class="ws-page">
    <!-- ws-page--wide 用于宽表 / 日历这类页面；颜色只引 src/styles/tokens.css 的变量 -->
    <PageHeader title="功能模板" subtitle="一句话说明这个功能干什么（改这一行）" icon="Grid">
      <template #actions>
        <el-button :loading="loading" @click="load"><el-icon><Refresh /></el-icon>&nbsp;刷新</el-button>
      </template>
    </PageHeader>

    <!-- ready 为 false 时给引导；「重新检测」成功后会 emit ready → 回到 load() -->
    <SidecarOffline v-if="!loading && !ready" what="功能模板" @ready="load" />

    <el-skeleton v-else-if="loading" :rows="6" animated />

    <EmptyState
      v-else-if="!items.length"
      title="还没有内容"
      description="这是空态。接上自己的数据源之后这条提示就不会出现了。"
    />

    <div v-else class="ws-card" style="padding: 18px">
      <div v-for="it in items" :key="it.id" class="ws-row" style="justify-content: space-between">
        <span>{{ it.text }}</span>
        <span class="ws-dim">{{ it.at }}</span>
      </div>
    </div>
  </div>
</template>
