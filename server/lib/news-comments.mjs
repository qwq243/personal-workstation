/**
 * 论坛评论抓取（`#/news` 的「单事件情绪」从哪来）。
 *
 * 为什么要有它：论坛开放了评论区，所以情绪不该只看标题（「离谱！」是正向还是负向？），
 * 要看这件事**引发的讨论**。目前认三类公开不登录的评论接口：
 *  - **Hacker News**：官方 Firebase API（免费、稳定、不用登录）；
 *  - **V2EX**：官方 REST（`/api/replies/show.json?topic_id=`）；
 *  - **linux.do**：Discourse 的 `.json` 端点（`…/t/<slug>/<id>.json`）。
 *
 * 评论**不在页面请求里同步抓**（那会让看板慢几秒），而是看板请求时**顺手在后台填缓存**，
 * 这次用上一轮缓存好的；下一次打开就是新的。缓存写进 `<dataDir>/news-comments/`（只追加，
 * 按 URL 一名一文件）。本机不是 7×24 的机器 —— 这个节奏正好。
 */
import fs from 'node:fs'
import path from 'node:path'
import { dataDir, loadConfig } from '../config.mjs'
import { runHidden } from './net.mjs'

const DIR = () => {
  const p = path.join(dataDir(), 'news-comments')
  fs.mkdirSync(p, { recursive: true })
  return p
}
const F = (url) => path.join(DIR(), Buffer.from(String(url)).toString('base64url') + '.json')
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

/** 中文情感词典（跟看板同一份，这里也要用它给「评论」打分） */
const POS = /好|赞|强|牛|棒|感谢|有用|收藏|mark|学到了|顶|支持|同意|厉害|妙|稳|准|快|省|优雅|巧妙|清晰|到位|实测|真的好用/i
const NEG = /垃圾|差|烂|坑|骗|吹|水文|营销|广告|没用|废话|过时|错|离谱|反对|质疑|担忧|不满|不稳|翻车|破|废|危|难|贵|慢|卡|甩锅|离谱|官官相护/i
const EN_POS = /\b(thanks|useful|great|good|nice|love|works|working|solved|helpful|awesome|clear|best|better|impressive|agree|exactly|confirmed)\b/i
const EN_NEG = /\b(bug|broken|wrong|bad|terrible|awful|hate|useless|spam|scam|fake|misleading|overrated|regression|crashes|doesn'?t work|disagree|skeptical|doubt)\b/i

function scoreComments(list) {
  let p = 0
  let n = 0
  /** 逐条评论的倾向：卡片右栏「情绪条」要的是**评论条数**的分布（pos/neu/neg 各几条），不是词频 */
  let cp = 0
  let cz = 0
  let cn = 0
  for (const c of list) {
    const t = String(c || '')
    const a = (t.match(POS) || []).length + (t.match(EN_POS) || []).length
    const b = (t.match(NEG) || []).length + (t.match(EN_NEG) || []).length
    p += a
    n += b
    if (a > b) cp++
    else if (b > a) cn++
    else cz++
  }
  const score = p - n
  return { pos: p, neg: n, score, label: score > 0 ? 'pos' : score < 0 ? 'neg' : 'neu', n: list.length, dist: { pos: cp, neu: cz, neg: cn } }
}

/* --------------------------------------------------------- 抓取 --- */

/**
 * 这些站直连有时会被重置（V2EX 曾被坑过），所以要留一条走代理的路。
 * 代理**不写死端口**：读配置 `collector.proxy`（其次 `news.proxy`），空串 = 直连。
 * 与采集器共用同一个代理设置，因为它抓的往往是同一批站点。
 */
function proxyOf() {
  const c = loadConfig()
  return String(c.collector?.proxy || c.news?.proxy || '').trim()
}

/** 直连：Node 自带的 fetch（零依赖）；配了代理才退回 curl（Node 的 fetch 不认代理选项） */
async function fetchJson(url, { timeout = 15000 } = {}) {
  const proxy = proxyOf()
  if (!proxy) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'MessageWatcher/0.1' },
        signal: AbortSignal.timeout(timeout),
      })
      const raw = await res.text()
      let json = null
      try {
        json = JSON.parse(raw)
      } catch {
        /* 不是 JSON 就按文本给 */
      }
      return { ok: res.status >= 200 && res.status < 300, status: res.status, json, text: raw.slice(0, 300) }
    } catch (e) {
      return { ok: false, status: 0, json: null, text: String(e?.message ?? e).slice(0, 300) }
    }
  }

  // 走代理：`-w` 的输出标记不能让 runHidden 的 exec 去拆（换行会被它吃掉），
  // 交给 curl 自己用 `\n` 转义；正文与状态码用不可能在正文里出现的分隔符分开。
  const args = ['-s', '-A', 'MessageWatcher/0.1', '--max-time', String(Math.ceil(timeout / 1000)), '-w', '\\n__HTTP__%{http_code}', '-x', proxy, url]
  const r = await runHidden(`curl ${args.map((a) => (a.includes(' ') || a.includes('&') ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ')}`, { timeout: timeout + 5000 })
  const m = /__HTTP__(\d{3})/.exec(r.stdout || '')
  const code = m ? Number(m[1]) : 0
  const text = (r.stdout || '').replace(/\n__HTTP__\d{3}[\s\S]*$/, '')
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 不是 JSON 就按文本给 */
  }
  return { ok: code >= 200 && code < 300, status: code, json, text: text.slice(0, 300) }
}

/** HN：RSS 里存的是文章 URL，评论在 HN 的「讨论页」—— algolia 搜索按 URL 找回 story 的 objectID */
async function hnStoryId(url) {
  const r = await fetchJson(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(url)}&restrictSearchableAttributes=url`)
  const hit = (r.json?.hits ?? []).find((h) => h.url === url || String(h.url || '').replace(/\/$/, '') === String(url).replace(/\/$/, ''))
  return hit?.objectID ?? null
}

async function fetchHn(storyId) {
  const r = await fetchJson(`https://hn.algolia.com/api/v1/items/${storyId}`)
  const out = []
  const walk = (node) => {
    if (!node || out.length >= 12) return
    const t = String(node.text ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    if (t) out.push(t.slice(0, 300))
    for (const c of node.children ?? []) walk(c)
  }
  for (const c of r.json?.children ?? []) walk(c)
  return out
}

/** V2EX：/api/replies/show.json?topic_id= */
async function fetchV2ex(topicId) {
  const r = await fetchJson(`https://www.v2ex.com/api/replies/show.json?topic_id=${topicId}`)
  const arr = Array.isArray(r.json) ? r.json : []
  return arr.slice(0, 12).map((x) => String(x?.content ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean)
}

/** linux.do（Discourse）：/t/topic/<id>.json 的 post_stream.posts */
async function fetchLinuxDo(topicId) {
  const r = await fetchJson(`https://linux.do/t/topic/${topicId}.json`)
  const posts = r.json?.post_stream?.posts ?? []
  // posts[0] 是正文，从第 2 条开始才是评论
  return posts.slice(1, 13).map((x) => String(x?.cooked ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean)
}

/** 按源把「这条的评论区前 N 条」抓回来；抓不到/不支持的源返回空 */
async function fetchCommentsFor(it) {
  const url = String(it.url || '')
  const sid = it.sourceId
  try {
    if (sid === 'hn') {
      const storyId = await hnStoryId(url)
      return storyId ? await fetchHn(storyId) : []
    }
    if (sid === 'v2ex') {
      const m = /t\/(\d+)/.exec(url)
      return m ? await fetchV2ex(m[1]) : []
    }
    if (sid === 'linuxdo-top' || sid === 'linuxdo-news') {
      const m = /\/t\/topic\/(\d+)/.exec(url) || /\/t\/[^/]+\/(\d+)/.exec(url)
      return m ? await fetchLinuxDo(m[1]) : []
    }
  } catch {
    /* 抓不到就当没有，别把整批弄死 */
  }
  return []
}

/* --------------------------------------------------------- 缓存 --- */

/** 已经抓过的（按 URL）：{comments, sentiment, at} */
export function get(url) {
  return readJson(F(url), null)
}

let busy = new Set()

/**
 * 顺手填缓存：看板拿到一批条目时调它，**不 await**（慢活在后台跑）。
 * 只抓「论坛源 + 还没有缓存」的；一次最多 6 条，别把自己当爬虫。
 */
export function prime(items) {
  for (const it of items ?? []) {
    const url = String(it.url || '')
    if (!url || !['hn', 'v2ex', 'linuxdo-top', 'linuxdo-news'].includes(it.sourceId)) continue
    if (get(url) || busy.has(url)) continue
    busy.add(url)
    ;(async () => {
      const comments = await fetchCommentsFor(it)
      if (comments.length) {
        writeJson(F(url), { at: Date.now(), url, title: it.title, comments, sentiment: scoreComments(comments) })
      }
      busy.delete(url)
      if (busy.size > 6) return // 这轮够了，下一轮看板再补
    })().catch(() => busy.delete(url))
    if (busy.size >= 6) break
  }
}

/** 情绪：优先用评论的，没有就返回 null（页面退回词典判定） */
export function sentimentFor(it) {
  const c = get(it.url)
  return c?.sentiment ?? null
}
