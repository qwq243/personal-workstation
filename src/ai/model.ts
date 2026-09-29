/**
 * 工作站 AI 界面的统一消息模型。
 *
 * 为什么要有这一层：四个 AI 界面（知识库问答 / 语音随记 / 看板 AI / 测聊）各自造了一套
 * 消息对象 —— 知识库叫 `Msg`、测聊叫 `Turn`、随记干脆没有数组只有几个 ref。
 * 统一之后界面层只认这一种形状，换组件、加字段都只改一处。
 *
 * 设计取舍：**只有四页共有的东西进核心，页面独有的走 `ext` 逃逸字段**。
 * 硬把 references/tools 塞进来会让语音随记背上一堆用不到的可选字段，
 * 反过来把 segments/hotwords 塞进来更荒唐（那是录音文档，不是对话）。
 */

/** 角色。注意只保留两种：错误不是一种角色，是 `status: 'error'` —— 测聊原来把错误当成 role='error'，那样没法在同一个位置显示「出错前的半截回答」。 */
export type AiRole = 'user' | 'assistant'

/**
 * 一条消息的生命周期。
 * `aborted` 与 `error` 分开：用户自己按停止得到的是 `aborted`（已保留半截，不算失败），
 * 上游出错才是 `error`。
 */
export type AiStatus = 'streaming' | 'done' | 'error' | 'aborted'

/** 工具链上的一步（检索、网络搜索、本机文件…）。对应服务端 `type:'tool'` 事件。 */
export interface AiToolStep {
  id: string
  name: string
  detail: string
  /**
   * 服务端补的结构化状态（2026-09-27 起 `wiki-chat.mjs` 会下发）。
   * 老服务端不带这个字段，适配层会退回 'ok'，界面不该因为字段缺失而显示成失败。
   *
   * `running` 是本地状态：随记的分段进度、知识库 tick 心跳都会用到「正在跑」这一步。
   * ThoughtChain 的 status 只有 loading/error/success 三种，映射关系见 AiThoughts.vue。
   */
  status?: 'running' | 'ok' | 'fail' | 'skip'
  /** 这一步花了多久（毫秒）。服务端只在知道的时候给 */
  ms?: number
  /** 这一步的产出条数（命中几页 / 取回几条） */
  count?: number
}

/** 依据（知识库问答专用）：正文里的 `[N]` 上标与它按序号一一对应，不能丢这个契约。 */
export interface AiReference {
  path: string
  title: string
  type?: string
  kind?: string
  snippet?: string
}

export interface AiUsage {
  promptTokens?: number
  completionTokens?: number
  /** 思考 token。测聊那边网关会单独给，显示在用量里 */
  thinkingTokens?: number
  [k: string]: unknown
}

/** 一条消息。`id` 必填 —— 列表 key 用它，不再用索引（索引当 key 会在插入/替换时整列重渲染）。 */
export interface AiMessage {
  id: string
  role: AiRole
  content: string
  status: AiStatus

  /* ---- 四页共有的可选块 ---- */
  reasoning?: string
  error?: string
  /** 错误详情（服务端的 error 帧另带 detail 时塞这里，界面上折进错误块） */
  errorDetail?: string
  model?: string
  elapsedMs?: number
  usage?: AiUsage

  /* ---- 知识库问答 ---- */
  tools?: AiToolStep[]
  references?: AiReference[]
  /** 输出被中断，正文是半截。服务端的 done 帧会给，本地点停止也要自己标上 */
  partial?: boolean

  /* ---- 测聊 ---- */
  /** 首字延迟 */
  ttfbMs?: number
  finishReason?: string
  /** 网关/上游原文回显（诊断用，错误时才有） */
  gatewayHint?: string

  /**
   * 页面独有的附加数据。核心不读它，只有对应页面的插槽会用。
   * 例如语音随记的分段进度、热词命中。
   */
  ext?: Record<string, unknown>
}

/* ------------------------------------------------------------------ 内部事件 -- */

/**
 * 适配层的输出：把三种线上帧（知识库判别联合 / 测聊扁平字段 / 随记 9 种 type）
 * 归一成同一组内部事件。界面与 reducer 只认这一组。
 */
export type AiStreamEvent =
  /** 流开始。带模型名等起始信息 */
  | { kind: 'start'; model?: string }
  | { kind: 'delta'; text: string }
  | { kind: 'reasoning'; text: string; chars?: number }
  | { kind: 'tool'; step: AiToolStep }
  /** 用量与耗时这类「非正文」指标，可能来得比 done 早 */
  | { kind: 'metrics'; ttfbMs?: number; elapsedMs?: number; usage?: AiUsage; finishReason?: string; model?: string }
  | {
      kind: 'done'
      references?: AiReference[]
      partial?: boolean
      sessionId?: string
      sessionTitle?: string
      model?: string
      usage?: AiUsage
      elapsedMs?: number
    }
  | { kind: 'error'; error: string; detail?: string; gatewayHint?: string }
  /** 流收尾（服务端 finally 下发，或适配层在异常后补） */
  | { kind: 'end' }
  /**
   * 页面私事：核心与 reducer 一律忽略，页面自己接管。
   * 存在的意义是让适配层**不丢事件**——例如随记的 `learned`（学出新热词，页面要重载热词库）。
   */
  | { kind: 'side'; name: string; payload?: unknown }

/** 生成消息 id。不用自增数字：列表 key 要跨会话稳定。 */
export function newMessageId(prefix = 'm'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** 造一条消息，默认字段补齐，避免每个调用点都写一遍 status/id */
export function makeMessage(init: Partial<AiMessage> & Pick<AiMessage, 'role'>): AiMessage {
  return {
    id: newMessageId(init.role === 'user' ? 'u' : 'a'),
    content: '',
    status: init.role === 'user' ? 'done' : 'streaming',
    ...init,
  }
}
