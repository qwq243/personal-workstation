<script setup lang="ts">
/**
 * 边车未连接时的占位。被多个联网功能复用，避免每个页面各写一遍。
 */
import { onMounted, ref } from 'vue'
import { ensureSidecar, sidecarHint, sidecarBase } from '@/core/sidecar'

const props = defineProps<{ what?: string; autoCheck?: boolean }>()
const emit = defineEmits<{ ready: [] }>()

const checking = ref(false)
const failedOnce = ref(false)

async function check() {
  checking.value = true
  try {
    const ok = await ensureSidecar(true)
    if (ok) emit('ready')
    else failedOnce.value = true
  } finally {
    checking.value = false
  }
}

onMounted(() => {
  if (props.autoCheck !== false) check()
})
</script>

<template>
  <div class="ws-card offline">
    <div class="offline__icon">
      <el-icon><Connection /></el-icon>
    </div>
    <div class="offline__title">本地边车服务没有连上</div>
    <p class="offline__desc">
      {{ what ?? '这个页面' }}需要工作站的本地服务（sidecar）来取数据 —— 它会代理外部接口、
      读写本地数据、代理外部请求，所有请求都只在本机内。
    </p>
    <div class="offline__hint">
      <div class="offline__hint-label">启动方式</div>
      <code>{{ sidecarHint() }}</code>
    </div>
    <div class="ws-row" style="justify-content: center; margin-top: 16px">
      <el-button type="primary" :loading="checking" @click="check">
        <el-icon><Refresh /></el-icon>&nbsp;重新检测
      </el-button>
    </div>
    <div class="offline__addr ws-dim">当前地址：{{ sidecarBase() }}</div>
    <div v-if="failedOnce && !checking" class="offline__err ws-dim">
      仍然连不上。确认那条命令的窗口还开着（关掉窗口服务就停了），或端口 5278 被别的程序占用。
    </div>
  </div>
</template>

<style scoped>
.offline {
  padding: 40px 28px;
  text-align: center;
  max-width: 620px;
  margin: 40px auto;
}
.offline__icon {
  width: 54px;
  height: 54px;
  margin: 0 auto 14px;
  border-radius: var(--ws-radius-lg);
  display: grid;
  place-items: center;
  font-size: 25px;
  color: var(--ws-warn);
  background: var(--ws-warn-soft);
}
.offline__title {
  font-size: var(--ws-fs-md);
  font-weight: 650;
}
.offline__desc {
  color: var(--ws-text-2);
  font-size: var(--ws-fs-sm);
  line-height: 1.75;
  margin-top: 8px;
}
.offline__hint {
  margin-top: 18px;
  text-align: left;
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
  border-radius: var(--ws-radius);
  padding: 12px 14px;
}
.offline__hint-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--ws-text-3);
  letter-spacing: 0.05em;
  text-transform: uppercase;
  margin-bottom: 6px;
}
.offline__hint code {
  font-family: var(--ws-mono);
  font-size: var(--ws-fs-xs);
  color: var(--ws-accent);
  word-break: break-all;
}
.offline__addr {
  font-size: 11px;
  margin-top: 12px;
  font-family: var(--ws-mono);
}
.offline__err {
  font-size: var(--ws-fs-xs);
  margin-top: 8px;
}
</style>
