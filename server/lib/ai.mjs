/**
 * AI 能力：每日总结、今日建议、自由问答。
 *
 * 全部经边车代理一个 OpenAI 兼容端点（浏览器完全不碰密钥），端点与密钥在设置页里配。
 * 提示词把「已知事实」结构化喂进去，减少模型编造；输出要求短、可执行。
 */
import { chat, balance, todaySpendByToken } from './newapi.mjs'
import { getDay, recentDays, streak, todayStr } from './dashboard.mjs'
import { loadConfig } from '../config.mjs'
import * as schoolCalendar from './school-calendar.mjs'
import * as plan from './plan.mjs'
import * as vocab from './vocab.mjs'

/** 汇总「喂给模型的事实」。任何一块取不到都标记出来，不让模型猜。 */
export async function gatherContext(date = todayStr()) {
  const ctx = { date }
  // 教学周由校历现算：放假 / 考试周 / 调休都会影响，且这属于「日历事实」不属于某个业务模块
  try {
    const mark = schoolCalendar.markOf(date)
    ctx.school = { week: mark.week, suspend: !!mark.suspend, label: mark.label ?? '', tag: mark.tag ?? '' }
  } catch {
    ctx.school = null
  }

  // 下面几块互相独立（余额 / 花费走 NewAPI、词单进度读本地文件）。
  // 先全部发起再按顺序取用，只等最慢的一个 —— 串行 await 会让「点 AI 总结」多等十几秒。
  //
  // settle 是必需的，不是保险：先发起、后 await 的这段时间里，若某个 Promise 先被拒绝，
  // Node 会按「未处理的拒绝」处理（Node 22 默认直接终止进程）。发起时就挂上拒绝处理，一个都不许漏。
  const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }))
  const balP = settle(balance())
  const spendP = settle(todaySpendByToken())

  const day = getDay(date)
  ctx.plan = { plans: day.plans ?? [], notes: day.notes ?? [], mood: day.mood, done: day.done, tomorrow: day.tomorrow }
  ctx.streak = streak()
  ctx.recent = recentDays(7).map((d) => ({ date: d.date, plans: d.plans, done: d.plansDone, notes: d.notes }))

  try {
    const progress = vocab.readProgress()
    const allStats = Object.values(progress.stats ?? {})
    const masteredSetting = progress.settings?.masterStreak ?? 2
    ctx.vocab = {
      totalWords: allStats.length,
      mastered: allStats.filter((s) => (s.streak ?? 0) >= masteredSetting).length,
    }
  } catch (e) {
    ctx.vocab = { error: e.message }
  }

  const balR = await balP
  const bal = balR.ok ? balR.v : { ok: false, error: balR.e?.message ?? String(balR.e) }
  ctx.balance = bal.ok ? { yuan: bal.quotaYuan, used: bal.usedYuan, requests: bal.requestCount } : { error: bal.error }
  const spendR = await spendP
  const spend = spendR.ok ? spendR.v : { ok: false, error: spendR.e?.message ?? String(spendR.e) }
  // 保持与 todaySpendByToken 一致的字段名（前端直接读 totalYuan / items）
  ctx.todaySpend = spend.ok
    ? {
        totalYuan: spend.totalYuan,
        items: spend.items.slice(0, 8).map((i) => ({ name: i.name, yuan: i.yuan })),
      }
    : { error: spend.error }

  return ctx
}

function ctxToText(ctx) {
  const L = []
  if (ctx.school) {
    const s = ctx.school
    L.push(
      s.suspend
        ? `日期：${ctx.date}（不上课${s.label ? `·${s.label}` : ''}${s.tag ? `·${s.tag}` : ''}）`
        : `日期：${ctx.date}${s.week ? `（教学第 ${s.week} 周${s.tag ? `，另标注：${s.tag}` : ''}）` : ''}`,
    )
  } else {
    L.push(`日期：${ctx.date}`)
  }
  const p = ctx.plan
  L.push(`今天自己写的计划：${(p.plans ?? []).map((x) => `${x.done ? '[已完成]' : '[未完成]'}${x.text}`).join('；') || '（还没写）'}`)
  if (p.notes?.length) L.push(`今天随手记录：${p.notes.map((n) => n.text).slice(0, 6).join('；')}`)
  if (p.done) L.push(`今天的复盘：${p.done}`)
  if (p.mood) L.push(`今天状态：${p.mood}/5 ${p.moodNote ?? ''}`)
  L.push(`连续记录天数：${ctx.streak}`)
  const r = ctx.recent.filter((d) => d.plans || d.notes)
  if (r.length) L.push(`近 7 天：${r.map((d) => `${d.date.slice(5)} 计划${d.plans}完成${d.done}笔记${d.notes}`).join('，')}`)
  if (ctx.vocab?.error) L.push('背单词：读不到进度')
  else if (ctx.vocab) L.push(`背单词：共 ${ctx.vocab.totalWords} 词，已掌握 ${ctx.vocab.mastered}`)
  L.push(ctx.balance?.error ? `余额：取不到` : `模型余额：¥${ctx.balance.yuan}（累计已用 ¥${ctx.balance.used}，请求 ${ctx.balance.requests}）`)
  L.push(
    ctx.todaySpend?.error
      ? `今日花费：取不到`
      : `今日模型花费：¥${ctx.todaySpend.totalYuan}（${ctx.todaySpend.items.map((i) => `${i.name} ¥${i.yuan}`).join('，')}）`,
  )
  return L.join('\n')
}

/**
 * 系统提示词里的「服务对象」这段。
 *
 * 本来这里写死了一句身份（学校 + 学号 + 专业）—— 那是作者本机的用法，
 * 开源版抽成配置项：`config.json` 的 `ai.persona`，谁用谁改；
 * 想再具体一点，把身份信息写进 `server/credentials.json` 的 `ai.personaPrivate`（本机文件，不进版本库）。
 */
function personaLine() {
  const cfg = loadConfig()
  const base = String(cfg.ai?.persona ?? '').trim() || '服务对象是一名在校大学生'
  const extra = String(cfg.ai?.personaPrivate ?? '').trim()
  return extra ? `${base}（${extra}）` : base
}

const SYSTEM_BASE = () =>
  `你是一个个人工作站里的助手，${personaLine()}。` +
  '说话直接、务实，不寒暄、不堆套话、不用 emoji 滥用。' +
  '只依据「已知事实」作答；事实里没有的信息不要编，需要的话明确说「这个我不知道」。' +
  '给建议要具体可执行，避免「保持专注」这类空话。'

/** 每日总结 + 今日建议（看板主卡片） */
export async function dailySummary({ date, force = false } = {}) {
  const ctx = await gatherContext(date)
  const facts = ctxToText(ctx)
  const prompt =
    `这是今天的情况：\n\n${facts}\n\n` +
    `请输出两段，用下面固定标题，不要加别的标题、不要 markdown 代码块：\n\n` +
    `【今日要点】\n3-5 条，每条一行，先说事实（几节课/哪个任务/花了多少钱/状态如何），再给一句判断。\n\n` +
    `【建议】\n2-4 条，每条一行，具体到「现在做什么」。如果看到卡点或连续多天没动的待办，优先提醒并给出最小下一步。`

  const r = await chat([
    { role: 'system', content: SYSTEM_BASE() },
    { role: 'user', content: prompt },
  ])
  if (!r.ok) return { ok: false, date: ctx.date, error: r.error, detail: r.detail, context: ctx }
  return {
    ok: true,
    // date 一定要带出来：调用方（/api/ai/summary）要按这个日期存档，否则存到哪一天就靠猜了
    date: ctx.date,
    content: r.content,
    model: r.model,
    provider: r.provider,
    usage: r.usage,
    context: ctx,
    facts,
    generatedAt: Date.now(),
  }
}

/**
 * 今日行动建议：由「昨天的总结 + 今天的课表/待办/临近截止」推 3 条现在就能做的动作。
 *
 * 和 dailySummary 的分工（2026-09-14 与用户对齐）：
 *   dailySummary → 回顾「那天发生了什么」，第二天早上当昨天看；
 *   todayBrief   → 推荐今天怎么过，**综合口径**：课表空档 + 未完成待办 + 最近截止 + 备考阶段。
 *
 * 倒计时与项目进度从规划台（plan.json）现读进提示词，模型只负责判断与排序，
 * 不负责记日期 —— 它背日期必出错。输出的 markdown 只用 **加粗** 和列表（前端 MdLite 能渲染）。
 */
export async function todayBrief({ date, recap } = {}) {
  const d = date ?? todayStr()
  const ctx = await gatherContext(d)

  // 规划台事实：主线倒计时 + 临近里程碑 + 项目阶段 + 备考进度
  const planLines = []
  try {
    const p = plan.panel()
    for (const e of p.hero) {
      if (e.daysLeft >= 0) planLines.push(`${e.name}：还有 ${e.daysLeft} 天（${e.date}${e.official ? '，官方日期' : '，推算日期'}）`)
    }
    for (const e of p.milestones) {
      if (e.daysLeft >= 0 && e.daysLeft <= 45) planLines.push(`${e.name}：还有 ${e.daysLeft} 天（${e.date}）`)
    }
    for (const pr of p.projects) {
      const dl = pr.daysLeft >= 0 && pr.daysLeft <= 30 ? `，截止 ${pr.deadline}（只剩 ${pr.daysLeft} 天）` : ''
      planLines.push(`项目「${pr.name}」${pr.priority ?? ''}${pr.stage ? `，当前阶段：${pr.stage}` : ''}${dl}`)
    }
    for (const s of p.prep) planLines.push(`备考「${s.name}」：${s.stage}，清单进度 ${s.done}/${s.total}`)
  } catch {
    /* 规划台读不到就不给这部分事实，别让它挡住建议 */
  }

  // 校历：放假 / 考试周 / 调休会直接改变「今天该怎么安排」
  const mark = schoolCalendar.markOf(d)
  const schoolLine = mark.suspend
    ? `今天不上课（${mark.label}${mark.tag ? `·${mark.tag}` : ''}）`
    : mark.week
      ? `今天上课（教学第 ${mark.week} 周${mark.tag ? `，另标注：${mark.tag}` : ''}）`
      : '今天不上课'

  const facts = [
    `日期：${d}。${schoolLine}`,
    ctx.vocab?.error ? '背单词：读不到进度' : ctx.vocab ? `背单词：共 ${ctx.vocab.totalWords} 词，已掌握 ${ctx.vocab.mastered}` : '',
    `今天已写的计划：${(ctx.plan?.plans ?? []).map((x) => `${x.done ? '[已完成]' : ''}${x.text}`).join('；') || '（还没写）'}`,
    planLines.length ? `目标与截止（来自规划台）：\n${planLines.join('\n')}` : '',
    recap?.ok ? `昨天的总结（供衔接，不要复述原文）：\n${String(recap.content).slice(0, 700)}` : '昨天的总结：没有',
  ]
    .filter(Boolean)
    .join('\n')

  const prompt =
    `这是今天的已知事实：\n\n${facts}\n\n` +
    `请给「今天怎么过」的行动建议，格式严格遵守：\n` +
    `第一行：**今天最重要的一件事**：…（用加粗标出那件事，一句话说清为什么是它，依据只能是上面的事实）\n` +
    `然后 2-3 条建议，每条一行、以「- 」开头：动词开头、具体到时段或动作，落在已写的计划 / 临近截止 / 备考阶段上；` +
    `14 天内要到的截止日必须优先提醒。\n` +
    `最后一行：**风险**：…（连续多天没动的计划、临近的截止）；实在没有就写「无」。\n` +
    `不要别的标题、不要代码块、总长不超过 200 字。事实里没有的不要编。`

  const r = await chat([
    { role: 'system', content: SYSTEM_BASE() },
    { role: 'user', content: prompt },
  ])
  if (!r.ok) return { ok: false, date: d, error: r.error, detail: r.detail }
  return { ok: true, date: d, content: r.content, model: r.model, provider: r.provider, usage: r.usage, generatedAt: Date.now() }
}

/** 晚间复盘助手：把今天的计划/笔记整理成一段可保存的复盘 */
export async function reviewDraft({ date } = {}) {
  const d = date ?? todayStr()
  const ctx = await gatherContext(d)
  const prompt =
    `这是今天的记录：\n\n${ctxToText(ctx)}\n\n` +
    `请替我写一段今日复盘，用于自己回看。要求：\n` +
    `1) 先按项目归类今天做了什么（不知道的不要编）；\n` +
    `2) 指出哪件真正推进了、哪件只是原地打转；\n` +
    `3) 最后给 2-3 条明天的具体安排。\n` +
    `总长控制在 400 字内，用通顺的中文段落，不要 markdown。`
  const r = await chat([{ role: 'system', content: SYSTEM_BASE() }, { role: 'user', content: prompt }])
  if (!r.ok) return { ok: false, error: r.error, detail: r.detail }
  return { ok: true, content: r.content, model: r.model, generatedAt: Date.now() }
}

/** 自由问答：带上今天的上下文 */
export async function ask(question, { date, history = [] } = {}) {
  if (!question?.trim()) return { ok: false, error: '问题为空' }
  const ctx = await gatherContext(date)
  const messages = [
    { role: 'system', content: `${SYSTEM_BASE()}\n\n以下是当前已知事实，回答时优先使用：\n${ctxToText(ctx)}` },
    ...history.slice(-8).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: question },
  ]
  const r = await chat(messages)
  if (!r.ok) return { ok: false, error: r.error, detail: r.detail }
  return { ok: true, content: r.content, model: r.model, usage: r.usage }
}
