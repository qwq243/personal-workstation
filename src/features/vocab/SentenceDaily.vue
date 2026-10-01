<script setup lang="ts">
/**
 * 英语学习 → 每日一句。
 * 练习本体是共用的 SentencePractice 卡片（与每日看板同一份，规则见 server/lib/english-daily.mjs）：
 * 指针做完才走，没做停留。这一页补上页面级信息：计划（剩余/预计完成）、打卡记录（每天做没做）、
 * 自评分布与「没读懂」的句子清单。
 */
import { computed, onMounted, ref, watch } from 'vue'
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
    await fetchAll()
  } finally {
    loading.value = false
  }
}

/** 只重取数据，不动 loading —— 打完卡刷新记录时用，免得整页闪骨架 */
async function fetchAll() {
  const [a, b, c] = await Promise.all([api.englishDaily(), api.englishDailyLog(35), api.englishDailyLibrary()])
  data.value = a.ok ? a.data : { ok: false, error: a.error ?? '加载失败' }
  log.value = b.ok ? b.data : null
  lib.value = c.ok ? c.data : null
}

/** 练习卡打完卡后回调：把打卡日历/统计/没读懂清单一起刷新（2026-09-29） */
async function refreshAfterRate() {
  await fetchAll()
  practice.value?.load?.()
}

const pct = computed(() => (data.value?.total ? Math.round((data.value.completedCount / data.value.total) * 100) : 0))
const stats = computed(() => lib.value?.stats ?? { good: 0, half: 0, lost: 0 })
const lostDays = computed<any[]>(() => (lib.value?.days ?? []).filter((d: any) => d.rating === 'lost'))
const logDays = computed<any[]>(() => log.value?.days ?? [])

/** 一天里的记录按时间排（列表与新→旧都用这个） */
function itemsByTime(d: any) {
  return [...(d.items ?? [])].sort((a: any, b: any) => (a.at ?? 0) - (b.at ?? 0))
}
/** 格子里一天练了哪句、什么评价 */
function cellTitle(d: any) {
  if (!d.done) return `${d.date} · 没练`
  return `${d.date} · ` + itemsByTime(d).map((it: any) => `Day${it.day} ${RATING_TEXT[it.rating] ?? ''}`).join('、')
}

/**
 * 色块着色 = 这一天**最后一次**自评。
 *
 * 原来用的是「一天里最差的一档」（没懂 > 半懂 > 读懂），2026-09-29 用户反馈
 * 「色块没有和我选择的对应」—— 当天练了三句（半懂 / 没懂 / 半懂），最后选的是半懂，
 * 格子却是红的，而且再练一句颜色也不动，看着就像「没更新」。
 * 换成「最后一次」之后：每评一次格子就跟着变，重练改好也会变绿。
 * 一天多句的完整明细在色块的浮层里（点开就能看到每一句各自的档位）。
 */
function cellCls(d: any) {
  if (!d.done) return 'is-empty'
  const items = itemsByTime(d)
  const last = items[items.length - 1]
  if (!last) return 'is-good'
  if (last.rating === 'lost') return 'is-lost'
  if (last.rating === 'half') return 'is-half'
  return 'is-good'
}

onMounted(load)

/* -------------------------------------------------- 今天练过的句子 ---
 * 一天可以刷很多句（打完卡指针前进），但练习卡永远只显示当前句 ——
 * 想回头看今天读过的就得去句子库翻。这里给一条滑动条：今天打卡过的句子
 * 按先后排开，拖到哪句就展示哪句（去重取当天最后一次评价），点卡片去句子库细看。 */
const todayItems = computed(() => {
  const today = log.value?.today
  const d = (log.value?.days ?? []).find((x: any) => x.date === today)
  if (!d?.items?.length) return []
  const byDay = new Map<number, any>()
  for (const it of itemsByTime(d)) byDay.set(it.day, it)
  return [...byDay.entries()].map(([day, it]) => {
    const info = (lib.value?.days ?? []).find((x: any) => x.day === day)
    return { day, rating: it.rating, text: info?.text ?? '', source: info?.source ?? '' }
  })
})
const reviewIdx = ref(1)
const review = computed(() => todayItems.value[reviewIdx.value - 1] ?? null)
/** 打完卡清单变长时滑块自动跟到最新一句 */
watch(
  () => todayItems.value.length,
  (n) => {
    reviewIdx.value = n || 1
  },
)

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
        <!-- 这一页是「打字练习」；纸面的那本（一句一页、点留白出译文、可导出 PDF）在做题本那边 -->
        <el-button title="一句一页的纸面版：点留白出译文，可导出 PDF" @click="router.push('/zuotiben/sentence')">
          <el-icon><EditPen /></el-icon>&nbsp;做题本版
        </el-button>
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
        <SentencePractice ref="practice" @rated="refreshAfterRate" />

        <!-- 今天练过的句子：滑动条回看（一天刷多句时不用去句子库翻） -->
        <div v-if="todayItems.length" class="ws-card block">
          <div class="block__head">
            <span class="block__title"><el-icon><Reading /></el-icon> 今天练过的句子</span>
            <span class="ws-dim">{{ todayItems.length }} 句 · 拖动回看</span>
          </div>
          <el-slider
            v-model="reviewIdx"
            :min="1"
            :max="todayItems.length"
            :show-tooltip="false"
            size="small"
          />
          <div class="rev__scale ws-dim">
            <span>第 1 句</span>
            <span>第 {{ todayItems.length }} 句 · 最新</span>
          </div>
          <div v-if="review" class="rev__item" @click="router.push(`/vocab/library?day=${review.day}`)">
            <div class="rev__head">
              <span class="rev__day">Day {{ review.day }}</span>
              <span class="rev__src ws-dim">{{ review.source }}</span>
              <span class="rev__rate" :class="`is-${review.rating}`">{{ RATING_TEXT[review.rating] ?? '' }}</span>
            </div>
            <div class="rev__text">{{ review.text }}</div>
            <div class="rev__go ws-dim">去句子库细看（原文 / 生词 / 解析 / 朗读）›</div>
          </div>
        </div>
      </div>

      <div class="col">
        <!-- 打卡记录 -->
        <div class="ws-card block">
          <div class="block__head">
            <span class="block__title"><el-icon><Calendar /></el-icon> 打卡记录</span>
            <span class="ws-dim">最近 35 天 · 每天做没做</span>
          </div>
          <!-- 色块可点：手机上 title 悬停根本看不见，点了要给得出「那天练了什么、什么评价」，
               并能直接跳到那句去重练（2026-09-29 用户反馈「应该要可以支持的」）。 -->
          <div class="cal">
            <el-popover
              v-for="d in logDays"
              :key="d.date"
              placement="top"
              trigger="click"
              :width="230"
              popper-class="cal__pop"
            >
              <template #reference>
                <button
                  type="button"
                  class="cal__cell"
                  :class="[cellCls(d), { 'is-today': d.date === log?.today }]"
                  :title="cellTitle(d)"
                  :aria-label="cellTitle(d)"
                />
              </template>
              <div class="cal__pop-head">{{ d.date }}{{ d.date === log?.today ? ' · 今天' : '' }}</div>
              <div v-if="!d.done" class="cal__pop-empty">这天没练。</div>
              <div v-else class="cal__pop-list">
                <button
                  v-for="it in itemsByTime(d)"
                  :key="it.day + '-' + (it.at ?? 0)"
                  type="button"
                  class="cal__pop-item"
                  @click="router.push(`/vocab/library?day=${it.day}`)"
                >
                  <span class="cal__pop-day">Day {{ it.day }}</span>
                  <span class="cal__pop-rate" :class="`is-${it.rating}`">{{ RATING_TEXT[it.rating] ?? it.rating }}</span>
                  <span class="ws-dim">去重练 ›</span>
                </button>
              </div>
            </el-popover>
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
  width: 100%;
  padding: 0;
  border-radius: 5px;
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
  cursor: pointer;
  /* 圆点/方块类按钮：别让点击有 300ms 延迟，也别继承按钮默认字体 */
  touch-action: manipulation;
  font: inherit;
  transition: transform 0.1s ease, box-shadow 0.12s ease;
}
.cal__cell:hover {
  transform: translateY(-1px);
}
.cal__cell:active {
  transform: translateY(0);
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
/* 点开色块的浮层：列出那天练了哪几句、什么评价，并可跳去重练 */
.cal__pop-head {
  font-size: 12px;
  font-weight: 650;
  margin-bottom: 6px;
}
.cal__pop-empty {
  font-size: 12px;
  color: var(--ws-text-3);
}
.cal__pop-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.cal__pop-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 6px;
  border: 0;
  border-radius: 6px;
  background: var(--ws-panel-2);
  font: inherit;
  font-size: 12px;
  color: var(--ws-text);
  cursor: pointer;
  text-align: left;
}
.cal__pop-item:hover {
  background: var(--ws-accent-soft);
}
.cal__pop-day {
  font-weight: 650;
}
.cal__pop-rate.is-good {
  color: var(--ws-success);
}
.cal__pop-rate.is-half {
  color: var(--ws-warn);
}
.cal__pop-rate.is-lost {
  color: var(--ws-danger);
}
.cal__pop-item .ws-dim {
  margin-left: auto;
}

/* 手机上把格子抬高一点：它现在是可点按钮（24px 手指不好点），42×30 才顺手 */
@media (max-width: 640px) {
  .cal__cell {
    height: 30px;
  }
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

/* 今天练过的句子：滑动条 + 当前选中的那张卡 */
.rev__scale {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  margin-top: -2px;
}
.rev__item {
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid var(--ws-border);
  border-radius: var(--ws-radius);
  background: var(--ws-panel-2);
  cursor: pointer;
  transition: border-color 0.14s ease;
}
.rev__item:hover {
  border-color: var(--ws-accent);
}
.rev__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 5px;
}
.rev__day {
  font-size: 12.5px;
  font-weight: 700;
}
.rev__src {
  font-size: 11px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rev__rate {
  margin-left: auto;
  flex: none;
  font-size: 11.5px;
  font-weight: 600;
}
.rev__rate.is-good { color: var(--ws-success); }
.rev__rate.is-half { color: var(--ws-warn); }
.rev__rate.is-lost { color: var(--ws-danger); }
.rev__text {
  font-size: 13px;
  line-height: 1.65;
  color: var(--ws-text-2);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.rev__go {
  font-size: 11px;
  margin-top: 6px;
}
</style>
