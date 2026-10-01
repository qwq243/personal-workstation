<script setup lang="ts">
/**
 * 英语学习 → 句子库。
 * 句库全景（Day 1 到材料最后一天）：哪天练过、什么评价、当前指针停在哪；点开某句看全文（原句/词汇/结构/参考译文/语法），
 * 也能「再练一次」——重练只追加记录，不会动指针（指针归 complete 里的当前句规则管）。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PageHeader from '@/components/PageHeader.vue'
import { api } from '@/core/sidecar'
import { ElMessage } from 'element-plus'
import { speakTerm, stopSpeaking } from './speak'

const route = useRoute()
const router = useRouter()

const lib = ref<any>(null)
const loading = ref(true)
const filter = ref<'all' | 'undone' | 'done' | 'lost'>('all')
const detail = ref<any>(null)
const drawer = ref(false)
const submitting = ref(false)

const RATING_TEXT: Record<string, string> = { good: '读懂了', half: '半懂', lost: '没读懂' }
const RATING_LIST: { key: 'good' | 'half' | 'lost'; label: string }[] = [
  { key: 'good', label: '读懂了' },
  { key: 'half', label: '半懂' },
  { key: 'lost', label: '没读懂' },
]

async function load() {
  loading.value = true
  try {
    const r = await api.englishDailyLibrary()
    lib.value = r.ok ? r.data : { ok: false, error: r.error ?? '加载失败' }
  } finally {
    loading.value = false
  }
}

const days = computed<any[]>(() => lib.value?.days ?? [])
const filtered = computed(() => {
  if (filter.value === 'done') return days.value.filter((d) => d.done)
  if (filter.value === 'undone') return days.value.filter((d) => !d.done)
  if (filter.value === 'lost') return days.value.filter((d) => d.rating === 'lost')
  return days.value
})
const doneCount = computed(() => days.value.filter((d) => d.done).length)
const pct = computed(() => (lib.value?.total ? Math.round((doneCount.value / lib.value.total) * 100) : 0))

function rateCls(d: any) {
  if (!d.done) return 'is-undone'
  return `is-${d.rating ?? 'done'}`
}

async function open(day: number) {
  const r = await api.englishDailyDay(day)
  if (r.ok) {
    detail.value = r.data
    drawer.value = true
    // 解析类内容默认收起（跟做题本一个交互：先自己读，要提示再点开）
    shown.value = { vocab: false, trans: false, structure: false, grammar: false }
    if (r.data?.item?.text) void prewarm(r.data.item.text)
  } else {
    ElMessage.error(r.error ?? '打不开这一句')
  }
}

/** 再练一次：记录追加到当天日期，指针不动（这里永远不是指针前的当前句） */
async function reRate(key: 'good' | 'half' | 'lost') {
  if (!detail.value?.item || submitting.value) return
  submitting.value = true
  try {
    const r = await api.englishDailyComplete(detail.value.item.day, key)
    if (r.ok) {
      ElMessage.success(`Day ${detail.value.item.day} 又记了一次：${RATING_TEXT[key]}`)
      const d2 = await api.englishDailyDay(detail.value.item.day)
      if (d2.ok) detail.value = d2.data
      await load()
    } else {
      ElMessage.error(r.error ?? '记录失败')
    }
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  const f = String(route.query.filter ?? '')
  if (f === 'lost' || f === 'done' || f === 'undone') filter.value = f
  await load()
  const day = Number(route.query.day ?? 0)
  if (day) open(day)
})

/* ---------------------------------------------------------------- 朗读 --
   整句走边车 edge-tts（服务端按文本哈希落盘缓存；首次现合成 1~3 秒，按钮标「合成中」；
   上游不通退回浏览器自带朗读）。词芯片走 speak.ts 的有道真人发音。 */
const speaking = ref(false)
const synthesizing = ref(false)
let audio: HTMLAudioElement | null = null
const chipSpeaking = ref(-1)
/** 解析三段的展开状态：默认全收起 */
const shown = ref({ vocab: false, trans: false, structure: false, grammar: false })

function resetSpeech() {
  if (audio) {
    audio.pause()
    audio.src = ''
  }
  try {
    speechSynthesis.cancel()
  } catch {
    /* 没这个 API 就算了 */
  }
  speaking.value = false
  synthesizing.value = false
}

/** 静默预热：让服务端把这句的合成缓存做出来（不播；失败点的时候再试） */
async function prewarm(text: string) {
  try {
    const url = await api.ttsSpeakUrl(text)
    await fetch(url).catch(() => {})
  } catch {
    /* 点的时候还会再试一次 */
  }
}

async function toggleSpeak() {
  const text = detail.value?.item?.text
  if (!text) return
  if (speaking.value) {
    resetSpeech()
    return
  }
  synthesizing.value = true
  let played = false
  try {
    const url = await api.ttsSpeakUrl(text)
    if (!audio) audio = new Audio()
    audio.src = url
    audio.onended = () => {
      speaking.value = false
    }
    await audio.play()
    played = true
    speaking.value = true
  } catch {
    speaking.value = false
  } finally {
    synthesizing.value = false
  }
  if (!played) {
    // 兜底：浏览器自带朗读（音色一般，但至少能出声）
    try {
      const u = new SpeechSynthesisUtterance(text)
      u.lang = 'en-US'
      u.onend = () => {
        speaking.value = false
      }
      speechSynthesis.speak(u)
      speaking.value = true
    } catch {
      ElMessage.warning('这台机器上暂时出不了声')
    }
  }
}

/** 点词芯片听发音（有道真人音，失败退系统朗读——都在 speak.ts 里） */
async function speakChip(idx: number | string, v: any) {
  // 模板里的 `v-for` 下标在类型上是 `string | number`（词表来自接口，形状是 any），
  // 这里归一到数字再比，免得类型检查红
  const i = Number(idx)
  const term = String(v?.term || v?.meaning || '').trim()
  if (!term) return
  if (chipSpeaking.value === i) {
    stopSpeaking()
    chipSpeaking.value = -1
    return
  }
  stopSpeaking()
  chipSpeaking.value = i
  try {
    await speakTerm(term)
  } catch (err: any) {
    ElMessage.warning(err?.message || '朗读失败')
  } finally {
    if (chipSpeaking.value === i) chipSpeaking.value = -1
  }
}

watch(drawer, (v) => {
  if (!v) {
    resetSpeech()
    stopSpeaking()
    chipSpeaking.value = -1
  }
})

onUnmounted(() => {
  resetSpeech()
  stopSpeaking()
})

</script>

<template>
  <div class="ws-page ws-page--wide">
    <PageHeader title="句子库" :subtitle="lib?.ok ? `${lib.source} · Day1–${lib.total} · 已完成 ${doneCount}` : '句库还没导入（见 docs/每日一句导入.md）'" icon="List">
      <template #actions>
        <el-radio-group v-model="filter" size="small">
          <el-radio-button value="all">全部</el-radio-button>
          <el-radio-button value="undone">未练</el-radio-button>
          <el-radio-button value="done">已练</el-radio-button>
          <el-radio-button value="lost">没读懂</el-radio-button>
        </el-radio-group>
        <el-button :loading="loading" @click="load"><el-icon><Refresh /></el-icon>&nbsp;刷新</el-button>
      </template>
    </PageHeader>

    <div class="ws-card prog">
      <div class="prog__row">
        <span>完成进度 <b>{{ doneCount }}</b> / {{ lib?.total ?? 105 }} 句</span>
        <span class="ws-dim">
          读懂 {{ lib?.stats?.good ?? 0 }} · 半懂 {{ lib?.stats?.half ?? 0 }} · 没懂 {{ lib?.stats?.lost ?? 0 }}
          <template v-if="lib?.pointer"> · 指针停在 Day {{ lib.pointer }}</template>
        </span>
      </div>
      <el-progress :percentage="pct" :stroke-width="10" :color="pct >= 70 ? 'var(--ws-success)' : pct >= 35 ? 'var(--ws-warn)' : 'var(--ws-accent)'" style="margin-top: 10px" />
    </div>

    <div v-if="!lib?.ok && !loading" class="ws-card pad">{{ lib?.error ?? '加载失败' }}</div>
    <div v-else-if="loading && !lib" class="ws-card pad"><el-skeleton :rows="6" animated /></div>
    <div v-else-if="!filtered.length" class="ws-card pad ws-dim">这个筛选下没有句子。</div>

    <div v-else class="grid">
      <div
        v-for="d in filtered"
        :key="d.day"
        class="cell"
        :class="[rateCls(d), { 'is-current': d.current }]"
        @click="open(d.day)"
      >
        <div class="cell__top">
          <span class="cell__day">Day {{ d.day }}</span>
          <span v-if="d.current" class="cell__now">当前</span>
          <span class="cell__state">{{ d.done ? RATING_TEXT[d.rating] ?? '已练' : '未练' }}</span>
        </div>
        <div class="cell__src ws-dim">{{ d.source }}</div>
        <div class="cell__text">{{ d.text }}</div>
      </div>
    </div>

    <!-- 单句详情 + 重练 -->
    <el-drawer v-model="drawer" size="640px" :title="detail?.item ? `Day ${detail.item.day} · ${detail.item.source}` : ''">
      <div v-if="detail?.item" class="dt">
        <div class="dt__textrow">
          <p class="dt__text">{{ detail.item.text }}</p>
          <button
            type="button"
            class="dt__speak"
            :class="{ 'is-playing': speaking }"
            :disabled="synthesizing"
            :aria-label="speaking ? '停止朗读' : '朗读原句'"
            @click="toggleSpeak"
          >
            <el-icon><VideoPause v-if="speaking" /><Loading v-else-if="synthesizing" class="is-loading" /><Headset v-else /></el-icon>
          </button>
        </div>

        <!-- 生词也默认收起：词义本身就是提示，先自己读句子 -->
        <div v-if="detail.item.vocab.length" class="dt__sec">
          <button type="button" class="dt__toggle" @click="shown.vocab = !shown.vocab">
            <span class="dt__label">生词（{{ detail.item.vocab.length }}）</span>
            <span class="dt__toggle-hint">{{ shown.vocab ? '收起' : '点击显示' }}</span>
            <el-icon class="dt__chev"><ArrowUp v-if="shown.vocab" /><ArrowDown v-else /></el-icon>
          </button>
          <div v-show="shown.vocab" class="dt__vocab">
            <button
              v-for="(v, i) in detail.item.vocab"
              :key="i"
              type="button"
              class="dt__word"
              :class="{ 'is-speaking': chipSpeaking === i }"
              :title="chipSpeaking === i ? '停止' : '朗读这个单词'"
              @click="speakChip(i, v)"
            >
              <b>{{ v.term || v.meaning }}</b><i v-if="v.pos"> {{ v.pos }}</i><span v-if="v.term && v.meaning"> {{ v.meaning }}</span>
              <el-icon class="dt__word-ic"><Headset /></el-icon>
            </button>
          </div>
        </div>

        <!-- 参考译文 / 结构划分 / 语法重点：默认收起，点一下才展开（先自己读，别让答案先入眼） -->
        <div class="dt__sec">
          <button type="button" class="dt__toggle" @click="shown.trans = !shown.trans">
            <span class="dt__label">参考译文</span>
            <span class="dt__toggle-hint">{{ shown.trans ? '收起' : '点击显示' }}</span>
            <el-icon class="dt__chev"><ArrowUp v-if="shown.trans" /><ArrowDown v-else /></el-icon>
          </button>
          <div v-show="shown.trans" class="dt__ref">{{ detail.item.refTranslation || '—' }}</div>
        </div>
        <div v-if="detail.item.structure.length" class="dt__sec">
          <button type="button" class="dt__toggle" @click="shown.structure = !shown.structure">
            <span class="dt__label">结构划分</span>
            <span class="dt__toggle-hint">{{ shown.structure ? '收起' : '点击显示' }}</span>
            <el-icon class="dt__chev"><ArrowUp v-if="shown.structure" /><ArrowDown v-else /></el-icon>
          </button>
          <div v-show="shown.structure" class="dt__pre">{{ detail.item.structure.join('\n') }}</div>
        </div>
        <div v-if="detail.item.grammar.length" class="dt__sec">
          <button type="button" class="dt__toggle" @click="shown.grammar = !shown.grammar">
            <span class="dt__label">语法重点</span>
            <span class="dt__toggle-hint">{{ shown.grammar ? '收起' : '点击显示' }}</span>
            <el-icon class="dt__chev"><ArrowUp v-if="shown.grammar" /><ArrowDown v-else /></el-icon>
          </button>
          <div v-show="shown.grammar" class="dt__pre">{{ detail.item.grammar.join('\n') }}</div>
        </div>

        <div class="dt__sec">
          <div class="dt__label">练习记录</div>
          <div v-if="!detail.records.length" class="ws-dim" style="font-size: 12.5px">还没练过这一句。</div>
          <div v-else class="dt__rec">
            <span v-for="(r, i) in detail.records" :key="i" class="dt__rec-item">
              {{ r.date }} · {{ RATING_TEXT[r.rating] ?? r.rating }}<template v-if="detail.item.day === detail.pointer"> — 这是当前句</template>
            </span>
          </div>
        </div>

        <div class="dt__rate">
          <div class="dt__hint ws-dim">
            {{ detail.item.day === detail.pointer ? '就是当前句：选一档即打卡并前进' : '重练一次只追加记录，不动当前进度' }}
          </div>
          <div class="dt__btns">
            <el-button
              v-for="r in RATING_LIST"
              :key="r.key"
              class="dt__btn"
              :type="r.key === 'good' ? 'primary' : 'default'"
              :loading="submitting"
              @click="reRate(r.key)"
            >
              {{ r.label }}
            </el-button>
          </div>
          <!-- 纸面那本（一句一页、点留白出译文、能导出 PDF）：直接落到这一句上 -->
          <div class="dt__links">
            <el-button size="small" link @click="router.push({ path: '/zuotiben/sentence', query: { from: detail.item.day, count: 1 } })">做题本里看 ›</el-button>
          </div>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.pad {
  padding: 18px 20px;
}
.prog {
  padding: 14px 20px;
  margin-bottom: 16px;
}
.prog__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px 12px;
  font-size: 13.5px;
}
/* 「完成进度 N / M 句」是一个整体，窄屏不许从中间断开 */
.prog__row > span:first-child {
  flex: none;
  white-space: nowrap;
}
.prog__row b {
  color: var(--ws-accent);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 232px), 1fr));
  gap: 12px;
}
.cell {
  border: 1px solid var(--ws-border);
  border-radius: var(--ws-radius);
  background: var(--ws-panel);
  padding: 10px 12px 11px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-left-width: 3px;
  transition: border-color 0.14s ease, transform 0.14s ease;
}
.cell:hover {
  transform: translateY(-2px);
  border-color: var(--ws-accent);
}
.cell.is-undone {
  border-left-color: var(--ws-border-strong);
}
.cell.is-good {
  border-left-color: var(--ws-success);
}
.cell.is-half {
  border-left-color: var(--ws-warn);
}
.cell.is-lost {
  border-left-color: var(--ws-danger);
}
.cell.is-current {
  box-shadow: inset 0 0 0 1.5px var(--ws-accent);
  background: color-mix(in srgb, var(--ws-accent) 5%, var(--ws-panel));
}
.cell__top {
  display: flex;
  align-items: center;
  gap: 6px;
}
.cell__day {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--ws-text);
}
.cell__now {
  font-size: 10px;
  font-weight: 600;
  line-height: 15px;
  padding: 0 5px;
  border-radius: 999px;
  color: var(--ws-on-accent);
  background: var(--ws-accent);
}
.cell__state {
  margin-left: auto;
  font-size: 11px;
  color: var(--ws-text-3);
}
.cell.is-good .cell__state { color: var(--ws-success); }
.cell.is-half .cell__state { color: var(--ws-warn); }
.cell.is-lost .cell__state { color: var(--ws-danger); }
.cell__src {
  font-size: 11px;
}
.cell__text {
  font-size: 12px;
  line-height: 1.55;
  color: var(--ws-text-2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* 抽屉 */
.dt__textrow {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.dt__text {
  flex: 1;
  min-width: 0;
  margin: 0 0 10px;
  font-size: 14.5px;
  line-height: 1.75;
}
.dt__speak {
  flex: 0 0 30px;
  width: 30px;
  height: 30px;
  display: inline-grid;
  place-items: center;
  border: 1px solid var(--ws-border);
  border-radius: 8px;
  background: var(--ws-panel-2);
  color: var(--ws-accent);
  cursor: pointer;
  padding: 0;
  transition: all 0.14s ease;
}
.dt__speak:hover {
  border-color: var(--ws-accent);
  background: var(--ws-accent-soft);
}
.dt__speak.is-playing {
  color: var(--ws-on-accent);
  background: var(--ws-accent);
  border-color: var(--ws-accent);
}
.dt__speak:disabled {
  opacity: 0.6;
  cursor: default;
}
.dt__vocab {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  margin-bottom: 12px;
}
.dt__word {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--ws-font);
  font-size: 12px;
  line-height: 1.5;
  padding: 1px 7px;
  border-radius: 5px;
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
  color: var(--ws-text-2);
  cursor: pointer;
  transition: all 0.14s ease;
}
.dt__word:hover {
  border-color: var(--ws-accent);
  color: var(--ws-text);
}
.dt__word.is-speaking {
  color: var(--ws-accent);
  border-color: var(--ws-accent);
  background: var(--ws-accent-soft);
}
.dt__word b {
  color: var(--ws-text);
}
.dt__word i {
  font-style: normal;
  font-size: 11px;
  color: var(--ws-text-3);
}
.dt__word-ic {
  font-size: 12px;
  color: var(--ws-text-3);
}
.dt__word.is-speaking .dt__word-ic {
  color: var(--ws-accent);
}
.dt__sec + .dt__sec {
  margin-top: 12px;
}
.dt__toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 2px 0;
  margin-bottom: 0;
  background: none;
  border: none;
  cursor: pointer;
  font-family: var(--ws-font);
  text-align: left;
}
.dt__toggle:hover .dt__label {
  color: var(--ws-accent);
}
.dt__toggle-hint {
  margin-left: auto;
  font-size: 11px;
  color: var(--ws-text-3);
}
.dt__chev {
  font-size: 12px;
  color: var(--ws-text-3);
}
.dt__label {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--ws-text-3);
  letter-spacing: 0.04em;
  margin-bottom: 5px;
}
.dt__toggle .dt__label {
  margin-bottom: 0;
}
.dt__ref {
  font-size: 13.5px;
  line-height: 1.7;
  padding: 9px 12px;
  border-radius: var(--ws-radius-sm);
  background: var(--ws-accent-soft);
}
.dt__pre {
  font-size: 12.5px;
  line-height: 1.7;
  white-space: pre-line;
  color: var(--ws-text-2);
  padding: 6px 0 0 11px;
  border-left: 2px solid var(--ws-border);
}
.dt__rec {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dt__rec-item {
  font-size: 12.5px;
  color: var(--ws-text-2);
}
.dt__rate {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px dashed var(--ws-border);
}
.dt__hint {
  font-size: 12px;
  margin-bottom: 10px;
}
.dt__btns {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}
/* EP 给相邻按钮加的 margin-left 会把栅格顶歪，收掉 */
.dt__btns :deep(.el-button + .el-button) {
  margin-left: 0;
}
.dt__btn {
  width: 100%;
}
.dt__links {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}
</style>
