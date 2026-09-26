<script setup lang="ts">
/**
 * 库 · 图谱面板：双链关系图 + 连接最多的页 + 还没建的页（虚线圈）。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api } from '@/core/sidecar'
import { contentPages, refresh, typeLabel } from '../store'
import WikiGraphCanvas from '../WikiGraphCanvas.vue'

const router = useRouter()
const graph = ref<{ nodes: any[]; edges: any[] }>({ nodes: [], edges: [] })
const counts = ref<any>(null)
const busy = ref(false)
const q = ref('')
const type = ref('')
const focus = ref('')

const missing = computed(() => graph.value.nodes.filter((n) => n.missing))
const hubs = computed(() =>
  graph.value.nodes
    .filter((n) => !n.missing)
    .slice()
    .sort((a, b) => (b.links ?? 0) - (a.links ?? 0))
    .slice(0, 9),
)
const filtered = computed(() => {
  let nodes = graph.value.nodes
  if (type.value) nodes = nodes.filter((n) => n.type === type.value)
  if (q.value.trim()) {
    const kw = q.value.trim().toLowerCase()
    const keep = new Set(nodes.filter((n) => n.label.toLowerCase().includes(kw)).map((n) => n.id))
    for (const e of graph.value.edges) {
      if (keep.has(e.source)) keep.add(e.target)
      if (keep.has(e.target)) keep.add(e.source)
    }
    nodes = graph.value.nodes.filter((n) => keep.has(n.id))
  }
  const ids = new Set(nodes.map((n) => n.id))
  return { nodes, edges: graph.value.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) }
})

async function load() {
  busy.value = true
  const r = await api.wikiGraph({ limit: 400 })
  busy.value = false
  if (!r.ok) return ElMessage.error(r.error ?? '读取失败')
  graph.value = { nodes: r.data.nodes ?? [], edges: r.data.edges ?? [] }
  counts.value = r.data.counts
}

function onOpen(node: any) {
  if (node.path) router.push(`/wiki/browse?path=${encodeURIComponent(node.path)}`)
  else ElMessage.info(`[[${node.label}]] 还没有页面 —— 体检页可以一键建骨架`)
}

onMounted(async () => {
  if (!contentPages.value.length) await refresh()
  await load()
})
</script>

<template>
  <div class="wk-cols" style="grid-template-columns: minmax(0, 1fr) minmax(190px, 230px)">
    <section class="wk-stack">
      <div class="wk-card se__strip">
        <div class="se__strip-main">
          <span class="wk-chip is-static">{{ counts?.nodes ?? 0 }} 节点</span>
          <span class="wk-chip is-static">{{ counts?.edges ?? 0 }} 条链接</span>
          <span v-if="counts?.missing" class="wk-chip wk-chip--warn">{{ counts.missing }} 个未建页</span>
        </div>
        <div class="se__strip-actions">
          <el-input v-model="q" size="small" placeholder="搜节点" clearable style="width: 150px" />
          <el-select v-model="type" size="small" placeholder="全部类型" clearable style="width: 120px">
            <el-option
              v-for="t in ['concept', 'entity', 'source', 'query', 'comparison', 'synthesis', 'overview', 'missing']"
              :key="t"
              :label="typeLabel(t)"
              :value="t"
            />
          </el-select>
          <el-button size="small" :loading="busy" @click="load">重画</el-button>
        </div>
      </div>
      <div class="wk-card gr__canvas">
        <WikiGraphCanvas v-if="filtered.nodes.length" :nodes="filtered.nodes" :edges="filtered.edges" :active="focus" @open="onOpen" />
        <div v-else class="wk-empty">没有可画的节点</div>
      </div>
    </section>

    <aside class="wk-stack">
      <section class="wk-card">
        <h3 class="wk-card__title" style="margin-bottom: 8px"><el-icon><Connection /></el-icon> 连接最多</h3>
        <ul class="wk-list">
          <li v-for="n in hubs" :key="n.id">
            <button class="wk-list__row" @mouseenter="focus = n.id" @mouseleave="focus = ''" @click="onOpen(n)">
              <span class="wk-list__main"><span class="wk-list__title">{{ n.label }}</span></span>
              <span class="wk-list__tail">{{ n.links }}</span>
            </button>
          </li>
        </ul>
      </section>
      <section v-if="missing.length" class="wk-card">
        <h3 class="wk-card__title" style="margin-bottom: 8px"><el-icon><Flag /></el-icon> 还没建的页</h3>
        <div class="wk-chips">
          <button
            v-for="n in missing.slice(0, 20)"
            :key="n.id"
            class="wk-chip wk-chip--warn"
            @mouseenter="focus = n.id"
            @mouseleave="focus = ''"
            @click="onOpen(n)"
          >
            {{ n.label }}
          </button>
        </div>
        <p class="wk-hint" style="margin-top: 8px">这些就是体检里的「死链」，可以一键建骨架。</p>
      </section>
    </aside>
  </div>
</template>

<style scoped>
.gr__canvas {
  padding: 10px;
}
.se__strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  justify-content: space-between;
}
.se__strip-main {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.se__strip-actions {
  display: flex;
  gap: 8px;
}
</style>
