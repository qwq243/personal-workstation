<script setup lang="ts">
/**
 * 英语学习 → 句子库。
 * 句库全景（Day 1 到材料最后一天）：哪天练过、什么评价、当前指针停在哪；点开某句看全文（原句/词汇/结构/参考译文/语法），
 * 也能「再练一次」——重练只追加记录，不会动指针（指针归 complete 里的当前句规则管）。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PageHeader from '@/components/PageHeader.vue'
import { api } from '@/core/sidecar'
import { ElMessage } from 'element-plus'

const route = useRoute()
const router = useRouter()

const lib = ref<any>(null)
const loading = ref(true)
const filter = ref<'all' | 'undone' | 'done' | 'lost'>('all')
const detail = ref<any>(null)
const drawer = ref(false)
const submitting = ref(false)

const RATING_TEXT: Record<string, string> = { good: '读懂了', half: '半懂', lost: '没读懂' }
const RATING_LIST: { key: 'good' | 'half' | 'lost'; label: string }[] = [
  { key: 'good', label: '读懂了' },
  { key: 'half', label: '半懂' },
  { key: 'lost', label: '没读懂' },
]

async function load() {
  loading.value = true
  try {
    const r = await api.englishDailyLibrary()
    lib.value = r.ok ? r.data : { ok: false, error: r.error ?? '加载失败' }
  } finally {
    loading.value = false
  }
}

const days = computed<any[]>(() => lib.value?.days ?? [])
const filtered = computed(() => {
  if (filter.value === 'done') return days.value.filter((d) => d.done)
  if (filter.value === 'undone') return days.value.filter((d) => !d.done)
  if (filter.value === 'lost') return days.value.filter((d) => d.rating === 'lost')
  return days.value
})
const doneCount = computed(() => days.value.filter((d) => d.done).length)
const pct = computed(() => (lib.value?.total ? Math.round((doneCount.value / lib.value.total) * 100) : 0))

function rateCls(d: any) {
  if (!d.done) return 'is-undone'
  return `is-${d.rating ?? 'done'}`
}

async function open(day: number) {
  const r = await api.englishDailyDay(day)
  if (r.ok) {
    detail.value = r.data
    drawer.value = true
  } else {
    ElMessage.error(r.error ?? '打不开这一句')
  }
}

/** 再练一次：记录追加到当天日期，指针不动（这里永远不是指针前的当前句） */
async function reRate(key: 'good' | 'half' | 'lost') {
  if (!detail.value?.item || submitting.value) return
  submitting.value = true
  try {
    const r = await api.englishDailyComplete(detail.value.item.day, key)
    if (r.ok) {
      ElMessage.success(`Day ${detail.value.item.day} 又记了一次：${RATING_TEXT[key]}`)
      const d2 = await api.englishDailyDay(detail.value.item.day)
      if (d2.ok) detail.value = d2.data
      await load()
    } else {
      ElMessage.error(r.error ?? '记录失败')
    }
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  const f = String(route.query.filter ?? '')
  if (f === 'lost' || f === 'done' || f === 'undone') filter.value = f
  await load()
  const day = Number(route.query.day ?? 0)
  if (day) open(day)
})
</script>

<template>
  <div class="ws-page ws-page--wide">
    <PageHeader title="句子库" :subtitle="lib?.ok ? `${lib.source} · Day1–${lib.total} · 已完成 ${doneCount}` : '句库还没导入（见 docs/每日一句导入.md）'" icon="List">
      <template #actions>
        <el-radio-group v-model="filter" size="small">
          <el-radio-button value="all">全部</el-radio-button>
          <el-radio-button value="undone">未练</el-radio-button>
          <el-radio-button value="done">已练</el-radio-button>
          <el-radio-button value="lost">没读懂</el-radio-button>
        </el-radio-group>
        <el-button :loading="loading" @click="load"><el-icon><Refresh /></el-icon>&nbsp;刷新</el-button>
      </template>
    </PageHeader>

    <div class="ws-card prog">
      <div class="prog__row">
        <span>完成进度 <b>{{ doneCount }}</b> / {{ lib?.total ?? 105 }} 句</span>
        <span class="ws-dim">
          读懂 {{ lib?.stats?.good ?? 0 }} · 半懂 {{ lib?.stats?.half ?? 0 }} · 没懂 {{ lib?.stats?.lost ?? 0 }}
          <template v-if="lib?.pointer"> · 指针停在 Day {{ lib.pointer }}</template>
        </span>
      </div>
      <el-progress :percentage="pct" :stroke-width="10" :color="pct >= 70 ? 'var(--ws-success)' : pct >= 35 ? 'var(--ws-warn)' : 'var(--ws-accent)'" style="margin-top: 10px" />
    </div>

    <div v-if="!lib?.ok && !loading" class="ws-card pad">{{ lib?.error ?? '加载失败' }}</div>
    <div v-else-if="loading && !lib" class="ws-card pad"><el-skeleton :rows="6" animated /></div>
    <div v-else-if="!filtered.length" class="ws-card pad ws-dim">这个筛选下没有句子。</div>

    <div v-else class="grid">
      <div
        v-for="d in filtered"
        :key="d.day"
        class="cell"
        :class="[rateCls(d), { 'is-current': d.current }]"
        @click="open(d.day)"
      >
        <div class="cell__top">
          <span class="cell__day">Day {{ d.day }}</span>
          <span v-if="d.current" class="cell__now">当前</span>
          <span class="cell__state">{{ d.done ? RATING_TEXT[d.rating] ?? '已练' : '未练' }}</span>
        </div>
        <div class="cell__src ws-dim">{{ d.source }}</div>
        <div class="cell__text">{{ d.text }}</div>
      </div>
    </div>

    <!-- 单句详情 + 重练 -->
    <el-drawer v-model="drawer" size="640px" :title="detail?.item ? `Day ${detail.item.day} · ${detail.item.source}` : ''">
      <div v-if="detail?.item" class="dt">
        <p class="dt__text">{{ detail.item.text }}</p>

        <div v-if="detail.item.vocab.length" class="dt__vocab">
          <span v-for="(v, i) in detail.item.vocab" :key="i" class="dt__word">
            <b>{{ v.term || v.meaning }}</b><i v-if="v.pos"> {{ v.pos }}</i><span v-if="v.term && v.meaning"> {{ v.meaning }}</span>
          </span>
        </div>

        <div class="dt__sec">
          <div class="dt__label">参考译文</div>
          <div class="dt__ref">{{ detail.item.refTranslation || '—' }}</div>
        </div>
        <div v-if="detail.item.structure.length" class="dt__sec">
          <div class="dt__label">结构划分</div>
          <div class="dt__pre">{{ detail.item.structure.join('\n') }}</div>
        </div>
        <div v-if="detail.item.grammar.length" class="dt__sec">
          <div class="dt__label">语法重点</div>
          <div class="dt__pre">{{ detail.item.grammar.join('\n') }}</div>
        </div>

        <div class="dt__sec">
          <div class="dt__label">练习记录</div>
          <div v-if="!detail.records.length" class="ws-dim" style="font-size: 12.5px">还没练过这一句。</div>
          <div v-else class="dt__rec">
            <span v-for="(r, i) in detail.records" :key="i" class="dt__rec-item">
              {{ r.date }} · {{ RATING_TEXT[r.rating] ?? r.rating }}<template v-if="detail.item.day === detail.pointer"> — 这是当前句</template>
            </span>
          </div>
        </div>

        <div class="dt__rate">
          <span class="ws-dim" style="font-size: 12px">
            {{ detail.item.day === detail.pointer ? '就是当前句：选一档即打卡并前进' : '重练一次只追加记录，不动当前进度' }}
          </span>
          <div class="ws-row">
            <el-button
              v-for="r in RATING_LIST"
              :key="r.key"
              size="small"
              :type="r.key === 'good' ? 'primary' : 'default'"
              :loading="submitting"
              @click="reRate(r.key)"
            >
              {{ r.label }}
            </el-button>
          </div>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.pad {
  padding: 18px 20px;
}
.prog {
  padding: 14px 20px;
  margin-bottom: 16px;
}
.prog__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  font-size: 13.5px;
}
.prog__row b {
  color: var(--ws-accent);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(232px, 1fr));
  gap: 12px;
}
.cell {
  border: 1px solid var(--ws-border);
  border-radius: var(--ws-radius);
  background: var(--ws-panel);
  padding: 10px 12px 11px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-left-width: 3px;
  transition: border-color 0.14s ease, transform 0.14s ease;
}
.cell:hover {
  transform: translateY(-2px);
  border-color: var(--ws-accent);
}
.cell.is-undone {
  border-left-color: var(--ws-border-strong);
}
.cell.is-good {
  border-left-color: var(--ws-success);
}
.cell.is-half {
  border-left-color: var(--ws-warn);
}
.cell.is-lost {
  border-left-color: var(--ws-danger);
}
.cell.is-current {
  box-shadow: inset 0 0 0 1.5px var(--ws-accent);
  background: color-mix(in srgb, var(--ws-accent) 5%, var(--ws-panel));
}
.cell__top {
  display: flex;
  align-items: center;
  gap: 6px;
}
.cell__day {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--ws-text);
}
.cell__now {
  font-size: 10px;
  font-weight: 600;
  line-height: 15px;
  padding: 0 5px;
  border-radius: 999px;
  color: var(--ws-on-accent);
  background: var(--ws-accent);
}
.cell__state {
  margin-left: auto;
  font-size: 11px;
  color: var(--ws-text-3);
}
.cell.is-good .cell__state { color: var(--ws-success); }
.cell.is-half .cell__state { color: var(--ws-warn); }
.cell.is-lost .cell__state { color: var(--ws-danger); }
.cell__src {
  font-size: 11px;
}
.cell__text {
  font-size: 12px;
  line-height: 1.55;
  color: var(--ws-text-2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* 抽屉 */
.dt__text {
  margin: 0 0 10px;
  font-size: 14.5px;
  line-height: 1.75;
}
.dt__vocab {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  margin-bottom: 12px;
}
.dt__word {
  font-size: 12px;
  line-height: 1.5;
  padding: 1px 7px;
  border-radius: 5px;
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
  color: var(--ws-text-2);
}
.dt__word b {
  color: var(--ws-text);
}
.dt__word i {
  font-style: normal;
  font-size: 11px;
  color: var(--ws-text-3);
}
.dt__sec + .dt__sec {
  margin-top: 12px;
}
.dt__label {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--ws-text-3);
  letter-spacing: 0.04em;
  margin-bottom: 5px;
}
.dt__ref {
  font-size: 13.5px;
  line-height: 1.7;
  padding: 9px 12px;
  border-radius: var(--ws-radius-sm);
  background: var(--ws-accent-soft);
}
.dt__pre {
  font-size: 12.5px;
  line-height: 1.7;
  white-space: pre-line;
  color: var(--ws-text-2);
  padding: 6px 0 0 11px;
  border-left: 2px solid var(--ws-border);
}
.dt__rec {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dt__rec-item {
  font-size: 12.5px;
  color: var(--ws-text-2);
}
.dt__rate {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px dashed var(--ws-border);
}
</style>
