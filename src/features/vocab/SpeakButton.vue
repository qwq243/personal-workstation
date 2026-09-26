<script setup lang="ts">
/** 单词旁的小喇叭：点一下朗读。正在播时图标转成暂停态。 */
import { onUnmounted, ref } from 'vue'
import { speakTerm, stopSpeaking, unlockAudio, type Accent } from './speak'

const props = withDefaults(
  defineProps<{
    term: string
    accent?: Accent
    size?: 'small' | 'default'
  }>(),
  { accent: 'us', size: 'small' },
)

const playing = ref(false)
let seq = 0

async function play(e?: Event) {
  e?.stopPropagation()
  e?.preventDefault()
  if (!props.term?.trim()) return
  if (playing.value) {
    seq += 1
    stopSpeaking()
    playing.value = false
    return
  }
  const my = ++seq
  unlockAudio()
  playing.value = true
  try {
    await speakTerm(props.term, props.accent)
  } catch (err: any) {
    ElMessage.warning(err?.message || '朗读失败')
  } finally {
    if (my === seq) playing.value = false
  }
}

onUnmounted(() => {
  if (playing.value) stopSpeaking()
})
</script>

<template>
  <el-tooltip :content="playing ? '停止' : '朗读英文'" placement="top" :show-after="400">
    <button
      type="button"
      class="speak"
      :class="{ 'is-playing': playing, 'is-sm': size === 'small' }"
      :aria-label="playing ? '停止朗读' : '朗读英文'"
      @click="play"
    >
      <el-icon><VideoPause v-if="playing" /><Headset v-else /></el-icon>
    </button>
  </el-tooltip>
</template>

<style scoped>
.speak {
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  border: 1px solid var(--ws-border);
  border-radius: 8px;
  background: var(--ws-panel-2);
  color: var(--ws-accent);
  cursor: pointer;
  padding: 0;
  vertical-align: middle;
  transition: all 0.14s ease;
}
.speak.is-sm {
  width: 24px;
  height: 24px;
  flex-basis: 24px;
  border-radius: 7px;
  font-size: 13px;
}
.speak:hover {
  border-color: var(--ws-accent);
  background: var(--ws-accent-soft);
}
.speak.is-playing {
  color: var(--ws-on-accent);
  background: var(--ws-accent);
  border-color: var(--ws-accent);
}
</style>
