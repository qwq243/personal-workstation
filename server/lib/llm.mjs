/**
 * 统一的大模型调用层：**输出预算**与**「思考吃光正文」的守卫**只在这里实现一次。
 *
 * 为什么要有这一层（2026-09-27 踩出来的）：
 *   思考 token 与正文**共用 max_tokens**。同一个模型，任务轻时想几十 token 就够了，
 *   任务重时（整理一段 5000 字的口述）能想 2 万字 —— 于是"给多少预算"这件事，
 *   每个调用点各写一遍必然出错：
 *     给 2500 → 思考吃掉 2.2 万字，正文被截成 466 字；
 *     给 900  → 正文直接空串；
 *     给 300  → 滚动摘要永远不出现（第一版就是这么静默失败的）。
 *   所以：
 *     1. **预算按输入体量算**（tier + 输入字数），长任务允许放大（cap 4.8 万）；
 *     2. **正文空/明显过短 → 自动加倍预算、退回非流式再跑一次**（非流式不会被流式截断）；
 *     3. 调用方只写业务提示词，不许再自己拍 maxTokens。
 *
 * 用法：
 *   const r = await chatGuarded(messages, { tier: 'doc', chars: 5202, model })
 *   const r = await chatStreamGuarded(messages, { tier: 'doc', chars, onDelta, onEvent, signal })
 */

import { chat, chatStream } from './newapi.mjs'

/**
 * 预算档位。`perChar` 是"每字输入给多少输出 token"——
 * 中文里 1 字≈1 token，整理类任务正文长度大致与输入同量级，再乘个思考系数。
 */
export const BUDGET = {
  /** 只要一两句的：滚动摘要、起标题 */
  short: { base: 3_000, perChar: 0.3, min: 3_000, cap: 12_000 },
  /** 普通问答 / 短材料总结 */
  normal: { base: 6_000, perChar: 1, min: 6_000, cap: 24_000 },
  /** 长材料整理：输入几千字、正文要分条展开 */
  doc: { base: 6_000, perChar: 2.5, min: 8_000, cap: 48_000 },
}

/** 首轮预算与重试预算（重试翻倍，仍然封顶） */
export function budgetFor(tier = 'normal', chars = 0) {
  const plan = BUDGET[tier] ?? BUDGET.normal
  const size = Math.max(0, Number(chars) || 0)
  const first = Math.min(plan.cap, Math.max(plan.min, Math.round(plan.base + size * plan.perChar)))
  return { first, retry: Math.min(plan.cap * 2, first * 2), tier, chars: size }
}

/** 正文是不是"不像话地少"：长输入配了极短的正文，基本就是被思考挤掉了 */
function tooThin(content, chars, tier) {
  const text = String(content ?? '').trim()
  if (!text) return true
  if (tier === 'doc') {
    const expect = Math.min(600, Math.max(120, Math.round((Number(chars) || 0) * 0.15)))
    return text.length < expect
  }
  return text.length < 8
}

/**
 * 非流式调用（带守卫）。返回 { ok, content, reasoning, usage, model, ... }，与 newapi.chat 同形。
 * tier/chars 只用来算预算；其余 opts（model / temperature / timeout / extraBody）原样透传。
 */
export async function chatGuarded(messages, { tier = 'normal', chars = 0, label = 'llm', ...opts } = {}) {
  const plan = budgetFor(tier, chars)
  let r = await chat(messages, { ...opts, maxTokens: plan.first })
  if (r.ok && tooThin(r.content, chars, tier)) {
    console.warn(
      `[${label}] 正文异常（首轮预算 ${plan.first}，拿到 ${String(r.content ?? '').length} 字，思考 ${String(r.reasoning ?? '').length} 字），放大到 ${plan.retry} 重试`,
    )
    const retry = await chat(messages, { ...opts, maxTokens: plan.retry })
    if (retry.ok && String(retry.content ?? '').trim()) return retry
    if (retry.ok && !r.content) return retry
    return r.ok && String(r.content ?? '').trim() ? r : (retry.ok ? retry : r)
  }
  return r
}

/**
 * 流式调用（带守卫）：正文增量走 onDelta，思考走 onEvent({type:'reasoning'})。
 * 正文空/过短时退回非流式大预算重跑一次（把结果一次性当 delta 补出去，前端不用改）。
 */
export async function chatStreamGuarded(
  messages,
  { tier = 'normal', chars = 0, label = 'llm', onDelta, onEvent, signal, ...opts } = {},
) {
  const plan = budgetFor(tier, chars)
  let r = await chatStream(messages, { ...opts, maxTokens: plan.first, onDelta, onEvent, signal })
  if (signal?.aborted) return r
  if (!r.ok || tooThin(r.content, chars, tier)) {
    console.warn(
      `[${label}] 流式正文异常（预算 ${plan.first}，拿到 ${String(r.content ?? '').length} 字，思考 ${String(r.reasoning ?? '').length} 字），改用非流式 ${plan.retry} 重试`,
    )
    const retry = await chat(messages, { ...opts, maxTokens: plan.retry })
    if (retry.ok && String(retry.content ?? '').trim()) {
      onDelta?.(retry.content)
      return retry
    }
    return r.ok ? r : retry
  }
  return r
}
