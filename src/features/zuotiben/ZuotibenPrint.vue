<script setup lang="ts">
/**
 * 做题本 · 打印版 —— 一题一页，外加三种导出格式。
 *
 * 版式照纸质做题本的路子来：
 *   页眉左 = 来源，右 = 日期范围；题号「N.【月.日】」+ 出处；题干与选项在上；
 *   下面整页留白手写；页脚 = 页码。
 *
 * 三种格式（2026-09-27 定的，工具条上直接选）：
 *   blank    纯题目纸（默认）：题面空着，答案不出现 —— 印出来手写。
 *   inline   答案在题里：答案填进题干空位，每题的解析印在该页留白之后。
 *   appendix 答案在后：题面依旧空白；末尾**先给一页答案汇总，再给逐题详解**（标准解析册的排法）。
 *
 * 为什么用浏览器打印而不是服务端出 PDF：公式排版管线（KaTeX + math-typeset）在前端，
 * 服务端再写一份就是两套要同时维护。Ctrl+P 选「另存为 PDF」就得到可导入平板的文件。
 *
 * 纸面与打印 CSS 在 `print-sheet.css`、每页高度在 `print-page.ts` ——
 * 英语「每日一句」的打印页（SentenceBookPrint.vue）共用这两份，别在这页里另写一套。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WikiMarkdown from '@/features/wiki/WikiMarkdown.vue'
import { api, ensureSidecar } from '@/core/sidecar'
import { stemWithAnswer } from './answer-inline'
import { sheetPageCss, type Orient } from './print-page'
import './print-sheet.css'

type Mode = 'blank' | 'inline' | 'appendix'

const route = useRoute()
const router = useRouter()

const ready = ref(false)
const error = ref('')
const date = ref(String(route.query.date ?? '') || dayStr())
const day = ref<any>({ date: '', source: '', problems: [] })

/** 地址栏优先：mode=blank|inline|appendix；老链接的 answers=1 当作 inline */
function initialMode(): Mode {
  const m = String(route.query.mode ?? '')
  if (m === 'blank' || m === 'inline' || m === 'appendix') return m
  return route.query.answers === '1' ? 'inline' : 'blank'
}
const mode = ref<Mode>(initialMode())

/** 方向：**默认横向** —— 这是给平板横屏做题用的（用户 2026-09-27 明确要「横过来」） */
const orient = ref<Orient>(route.query.orient === 'portrait' ? 'portrait' : 'landscape')
/** 备注要不要一起印。默认不印：备注是「做错原因」，属于自己的话，不该跟着题目纸发出去 */
const showNote = ref(route.query.note === '1')
/**
 * 答案（详解）怎么排：
 *   flow（默认）—— 连着排，一题不跨页；放不下就整条挪到下一页（这就是「超出一页就单独拎出来」）
 *   page        —— 每条详解独占一页，专门做答案陈列
 * 另外 flow 下**特别长的解析也会自动独占一页**（见 LONG_SOLUTION），
 * 免得一条挤掉半页、后面几条全被顶散。
 */
type AnsLayout = 'flow' | 'page'
const ansLayout = ref<AnsLayout>(route.query.anslayout === 'page' ? 'page' : 'flow')
/** 超过这个字数就当「一条占大半页」，让它独占一页。按横放 A4 的容量粗估的，不是精确测量 */
const LONG_SOLUTION = 420

const MODES: { value: Mode; label: string; hint: string }[] = [
  { value: 'blank', label: '纯题目纸', hint: '答案不出现，印出来手写' },
  { value: 'inline', label: '答案在题里', hint: '答案填进题干空位，解析印在本页留白之后' },
  { value: 'appendix', label: '答案在后', hint: '题面空着，末尾先答案汇总、再逐题详解' },
]

/** 题号旁的那句出处：优先用结构化 ref 的 label（它是从原文取的，章号题号不会抄错） */
function refLabel(p: any) {
  return String(p?.ref?.label ?? '').trim() || String(p?.origin ?? '').trim()
}

/** 这条详解要不要独占一页 */
function ownPage(p: any) {
  if (ansLayout.value === 'page') return true
  return String(p?.solution ?? '').length > LONG_SOLUTION
}

/*
 * 纸张方向与每页高度：由 `print-page.ts` 按当前方向拼好挂到 head 上（@page 不认 CSS 变量）。
 */
const pageCss = sheetPageCss(orient)

function dayStr(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const problems = computed<any[]>(() => day.value.problems ?? [])
/** blank / appendix 的题面都不带答案；只有 inline 把答案写进题干 */
const stemShowsAnswer = computed(() => mode.value === 'inline')
const modeHint = computed(() => MODES.find((m) => m.value === mode.value)?.hint ?? '')
/** 页眉右栏：这本册子是哪一天的（原来是「当月 01 号 - 月末」的月度范围，
    单日册子上没有信息量；2026-09-29 改成日期 + 题数） */
const dayLabel = computed(() => String(date.value ?? '').replace(/-/g, '.'))

async function load() {
  error.value = ''
  const ok = await ensureSidecar()
  ready.value = ok
  if (!ok) return
  try {
    const r: any = await api.zuotibenDay(date.value)
    if (r?.ok === false) throw new Error(r.error || '读取失败')
    // 注意：call() 把整个响应体包在 data 里，不是摊平的
    day.value = r.data ?? { date: date.value, source: '', problems: [] }
    // 空册子别直接弹打印框 —— 打出来是白纸，还以为是版式坏了
    if (!problems.value.length) error.value = `${date.value} 还没有题`
  } catch (e: any) {
    error.value = e?.message || String(e)
  }
}

function syncQuery() {
  router.replace({
    name: 'zuotiben-print',
    query: {
      date: date.value,
      ...(mode.value === 'blank' ? {} : { mode: mode.value }),
      ...(orient.value === 'landscape' ? {} : { orient: orient.value }),
      ...(showNote.value ? { note: '1' } : {}),
      ...(ansLayout.value === 'flow' ? {} : { anslayout: ansLayout.value }),
    },
  })
}

/** 答案汇总里一行：有答案给答案；解答/证明题没有可填的答案，指向详解 */
function answerOf(p: any) {
  return String(p?.answer ?? '').trim() || '见详解'
}

function doPrint() {
  window.print()
}

watch([date], () => load())
watch([mode, orient, showNote, ansLayout], syncQuery)
// 地址栏里换参数（工具栏按钮走的是 replace）时也要跟着变
watch(
  () => route.query,
  (q) => {
    const s = String(q.date ?? '')
    if (s && s !== date.value) date.value = s
    const m = String(q.mode ?? '')
    const next: Mode =
      m === 'blank' || m === 'inline' || m === 'appendix' ? m : q.answers === '1' ? 'inline' : 'blank'
    if (next !== mode.value) mode.value = next
    const o: Orient = q.orient === 'portrait' ? 'portrait' : 'landscape'
    if (o !== orient.value) orient.value = o
    const n = q.note === '1'
    if (n !== showNote.value) showNote.value = n
    const a: AnsLayout = q.anslayout === 'page' ? 'page' : 'flow'
    if (a !== ansLayout.value) ansLayout.value = a
  },
)
onMounted(() => load())
</script>

<template>
  <div class="ztb-print" :class="{ 'is-landscape': orient === 'landscape' }">
    <div class="ztb-print__toolbar">
      <el-input v-model="date" size="small" style="width: 130px" placeholder="YYYY-MM-DD" />
      <el-button size="small" @click="syncQuery()">换日期</el-button>
      <el-radio-group v-model="orient" size="small">
        <el-radio-button value="landscape">横向</el-radio-button>
        <el-radio-button value="portrait">纵向</el-radio-button>
      </el-radio-group>
      <el-radio-group v-model="mode" size="small">
        <el-radio-button v-for="m in MODES" :key="m.value" :value="m.value">{{ m.label }}</el-radio-button>
      </el-radio-group>
      <el-checkbox v-model="showNote" size="small" style="margin: 0 4px">含备注</el-checkbox>
      <el-radio-group v-model="ansLayout" size="small" :disabled="mode !== 'appendix'">
        <el-radio-button value="flow">答案连着排</el-radio-button>
        <el-radio-button value="page">答案每题一页</el-radio-button>
      </el-radio-group>
      <el-button size="small" type="primary" :disabled="!problems.length" @click="doPrint">
        打印 / 另存为 PDF
      </el-button>
      <span class="ztb-print__tip">
        {{ problems.length }} 页题目（一题一页）· {{ modeHint }}<template
          v-if="mode === 'appendix'"
        >（末尾附答案汇总 + 逐题详解）</template> · 打印对话框里选「另存为 PDF」、缩放「默认」
      </span>
      <el-button size="small" link @click="$router.push({ name: 'zuotiben', query: { date } })">
        回做题本
      </el-button>
    </div>

    <el-alert v-if="error" type="warning" :closable="false" :title="error" style="margin-bottom: 12px" />

    <!-- 一张纸 = 一道题 -->
    <section
      v-for="(p, i) in problems"
      :key="p.id"
      class="ztb-page"
      :class="{ 'has-solution': mode === 'inline' && p.solution }"
    >
      <header class="ztb-page__head">
        <span>{{ day.source || '每日一题做题本' }}</span>
        <span>{{ dayLabel }} · 共 {{ problems.length }} 题</span>
      </header>

      <div class="ztb-page__body">
        <div class="ztb-page__stem">
          <span class="ztb-page__no">{{ p.no }}.</span>
          <span v-if="p.tag" class="ztb-page__tag">【{{ p.tag }}】</span>
          <span v-if="refLabel(p)" class="ztb-page__origin">{{ refLabel(p) }}</span>
          <span class="ztb-page__text">
            <WikiMarkdown :text="stemShowsAnswer ? stemWithAnswer(p) : p.stem" />
          </span>
        </div>

        <div v-if="p.options?.length" class="ztb-page__opts">
          <div v-for="(o, k) in p.options" :key="k" class="ztb-page__opt">
            <WikiMarkdown :text="o" />
          </div>
        </div>
      </div>

      <!-- 留白：手写区，占满剩下的整页 -->
      <div class="ztb-page__blank" />

      <!-- 只有「答案在题里」才把解析印在本页；另外两种格式答案在别处 -->
      <div v-if="mode === 'inline' && p.solution" class="ztb-page__solution">
        <!-- 考点跟着解析走：解析印在哪，考点就出现在哪（题面本身永远不剧透） -->
        <span v-if="p.topic" class="ztb-sheet__topic">{{ p.topic }}</span>
        <b>解析</b>
        <WikiMarkdown :text="p.solution" />
        <p v-if="showNote && p.note" class="ztb-page__note"><b>备注</b>{{ p.note }}</p>
      </div>

      <footer class="ztb-page__foot">{{ i + 1 }}/{{ problems.length }}</footer>
    </section>

    <!-- ========= 答案在后：题面已经印完，这里是这一册最后的答案区 ========= -->
    <template v-if="mode === 'appendix' && problems.length">
      <!-- 第一页：综合答案，一眼扫完 -->
      <section class="ztb-sheet ztb-sheet--answers">
        <header class="ztb-page__head">
          <span>{{ day.source || '每日一题做题本' }} · 答案</span>
          <span>{{ dayLabel }}</span>
        </header>
        <h2 class="ztb-sheet__title">答案</h2>
        <ul class="ztb-sheet__answers">
          <li v-for="p in problems" :key="p.id">
            <span class="ztb-sheet__no">{{ p.no }}.</span>
            <span v-if="p.tag" class="ztb-sheet__tag">【{{ p.tag }}】</span>
            <span class="ztb-sheet__ans"><WikiMarkdown :text="answerOf(p)" /></span>
          </li>
        </ul>
      </section>

      <!-- 之后：逐题详解（不强行一题一页，但一题不跨页） -->
      <section class="ztb-sheet">
        <header class="ztb-page__head">
          <span>{{ day.source || '每日一题做题本' }} · 详解</span>
          <span>{{ dayLabel }}</span>
        </header>
        <h2 class="ztb-sheet__title">详解</h2>
        <article v-for="p in problems" :key="p.id" class="ztb-sheet__item" :class="{ 'is-own-page': ownPage(p) }">
          <div class="ztb-sheet__qhead">
            <span class="ztb-page__no">{{ p.no }}.</span>
            <span v-if="p.tag" class="ztb-page__tag">【{{ p.tag }}】</span>
            <span v-if="refLabel(p)" class="ztb-page__origin">{{ refLabel(p) }}</span>
            <span v-if="p.topic" class="ztb-sheet__topic">{{ p.topic }}</span>
            <span v-if="p.answer" class="ztb-sheet__ans-inline">答案 {{ p.answer }}</span>
          </div>
          <!-- 详解里把题干重述一遍：标准解析册就这么排，光看解析会不知道在解什么 -->
          <div class="ztb-sheet__stem"><WikiMarkdown :text="stemWithAnswer(p)" /></div>
          <div v-if="p.solution" class="ztb-sheet__sol"><WikiMarkdown :text="p.solution" /></div>
          <p v-else class="ztb-sheet__sol">（这条还没有标准解析）</p>
          <p v-if="showNote && p.note" class="ztb-page__note"><b>备注</b>{{ p.note }}</p>
          <p v-if="p.ref?.files?.length" class="ztb-sheet__src">
            溯源：{{ p.ref.files.join('　·　') }}
          </p>
        </article>
      </section>
    </template>
  </div>
</template>
