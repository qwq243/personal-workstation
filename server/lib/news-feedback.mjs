/**
 * 资讯反馈档（`#/news` 的「调教采集」闭环）。
 *
 * 对每条事件给 👍 / 👎 / 备注。这不是打分收藏，是**采集器的指挥信号**：
 *  - 👍 / 👎 落到 `prefs.json`（按源 / 主题 / 关键词加权），看板给**每批的最新卡**时按它排序 ——
 *    在意的浮上来，不关心的沉下去。
 *  - **备注是重信号**：一个人拍脑袋调不出规则，但一句「以后别给我 GitHub 仓库」就是一条现成的
 *    `titleExclude`。所以每一条备注都会落到 `suggestions.json`，页面把它变成**可一键加进
 *    采集器 `sources.json`** 的按钮（黑名单 / 加权 / 降频）。
 *
 * 只用追加（只往后面写，不改前面）—— 边车与你自己都可能写，追加不会把对方盖掉。
 * 文件落在 `<dataDir>/news-prefs/`。
 */
import fs from 'node:fs'
import path from 'node:path'
import { dataDir, loadConfig } from '../config.mjs'

const dir = () => {
  const p = path.join(dataDir(), 'news-prefs')
  fs.mkdirSync(p, { recursive: true })
  return p
}
const P = (f) => path.join(dir(), f)
const readJson = (file, d) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return d
  }
}
const writeJson = (file, obj) => {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
  fs.renameSync(tmp, file)
}

/* -------------------------------------------------------------- 权重 --- */

/**
 * 基础分：主题（默认 1.0）· 源（默认 1.0）· 关键词（默认 0）· 追踪中的卡。
 * `tracked` 是 2026-09-28 加的：点「追踪」= 下一轮概括要在**原卡上补齐**，
 * 不是重新生成一张（规范 §1.3）。
 */
function basePrefs() {
  return { cat: {}, source: {}, kw: {}, notes: [], tracked: [] }
}

export function prefs() {
  return readJson(P('prefs.json'), basePrefs())
}

/**
 * 计算某一条的权重：主题 × 源 × ∏关键词。
 * 👍 让某项 ×1.12、👎 让某项 ÷1.12，多次反馈会指数累积；源与主题各自收在 [0.2, 3]，
 * 不封顶（多个词同向时会放大）但每步被夹在 [0.35, 2.8]，避免一个词就把结果翻过去。
 */
export function weightFor({ cat, sourceId, kws = [] }) {
  const p = prefs()
  let w = (p.cat[cat] ?? 1) * (p.source[sourceId] ?? 1)
  for (const k of kws) w *= 1 + (p.kw[k] ?? 0)
  return w
}

/** 👍 / 👎 打到哪几项上（主题与源各按 12% 调，词按 20% 调） */
function applyVote(it, vote) {
  const p = prefs()
  const f = vote === 'up' ? 1.12 : 1 / 1.12
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))
  if (it.cat) p.cat[it.cat] = clamp((p.cat[it.cat] ?? 1) * f, 0.2, 3)
  if (it.sourceId) p.source[it.sourceId] = clamp((p.source[it.sourceId] ?? 1) * f, 0.2, 3)
  for (const k of it.kws ?? []) {
    p.kw[k] = clamp((p.kw[k] ?? 0) + (vote === 'up' ? 0.15 : -0.15), -0.65, 1.5)
  }
  p.notes.push({ t: Date.now(), vote, title: String(it.title || '').slice(0, 120), cat: it.cat || '', sourceId: it.sourceId || '', kws: (it.kws || []).slice(0, 6) })
  if (p.notes.length > 2000) p.notes = p.notes.slice(-2000)
  writeJson(P('prefs.json'), p)
  return { ok: true, catW: p.cat[it.cat] ?? 1, sourceW: p.source[it.sourceId] ?? 1 }
}

/* -------------------------------------------------------------- 备注 --- */

/**
 * 备注→规则建议。规则本身不聪明，只是**把那句中文变成 sources.json 能吃的字段**；
 * 真正聪明的地方在写它的人：写下「以后别给我 XX」的那一刻，规则就已经成立了。
 *
 * 识别这几类（优先级从上到下）：
 *  ① 黑名单：「别 / 不要 / 拉黑 / 屏蔽 / 滚 / 别再」+ 源或词 → titleExclude / disableSource
 *  ② 加权：「多给我 / 多推 / 多来点」→ 那条主题权重 +20%（相当于一次 👍，但更狠）
 *  ③ 降频：「少给我 / 少来点」→ 那条主题权重 −20%
 *  ④ 其他：原样存档，标 kind:'note'
 */
export function addFeedback(it) {
  const vote = String(it.vote || '')
  const note = String(it.note || '').trim()
  const out = { ok: true }

  if (vote === 'up' || vote === 'down') out.vote = applyVote(it, vote)

  if (note) {
    const row = {
      t: Date.now(),
      id: String(it.id || ''),
      title: String(it.title || '').slice(0, 120),
      url: it.url || '',
      cat: it.cat || '',
      sourceId: it.sourceId || '',
      note: note.slice(0, 400),
      kind: 'note',
      applied: false,
    }
    // 关键词：那句备注里抓最像「对象」的一段（中英数字，去掉「以后别给我」这类壳）
    const shell = /(以后|请|帮我|别再|别|不要|不用|拉黑|屏蔽|多给我|多推|多来点|少给我|少来点|来点|来点吧|就|的|了|啦|啊|呢|吧|给|我|要|是|再|别|让|把|这类|这种|那些|这些|相关|有关|关于|这类型的?|这个|这种的)/g
    const kw = note.replace(shell, ' ').match(/[一-龥A-Za-z0-9+#.\-]{2,12}/g)
    row.kw = kw && kw.length ? kw[0] : ''
    if (/拉黑|屏蔽|别再|别给|不要|不用|滚/.test(note)) row.kind = 'blacklist'
    else if (/多给|多推|多来点|想多/.test(note)) row.kind = 'boost'
    else if (/少给|少来点|不想看/.test(note)) row.kind = 'reduce'

    const arr = readJson(P('suggestions.json'), [])
    arr.push(row)
    writeJson(P('suggestions.json'), arr.slice(-500))
    out.suggestion = row
  }
  return out
}

/* --------------------------------------------------------- 一键采用 --- */

/**
 * 把一条备注一键落进采集器：改的是**采集器那份** `sources.json`（`collector.dir` 下），
 * 也就是采集器真正会读的那一份。没配目录就直说，不猜路径。
 */
export function applySuggestion(id, action) {
  const arr = readJson(P('suggestions.json'), [])
  const row = arr.find((x) => String(x.id) === String(id) || (x.t === Number(id) || x.note === id))
  if (!row) return { ok: false, error: '找不到这条建议' }

  const collectorDir = String(loadConfig().collector?.dir || '').trim()
  if (!collectorDir) return { ok: false, error: '还没配采集器目录（collector.dir），没地方写 sources.json' }
  const file = path.join(collectorDir, 'sources.json')
  const sources = readJson(file, [])
  if (!Array.isArray(sources)) return { ok: false, error: `读不到 ${file}` }

  const src = sources.find((s) => s.id === row.sourceId)
  const changes = []
  if (action === 'disable' && src) {
    src.disabled = true
    changes.push(`停用源 ${src.id}`)
  } else if (action === 'exclude' && src && row.kw) {
    const prev = src.titleExclude ? src.titleExclude + '|' : ''
    if (!prev.includes(row.kw)) src.titleExclude = prev + row.kw
    changes.push(`${src.id} 的标题排除加上「${row.kw}」`)
  } else if (action === 'boost' && row.cat) {
    const p = prefs()
    p.cat[row.cat] = Math.min(3, (p.cat[row.cat] ?? 1) * 1.2)
    writeJson(P('prefs.json'), p)
    changes.push(`主题 ${row.cat} 权重 +20%`)
  } else if (action === 'reduce' && row.cat) {
    const p = prefs()
    p.cat[row.cat] = Math.max(0.2, (p.cat[row.cat] ?? 1) / 1.2)
    writeJson(P('prefs.json'), p)
    changes.push(`主题 ${row.cat} 权重 −20%`)
  } else {
    return { ok: false, error: '这个动作现在只支持 disable / exclude / boost / reduce' }
  }

  if (changes.some((c) => c.includes('停用') || c.includes('标题排除'))) writeJson(file, sources)
  row.applied = true
  row.appliedAt = Date.now()
  row.action = action
  writeJson(P('suggestions.json'), arr)
  return { ok: true, changes, note: '规则已写进采集器的 sources.json（下一轮采集生效）。' }
}

/** 追踪中的卡（新加的在前）；概括时会拿它去要求「原卡补齐」 */
export function trackedCards() {
  return (prefs().tracked ?? []).slice(-20).reverse()
}

/** 点「追踪」/ 取消：按卡片标题记一条 */
export function trackCard({ title, summary, on }) {
  const t = String(title ?? '').trim().slice(0, 80)
  if (!t) return { ok: false, error: '缺标题' }
  const p = prefs()
  const list = (p.tracked ?? []).filter((x) => x.title !== t)
  if (on) list.push({ title: t, summary: String(summary ?? '').slice(0, 300), at: Date.now() })
  p.tracked = list.slice(-50)
  writeJson(P('prefs.json'), p)
  return { ok: true, tracked: !!on, total: p.tracked.length }
}

/* --------------------------------------------------------- 页面读出 --- */

/** 页面要的「迭代建议」：还没被采用的，最新的在前 */
export function suggestions(limit = 30) {
  const arr = readJson(P('suggestions.json'), [])
  return arr
    .filter((x) => !x.applied)
    .slice(-limit)
    .reverse()
}

/** 关键词权重榜：给「调教记录」那块用 */
export function learned(limit = 20) {
  const p = prefs()
  const kws = Object.entries(p.kw)
    .filter(([, v]) => Math.abs(v) > 0.05)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, limit)
    .map(([w, v]) => ({ w, v: Number(v.toFixed(2)), dir: v > 0 ? 'up' : 'down' }))
  const cats = Object.entries(p.cat)
    .filter(([, v]) => Math.abs(v - 1) > 0.02)
    .map(([id, v]) => ({ id, v: Number(v.toFixed(2)) }))
  return { kws, cats, notes: p.notes.length }
}
