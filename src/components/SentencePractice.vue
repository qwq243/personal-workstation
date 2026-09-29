<script setup lang="ts">
/**
 * 英语每日一句 · 练习卡片（每日看板与「英语学习 → 每日一句」页共用）。
 * 规则（2026-09-26 定稿）：指针做完才走 —— 写翻译 → 核对 → 三档自评，走完才推到下一句；
 * 没做就停在当前句。每天做没做按日期记在边车 progress.json，卡片底部有最近 7 天的记号。
 * 词汇在翻译前就给（与纸上顺序一致：原句 → 词汇 → 你的翻译 → 参考答案）。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '@/core/sidecar'
import { useUiStore } from '@/core/ui'
import { ElMessage } from 'element-plus'

/** more：右上角给一个「英语学习 ›」入口（看板上用；页面自己用时不传） */
const props = defineProps<{ more?: boolean }>()
/**
 * 打完卡要通知外面：这张卡只管自己（重新拉当前句），但**页面上的记录**——
 * 打卡日历的色块、已完成/自评分布、没读懂清单——都在父组件里，不通知就一直是旧的。
 * 2026-09-29 用户反馈「色块没有更新、和我的选择对不上」就是这里。
 */
const emit = defineEmits<{ (e: 'rated', payload: { day: number; rating: string }): void }>()
const router = useRouter()
const ui = useUiStore()

const data = ref<any>(null)
const loading = ref(true)
const translation = ref('')
const checked = ref(false)
const submitting = ref(false)
/** 词汇默认收起（先自己读原句，需要提示再点开）—— 2026-09-26 用户定 */
const showVocab = ref(false)

/**
 * 写译文的框：高度跟着内容走。
 *
 * 原来是死高 2 行，手机上（390px 屏）一句 100 多字的译文要写 4~6 行，
 * 写完只能看见最后两行，前面写了什么得在框里上下拖 —— 2026-09-29 用户提的
 * 「就只有一行、输入看不太全」就是这里。
 * 手机档起步给 5 行（一只手写译文的常见长度），上限 16 行 = 300 字（maxlength）
 * 在手机上写完也不用框内滚动；桌面档起步还是 2 行，写法不变，写长了同样会长高。
 */
const inputAuto = computed(() => ({ minRows: ui.isMobile ? 5 : 2, maxRows: 16 }))

const RATING_LIST: { key: 'good' | 'half' | 'lost'; label: string }[] = [
  { key: 'good', label: '读懂了' },
  { key: 'half', label: '半懂' },
  { key: 'lost', label: '没读懂' },
]

/* ---------------------------------------------------------------- 朗读 --
   走边车 edge-tts 合成整句（服务端按文本哈希落盘缓存，同一天同一句只合成一次）。
   首次要现合成 1~3 秒，所以按钮上标「合成中」；上游不通就退回浏览器自带朗读。 */
const speaking = ref(false)
const synthesizing = ref(false)
let audio: HTMLAudioElement | null = null

/** 换句子/打卡后把播放状态收干净 */
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

/** 静默预热：只让服务端把缓存做出来（不播、不打扰；失败就当没发生） */
async function prewarm(text: string) {
  try {
    const url = await api.ttsSpeakUrl(text)
    await fetch(url).catch(() => {})
  } catch {
    /* 点的时候还会再试一次 */
  }
}

/** 兜底：系统自带朗读（音色一般，但上游不通时至少能出声） */
function speakWithSystem(text: string) {
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

async function toggleSpeak() {
  const text = data.value?.item?.text
  if (!text) return
  if (speaking.value) {
    audio?.pause()
    if (audio) audio.currentTime = 0
    try {
      speechSynthesis.cancel()
    } catch {
      /* ignore */
    }
    speaking.value = false
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
  if (!played) speakWithSystem(text)
}

async function load() {
  resetSpeech()
  loading.value = true
  try {
    const r = await api.englishDaily()
    data.value = r.ok ? r.data : { ok: false, error: r.error ?? '加载失败' }
    if (data.value?.item?.text) void prewarm(data.value.item.text)
  } finally {
    loading.value = false
  }
}

async function rate(key: 'good' | 'half' | 'lost') {
  if (!data.value?.item || submitting.value) return
  submitting.value = true
  try {
    const doneDay = Number(data.value.item.day)
    const r = await api.englishDailyComplete(doneDay, key)
    if (r.ok) {
      ElMessage.success(key === 'lost' ? '已打卡。这句没读懂，回头再翻翻' : '已打卡，下一句见')
      emit('rated', { day: doneDay, rating: key })
      translation.value = ''
      checked.value = false
      showVocab.value = false
      await load()
    } else {
      ElMessage.error(r.error ?? '打卡失败')
    }
  } finally {
    submitting.value = false
  }
}

defineExpose({ load })
load()
</script>

<template>
  <div class="ws-card block">
    <div class="block__head">
      <span class="block__title"><el-icon><Reading /></el-icon> 英语每日一句</span>
      <div class="ws-row" style="gap: 8px">
        <span v-if="data?.ok" class="ws-dim">
          已完成 {{ data.completedCount }}/{{ data.total }}<template v-if="data.streak"> · 连续 {{ data.streak }} 天</template>
        </span>
        <!-- 看板上多给一个「做题本」入口：一句一页、点留白出译文、可导出 PDF（2026-09-29 用户要的） -->
        <el-button v-if="props.more" size="small" text type="primary" @click="router.push('/zuotiben/sentence')">做题本 ›</el-button>
        <el-button v-if="props.more" size="small" text type="primary" @click="router.push('/vocab/daily')">英语学习 ›</el-button>
      </div>
    </div>

    <el-skeleton v-if="loading && !data" :rows="3" animated />
    <div v-else-if="!data?.ok" class="muted-line">{{ data?.error ?? '加载失败' }}</div>
    <div v-else-if="data.finished" class="muted-line">全部 {{ data.total }} 句都完成了。句库有更新时编译进句库，指针会自动接上。</div>

    <template v-else>
      <div class="ed-head">
        <span class="ed-day">Day {{ data.item.day }}</span>
        <span v-if="data.item.source" class="ed-src">真题 {{ data.item.source }}</span>
        <!-- 朗读整句（边车 edge-tts 合成、落盘缓存）；合成中/播放中是两个中间态 -->
        <button
          type="button"
          class="ed-speak"
          :class="{ 'is-on': speaking }"
          :disabled="synthesizing"
          :title="speaking ? '停止朗读' : '朗读这句'"
          @click="toggleSpeak"
        >
          <el-icon>
            <Loading v-if="synthesizing" />
            <VideoPause v-else-if="speaking" />
            <Headset v-else />
          </el-icon>
          <span>{{ synthesizing ? '合成中' : speaking ? '停止' : '朗读' }}</span>
        </button>
      </div>
      <p class="ed-text">{{ data.item.text }}</p>

      <div v-if="data.item.vocab.length" class="ed-vocabwrap">
        <button type="button" class="ed-vocab-toggle" @click="showVocab = !showVocab">
          <el-icon class="ed-vocab-toggle__icon"><ArrowDown v-if="showVocab" /><ArrowRight v-else /></el-icon>
          <span>词汇 {{ data.item.vocab.length }} 个</span>
          <span class="ws-dim">{{ showVocab ? '收起' : '点击显示' }}</span>
        </button>
        <div v-if="showVocab" class="ed-vocab">
          <span v-for="(v, i) in data.item.vocab" :key="i" class="ed-word">
            <b>{{ v.term || v.meaning }}</b><i v-if="v.pos"> {{ v.pos }}</i><span v-if="v.term && v.meaning"> {{ v.meaning }}</span>
          </span>
        </div>
      </div>

      <el-input
        v-model="translation"
        type="textarea"
        :autosize="inputAuto"
        :maxlength="300"
        resize="none"
        placeholder="你的翻译（先自己写，再核对）"
        class="ed-input"
      />

      <div v-if="!checked" class="ed-actions">
        <el-button type="primary" size="small" @click="checked = true">核对答案</el-button>
        <span class="ws-dim ed-hint">核对后选「读懂了 / 半懂 / 没读懂」，就记今天的打卡并展示下一句</span>
      </div>

      <template v-else>
        <div class="ed-sec">
          <div class="ed-sec__label">参考译文</div>
          <div class="ed-ref">{{ data.item.refTranslation || '—' }}</div>
        </div>
        <div v-if="data.item.structure.length" class="ed-sec">
          <div class="ed-sec__label">结构划分</div>
          <div class="ed-pre">{{ data.item.structure.join('\n') }}</div>
        </div>
        <div v-if="data.item.grammar.length" class="ed-sec">
          <div class="ed-sec__label">语法重点</div>
          <div class="ed-pre">{{ data.item.grammar.join('\n') }}</div>
        </div>
        <div class="ed-rate">
          <span class="ws-dim ed-hint">今天这句练得怎么样？</span>
          <el-button
            v-for="r in RATING_LIST"
            :key="r.key"
            size="small"
            :type="r.key === 'good' ? 'primary' : 'default'"
            :loading="submitting"
            @click="rate(r.key)"
          >
            {{ r.label }}
          </el-button>
        </div>
      </template>

      <div class="ed-foot">
        <span class="ws-dim">
          每天一句 · 剩 {{ data.plan.remaining }} 句 · 预计 {{ data.plan.projectedFinish.slice(5) }} 完成
          <template v-if="data.todayDone"> · 今天已打卡 ✓</template>
        </span>
        <span class="ed-dots" title="最近 7 天做没做">
          <i v-for="d in data.last7" :key="d.date" :class="{ 'is-done': d.done }" />
        </span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ed-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.ed-day {
  font-size: 12px;
  font-weight: 700;
  color: var(--ws-accent);
  background: var(--ws-accent-soft);
  border-radius: 999px;
  padding: 1px 9px;
}
.ed-src {
  font-size: 11.5px;
  color: var(--ws-text-3);
}
/* 朗读按钮：与「词汇 N 个」那颗同一套观感（细边胶囊，hover / 播放中才上色），推到行尾 */
.ed-speak {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 9px;
  border: 1px solid var(--ws-border);
  border-radius: 999px;
  background: transparent;
  color: var(--ws-text-2);
  font-size: 12px;
  font-family: inherit;
  line-height: 1.6;
  cursor: pointer;
  flex: none;
  transition: border-color 0.14s ease, color 0.14s ease, background 0.14s ease;
}
.ed-speak:hover:not(:disabled),
.ed-speak.is-on {
  border-color: var(--ws-accent);
  color: var(--ws-accent);
  background: var(--ws-accent-soft);
}
.ed-speak:disabled {
  opacity: 0.75;
  cursor: default;
}
.ed-speak .el-icon {
  font-size: 13px;
}
.ed-text {
  margin: 0 0 8px;
  font-size: 14.5px;
  line-height: 1.75;
  color: var(--ws-text);
}
.ed-vocabwrap {
  margin-bottom: 10px;
}
.ed-vocab-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 8px 1px 6px;
  margin-left: -2px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--ws-text-2);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease;
}
.ed-vocab-toggle:hover {
  background: var(--ws-accent-soft);
  color: var(--ws-accent);
}
.ed-vocab-toggle__icon {
  font-size: 12px;
}
.ed-vocab {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  margin-top: 6px;
}
.ed-word {
  font-size: 12px;
  line-height: 1.5;
  padding: 1px 7px;
  border-radius: 5px;
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
  color: var(--ws-text-2);
}
.ed-word b {
  font-weight: 650;
  color: var(--ws-text);
}
.ed-word i {
  font-style: normal;
  color: var(--ws-text-3);
  font-size: 11px;
}
.ed-input {
  margin-bottom: 8px;
}
/* autosize 顶到上限那几行之后，EP 会把 overflow-y 写成内联的 hidden ——
   真有人写满 300 字（maxlength）时，多出来的行既看不见也拖不动。放开成 auto：
   封顶了就滚，别静默把字吃掉。必须 !important，EP 那份是内联样式。 */
.ed-input :deep(.el-textarea__inner) {
  overflow-y: auto !important;
}
.ed-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ed-hint {
  font-size: 11.5px;
}
.ed-sec + .ed-sec {
  margin-top: 10px;
}
.ed-sec__label {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--ws-text-3);
  letter-spacing: 0.04em;
  margin-bottom: 4px;
}
.ed-ref {
  font-size: 13.5px;
  line-height: 1.7;
  padding: 8px 11px;
  border-radius: var(--ws-radius-sm);
  background: var(--ws-accent-soft);
  color: var(--ws-text);
}
.ed-pre {
  font-size: 12.5px;
  line-height: 1.7;
  white-space: pre-line;
  color: var(--ws-text-2);
  padding: 6px 0 0 11px;
  border-left: 2px solid var(--ws-border);
}
.ed-rate {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed var(--ws-border);
}
.ed-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 12px;
  font-size: 11.5px;
}
.ed-dots {
  display: flex;
  gap: 4px;
  flex: none;
}
.ed-dots i {
  width: 7px;
  height: 7px;
  border-radius: 99px;
  background: var(--ws-border);
}
.ed-dots i.is-done {
  background: var(--ws-success);
}

/* ---------------------------------------------------------------- 手机档 --
   断点 760px 与 src/core/ui.ts 的 MOBILE_MAX 对齐（那边管 autosize 的行数）。
   2026-09-29 按手机截图改的三处：① 译文框只露两行、写多了自己看不见 —— 行为在
   script 的 inputAuto（起步 5 行 + 跟着内容长），这里把字放大、行距放松；
   ② 「词汇 N 个 点击显示」那颗按钮实高 18px，手指点不准（手机门禁 check-mobile
   量出来的过小点按），抬到 30px；③ 答案那几段（参考译文 / 结构划分 / 语法重点）
   桌面用的 12.5~13.5px 在手机上是真小，一起抬到 14px 上下。 */
@media (max-width: 760px) {
  .ed-input :deep(.el-textarea__inner) {
    font-size: 15px;
    line-height: 1.65;
    padding: 8px 10px;
  }

  .ed-vocab-toggle {
    min-height: 30px;
    font-size: 13px;
  }

  /* 朗读按钮同样要够手指点（手机门禁会量过小点按） */
  .ed-speak {
    min-height: 30px;
    font-size: 13px;
  }

  .ed-ref {
    font-size: 14.5px;
  }

  .ed-pre {
    font-size: 14px;
  }

  /* 自评那行是「一句问话 + 三个按钮」，390px 屏上排不下 —— 不给换行的话
     问话会被压成竖排（和全局 .ws-row 那条同源）；换行之后再把问话推满一整行，
     免得两个按钮跟它挤一行、第三个孤零零掉到下一行。 */
  .ed-rate {
    flex-wrap: wrap;
  }

  .ed-rate .ed-hint {
    flex: 1 1 100%;
  }
}
</style>
