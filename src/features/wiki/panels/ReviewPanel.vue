<script setup lang="ts">
/**
 * 库 · 体检面板：死链 / 孤立页 / 缺 frontmatter / 索引不同步 / 料没编译。
 * 每项都带动作（建骨架 / 编译 / 补索引 / 忽略）—— 只报不改是没用的。
 * 两条底线：建页只建骨架不猜内容；不提供删除（忽略只是不再显示）。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api } from '@/core/sidecar'
import { refresh } from '../store'

const router = useRouter()
const items = ref<any[]>([])
const counts = ref<any>({})
const hidden = ref(0)
const busy = ref('')

const KIND_LABEL: Record<string, string> = {
  'dead-link': '死链',
  orphan: '孤立页',
  'no-frontmatter': '缺 frontmatter',
  'index-missing': '索引缺项',
  'index-stale': '索引过期',
  'index-missing-file': '缺索引文件',
  'raw-pending': '料没编译',
}
const grouped = computed(() => {
  const map = new Map<string, any[]>()
  for (const it of items.value) {
    if (!map.has(it.kind)) map.set(it.kind, [])
    map.get(it.kind)!.push(it)
  }
  return [...map.entries()]
})

async function load() {
  busy.value = 'load'
  const r = await api.wikiLint()
  busy.value = ''
  if (!r.ok) return ElMessage.error(r.error ?? '体检失败')
  items.value = r.data.items ?? []
  counts.value = r.data.counts ?? {}
  hidden.value = r.data.hidden ?? 0
}

async function act(item: any, action: string, extra: Record<string, unknown> = {}) {
  busy.value = item.id
  const r = await api.wikiReviewAction({ id: item.id, action, ...extra })
  busy.value = ''
  if (!r.ok) return ElMessage.error(r.error ?? '操作失败')
  if (action === 'create-page') ElMessage.success(`已建骨架：${r.data?.path ?? r.data?.slug}（内容留空，去页面里补）`)
  else if (action === 'sync-index') ElMessage.success(r.data?.added?.length ? `index.md 补了 ${r.data.added.length} 条` : 'index.md 已经是最新的')
  else if (action === 'compile') ElMessage.success('已丢进入库队列，去「入库」页点跑队列')
  else ElMessage.success('已处理')
  if (action === 'sync-index') await refresh()
  await load()
}

async function syncAll() {
  busy.value = 'sync'
  const r = await api.wikiIndexSync(true)
  busy.value = ''
  if (!r.ok) return ElMessage.error(r.error ?? '同步失败')
  ElMessage.success(r.data?.added?.length ? `index.md 补了 ${r.data.added.length} 条` : 'index.md 已经是最新的')
  await refresh()
  await load()
}

onMounted(load)
</script>

<template>
  <div class="wk-stack">
    <div class="wk-card rv__summary">
      <div class="wk-chips">
        <span v-for="(n, k) in counts" :key="k" class="wk-chip is-static" :class="String(k).startsWith('dead') || String(k).startsWith('index-stale') ? 'wk-chip--warn' : ''">
          {{ KIND_LABEL[String(k)] ?? k }} {{ n }}
        </span>
        <span v-if="!items.length" class="wk-hint wk-hint--ok">结构没问题：没有死链、孤立页，索引也是同步的。</span>
        <span v-if="hidden" class="wk-hint">另有 {{ hidden }} 项已忽略</span>
      </div>
      <el-button size="small" :loading="busy === 'sync'" @click="syncAll">补齐 index.md</el-button>
    </div>

    <p class="wk-hint">
      只报不改的事一件不做：每项都带动作；「建骨架」只建空白页不猜内容，库也**不提供删除**（忽略只是不再显示）。
    </p>

    <section v-for="[kind, list] in grouped" :key="kind" class="wk-card wk-card--flush">
      <div class="wk-card__head">
        <h3 class="wk-card__title"><el-icon><WarningFilled /></el-icon> {{ KIND_LABEL[kind] ?? kind }}（{{ list.length }}）</h3>
        <el-button size="small" text :loading="busy === 'load'" @click="load">重查</el-button>
      </div>
      <table class="wk-table">
        <tbody>
          <tr v-for="it in list" :key="it.id">
            <td>
              <div class="rv__title">{{ it.title }}</div>
              <div class="wk-hint">{{ it.detail }}</div>
            </td>
            <td class="rv__actions">
              <el-button v-if="it.kind === 'dead-link'" size="small" type="primary" plain :loading="busy === it.id" @click="act(it, 'create-page', { target: it.target, from: it.path })">
                建骨架
              </el-button>
              <el-button v-if="it.kind === 'raw-pending'" size="small" type="primary" plain :loading="busy === it.id" @click="act(it, 'compile', { path: it.path })">
                编译
              </el-button>
              <el-button v-if="it.kind === 'index-missing' || it.kind === 'index-stale'" size="small" :loading="busy === it.id" @click="act(it, 'sync-index')">
                补索引
              </el-button>
              <el-button v-if="it.path?.startsWith('wiki/')" size="small" text type="primary" @click="router.push(`/wiki/browse?path=${encodeURIComponent(it.path)}`)">
                打开
              </el-button>
              <el-button size="small" text @click="act(it, 'ignore')">忽略</el-button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<style scoped>
.rv__summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  justify-content: space-between;
}
.rv__title {
  font-size: var(--ws-fs-sm);
  color: var(--ws-text);
  font-weight: 600;
}
.rv__actions {
  text-align: right;
  white-space: nowrap;
  width: 1%;
}
</style>
