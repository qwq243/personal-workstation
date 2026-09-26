<script setup lang="ts">
/**
 * 「端口」标签页的内容（嵌在进程守护页里，所以不带自己的页头和离线占位）。
 *
 * 端口视图：谁在监听、占用者是哪个进程、能不能动它。
 * 「结束」先过工作台移植的它的保护层（server/lib/procscan.mjs），被拒的按钮禁用并写明原因；
 * 每次结束都写 data/procscan-actions.jsonl。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { api } from '@/core/sidecar'

const loading = ref(false)
const busy = ref('')
const err = ref('')
const data = ref<any>(null)
const listenOnly = ref(true)
const q = ref('')
let timer: ReturnType<typeof setInterval> | null = null
let debounce: ReturnType<typeof setTimeout> | null = null

const items = computed(() => data.value?.items ?? [])

async function load(showLoading = false) {
  if (showLoading) loading.value = true
  try {
    const r = await api.procPorts({ listenOnly: listenOnly.value, q: q.value })
    const d = r.data as any
    if (r.ok && d?.ok !== false) {
      data.value = d
      err.value = ''
    } else err.value = d?.error ?? r.error ?? '读不到端口'
  } finally {
    if (showLoading) loading.value = false
  }
}

function onFilter() {
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => load(), 250)
}

async function endIt(row: any) {
  try {
    await ElMessageBox.confirm(`结束 ${row.name}（PID ${row.pid}）？它占用 ${row.local}。`, '确认结束这个进程', {
      confirmButtonText: '结束',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }
  busy.value = String(row.pid)
  try {
    const r = await api.procEnd(row.pid, { force: true })
    const d = r.data as any
    if (d?.ok) ElMessage.success(`已结束 ${d.name}(${d.pid})`)
    else ElMessage.error(d?.error ?? r.error ?? '结束失败')
    await load()
  } finally {
    busy.value = ''
  }
}

onMounted(() => {
  load(true)
  timer = setInterval(() => load(), 8000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div class="pane">
    <div class="toolbar">
      <span class="ws-dim">
        <b>{{ data?.total ?? '—' }}</b> 条连接与会话（显示 {{ data?.shown ?? 0 }} 条{{ listenOnly ? '，只看监听' : '' }}）
      </span>
      <span class="ws-spacer" />
      <el-input v-model="q" placeholder="端口 / 进程 / 地址" size="small" style="max-width: 180px" clearable @input="onFilter" />
      <el-switch v-model="listenOnly" size="small" active-text="只看监听" @change="load()" />
      <el-button size="small" :loading="loading" @click="load(true)"><el-icon><Refresh /></el-icon></el-button>
    </div>
    <p v-if="err" class="ws-muted">{{ err }}</p>
    <el-table v-else :data="items" size="small" max-height="480">
      <el-table-column label="端口" width="84" align="right">
        <template #default="{ row }"><span class="ws-mono">{{ row.port }}</span></template>
      </el-table-column>
      <el-table-column label="状态" width="108">
        <template #default="{ row }">
          <el-tag :type="row.state === 'LISTENING' ? 'success' : 'info'" size="small" effect="plain">{{ row.state }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="本地地址" min-width="190">
        <template #default="{ row }">
          <span class="ws-mono" style="font-size: 12px">{{ row.local }}</span>
          <el-tag v-if="row.exposed" size="small" type="warning" effect="plain" style="margin-left: 6px">对外</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="占用进程" min-width="170">
        <template #default="{ row }">{{ row.name }} <span class="ws-dim">({{ row.pid }})</span></template>
      </el-table-column>
      <el-table-column label="操作" width="104" align="right">
        <template #default="{ row }">
          <el-tooltip v-if="row.blocked" content="受保护进程：受保护名单 / 系统目录 / 会话 0 / 前台窗口 / 白名单" placement="left">
            <el-button size="small" disabled>受保护</el-button>
          </el-tooltip>
          <el-button v-else size="small" type="danger" plain :loading="busy === String(row.pid)" @click="endIt(row)">结束</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.pane { padding-top: 4px; }
.toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; font-size: 12.8px; }
</style>
