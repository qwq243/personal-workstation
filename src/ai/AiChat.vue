<script setup lang="ts">
/**
 * AI 对话外壳 —— **全站唯一一处**。四个 AI 界面（知识库问答 / 测聊 / 看板 AI / 语音随记）
 * 的对话骨架都走它，页面只填自己的那几块（依据、用量、技能、检索开关…）。
 *
 * 冒泡、左右分置、空态、输入框、滚动与虚拟列表全部交给 vue-element-plus-x：
 *   BubbleList  —— 消息列表。**自带三样我们原来没有的东西**：
 *                  `autoScroll`（贴底才跟随、用户上滑就中断）、
 *                  `virtual`（虚拟滚动，长会话不卡）、
 *                  `backButton`（滚上去之后「回到最新」带上未读数）
 *   Bubble      —— 单条气泡（placement 决定左右）
 *   Welcome / Prompts —— 空态与建议问题
 *   XSender     —— 输入框。自带 `submitType`（Enter 发送 / Shift+Enter 换行）与
 *                  输入法组合键守卫（`isComposing` + keyCode 229）—— 我们原来三处
 *                  `@keydown.enter.exact.prevent` 都没有这个保护，换过来是净收益。
 *
 * 插槽表（页面按需填，不填就用默认）：
 *   #welcome-extra   空态下面额外的说明
 *   #sender-header   输入框上方的工具条（模型选择、检索开关、技能）
 *   #message-meta    气泡头部（模型名、耗时、半截提示）
 *   #message-content 正文渲染器（**知识库要传 WikiMarkdown**，其余可 MdLite / 纯文本）
 *   #message-extra   正文之后、依据之前（页面自己的块）
 *   #message-refs    依据列表（知识库的 `[N]` 上标 ↔ 正文锚点靠它保契约）
 *   #message-actions 每条消息的动作（复制 / 重试）
 *   #footer          输入框下方的状态行
 *
 * 明确不做：不在这里判断「哪个页面」（那会变成一堆 v-if）；页面独有的东西一律走插槽。
 */
import { computed, ref } from 'vue'
import { BubbleList, Prompts, Welcome, XSender } from 'vue-element-plus-x'
import type { AiMessage } from './model'
import AiThoughts from './AiThoughts.vue'

const props = withDefaults(
  defineProps<{
    messages: AiMessage[]
    /** 是否正在流式输出（决定输入框的发送/停止态） */
    streaming?: boolean
    welcomeTitle?: string
    welcomeDesc?: string
    /** 建议问题 / 快捷验证语 */
    suggestions?: string[]
    /**
     * 点了建议之后干什么。**两种页面行为不同，不能统一**：
     *   'send' —— 直接发出去（知识库问答、看板的空态建议）
     *   'fill' —— 只填进输入框、不发送（测聊的快捷验证语：用户要先改参数再发）
     */
    suggestionMode?: 'send' | 'fill'
    placeholder?: string
    /**
     * 虚拟滚动。长会话才开 —— 短会话开它是白搭（多一层测量），
     * 而「长了才卡」正是手机上最吃力的地方。
     */
    virtual?: boolean
    autoScroll?: boolean
    /** 消息区域的高度。留空则由外层容器决定（有些页面要它撑满卡片） */
    listHeight?: string
  }>(),
  {
    streaming: false,
    suggestions: () => [],
    suggestionMode: 'send',
    placeholder: '说点什么…',
    virtual: false,
    autoScroll: true,
    listHeight: '',
  },
)

const emit = defineEmits<{
  (e: 'send', text: string): void
  (e: 'stop'): void
  (e: 'suggestion', text: string): void
  (e: 'retry', msg: AiMessage): void
}>()

/**
 * 输入框内容。**XSender 的 v-model 是 `{ html, text }` 对象，不是字符串**
 * （它内部支持富文本标签/提及），所以这里必须绑对象、提交时取 `.text`。
 * 绑成字符串的话运行时会静默失效（组件读不到 text 就一直认为输入为空）。
 */
const draft = ref<{ html: string; text: string }>({ html: '', text: '' })

function submit() {
  const text = (draft.value?.text ?? '').trim()
  if (!text || props.streaming) return
  emit('send', text)
  draft.value = { html: '', text: '' }
}

/** 点击建议：按页面语义决定「直接发」还是「只填」 */
function pickSuggestion(label: string) {
  emit('suggestion', label)
  if (props.suggestionMode === 'send') {
    emit('send', label)
  } else {
    draft.value = { html: label, text: label }
  }
}

/**
 * 列表项。字段必须满足 Bubble 的 props（`BubbleListItemProps extends BubbleProps`），
 * 所以 placement / loading / maxWidth 都在这层给；原始消息随 `msg` 一起挂上去，
 * 插槽里靠它取 references / tools / reasoning 这些库不认识的东西。
 */
const listItems = computed(() =>
  props.messages.map((m) => ({
    id: m.id,
    placement: m.role === 'user' ? ('end' as const) : ('start' as const),
    // 首字还没来时的「正在输入」三点：库内置，不用自己画动画
    loading: m.status === 'streaming' && !m.content,
    maxWidth: '84%',
    msg: m,
  })),
)

/** 空态的建议项。Prompts 要的是 { key, label }，key 必须稳定。 */
const promptItems = computed(() => props.suggestions.map((s, i) => ({ key: `s${i}`, label: s })))

const showWelcome = computed(() => props.messages.length === 0)
</script>

<template>
  <div class="ai-chat">
    <!-- ------------------------------------------------------- 空态 -->
    <div v-if="showWelcome" class="ai-chat__welcome">
      <Welcome :title="welcomeTitle" :description="welcomeDesc" variant="filled">
        <template #extra>
          <slot name="welcome-extra" />
        </template>
      </Welcome>
      <Prompts v-if="promptItems.length" :items="promptItems" wrap @item-click="(it: any) => pickSuggestion(it.label)" />
    </div>

    <!-- --------------------------------------------------- 消息列表 -->
    <BubbleList
      v-else
      class="ai-chat__list"
      :list="listItems"
      :auto-scroll="autoScroll"
      :virtual="virtual"
      :max-height="listHeight || undefined"
      show-back-button
      item-key="id"
    >
      <!-- 头部：模型 / 耗时 / 半截提示。原来是三页各画一遍 -->
      <template #header="{ item }">
        <div v-if="item.msg.status !== 'streaming'" class="ai-chat__meta">
          <slot name="message-meta" :msg="item.msg">
            <span v-if="item.msg.model" class="ws-dim">{{ item.msg.model }}</span>
            <span v-if="item.msg.elapsedMs" class="ws-dim">{{ (item.msg.elapsedMs / 1000).toFixed(1) }}s</span>
            <!-- 「半截」必须显式标出来：不然用户会以为回答就到这里 -->
            <span v-if="item.msg.partial" class="ai-chat__partial">
              {{ item.msg.status === 'aborted' ? '已停止（保留了半截）' : '输出中断（保留了半截）' }}
            </span>
          </slot>
        </div>
      </template>

      <!-- 正文：工具链 + 推理 + 内容 + 依据 + 动作 -->
      <template #content="{ item }">
        <div class="ai-chat__body">
          <AiThoughts :tools="item.msg.tools" :reasoning="item.msg.reasoning" :phase="item.msg.status" />

          <slot name="message-content" :msg="item.msg">
            <!-- 默认纯文本。知识库会传 WikiMarkdown 进来（KaTeX / 表格 / 双链 / [N] 上标） -->
            <div class="ai-chat__text">{{ item.msg.content }}</div>
          </slot>

          <!-- 还在流式：一个光标。Bubble 没有 typing 这个 prop，所以自己留一个 -->
          <span v-if="item.msg.status === 'streaming' && item.msg.content" class="ai-chat__caret" />

          <div v-if="item.msg.error" class="ai-chat__err">
            {{ item.msg.error }}
            <pre v-if="item.msg.errorDetail" class="ai-chat__errdetail">{{ item.msg.errorDetail }}</pre>
          </div>

          <slot name="message-extra" :msg="item.msg" />
        </div>
      </template>

      <!-- 脚部：依据 + 动作 -->
      <template #footer="{ item }">
        <div v-if="item.msg.role === 'assistant'" class="ai-chat__foot">
          <slot name="message-refs" :msg="item.msg" />
          <div class="ai-chat__acts">
            <slot name="message-actions" :msg="item.msg">
              <a v-if="item.msg.status !== 'streaming'" @click="emit('retry', item.msg)">重新生成</a>
            </slot>
          </div>
        </div>
      </template>
    </BubbleList>

    <!-- ------------------------------------------------------- 输入 -->
    <div class="ai-chat__sender">
      <div v-if="$slots['sender-header']" class="ai-chat__bar">
        <slot name="sender-header" />
      </div>
      <XSender
        v-model="draft"
        :placeholder="placeholder"
        :loading="streaming"
        submit-type="enter"
        clearable
        @submit="submit"
        @cancel="emit('stop')"
      >
        <!-- 测聊把「模型 / system / 温度」放这儿；知识库放「技能」 -->
        <template #header><slot name="sender-extra" /></template>
      </XSender>
      <div v-if="$slots.footer" class="ai-chat__status">
        <slot name="footer" />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 只写「页面骨架」的间距与高度；气泡/空态/输入框的视觉全在库里。
   这条规矩见 docs/ai-ui.md，由 npm run check:ai-ui 兜底。 */
.ai-chat {
  display: flex;
  flex-direction: column;
  min-width: 0;
  height: 100%;
  min-height: 0;
}

.ai-chat__welcome {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  min-height: 0;
  padding: 20px 12px;
}

.ai-chat__list {
  flex: 1;
  min-height: 0;
}

.ai-chat__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-3);
}

.ai-chat__partial {
  color: var(--ws-warn);
}

.ai-chat__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.ai-chat__text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* 流式光标。Bubble 没有 `typing` prop（核对过 2.0.3 的类型定义），只能自己留一个 */
.ai-chat__caret {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: var(--ws-accent);
  animation: ai-caret 1s steps(2) infinite;
}

@keyframes ai-caret {
  50% {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ai-chat__caret {
    animation: none;
  }
}

.ai-chat__err {
  padding: 8px 10px;
  border-radius: var(--ws-radius-sm);
  background: var(--ws-danger-soft);
  color: var(--ws-danger);
  font-size: var(--ws-fs-sm);
  overflow-wrap: anywhere;
}

.ai-chat__errdetail {
  margin: 6px 0 0;
  max-height: 160px;
  overflow: auto;
  font-family: var(--ws-mono);
  font-size: var(--ws-fs-xs);
  white-space: pre-wrap;
}

.ai-chat__foot {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
  min-width: 0;
}

/* 插槽内容自己也要能缩 —— 光在外层写 min-width:0 不够，链上每一环都得放开 */
.ai-chat__foot > * {
  min-width: 0;
}

.ai-chat__acts {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-3);
}

.ai-chat__acts :deep(a) {
  cursor: pointer;
}

.ai-chat__acts :deep(a:hover) {
  color: var(--ws-accent);
}

.ai-chat__sender {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 10px;
  min-width: 0;
}

.ai-chat__bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.ai-chat__status {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-3);
  min-width: 0;
}
</style>
