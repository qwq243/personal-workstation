<script setup lang="ts">
/**
 * 每日一句 · 打印版 —— 一句一页，两种格式（与数学做题本同一套纸面）。
 *
 * 版式沿用同一套纸面（英语这边是「一句一页」）：
 *   页眉左 = 来源，右 = Day 区间；「Day N. 真题出处」+ 原句；下面整页留白手写；页脚 = 页码。
 *
 * 两种格式（**没有「答案在本页」**，2026-09-29 实测定的）：
 *   参考译文 + 结构划分 + 语法重点合起来三十来行，横放 A4 一页塞不下，硬塞必然续到第二页
 *   （实测 3 句导出 6 页）—— 那就把「一句一页」打脸了。所以只留两种能兑现承诺的：
 *   blank    纯句子纸（默认）：只有原句，答案不出现 —— 印出来手写。
 *   appendix 答案在后：句子全空；末尾**先一页译文汇总，再逐句详解**（详解自然连排）。
 *
 * 纸面与打印 CSS 走共用的 `print-sheet.css`、每页高度走 `print-page.ts` ——
 * 这两份别在页面里另写一套（外壳覆盖那几处漏了就打不出整页）。
 */
import { onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, ensureSidecar } from '@/core/sidecar'
import { sheetPageCss, type Orient } from './print-page'
// 译文里的 `$80\%$` 这类 LaTeX 要排出来（与屏幕版同一套渲染）
import { renderDollarMath } from '@/features/wiki/math-typeset'
import 'katex/dist/katex.min.css'
import './print-sheet.css'

type Mode = 'blank' | 'appendix'
type AnsLayout = 'flow' | 'page'

const route = useRoute()
const router = useRouter()

const ready = ref(false)
const error = ref('')
const source = ref('')
const items = ref<any[]>([])
const total = ref(0)

/** 起点/终点都按 Day 号说（这本册子没有日期，只有句子的序号） */
const from = ref(Math.max(1, Number(route.query.from ?? 0) || 1))
const to = ref(Math.max(0, Number(route.query.to ?? 0) || 0))

/** 地址栏优先：mode=blank|appendix（老的 inline 链接按 blank 处理） */
function initialMode(): Mode {
  return route.query.mode === 'appendix' ? 'appendix' : 'blank'
}
const mode = ref<Mode>(initialMode())
/** 方向默认横向 —— 与数学册一致，平板横屏做题用 */
const orient = ref<Orient>(route.query.orient === 'portrait' ? 'portrait' : 'landscape')
/** 词汇要不要一起印。默认不印：它不是答案，但先把词摆出来等于给了半个提示 */
const showVocab = ref(route.query.vocab === '1')
/** 详解怎么排：flow 连着排（一题不跨页）· page 每条独占一页 */
const ansLayout = ref<AnsLayout>(route.query.anslayout === 'page' ? 'page' : 'flow')
/** 超过这个字数就当「一条占大半页」，让它独占一页（按横放 A4 的容量粗估，与数学册同值） */
const LONG_SOLUTION = 420

const MODES: { value: Mode; label: string; hint: string }[] = [
  { value: 'blank', label: '纯句子纸', hint: '答案不出现，印出来手写' },
  { value: 'appendix', label: '答案在后', hint: '句子全空，末尾先译文汇总、再逐句详解' },
]

const pageCss = sheetPageCss(orient)

function lines(v: any): string[] {
  return Array.isArray(v) ? v.filter((x) => String(x ?? '').trim()) : []
}
/** 这一句有没有可印的答案 —— 材料本身可能缺项 */
function hasAnswer(it: any) {
  return !!(it?.refTranslation || lines(it?.structure).length || lines(it?.grammar).length)
}
/** 这条详解要不要独占一页 */
function ownPage(it: any) {
  if (ansLayout.value === 'page') return true
  const n = String(it?.refTranslation ?? '').length + lines(it?.structure).join('').length + lines(it?.grammar).join('').length
  return n > LONG_SOLUTION
}
/** 汇总页一行：译文取第一段（长的在详解里读） */
function translationOf(it: any) {
  const t = String(it?.refTranslation ?? '').trim()
  return t || '（这一句资料里没有参考译文）'
}

async function load() {
  error.value = ''
  const ok = await ensureSidecar()
  ready.value = ok
  if (!ok) return
  try {
    const cur: any = await api.englishDaily()
    total.value = Number(cur?.data?.total) || 0
    if (!to.value) to.value = Math.min(total.value || from.value + 9, (from.value || 1) + 9)
    const r: any = await api.englishDailySheet(from.value, to.value)
    if (r?.ok === false) throw new Error(r.error || '读取失败')
    const d = r.data ?? { items: [] }
    items.value = d.items ?? []
    source.value = d.source ?? ''
    from.value = d.from ?? from.value
    to.value = d.to ?? to.value
    if (!items.value.length) error.value = `Day ${from.value}–${to.value} 还没有句子`
  } catch (e: any) {
    error.value = e?.message || String(e)
  }
}

function syncQuery() {
  router.replace({
    name: 'zuotiben-sentence-print',
    query: {
      from: String(from.value),
      to: String(to.value),
      ...(mode.value === 'blank' ? {} : { mode: mode.value }),
      ...(orient.value === 'landscape' ? {} : { orient: orient.value }),
      ...(showVocab.value ? { vocab: '1' } : {}),
      ...(ansLayout.value === 'flow' ? {} : { anslayout: ansLayout.value }),
    },
  })
}

function doPrint() {
  window.print()
}

watch([from, to], () => load())
watch([mode, orient, showVocab, ansLayout], syncQuery)
// 地址栏里换参数（工具栏按钮走的是 replace）时也要跟着变
watch(
  () => route.query,
  (q) => {
    const f = Number(q.from ?? 0)
    if (f && f !== from.value) from.value = f
    const t = Number(q.to ?? 0)
    if (t && t !== to.value) to.value = t
    // 老链接里的 mode=inline 一律按 blank 处理（那个格式已经撤了，见文件头注释）
    const next: Mode = q.mode === 'appendix' ? 'appendix' : 'blank'
    if (next !== mode.value) mode.value = next
    const o: Orient = q.orient === 'portrait' ? 'portrait' : 'landscape'
    if (o !== orient.value) orient.value = o
    const v = q.vocab === '1'
    if (v !== showVocab.value) showVocab.value = v
    const a: AnsLayout = q.anslayout === 'page' ? 'page' : 'flow'
    if (a !== ansLayout.value) ansLayout.value = a
  },
)
onMounted(() => load())
</script>

<template>
  <div class="ztb-print" :class="{ 'is-landscape': orient === 'landscape' }">
    <div class="ztb-print__toolbar">
      <span class="snt-print__lbl">Day</span>
      <el-input-number v-model="from" size="small" :min="1" :max="total || 999" controls-position="right" style="width: 100px" />
      <span class="snt-print__lbl">–</span>
      <el-input-number v-model="to" size="small" :min="1" :max="total || 999" controls-position="right" style="width: 100px" />
      <el-button size="small" @click="load()">换范围</el-button>
      <el-radio-group v-model="orient" size="small">
        <el-radio-button value="landscape">横向</el-radio-button>
        <el-radio-button value="portrait">纵向</el-radio-button>
      </el-radio-group>
      <el-radio-group v-model="mode" size="small">
        <el-radio-button v-for="m in MODES" :key="m.value" :value="m.value">{{ m.label }}</el-radio-button>
      </el-radio-group>
      <el-checkbox v-model="showVocab" size="small" style="margin: 0 4px">含词汇</el-checkbox>
      <el-radio-group v-model="ansLayout" size="small" :disabled="mode !== 'appendix'">
        <el-radio-button value="flow">答案连着排</el-radio-button>
        <el-radio-button value="page">答案每句一页</el-radio-button>
      </el-radio-group>
      <el-button size="small" type="primary" :disabled="!items.length" @click="doPrint">
        打印 / 另存为 PDF
      </el-button>
      <span class="ztb-print__tip">
        <template v-if="mode === 'appendix'">{{ items.length }} 页空白句子 + 末尾附译文汇总与逐句详解</template>
        <template v-else>{{ items.length }} 页空白句子（一句一页，不带答案）</template>
        · 打印对话框里选「另存为 PDF」、缩放「默认」
      </span>
      <el-button size="small" link @click="$router.push({ name: 'zuotiben-sentence', query: { from, to } })">
        回每日一句
      </el-button>
    </div>

    <el-alert v-if="error" type="warning" :closable="false" :title="error" style="margin-bottom: 12px" />

    <!-- 一张纸 = 一句。两种格式下这一页都是**空白句子**（答案只在「答案在后」的末尾出现） -->
    <section v-for="(it, i) in items" :key="it.day" class="ztb-page">
      <header class="ztb-page__head">
        <span>{{ source || '每日一句' }}</span>
        <span>Day {{ from }}–{{ to }}</span>
      </header>

      <div class="ztb-page__body">
        <div class="ztb-page__stem">
          <!-- 句号前面带「Day」：纸面上单看一个「12.」会跟题号混起来 -->
          <span class="ztb-page__no">Day {{ it.day }}.</span>
          <span v-if="it.source" class="ztb-page__origin">真题 {{ it.source }}</span>
          <p class="ztb-page__sent" v-html="renderDollarMath(it.text)" />
        </div>

        <!-- 词汇：可选（默认不印，先让人自己读原句） -->
        <div v-if="showVocab && it.vocab?.length" class="snt-vocab">
          <span v-for="(v, k) in it.vocab" :key="k" class="snt-vocab__word">
            <b>{{ v.term || v.meaning }}</b><template v-if="v.pos"> {{ v.pos }}</template
            ><template v-if="v.term && v.meaning"> {{ v.meaning }}</template>
          </span>
        </div>
      </div>

      <!-- 留白：手写区，占满整页（这一页就是给人写译文的） -->
      <div class="ztb-page__blank" />

      <footer class="ztb-page__foot">{{ i + 1 }}/{{ items.length }}</footer>
    </section>

    <!-- ========= 答案在后：句子已经印完，这里是这一册最后的答案区 ========= -->
    <template v-if="mode === 'appendix' && items.length">
      <!-- 第一页：译文汇总，一眼扫完 -->
      <section class="ztb-sheet ztb-sheet--answers">
        <header class="ztb-page__head">
          <span>{{ source || '每日一句' }} · 参考译文</span>
          <span>Day {{ from }}–{{ to }}</span>
        </header>
        <h2 class="ztb-sheet__title">参考译文</h2>
        <ul class="ztb-sheet__answers">
          <li v-for="it in items" :key="it.day">
            <span class="ztb-sheet__no">Day {{ it.day }}</span>
            <span class="ztb-sheet__ans" v-html="renderDollarMath(translationOf(it))" />
          </li>
        </ul>
      </section>

      <!-- 之后：逐句详解（不强行一句一页，但一句不跨页） -->
      <section class="ztb-sheet">
        <header class="ztb-page__head">
          <span>{{ source || '每日一句' }} · 详解</span>
          <span>Day {{ from }}–{{ to }}</span>
        </header>
        <h2 class="ztb-sheet__title">详解</h2>
        <article v-for="it in items" :key="it.day" class="ztb-sheet__item" :class="{ 'is-own-page': ownPage(it) }">
          <div class="ztb-sheet__qhead">
            <span class="ztb-page__no">Day {{ it.day }}.</span>
            <span v-if="it.source" class="ztb-page__origin">真题 {{ it.source }}</span>
          </div>
          <!-- 详解里把原句重述一遍：光看解析会不知道在解什么 -->
          <p class="ztb-sheet__stem" v-html="renderDollarMath(it.text)" />
          <div v-if="showVocab && it.vocab?.length" class="snt-vocab snt-vocab--sheet">
            <span v-for="(v, k) in it.vocab" :key="k" class="snt-vocab__word">
              <b>{{ v.term || v.meaning }}</b><template v-if="v.pos"> {{ v.pos }}</template
              ><template v-if="v.term && v.meaning"> {{ v.meaning }}</template>
            </span>
          </div>
          <p class="snt-sol__row">
            <b>参考译文</b><span v-html="renderDollarMath(translationOf(it))" />
          </p>
          <div v-if="lines(it.structure).length" class="snt-sol__pre">
            <b>结构划分</b><span v-html="renderDollarMath(lines(it.structure).join('\n'), { breaks: true })" />
          </div>
          <div v-if="lines(it.grammar).length" class="snt-sol__pre">
            <b>语法重点</b><span v-html="renderDollarMath(lines(it.grammar).join('\n'), { breaks: true })" />
          </div>
          <p v-if="!hasAnswer(it)" class="ztb-sheet__sol">（这一句资料里没有答案）</p>
        </article>
      </section>
    </template>
  </div>
</template>

<style scoped>
/* 这页自己的块带 snt- 前缀（ztb-page / ztb-sheet / ztb-print 是两份册子共用的纸面） */
.snt-print__lbl {
  font-size: 12.5px;
  color: var(--ws-text-2);
  margin-right: -4px;
}
/* 原句：纸面上要一眼看清句子结构，行距给足 */
.ztb-page__sent {
  margin: 4px 0 0;
  font-size: 16.5px;
  line-height: 2.05;
  color: #111;
}
.snt-vocab {
  margin-top: 4mm;
  font-size: 12px;
  line-height: 1.8;
  color: #374151;
}
.snt-vocab--sheet {
  margin: 2px 0 4px;
}
.snt-vocab__word {
  margin-right: 10px;
  white-space: nowrap;
}
.snt-sol__row {
  margin: 0 0 2mm;
  font-size: 13.5px;
  line-height: 1.9;
  color: #111;
}
.snt-sol__row b,
.snt-sol__pre b {
  font-weight: 700;
  color: #4338ca;
  margin-right: 5px;
}
.snt-sol__pre {
  margin-bottom: 2mm;
  font-size: 13px;
  line-height: 1.85;
  color: #1f2937;
}
/* 译文汇总：一行一句（中英对照是长句，三列会挤成一团，盖掉共用那份的三列） */
.ztb-sheet__answers {
  grid-template-columns: 1fr;
  font-size: 14px;
  line-height: 1.9;
}
.ztb-sheet__answers li {
  border-bottom: 0;
  display: block;
}
.ztb-sheet__answers .ztb-sheet__no {
  display: inline-block;
  min-width: 62px;
  margin-right: 6px;
  color: #4338ca;
}
</style>
