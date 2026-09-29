/**
 * 事件适配层：把三种线上帧归一成一组内部事件。
 *
 * 现状（收口前）：
 *   知识库问答 —— 判别联合 `{type:'tool'|'delta'|'reasoning'|'done'|'error'|'end'}`
 *   语音随记   —— 九种 `{type:'start'|'stage'|'reasoning'|'tick'|'delta'|'learned'|'done'|'error'|'end'}`
 *
 * 三套形状本身没问题（各自贴合自己的服务端），问题是**每个页面各自写一遍 switch**，
 * 于是「推理怎么累加」「错误怎么写进消息」这类逻辑被抄了三遍、还抄得不一样。
 * 这里改成：**纯函数适配 + 一个共享 reducer**，页面只保留自己独有的收尾动作。
 *
 * 刻意**不**抹平的三处差异（抹了就是丢功能）：
 *   1. 中断语义：知识库 abort → 静默 end；随记 abort → 完全静默
 *   2. 收尾动作：知识库要刷新会话列表、随记要回读记录并在失败时降级非流式
 *   3. 起始事件：随记有 `start`（带分块数），知识库没有
 */
import type { MemoSummaryEvent, WikiChatEvent } from '@/core/sidecar'
import type { AiMessage, AiReference, AiStreamEvent, AiToolStep } from './model'

/**
 * 工具步的序号。用模块级计数器而不是数组下标：
 * 步骤会边走边追加，下标在同一条消息里会重复（随记的分段进度会改同一步的标题）。
 */
let stepSeq = 0
function nextStepId(prefix = 't'): string {
  return `${prefix}${++stepSeq}`
}

/* ------------------------------------------------------------ 知识库问答 -- */

export function adaptWikiEvent(e: WikiChatEvent): AiStreamEvent[] {
  switch (e.type) {
    case 'delta':
      return [{ kind: 'delta', text: e.text ?? '' }]

    case 'reasoning':
      return [{ kind: 'reasoning', text: e.text ?? '' }]

    case 'tool': {
      const step: AiToolStep = {
        // 服务端给了 id 就用它：心跳每 2 秒下发一次，靠稳定 id 原地更新同一行，
        // 否则工具链上会每 2 秒长出一行「准备中」
        id: e.id ?? nextStepId(),
        name: e.name ?? '',
        detail: e.detail ?? '',
        // 服务端补的结构化字段；老服务端没有就当成功（不能因为缺字段显示成失败）
        status: e.status ?? 'ok',
        ms: e.ms,
        count: e.count,
      }
      return [{ kind: 'tool', step }]
    }

    case 'done':
      return [
        {
          kind: 'done',
          references: (e.references ?? []) as AiReference[],
          partial: e.partial,
          sessionId: e.sessionId,
          sessionTitle: e.sessionTitle,
          // 这两个字段服务端一直在下发，收口前前端把它丢了；现在收进 metrics 供界面显示
          usage: e.usage,
          elapsedMs: e.elapsedMs,
        },
        ...(e.usage || e.elapsedMs !== undefined
          ? ([{ kind: 'metrics', usage: e.usage, elapsedMs: e.elapsedMs }] as AiStreamEvent[])
          : []),
      ]

    case 'error':
      return [{ kind: 'error', error: e.error ?? '问答失败', detail: e.detail }]

    case 'end':
      return [{ kind: 'end' }]

    default:
      return []
  }
}

/* -------------------------------------------------------------- 语音随记 -- */

export function adaptMemoEvent(e: MemoSummaryEvent): AiStreamEvent[] {
  switch (e.type) {
    case 'start':
      return [
        { kind: 'start', model: e.model },
        { kind: 'side', name: 'start', payload: { mode: e.mode, chunks: e.chunks } },
      ]

    /**
     * 分段进度 → 工具步。
     * `part i/n` 是「正在整理第 i 块」，`merge` 是「把各块合并成总稿」。
     * 同一步会有多次下发（先 running、后来 title、最后 done），所以**id 必须稳定**（用 phase+index），
     * 靠 id 原地更新，别每来一次就追加一行 —— 界面上一行标题变来变去才对，不是列一长串。
     */
    case 'stage': {
      const isMerge = e.phase === 'merge'
      const idx = e.index ?? 0
      const total = e.total ?? 0
      const step: AiToolStep = {
        id: isMerge ? 'stage-merge' : `stage-part-${idx}`,
        name: isMerge ? '合并总稿' : `整理第 ${idx}${total ? `/${total}` : ''} 块`,
        detail: e.title ?? '',
        status: e.failed ? 'fail' : e.running ? 'running' : 'ok',
        count: e.chars,
      }
      return [{ kind: 'tool', step }]
    }

    case 'reasoning':
      return [{ kind: 'reasoning', text: e.text, chars: e.chars }]

    case 'tick':
      return [{ kind: 'metrics', elapsedMs: (e.elapsedSec ?? 0) * 1000 }]

    case 'delta':
      return [{ kind: 'delta', text: e.text }]

    /** 学出新热词：这是页面私事（要重载热词库），交给 side 通道，核心不碰 */
    case 'learned':
      return [{ kind: 'side', name: 'learned', payload: { categoryName: e.categoryName, terms: e.terms } }]

    case 'done':
      return [{ kind: 'done' }]

    case 'error':
      return [{ kind: 'error', error: e.error }]

    case 'end':
      return [{ kind: 'end' }]

    default:
      return []
  }
}

/* --------------------------------------------------------------- reducer -- */

/**
 * 把一条内部事件应用到消息上（原地改，调用方拿的是响应式对象）。
 *
 * **只做「消息自己的事」**：正文/推理/工具/指标的累加与状态流转。
 * 不碰会话列表刷新、不碰记录回读、不碰滚动 —— 那些是页面独有的收尾动作，留在页面里。
 *
 * @returns 是否发生了需要重渲染的变化（`end`/`side` 返回 false，让调用方能省一次渲染）
 */
export function applyEvent(msg: AiMessage, ev: AiStreamEvent): boolean {
  switch (ev.kind) {
    case 'start':
      if (ev.model) msg.model = ev.model
      msg.status = 'streaming'
      return false

    case 'delta':
      if (!ev.text) return false
      msg.content += ev.text
      return true

    case 'reasoning':
      if (!ev.text) return false
      msg.reasoning = (msg.reasoning ?? '') + ev.text
      return true

    case 'tool': {
      const list = msg.tools ? [...msg.tools] : []
      const at = list.findIndex((s) => s.id === ev.step.id)
      if (at >= 0) list[at] = { ...list[at], ...ev.step }
      else list.push(ev.step)
      msg.tools = list
      return true
    }

    case 'metrics':
      if (ev.ttfbMs !== undefined) msg.ttfbMs = ev.ttfbMs
      if (ev.elapsedMs !== undefined) msg.elapsedMs = ev.elapsedMs
      if (ev.usage) msg.usage = ev.usage
      if (ev.finishReason) msg.finishReason = ev.finishReason
      if (ev.model) msg.model = ev.model
      return false

    case 'done':
      if (ev.references) msg.references = ev.references
      if (ev.partial) msg.partial = true
      if (ev.usage) msg.usage = ev.usage
      if (ev.elapsedMs !== undefined) msg.elapsedMs = ev.elapsedMs
      if (ev.model) msg.model = ev.model
      if (msg.status === 'streaming') msg.status = 'done'
      return false

    case 'error': {
      // 出错时**不清空已有正文**：半截回答比一句报错有用（收口前知识库就是这么做的）
      msg.error = ev.error
      if (ev.detail) msg.errorDetail = ev.detail
      if (ev.gatewayHint) msg.gatewayHint = ev.gatewayHint
      msg.status = 'error'
      return true
    }

    case 'end':
      if (msg.status === 'streaming') msg.status = 'done'
      return false

    case 'side':
      return false
  }
  return false
}

/**
 * 中断（用户按停止）时用。
 * 知识库原来的做法只是把 streaming 置 false，界面上看不出「这是半截」——
 * 统一之后一律标 `aborted` + `partial`，界面据此显示「已停止（保留了半截）」。
 */
export function markAborted(msg: AiMessage): void {
  if (msg.status !== 'streaming') return
  msg.status = 'aborted'
  if (msg.content) msg.partial = true
}
