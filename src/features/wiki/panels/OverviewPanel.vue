<script setup lang="ts">
/**
 * 库 · 概览面板：这个库现在长什么样（页面构成 / 最近记录 / 待办 / 最近改动）。
 * 数字与待办项都能点进对应位置 —— 概览不是只读仪表盘。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '@/core/sidecar'
import { contentPages, embedStatus, pendingRaw, refresh, status } from '../store'

const emit = defineEmits<{ (e: 'go', tab: string): void }>()
const router = useRouter()

const log = ref('')
const lint = ref<any>(null)
const loading = ref(false)

const TYPES = [
  { id: 'concept', label: '概念', hint: '想法、方法、现象、框架', color: '#4f46e5' },
  { id: 'entity', label: '实体', hint: '人、机构、作品、工具', color: '#16a34a' },
  { id: 'source', label: '来源', hint: '文章、论文、书、演讲', color: '#0ea5e9' },
  { id: 'query', label: '问题', hint: '正在追的开放问题', color: '#d97706' },
  { id: 'comparison', label: '比较', hint: '并排对照', color: '#7c3aed' },
  { id: 'synthesis', label: '综述', hint: '跨页结论', color: '#be185d' },
]
const cards = computed(() => {
  const by = status.value?.pages?.byType ?? {}
  // 六个类型都显示（含 0 的：它们是这份库的「构成」，0 也该让人看到）。
  // 宽度交给 .wk-stats 的 auto-fit 分（看板顶部那条 KPI 卡是同一套规则）。
  return TYPES.map((t) => ({ ...t, n: by[t.id] ?? 0 }))
})

const logTail = computed(() => {
  const out: string[] = []
  let seen = 0
  for (const l of log.value.split(/\r?\n/)) {
    if (/^##\s/.test(l)) seen += 1
    if (seen > 2) break
    if (l.trim()) out.push(l)
  }
  return out.slice(0, 22)
})

const recent = computed(() =>
  contentPages.value
    .slice()
    .sort((a: any, b: any) => String(b.mtime).localeCompare(String(a.mtime)))
    .slice(0, 7),
)

async function load() {
  loading.value = true
  if (!status.value) await refresh()
  const [lg, ln] = await Promise.all([api.wikiPage('wiki/log.md'), api.wikiLint()])
  loading.value = false
  log.value = lg.ok ? String(lg.data?.body ?? '') : ''
  lint.value = ln.ok ? ln.data : null
}

function openPage(path: string) {
  router.push(`/wiki/browse?path=${encodeURIComponent(path)}`)
}

onMounted(load)
defineExpose({ load })
</script>

<template>
  <div class="wk-stack">
    <div class="wk-stats">
      <button
        v-for="c in cards"
        :key="c.id"
        class="wk-stat"
        :style="{ '--wk-stat-color': c.color }"
        @click="emit('go', 'pages')"
      >
        <span class="wk-stat__label">{{ c.label }}</span>
        <span class="wk-stat__n">{{ c.n }}</span>
        <span class="wk-stat__hint">{{ c.hint }}</span>
      </button>
    </div>

    <div class="wk-cols wk-cols--2-1">
      <section class="wk-card">
        <div class="wk-card__head">
          <h3 class="wk-card__title"><el-icon><Clock /></el-icon> 最近入库记录</h3>
          <button class="wk-link" @click="openPage('wiki/log.md')">打开 log.md</button>
        </div>
        <pre class="ov__log">{{ logTail.join('\n') || '（log.md 还是空的）' }}</pre>
      </section>

      <div class="wk-stack">
        <section class="wk-card">
          <div class="wk-card__head">
            <h3 class="wk-card__title"><el-icon><Finished /></el-icon> 待办</h3>
          </div>
          <ul class="wk-list">
            <li class="wk-list__row">
              <span class="wk-chip" :class="pendingRaw.length ? 'wk-chip--warn' : ''">{{ pendingRaw.length }}</span>
              <span class="wk-list__main">份料还没编译</span>
              <button v-if="pendingRaw.length" class="wk-link" @click="router.push('/wiki/ingest')">去编译</button>
            </li>
            <li class="wk-list__row">
              <span class="wk-chip" :class="lint?.total ? 'wk-chip--warn' : ''">{{ lint?.total ?? 0 }}</span>
              <span class="wk-list__main">项结构问题</span>
              <button v-if="lint?.total" class="wk-link" @click="emit('go', 'review')">去体检</button>
            </li>
            <li class="wk-list__row">
              <span class="wk-chip">{{ embedStatus?.indexed ?? 0 }}/{{ embedStatus?.pages ?? 0 }}</span>
              <span class="wk-list__main">页有向量索引</span>
              <button class="wk-link" @click="emit('go', 'search')">语义检索</button>
            </li>
          </ul>
        </section>

        <section class="wk-card">
          <div class="wk-card__head">
            <h3 class="wk-card__title"><el-icon><EditPen /></el-icon> 最近改动</h3>
          </div>
          <ul class="wk-list">
            <li v-for="p in recent" :key="p.path">
              <button class="wk-list__row" @click="openPage(p.path)">
                <span class="wk-list__main">
                  <span class="wk-list__title">{{ p.title }}</span>
                </span>
                <span class="wk-list__tail">{{ String(p.mtime).slice(0, 10) }}</span>
              </button>
            </li>
          </ul>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ov__log {
  margin: 0;
  min-height: 220px;
  max-height: 420px;
  overflow: auto;
  font-family: var(--ws-mono);
  font-size: var(--ws-fs-xs);
  line-height: 1.9;
  color: var(--ws-text-2);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
