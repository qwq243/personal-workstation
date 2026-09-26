<script setup lang="ts">
/**
 * 规划台 —— 长期目标一屏看完：关键日期倒计时 + 项目推进 + 备考清单。
 *
 * 和「每日看板」的分工：看板管今天这一天（课表、待办、计划、复盘），
 * 这里管这个学期要推进到哪：项目到几成、备考在哪个阶段、哪个截止快到了。
 *
 * 数据在服务端（server/data/plan.json），本页只是一个视图 —— 所以
 * 每日 03:00 的对话复盘把项目进度写进去之后，刷新一下就同步了。
 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import SidecarOffline from '@/components/SidecarOffline.vue'
import { api, ensureSidecar } from '@/core/sidecar'

/* ---------------------------------------------------------------- 类型 -- */

interface Step {
  id: string
  text: string
  done: boolean
}
interface Exam {
  id: string
  name: string
  date: string
  time?: string
  kind: 'exam' | 'deadline'
  pinned?: boolean
  official?: boolean
  prepId?: string
  note?: string
  source?: string
  daysLeft?: number | null
}
interface Project {
  id: string
  name: string
  priority: string
  status: string
  deadline: string
  progress: number
  stage: string
  note: string
  source?: string
  next: Step[]
  daysLeft?: number | null
}
interface Prep {
  id: string
  name: string
  examId: string
  stage: string
  note: string
  items: Step[]
  total: number
  done: number
  progress: number
  exam?: Exam | null
}

const STATUS_TEXT: Record<string, string> = { active: '推进中', waiting: '等反馈', paused: '暂停', done: '已完成' }
const PRIORITY_HINT: Record<string, string> = { P0: '最急', P1: '重要', P2: '常规', P3: '有空做' }

/* ---------------------------------------------------------------- 状态 -- */

const ready = ref(false)
const loading = ref(true)
const saving = ref(false)
const panel = ref<any>(null)
/** 读到的版本号，写回时带上：别处（另一个窗口 / 智能体）也改过就留 .conflict 副本 */
const baseRev = ref<number | undefined>(undefined)
/** 每分钟推一次：倒计时是现算的，跨天不用重启页面就会往下走 */
const tick = ref(0)
let timer: number | undefined

const projects = computed<Project[]>(() => panel.value?.projects ?? [])
const prep = computed<Prep[]>(() => panel.value?.prep ?? [])

/* -------------------------------------------------------- 日期与天数 -- */

const WD = '日一二三四五六'

/** 本地日历日的天数差：今天 = 0，明天 = 1，已过去为负。用 UTC 归一化，只比日历日 */
function daysLeft(date?: string): number | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const [y, m, d] = date.split('-').map(Number)
  const n = new Date()
  const a = Date.UTC(n.getFullYear(), n.getMonth(), n.getDate())
  const b = Date.UTC(y, m - 1, d)
  return Math.round((b - a) / 86400000)
}

function fmtDate(date?: string) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return '日期未定'
  const [y, m, d] = date.split('-').map(Number)
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} 周${WD[w]}`
}

function leftText(d: number | null) {
  if (d === null) return '日期未定'
  if (d < 0) return `已过 ${-d} 天`
  if (d === 0) return '就是今天'
  return `还有 ${d} 天`
}

/** 紧迫度分档 → 决定卡片用哪一档颜色 */
function tone(d: number | null) {
  if (d === null) return 'plain'
  if (d < 0) return 'over'
  if (d <= 7) return 'danger'
  if (d <= 30) return 'warn'
  return 'calm'
}

const heroCards = computed(() => {
  tick.value // 依赖它才会每分钟重算
  return (panel.value?.hero ?? []).map((e: Exam) => ({
    ...e,
    d: daysLeft(e.date),
    prep: prep.value.find((p) => p.id === e.prepId) ?? null,
  }))
})

const milestoneCards = computed(() => {
  tick.value
  return (panel.value?.milestones ?? []).map((e: Exam) => ({ ...e, d: daysLeft(e.date) }))
})

/** 项目：带截止的排前面，颜色按紧迫度 */
const projectCards = computed(() => {
  tick.value
  return projects.value.map((p) => ({ ...p, d: daysLeft(p.deadline), tone: tone(daysLeft(p.deadline)) }))
})

const activeCount = computed(() => projects.value.filter((p) => p.status !== 'done').length)
const openStepCount = computed(() => projects.value.reduce((n, p) => n + p.next.filter((s) => !s.done).length, 0))

/* ---------------------------------------------------------------- 加载 -- */

function apply(d: any) {
  if (!d) return
  panel.value = d
  if (d.meta) baseRev.value = d.meta.rev
  for (const s of d.prep ?? []) savedStage[s.id] = s.stage ?? ''
}

async function load() {
  loading.value = true
  const ok = await ensureSidecar()
  ready.value = ok
  if (ok) {
    const r = await api.planPanel()
    if (r.ok) apply(r.data)
    else ElMessage.error(r.error ?? '读不到规划台数据')
  }
  loading.value = false
}

/** 统一写入口：带上 baseRev，服务端会告诉我们有没有并发冲突 */
async function save(patch: Record<string, unknown>, okMsg?: string): Promise<boolean> {
  saving.value = true
  try {
    const r = await api.planSave({ ...patch, baseRev: baseRev.value, source: 'web' })
    if (!r.ok) {
      ElMessage.error(r.error ?? '保存失败')
      return false
    }
    apply(r.data)
    if (r.data?.conflict) {
      ElMessage.warning(`这个文件在别处也改过（磁盘 rev ${r.data.conflict.expected}），对方版本已另存为 .conflict 副本`)
    } else if (okMsg) {
      ElMessage.success(okMsg)
    }
    return true
  } finally {
    saving.value = false
  }
}

/* ------------------------------------------------------------ 项目操作 -- */

const stepDraft = reactive<Record<string, string>>({})

function patchProject(id: string, nextOf: (p: Project) => Step[]) {
  return projects.value.map((p) => (p.id === id ? { ...p, next: nextOf(p) } : p))
}

async function toggleStep(p: Project, s: Step) {
  await save({ projects: patchProject(p.id, (x) => x.next.map((n) => (n.id === s.id ? { ...n, done: !n.done } : n))) })
}

async function addStep(p: Project) {
  const text = (stepDraft[p.id] ?? '').trim()
  if (!text) return
  const okSaved = await save({
    projects: patchProject(p.id, (x) => [...x.next, { id: `ns_${Date.now().toString(36)}`, text, done: false }]),
  })
  if (okSaved) stepDraft[p.id] = ''
}

const projDlg = ref(false)
const projForm = reactive({
  id: '',
  name: '',
  priority: 'P1',
  status: 'active',
  deadline: '',
  progress: 0,
  stage: '',
  note: '',
})

function openProject(p?: Project) {
  if (p) {
    Object.assign(projForm, {
      id: p.id,
      name: p.name,
      priority: p.priority,
      status: p.status,
      deadline: p.deadline ?? '',
      progress: p.progress,
      stage: p.stage ?? '',
      note: p.note ?? '',
    })
  } else {
    Object.assign(projForm, { id: '', name: '', priority: 'P1', status: 'active', deadline: '', progress: 0, stage: '', note: '' })
  }
  projDlg.value = true
}

async function saveProject() {
  if (!projForm.name.trim()) {
    ElMessage.warning('项目名不能为空')
    return
  }
  const list = projects.value.map((p) => ({ ...p, next: p.next }))
  const i = list.findIndex((p) => p.id === projForm.id)
  const body = {
    name: projForm.name.trim(),
    priority: projForm.priority,
    status: projForm.status,
    deadline: projForm.deadline,
    progress: Number(projForm.progress) || 0,
    stage: projForm.stage,
    note: projForm.note,
  }
  if (i >= 0) list[i] = { ...list[i], ...body }
  else list.push({ ...body, id: `p_${Date.now().toString(36)}`, next: [], source: '规划台手动添加' } as Project)
  if (await save({ projects: list }, i >= 0 ? '已更新项目' : '已新增项目')) projDlg.value = false
}

async function removeProject() {
  try {
    await ElMessageBox.confirm(`删除项目「${projForm.name}」？它的下一步清单会一起没了，且不可撤销。`, '删除项目', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  if (await save({ projects: projects.value.filter((p) => p.id !== projForm.id) }, '已删除项目')) projDlg.value = false
}

/* ------------------------------------------------------------ 备考操作 -- */

const prepDraft = reactive<Record<string, string>>({})
const savedStage = reactive<Record<string, string>>({})

function patchPrep(id: string, nextOf: (s: Prep) => Step[]) {
  return prep.value.map((s) => (s.id === id ? { ...s, items: nextOf(s) } : s))
}

async function toggleItem(s: Prep, it: Step) {
  await save({ prep: patchPrep(s.id, (x) => x.items.map((n) => (n.id === it.id ? { ...n, done: !n.done } : n))) })
}

async function removeItem(s: Prep, it: Step) {
  await save({ prep: patchPrep(s.id, (x) => x.items.filter((n) => n.id !== it.id)) }, '已删除该条目')
}

async function addItem(s: Prep) {
  const text = (prepDraft[s.id] ?? '').trim()
  if (!text) return
  const okSaved = await save({
    prep: patchPrep(s.id, (x) => [...x.items, { id: `ns_${Date.now().toString(36)}`, text, done: false }]),
  })
  if (okSaved) prepDraft[s.id] = ''
}

/** 阶段是输入框，失焦/回车才写；没改就不写，免得白抬 rev */
async function saveStage(s: Prep) {
  if ((savedStage[s.id] ?? '') === (s.stage ?? '')) return
  await save({ prep: prep.value }, '已更新阶段')
}

/* -------------------------------------------------------- 关键日期操作 -- */

const examDlg = ref(false)
const examForm = reactive({
  id: '',
  name: '',
  date: '',
  time: '',
  kind: 'deadline' as 'exam' | 'deadline',
  pinned: false,
  official: true,
  note: '',
})

function openExam(e?: Exam) {
  if (e) {
    Object.assign(examForm, {
      id: e.id,
      name: e.name,
      date: e.date,
      time: e.time ?? '',
      kind: e.kind,
      pinned: !!e.pinned,
      official: !!e.official,
      note: e.note ?? '',
    })
  } else {
    Object.assign(examForm, { id: '', name: '', date: '', time: '', kind: 'deadline', pinned: false, official: true, note: '' })
  }
  examDlg.value = true
}

async function saveExam() {
  if (!examForm.name.trim()) {
    ElMessage.warning('名称不能为空')
    return
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(examForm.date)) {
    ElMessage.warning('日期要写成 YYYY-MM-DD')
    return
  }
  const list = (panel.value?.exams ?? []).map((e: Exam) => ({ ...e }))
  const i = list.findIndex((e: Exam) => e.id === examForm.id)
  const body = { ...examForm, name: examForm.name.trim() }
  if (i >= 0) list[i] = { ...list[i], ...body }
  else list.push({ ...body, id: `exam_${Date.now().toString(36)}`, source: '规划台手动添加' } as Exam)
  if (await save({ exams: list }, '已保存时间点')) examDlg.value = false
}

async function removeExam() {
  try {
    await ElMessageBox.confirm(`删除时间点「${examForm.name}」？`, '删除时间点', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  if (await save({ exams: (panel.value?.exams ?? []).filter((e: Exam) => e.id !== examForm.id) }, '已删除时间点')) {
    examDlg.value = false
  }
}

const savedAt = computed(() => {
  const t = panel.value?.meta?.updatedAt
  if (!t) return '还没写入过（当前显示的是初始种子数据）'
  return `${new Date(t).toLocaleString('zh-CN')}${panel.value?.meta?.savedBy ? ` · 由 ${panel.value.meta.savedBy} 写入` : ''}`
})

onMounted(() => {
  load()
  timer = window.setInterval(() => {
    tick.value += 1
  }, 60000)
  // 页面被切到后台再回来时补一次，避免跨天看的是旧数字
  document.addEventListener('visibilitychange', onVisible)
})
onUnmounted(() => {
  if (timer) window.clearInterval(timer)
  document.removeEventListener('visibilitychange', onVisible)
})
function onVisible() {
  if (!document.hidden) {
    tick.value += 1
  }
}

/** 进度条的 tooltip 文案（放 script 里，模板里就不写内联箭头函数了） */
function pctText(v: number) {
  return `${v}%`
}
</script>

<template>
  <div class="ws-page ws-page--wide">
    <PageHeader title="规划台" subtitle="长期目标：项目推进 + 备考清单 + 关键日期倒计时" icon="Flag">
      <template #actions>
        <el-button :loading="loading" @click="load"><el-icon><Refresh /></el-icon>&nbsp;刷新</el-button>
        <el-button :loading="saving" @click="openExam()"><el-icon><Timer /></el-icon>&nbsp;加时间点</el-button>
        <el-button type="primary" :loading="saving" @click="openProject()"><el-icon><Plus /></el-icon>&nbsp;新增项目</el-button>
      </template>
    </PageHeader>

    <SidecarOffline v-if="!loading && !ready" what="规划台" @ready="load" />
    <el-skeleton v-else-if="loading && !panel" :rows="8" animated />

    <template v-else-if="panel">
      <!-- ================================================ 倒计时 -->
      <section class="cd">
        <article v-for="e in heroCards" :key="e.id" class="cdcard" :class="`is-${tone(e.d)}`">
          <header class="cdcard__head">
            <span class="cdcard__name">{{ e.name }}</span>
            <div class="ws-row" style="gap: 4px">
              <el-tag v-if="!e.official" size="small" type="warning" effect="plain">推算</el-tag>
              <el-button link size="small" title="改日期 / 名称" @click="openExam(e)">
                <el-icon><EditPen /></el-icon>
              </el-button>
            </div>
          </header>

          <div class="cdcard__num">
            <template v-if="e.d === null">
              <span class="cdcard__days">—</span>
            </template>
            <template v-else-if="e.d < 0">
              <span class="cdcard__days">{{ -e.d }}</span><span class="cdcard__unit">天前</span>
            </template>
            <template v-else>
              <span class="cdcard__days">{{ e.d }}</span><span class="cdcard__unit">天</span>
            </template>
          </div>
          <div class="cdcard__date">{{ fmtDate(e.date) }}<span v-if="e.time" class="ws-dim"> · {{ e.time }}</span></div>

          <div v-if="e.prep" class="cdcard__prog">
            <div class="bar"><i :style="{ width: `${e.prep.progress}%` }" /></div>
            <div class="cdcard__prog-text">
              <span class="ws-muted">{{ e.prep.stage || '还没定阶段' }}</span>
              <span class="ws-dim">{{ e.prep.done }}/{{ e.prep.total }}</span>
            </div>
          </div>

          <div v-if="e.note" class="cdcard__note ws-dim">{{ e.note }}</div>
        </article>

        <aside class="milestones">
          <div class="milestones__head">
            <span>其他关键时间点</span>
            <span class="ws-dim">左侧是天数</span>
          </div>
          <div v-if="!milestoneCards.length" class="muted-line">还没有。考试报名截止、面试这类日期都可以放这儿。</div>
          <div
            v-for="e in milestoneCards"
            :key="e.id"
            class="mile"
            :class="`is-${tone(e.d)}`"
          >
            <div class="mile__left">
              <template v-if="e.d === null">—</template>
              <template v-else-if="e.d < 0">{{ -e.d }}</template>
              <template v-else>{{ e.d }}</template>
              <span class="mile__unit">天</span>
            </div>
            <div class="mile__body">
              <div class="mile__name">
                <span class="mile__label">{{ e.name }}</span>
                <el-tag v-if="e.kind === 'deadline'" size="small" type="warning" effect="plain" class="mile__tag">截止</el-tag>
              </div>
              <div class="mile__date ws-dim">{{ fmtDate(e.date) }}{{ e.time ? ` ${e.time}` : '' }}</div>
            </div>
            <div class="ws-row mile__ops">
              <el-tooltip content="编辑名称 / 日期 / 是否放到主卡">
                <el-button link size="small" @click="openExam(e)"><el-icon><EditPen /></el-icon></el-button>
              </el-tooltip>
            </div>
          </div>
        </aside>
      </section>

      <!-- ================================================ 项目推进 -->
      <section class="ws-card block block--tint">
        <div class="block__head">
          <span class="block__title"><el-icon><TrendCharts /></el-icon> 项目推进</span>
          <span class="ws-dim">{{ activeCount }} 个在推进 · 共 {{ projects.length }} 个 · 待办 {{ openStepCount }} 条</span>
        </div>

        <div v-if="!projects.length" class="muted-line">还没有项目。点右上角「新增项目」，或让智能体从每日复盘里写进来。</div>
        <div v-else class="pgrid">
          <article v-for="p in projectCards" :key="p.id" class="proj" :class="[`is-${p.tone}`, { 'is-done': p.status === 'done' }]">
            <header class="proj__head">
              <span class="pri" :class="`pri--${p.priority}`" :title="PRIORITY_HINT[p.priority]">{{ p.priority }}</span>
              <span class="proj__name">{{ p.name }}</span>
              <el-button link size="small" @click="openProject(p)"><el-icon><EditPen /></el-icon></el-button>
            </header>

            <div class="proj__meta">
              <span class="status" :class="`status--${p.status}`">{{ STATUS_TEXT[p.status] ?? p.status }}</span>
              <span v-if="p.deadline" class="due">{{ p.deadline }} · {{ leftText(p.d) }}</span>
              <span v-else class="ws-dim">无硬截止</span>
            </div>

            <div class="proj__bar">
              <div class="bar"><i :style="{ width: `${p.progress}%` }" /></div>
              <span class="proj__pct">{{ p.progress }}%</span>
            </div>

            <div v-if="p.stage" class="proj__stage">{{ p.stage }}</div>
            <div v-if="p.note" class="proj__note ws-dim">{{ p.note }}</div>

            <ul v-if="p.next.length" class="steps">
              <li v-for="s in p.next" :key="s.id" class="step" :class="{ 'is-done': s.done }">
                <el-checkbox size="small" :model-value="s.done" @change="toggleStep(p, s)" />
                <span class="step__text">{{ s.text }}</span>
              </li>
            </ul>
            <div v-else class="muted-line muted-line--tight">还没有下一步。</div>

            <div class="add-row">
              <el-input
                v-model="stepDraft[p.id]"
                size="small"
                placeholder="加一条下一步，回车提交"
                @keyup.enter="addStep(p)"
              />
              <el-button size="small" @click="addStep(p)"><el-icon><Plus /></el-icon></el-button>
            </div>
          </article>
        </div>
      </section>

      <!-- ================================================ 备考 -->
      <section class="prep">
        <article v-for="s in prep" :key="s.id" class="ws-card block prep__card">
          <div class="block__head">
            <span class="block__title"><el-icon><Reading /></el-icon> {{ s.name }}备考</span>
            <span class="ws-dim">{{ s.done }}/{{ s.total }} 项</span>
          </div>

          <div v-if="s.exam" class="prep__cd">
            <span class="prep__cd-num">{{ leftText(daysLeft(s.exam.date)) }}</span>
            <span class="ws-dim">｜{{ s.exam.name }} · {{ s.exam.date }}</span>
          </div>

          <div class="prep__stage">
            <span class="prep__stage-label">当前阶段</span>
            <el-input v-model="s.stage" size="small" placeholder="如：基础一轮（数学）" @blur="saveStage(s)" @keyup.enter="saveStage(s)" />
          </div>

          <div class="bar bar--wide"><i :style="{ width: `${s.progress}%` }" /></div>

          <ul class="steps steps--prep">
            <li v-for="it in s.items" :key="it.id" class="step" :class="{ 'is-done': it.done }">
              <el-checkbox size="small" :model-value="it.done" @change="toggleItem(s, it)" />
              <span class="step__text">{{ it.text }}</span>
              <el-button link size="small" class="step__del" @click="removeItem(s, it)"><el-icon><Close /></el-icon></el-button>
            </li>
          </ul>
          <div v-if="!s.items.length" class="muted-line muted-line--tight">清单还是空的。</div>

          <div class="add-row">
            <el-input v-model="prepDraft[s.id]" size="small" placeholder="加一条备考任务，回车提交" @keyup.enter="addItem(s)" />
            <el-button size="small" @click="addItem(s)"><el-icon><Plus /></el-icon></el-button>
          </div>

          <div v-if="s.note" class="prep__note ws-dim">{{ s.note }}</div>
        </article>
      </section>

      <div class="foot ws-dim">
        数据存本机 <code>server/data/plan.json</code>（rev {{ panel.meta.rev }}，{{ savedAt }}）。
        每日 03:00 的对话复盘会把它整理出的项目进度写进这里；MCP 的 get_plan / update_project / update_prep /
        set_goal_date 读写的是同一份，所以面板和智能体永远看同一个数。带「推算」标记的日期是按历年惯例算的，官方一发通知就改掉它。
      </div>
    </template>

    <!-- ================================================ 时间点弹窗 -->
    <el-dialog v-model="examDlg" :title="examForm.id ? '编辑时间点' : '新增时间点'" width="480px">
      <el-form label-width="82px" label-position="left">
        <el-form-item label="名称">
          <el-input v-model="examForm.name" placeholder="如：报名截止 / 初试" />
        </el-form-item>
        <el-form-item label="日期">
          <el-date-picker v-model="examForm.date" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" style="width: 100%" />
        </el-form-item>
        <el-form-item label="时间">
          <el-input v-model="examForm.time" placeholder="可留空，如 09:00" />
        </el-form-item>
        <el-form-item label="类型">
          <el-radio-group v-model="examForm.kind">
            <el-radio-button value="exam">考试</el-radio-button>
            <el-radio-button value="deadline">截止</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="展示">
          <el-checkbox v-model="examForm.pinned">作为主卡（大数字）显示</el-checkbox>
        </el-form-item>
        <el-form-item label="数据来源">
          <el-checkbox v-model="examForm.official">官方公告值（不勾 = 推算值，会提示「推算」）</el-checkbox>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="examForm.note" type="textarea" :rows="2" placeholder="口径说明，会显示在卡片底部" />
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="dlg-foot">
          <el-button v-if="examForm.id" type="danger" plain :loading="saving" @click="removeExam">删除</el-button>
          <div class="ws-spacer" />
          <el-button @click="examDlg = false">取消</el-button>
          <el-button type="primary" :loading="saving" @click="saveExam">保存</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- ================================================ 项目弹窗 -->
    <el-dialog v-model="projDlg" :title="projForm.id ? '编辑项目' : '新增项目'" width="520px">
      <el-form label-width="82px" label-position="left">
        <el-form-item label="项目名">
          <el-input v-model="projForm.name" placeholder="如：图书馆比赛" />
        </el-form-item>
        <el-form-item label="优先级">
          <el-radio-group v-model="projForm.priority">
            <el-radio-button v-for="p in ['P0', 'P1', 'P2', 'P3']" :key="p" :value="p">{{ p }}</el-radio-button>
          </el-radio-group>
          <span class="form-hint ws-dim">{{ PRIORITY_HINT[projForm.priority] }}</span>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="projForm.status" style="width: 100%">
            <el-option v-for="(text, key) in STATUS_TEXT" :key="key" :label="text" :value="key" />
          </el-select>
        </el-form-item>
        <el-form-item label="截止">
          <el-date-picker
            v-model="projForm.deadline"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="没有硬截止就留空"
            clearable
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="进度">
          <el-slider v-model="projForm.progress" :step="5" :format-tooltip="pctText" />
        </el-form-item>
        <el-form-item label="当前阶段">
          <el-input v-model="projForm.stage" placeholder="一句话，如：上线前清 bug" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="projForm.note" type="textarea" :rows="2" placeholder="约定、口径、卡点" />
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="dlg-foot">
          <el-button v-if="projForm.id" type="danger" plain :loading="saving" @click="removeProject">删除</el-button>
          <div class="ws-spacer" />
          <el-button @click="projDlg = false">取消</el-button>
          <el-button type="primary" :loading="saving" @click="saveProject">保存</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* ---------------------------------------------------------- 倒计时区 -- */
.cd {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr)) 300px;
  gap: 16px;
  margin-bottom: 18px;
}
@media (max-width: 1180px) {
  .cd {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .milestones {
    grid-column: 1 / -1;
    max-height: none;
  }
}
@media (max-width: 720px) {
  .cd {
    grid-template-columns: 1fr;
  }
}

/* 主卡：左侧色条 + 同色系斜向淡底，用 -soft 令牌做「色温」，深浅色主题都成立 */
.cdcard {
  --cd: var(--ws-accent);
  --cd-soft: var(--ws-accent-soft);
  position: relative;
  background: linear-gradient(158deg, var(--cd-soft) 0%, var(--ws-panel) 58%);
  border: 1px solid var(--ws-border);
  border-radius: var(--ws-radius-lg);
  box-shadow: var(--ws-shadow-2);
  padding: 20px 22px 18px;
  overflow: hidden;
  transition: transform 0.18s ease, box-shadow 0.18s ease;
}
.cdcard::before {
  content: '';
  position: absolute;
  left: 0;
  top: 18px;
  bottom: 18px;
  width: 4px;
  border-radius: 0 var(--ws-radius-pill) var(--ws-radius-pill) 0;
  background: var(--cd);
}
.cdcard:hover {
  transform: translateY(-3px);
  box-shadow: var(--ws-shadow-3);
}
.cdcard.is-warn {
  --cd: var(--ws-warn);
  --cd-soft: var(--ws-warn-soft);
}
.cdcard.is-danger {
  --cd: var(--ws-danger);
  --cd-soft: var(--ws-danger-soft);
}
.cdcard.is-over,
.cdcard.is-plain {
  --cd: var(--ws-text-3);
  --cd-soft: var(--ws-panel-2);
}

.cdcard__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.cdcard__name {
  font-size: 17px;
  font-weight: 680;
  letter-spacing: -0.012em;
  line-height: 1.4;
}
.cdcard__num {
  display: flex;
  align-items: baseline;
  gap: 7px;
  margin: 12px 0 3px;
}
.cdcard__days {
  font-size: 54px;
  line-height: 1;
  font-weight: 750;
  letter-spacing: -0.04em;
  color: var(--cd);
  font-variant-numeric: tabular-nums;
}
.cdcard__unit {
  font-size: var(--ws-fs-sm);
  font-weight: 500;
  color: var(--ws-text-3);
}
.cdcard__date {
  font-size: var(--ws-fs-sm);
  color: var(--ws-text-2);
  font-variant-numeric: tabular-nums;
}
.cdcard__prog {
  margin-top: 16px;
}
.cdcard__prog-text {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: var(--ws-fs-xs);
  margin-top: 7px;
}
/* 卡内进度条跟着紧迫度走色，和左侧色条同源 */
.cdcard .bar i {
  background: var(--cd);
}
.cdcard__note {
  font-size: var(--ws-fs-xs);
  line-height: 1.7;
  margin-top: 14px;
  padding: 8px 10px;
  border-radius: var(--ws-radius-sm);
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
}

/* -------------------------------------------------------- 小时间点列表 -- */
/* 靠网格默认 stretch 撑到和主卡同高，底边对齐；条目多了再靠 max-height 滚动 */
.milestones {
  background: var(--ws-panel);
  border: 1px solid var(--ws-border);
  border-radius: var(--ws-radius-lg);
  box-shadow: var(--ws-shadow-1);
  padding: 14px 14px 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 340px;
  overflow: auto;
}
.milestones__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: var(--ws-fs-sm);
  font-weight: 650;
  color: var(--ws-text-2);
  padding-bottom: 9px;
  border-bottom: 1px solid var(--ws-border);
  margin-bottom: 6px;
}
.milestones__head .ws-dim {
  font-weight: 400;
  font-size: 11px;
}
.mile {
  --cd: var(--ws-accent);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px;
  border-radius: var(--ws-radius-sm);
  transition: background 0.15s ease;
}
.mile + .mile {
  border-top: 1px solid var(--ws-border);
}
.mile:hover {
  background: var(--ws-panel-2);
}
.mile.is-warn {
  --cd: var(--ws-warn);
}
.mile.is-danger {
  --cd: var(--ws-danger);
}
.mile.is-over,
.mile.is-plain {
  --cd: var(--ws-text-3);
}
/* 天数做成小药丸：数字仍按紧迫度着色，但有了承托面，比裸数字好读 */
.mile__left {
  flex: 0 0 auto;
  min-width: 48px;
  padding: 3px 6px;
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 1px;
  border-radius: var(--ws-radius-sm);
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
  font-size: var(--ws-fs-sm);
  font-weight: 700;
  color: var(--cd);
  font-variant-numeric: tabular-nums;
}
.mile__unit {
  font-size: 10px;
  font-weight: 400;
  color: var(--ws-text-3);
}
.mile__body {
  flex: 1;
  min-width: 0;
}
.mile__name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.mile__label {
  font-size: var(--ws-fs-sm);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mile__tag {
  flex: 0 0 auto;
  transform: scale(0.86);
  transform-origin: left center;
}
.mile__date {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mile__ops {
  flex: 0 0 auto;
  gap: 0;
}

/* ------------------------------------------------------------ 通用块 -- */
.block {
  padding: 16px 18px 18px;
  margin-bottom: 18px;
}
/* 项目区用 panel-2 打底，里面的白卡才有"浮起来"的层次 */
.block--tint {
  background: var(--ws-panel-2);
}
.block__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-bottom: 12px;
  margin-bottom: 14px;
  border-bottom: 1px solid var(--ws-border);
}
.block__title {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: var(--ws-fs-md);
  font-weight: 650;
}
/* 标题图标做成小方块"图标砖"，和侧边栏导航的视觉语言一致 */
.block__title .el-icon {
  width: 26px;
  height: 26px;
  flex: 0 0 auto;
  border-radius: var(--ws-radius-sm);
  background: var(--ws-accent-soft);
  color: var(--ws-accent);
  font-size: 15px;
}
.muted-line {
  color: var(--ws-text-3);
  font-size: var(--ws-fs-sm);
  padding: 6px 0;
}
.muted-line--tight {
  padding: 2px 0 6px;
}

.bar {
  flex: 1;
  height: 7px;
  border-radius: var(--ws-radius-pill);
  background: var(--ws-border);
  overflow: hidden;
}
.bar--wide {
  width: 100%;
  margin: 14px 0 4px;
}
.bar i {
  display: block;
  height: 100%;
  border-radius: var(--ws-radius-pill);
  background: var(--ws-accent);
  transition: width 0.35s cubic-bezier(0.22, 1, 0.36, 1);
}

.add-row {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed var(--ws-border);
}

.steps {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
}
.step {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  padding: 4px 6px 4px 2px;
  border-radius: var(--ws-radius-sm);
  font-size: var(--ws-fs-sm);
  transition: background 0.14s ease;
}
.step:hover {
  background: var(--ws-panel-2);
}
/* 复选框压到 21px 高，行高同为 21px —— 首行中心线对齐，多行时也不会把勾选框甩到中间 */
.step :deep(.el-checkbox) {
  height: 21px;
  margin-right: 2px;
}
.step__text {
  flex: 1;
  min-width: 0;
  line-height: 21px;
  color: var(--ws-text-2);
}
.step.is-done .step__text {
  color: var(--ws-text-3);
  text-decoration: line-through;
}
.step__del {
  opacity: 0;
  transition: opacity 0.15s ease;
}
.step:hover .step__del {
  opacity: 1;
}

/* ------------------------------------------------------------ 项目 --- */
.pgrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
}
.proj {
  --cd: var(--ws-accent);
  position: relative;
  background: var(--ws-panel);
  border: 1px solid var(--ws-border);
  border-radius: var(--ws-radius);
  box-shadow: var(--ws-shadow-1);
  padding: 14px 16px 14px 18px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
}
.proj::before {
  content: '';
  position: absolute;
  left: 0;
  top: 12px;
  bottom: 12px;
  width: 3px;
  border-radius: 0 var(--ws-radius-pill) var(--ws-radius-pill) 0;
  background: var(--cd);
}
.proj:hover {
  transform: translateY(-2px);
  box-shadow: var(--ws-shadow-2);
  border-color: var(--ws-border-strong);
}
.proj.is-warn {
  --cd: var(--ws-warn);
}
.proj.is-danger {
  --cd: var(--ws-danger);
}
.proj.is-over {
  --cd: var(--ws-text-3);
}
.proj.is-done {
  --cd: var(--ws-success);
  opacity: 0.82;
}
.proj__head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.proj__name {
  flex: 1;
  min-width: 0;
  font-weight: 650;
  font-size: var(--ws-fs-base);
  letter-spacing: -0.005em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.proj__note {
  font-size: 12px;
  line-height: 1.55;
  margin-top: 2px;
}
.pri {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.03em;
  padding: 1px 7px;
  border-radius: var(--ws-radius-sm);
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border-strong);
  color: var(--ws-text-2);
}
.pri--P0 {
  color: var(--ws-danger);
  border-color: var(--ws-danger);
  background: var(--ws-danger-soft);
}
.pri--P1 {
  color: var(--ws-warn);
  border-color: var(--ws-warn);
  background: var(--ws-warn-soft);
}
.proj__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 9px;
  font-size: var(--ws-fs-xs);
}
.status {
  padding: 1px 8px;
  border-radius: var(--ws-radius-pill);
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border-strong);
  color: var(--ws-text-2);
}
.status--active {
  color: var(--ws-accent);
  border-color: var(--ws-accent-ring);
  background: var(--ws-accent-soft);
}
.status--waiting {
  color: var(--ws-warn);
  border-color: var(--ws-warn);
  background: var(--ws-warn-soft);
}
.status--done {
  color: var(--ws-success);
  border-color: var(--ws-success);
  background: var(--ws-success-soft);
}
.due {
  color: var(--cd);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.proj__bar {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-top: 12px;
}
.proj__bar .bar i {
  background: var(--cd);
}
.proj__pct {
  font-size: var(--ws-fs-xs);
  font-weight: 600;
  color: var(--ws-text-2);
  font-variant-numeric: tabular-nums;
  min-width: 32px;
  text-align: right;
}
/* 当前阶段做成引用条：和卡片左侧色条同色，一眼能区分"元信息"和"下一步清单" */
.proj__stage {
  font-size: var(--ws-fs-xs);
  line-height: 1.65;
  color: var(--ws-text-2);
  margin-top: 10px;
  padding-left: 9px;
  border-left: 2px solid var(--cd);
}

/* ------------------------------------------------------------ 备考 --- */
.prep {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
  gap: 16px;
}
.prep__card {
  margin-bottom: 0;
}
/* 倒计时行做成主色软底提示条，比裸文字更有"接着要考了"的分量 */
.prep__cd {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  font-size: var(--ws-fs-sm);
  padding: 8px 12px;
  border-radius: var(--ws-radius-sm);
  background: var(--ws-accent-soft);
  border: 1px solid var(--ws-border);
}
.prep__cd-num {
  font-size: var(--ws-fs-md);
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--ws-accent);
}
.prep__stage {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
}
.prep__stage-label {
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-3);
  white-space: nowrap;
}
.steps--prep .step__text {
  color: var(--ws-text-2);
}
.prep__note {
  font-size: var(--ws-fs-xs);
  line-height: 1.7;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed var(--ws-border);
}

/* ------------------------------------------------------------ 页脚 --- */
.foot {
  font-size: var(--ws-fs-xs);
  line-height: 1.9;
  margin-top: 20px;
  padding-top: 14px;
  border-top: 1px dashed var(--ws-border);
}
.foot code {
  font-family: var(--ws-mono);
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 6px;
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
}

/* ------------------------------------------------------------ 弹窗 --- */
.dlg-foot {
  display: flex;
  align-items: center;
  gap: 8px;
}
.form-hint {
  font-size: var(--ws-fs-xs);
  margin-left: 8px;
}
</style>
