<script setup lang="ts">
/** 每日看板 · AI 助手：带今日上下文的问答 + 生成总结/复盘。 */
import { computed, nextTick, onMounted, ref } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import SidecarOffline from '@/components/SidecarOffline.vue'
import MdLite from '@/components/MdLite.vue'
import { api, ensureSidecar } from '@/core/sidecar'

interface Msg {
  role: 'user' | 'assistant'
  content: string
  model?: string
  error?: boolean
}

const ready = ref(false)
const messages = ref<Msg[]>([])
const input = ref('')
const sending = ref(false)
const models = ref<string[]>([])
const model = ref('')
const scroller = ref<HTMLElement | null>(null)
const showContext = ref(false)
const contextText = ref('')

const suggestions = [
  '今天该先做什么？',
  '帮我把今天的计划排个优先级',
  '这周我在哪些事上原地打转？',
  '总结一下我最近的记录',
]

const canSend = computed(() => input.value.trim().length > 0 && !sending.value)

async function scrollDown() {
  await nextTick()
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
}

async function send(text?: string) {
  const q = (text ?? input.value).trim()
  if (!q || sending.value) return
  input.value = ''
  messages.value.push({ role: 'user', content: q })
  sending.value = true
  await scrollDown()
  try {
    const history = messages.value.slice(0, -1).map((m) => ({ role: m.role, content: m.content }))
    const r = await api.aiAsk(q, history)
    if (r.ok) {
      messages.value.push({ role: 'assistant', content: r.data?.content ?? '', model: r.data?.model })
    } else {
      messages.value.push({ role: 'assistant', content: r.error ?? '请求失败（先在设置里配好模型端点与密钥）', error: true })
    }
  } finally {
    sending.value = false
    await scrollDown()
  }
}

async function gen(kind: 'summary' | 'review') {
  sending.value = true
  messages.value.push({ role: 'user', content: kind === 'summary' ? '生成今日要点与建议' : '生成今日复盘' })
  await scrollDown()
  try {
    const r = kind === 'summary' ? await api.aiSummary() : await api.aiReview()
    if (r.ok) messages.value.push({ role: 'assistant', content: r.data?.content ?? '', model: r.data?.model })
    else messages.value.push({ role: 'assistant', content: r.error ?? '生成失败', error: true })
  } finally {
    sending.value = false
    await scrollDown()
  }
}

async function loadContext() {
  const r = await api.aiContext()
  if (r.ok) {
    contextText.value = JSON.stringify(r.data, null, 2)
    showContext.value = true
  } else ElMessage.error(r.error ?? '读不到上下文')
}

async function init() {
  const ok = await ensureSidecar()
  ready.value = ok
  if (!ok) return
  const r = await api.overview()
  if (r.ok) {
    models.value = r.data?.ai?.models ?? []
    model.value = r.data?.ai?.model ?? ''
  }
}

onMounted(init)
</script>

<template>
  <div class="ws-page">
    <SidecarOffline v-if="ready === false" what="AI 助手" @ready="init" />

    <template v-else>
      <PageHeader title="AI 助手" subtitle="自动带上看板计划、词单进度、校园日历与模型花费作为上下文" icon="ChatDotRound">
        <template #actions>
          <el-button size="small" @click="gen('summary')" :disabled="sending">
            <el-icon><MagicStick /></el-icon>&nbsp;生成今日要点
          </el-button>
          <el-button size="small" @click="gen('review')" :disabled="sending">
            <el-icon><Notebook /></el-icon>&nbsp;生成复盘
          </el-button>
          <el-button size="small" @click="loadContext">看上下文</el-button>
        </template>
      </PageHeader>

      <div class="ws-card chat">
        <div ref="scroller" class="chat__scroll">
          <div v-if="!messages.length" class="welcome">
            <div class="welcome__title">问点什么</div>
            <p class="welcome__desc">
              它会看到你在看板上写的计划和记录、背单词的进度、今天上不上课（校历）、
              以及模型花了多少钱。外部的数据源（课表 / 待办…）要自己接，见 docs/architecture.md。
            </p>
            <div class="welcome__chips">
              <button v-for="s in suggestions" :key="s" class="chip" @click="send(s)">{{ s }}</button>
            </div>
          </div>

          <div v-for="(m, i) in messages" :key="i" class="msg" :class="`msg--${m.role}`">
            <div class="msg__bubble" :class="{ 'msg__bubble--err': m.error }">
              <!-- AI 回复走 MdLite（加粗/列表/行内码有颜色层次）；用户输入与错误信息保持纯文本 -->
              <div class="msg__text">
                <MdLite v-if="m.role === 'assistant' && !m.error" :text="m.content" />
                <template v-else>{{ m.content || '（空回复）' }}</template>
              </div>
              <div v-if="m.model" class="msg__meta ws-dim">{{ m.model }}</div>
            </div>
          </div>

          <div v-if="sending" class="msg msg--assistant">
            <div class="msg__bubble typing"><span /><span /><span /></div>
          </div>
        </div>

        <div class="chat__input">
          <el-input
            v-model="input"
            type="textarea"
            :rows="2"
            resize="none"
            placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"
            @keydown.enter.exact.prevent="send()"
          />
          <el-button type="primary" :disabled="!canSend" :loading="sending" @click="send()">发送</el-button>
        </div>
        <div class="chat__foot ws-dim">
          <span>模型：{{ model || '默认' }}（{{ models.join(' / ') || '未知' }}）</span>
          <span>· 经边车代理模型端点，密钥不进浏览器</span>
        </div>
      </div>

      <el-drawer v-model="showContext" title="AI 看到的上下文" size="560px">
        <pre class="ctx">{{ contextText }}</pre>
      </el-drawer>
    </template>
  </div>
</template>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 190px);
  min-height: 400px;
  overflow: hidden;
}
.chat__scroll {
  flex: 1;
  overflow-y: auto;
  padding: 20px 22px;
}
.welcome {
  max-width: 560px;
  margin: 40px auto;
  text-align: center;
}
.welcome__title {
  font-size: 17px;
  font-weight: 650;
}
.welcome__desc {
  color: var(--ws-text-2);
  font-size: 13.2px;
  line-height: 1.75;
  margin-top: 8px;
}
.welcome__chips {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: center;
  margin-top: 18px;
}
.chip {
  padding: 6px 13px;
  border-radius: 99px;
  border: 1px solid var(--ws-border-strong);
  background: var(--ws-panel);
  color: var(--ws-text-2);
  font: inherit;
  font-size: 12.8px;
  cursor: pointer;
  transition: all 0.14s ease;
}
.chip:hover {
  border-color: var(--ws-accent);
  color: var(--ws-accent);
  background: var(--ws-accent-soft);
}

.msg {
  display: flex;
  margin-bottom: 14px;
}
.msg--user {
  justify-content: flex-end;
}
.msg__bubble {
  max-width: 78%;
  padding: 11px 14px;
  border-radius: var(--ws-radius);
  font-size: var(--ws-fs-sm);
  line-height: 1.75;
  white-space: pre-wrap;
  word-break: break-word;
}
.msg--user .msg__bubble {
  background: var(--ws-accent);
  color: var(--ws-on-accent);
  border-bottom-right-radius: 4px;
}
.msg--assistant .msg__bubble {
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
  border-bottom-left-radius: 4px;
}
.msg__bubble--err {
  background: var(--ws-danger-soft) !important;
  border-color: var(--ws-danger) !important;
  color: var(--ws-danger);
}
.msg__meta {
  font-size: 10.5px;
  margin-top: 6px;
}
.typing {
  display: flex;
  gap: 4px;
  align-items: center;
  padding: 14px 16px;
}
.typing span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ws-text-3);
  animation: blink 1.2s infinite ease-in-out;
}
.typing span:nth-child(2) {
  animation-delay: 0.18s;
}
.typing span:nth-child(3) {
  animation-delay: 0.36s;
}
@keyframes blink {
  0%, 60%, 100% {
    opacity: 0.25;
  }
  30% {
    opacity: 1;
  }
}

.chat__input {
  display: flex;
  gap: 10px;
  align-items: flex-end;
  padding: 14px 18px 10px;
  border-top: 1px solid var(--ws-border);
}
.chat__foot {
  display: flex;
  gap: 6px;
  padding: 0 18px 12px;
  font-size: 11.5px;
  flex-wrap: wrap;
}
.ctx {
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--ws-mono);
  font-size: 11.5px;
  line-height: 1.65;
  margin: 0;
}
</style>
