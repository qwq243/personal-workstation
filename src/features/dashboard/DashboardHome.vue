<script setup lang="ts">
/**
 * 每日看板 · 今日。
 *
 * **开源版只带骨架**：这里的每一张卡都只依赖工作台自己的数据源
 * （看板的 dashboard.json、规划台的 plan.json、校历、模型用量）。
 * 课表 / 待办 / 早报那几张卡的数据源因人而异（各校接口 / 本机服务都不一样），已经整块摘掉 ——
 * 想要就把数据接回 `/api/overview`，再在这里加一张卡，写法照下面任意一张即可
 * （见 docs/ARCHITECTURE.md 的「看板是容器」一节）。
 *
 * 现在有的卡：
 *   ① 顶部 KPI：主线倒计时 / 今日模型花费 / 连续记录天数 / 今天（校历）
 *   ② 今天：计划（可勾选）+ 随手记
 *   ③ AI 总结卡：回顾 + 今天的建议（走 server/lib/summaries.mjs 的按天存档）
 *   ④ 近 7 天：计划完成数 / 记录数
 */
import { computed, onMounted, ref } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import SidecarOffline from '@/components/SidecarOffline.vue'
import MdLite from '@/components/MdLite.vue'
import { api, ensureSidecar } from '@/core/sidecar'

const ready = ref(false)
const loading = ref(true)
const overview = ref<any>(null)
const planPanel = ref<any>(null)
const day = ref<any>(null)
const mark = ref<any>(null)
const ai = ref<any>(null)
const recent = ref<any[]>([])

const newPlan = ref('')
const newNote = ref('')
const busy = ref('')
const aiBusy = ref(false)
const showContext = ref(false)
const contextText = ref('')

const TODAY = (() => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
})()

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

function weekdayOf(ds: string) {
  const w = ['日', '一', '二', '三', '四', '五', '六'][new Date(`${ds}T00:00:00`).getDay()]
  return `周${w}`
}

async function reloadDay() {
  const d = await api.day(TODAY)
  if (d.ok) day.value = d.data
}

async function load() {
  loading.value = true
  try {
    const [ov, pl, dy, sc, aiR, rd] = await Promise.all([
      api.overview(),
      api.planPanel(),
      api.day(TODAY),
      api.schoolCalendar(TODAY.slice(0, 7)),
      api.aiDaily(TODAY),
      api.recentDays(7),
    ])
    if (ov.ok) overview.value = ov.data
    if (pl.ok) planPanel.value = pl.data
    if (dy.ok) day.value = dy.data
    if (sc.ok) mark.value = sc.data?.days?.[TODAY] ?? null
    if (aiR.ok) ai.value = aiR.data
    if (rd.ok) recent.value = rd.data?.days ?? []
  } finally {
    loading.value = false
  }
}

async function init() {
  const ok = await ensureSidecar()
  ready.value = ok
  if (ok) await load()
}

async function addPlan() {
  const text = newPlan.value.trim()
  if (!text) return
  busy.value = 'plan'
  try {
    const r = await api.addPlan(text)
    if (r.ok) {
      newPlan.value = ''
      await reloadDay()
    } else ElMessage.error(r.error ?? '没加上')
  } finally {
    busy.value = ''
  }
}

async function togglePlan(p: any) {
  const r = await api.updatePlan(p.id, { done: !p.done })
  if (!r.ok) ElMessage.error(r.error ?? '改不动')
  else day.value = { ...(day.value ?? {}), plans: plans.value.map((x) => (x.id === p.id ? { ...x, done: !p.done } : x)) }
}

async function removePlan(p: any) {
  const r = await api.removePlan(p.id)
  if (!r.ok) ElMessage.error(r.error ?? '删不掉')
  else day.value = { ...(day.value ?? {}), plans: plans.value.filter((x) => x.id !== p.id) }
}

async function addNote() {
  const text = newNote.value.trim()
  if (!text) return
  busy.value = 'note'
  try {
    const r = await api.addNote(text)
    if (r.ok) {
      newNote.value = ''
      await reloadDay()
    } else ElMessage.error(r.error ?? '没记上')
  } finally {
    busy.value = ''
  }
}

async function removeNote(n: any) {
  const r = await api.removeNote(n.id)
  if (!r.ok) ElMessage.error(r.error ?? '删不掉')
  else day.value = { ...(day.value ?? {}), notes: notes.value.filter((x) => x.id !== n.id) }
}

async function genToday() {
  aiBusy.value = true
  try {
    const r = await api.aiToday(TODAY)
    if (r.ok) {
      ElMessage.success('已生成并存档')
      const d = await api.aiDaily(TODAY)
      if (d.ok) ai.value = d.data
    } else ElMessage.error(r.error ?? '生成失败（先在设置里配好模型端点与密钥）')
  } finally {
    aiBusy.value = false
  }
}

async function genReview() {
  aiBusy.value = true
  try {
    const r = await api.aiSummary(TODAY)
    if (r.ok) {
      ElMessage.success('已生成并存档')
      const d = await api.aiDaily(TODAY)
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
      <PageHeader title="今日" subtitle="看板 + 规划台 + 模型花费；要自接的数据源见 README" icon="Sunny">
        <template #actions>
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
              <template v-if="spend && !spend.error">¥{{ spend.totalYuan ?? 0 }}</template>
              <span v-else class="ws-dim">—</span>
            </div>
            <div class="kpi__d">
              <template v-if="spend?.error">{{ spend.error }}</template>
              <template v-else>{{ (spend?.items ?? []).length }} 个密钥有消耗</template>
            </div>
          </div>

          <div class="kpi">
            <div class="kpi__k">连续记录</div>
            <div class="kpi__v">{{ streak }}<small>天</small></div>
            <div class="kpi__d">有计划 / 记录 / 复盘就算一天</div>
          </div>

          <div class="kpi">
            <div class="kpi__k">今天</div>
            <div class="kpi__v kpi__v--sm">{{ schoolLine }}</div>
            <div class="kpi__d ws-mono">{{ TODAY }} {{ weekdayOf(TODAY) }}</div>
          </div>
        </div>

        <div class="grid">
          <!-- ==================================== ② 今天的计划与记录 -->
          <div class="col">
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

          <!-- ======================================== ③ AI 卡 + ④ 近 7 天 -->
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
                还没有总结。点「生成今天的建议」会结合你的计划、词单进度、校历与花费写 3 条行动建议；
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
