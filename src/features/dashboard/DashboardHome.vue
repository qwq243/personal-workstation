<script setup lang="ts">
/**
 * 每日看板 · 今日。
 *
 * 现在有的卡：
 *   ① 顶部 KPI：主线倒计时 / 今日模型花费 / 连续记录天数 / 今天（校历）
 *   ② 本周一览：这一周每天留了多少痕迹（计划完成 / 记录 / 复盘），点一天就切到那天
 *   ③ 每日一句：跟读 + 写译文 + 三档自评（打卡规则见 components/SentencePractice.vue）
 *   ④ 今天的计划（可勾选）与随手记
 *   ⑤ AI 总结卡：回顾 + 今天的建议（走 server/lib/summaries.mjs 的按天存档）
 *   ⑥ 近 7 天：计划完成数 / 记录数
 *
 * 开源版只依赖工作台自己的数据源（看板 dashboard.json、规划台 plan.json、校历、模型用量）。
 * 课表 / 待办 / 早报这类外部数据源因人而异，已经整块摘掉 —— 想要就把数据接回
 * `/api/overview`（或另开 `/api/*`），再在这里加一张卡，写法照下面任意一张即可
 * （见 docs/ARCHITECTURE.md 的「看板是容器」一节）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import PageHeader from '@/components/PageHeader.vue'
import SidecarOffline from '@/components/SidecarOffline.vue'
import MdLite from '@/components/MdLite.vue'
import SentencePractice from '@/components/SentencePractice.vue'
import { api, ensureSidecar } from '@/core/sidecar'

const router = useRouter()

const ready = ref(false)
const loading = ref(true)
/** overview 独立加载态：它是看板里最慢的一个请求（冷启动要出网拉余额）。
 *  快接口（day / calendar）先到先渲染，overview 没到就用骨架屏占位 —— 页面永远立即有响应。 */
const ovLoading = ref(true)

const p2 = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
const TODAY = ymd(new Date())
/** 当前在看哪天（默认今天）；点「本周一览」里的一格就切过去 */
const date = ref(TODAY)
const isToday = computed(() => date.value === TODAY)

const overview = ref<any>(null)
const planPanel = ref<any>(null)
const day = ref<any>(null)
const mark = ref<any>(null)
const ai = ref<any>(null)
const recent = ref<any[]>([])
/** 当月每天的记录摘要（date -> { plans, plansDone, notes, hasReview }），「本周一览」用 */
const cal = ref<Record<string, any>>({})

const newPlan = ref('')
const newNote = ref('')
const busy = ref('')
const aiBusy = ref(false)
const showContext = ref(false)
const contextText = ref('')

function weekdayOf(ds: string) {
  const w = ['日', '一', '二', '三', '四', '五', '六'][new Date(`${ds}T00:00:00`).getDay()]
  return `周${w}`
}

/** 今天上不上课 / 第几教学周：只读本机校历文件，不依赖任何外部服务 */
const schoolLine = computed(() => {
  const m = mark.value
  if (!m) return '校历还没配（见 docs/校历格式.md）'
  if (m.suspend) return `不上课${m.label ? `（${m.label}${m.tag ? `·${m.tag}` : ''}）` : ''}`
  return m.week ? `上课，教学第 ${m.week} 周${m.tag ? `（${m.tag}）` : ''}` : '不上课'
})

const hero = computed(() => planPanel.value?.hero?.[0] ?? null)
const plans = computed<any[]>(() => day.value?.plans ?? [])
const notes = computed<any[]>(() => day.value?.notes ?? [])
const spend = computed(() => overview.value?.spend ?? null)
const streak = computed(() => overview.value?.streak ?? 0)

/** AI 卡：今天的建议优先，没有就显示最近一份回顾 */
const aiText = computed(() => ai.value?.today?.content ?? ai.value?.review?.content ?? '')
const aiKind = computed(() =>
  ai.value?.today?.content ? '今天的建议' : ai.value?.review?.content ? '最近一次回顾' : '',
)

/* --------------------------------------------------------- 本周一览 ---
   看板不重复日历页的全部功能，但「这一周怎么过」是每天都要扫一眼的，所以给一条窄带：
   7 天 × （计划完成 / 记录 / 复盘），点任意一天就把看板切到那天。
   数据来自 /api/dashboard/calendar（**你自己留的痕迹**）—— 学校安排那套不在开源版里
   （校历只用来在 KPI 里说一句「今天上不上课」）。 */
const DOW = ['日', '一', '二', '三', '四', '五', '六']
function parseYmd(s: string) {
  return new Date(`${s}T00:00:00`)
}
function addDays(d: Date, n: number) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}
/** 本周的周一（周一为一周之首） */
function mondayOf(d: Date) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7))
  return x
}

const weekStrip = computed(() => {
  const mon = mondayOf(parseYmd(date.value))
  return Array.from({ length: 7 }, (_, i) => {
    const d = addDays(mon, i)
    const ds = ymd(d)
    const rec = cal.value[ds] ?? null
    return {
      date: ds,
      dow: DOW[d.getDay()],
      dayNum: d.getDate(),
      isToday: ds === TODAY,
      isSel: ds === date.value,
      plans: rec?.plans ?? 0,
      plansDone: rec?.plansDone ?? 0,
      notes: rec?.notes ?? 0,
      hasReview: !!rec?.hasReview,
    }
  })
})

/** 视图涉及的所有月份（一周可能跨月，如 8/31–9/6） */
const calMonths = computed(() => {
  const keys = new Set<string>([date.value.slice(0, 7)])
  for (const d of weekStrip.value) keys.add(d.date.slice(0, 7))
  return [...keys]
})

async function loadCalendar() {
  const rs = await Promise.all(calMonths.value.map((m) => api.dashboardCalendar(m)))
  const merged: Record<string, any> = { ...cal.value }
  for (const r of rs) if (r.ok) Object.assign(merged, r.data?.days ?? {})
  cal.value = merged
}

async function loadDay() {
  const [dy, sc] = await Promise.all([api.day(date.value), api.schoolCalendar(date.value.slice(0, 7))])
  if (dy.ok) day.value = dy.data
  if (sc.ok) mark.value = sc.data?.days?.[date.value] ?? null
  await loadCalendar()
}

async function load() {
  loading.value = true
  ovLoading.value = true
  try {
    const [pl, aiR, rd] = await Promise.all([
      api.planPanel(),
      api.aiDaily(date.value),
      api.recentDays(7),
    ])
    if (pl.ok) planPanel.value = pl.data
    if (aiR.ok) ai.value = aiR.data
    if (rd.ok) recent.value = rd.data?.days ?? []
  } finally {
    loading.value = false
  }
  // overview 单独走：它慢，别拖着上面的卡一起等
  void api.overview().then((ov) => {
    if (ov.ok) overview.value = ov.data
    ovLoading.value = false
  })
  await loadDay()
}

async function init() {
  const ok = await ensureSidecar()
  ready.value = ok
  if (ok) await load()
}

/** 切到某一天（点「本周一览」的格子） */
async function pickDate(ds: string) {
  if (ds === date.value) return
  date.value = ds
}

watch(date, async () => {
  await loadDay()
  const aiR = await api.aiDaily(date.value)
  if (aiR.ok) ai.value = aiR.data
})

/** 每日一句打卡后：色块与连续记录要跟着变（组件只知道自己那一句） */
async function onSentenceRated() {
  const [rd, ov] = await Promise.all([api.recentDays(7), api.overview()])
  if (rd.ok) recent.value = rd.data?.days ?? []
  if (ov.ok) overview.value = ov.data
  await loadCalendar()
}

async function addPlan() {
  const text = newPlan.value.trim()
  if (!text) return
  busy.value = 'plan'
  try {
    const r = await api.addPlan(text, date.value)
    if (r.ok) {
      newPlan.value = ''
      await loadDay()
    } else ElMessage.error(r.error ?? '没加上')
  } finally {
    busy.value = ''
  }
}

async function togglePlan(p: any) {
  const r = await api.updatePlan(p.id, { done: !p.done }, date.value)
  if (!r.ok) ElMessage.error(r.error ?? '改不动')
  else {
    day.value = { ...(day.value ?? {}), plans: plans.value.map((x) => (x.id === p.id ? { ...x, done: !p.done } : x)) }
    await loadCalendar()
  }
}

async function removePlan(p: any) {
  const r = await api.removePlan(p.id, date.value)
  if (!r.ok) ElMessage.error(r.error ?? '删不掉')
  else {
    day.value = { ...(day.value ?? {}), plans: plans.value.filter((x) => x.id !== p.id) }
    await loadCalendar()
  }
}

async function addNote() {
  const text = newNote.value.trim()
  if (!text) return
  busy.value = 'note'
  try {
    const r = await api.addNote(text, date.value)
    if (r.ok) {
      newNote.value = ''
      await loadDay()
    } else ElMessage.error(r.error ?? '没记上')
  } finally {
    busy.value = ''
  }
}

async function removeNote(n: any) {
  const r = await api.removeNote(n.id, date.value)
  if (!r.ok) ElMessage.error(r.error ?? '删不掉')
  else {
    day.value = { ...(day.value ?? {}), notes: notes.value.filter((x) => x.id !== n.id) }
    await loadCalendar()
  }
}

async function genToday() {
  aiBusy.value = true
  try {
    const r = await api.aiToday(date.value)
    if (r.ok) {
      ElMessage.success('已生成并存档')
      const d = await api.aiDaily(date.value)
      if (d.ok) ai.value = d.data
    } else ElMessage.error(r.error ?? '生成失败（先在设置里配好模型端点与密钥）')
  } finally {
    aiBusy.value = false
  }
}

async function genReview() {
  aiBusy.value = true
  try {
    const r = await api.aiSummary(date.value)
    if (r.ok) {
      ElMessage.success('已生成并存档')
      const d = await api.aiDaily(date.value)
      if (d.ok) ai.value = d.data
    } else ElMessage.error(r.error ?? '生成失败')
  } finally {
    aiBusy.value = false
  }
}

async function showAiContext() {
  const r = await api.aiContext()
  if (r.ok) {
    contextText.value = JSON.stringify(r.data, null, 2)
    showContext.value = true
  } else ElMessage.error(r.error ?? '读不到上下文')
}

onMounted(init)
</script>

<template>
  <div class="ws-page">
    <SidecarOffline v-if="ready === false" what="每日看板" @ready="init" />

    <template v-else>
      <PageHeader
        title="今日"
        :subtitle="isToday ? '看板 + 规划台 + 模型花费；要自接的数据源见 README' : `在看 ${date}（${weekdayOf(date)}）—— 点「回到今天」切回来`"
        icon="Sunny"
      >
        <template #actions>
          <el-button v-if="!isToday" size="small" @click="pickDate(TODAY)">回到今天</el-button>
          <el-button size="small" :loading="loading" @click="load">
            <el-icon><Refresh /></el-icon>&nbsp;刷新
          </el-button>
        </template>
      </PageHeader>

      <el-skeleton v-if="loading && !overview" :rows="6" animated />

      <template v-else>
        <!-- ============================================ ① 顶部 KPI -->
        <div class="ws-card kpi-row">
          <div class="kpi">
            <div class="kpi__k">主线倒计时</div>
            <template v-if="hero">
              <div class="kpi__v" :style="{ color: hero.daysLeft <= 30 ? 'var(--ws-danger)' : undefined }">
                {{ hero.daysLeft >= 0 ? hero.daysLeft : '—' }}<small>天</small>
              </div>
              <div class="kpi__d">{{ hero.name }} · {{ hero.date }}</div>
            </template>
            <template v-else>
              <div class="kpi__v ws-dim">—</div>
              <div class="kpi__d">去「规划台」加一条关键日期</div>
            </template>
          </div>

          <div class="kpi">
            <div class="kpi__k">今日模型花费</div>
            <div class="kpi__v">
              <el-skeleton v-if="ovLoading" :rows="1" animated style="max-width: 90px" />
              <template v-else-if="spend && !spend.error">¥{{ spend.totalYuan ?? 0 }}</template>
              <span v-else class="ws-dim">—</span>
            </div>
            <div class="kpi__d">
              <template v-if="spend?.error">{{ spend.error }}</template>
              <template v-else>{{ (spend?.items ?? []).length }} 个密钥有消耗</template>
            </div>
          </div>

          <div class="kpi">
            <div class="kpi__k">连续记录</div>
            <div class="kpi__v">
              <el-skeleton v-if="ovLoading" :rows="1" animated style="max-width: 70px" />
              <template v-else>{{ streak }}<small>天</small></template>
            </div>
            <div class="kpi__d">有计划 / 记录 / 复盘就算一天</div>
          </div>

          <div class="kpi">
            <div class="kpi__k">今天</div>
            <div class="kpi__v kpi__v--sm">{{ schoolLine }}</div>
            <div class="kpi__d ws-mono">{{ date }} {{ weekdayOf(date) }}</div>
          </div>
        </div>

        <!-- ======================================== ② 本周一览 -->
        <div class="ws-card block week">
          <div class="block__title block__title--row">
            <span>本周一览</span>
            <span class="block__actions">
              <span class="ws-dim" style="font-size: 12px">点一格 = 看那天</span>
              <el-button size="small" link @click="router.push('/calendar')">打开日历 ›</el-button>
            </span>
          </div>
          <div class="week__row">
            <button
              v-for="d in weekStrip"
              :key="d.date"
              class="week__cell"
              :class="{ 'is-sel': d.isSel, 'is-today': d.isToday, 'is-off': !d.plans && !d.notes }"
              type="button"
              @click="pickDate(d.date)"
            >
              <div class="week__dow">{{ d.dow === '日' ? '日' : d.dow }}</div>
              <div class="week__num">{{ d.dayNum }}</div>
              <div class="week__dots">
                <span v-if="d.plans" class="week__dot week__dot--plan" :title="`计划 ${d.plansDone}/${d.plans}`" />
                <span v-if="d.notes" class="week__dot week__dot--note" :title="`记录 ${d.notes}`" />
                <span v-if="d.hasReview" class="week__dot week__dot--review" title="有复盘" />
              </div>
              <div class="week__stat ws-dim">{{ d.plans ? `${d.plansDone}/${d.plans}` : d.notes ? `${d.notes}记` : '—' }}</div>
            </button>
          </div>
        </div>

        <div class="grid">
          <!-- ====================== ③ 每日一句 + ④ 今天的计划与记录 -->
          <div class="col">
            <SentencePractice more @rated="onSentenceRated" />

            <div class="ws-card block">
              <div class="block__title">今天的计划</div>
              <div class="add-row">
                <el-input v-model="newPlan" size="small" placeholder="今天要做的一件事…（Enter 添加）" @keydown.enter="addPlan" />
                <el-button size="small" type="primary" :loading="busy === 'plan'" @click="addPlan">加</el-button>
              </div>
              <div v-if="!plans.length" class="muted-line">还没有计划。</div>
              <div v-for="p in plans" :key="p.id" class="row">
                <el-checkbox :model-value="!!p.done" @change="togglePlan(p)" />
                <span class="row__text" :class="{ 'is-done': p.done }">{{ p.text }}</span>
                <el-button link size="small" @click="removePlan(p)">
                  <el-icon><Delete /></el-icon>
                </el-button>
              </div>
            </div>

            <div class="ws-card block">
              <div class="block__title">随手记</div>
              <div class="add-row">
                <el-input v-model="newNote" size="small" placeholder="想到什么记一句…（Enter 添加）" @keydown.enter="addNote" />
                <el-button size="small" :loading="busy === 'note'" @click="addNote">记</el-button>
              </div>
              <div v-if="!notes.length" class="muted-line">还没有记录。</div>
              <div v-for="n in notes" :key="n.id" class="row row--note">
                <span class="row__text">{{ n.text }}</span>
                <el-button link size="small" @click="removeNote(n)">
                  <el-icon><Delete /></el-icon>
                </el-button>
              </div>
            </div>
          </div>

          <!-- ======================================== ⑤ AI 卡 + ⑥ 近 7 天 -->
          <div class="col">
            <div class="ws-card block">
              <div class="block__title block__title--row">
                <span>
                  <el-icon><MagicStick /></el-icon>
                  AI 总结<template v-if="aiKind"> · {{ aiKind }}</template>
                </span>
                <span class="block__actions">
                  <el-button size="small" :loading="aiBusy" @click="genToday">生成今天的建议</el-button>
                  <el-button size="small" :disabled="aiBusy" @click="genReview">生成今日复盘</el-button>
                  <el-button size="small" link @click="showAiContext">看上下文</el-button>
                </span>
              </div>
              <div v-if="aiText" class="ai-body"><MdLite :text="aiText" /></div>
              <div v-else class="muted-line">
                还没有总结。点「生成今天的建议」会结合你的计划、英语进度、校历与花费写 3 条行动建议；
                生成过的会按天存下来，第二天还能回看。
              </div>
            </div>

            <div class="ws-card block">
              <div class="block__title">近 7 天</div>
              <div class="trend">
                <div v-for="d in recent" :key="d.date" class="trend__cell">
                  <div class="trend__bar">
                    <div
                      class="trend__fill"
                      :style="{ height: `${Math.min(100, (d.plans || 0) * 20 + (d.notes || 0) * 10)}%` }"
                    />
                  </div>
                  <div class="trend__label ws-dim">{{ d.date.slice(5) }}</div>
                  <div class="trend__num">{{ d.plansDone ?? 0 }}/{{ d.plans ?? 0 }}</div>
                </div>
              </div>
              <div class="ws-dim" style="font-size: 12px; margin-top: 8px">
                柱子高度 = 计划与记录条数；数字是「完成 / 计划」。完整的月度视图在「日历日程」页。
              </div>
            </div>
          </div>
        </div>
      </template>

      <el-drawer v-model="showContext" title="AI 看到的上下文" size="560px">
        <pre class="ctx">{{ contextText }}</pre>
      </el-drawer>
    </template>
  </div>
</template>

<style scoped>
.kpi-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 18px;
  padding: 16px 20px;
}
.kpi__k {
  font-size: 12px;
  color: var(--ws-text-3);
}
.kpi__v {
  font-size: 26px;
  font-weight: 650;
  line-height: 1.25;
  margin-top: 4px;
}
.kpi__v small {
  font-size: 13px;
  font-weight: 400;
  margin-left: 3px;
  color: var(--ws-text-2);
}
.kpi__v--sm {
  font-size: 15px;
  font-weight: 550;
}
.kpi__d {
  font-size: 12px;
  color: var(--ws-text-3);
  margin-top: 4px;
}

/* 本周一览：窄带，7 格等宽；格子里只放「这一天留了多少痕迹」 */
.week {
  margin-top: 16px;
  padding: 14px 18px 14px;
}
.week__row {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 6px;
}
.week__cell {
  appearance: none;
  border: 1px solid var(--ws-border);
  background: var(--ws-panel-2);
  border-radius: 8px;
  padding: 8px 4px 6px;
  cursor: pointer;
  text-align: center;
  color: inherit;
  font: inherit;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.week__cell:hover {
  border-color: var(--ws-accent);
}
.week__cell.is-sel {
  border-color: var(--ws-accent);
  background: var(--ws-accent-50);
}
.week__cell.is-today .week__num {
  color: var(--ws-accent);
}
.week__dow {
  font-size: 11px;
  color: var(--ws-text-3);
}
.week__num {
  font-size: 17px;
  font-weight: 600;
  line-height: 1.3;
}
.week__dots {
  display: flex;
  justify-content: center;
  gap: 3px;
  height: 8px;
  margin-top: 2px;
}
.week__dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  display: inline-block;
}
.week__dot--plan {
  background: var(--ws-accent);
}
.week__dot--note {
  background: var(--ws-ok);
}
.week__dot--review {
  background: var(--ws-warn);
}
.week__stat {
  font-size: 11px;
  margin-top: 2px;
}

.grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
  gap: 16px;
  margin-top: 16px;
}
@media (max-width: 1000px) {
  .grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
.col {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}
.block {
  padding: 14px 18px 16px;
}
.block__title {
  font-weight: 600;
  font-size: 13.5px;
  margin-bottom: 10px;
}
.block__title--row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.block__title--row > span:first-child {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.block__actions {
  display: inline-flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
}
.add-row {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}
.row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 3px 0;
  font-size: var(--ws-fs-sm);
}
.row__text {
  flex: 1;
  line-height: 1.7;
  word-break: break-word;
}
.row__text.is-done {
  text-decoration: line-through;
  color: var(--ws-text-3);
}
.row--note .row__text {
  color: var(--ws-text-2);
}
.muted-line {
  color: var(--ws-text-3);
  font-size: 12.5px;
  padding: 6px 0;
}

.ai-body {
  font-size: var(--ws-fs-sm);
  line-height: 1.8;
  max-height: 420px;
  overflow-y: auto;
}

.trend {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}
.trend__cell {
  flex: 1;
  text-align: center;
}
.trend__bar {
  height: 64px;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background: var(--ws-panel-2);
  border-radius: 4px;
  overflow: hidden;
}
.trend__fill {
  width: 100%;
  background: var(--ws-accent);
  opacity: 0.55;
  transition: height 0.2s ease;
}
.trend__label {
  font-size: 11px;
  margin-top: 4px;
}
.trend__num {
  font-size: 11.5px;
  color: var(--ws-text-2);
}

.ctx {
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--ws-mono);
  font-size: 11.5px;
  line-height: 1.65;
  margin: 0;
}
</style>
