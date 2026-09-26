<script setup lang="ts">
/**
 * 日历日程 —— 月 / 周两种视图，把「学校怎么安排」和「我留下了什么」叠在一张表上。
 *
 * 数据来源（全部走边车）：
 *   - /api/calendar/school     → 校历（放假 / 考试周 / 教学周）
 *   - /api/dashboard/*         → 自己的计划与记录（看板那份数据）
 *   - /api/calendar/school     → 校历：每天是不是上课日 / 放假 / 考试周 / 第几教学周
 *   - /api/dashboard/calendar  → 某个月每天的记录摘要（计划数 / 记录数 / 心情）
 *   - /api/dashboard/day       → 点开某天的明细；写入落在看板的 dashboard.json
 *
 * 三个关键判断（都来自数据本身，不是审美偏好）：
 *   1. 上游课表**没有周次范围字段**，同一门课每周重复 —— 所以「星期几有什么课」是**列属性**，
 *      每格重复显示它是冗余的。但它是这一格里最有用的信息，所以**直接显示、不做省略**，
 *      同时把「这周上不上课」交给校历判定（放假/考试周直接不排课）。
 *   2. **校历负责「上不上课」，课表负责「上什么课」**。以前只有课表，于是国庆、寒假、
 *      考试周的格子里照样排着每周固定的课 —— 那是假的。现在两边分开取，合成一张表。
 *   3. 只有周视图展开到节次时间轴：那时候要回答的是「今天哪段是空的」。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import PageHeader from '@/components/PageHeader.vue'
import SidecarOffline from '@/components/SidecarOffline.vue'
import MdLite from '@/components/MdLite.vue'
import { api, ensureSidecar } from '@/core/sidecar'

const route = useRoute()

/* ------------------------------------------------------------ 日期工具 --- */

const p2 = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
const parseYmd = (s: string) => new Date(`${s}T00:00:00`)
/** 本周的周一（周一为一周之首，与常见的高校作息一致） */
function mondayOf(d: Date) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7))
  return x
}
function addDays(d: Date, n: number) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}

const TODAY = ymd(new Date())
const DOW_CHARS = ['日', '一', '二', '三', '四', '五', '六']
/** `星期一` / `周一` / `Monday` 一律归一成「一」这一个字 */
function dowChar(s: unknown) {
  const m = String(s ?? '').match(/[一二三四五六日天]/)
  if (!m) return ''
  return m[0] === '天' ? '日' : m[0]
}

const anchor = ref(TODAY)
const anchorDate = computed(() => parseYmd(anchor.value))
const monthKey = computed(() => anchor.value.slice(0, 7))

/* ----------------------------------------------------------------- 状态 --- */

const mode = ref<'month' | 'week'>('month')
const ready = ref(false)
const loading = ref(false)

const overview = ref<any>(null)
/** date -> { notes, reviews, jots } */
const monthData = ref<Record<string, any>>({})
/** date -> 校历标记 { kind, label, suspend, week, term, tag, note, estimated } */
const schoolDays = ref<Record<string, SchoolMark>>({})
const schoolMeta = ref<any>(null)

/* 详情抽屉 */
const drawer = ref(false)
const detailDate = ref('')
const detail = ref<any>(null)
const detailLoading = ref(false)
const newNote = ref('')

/* ------------------------------------------------------------- 课表数据 --- */

interface SchoolMark {
  kind: 'teaching' | 'holiday' | 'vacation' | 'exam' | 'event' | 'register' | 'workday' | 'rest'
  label: string
  suspend: boolean
  week: number | null
  term: string | null
  tag?: string | null
  note?: string | null
  estimated?: boolean
  source?: string | null
}

/** 节次时间表（常见的高校作息；要改就在这一处改） */
const PERIODS = [
  { n: 1, from: '08:10', to: '08:50' },
  { n: 2, from: '09:00', to: '09:40' },
  { n: 3, from: '09:50', to: '10:30' },
  { n: 4, from: '10:40', to: '11:20' },
  { n: 5, from: '11:30', to: '12:10' },
  { n: 6, from: '14:30', to: '15:10' },
  { n: 7, from: '15:20', to: '16:00' },
  { n: 8, from: '16:10', to: '16:50' },
  { n: 9, from: '17:00', to: '17:40' },
  { n: 10, from: '19:00', to: '19:40' },
  { n: 11, from: '19:50', to: '20:30' },
  { n: 12, from: '20:40', to: '21:20' },
]

/** `第01-03节` → [起始节, 结束节] */
function periodSpan(time?: string): [number, number] | null {
  const m = typeof time === 'string' ? time.match(/第\s*(\d+)\s*-\s*(\d+)\s*节/) : null
  if (!m) return null
  const a = Number(m[1])
  const b = Number(m[2])
  if (!(a >= 1) || b > 12 || b < a) return null
  return [a, b]
}
function timeRange(time?: string) {
  const sp = periodSpan(time)
  if (!sp) return time ?? ''
  return `${PERIODS[sp[0] - 1].from}-${PERIODS[sp[1] - 1].to}`
}
/** 只取起始时间（月视图格子窄，放不下完整区间） */
function startTime(time?: string) {
  const sp = periodSpan(time)
  return sp ? PERIODS[sp[0] - 1].from : ''
}
/** 节次文案：`第01-03节` → `1-3节` */
function periodLabelOf(time?: string) {
  const sp = periodSpan(time)
  return sp ? `${sp[0]}-${sp[1]}节` : (time ?? '')
}

/** 同一门课在哪儿都同色。 */
const hueMap = computed<Record<string, number>>(() => {
  const names = new Set<string>()
  for (const list of Object.values(coursesByDow.value)) {
    for (const c of list) if (c?.name) names.add(String(c.name))
  }
  // 为什么不用名字哈希：本学期的 8 门课哈希到 6 个桶里，实测 4 门挤进同一桶，
  // 满屏一片玫红，一眼分不出来。改成「按课程名排序后轮流取 8 组色阶」——
  // ≤8 门课保证两两不同色（一个学期的课表通常就 6~10 门）。
  //
  // 取色顺序刻意打乱（不是 1,2,3,…）：相邻两节课在名单里往往也相邻，
  // 按顺序走会给它们青/绿这种近色；按下面这个顺序，相邻两门必定对比明显。
  const HUE_ORDER = [1, 4, 3, 5, 2, 8, 7, 6]
  const sorted = [...names].sort((a, b) => a.localeCompare(b))
  const map: Record<string, number> = {}
  sorted.forEach((n, i) => {
    map[n] = HUE_ORDER[i % HUE_ORDER.length]
  })
  return map
})
function hueOf(name: string) {
  return hueMap.value[String(name ?? '')] ?? 1
}

/** 星期字 → 当天课程（原始课表，未考虑放假） */
const coursesByDow = computed<Record<string, any[]>>(() => {
  const out: Record<string, any[]> = {}
  const weekDays = overview.value?.schedule?.weekDays ?? []
  for (const d of weekDays) {
    const k = dowChar(d?.day)
    if (k) out[k] = Array.isArray(d?.courses) ? d.courses : []
  }
  return out
})
/** 课表里这天本来排了什么（不管放不放假） */
function scheduledOf(dateStr: string) {
  return coursesByDow.value[dowChar(`星期${DOW_CHARS[parseYmd(dateStr).getDay()]}`)] ?? []
}
function markOf(dateStr: string): SchoolMark {
  return (
    schoolDays.value[dateStr] ?? {
      kind: 'teaching',
      label: '上课',
      suspend: false,
      week: null,
      term: null,
    }
  )
}
/** 真正要上的课：放假/考试周/周末的格子不给排课 —— 校历负责「上不上」，课表只管「上什么」 */
function coursesOf(dateStr: string) {
  if (markOf(dateStr).suspend) return []
  return scheduledOf(dateStr)
}
/** 带定位信息的课程块（周视图用） */
function blocksOf(dateStr: string) {
  return coursesOf(dateStr).map((c: any, i: number) => {
    const sp = periodSpan(c.time) ?? [1, 1]
    return { ...c, key: `${dateStr}-${i}`, rowStart: sp[0], rowEnd: sp[1] + 1, hue: hueOf(c.name) }
  })
}

/* --------------------------------------------------------- 月视图网格 --- */

interface Cell {
  date: string
  dayNum: number
  inMonth: boolean
  isToday: boolean
  monthLabel: string | null
  mark: SchoolMark
  /** 要上的课（停课日为空） */
  courses: any[]
  /** 课表里本来排了几节（用来提示「这天的课被放假冲掉了」） */
  scheduled: number
  rec: any | null
  pct: number
}

const monthCells = computed<Cell[]>(() => {
  const first = new Date(anchorDate.value.getFullYear(), anchorDate.value.getMonth(), 1)
  const start = addDays(first, -((first.getDay() + 6) % 7))
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  const lead = (first.getDay() + 6) % 7
  const rows = Math.ceil((lead + daysInMonth) / 7)
  const cells: Cell[] = []
  for (let i = 0; i < rows * 7; i += 1) {
    const cur = addDays(start, i)
    const date = ymd(cur)
    const rec = monthData.value[date] ?? null
    cells.push({
      date,
      dayNum: cur.getDate(),
      inMonth: cur.getMonth() === first.getMonth(),
      isToday: date === TODAY,
      monthLabel: cur.getDate() === 1 ? `${cur.getMonth() + 1}月` : null,
      mark: markOf(date),
      courses: coursesOf(date),
      scheduled: scheduledOf(date).length,
      rec,
      pct: rec?.notes ? 100 : 0,
    })
  }
  return cells
})
const monthRows = computed(() => Math.max(1, Math.ceil(monthCells.value.length / 7)))

/** 星期列表头：整周课量（数据是每周固定的，放这儿当「这周的重心」一眼可见） */
const weekHeads = computed(() => {
  const order = ['一', '二', '三', '四', '五', '六', '日']
  const counts = order.map((k) => (coursesByDow.value[k] ?? []).length)
  const max = Math.max(1, ...counts)
  return order.map((k, i) => ({
    dow: `周${k}`,
    count: counts[i],
    pct: Math.round((counts[i] / max) * 100),
    courses: coursesByDow.value[k] ?? [],
  }))
})

/* --------------------------------------------------------- 周视图网格 --- */

const weekDates = computed(() => {
  const mon = mondayOf(anchorDate.value)
  return Array.from({ length: 7 }, (_, i) => {
    const d = addDays(mon, i)
    const date = ymd(d)
    const rec = monthData.value[date] ?? null
    const mark = markOf(date)
    return {
      date,
      dowLabel: `周${DOW_CHARS[d.getDay()]}`,
      dayNum: d.getDate(),
      monthLabel: `${d.getMonth() + 1}月`,
      isToday: date === TODAY,
      isWeekend: i >= 5,
      mark,
      off: mark.suspend,
      courses: coursesOf(date),
      blocks: blocksOf(date),
      rec,
    }
  })
})

/* ------------------------------------------------------------- 教学周 --- */

/** 锚点那天的教学周。以校历现算为准（课表快照里的 week 会 stale，只作兜底）。 */
const teachingWeek = computed<number | null>(() => {
  const fromSchool = markOf(anchor.value).week
  if (fromSchool) return fromSchool
  const cur = Number(overview.value?.semester?.week) || Number(overview.value?.schedule?.week)
  if (!cur) return null
  const base = mondayOf(new Date())
  const target = mondayOf(anchorDate.value)
  const w = cur + Math.round((target.getTime() - base.getTime()) / (7 * 86400000))
  return w > 0 ? w : null
})

/** 当前学期名（从任意一个有 term 的标记里取） */
const termName = computed<string | null>(() => {
  const direct = markOf(anchor.value).term
  if (direct) return direct
  for (const c of monthCells.value) if (c.mark.term) return c.mark.term
  return schoolMeta.value?.semesters?.[0]?.name ?? null
})

/** 当月覆盖的教学周区间，如「第 1–5 教学周」 */
const monthWeeks = computed(() => {
  const ws = monthCells.value.filter((c) => c.inMonth && c.mark.week).map((c) => c.mark.week as number)
  if (!ws.length) return null
  const a = Math.min(...ws)
  const b = Math.max(...ws)
  return a === b ? `第 ${a} 教学周` : `第 ${a}–${b} 教学周`
})

/** 课表里最重的一天有几节 —— 只有真的出现 ≥3 节的日子，「满课」图例才有意义 */
const HEAVY = 3
const hasHeavyDay = computed(() =>
  Object.values(coursesByDow.value).some((l) => (l?.length ?? 0) >= HEAVY),
)

/* --------------------------------------------------------- 周期标题 --- */

const periodLabel = computed(() => {
  if (mode.value === 'month') {
    return `${anchorDate.value.getFullYear()} 年 ${anchorDate.value.getMonth() + 1} 月`
  }
  const a = weekDates.value[0]
  const b = weekDates.value[6]
  return `${a.monthLabel}${a.dayNum} 日 – ${b.monthLabel}${b.dayNum} 日`
})

/** 标题下的那段补充：月看教学周区间，周看这一周休几天 */
const periodSub = computed(() => {
  if (mode.value === 'month') return monthWeeks.value
  const off = weekDates.value.filter((d) => d.off).length
  return off ? `休 ${off} 天` : null
})

/* --------------------------------------------------------- 月概览统计 --- */

const monthSummary = computed(() => {
  const days = monthCells.value.filter((c) => c.inMonth)
  const recs = days.map((c) => c.rec).filter(Boolean)
  const notes = recs.reduce((s, r) => s + (r.notes || 0), 0)
  const reviews = recs.reduce((s, r) => s + (r.reviews || 0), 0)
  const schoolDays2 = days.filter((c) => !c.mark.suspend && c.scheduled > 0)
  const courseCount = schoolDays2.reduce((s, c) => s + c.courses.length, 0)
  const lost = days.reduce((s, c) => s + (c.mark.suspend ? c.scheduled : 0), 0)
  const activeDays = recs.filter((r) => r.notes || r.reviews).length
  const offDays = days.filter((c) => c.mark.suspend && c.mark.kind !== 'rest').length
  return {
    courseDays: schoolDays2.length,
    courseCount,
    lost,
    offDays,
    activeDays,
    activeTotal: days.length,
    notes,
    reviews,
  }
})

/* --------------------------------------------------------------- 加载 --- */

async function loadOverview() {
  const r = await api.overview()
  if (r.ok) overview.value = r.data
}

/**
 * 拉视图需要的月份数据。
 * 周视图可能横跨两个月（如 8/31–9/6），两个月的摘要都要在手里，
 * 否则跨月那一周会半边空白；顺便把锚点所在月也带上，月概览 KPI 才准。
 */
async function loadMonth() {
  const keys = new Set<string>([monthKey.value])
  if (mode.value === 'week') {
    for (const d of weekDates.value) keys.add(d.date.slice(0, 7))
  }
  const merged: Record<string, any> = {}
  const marks: Record<string, SchoolMark> = {}
  let meta: any = null
  await Promise.all(
    [...keys].map(async (k) => {
      const [dash, school] = await Promise.all([api.dashboardCalendar(k), api.schoolCalendar(k)])
      if (dash.ok) Object.assign(merged, dash.data?.days ?? {})
      if (school.ok) {
        Object.assign(marks, school.data?.days ?? {})
        meta = school.data
      }
    }),
  )
  monthData.value = merged
  schoolDays.value = marks
  if (meta) schoolMeta.value = meta
}

async function loadAll() {
  loading.value = true
  try {
    await Promise.all([loadOverview(), loadMonth()])
  } finally {
    loading.value = false
  }
}

/* ----------------------------------------------------------- 详情抽屉 --- */

async function loadDetail() {
  if (!detailDate.value) return
  detailLoading.value = true
  try {
    const r = await api.day(detailDate.value)
    if (r.ok) detail.value = { notes: r.data?.notes ?? [], plans: r.data?.plans ?? [] }
  } finally {
    detailLoading.value = false
  }
}

function openDay(date: string) {
  detailDate.value = date
  detail.value = { notes: [], plans: [] }
  drawer.value = true
  loadDetail()
}

async function afterWrite() {
  await loadDetail()
  if (detailDate.value.startsWith(`${monthKey.value}-`)) await loadMonth()
}

async function addNote() {
  const text = newNote.value.trim()
  if (!text) return
  const r = await api.addNote(text, detailDate.value)
  if (r.ok) {
    newNote.value = ''
    afterWrite()
  } else ElMessage.error(r.error ?? '记录失败')
}

/* ------------------------------------------------------------- 派生展示 --- */

const detailMark = computed<SchoolMark | null>(() => (detailDate.value ? markOf(detailDate.value) : null))
const detailScheduled = computed(() => (detailDate.value ? scheduledOf(detailDate.value).length : 0))
const detailCourses = computed(() => (detailDate.value ? blocksOf(detailDate.value) : []))
/** 详情里的「记录」= 当天的随手记 + 计划（都来自看板的 dashboard.json） */
const detailNotes = computed<any[]>(() => detail.value?.notes ?? [])
const detailPlans = computed<any[]>(() => detail.value?.plans ?? [])
const detailWeekday = computed(() =>
  detailDate.value ? `星期${DOW_CHARS[parseYmd(detailDate.value).getDay()]}` : '',
)
const detailIsFuture = computed(() => detailDate.value > TODAY)

function shift(step: number) {
  if (mode.value === 'month') {
    const d = anchorDate.value
    anchor.value = ymd(new Date(d.getFullYear(), d.getMonth() + step, 1))
  } else {
    anchor.value = ymd(addDays(anchorDate.value, step * 7))
  }
}
function goToday() {
  anchor.value = TODAY
}

/* --------------------------------------------------------------- 生命周期 --- */

watch([anchor, mode], () => {
  if (ready.value) loadMonth()
})

onMounted(async () => {
  const q = String(route.query.date ?? '')
  if (/^\d{4}-\d{2}-\d{2}$/.test(q)) anchor.value = q
  // 支持 ?view=week 直达周视图（也方便截图/分享某一周）
  if (route.query.view === 'week') mode.value = 'week'
  const ok = await ensureSidecar()
  ready.value = ok
  if (!ok) return
  await loadAll()
  if (/^\d{4}-\d{2}-\d{2}$/.test(q) && route.query.open === '1') openDay(q)
})
</script>

<template>
  <div class="ws-page ws-page--wide">
    <SidecarOffline v-if="ready === false" what="日历日程" @ready="loadAll" />

    <template v-else>
      <PageHeader
        title="日历日程"
        :subtitle="`${periodLabel}${periodSub ? ` · ${periodSub}` : ''}${termName ? ` · ${termName}` : ''}`"
        icon="Calendar"
      >
        <template #actions>
          <el-radio-group v-model="mode" size="default">
            <el-radio-button value="month">月</el-radio-button>
            <el-radio-button value="week">周</el-radio-button>
          </el-radio-group>
          <el-button-group>
            <el-button @click="shift(-1)"><el-icon><ArrowLeft /></el-icon></el-button>
            <el-button :disabled="anchor === TODAY" @click="goToday">今天</el-button>
            <el-button @click="shift(1)"><el-icon><ArrowRight /></el-icon></el-button>
          </el-button-group>
          <el-button :loading="loading" @click="loadAll"><el-icon><Refresh /></el-icon>&nbsp;刷新</el-button>
        </template>
      </PageHeader>

      <!-- ==================================================== 月概览 KPI -->
      <div class="kpis">
        <div class="kpi">
          <div class="kpi__label">本月课时</div>
          <div class="kpi__value">{{ monthSummary.courseCount }}<small>节</small></div>
          <div class="kpi__foot">
            {{ monthSummary.courseDays }} 天有课<template v-if="monthSummary.lost">
              · 放假冲掉 {{ monthSummary.lost }} 节</template>
          </div>
        </div>
        <div class="kpi">
          <div class="kpi__label">休息天数</div>
          <div class="kpi__value">{{ monthSummary.offDays }}<small>天</small></div>
          <div class="kpi__foot">放假 / 考试周（不含周末）</div>
        </div>
        <div class="kpi">
          <div class="kpi__label">有记录的天数</div>
          <div class="kpi__value">{{ monthSummary.activeDays }}<small>/ {{ monthSummary.activeTotal }}</small></div>
          <div class="kpi__foot">随手记 · 复盘任一</div>
        </div>
        <div class="kpi">
          <div class="kpi__label">本月记录</div>
          <div class="kpi__value">{{ monthSummary.notes }}<small>条</small></div>
          <div class="kpi__foot">{{ monthSummary.reviews ? `其中 ${monthSummary.reviews} 条复盘` : '还没写过记录' }}</div>
        </div>
      </div>

      <!-- ======================================================= 月视图 -->
      <div v-if="mode === 'month'" class="ws-card cal">
        <div class="cal__head">
          <div v-for="h in weekHeads" :key="h.dow" class="cal__head-cell" :class="{ 'is-rest': !h.count }">
            <div class="cal__head-dow">{{ h.dow }}</div>
            <el-tooltip
              :content="h.courses.length ? h.courses.map((c: any) => `${c.name} ${periodLabelOf(c.time)}`).join('\n') : '这一天没有课'"
              placement="bottom"
            >
              <div class="cal__head-load">
                <span class="cal__head-track"><i :style="{ width: `${h.pct}%` }" /></span>
                <span class="cal__head-n">{{ h.count ? `${h.count} 节` : '休息' }}</span>
              </div>
            </el-tooltip>
          </div>
        </div>

        <div class="cal__grid" :style="{ gridTemplateRows: `repeat(${monthRows}, minmax(104px, 1fr))` }">
          <div
            v-for="c in monthCells"
            :key="c.date"
            class="day"
            :class="[
              `day--${c.mark.kind}`,
              {
                'is-out': !c.inMonth,
                'is-today': c.isToday,
                'is-off': c.mark.suspend,
                'is-empty': !c.rec && !c.courses.length && !c.mark.suspend,
              },
            ]"
            @click="openDay(c.date)"
          >
            <div class="day__top">
              <span class="day__num">{{ c.dayNum }}</span>
              <span v-if="c.monthLabel" class="day__month">{{ c.monthLabel }}</span>
              <span v-if="c.isToday" class="day__today">今</span>
            </div>

            <!-- 放假 / 考试周 / 报到：这是这一格最重要的信息，放最前面 -->
            <div v-if="c.mark.kind !== 'teaching' && c.mark.kind !== 'rest'" class="day__mark">
              <span class="tag" :title="c.mark.note ?? c.mark.source ?? ''">
                {{ c.mark.label }}<template v-if="c.mark.estimated">?</template>
              </span>
              <span v-if="c.mark.suspend && c.scheduled" class="day__lost">停课 {{ c.scheduled }} 节</span>
            </div>

            <!-- 课程：直接铺出来，不做省略 -->
            <div v-if="c.courses.length" class="day__courses">
              <div
                v-for="(cc, i) in c.courses.slice(0, 3)"
                :key="`${c.date}-c${i}`"
                class="cc"
                :class="`cc--${hueOf(cc.name)}`"
                :title="`${cc.name} · ${timeRange(cc.time)}${cc.location ? ` · ${cc.location}` : ''}`"
              >
                <span class="cc__t ws-mono">{{ startTime(cc.time) }}</span>
                <span class="cc__n">{{ cc.name }}</span>
              </div>
              <div v-if="c.courses.length > 3" class="cc__more">还有 {{ c.courses.length - 3 }} 节…</div>
            </div>

            <div class="day__foot">
              <template v-if="c.rec">
                <div class="day__signals">
                  <span v-if="c.rec.notes" class="sig">{{ c.rec.notes }} 记</span>
                  <span v-if="c.rec.reviews" class="sig sig--ok">{{ c.rec.reviews }} 复盘</span>
                </div>
              </template>
              <span v-else-if="c.mark.tag" class="day__tag">{{ c.mark.tag }}</span>
            </div>
          </div>
        </div>

        <div class="cal__legend">
          <span class="lg"><i class="lg__chip lg__chip--holiday" /> 法定节假日</span>
          <span class="lg"><i class="lg__chip lg__chip--vacation" /> 寒暑假</span>
          <span class="lg"><i class="lg__chip lg__chip--exam" /> 考试周</span>
          <span class="lg"><i class="lg__chip lg__chip--event" /> 校历活动</span>
          <span class="lg"><i class="lg__chip lg__chip--workday" /> 调休上课</span>
          <span class="lg"><i class="lg__bar" /> 有记录</span>
          <span v-if="hasHeavyDay" class="lg"><i class="lg__heavy" /> 满课（≥{{ HEAVY }} 节）</span>
          <span class="ws-dim">带 ? 的是 2027 年放假安排（尚未公布，按惯例标）</span>
        </div>
      </div>

      <!-- ======================================================= 周视图 -->
      <div v-else class="ws-card wk">
        <div class="wk__head">
          <div class="wk__corner"><span class="ws-dim">节次</span></div>
          <div
            v-for="d in weekDates"
            :key="d.date"
            class="wk__head-cell"
            :class="{
              'is-today': d.isToday,
              'is-weekend': d.isWeekend,
              'is-off': d.off && d.mark.kind !== 'rest',
            }"
            @click="openDay(d.date)"
          >
            <span class="wk__dow">{{ d.dowLabel }}</span>
            <span class="wk__num">{{ d.dayNum }}</span>
            <span
              v-if="d.mark.kind !== 'teaching' && d.mark.kind !== 'rest'"
              class="wk__mark"
              :class="`wk__mark--${d.mark.kind}`"
            >{{ d.mark.label }}</span>
            <span class="wk__meta">
              {{ d.off ? (d.mark.kind === 'rest' ? '周末' : '放假') : `${d.courses.length} 节课` }}
              <template v-if="d.rec?.notes"> · {{ d.rec.notes }} 记</template>
            </span>
          </div>
        </div>

        <div class="wk__body">
          <div class="wk__axis">
            <div v-for="p in PERIODS" :key="p.n" class="wk__axis-row">
              <span class="wk__axis-n">{{ p.n }}</span>
              <span class="wk__axis-t ws-mono">{{ p.from }}</span>
            </div>
          </div>
          <div class="wk__cols">
            <div
              v-for="d in weekDates"
              :key="d.date"
              class="wk__col"
              :class="{ 'is-today': d.isToday, 'is-weekend': d.isWeekend, 'is-off': d.off }"
              @click="openDay(d.date)"
            >
              <div
                v-for="b in d.blocks"
                :key="b.key"
                class="blk"
                :class="`blk--${b.hue}`"
                :style="{ top: `${((b.rowStart - 1) * 100) / 12}%`, height: `${((b.rowEnd - b.rowStart) * 100) / 12}%` }"
                :title="`${b.name} · ${timeRange(b.time)} · ${b.location ?? ''}`"
              >
                <span class="blk__name">{{ b.name }}</span>
                <span class="blk__meta ws-mono">{{ periodLabelOf(b.time) }} {{ startTime(b.time) }}</span>
                <span v-if="b.location" class="blk__loc">{{ b.location }}</span>
              </div>
              <div v-if="d.off" class="wk__off">
                <span>{{ d.mark.kind === 'rest' ? '周末' : d.mark.label }}</span>
              </div>
              <div v-else-if="!d.blocks.length" class="wk__free">空闲</div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- ========================================================= 当天详情 -->
    <el-drawer v-model="drawer" :size="450" :title="`${detailDate} ${detailWeekday}`">
      <div v-loading="detailLoading" class="dt">
        <div class="dt__chips">
          <span v-if="detailMark && detailMark.kind !== 'teaching'" class="chip chip--mark">
            {{ detailMark.label }}<template v-if="detailMark.estimated">（待定）</template>
          </span>
          <span v-else-if="detailMark?.week" class="chip">第 {{ detailMark.week }} 教学周</span>
          <span class="chip">{{ detailCourses.length }} 节课</span>
          <span class="chip">{{ detailNotes.length }} 条记录</span>
          <span v-if="detailPlans.length" class="chip">{{ detailPlans.length }} 计划</span>
          <span v-if="detailIsFuture" class="chip chip--future">还没到</span>
        </div>

        <div v-if="detailMark?.note" class="dt__note-top">{{ detailMark.note }}</div>

        <!-- 课程 -->
        <div class="dt__sec">
          <div class="dt__title"><el-icon><Clock /></el-icon> 课程</div>
          <div v-if="detailCourses.length" class="dt__courses">
            <div v-for="c in detailCourses" :key="c.key" class="dt__course" :class="`dt__course--${c.hue}`">
              <span class="dt__course-time ws-mono">{{ timeRange(c.time) }}</span>
              <span class="dt__course-body">
                <span class="dt__course-name">{{ c.name }}</span>
                <span v-if="c.location" class="dt__course-loc ws-dim"><el-icon><Location /></el-icon>{{ c.location }}</span>
              </span>
            </div>
          </div>
          <div v-else-if="detailMark?.suspend && detailScheduled" class="dt__empty">
            这天本来有 {{ detailScheduled }} 节课，{{ detailMark.label === '周末' ? '周末' : detailMark.label }}停课了。
          </div>
          <div v-else class="dt__empty">这一天没有课。</div>
        </div>

        <div class="dt__sec">
          <div class="dt__title"><el-icon><EditPen /></el-icon> 记录</div>
          <div class="dt__add">
            <el-input v-model="newNote" size="small" placeholder="记一句，支持 markdown" @keyup.enter="addNote" />
            <el-button size="small" type="primary" @click="addNote">记</el-button>
          </div>
          <div v-if="!detailPlans.length && !detailNotes.length" class="dt__empty">这一天还没有记录。</div>
          <div v-else class="dt__notes">
            <div v-for="p in detailPlans" :key="p.id" class="dt__note">
              <span class="chip">{{ p.done ? '已完成' : '计划' }}</span>
              <span>{{ p.text }}</span>
            </div>
            <div v-for="n in detailNotes" :key="n.id" class="dt__note">
              <span class="chip">随手记</span>
              <MdLite :text="n.text" dense />
            </div>
          </div>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
/* ------------------------------------------------------------- KPI ---- */
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
  padding: 13px 16px;
  box-shadow: var(--ws-shadow-1);
}
.kpi__label {
  font-size: 12px;
  color: var(--ws-text-2);
}
.kpi__value {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.02em;
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
.kpi__foot {
  font-size: 11.5px;
  color: var(--ws-text-3);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* --------------------------------------------------------- 月视图 ------ */
.cal {
  overflow: hidden;
}
.cal__head,
.cal__grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
}
.cal__head {
  border-bottom: 1px solid var(--ws-border);
  background: var(--ws-panel-2);
}
.cal__head-cell {
  padding: 9px 12px 8px;
  border-right: 1px solid var(--ws-border);
  min-width: 0;
}
.cal__head-cell:last-child {
  border-right: none;
}
.cal__head-cell.is-rest {
  opacity: 0.62;
}
.cal__head-dow {
  font-size: 12.5px;
  font-weight: 650;
}
.cal__head-load {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 5px;
}
.cal__head-track {
  flex: 1;
  height: 4px;
  min-width: 0;
  border-radius: 99px;
  background: var(--ws-border);
  overflow: hidden;
}
.cal__head-track i {
  display: block;
  height: 100%;
  border-radius: 99px;
  background: var(--ws-module-office);
  transition: width 0.2s ease;
}
.cal__head-n {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--ws-text-3);
  font-family: var(--ws-mono);
}

.cal__grid {
  background: var(--ws-panel);
}
.day {
  position: relative;
  min-width: 0;
  padding: 7px 8px 8px;
  border-right: 1px solid var(--ws-border);
  border-bottom: 1px solid var(--ws-border);
  cursor: pointer;
  transition: box-shadow 0.14s ease, background 0.14s ease;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.day:nth-child(7n) {
  border-right: none;
}
.cal__grid > .day:nth-last-child(-n + 7) {
  border-bottom: none;
}
.day:hover {
  box-shadow: inset 0 0 0 1.5px var(--ws-accent-200);
  z-index: 1;
}
.day.is-out {
  background: var(--ws-panel-2);
}
.day.is-out .day__num {
  color: var(--ws-text-3);
  opacity: 0.55;
}

/* 每天的「性质」底色：一眼能扫出这个月的节奏 */
.day--holiday {
  background: var(--ws-danger-soft);
}
.day--vacation {
  background: repeating-linear-gradient(
    45deg,
    var(--ws-panel-2) 0 6px,
    transparent 6px 12px
  );
}
.day--exam {
  background: var(--ws-warn-soft);
}
.day--event {
  background: var(--ws-info-soft);
}
.day--register {
  background: var(--ws-info-soft);
}
.day--workday {
  background: var(--ws-success-soft);
}
.day.is-out.day--holiday,
.day.is-out.day--exam,
.day.is-out.day--event,
.day.is-out.day--register,
.day.is-out.day--workday {
  opacity: 0.55;
}
.day.is-today {
  box-shadow: inset 0 0 0 1.5px var(--ws-accent);
}
.day.is-today .day__num {
  color: var(--ws-accent);
}
/* 满课日：左侧一条细描边 */
.day.is-heavy::before {
  content: '';
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--ws-module-office);
  opacity: 0.5;
}
.day__top {
  display: flex;
  align-items: center;
  gap: 5px;
}
.day__num {
  font-size: 13.5px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
.day__month {
  font-size: 10.5px;
  color: var(--ws-text-3);
  border: 1px solid var(--ws-border);
  border-radius: 4px;
  padding: 0 3px;
  line-height: 15px;
}
.day__today {
  margin-left: auto;
  font-size: 10px;
  font-weight: 600;
  color: var(--ws-on-accent);
  background: var(--ws-accent);
  border-radius: var(--ws-radius-pill);
  padding: 1px 5px;
}

.day__mark {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.tag {
  font-size: 10.5px;
  font-weight: 600;
  line-height: 16px;
  padding: 0 6px;
  border-radius: 4px;
  color: var(--ws-text);
  background: var(--ws-panel);
  border: 1px solid var(--ws-border-strong);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.day--holiday .tag {
  color: var(--ws-danger);
  border-color: var(--ws-danger);
}
.day--vacation .tag {
  color: var(--ws-text-2);
}
.day--exam .tag {
  color: var(--ws-warn);
  border-color: var(--ws-warn);
}
.day--event .tag,
.day--register .tag {
  color: var(--ws-info);
  border-color: var(--ws-info);
}
.day--workday .tag {
  color: var(--ws-success);
  border-color: var(--ws-success);
}
.day__lost {
  font-size: 10.5px;
  color: var(--ws-text-3);
}

.day__courses {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.cc {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding: 2px 5px;
  border-radius: 5px;
  border-left: 3px solid currentColor;
  line-height: 1.35;
}
.cc__t {
  flex: 0 0 auto;
  font-size: 9.5px;
  opacity: 0.85;
}
.cc__n {
  font-size: 11px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.cc__more {
  font-size: 10px;
  color: var(--ws-text-3);
}
.cc--1 { background: var(--ws-cal-1); color: var(--ws-cal-1-fg); }
.cc--2 { background: var(--ws-cal-2); color: var(--ws-cal-2-fg); }
.cc--3 { background: var(--ws-cal-3); color: var(--ws-cal-3-fg); }
.cc--4 { background: var(--ws-cal-4); color: var(--ws-cal-4-fg); }
.cc--5 { background: var(--ws-cal-5); color: var(--ws-cal-5-fg); }
.cc--6 { background: var(--ws-cal-6); color: var(--ws-cal-6-fg); }
.cc--7 { background: var(--ws-cal-7); color: var(--ws-cal-7-fg); }
.cc--8 { background: var(--ws-cal-8); color: var(--ws-cal-8-fg); }

.day__foot {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.day__plans {
  display: flex;
  align-items: center;
  gap: 6px;
}
.day__track {
  flex: 1;
  height: 4px;
  min-width: 0;
  border-radius: 99px;
  background: var(--ws-border);
  overflow: hidden;
}
.day__track i {
  display: block;
  height: 100%;
  border-radius: 99px;
  background: var(--ws-success);
  transition: width 0.2s ease;
}
.day__plans-n {
  flex: 0 0 auto;
  font-size: 10.5px;
  color: var(--ws-text-3);
}
.day__signals {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.sig {
  font-size: 10.5px;
  line-height: 15px;
  padding: 0 5px;
  border-radius: 4px;
  color: var(--ws-text-2);
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
}
.sig--ok {
  color: var(--ws-success);
  background: var(--ws-success-soft);
  border-color: transparent;
}
.sig--mood {
  color: var(--ws-warn);
  background: var(--ws-warn-soft);
  border-color: transparent;
}
.day__tag {
  font-size: 10.5px;
  color: var(--ws-text-3);
}

.cal__legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
  padding: 10px 16px;
  border-top: 1px solid var(--ws-border);
  font-size: 11.5px;
  color: var(--ws-text-2);
  background: var(--ws-panel-2);
}
.lg {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.lg__bar {
  width: 22px;
  height: 5px;
  border-radius: 99px;
  background: var(--ws-success);
}
.lg__chip {
  width: 12px;
  height: 12px;
  border-radius: 3px;
  border: 1px solid var(--ws-border-strong);
}
.lg__chip--holiday { background: var(--ws-danger-soft); border-color: var(--ws-danger); }
.lg__chip--vacation { background: var(--ws-panel-2); }
.lg__chip--exam { background: var(--ws-warn-soft); border-color: var(--ws-warn); }
.lg__chip--event { background: var(--ws-info-soft); border-color: var(--ws-info); }
.lg__chip--workday { background: var(--ws-success-soft); border-color: var(--ws-success); }
.lg__heavy {
  width: 3px;
  height: 12px;
  border-radius: 99px;
  background: var(--ws-module-office);
  opacity: 0.6;
}

/* --------------------------------------------------------- 周视图 ------ */
.wk {
  --wk-row: 44px;
  overflow: hidden;
}
.wk__head {
  display: grid;
  grid-template-columns: 74px repeat(7, minmax(0, 1fr));
  border-bottom: 1px solid var(--ws-border);
  background: var(--ws-panel-2);
}
.wk__body {
  display: grid;
  grid-template-columns: 74px minmax(0, 1fr);
}
.wk__corner {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 10px 0 8px;
  font-size: 11px;
  border-right: 1px solid var(--ws-border);
}
.wk__head-cell {
  padding: 8px 10px 9px;
  text-align: center;
  border-right: 1px solid var(--ws-border);
  cursor: pointer;
  transition: background 0.14s ease;
  min-width: 0;
}
.wk__head-cell:last-child {
  border-right: none;
}
.wk__head-cell:hover {
  background: var(--ws-accent-soft);
}
.wk__head-cell.is-weekend {
  background: var(--ws-panel);
}
.wk__head-cell.is-off {
  background: var(--ws-danger-soft);
}
.wk__head-cell.is-today {
  box-shadow: inset 0 -2px 0 var(--ws-accent);
}
.wk__dow {
  font-size: 11.5px;
  color: var(--ws-text-2);
  margin-right: 4px;
}
.wk__num {
  font-size: 15px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.wk__head-cell.is-today .wk__num {
  color: var(--ws-accent);
}
.wk__mark {
  display: inline-block;
  margin-left: 4px;
  font-size: 10px;
  font-weight: 600;
  padding: 0 5px;
  border-radius: 4px;
  color: var(--ws-text-2);
  background: var(--ws-panel);
  border: 1px solid var(--ws-border-strong);
  max-width: 84px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: 1px;
}
.wk__mark--holiday {
  color: var(--ws-danger);
  border-color: var(--ws-danger);
}
.wk__mark--exam {
  color: var(--ws-warn);
  border-color: var(--ws-warn);
}
.wk__mark--event,
.wk__mark--register {
  color: var(--ws-info);
  border-color: var(--ws-info);
}
.wk__mark--workday {
  color: var(--ws-success);
  border-color: var(--ws-success);
}
.wk__meta {
  display: block;
  font-size: 10.5px;
  color: var(--ws-text-3);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wk__axis {
  border-right: 1px solid var(--ws-border);
  background: var(--ws-panel-2);
}
.wk__axis-row {
  height: var(--wk-row);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px;
  border-bottom: 1px solid var(--ws-border);
  font-size: 10.5px;
  color: var(--ws-text-3);
}
.wk__axis-row:last-child {
  border-bottom: none;
}
.wk__axis-n {
  font-weight: 600;
  color: var(--ws-text-2);
}
.wk__cols {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
}
.wk__col {
  position: relative;
  min-width: 0;
  border-right: 1px solid var(--ws-border);
  background-image: repeating-linear-gradient(
    to bottom,
    var(--ws-border) 0 1px,
    transparent 1px var(--wk-row)
  );
  cursor: pointer;
}
.wk__col:last-child {
  border-right: none;
}
.wk__col.is-weekend {
  background-color: var(--ws-panel-2);
}
.wk__col.is-today {
  background-color: var(--ws-accent-soft);
}
/* 放假那一列：压一层斜纹，表示「这天不上课」 */
.wk__col.is-off {
  background-color: var(--ws-panel-2);
  background-image: repeating-linear-gradient(
    45deg,
    color-mix(in srgb, var(--ws-text-3) 12%, transparent) 0 6px,
    transparent 6px 14px
  );
}
.wk__off {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--ws-text-3);
  pointer-events: none;
  writing-mode: vertical-rl;
  letter-spacing: 0.16em;
}
.wk__free {
  position: absolute;
  left: 50%;
  bottom: 8px;
  transform: translateX(-50%);
  font-size: 10.5px;
  color: var(--ws-text-3);
  opacity: 0.7;
  pointer-events: none;
}
.blk {
  position: absolute;
  left: 4px;
  right: 4px;
  border-radius: var(--ws-radius-sm);
  padding: 5px 7px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 1px;
  border-left: 3px solid currentColor;
  transition: transform 0.14s ease, box-shadow 0.14s ease;
}
.blk:hover {
  transform: translateY(-1px);
  box-shadow: var(--ws-shadow-2);
}
.blk__name {
  font-size: 11.5px;
  font-weight: 650;
  line-height: 1.3;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.blk__meta {
  font-size: 10px;
  opacity: 0.8;
}
.blk__loc {
  font-size: 10px;
  opacity: 0.72;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.blk--1 { background: var(--ws-cal-1); color: var(--ws-cal-1-fg); }
.blk--2 { background: var(--ws-cal-2); color: var(--ws-cal-2-fg); }
.blk--3 { background: var(--ws-cal-3); color: var(--ws-cal-3-fg); }
.blk--4 { background: var(--ws-cal-4); color: var(--ws-cal-4-fg); }
.blk--5 { background: var(--ws-cal-5); color: var(--ws-cal-5-fg); }
.blk--6 { background: var(--ws-cal-6); color: var(--ws-cal-6-fg); }
.blk--7 { background: var(--ws-cal-7); color: var(--ws-cal-7-fg); }
.blk--8 { background: var(--ws-cal-8); color: var(--ws-cal-8-fg); }

/* ------------------------------------------------------- 详情抽屉 ------ */
.dt {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.dt__chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
}
.chip {
  font-size: 11.5px;
  padding: 3px 9px;
  border-radius: var(--ws-radius-pill);
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
  color: var(--ws-text-2);
}
.chip--mark {
  color: var(--ws-danger);
  background: var(--ws-danger-soft);
  border-color: transparent;
  font-weight: 600;
}
.chip--mood {
  color: var(--ws-warn);
  background: var(--ws-warn-soft);
  border-color: transparent;
}
.chip--future {
  color: var(--ws-info);
  background: var(--ws-info-soft);
  border-color: transparent;
}
.dt__note-top {
  font-size: 12px;
  line-height: 1.6;
  color: var(--ws-text-2);
  background: var(--ws-panel-2);
  border-left: 3px solid var(--ws-info);
  border-radius: var(--ws-radius-sm);
  padding: 8px 10px;
}
.dt__sec {
  border-top: 1px solid var(--ws-border);
  padding-top: 13px;
}
.dt__title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13.5px;
  font-weight: 650;
  margin-bottom: 9px;
}
.dt__empty {
  font-size: 12.5px;
  color: var(--ws-text-3);
  padding: 3px 0;
}
.dt__courses {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.dt__course {
  display: flex;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--ws-radius-sm);
  border-left: 3px solid currentColor;
}
.dt__course-time {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  padding-top: 1px;
}
.dt__course-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.dt__course-name {
  font-size: 13px;
  font-weight: 600;
}
.dt__course-loc {
  font-size: 11.5px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.dt__course--1 { background: var(--ws-cal-1); color: var(--ws-cal-1-fg); }
.dt__course--2 { background: var(--ws-cal-2); color: var(--ws-cal-2-fg); }
.dt__course--3 { background: var(--ws-cal-3); color: var(--ws-cal-3-fg); }
.dt__course--4 { background: var(--ws-cal-4); color: var(--ws-cal-4-fg); }
.dt__course--5 { background: var(--ws-cal-5); color: var(--ws-cal-5-fg); }
.dt__course--6 { background: var(--ws-cal-6); color: var(--ws-cal-6-fg); }
.dt__course--7 { background: var(--ws-cal-7); color: var(--ws-cal-7-fg); }
.dt__course--8 { background: var(--ws-cal-8); color: var(--ws-cal-8-fg); }
.dt__course-name,
.dt__course-loc {
  color: inherit;
}
.dt__add {
  display: flex;
  gap: 8px;
  margin-bottom: 9px;
}
.dt__list {
  display: flex;
  flex-direction: column;
}
.dt__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
}
.dt__item + .dt__item {
  border-top: 1px solid var(--ws-border);
}
.dt__item-text {
  flex: 1;
  font-size: 13px;
  line-height: 1.55;
  min-width: 0;
  word-break: break-word;
  color: var(--ws-text);
}
.dt__item-text.is-done {
  color: var(--ws-text-3);
  text-decoration: line-through;
}
.dt__notes {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.dt__note {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  font-size: 12.8px;
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
  border-radius: var(--ws-radius-sm);
  padding: 7px 10px;
  cursor: pointer;
}
.dt__note:hover {
  border-color: var(--ws-accent);
}
.dt__rate {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
}
.dt__save {
  margin-top: 10px;
}
</style>
