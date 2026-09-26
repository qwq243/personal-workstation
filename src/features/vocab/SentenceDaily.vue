<script setup lang="ts">
/**
 * 英语学习 → 每日一句。
 * 练习本体是共用的 SentencePractice 卡片（与每日看板同一份，规则见 server/lib/english-daily.mjs）：
 * 指针做完才走，没做停留。这一页补上页面级信息：计划（剩余/预计完成）、打卡记录（每天做没做）、
 * 自评分布与「没读懂」的句子清单。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageHeader from '@/components/PageHeader.vue'
import SentencePractice from '@/components/SentencePractice.vue'
import { api } from '@/core/sidecar'

const router = useRouter()
const data = ref<any>(null)
const log = ref<any>(null)
const lib = ref<any>(null)
const loading = ref(true)
const practice = ref<any>(null)

const RATING_TEXT: Record<string, string> = { good: '读懂', half: '半懂', lost: '没懂' }

async function load() {
  loading.value = true
  try {
    const [a, b, c] = await Promise.all([api.englishDaily(), api.englishDailyLog(35), api.englishDailyLibrary()])
    data.value = a.ok ? a.data : { ok: false, error: a.error ?? '加载失败' }
    log.value = b.ok ? b.data : null
    lib.value = c.ok ? c.data : null
  } finally {
    loading.value = false
  }
}

const pct = computed(() => (data.value?.total ? Math.round((data.value.completedCount / data.value.total) * 100) : 0))
const stats = computed(() => lib.value?.stats ?? { good: 0, half: 0, lost: 0 })
const lostDays = computed<any[]>(() => (lib.value?.days ?? []).filter((d: any) => d.rating === 'lost'))
const logDays = computed<any[]>(() => log.value?.days ?? [])

/** 格子里一天练了哪句、什么评价 */
function cellTitle(d: any) {
  if (!d.done) return `${d.date} · 没练`
  return `${d.date} · ` + d.items.map((it: any) => `Day${it.day} ${RATING_TEXT[it.rating] ?? ''}`).join('、')
}
/** 一天练了多句时按最差的一档着色（没懂 > 半懂 > 读懂） */
function cellCls(d: any) {
  if (!d.done) return 'is-empty'
  if (d.items.some((it: any) => it.rating === 'lost')) return 'is-lost'
  if (d.items.some((it: any) => it.rating === 'half')) return 'is-half'
  return 'is-good'
}

onMounted(load)
</script>

<template>
  <div class="ws-page ws-page--wide">
    <PageHeader
      title="每日一句"
      :subtitle="data?.ok ? `${data.source} · Day ${data.pointer} / ${data.total} · 做完才走，没做停留` : '句库还没导入（见 docs/每日一句导入.md）'"
      icon="Reading"
    >
      <template #actions>
        <el-button :loading="loading" @click="load"><el-icon><Refresh /></el-icon>&nbsp;刷新</el-button>
        <el-button type="primary" @click="router.push('/vocab/library')"><el-icon><List /></el-icon>&nbsp;句子库</el-button>
      </template>
    </PageHeader>

    <!-- 计划条 -->
    <div class="strip">
      <div class="strip__card strip__card--hero">
        <div class="strip__label">当前句子</div>
        <div class="strip__value">{{ data?.ok ? `Day ${data.pointer}` : '—' }}<i>/ {{ data?.total ?? 105 }}</i></div>
        <div class="strip__foot">{{ data?.todayDone ? '今天已打卡 ✓' : '今天还没练' }}</div>
      </div>
      <div class="strip__card">
        <div class="strip__label">已完成</div>
        <div class="strip__value">{{ data?.ok ? data.completedCount : '—' }}<i>句 · {{ pct }}%</i></div>
        <div class="strip__foot">读懂了 {{ stats.good }} · 半懂 {{ stats.half }} · 没懂 {{ stats.lost }}</div>
      </div>
      <div class="strip__card">
        <div class="strip__label">连续打卡</div>
        <div class="strip__value">{{ data?.ok ? data.streak : '—' }}<i>天</i></div>
        <div class="strip__foot">{{ data?.startedAt ? `从 ${data.startedAt} 开始` : '还没开始' }}</div>
      </div>
      <div class="strip__card">
        <div class="strip__label">预计完成</div>
        <div class="strip__value strip__value--date">{{ data?.ok ? data.plan.projectedFinish : '—' }}</div>
        <div class="strip__foot">每天一句 · 剩 {{ data?.plan?.remaining ?? '—' }} 句</div>
      </div>
    </div>

    <div class="cols">
      <div class="col">
        <SentencePractice ref="practice" />
      </div>

      <div class="col">
        <!-- 打卡记录 -->
        <div class="ws-card block">
          <div class="block__head">
            <span class="block__title"><el-icon><Calendar /></el-icon> 打卡记录</span>
            <span class="ws-dim">最近 35 天 · 每天做没做</span>
          </div>
          <div class="cal">
            <span
              v-for="d in logDays"
              :key="d.date"
              class="cal__cell"
              :class="[cellCls(d), { 'is-today': d.date === log?.today }]"
              :title="cellTitle(d)"
            />
          </div>
          <div class="cal__legend">
            <span><i class="dot dot--good" />读懂</span>
            <span><i class="dot dot--half" />半懂</span>
            <span><i class="dot dot--lost" />没懂</span>
            <span><i class="dot dot--empty" />没练</span>
          </div>
          <div class="cal__stat ws-dim">
            共打卡 {{ logDays.filter((d: any) => d.done).length }} / {{ logDays.length }} 天
            <template v-if="data?.startedAt"> · 最近一次 {{ data.todayDone ? data.today : data.startedAt }}</template>
          </div>
        </div>

        <!-- 没读懂的句子 -->
        <div class="ws-card block">
          <div class="block__head">
            <span class="block__title"><el-icon><Flag /></el-icon> 没读懂的句子</span>
            <span class="ws-dim">{{ lostDays.length }} 句</span>
          </div>
          <div v-if="!lostDays.length" class="muted-line">还没有标过「没读懂」的句子。</div>
          <div v-else class="lost">
            <div v-for="d in lostDays" :key="d.day" class="lost__item" @click="router.push(`/vocab/library?day=${d.day}`)">
              <span class="lost__day">Day {{ d.day }}</span>
              <span class="lost__src ws-dim">{{ d.source }}</span>
              <span class="lost__text">{{ d.text }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(158px, 1fr));
  gap: 12px;
  margin-bottom: 18px;
}
.strip__card {
  border: 1px solid var(--ws-border);
  border-radius: var(--ws-radius-lg);
  background: var(--ws-panel);
  padding: 14px 16px;
  box-shadow: var(--ws-shadow-sm);
}
.strip__card--hero {
  background: linear-gradient(158deg, color-mix(in srgb, var(--ws-accent) 10%, var(--ws-panel)), var(--ws-panel) 62%);
}
.strip__label {
  font-size: 12px;
  color: var(--ws-text-2);
}
.strip__value {
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.25;
  margin-top: 3px;
  color: var(--ws-accent);
  font-variant-numeric: tabular-nums;
}
.strip__value i {
  font-style: normal;
  font-size: 13px;
  font-weight: 500;
  color: var(--ws-text-3);
  letter-spacing: 0;
}
.strip__value--date {
  font-size: 20px;
  padding-top: 4px;
}
.strip__foot {
  font-size: 11.5px;
  color: var(--ws-text-3);
  margin-top: 2px;
}

.cols {
  display: grid;
  grid-template-columns: 1.35fr 1fr;
  gap: 18px;
  align-items: start;
}
@media (max-width: 1100px) {
  .cols {
    grid-template-columns: 1fr;
  }
}
.col {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
}
.block {
  padding: 16px 18px;
}
.block__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
}
.block__title {
  font-size: 14px;
  font-weight: 650;
  display: flex;
  align-items: center;
  gap: 7px;
}
.muted-line {
  color: var(--ws-text-3);
  font-size: 13px;
  padding: 6px 0;
}

/* 打卡格子：7 列 × 5 行（35 天），今天的格子带环 */
.cal {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 5px;
}
.cal__cell {
  height: 24px;
  border-radius: 5px;
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
}
.cal__cell.is-good {
  background: var(--ws-success-soft);
  border-color: color-mix(in srgb, var(--ws-success) 45%, var(--ws-border));
}
.cal__cell.is-half {
  background: var(--ws-warn-soft);
  border-color: color-mix(in srgb, var(--ws-warn) 45%, var(--ws-border));
}
.cal__cell.is-lost {
  background: var(--ws-danger-soft);
  border-color: color-mix(in srgb, var(--ws-danger) 45%, var(--ws-border));
}
.cal__cell.is-today {
  box-shadow: inset 0 0 0 1.5px var(--ws-accent);
}
.cal__legend {
  display: flex;
  gap: 12px;
  margin-top: 10px;
  font-size: 11.5px;
  color: var(--ws-text-2);
}
.cal__legend span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 3px;
  display: inline-block;
}
.dot--good { background: var(--ws-success-soft); border: 1px solid var(--ws-success); }
.dot--half { background: var(--ws-warn-soft); border: 1px solid var(--ws-warn); }
.dot--lost { background: var(--ws-danger-soft); border: 1px solid var(--ws-danger); }
.dot--empty { background: var(--ws-panel-2); border: 1px solid var(--ws-border); }
.cal__stat {
  margin-top: 8px;
  font-size: 11.5px;
}

.lost {
  display: flex;
  flex-direction: column;
}
.lost__item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 8px 0;
  cursor: pointer;
  border-top: 1px solid var(--ws-border);
}
.lost__item:first-child {
  border-top: none;
}
.lost__item:hover .lost__text {
  color: var(--ws-accent);
}
.lost__day {
  flex: none;
  font-size: 12px;
  font-weight: 650;
  color: var(--ws-danger);
}
.lost__src {
  flex: none;
  font-size: 11px;
}
.lost__text {
  font-size: 12.5px;
  color: var(--ws-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color 0.14s ease;
}
</style>
