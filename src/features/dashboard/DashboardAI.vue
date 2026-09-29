<script setup lang="ts">
/**
 * 每日看板 · AI 助手：带今日上下文的问答 + 生成总结/复盘。
 *
 * 2026-09-27 收口：气泡 / 空态 / 输入框 / 「正在输入」动画全部换成 `src/ai/AiChat.vue`
 * （vue-element-plus-plus 的 Bubble / BubbleList / Welcome / Prompts / XSender），
 * 本文件只留看板独有的两件事 —— 页头的「生成今日要点 / 复盘 / 看上下文」与上下文抽屉。
 *
 * 这一页**目前还是非流式**（`/api/ai/ask` 一次性返回），所以没有推理与工具链可显示；
 * 换成流式要服务端另开 SSE 端点。先把「各写各的」这部分收掉，链路改造单独排。
 */
import { onMounted, ref } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import SidecarOffline from '@/components/SidecarOffline.vue'
import MdLite from '@/components/MdLite.vue'
import AiChat from '@/ai/AiChat.vue'
import { makeMessage, type AiMessage } from '@/ai/model'
import { api, ensureSidecar } from '@/core/sidecar'

const ready = ref(false)
const messages = ref<AiMessage[]>([])
const sending = ref(false)
const models = ref<string[]>([])
const model = ref('')
const showContext = ref(false)
const contextText = ref('')

const suggestions = [
  '今天该先做什么？',
  '帮我把今天的计划排个优先级',
  '这周我在哪些事上原地打转？',
  '总结一下我最近的记录',
]

/** 把一次结果落成一条助手消息（send 与 gen 共用） */
function pushAssistant(content: string, modelName?: string, error?: string) {
  const msg = makeMessage({ role: 'assistant', content: content ?? '', model: modelName })
  msg.status = error ? 'error' : 'done'
  if (error) msg.error = error
  messages.value.push(msg)
}

async function send(text: string) {
  const q = text.trim()
  if (!q || sending.value) return
  messages.value.push(makeMessage({ role: 'user', content: q }))
  sending.value = true
  try {
    const history = messages.value.slice(0, -1).map((m) => ({ role: m.role, content: m.content }))
    const r = await api.aiAsk(q, history)
    if (r.ok) pushAssistant(r.data?.content ?? '', r.data?.model)
    else pushAssistant('', undefined, r.error ?? '请求失败')
  } finally {
    sending.value = false
  }
}

async function gen(kind: 'summary' | 'review') {
  if (sending.value) return
  sending.value = true
  messages.value.push(makeMessage({ role: 'user', content: kind === 'summary' ? '生成今日要点与建议' : '生成今日复盘' }))
  try {
    const r = kind === 'summary' ? await api.aiSummary() : await api.aiReview()
    if (r.ok) pushAssistant(r.data?.content ?? '', r.data?.model)
    else pushAssistant('', undefined, r.error ?? '生成失败')
  } finally {
    sending.value = false
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
    <SidecarOffline v-if="!ready" />

    <template v-else>
      <PageHeader
        title="AI 助手"
        subtitle="它能看到你今天的计划、记录与最近几天的复盘"
        icon="MagicStick"
      >
        <template #actions>
          <el-button size="small" :disabled="sending" @click="gen('summary')">生成今日要点</el-button>
          <el-button size="small" :disabled="sending" @click="gen('review')">生成复盘</el-button>
          <el-button size="small" text @click="loadContext">看上下文</el-button>
        </template>
      </PageHeader>

      <div class="ws-card chat">
        <AiChat
          :messages="messages"
          :streaming="sending"
          :suggestions="suggestions"
          suggestion-mode="send"
          placeholder="问它今天的事…（Enter 发送，Shift+Enter 换行）"
          welcome-title="问它今天的事"
          welcome-desc="它会看到你今天写了哪些计划、记录里写了什么，以及最近几天的复盘。回答只依据这些，不编。"
          @send="send"
        >
          <!-- 正文：助手走 MdLite（标题/列表/加粗/行内码），用户与错误保持纯文本 -->
          <template #message-content="{ msg }">
            <MdLite v-if="msg.role === 'assistant' && !msg.error" :text="msg.content" />
            <div v-else class="chat__plain">{{ msg.content }}</div>
          </template>

          <template #message-meta="{ msg }">
            <span v-if="msg.model">{{ msg.model }}</span>
          </template>

          <template #footer>
            <span>模型：{{ model || '跟随设置' }}</span>
            <span v-if="models.length">· 可选 {{ models.length }} 个</span>
            <span>· 密钥不进浏览器（边车代理）</span>
          </template>
        </AiChat>
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
  height: calc(100dvh - 190px);
  min-height: 400px;
  padding: 14px 16px;
  min-width: 0;
}

.chat__plain {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.ctx {
  margin: 0;
  font-family: var(--ws-mono);
  font-size: var(--ws-fs-xs);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
