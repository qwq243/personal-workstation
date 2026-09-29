<script setup lang="ts">
/**
 * 做题本 —— 每日一题。
 *
 * 为什么不是「把题列出来」：2026-09-27 定的规矩 —— 题目**不能一堆聚合在一条消息里**，
 * 要按纸质做题本的样子给：**一题一份、题干在上、下面留够写的位置**，
 * 能一题一页打印出来在平板上手写。
 *
 * 收起答案时这一页就是「印出来的那份」；点「展开全部答案」才换成带答案的题干 + 标准解析。
 * **答案写在题干原本的空位里**（选择题进「（　）」、填空题进「______」），
 * 所以解析区只有解析，不再单列一行「答案」——见 answer-inline.ts。
 *
 * 数据来自边车 `/api/zuotiben/*`（server/lib/zuotiben.mjs）；
 * 智能体用 MCP `add_problems` 往这里灌题，灌完就在这一页看到，不用手工抄。
 *
 * 卡片 / 留白 / 档位 / 导出弹窗那套版式抽在 `book.css`（英语「每日一句」的做题本共用一份），
 * 这一页的样式只留「最近几天」那排日期链接。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PageHeader from '@/components/PageHeader.vue'
import SidecarOffline from '@/components/SidecarOffline.vue'
import WikiMarkdown from '@/features/wiki/WikiMarkdown.vue'
import { api, ensureSidecar } from '@/core/sidecar'
import { stemWithAnswer } from './answer-inline'
import { downloadPdf } from './export-download'
import './book.css'

const route = useRoute()
const router = useRouter()

const ready = ref(false)
const loading = ref(false)
const error = ref('')
const date = ref(String(route.query.date ?? '') || dayStr())
const day = ref<any>({ date: '', source: '每日一题做题本', problems: [] })
const recent = ref<any[]>([])
/**
 * 哪几道题展开了答案。
 * 三种触发方式都落到这个表上，语义统一：**点某题的留白区**切那一题、
 * 右上按钮整册一起切、地址栏 `?answers=1` 表示「全部展开」（可分享/存书签）。
 */
const revealed = ref<Record<string, boolean>>({})
/** 备注的本地草稿：边打字边存会把接口打满，失焦或按「存备注」才提交 */
const noteDraft = ref<Record<string, string>>({})
const noteSaving = ref('')

function dayStr(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const problems = computed<any[]>(() => day.value.problems ?? [])
/** 按「做对 / 做错 / 还没做」三档统计 —— 跟下面那两颗按钮的说法保持一致 */
const stat = computed(() => {
  const wrong = problems.value.filter((p) => p.done && p.wrong).length
  const right = problems.value.filter((p) => p.done && !p.wrong).length
  return { total: problems.value.length, right, wrong, left: problems.value.length - right - wrong }
})
const isEmpty = computed(() => ready.value && !loading.value && stat.value.total === 0)
const answerCount = computed(() => problems.value.filter((p) => p.solution || p.answer).length)
/** 全部展开 / 还有没收起的，决定右上按钮是「展开」还是「收起」 */
const allRevealed = computed(
  () => problems.value.length > 0 && problems.value.every((p) => revealed.value[p.id]),
)

function isRevealed(p: any) {
  return !!revealed.value[p.id]
}

/** 点某题的留白区：只切这一题 —— 做完一题对一题，不用去右上角按按钮 */
function toggleOne(p: any) {
  revealed.value = { ...revealed.value, [p.id]: !revealed.value[p.id] }
}

/**
 * 这道题的结果：'' 没标 / 'right' 做对 / 'wrong' 做错。
 *
 * 界面上是**做对 / 做错二选一**（用户 2026-09-27 定：就打个勾和个叉），
 * 但存储仍用原有的两个字段表达，不动数据结构：
 *   做对 = done 且没错；做错 = done 且 wrong；没标 = 没 done。
 */
function resultOf(p: any): 'right' | 'wrong' | '' {
  if (!p?.done) return ''
  return p.wrong ? 'wrong' : 'right'
}

/** 点「做对」/「做错」：切换到那个结果；**再点当前那个就取消**（回到没标） */
function markResult(p: any, want: 'right' | 'wrong') {
  const next = resultOf(p) === want ? '' : want
  patch(p, { done: next !== '', wrong: next === 'wrong' })
}

function toggleAll() {
  const target = !allRevealed.value
  const next: Record<string, boolean> = {}
  for (const p of problems.value) next[p.id] = target
  revealed.value = next
}

/** 整册展开/收起（给地址栏参数用） */
function revealAll(flag: boolean) {
  const next: Record<string, boolean> = {}
  for (const p of problems.value) next[p.id] = flag
  revealed.value = next
}

/**
 * @param withSpin   显示 loading
 * @param resetReveal 重置「哪些题展开了答案」—— 只在首次进入和换天时为 true。
 *   勾「做过/做错」、存备注之后也要重新读一遍数据，那时候**不能**重置，
 *   否则正在看的解析会被自己收起来。
 */
async function load(withSpin = false, resetReveal = false) {
  if (withSpin) loading.value = true
  error.value = ''
  try {
    const ok = await ensureSidecar()
    ready.value = ok
    if (!ok) return
    const r: any = await api.zuotibenDay(date.value)
    if (r?.ok === false) throw new Error(r.error || '读取失败')
    // 注意：call() 把整个响应体包在 data 里，不是摊平的
    day.value = r.data ?? { date: date.value, source: '', problems: [] }
    const l: any = await api.zuotibenDays()
    recent.value = l?.data?.days ?? []
    // 换天时把备注草稿重置成该天自己的备注
    noteDraft.value = {}
    for (const p of problems.value) noteDraft.value[p.id] = p.note ?? ''
    if (resetReveal) revealAll(route.query.answers === '1')
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally {
    loading.value = false
  }
}
watch(date, () => load(true, true))
// 日期与「是否全展开」都反映到地址栏（可分享、刷新不丢）
watch([date, allRevealed], () => {
  router.replace({
    name: 'zuotiben',
    query: { date: date.value, ...(allRevealed.value ? { answers: '1' } : {}) },
  })
})
onMounted(() => load(true, true))

async function patch(p: any, body: Record<string, any>, spinning = '') {
  if (spinning) noteSaving.value = spinning
  try {
    const r: any = await api.zuotibenUpdate(p.date || date.value, p.id, body)
    if (r?.ok === false) throw new Error(r.error || '保存失败')
    await load()
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally {
    noteSaving.value = ''
  }
}

/** 备注：只在内容真的变了的时候提交 */
async function saveNote(p: any) {
  const draft = (noteDraft.value[p.id] ?? '').trim()
  if (draft === (p.note ?? '').trim()) return
  await patch(p, { note: draft }, p.id)
}

/**
 * 导出是**服务端真出文件**（边车调本机 Chrome 的 `--print-to-pdf`），
 * 拿回来是 PDF 字节，前端转成 blob 触发下载 —— 所以点一下直接进「下载」，
 * 不会像 `window.open` 那样先跳一个页面出来（用户反馈过一次）。
 * 生成要十几秒，必须给 loading，否则会以为没反应又点一遍。
 */
const exportOpen = ref(false)
const exporting = ref(false)
const exportOpts = ref({ mode: 'blank', orient: 'landscape', note: false, ansLayout: 'flow' })

const EXPORT_MODES = [
  { value: 'blank', label: '纯题目纸', hint: '答案不出现，印出来手写' },
  { value: 'inline', label: '答案在题里', hint: '答案填进题干空位，解析印在本页' },
  { value: 'appendix', label: '答案在后', hint: '题面全空，末尾先答案汇总再逐题详解' },
]

/** 预览用第一题（有题才有预览，没题时预览区显示空态） */
const previewP = computed<any>(() => problems.value[0] ?? { stem: '（这一天还没有题）', options: [] })

/**
 * 预览里的选项走纯文本（去掉 `$` 定界符）。
 * 缩略图不需要真公式，而 KaTeX 的行盒会把每个选项撑成两三行 —— 四个选项吃掉 85px，
 * 「写作用」那块留白就被挤没了（实测纸的留白只剩 34px，主体都没了）。
 */
/** 常见 LaTeX → 人读的符号。只求缩略图看得懂，不追求完整（真排版在打印页里） */
const TEX_PLAIN: Array<[RegExp, string]> = [
  [/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '$1/$2'],
  [/\\sqrt\s*\{([^{}]*)\}/g, '√($1)'],
  [/\\left|\\right/g, ''],
  [/\\(sin|cos|tan|arctan|ln|log|exp|max|min|lim)\b/g, '$1'],
  [/\\neq/g, '≠'],
  [/\\leqslant|\\le\b/g, '≤'],
  [/\\geqslant|\\ge\b/g, '≥'],
  [/\\pm/g, '±'],
  [/\\cdot/g, '·'],
  [/\\times/g, '×'],
  [/\\infty/g, '∞'],
  [/\\to\b|\\rightarrow/g, '→'],
  [/\\pi\b/g, 'π'],
  [/\\var(phi|epsilon|theta|sigma|lambda|alpha|beta|gamma|mu)/g, '$1'],
  [/\^\{([^{}]*)\}/g, '^($1)'],
  [/_\{([^{}]*)\}/g, '_($1)'],
  [/\\[,;! ]/g, ' '],
]

function previewPlain(s: string) {
  let t = String(s ?? '').replace(/\$/g, '')
  for (const [re, to] of TEX_PLAIN) t = t.replace(re as RegExp, to as string)
  // 剩下没覆盖到的命令（\xxx）去反斜杠，别把反斜杠露在缩略图上
  return t
    .replace(/\\[a-zA-Z]+/g, (m) => m.slice(1))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 预览里那句解析要截断，但**不能把 $...$ 从中间切断** ——
 * KaTeX 拿到半个公式会整段退回裸文本，预览里就会露出 `$g(a)\neq 0$` 这种原文（踩过一次）。
 * 所以截断后如果 `$` 的个数是奇数，就退到最后一个 `$` 之前。
 */
function previewText(s: string, n = 52) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  if (t.length <= n) return t
  let cut = t.slice(0, n)
  if ((cut.match(/\$/g) ?? []).length % 2 === 1) cut = cut.slice(0, cut.lastIndexOf('$'))
  return `${cut.trim()}…`
}

/** 预览底下那一句：说清「答案在哪儿、一共几页」，别写成长篇说明 */
const previewNote = computed(() => {
  const n = stat.value.total
  if (!n) return '这一天还没有题'
  if (exportOpts.value.mode === 'blank') return `共 ${n} 题，一题一页（${n} 页）· 不带答案`
  if (exportOpts.value.mode === 'inline') return `共 ${n} 题，一题一页（${n} 页）· 答案与解析印在每页题目下面`
  return `共 ${n + 1} 页题目与答案 + 详解 ${exportOpts.value.ansLayout === 'page' ? '（每题一页）' : '（连着排）'}`
})

async function doExport() {
  if (exporting.value) return
  exporting.value = true
  error.value = ''
  try {
    const url = await api.zuotibenExportUrl({ date: date.value, ...exportOpts.value })
    // 「取字节 → 触发下载」这一步两份册子共用（见 export-download.ts）
    await downloadPdf(url, `做题本_${date.value}.pdf`)
    exportOpen.value = false
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally {
    exporting.value = false
  }
}

function kindLabel(k: string) {
  return k === 'choice' ? '选择' : k === 'fill' ? '填空' : '解答'
}
</script>

<template>
  <div class="ztb">
    <SidecarOffline v-if="ready === false" />

    <PageHeader title="做题本" subtitle="一题一份：题干在上，下面留白手写；打印一题一页" icon="EditPen" compact>
      <template #actions>
        <div class="ws-tools">
        <el-date-picker
          v-model="date"
          type="date"
          value-format="YYYY-MM-DD"
          size="default"
          style="width: 150px"
        />
        <el-button size="default" @click="date = dayStr()">今天</el-button>
        <!-- 另一本册子：英语「每日一句」，版式与导出同一套（一句一页）。
             用户是按「做题本」这件事来找它的，所以入口放在这一页右上（2026-09-29）。 -->
        <el-button size="default" @click="router.push('/zuotiben/sentence')">
          <el-icon><component is="Reading" /></el-icon>
          <span style="margin-left: 4px">每日一句</span>
        </el-button>
        <el-button
          size="default"
          :type="allRevealed ? 'warning' : 'default'"
          :disabled="!stat.total"
          @click="toggleAll"
        >
          {{ allRevealed ? '收起全部答案' : '展开全部答案' }}
        </el-button>
        <el-button size="default" type="primary" :disabled="!stat.total" @click="exportOpen = true">
          <el-icon><component is="Download" /></el-icon>
          <span style="margin-left: 4px">导出 PDF</span>
        </el-button>
        <el-button size="default" :loading="loading" @click="load(true)">刷新</el-button>
        </div>
      </template>
    </PageHeader>

    <el-alert v-if="error" type="error" :closable="false" :title="error" style="margin-bottom: 12px" />

    <div class="ztb__bar">
      <span class="ztb__src">{{ day.source || '每日一题做题本' }}</span>
      <span class="ztb__count">
        共 {{ stat.total }} 题
        <b v-if="stat.right" class="is-right"> · 做对 {{ stat.right }}</b>
        <b v-if="stat.wrong" class="is-wrong"> · 做错 {{ stat.wrong }}</b>
        <b v-if="stat.left" class="is-left"> · 还剩 {{ stat.left }}</b>
      </span>
      <span v-if="answerCount" class="ztb__hintline">
        <span class="ws-hide-sm">本册标准解析 {{ answerCount }} 题 —— 点下面的留白区看这一题，或右上「{{ allRevealed ? '收起全部答案' : '展开全部答案' }}」</span>
        <span class="ws-only-sm">标准解析 {{ answerCount }} 题 · 点留白区看答案</span>
      </span>
      <span v-if="recent.length" class="ztb__recent">
        最近：
        <a
          v-for="d in recent.slice(0, 6)"
          :key="d.date"
          :class="{ 'is-active': d.date === date }"
          @click="date = d.date"
        >
          {{ d.date.slice(5) }}<i v-if="d.total">({{ d.done }}/{{ d.total }})</i>
        </a>
      </span>
    </div>

    <el-empty v-if="isEmpty" description="这一天还没有题">
      <p class="ztb__hint">
        题是智能体用 MCP <code>add_problems</code> 灌进来的；也可以换上面日期看别的天。<br />
        灌进来之后，用「打印 / 存 PDF」得到一题一页的纸面，在平板上手写。
      </p>
    </el-empty>

    <!-- 一题一卡：题干在上，留白在下 -->
    <article
      v-for="p in problems"
      :key="p.id"
      class="ztb__card"
      :class="{ 'is-right': resultOf(p) === 'right', 'is-wrong': resultOf(p) === 'wrong' }"
    >
      <header class="ztb__head">
        <span class="ztb__no">第 {{ p.no }} 题</span>
        <span v-if="p.tag" class="ztb__tag">【{{ p.tag }}】</span>
        <!-- 溯源：优先用结构化的 ref.label（从原文取的，章号题号不会抄错） -->
        <span v-if="p.ref?.label || p.origin" class="ztb__origin" :title="p.ref?.files?.join(' · ') || ''">
          {{ p.ref?.label || p.origin }}
        </span>
        <!--
          **考点标签默认不显示**（用户 2026-09-27：看见「乘积可导」就知道该用什么方法了，
          等于把题做废了）。点出答案时才跟着解析一起出现；「展开全部答案」会一起亮。
          另一种可以直接亮的情况：这题**已经标过做对/做错**了（做过一遍不算剧透）。
          收起状态且没标过的，**连个占位点都别留** —— 这条是明说过的，别顺手改回常显。
        -->
        <span v-if="p.topic && (isRevealed(p) || resultOf(p))" class="ztb__topic">{{ p.topic }}</span>
        <span class="ztb__kind">{{ kindLabel(p.kind) }}</span>
        <!--
          结果只**显示**在这里（跟着标签流排，不做右对齐）；
          点它的入口在留白区正下方那两颗大按钮 —— 最右侧那两颗平板上够不着。
        -->
        <span v-if="resultOf(p) === 'wrong'" class="ztb__state is-wrong">✕ 做错</span>
        <span v-else-if="resultOf(p) === 'right'" class="ztb__state is-right">✓ 做对</span>
      </header>

      <!-- 展开答案时题干换成带答案的那份：选择填进（　），填空填到 ______ 上 -->
      <div class="ztb__stem">
        <WikiMarkdown :text="isRevealed(p) ? stemWithAnswer(p) : p.stem" />
      </div>

      <ol v-if="p.options?.length" class="ztb__opts">
        <li v-for="(o, i) in p.options" :key="i">
          <WikiMarkdown :text="o" />
        </li>
      </ol>

      <!--
        留白区：这一块既是「做题本」的本体，也是**点一下就出答案**的开关，
        而且**解析就出在这块区域里**（2026-09-27 用户要求：解析出现在横线上，不是另起一块放在下面）。
        所以整块可点、解析渲染在内部；展开时把横线隐掉，否则文字与线距对不齐会显得很乱。
      -->
      <div
        class="ztb__work"
        :class="{ 'is-open': isRevealed(p) }"
        role="button"
        :title="isRevealed(p) ? '点一下收起答案' : '点一下看答案'"
        @click="toggleOne(p)"
      >
        <template v-if="isRevealed(p)">
          <div class="ztb__work-sol">
            <b>解析</b>
            <WikiMarkdown v-if="p.solution" :text="p.solution" />
            <span v-else class="ztb__hint">这条还没有标准解析</span>
          </div>
        </template>
        <span v-else class="ztb__work-hint">写作用</span>
        <span class="ztb__work-toggle">{{ isRevealed(p) ? '收起答案 ▴' : '点这里看答案 ▾' }}</span>
      </div>

      <!--
        做对 / 做错：留白（解析）区正下方 —— 手写和看解析的视线落点就在这儿，手指也够得着。
        用原生 button 自己描样式：Element 的按钮底色太实，两颗摆一起像两块色卡，很丑。
        这里没选中是白底细边（安静），选中才上颜色（绿=对、红=错），再点一次取消。
      -->
      <div class="ztb__marks">
        <span class="ztb__marks-label">这道题</span>
        <button
          type="button"
          class="ztb__mark"
          :class="{ 'is-right': resultOf(p) === 'right' }"
          :aria-pressed="resultOf(p) === 'right'"
          @click="markResult(p, 'right')"
        >
          <span class="ztb__mark-ico">✓</span>
          <span>做对</span>
        </button>
        <button
          type="button"
          class="ztb__mark"
          :class="{ 'is-wrong': resultOf(p) === 'wrong' }"
          :aria-pressed="resultOf(p) === 'wrong'"
          @click="markResult(p, 'wrong')"
        >
          <span class="ztb__mark-ico">✕</span>
          <span>做错</span>
        </button>
        <span class="ztb__marks-tip">{{ resultOf(p) ? '再点一次可取消' : '做完点一下' }}</span>
      </div>

      <!-- 备注：做错原因 / 自己想记的话。解析在上面那块里，别混 -->
      <div class="ztb__note">
        <el-input
          v-model="noteDraft[p.id]"
          type="textarea"
          :rows="2"
          resize="none"
          :placeholder="p.wrong ? '做错的原因（为什么错、错在哪一步）' : '备注（可选）'"
          @blur="saveNote(p)"
        />
        <el-button
          v-if="(noteDraft[p.id] ?? '') !== (p.note ?? '')"
          size="small"
          type="primary"
          link
          :loading="noteSaving === p.id"
          @click="saveNote(p)"
        >存备注</el-button>
      </div>
    </article>

    <!--
      导出：左边设置、右边预览（用户 2026-09-27 要的版式；工具栏上不再单独放「预览」入口）。
      控件一律用自定义的分段按钮/卡片行，**不用 el-radio-group**：
      el-radio 的 direction="vertical" 在这里不生效（三个格式会挤成一行），
      而且它的圆点尺寸和分段按钮不搭，摆一起显得很乱。
    -->
    <el-dialog v-model="exportOpen" title="导出做题本 PDF" width="740px" append-to-body class="ztb__dlg">
      <div class="ztb__exp">
        <div class="ztb__exp-left">
          <div class="ztb__opt">
            <div class="ztb__opt-label">方向</div>
            <div class="ztb__seg2">
              <button
                v-for="o in [{ v: 'landscape', t: '横向' }, { v: 'portrait', t: '纵向' }]"
                :key="o.v"
                type="button"
                class="ztb__seg2-btn"
                :class="{ 'is-on': exportOpts.orient === o.v }"
                @click="exportOpts.orient = o.v as 'landscape' | 'portrait'"
              >{{ o.t }}</button>
            </div>
          </div>

          <div class="ztb__opt">
            <div class="ztb__opt-label">格式</div>
            <div class="ztb__cards">
              <button
                v-for="m in EXPORT_MODES"
                :key="m.value"
                type="button"
                class="ztb__fcard"
                :class="{ 'is-on': exportOpts.mode === m.value }"
                @click="exportOpts.mode = m.value"
              >
                <span class="ztb__fcard-dot" />
                <span class="ztb__fcard-text">
                  <span class="ztb__fcard-title">{{ m.label }}</span>
                  <span class="ztb__fcard-hint">{{ m.hint }}</span>
                </span>
              </button>
            </div>
          </div>

          <div class="ztb__opt">
            <div class="ztb__opt-label">答案排版</div>
            <div class="ztb__seg2" :class="{ 'is-off': exportOpts.mode !== 'appendix' }">
              <button
                v-for="a in [{ v: 'flow', t: '连着排' }, { v: 'page', t: '每题一页' }]"
                :key="a.v"
                type="button"
                class="ztb__seg2-btn"
                :class="{ 'is-on': exportOpts.ansLayout === a.v }"
                :disabled="exportOpts.mode !== 'appendix'"
                @click="exportOpts.ansLayout = a.v as 'flow' | 'page'"
              >{{ a.t }}</button>
            </div>
          </div>

          <div class="ztb__opt ztb__opt--last">
            <el-checkbox v-model="exportOpts.note">连我的备注一起印</el-checkbox>
          </div>
        </div>

        <div class="ztb__exp-right">
          <div class="ztb__exp-right-title">预览 · 第 1 页</div>
          <div class="ztb__paper" :class="{ 'is-land': exportOpts.orient === 'landscape' }">
            <div class="ztb__paper-head">
              <span>{{ day.source || '每日一题做题本' }}</span>
              <span>{{ date }}</span>
            </div>
            <div class="ztb__paper-no">
              {{ previewP.no }}.
              <span v-if="previewP.tag">【{{ previewP.tag }}】</span>
              <span class="ztb__paper-ref">{{ previewP.ref?.label || previewP.origin }}</span>
            </div>
            <div class="ztb__paper-stem">
              <WikiMarkdown :text="exportOpts.mode === 'inline' ? stemWithAnswer(previewP) : previewP.stem" />
            </div>
            <div v-if="previewP.options?.length" class="ztb__paper-opts">
              <span v-for="(o, i) in previewP.options" :key="i">{{ previewPlain(o) }}</span>
            </div>
            <div class="ztb__paper-blank" />
            <div v-if="exportOpts.mode === 'inline' && previewP.solution" class="ztb__paper-sol">
              <b>解析</b><WikiMarkdown :text="previewText(previewP.solution)" />
            </div>
            <div class="ztb__paper-foot">1/{{ stat.total }}</div>
          </div>
          <p class="ztb__exp-note">{{ previewNote }}</p>
        </div>
      </div>

      <template #footer>
        <el-button @click="exportOpen = false">取消</el-button>
        <el-button type="primary" :loading="exporting" @click="doExport">
          {{ exporting ? '正在生成…' : '导出并下载' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* 只留数学册自己的东西：最近几天那排日期链接。
   .ztb 外框、信息行、.ztb__hint 都在 book.css（英语册也用它，见文件头注释）。 */
.ztb__recent a {
  cursor: pointer;
  margin-right: 8px;
  color: var(--ws-accent, #4f46e5);
}
.ztb__recent a.is-active {
  font-weight: 700;
  text-decoration: underline;
}
.ztb__recent a i {
  font-style: normal;
  opacity: 0.6;
}
</style>
