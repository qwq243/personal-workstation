<script setup lang="ts">
/**
 * WorkBuddy 测聊 —— 随便挑个模型发一句话，看它到底能不能用、首字多快、报什么错。
 *
 * 为什么这页值得存在：网关 /v1/models 是**目录**，不是能力证明。目录里同时躺着
 * 能用的和不能用的（例如 cn:hunyuan-image-alpha-edit 打完请求会回
 * “Backend [hunyuan-stream] is not supported”）。只有真发一次才知道 ——
 * 所以这一页的定位是「验证模型」，不是「当聊天工具用」（日常对话在别处）。
 *
 * 流式走边车的 /api/workbuddy/chat（SSE 逐帧），所以：
 *   · 令牌与网关 api_key 都不进浏览器；
 *   · 上游的报错原文（错误信息 + gateway_hint）会原样回显 —— 排查就靠它。
 *
 * 2026-09-27 收口：消息模型换成 `AiMessage`、事件走 `adaptWbEvent` + `applyEvent`、
 * 界面走 `src/ai/AiChat.vue`。这一页顺带白拿了三样原来没有的能力：
 *   · **自动滚动**（原来 `.wbo-chat__log` 滚动条根本不跟流式内容走，得手拉）；
 *   · **输入法守卫**（原来的 `@keydown.enter.exact.prevent` 没挡组合态，
 *     中文选字时按 Enter 有误发风险；XSender 内部有 `isComposing` + keyCode 229）；
 *   · **推理可折叠**（原来是一整块平铺出来、max-height 180px）。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import SidecarOffline from '@/components/SidecarOffline.vue'
import { api, ensureSidecar, workbuddyChatStream } from '@/core/sidecar'
import AiChat from '@/ai/AiChat.vue'
import { adaptWbEvent, applyEvent, markAborted } from '@/ai/adapt'
import { makeMessage, type AiMessage } from '@/ai/model'
import { compact, latency, num } from './wb-shared'

const ready = ref(false)
const err = ref('')
const models = ref<any[]>([])
const modelFilter = ref('')
const model = ref('')
const system = ref('')
const temperature = ref<number | ''>('')
const maxTokens = ref<number | ''>('')
const messages = ref<AiMessage[]>([])
const busy = ref(false)
let ctl: AbortController | null = null

/** 目录里挑模型：默认按免费/倍率排序，空串表示还没选 */
const modelOptions = computed(() => {
  const q = modelFilter.value.trim().toLowerCase()
  return models.value.filter(
    (m) =>
      !q ||
      String(m.model).toLowerCase().includes(q) ||
      String(m.name ?? '').toLowerCase().includes(q),
  )
})

/**
 * 快捷验证语：一句话能同时验通不通、中文正不正常、是否在瞎想。
 * 交给 AiChat 的 `Prompts` 渲染，`suggestion-mode="fill"` 只填不进 ——
 * 这一页的语义是「先改参数再发」，与知识库「点了就发」不同，那个差异由 AiChat 的
 * `suggestionMode` 保留，没有统一掉。
 */
const PRESETS = ['只回复两个字：可用', '用一句话说明你是什么模型', '9.9 和 9.11 哪个大？']

onMounted(async () => {
  const online = await ensureSidecar()
  ready.value = true
  if (!online) return
  const r = await api.workbuddyModels()
  if (!r.ok) {
    err.value = r.error ?? '读不到模型清单'
    return
  }
  models.value = r.data.items ?? []
  // 默认挑第一个免费或最便宜的，别让用户一上来就花积分
  const cheapest = models.value.find((m) => m.multiplier === 0) ?? models.value[0]
  if (cheapest) model.value = cheapest.model
})

onUnmounted(() => {
  ctl?.abort()
})

async function send(text: string) {
  const q = text.trim()
  if (!q) return
  if (!model.value) return ElMessage.warning('先选一个模型')

  messages.value.push(makeMessage({ role: 'user', content: q }))
  const turn = makeMessage({ role: 'assistant', model: model.value })
  messages.value.push(turn)

  busy.value = true
  ctl = new AbortController()

  await workbuddyChatStream(
    {
      model: model.value,
      system: system.value.trim() || undefined,
      temperature: temperature.value === '' ? undefined : temperature.value,
      maxTokens: maxTokens.value === '' ? undefined : maxTokens.value,
      messages: messages.value
        // 只带已完成的轮次：正在跑的那条本身就是这次请求
        .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.status === 'done'))
        .map((m) => ({ role: m.role, content: m.content })),
    },
    (e) => {
      for (const ev of adaptWbEvent(e)) applyEvent(turn, ev)
    },
    ctl.signal,
  )

  // 空输出兜底：流正常结束了但一个字节都没有 —— 最常见的两种原因是
  // max_tokens 太小（推理模型只输出了思考就被截断）和上游返回空流。
  if (turn.status === 'streaming') {
    if (!turn.content && !turn.reasoning) {
      turn.status = 'error'
      turn.error = '这条没有任何输出（可能是 max_tokens 太小，或上游返回了空流）'
    } else {
      turn.status = 'done'
    }
  }
  busy.value = false
  ctl = null
}

function stop() {
  ctl?.abort()
  // 标成 aborted + partial：界面会显示「已停止（保留了半截）」，
  // 而不是像原来那样只是安静地停下、看不出这是半截回答
  const last = messages.value[messages.value.length - 1]
  if (last) markAborted(last)
  busy.value = false
}

function clearAll() {
  messages.value = []
}

function multTag(m: any) {
  if (m.multiplier == null) return '—'
  if (m.multiplier === 0) return '免费'
  return `x${m.multiplier}`
}

function tokensOf(u: any) {
  if (!u) return ''
  const inTok = u.prompt_tokens ?? u.input_tokens
  const outTok = u.completion_tokens ?? u.output_tokens
  const think = u.completion_thinking_tokens ?? u.completion_tokens_details?.reasoning_tokens
  const parts = []
  if (inTok != null) parts.push(`入 ${num(inTok)}`)
  if (outTok != null) parts.push(`出 ${num(outTok)}`)
  if (think) parts.push(`其中思考 ${num(think)}`)
  return parts.join(' · ')
}
</script>

<template>
  <div class="ws-page">
    <PageHeader
      title="WorkBuddy 测聊"
      subtitle="验证某个模型到底能不能用：真发一次请求，看首字延迟、用量与上游报错原文"
      icon="ChatDotRound"
    >
      <template #actions>
        <span class="ws-dim" style="font-size: 11.5px">
          目录里全是语言 / 多模态模型，没有生图模型
        </span>
        <el-button size="small" :disabled="!messages.length" @click="clearAll">清空</el-button>
      </template>
    </PageHeader>

    <SidecarOffline v-if="ready && err" />

    <template v-else-if="ready">
      <div class="wbo-chat">
        <!-- ------------------------------------------------------ 左：对话 -->
        <div class="ws-card wbo-block">
          <div class="wbo-block__head">
            <span class="wbo-block__title">
              <el-icon><ChatDotRound /></el-icon>{{ model || '未选模型' }}
            </span>
            <span class="ws-dim" style="font-size: 11.5px">走边车 → 网关 → 上游，流式</span>
          </div>

          <AiChat
            :messages="messages"
            :streaming="busy"
            :suggestions="PRESETS"
            suggestion-mode="fill"
            placeholder="输入一句话…（Enter 发送，Shift+Enter 换行）"
            welcome-title="验证一个模型"
            welcome-desc="点下面任意一条快捷验证语（只填进输入框，不会直接发），或自己写一句。回复逐字出现，每轮下方给出首字延迟、总耗时与 token 用量。"
            list-height="52vh"
            @send="send"
            @stop="stop"
          >
            <!-- 头部指标：首字 / 总耗时 / finishReason / 用量。这一页存在的理由就是它们 -->
            <template #message-meta="{ msg }">
              <span v-if="msg.model" class="ws-mono">{{ msg.model }}</span>
              <span v-if="msg.ttfbMs" class="wbo-tag">首字 {{ latency(msg.ttfbMs) }}</span>
              <span v-if="msg.elapsedMs" class="wbo-tag">总 {{ latency(msg.elapsedMs) }}</span>
              <span v-if="msg.finishReason" class="wbo-tag">{{ msg.finishReason }}</span>
              <span v-if="msg.usage" class="wbo-tag">{{ tokensOf(msg.usage) }}</span>
            </template>

            <!-- 上游报错原文：排查全靠它，所以单独占一块、等宽字 -->
            <template #message-extra="{ msg }">
              <div v-if="msg.gatewayHint" class="wbo-note">网关提示：{{ msg.gatewayHint }}</div>
            </template>
          </AiChat>
        </div>

        <!-- ---------------------------------------------------- 右：参数 -->
        <div class="ws-card wbo-block">
          <div class="wbo-block__head">
            <span class="wbo-block__title"><el-icon><Setting /></el-icon>参数</span>
          </div>

          <div class="wbo-field">
            <div class="wbo-form__label">模型</div>
            <el-select
              v-model="model"
              filterable
              size="small"
              style="width: 100%"
              placeholder="筛选模型名…"
            >
              <el-option
                v-for="m in modelOptions"
                :key="m.model"
                :label="m.model"
                :value="m.model"
              >
                <span class="ws-mono" style="font-size: 12px">{{ m.model }}</span>
                <span style="float: right; color: var(--ws-text-3); font-size: 11.5px">
                  {{ multTag(m) }}<template v-if="m.context"> · {{ compact(m.context) }}</template>
                  <template v-if="!m.images"> · 无图</template>
                </span>
              </el-option>
            </el-select>
            <div class="wbo-form__hint">
              共 {{ models.length }} 个，免费 {{ models.filter((m) => m.multiplier === 0).length }} 个
            </div>
          </div>

          <div class="wbo-field">
            <div class="wbo-form__label">系统提示（可选）</div>
            <el-input v-model="system" type="textarea" :rows="2" size="small" resize="none" />
          </div>

          <div class="wbo-field">
            <div class="wbo-form__label">temperature（留空 = 不传）</div>
            <el-input v-model.number="temperature" size="small" placeholder="如 0.3" />
          </div>

          <div class="wbo-field">
            <div class="wbo-form__label">max_tokens（留空 = 不传）</div>
            <el-input v-model.number="maxTokens" size="small" placeholder="如 512" />
          </div>

          <p class="wbo-note">
            测模型是否可用时把 max_tokens 留空 —— 留太小会让推理模型只输出思考就断掉，
            看起来像「模型坏了」。
          </p>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.wbo-field {
  margin-bottom: 12px;
}
</style>
