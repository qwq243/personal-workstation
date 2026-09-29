<script setup lang="ts">
/**
 * 原始音频播放器（记录详情用）。
 *
 * `<audio>` 读边车那条支持 Range 的接口（`/api/memo/audio`）—— 拖进度条靠 206 + Content-Range，
 * 一次给完整文件的话每次跳都得重下。播放位置用 `timeupdate` 抛给父组件（父组件还能反向调 `seek()`）。
 * 样式一律自己做：浏览器的原生 `<audio>` 跟工作站这套壳不搭（类名在 memo.css 里，三个页面共用）。
 */
import { onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps<{ record: any; url: string }>()
const emit = defineEmits<{ (e: 'time', sec: number): void }>()

const el = ref<HTMLAudioElement | null>(null)
const playing = ref(false)
const cur = ref(0)
/** 初值取记录上的时长（服务端能从 WAV 头读出来时才有）；元数据到了会被真实值覆盖 */
const total = ref(Number(props.record?.audio?.seconds ?? 0))
const rate = ref(1)
const broken = ref('')
const track = ref<HTMLElement | null>(null)
const dragging = ref(false)

const RATES = [0.75, 1, 1.25, 1.5, 2]

function clock(sec: number) {
  const t = Math.max(0, Math.floor(Number(sec) || 0))
  const m = Math.floor(t / 60)
  const s = t % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

const percent = () => (total.value ? Math.min(100, (cur.value / total.value) * 100) : 0)

/** 下载名：优先用上传时的原文件名（扩展名是真实的那一个，别一律写 .wav） */
const fileName = () => String(props.record?.audio?.name || `${props.record?.title || 'memo'}.wav`)

async function toggle() {
  const a = el.value
  if (!a) return
  if (a.paused) {
    try {
      await a.play()
    } catch (err: any) {
      broken.value = err?.message ?? '播放失败'
    }
  } else {
    a.pause()
  }
}

function seek(sec: number) {
  const a = el.value
  if (!a) return
  const target = Math.max(0, Number(sec) || 0)
  try {
    a.currentTime = target
  } catch {
    /* 元数据还没加载好，等 loadedmetadata 后父组件再跳 */
  }
  cur.value = target
  emit('time', target)
}

function setRate(value: number) {
  rate.value = value
  if (el.value) el.value.playbackRate = value
}

function seekByRatio(clientX: number) {
  const box = track.value?.getBoundingClientRect()
  if (!box || !total.value) return
  seek(Math.min(1, Math.max(0, (clientX - box.left) / box.width)) * total.value)
}

function onDown(e: PointerEvent) {
  dragging.value = true
  seekByRatio(e.clientX)
  ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
}
function onMove(e: PointerEvent) {
  if (dragging.value) seekByRatio(e.clientX)
}
function onUp() {
  dragging.value = false
}

function onMeta() {
  const a = el.value
  if (!a) return
  if (Number.isFinite(a.duration) && a.duration > 0) total.value = a.duration
}
function onTime() {
  const a = el.value
  if (!a) return
  cur.value = a.currentTime
  emit('time', a.currentTime)
}

watch(
  () => props.url,
  () => {
    playing.value = false
    cur.value = 0
    broken.value = ''
  },
)

onBeforeUnmount(() => el.value?.pause())

defineExpose({ seek })
</script>

<template>
  <div class="audio">
    <audio
      ref="el"
      :src="url"
      preload="metadata"
      @play="playing = true"
      @pause="playing = false"
      @ended="playing = false"
      @timeupdate="onTime"
      @loadedmetadata="onMeta"
      @error="broken = '音频读不出来（文件可能被删了）'"
    />

    <button class="audio__btn" :title="playing ? '暂停' : '播放'" @click="toggle">
      <el-icon><VideoPause v-if="playing" /><VideoPlay v-else /></el-icon>
    </button>

    <div class="audio__body">
      <div
        ref="track"
        class="audio__track"
        :class="{ 'is-drag': dragging }"
        @pointerdown="onDown"
        @pointermove="onMove"
        @pointerup="onUp"
        @pointercancel="onUp"
      >
        <span class="audio__fill" :style="{ width: `${percent()}%` }" />
        <span class="audio__knob" :style="{ left: `${percent()}%` }" />
      </div>
      <div class="audio__meta">
        <span class="audio__time">{{ clock(cur) }} / {{ clock(total) }}</span>
        <span class="ws-dim">原始音频 · 拖动进度条跳着听</span>
        <span v-if="broken" class="audio__err">{{ broken }}</span>
      </div>
    </div>

    <el-dropdown trigger="click" @command="setRate">
      <button class="audio__rate" :title="`播放速度 ${rate}×`">{{ rate }}×</button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item v-for="r in RATES" :key="r" :command="r" :disabled="r === rate">{{ r }}×</el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>

    <a class="audio__dl" :href="url" :download="fileName()" title="下载音频">
      <el-icon><Download /></el-icon>
    </a>
  </div>
</template>
