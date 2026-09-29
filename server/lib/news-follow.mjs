/**
 * 把「点过追踪的卡 + 写下的备注」导出给采集器（`<collector.dir>/follow.json`）。
 *
 * 为什么必须有：追踪与备注**只落在本机** `data/news-prefs/`，而**成卡那一步在采集器那一侧**
 * （它可能跑在另一台机器 / 另一个进程里）—— 采集器看不到点了什么、写了什么，于是规范里那句
 * 「点了「追踪」的卡就该越来越厚」一直是空的。这个模块补上「本机 → 采集器」这半条路：
 * 写一个小 JSON 到采集器产物目录，采集器（或它的智能体）读它来决定下一轮补哪些卡。
 *
 * 实现：**节流 20 秒**（点一下就会把那份更新掉，但连点几下不会连着写）；失败不抛、只记状态 ——
 * 导出不该影响点按钮的手感。产物目录没配就跳过（模块本身在那时也不显示）。
 *
 * 文件形状（采集器侧按这个读）：
 * {
 *   at, tracked: [{ title, summary, note, at }],   // note = 对这条主题的补充要求或说明
 *   notes: [{ at, title, note, kind, applied }],   // 备注原文；kind 是本地猜的调教方向
 *   learned: { kws: [{w, v, dir}] },               // 👍/👎 学出来的偏好（给采集器当参考）
 * }
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../config.mjs'
import * as fb from './news-feedback.mjs'

/** 采集器产物目录（导出目标）；留空 = 没配，直接跳过 */
const dir = () => String(loadConfig().collector?.dir || '').trim()

/** 打包要导出的那份（纯读，排障时也能直接调用） */
export function snapshot() {
  let p = { tracked: [] }
  let sugg = []
  let learned = { kws: [] }
  try {
    p = fb.prefs() || p
    sugg = fb.suggestions(60) || []
    learned = fb.learned(20) || learned
  } catch {
    /* 读不到就当空的导出，别炸 */
  }
  /** 备注按标题挂到追踪项上：在某张卡上写的话，就是他对这个主题的要求 */
  const noteOf = (title) => {
    const t = String(title || '')
    const hit = sugg.filter((r) => String(r.title || '') === t && r.note).sort((a, b) => (b.t || 0) - (a.t || 0))[0]
    return hit ? String(hit.note).slice(0, 300) : ''
  }
  return {
    at: Date.now(),
    tracked: (p.tracked ?? []).map((t) => ({
      title: String(t.title || '').slice(0, 80),
      summary: String(t.summary || '').slice(0, 200),
      note: String(t.note || '') || noteOf(t.title),
      at: Number(t.at) || 0,
    })),
    notes: sugg
      .filter((r) => r.note)
      .slice(-40)
      .map((r) => ({
        at: Number(r.t) || 0,
        title: String(r.title || '').slice(0, 80),
        note: String(r.note).slice(0, 300),
        kind: String(r.kind || 'note'),
        applied: !!r.applied,
      })),
    learned: { kws: (learned.kws ?? []).slice(0, 20) },
  }
}

let timer = null
let pushing = false
let last = { at: 0, ok: false, error: '' }

/** 导出状态（给页面/排障看） */
export function status() {
  return { ...last, pending: !!timer }
}

/** 立刻导出一份（不节流）。排障与测试用。 */
export async function pushNow() {
  if (pushing) return last
  const target = dir()
  if (!target) {
    last = { at: Date.now(), ok: false, error: '还没配采集器目录（collector.dir）' }
    return last
  }
  pushing = true
  try {
    const data = snapshot()
    if (!data.tracked.length && !data.notes.length) {
      last = { at: Date.now(), ok: true, error: '', skipped: '没有追踪也没有备注，不导出' }
      return last
    }
    const file = path.join(target, 'follow.json')
    // 原子写：采集器可能正在读它，别让它读到半个文件
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    fs.renameSync(tmp, file)
    last = { at: Date.now(), ok: true, error: '', tracked: data.tracked.length, notes: data.notes.length, file }
    return last
  } catch (e) {
    last = { at: Date.now(), ok: false, error: String(e.message || e).slice(0, 160) }
    return last
  } finally {
    pushing = false
  }
}

/** 节流导出：点按钮时调它，20 秒内的多次合并成一次 */
export function pushSoon() {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    pushNow().catch(() => {})
  }, 20_000)
  // 别让这个定时器把进程吊住（边车常驻，其实无所谓，但更干净）
  timer.unref?.()
}
