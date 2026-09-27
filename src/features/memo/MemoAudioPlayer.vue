<script setup lang="ts">
/**
 * 原始音频播放器（记录详情用）。
 *
 * `<audio>` 读边车那条支持 Range 的接口（`/api/memo/audio`）—— 拖进度条靠 206 + Content-Range，
 * 一次给完整文件的话每次跳都得重下。样式全自己做：浏览器的原生 `<audio>` 跟工作站这套壳不搭。
 */
import { onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps<{ url: string; title?: string }>()

const el = ref<HTMLAudioElement | null>(null)
const playing = ref(false)
const cur = ref(0)
const total = ref(0)
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
    /* 元数据还没到，等 loadedmetadata 再说 */
  }
  cur.value = target
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
  if (a && Number.isFinite(a.duration)) total.value = a.duration
}
function onTime() {
  if (el.value) cur.value = el.value.currentTime
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
      @error="broken = '音频读不出来（文件被删了？）'"
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
        <span class="ws-dim">原始音频</span>
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

    <a class="audio__dl" :href="url" :download="title || 'memo'" title="下载音频">
      <el-icon><Download /></el-icon>
    </a>
  </div>
</template>

<style scoped>
.audio {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--el-color-primary-light-7);
  border-radius: var(--ws-radius);
  background: var(--el-color-primary-light-9);
}
.audio__btn {
  flex: 0 0 auto;
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 999px;
  background: var(--ws-accent);
  color: #fff;
  font-size: 17px;
  cursor: pointer;
}
.audio__btn:active {
  transform: scale(0.96);
}
.audio__body {
  flex: 1 1 auto;
  min-width: 0;
}
.audio__track {
  position: relative;
  height: 8px;
  border-radius: 999px;
  background: var(--el-fill-color-dark, #e5e7eb);
  cursor: pointer;
  touch-action: none;
}
.audio__fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  border-radius: 999px;
  background: var(--ws-accent);
}
.audio__knob {
  position: absolute;
  top: 50%;
  width: 14px;
  height: 14px;
  margin-left: -7px;
  border: 2px solid var(--ws-accent);
  border-radius: 999px;
  background: #fff;
  transform: translateY(-50%);
  pointer-events: none;
}
.audio__meta {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-top: 5px;
  font-size: 11.5px;
  color: var(--ws-text-3);
}
.audio__time {
  color: var(--ws-text-2);
  font-family: var(--ws-mono);
}
.audio__err {
  color: var(--el-color-danger);
}
.audio__rate,
.audio__dl {
  flex: 0 0 auto;
  padding: 3px 8px;
  border: 1px solid var(--ws-border);
  border-radius: 999px;
  background: var(--ws-panel);
  color: var(--ws-text-2);
  font-family: var(--ws-mono);
  font-size: 11.5px;
  line-height: 16px;
  cursor: pointer;
}
.audio__dl {
  display: grid;
  place-items: center;
}
.audio__rate:hover,
.audio__dl:hover {
  border-color: var(--ws-accent);
  color: var(--ws-accent);
}
</style>
