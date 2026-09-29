<script setup lang="ts">
/**
 * AI 的工具链与推理过程 —— **全站唯一一处**。
 *
 * 收口前这套东西被抄了三遍，而且三遍都不一样：
 *   知识库问答 —— 工具链是「一排灰色胶囊」，推理是手风琴（跨消息只允许开一个）
 *   测聊       —— 没有工具链；推理直接平铺出来、**不能折叠**
 *   语音随记   —— 分段进度是自己画的一列（is-done/is-running），推理另有折叠按钮
 *
 * 现在统一走 vue-element-plus-x 的 ThoughtChain（工具调用）与 Thinking（推理）。
 * 折叠规矩也统一了：改用 Thinking 自带的 `autoCollapse`（跑完自动收起），
 * 而不是原来那套「手写状态 + 跨消息只开一个」—— 后者是组件能力不足时的将就，
 * 而且用户想同时看两条的思考时反而不给。
 */
import { computed } from 'vue'
import { Thinking, ThoughtChain } from 'vue-element-plus-x'
import type { AiToolStep } from './model'

const props = defineProps<{
  /** 工具链（知识库的检索轮次、随记的分段进度都走这里） */
  tools?: AiToolStep[]
  /** 推理正文（流式累加） */
  reasoning?: string
  /**
   * 这条消息当前处在哪一阶段。决定 Thinking 的状态图标：
   * 进行中显示转圈、出错显示红叉、用户中断显示「已取消」、正常结束显示对勾。
   */
  phase?: 'streaming' | 'done' | 'error' | 'aborted'
}>()

/**
 * `AiToolStep.status` → ThoughtChain 的 status。
 *
 * ThoughtChain 只认三种：loading / error / success。
 * 所以这里是**降级映射**，两处不精确要记住：
 *   · `running` → `loading`（语义一致）
 *   · `fail`    → `error`（语义一致）
 *   · `ok`      → `success`
 *   · `skip`    → `success` —— **「跳过」没有对应的第三种状态**，
 *     所以只能降级成 success，靠标题里的「跳过」二字表达。
 *     别为了图标好看把 skip 塞进 error：那会把「按配置跳过」误报成失败。
 */
const STATUS_MAP: Record<string, 'loading' | 'error' | 'success'> = {
  running: 'loading',
  fail: 'error',
  ok: 'success',
  skip: 'success',
}

/**
 * 工具步 → ThoughtChain 的 item。
 *
 * 注意 `isCanExpand` 与 `thinkContent` 在这个库里是**必填**的（类型上就要求），
 * 少了会在运行时报警。没有详情可展开时给 `isCanExpand: false`，别传 undefined。
 */
const items = computed(() =>
  (props.tools ?? []).map((s) => {
    // 服务端补的 count/ms 是结构化字段；老服务端没有就只显示名字
    const tail = [s.count != null ? `${s.count} 条` : '', s.ms != null ? `${s.ms}ms` : ''].filter(Boolean).join(' · ')
    return {
      id: s.id,
      title: tail ? `${s.name}（${tail}）` : s.name,
      thinkTitle: '这一步的详情',
      thinkContent: s.detail || '（无详情）',
      isCanExpand: !!s.detail,
      status: STATUS_MAP[s.status ?? 'ok'] ?? 'success',
    }
  }),
)

/** Thinking 的状态。没有推理内容时它自己会隐藏，不用我们判断。 */
const thinkingStatus = computed<'start' | 'thinking' | 'end' | 'error' | 'cancel'>(() => {
  switch (props.phase) {
    case 'streaming':
      return 'thinking'
    case 'error':
      return 'error'
    case 'aborted':
      return 'cancel'
    default:
      return 'end'
  }
})
</script>

<template>
  <div v-if="items.length || reasoning" class="ai-thoughts">
    <!-- 工具链：检索轮次 / 分段进度都在这儿 -->
    <ThoughtChain v-if="items.length" :thinking-items="items" line-gradient />

    <!--
      推理过程。`auto-collapse` = 跑完自动收起（折叠规矩统一到这里）。
      `#label` 用来把「已思考 N 字」写进那颗按钮 —— 原来三个页面各写一遍这个字数。
    -->
    <Thinking
      v-if="reasoning"
      :content="reasoning"
      :status="thinkingStatus"
      auto-collapse
      max-width="100%"
    >
      <template #label="{ status }">
        <span>
          {{ status === 'thinking' ? '正在思考' : '思考过程' }}
          <span class="ws-dim">· {{ reasoning.length }} 字</span>
        </span>
      </template>
    </Thinking>
  </div>
</template>

<style scoped>
/* 只调间距：其余视觉全交给库组件，别再在这里手画气泡/胶囊。
   这条规矩写在 docs/ai-ui.md，并由 npm run check:ai-ui 兜底。 */
.ai-thoughts {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
</style>
