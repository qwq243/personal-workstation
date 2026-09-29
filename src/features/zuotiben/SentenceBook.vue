<script setup lang="ts">
/**
 * 每日一句做题本 —— 英语那句也按做题本的样子给（2026-09-29 用户要的）。
 *
 * 版式与数学册是同一套（`book.css`）：**一句一份、原文在上、下面留白手写**，
 * 点留白区出答案（参考译文 / 结构划分 / 语法重点），也能一句一页打印出来在平板上写。
 * 入口两处：做题本页右上角的「每日一句」，以及看板「英语每日一句」卡片上的「做题本 ›」。
 *
 * 与「英语学习 → 每日一句」那页的分工：那页是**打字练习**（写翻译 → 核对 → 自评），
 * 这页是**纸面**（写字 / 打印）。打卡规则同一条 —— 指针做完才走（见 server/lib/english-daily.mjs）：
 * 指针之后的句子在这页只能看不能标（按钮灰掉并说明原因）。
 *
 * 数据：`GET /api/english/daily/sheet?from=&to=`（一句一条的全文，见 lib/english-daily.mjs 的 sheet()），
 * 打卡仍走原来的 `POST /api/english/daily/complete`。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PageHeader from '@/components/PageHeader.vue'
import SidecarOffline from '@/components/SidecarOffline.vue'
import { api, ensureSidecar } from '@/core/sidecar'
import { ElMessage } from 'element-plus'
import { downloadPdf } from './export-download'
// 句子库里偶尔夹 LaTeX（译文里的 `$80\%$` 这种），只认 $ 定界符的那种轻量渲染
import { renderDollarMath } from '@/features/wiki/math-typeset'
import 'katex/dist/katex.min.css'
import './book.css'

const route = useRoute()
const router = useRouter()

const ready = ref(false)
const loading = ref(false)
const error = ref('')
/**
 * 起点：输入框留空 = 跟着「当前句」（指针）走，避免刚进来就写死一个过期的 Day。
 *
 * 为什么用 el-input 而不是 el-input-number：数字输入框的 `:min` 会把模型值**就地夹到 1**
 * （留空的空档被它写成 1），于是「留空＝跟当前句」这个语义当场失效 ——
 * 实测就是范围永远从 Day 1 开始、而「当前」却在 Day 4。文本输入不会碰你给的值。
 */
const startText = ref(String(route.query.from ?? '') || '')
const startDay = computed(() => {
  const n = Math.trunc(Number(startText.value))
  return Number.isFinite(n) && n > 0 ? n : 0
})
/** 条数：0 = 全部（打印整本时才用） */
const COUNT_OPTIONS = [
  { value: 5, label: '5 句' },
  { value: 10, label: '10 句' },
  { value: 20, label: '20 句' },
  { value: 30, label: '30 句' },
  { value: 0, label: '全部' },
]
const pageCount = ref(route.query.count === 'all' ? 0 : Number(route.query.count ?? 0) || 10)

const meta = ref<{ total: number; maxDay: number; pointer: number; source: string }>({
  total: 0,
  maxDay: 0,
  pointer: 1,
  source: '',
})
const items = ref<any[]>([])
const loadedFrom = ref(0)
const loadedTo = ref(0)

/** 哪几句展开了答案（点留白区 / 右上按钮 / 地址栏 answers=1 三种入口，语义统一） */
const revealed = ref<Record<number, boolean>>({})
/** 词汇默认收起：先自己读原句，需要提示再点开（与纸上顺序一致，2026-09-26 定的） */
const vocabOpen = ref<Record<number, boolean>>({})
/** 正在记哪一句（按钮转圈） */
const saving = ref(0)

const RATING_TEXT: Record<string, string> = { good: '读懂', half: '半懂', lost: '没懂' }
const RATINGS: { key: 'good' | 'half' | 'lost'; label: string; ico: string }[] = [
  { key: 'good', label: '读懂了', ico: '✓' },
  { key: 'half', label: '半懂', ico: '~' },
  { key: 'lost', label: '没读懂', ico: '✕' },
]

/** 这一句的档位：没练过是空串 */
function ratingOf(it: any): '' | 'good' | 'half' | 'lost' {
  return it?.done ? (it.rating ?? 'good') : ''
}

/** 一段里各档各几句（顶栏那条统计） */
const stat = computed(() => {
  const out = { good: 0, half: 0, lost: 0, undone: 0, locked: 0 }
  for (const it of items.value) {
    if (it.locked) out.locked += 1
    else if (!it.done) out.undone += 1
    else out[ratingOf(it) as 'good' | 'half' | 'lost'] += 1
  }
  return out
})

const allRevealed = computed(
  () => items.value.length > 0 && items.value.every((it) => revealed.value[it.day]),
)

function isRevealed(it: any) {
  return !!revealed.value[it.day]
}
function toggleOne(it: any) {
  revealed.value = { ...revealed.value, [it.day]: !revealed.value[it.day] }
}
function toggleVocab(it: any) {
  vocabOpen.value = { ...vocabOpen.value, [it.day]: !vocabOpen.value[it.day] }
}
function toggleAll() {
  const target = !allRevealed.value
  const next: Record<number, boolean> = {}
  for (const it of items.value) next[it.day] = target
  revealed.value = next
}

/** 有没有可看的答案 —— 材料本身可能缺项（缺的那几句只能对原句自己啃，别当成页面坏了） */
function hasAnswer(it: any) {
  return !!(it?.refTranslation || it?.structure?.length || it?.grammar?.length)
}

/**
 * 三档按钮的提示语：说清「现在这一句能不能标、标了会怎样」。
 * 指针之后的句子**不能标**（规则是做完才走），这里必须说明，否则会以为是页面坏了。
 */
function tipOf(it: any) {
  if (it.locked) return `还没轮到这句 · 现在做的是 Day ${meta.value.pointer}`
  if (ratingOf(it)) return `已记「${RATING_TEXT[ratingOf(it)] ?? ''}」· 点其它档位可再记一次`
  return '做完点一下，记今天的打卡'
}

async function load(withSpin = false, resetReveal = false) {
  if (withSpin) loading.value = true
  error.value = ''
  try {
    const ok = await ensureSidecar()
    ready.value = ok
    if (!ok) return
    // 先问当前句（指针 / 总句数），再按区间取全文 —— 起点的默认值就是指针
    const cur: any = await api.englishDaily()
    const c = cur?.data ?? {}
    meta.value = {
      total: Number(c.total) || 0,
      maxDay: Number(c.total) || 0,
      pointer: Number(c.pointer) || 1,
      source: String(c.source ?? ''),
    }
    const total = Math.max(1, meta.value.total || 1)
    const start = Math.min(Math.max(1, startDay.value || meta.value.pointer || 1), total)
    const want = pageCount.value === 0 ? total : pageCount.value
    const end = Math.min(total, start + Math.max(1, want) - 1)

    const r: any = await api.englishDailySheet(start, end)
    if (r?.ok === false) throw new Error(r.error || '读取失败')
    // 注意：call() 把整个响应体包在 data 里，不是摊平的
    const d = r.data ?? { items: [] }
    items.value = d.items ?? []
    loadedFrom.value = d.from ?? start
    loadedTo.value = d.to ?? end
    if (d.source) meta.value.source = d.source
    if (resetReveal) revealed.value = {}
    vocabOpen.value = {}
    // 起点输入框要跟真实区间对上：进来时它是空的（＝跟着当前句），这里落成具体 Day；
    // 手输一个越界的 Day（比如 500）也照服务端夹回来的值改，免得框里写着 500、实际看的是 105。
    // 赋值会触发 watch 再取一次，第二次两边一致、不会再来一轮。
    if (loadedFrom.value !== startDay.value) startText.value = String(loadedFrom.value)
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally {
    loading.value = false
  }
}

/** 换范围：重新取全文，并把「展开/收起」重置（不然会带着上一段的展开状态） */
function reload() {
  load(true, true)
}
watch([startDay, pageCount], reload)
watch([loadedFrom, loadedTo], () => {
  router.replace({
    name: 'zuotiben-sentence',
    query: {
      from: String(loadedFrom.value || startDay.value || ''),
      count: pageCount.value === 0 ? 'all' : String(pageCount.value),
    },
  })
})
onMounted(() => {
  if (route.query.answers === '1') revealed.value = {}
  load(true, true)
})

/**
 * 记一档：写入打卡（指针跟着 +1），然后重取这一段。
 * 同一档再点一次不重复写 —— 数据层是「追加记录」的，重复点会白记一条。
 */
async function rate(it: any, key: 'good' | 'half' | 'lost') {
  if (it.locked || saving.value) return
  if (ratingOf(it) === key) return
  saving.value = it.day
  try {
    const r: any = await api.englishDailyComplete(it.day, key)
    if (r?.ok === false) throw new Error(r.error || '记录失败')
    ElMessage.success(`Day ${it.day}：${RATING_TEXT[key]}`)
    await load()
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally {
    saving.value = 0
  }
}

/* --------------------------------------------------------------- 导出 --- */

const exportOpen = ref(false)
const exporting = ref(false)
const exportOpts = ref({ mode: 'blank', orient: 'landscape', vocab: false, ansLayout: 'flow' })

/**
 * 两种格式，**没有「答案在本页」**（2026-09-29 实测定的）：
 * 这一句的参考译文 + 结构划分 + 语法重点合起来三十来行，横放 A4 一页装不下，
 * 硬塞就会自动续到下一页 —— 那就把「一句一页」这句话打脸了（实测 3 句导出 6 页）。
 * 所以句子这边只留两种能兑现承诺的：纯句子纸（手写用）与答案在后（对答案用，答案自然连排）。
 */
const EXPORT_MODES = [
  { value: 'blank', label: '纯句子纸', hint: '答案不出现，印出来手写' },
  { value: 'appendix', label: '答案在后', hint: '句子全空，末尾先译文汇总再逐句详解' },
]

const preview = computed<any>(
  () => items.value[0] ?? { day: loadedFrom.value || 1, text: '（这一段还没有句子）', source: '' },
)

/** 预览里的长文本要截断（缩略图不求全）：只截纯文本，句子里没有公式，直接切 */
function previewText(s: any, n = 90) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/** 预览底下那一句：说清「答案在哪儿、一共几页」 */
const previewNote = computed(() => {
  const n = items.value.length
  if (!n) return '这一段还没有句子'
  if (exportOpts.value.mode === 'blank') return `共 ${n} 句，一句一页（${n} 页）· 不带答案`
  return `前面 ${n} 页是一句一页的空白句子；末尾接译文汇总与逐句详解，详解 ${
    exportOpts.value.ansLayout === 'page' ? '每句一页' : '连着排（一页放不下自动挪下一页）'
  }`
})

async function doExport() {
  if (exporting.value) return
  exporting.value = true
  error.value = ''
  try {
    const url = await api.zuotibenExportUrl({
      book: 'sentence',
      from: loadedFrom.value,
      to: loadedTo.value,
      ...exportOpts.value,
    })
    await downloadPdf(url, `每日一句_Day${loadedFrom.value}-${loadedTo.value}.pdf`)
    exportOpen.value = false
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally {
    exporting.value = false
  }
}

/** 一句一段的纯文本（结构划分 / 语法重点：资料里就是一串带序号的整句） */
function lines(v: any): string[] {
  return Array.isArray(v) ? v.filter((x) => String(x ?? '').trim()) : []
}
</script>

<template>
  <div class="ztb">
    <SidecarOffline v-if="ready === false" />

    <PageHeader
      title="每日一句做题本"
      subtitle="一句一份：原文在上，下面留白手写；点留白看译文，打印一句一页"
      icon="Reading"
      compact
    >
      <template #actions>
        <!-- .ws-tools：手机上把这排控件排成两列等宽网格（见 styles/index.css） -->
        <div class="ws-tools">
        <span class="zts__ctl-label">起点</span>
        <el-input
          v-model="startText"
          size="small"
          style="width: 104px"
          inputmode="numeric"
          :placeholder="`Day ${meta.pointer || 1}`"
          title="从哪一句开始看；留空＝跟着当前句"
        />
        <el-select v-model="pageCount" size="small" style="width: 92px">
          <el-option v-for="o in COUNT_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
        <el-button size="default" title="跳回当前该做的那一句" @click="startText = ''">当前句</el-button>
        <el-button
          size="default"
          :type="allRevealed ? 'warning' : 'default'"
          :disabled="!items.length"
          @click="toggleAll"
        >
          {{ allRevealed ? '收起全部答案' : '展开全部答案' }}
        </el-button>
        <el-button size="default" type="primary" :disabled="!items.length" @click="exportOpen = true">
          <el-icon><component is="Download" /></el-icon>
          <span style="margin-left: 4px">导出 PDF</span>
        </el-button>
        <el-button size="default" :loading="loading" @click="load(true)">刷新</el-button>
        <el-button class="ws-tools__wide" size="default" link @click="router.push('/zuotiben')">每日一题（数学）›</el-button>
        </div>
      </template>
    </PageHeader>

    <el-alert v-if="error" type="error" :closable="false" :title="error" style="margin-bottom: 12px" />

    <div class="ztb__bar">
      <span class="ztb__src">{{ meta.source || '每日一句素材' }}</span>
      <span class="ztb__count">
        Day {{ loadedFrom }}–{{ loadedTo }}
        <b>共 {{ items.length }} 句</b>
        <b v-if="stat.good" class="is-right"> · 读懂 {{ stat.good }}</b>
        <b v-if="stat.half" class="is-half"> · 半懂 {{ stat.half }}</b>
        <b v-if="stat.lost" class="is-wrong"> · 没懂 {{ stat.lost }}</b>
        <b v-if="stat.undone" class="is-left"> · 还没做 {{ stat.undone }}</b>
      </span>
      <span class="ztb__hintline">现在做的是 Day {{ meta.pointer }}（做完才走）</span>
      <span class="zts__note">
        <span class="ws-hide-sm">点下面的留白区看这一句的答案，或右上「{{ allRevealed ? '收起全部答案' : '展开全部答案' }}」</span>
        <span class="ws-only-sm">点留白区看译文</span>
      </span>
    </div>

    <el-empty v-if="ready && !loading && !items.length" description="这一段还没有句子" />

    <!-- 一句一卡：原文在上，留白在下 -->
    <article
      v-for="it in items"
      :key="it.day"
      class="ztb__card"
      :class="ratingOf(it) ? `is-${ratingOf(it)}` : ''"
    >
      <header class="ztb__head">
        <span class="ztb__no">Day {{ it.day }}</span>
        <span v-if="it.source" class="ztb__tag">真题 {{ it.source }}</span>
        <span v-if="it.current" class="ztb__kind">当前</span>
        <button v-if="it.vocab?.length" type="button" class="zts__vocab-toggle" @click="toggleVocab(it)">
          词汇 {{ it.vocab.length }} 个 {{ vocabOpen[it.day] ? '▴' : '▾' }}
        </button>
        <span v-if="ratingOf(it)" class="ztb__state" :class="`is-${ratingOf(it)}`">
          {{ ratingOf(it) === 'good' ? '✓ 读懂' : ratingOf(it) === 'half' ? '半懂' : '✕ 没懂' }}
        </span>
      </header>

      <!-- 词汇：默认收起，点开才给（先自己读原句） -->
      <div v-if="vocabOpen[it.day]" class="zts__vocab">
        <span v-for="(v, i) in it.vocab" :key="i" class="zts__word">
          <b>{{ v.term || v.meaning }}</b>
          <i v-if="v.pos"> {{ v.pos }}</i>
          <span v-if="v.term && v.meaning"> {{ v.meaning }}</span>
        </span>
      </div>

      <div class="ztb__stem zts__text" v-html="renderDollarMath(it.text)" />

      <!-- 留白：手写区 + 点一下出答案的开关；答案就渲染在这块区域里面 -->
      <div
        class="ztb__work"
        :class="{ 'is-open': isRevealed(it) }"
        role="button"
        :title="isRevealed(it) ? '点一下收起答案' : '点一下看答案'"
        @click="toggleOne(it)"
      >
        <template v-if="isRevealed(it)">
          <div class="ztb__work-sol">
            <b>参考译文</b>
            <p class="zts__ref" v-html="renderDollarMath(it.refTranslation || '（这一句资料里没有参考译文）')" />
            <template v-if="lines(it.structure).length">
              <b>结构划分</b>
              <div class="zts__pre" v-html="renderDollarMath(lines(it.structure).join('\n'), { breaks: true })" />
            </template>
            <template v-if="lines(it.grammar).length">
              <b>语法重点</b>
              <div class="zts__pre" v-html="renderDollarMath(lines(it.grammar).join('\n'), { breaks: true })" />
            </template>
            <span v-if="!hasAnswer(it)" class="ztb__hint">这一句资料里没有答案，只能对原句自己啃了</span>
          </div>
        </template>
        <span v-else class="ztb__work-hint">写作用</span>
        <span class="ztb__work-toggle">{{ isRevealed(it) ? '收起答案 ▴' : '点这里看答案 ▾' }}</span>
      </div>

      <!-- 档位：留白区正下方。读懂 / 半懂 / 没读懂 三选一，与英语学习那页同一套说法 -->
      <div class="ztb__marks">
        <span class="ztb__marks-label">这句</span>
        <button
          v-for="r in RATINGS"
          :key="r.key"
          type="button"
          class="ztb__mark"
          :class="ratingOf(it) === r.key ? `is-${r.key}` : ''"
          :disabled="it.locked || saving === it.day"
          @click="rate(it, r.key)"
        >
          <span class="ztb__mark-ico">{{ r.ico }}</span>
          <span>{{ r.label }}</span>
        </button>
        <span class="ztb__marks-tip">{{ tipOf(it) }}</span>
      </div>
    </article>

    <!--
      导出：左边设置、右边预览（与数学册同一套版式与类名，见 book.css）。
      控件照数学册那样自己描，不用 el-radio-group（它在这儿不好用）。
    -->
    <el-dialog v-model="exportOpen" title="导出每日一句 PDF" width="740px" append-to-body>
      <div class="ztb__exp">
        <div class="ztb__exp-left">
          <div class="ztb__opt">
            <div class="ztb__opt-label">范围</div>
            <div class="zts__range">Day {{ loadedFrom }} – {{ loadedTo }}（共 {{ items.length }} 句）</div>
          </div>

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
              >
                {{ o.t }}
              </button>
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
                v-for="a in [{ v: 'flow', t: '连着排' }, { v: 'page', t: '每句一页' }]"
                :key="a.v"
                type="button"
                class="ztb__seg2-btn"
                :class="{ 'is-on': exportOpts.ansLayout === a.v }"
                :disabled="exportOpts.mode !== 'appendix'"
                @click="exportOpts.ansLayout = a.v as 'flow' | 'page'"
              >
                {{ a.t }}
              </button>
            </div>
          </div>

          <div class="ztb__opt ztb__opt--last">
            <el-checkbox v-model="exportOpts.vocab">连词汇一起印</el-checkbox>
          </div>
        </div>

        <div class="ztb__exp-right">
          <div class="ztb__exp-right-title">预览 · 第 1 页</div>
          <div class="ztb__paper" :class="{ 'is-land': exportOpts.orient === 'landscape' }">
            <div class="ztb__paper-head">
              <span>{{ meta.source || '每日一句素材' }}</span>
              <span>Day {{ loadedFrom }}–{{ loadedTo }}</span>
            </div>
            <div class="ztb__paper-no">
              Day {{ preview.day }}.
              <span class="ztb__paper-ref">{{ preview.source ? `真题 ${preview.source}` : '' }}</span>
            </div>
            <div class="ztb__paper-stem">{{ previewText(preview.text, 190) }}</div>
            <div v-if="exportOpts.vocab && preview.vocab?.length" class="zts__paper-vocab">
              词汇：{{ preview.vocab.map((v: any) => v.term || v.meaning).join('、') }}
            </div>
            <div class="ztb__paper-blank" />
            <!-- 第 1 页在两种格式里长得一样（都是一句一页的空白句子），
                 差别在末尾有没有答案区 —— 那句说明写在下面 previewNote 里，别在预览上假装有答案。 -->
            <div class="ztb__paper-foot">1/{{ items.length }}</div>
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
/* 这页自己的块一律带 zts__ 前缀（book.css 那套 ztb__ 是全站共用，别在这儿改写它） */
.zts__ctl-label {
  font-size: 12.5px;
  color: var(--ws-text-2);
}
.zts__note {
  color: var(--ws-text-3);
}
.zts__range {
  font-size: 13px;
  color: var(--ws-text);
}

/* 原句：比数学题的题干再大一点、行距再松一点 —— 英语要看清句子结构 */
.zts__text {
  font-size: 16px;
  line-height: 2;
  letter-spacing: 0.01em;
}
.zts__ref {
  margin: 0 0 10px;
  font-size: 14.5px;
  line-height: 1.9;
}
.zts__pre {
  margin: 0 0 10px;
  font-family: inherit;
  font-size: 13.5px;
  line-height: 1.85;
  color: var(--ws-text-2);
}

.zts__vocab-toggle {
  border: 0;
  background: transparent;
  padding: 4px 10px;
  border-radius: 999px;
  font-family: inherit;
  font-size: 12px;
  color: var(--ws-text-2);
  cursor: pointer;
  transition: background-color 0.14s, color 0.14s;
}
.zts__vocab-toggle:hover {
  background: var(--ws-accent-soft);
  color: var(--ws-accent);
}
.zts__vocab {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  margin-bottom: 10px;
}
.zts__word {
  font-size: 12px;
  line-height: 1.5;
  padding: 1px 7px;
  border-radius: 5px;
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
  color: var(--ws-text-2);
}
.zts__word b {
  font-weight: 650;
  color: var(--ws-text);
}
.zts__word i {
  font-style: normal;
  color: var(--ws-text-3);
  font-size: 11px;
}
.zts__paper-vocab {
  margin-top: 4px;
  font-size: 9.5px;
  color: var(--ws-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------------------------------------------------------- 手机档 ---
   「词汇 N 个 ▾」这类行内小按钮在手机上是可点目标，抬到 30px 高才好按
   （门禁实测 82×25，2026-09-29）。 */
@media (max-width: 760px) {
  .zts__vocab-toggle {
    min-height: 30px;
    padding: 4px 12px;
  }
}
</style>
