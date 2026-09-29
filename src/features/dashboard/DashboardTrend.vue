<script setup lang="ts">
/** 每日看板 · 趋势与记录（后台数据看板视角）。 */
import { computed, onMounted, ref } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import SidecarOffline from '@/components/SidecarOffline.vue'
import { api, ensureSidecar } from '@/core/sidecar'

const ready = ref(false)
const loading = ref(false)
const rows = ref<any[]>([])
const streak = ref(0)
const limit = ref(14)

const maxPlans = computed(() => Math.max(1, ...rows.value.map((r) => r.plans || 0)))
const activeDays = computed(() => rows.value.filter((r) => r.plans || r.notes || r.hasReview || r.mood != null).length)

async function load() {
  const ok = await ensureSidecar()
  ready.value = ok
  if (!ok) return
  loading.value = true
  try {
    const r = await api.recentDays(limit.value)
    if (r.ok) {
      rows.value = (r.data?.days ?? []).slice().reverse()
      streak.value = r.data?.streak ?? 0
    }
  } finally {
    loading.value = false
  }
}

function barWidth(n: number) {
  return `${Math.round(((n || 0) / maxPlans.value) * 100)}%`
}

onMounted(load)
</script>

<template>
  <div class="ws-page ws-page--wide">
    <SidecarOffline v-if="ready === false" what="趋势" @ready="load" />

    <template v-else>
      <PageHeader title="趋势与记录" subtitle="最近这些天在看板上留下了什么" icon="TrendCharts">
        <template #actions>
          <el-radio-group v-model="limit" size="small" @change="load">
            <el-radio-button :value="7">7 天</el-radio-button>
            <el-radio-button :value="14">14 天</el-radio-button>
            <el-radio-button :value="30">30 天</el-radio-button>
          </el-radio-group>
          <el-button :loading="loading" @click="load"><el-icon><Refresh /></el-icon>&nbsp;刷新</el-button>
        </template>
      </PageHeader>

      <div class="kpis">
        <div class="kpi">
          <div class="kpi__label">连续记录</div>
          <div class="kpi__value">{{ streak }}<small>天</small></div>
        </div>
        <div class="kpi">
          <div class="kpi__label">有记录的天数</div>
          <div class="kpi__value">{{ activeDays }}<small>/ {{ rows.length }}</small></div>
        </div>
        <div class="kpi">
          <div class="kpi__label">计划总数</div>
          <div class="kpi__value">{{ rows.reduce((s, r) => s + (r.plans || 0), 0) }}</div>
        </div>
        <div class="kpi">
          <div class="kpi__label">完成率</div>
          <div class="kpi__value">
            {{
              (() => {
                const t = rows.reduce((s, r) => s + (r.plans || 0), 0)
                const d = rows.reduce((s, r) => s + (r.plansDone || 0), 0)
                return t ? Math.round((d / t) * 100) + '%' : '—'
              })()
            }}
          </div>
        </div>
      </div>

      <div class="ws-card block">
        <div class="block__title">每日计划 / 完成</div>
        <div class="chart">
          <div v-for="r in rows" :key="r.date" class="chart__row">
            <div class="chart__date ws-mono">{{ r.date.slice(5) }}</div>
            <div class="chart__track">
              <div class="chart__bar" :style="{ width: barWidth(r.plans) }">
                <div class="chart__done" :style="{ width: r.plans ? `${(r.plansDone / r.plans) * 100}%` : '0%' }" />
              </div>
            </div>
            <div class="chart__nums ws-dim">{{ r.plansDone }}/{{ r.plans }}</div>
            <div class="chart__meta ws-dim">
              <span v-if="r.notes">{{ r.notes }} 条记录</span>
              <span v-if="r.mood" class="chart__mood">{{ '★'.repeat(r.mood) }}</span>
              <span v-if="r.hasReview" class="chart__review">有复盘</span>
            </div>
          </div>
          <div v-if="!rows.length" class="ws-dim" style="padding: 20px 0">还没有数据</div>
        </div>
      </div>

      <div class="ws-card block" style="margin-top: 18px">
        <div class="block__title">说明</div>
        <p class="note">
          这里只统计「看板自己记的东西」——计划、记录、复盘、心情。
          AI 总结与「本周一览」在「今日」页（AI 总结默认显示最近一次的那份）。
        </p>
        <p class="note">
          看板数据存在边车的 <code class="ws-mono">server/data/dashboard.json</code>，
          所以智能体也能通过 MCP 读取和写入同一份数据。
        </p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  margin-bottom: 18px;
}
.kpi {
  border: 1px solid var(--ws-border);
  border-radius: var(--ws-radius-lg);
  background: var(--ws-panel);
  padding: 14px 16px;
  box-shadow: var(--ws-shadow-sm);
}
.kpi__label {
  font-size: 12px;
  color: var(--ws-text-2);
}
.kpi__value {
  font-size: 25px;
  font-weight: 700;
  color: var(--ws-accent);
  line-height: 1.25;
  margin-top: 3px;
}
.kpi__value small {
  font-size: 13px;
  font-weight: 500;
  color: var(--ws-text-3);
  margin-left: 3px;
}
.block {
  padding: 16px 18px;
}
.block__title {
  font-size: 14px;
  font-weight: 650;
  margin-bottom: 14px;
}
.chart {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.chart__row {
  display: flex;
  align-items: center;
  gap: 11px;
  font-size: 12.5px;
}
.chart__date {
  flex: 0 0 42px;
  color: var(--ws-text-3);
}
.chart__track {
  flex: 1;
  height: 18px;
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
  border-radius: 5px;
  overflow: hidden;
  min-width: 60px;
}
.chart__bar {
  height: 100%;
  background: var(--ws-accent-soft);
  border-right: 1px solid var(--ws-border);
  transition: width 0.2s ease;
}
.chart__done {
  height: 100%;
  background: var(--ws-success);
  opacity: 0.75;
}
.chart__nums {
  flex: 0 0 38px;
  text-align: right;
  font-family: var(--ws-mono);
}
.chart__meta {
  flex: 0 0 132px;
  display: flex;
  gap: 8px;
  align-items: center;
  overflow: hidden;
}
.chart__mood {
  color: var(--ws-warn);
}
.chart__review {
  color: var(--ws-success);
}
.note {
  font-size: 13px;
  line-height: 1.75;
  color: var(--ws-text-2);
}
.note + .note {
  margin-top: 8px;
}
</style>
