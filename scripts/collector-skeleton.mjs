#!/usr/bin/env node
/**
 * 最小示例采集器 —— 让「资讯」页（`#/news`）在 5 分钟内点亮。
 *
 *   node scripts/collector-skeleton.mjs <产物目录>
 *   node scripts/collector-skeleton.mjs <产物目录> my-sources.json
 *
 * 它抓一个 JSON 源清单里的 **RSS / Atom**（默认用两个公开源），把最新条目写成
 * `docs/news-contract.md` 契约里的产物：
 *   <dir>/out/latest.json    最新一批（页面读它）
 *   <dir>/out/<时间>.md      这一批的 markdown（「更早的批次」读它）
 *   <dir>/sources.json       源清单（页面「后台」按它列每源档位）
 *   <dir>/state.json         每源上次抓取时间与见过的 URL（用它算「新」）
 *   <dir>/watch.json         关注主题（这里留空，自己按需加）
 *
 * 零依赖：只用 node 内置的 `fetch` 与 `fs` —— 采集器是**独立进程**，
 * 跑在哪台机器、用什么语言都行，只要产出上面这几个文件。这是给你抄的骨架，不是产品：
 *  - **不带任何需要登录 / 需要浏览器的源**（凭据与浏览器自动化是各人自己的事）；
 *  - 需要代理、需要模型写「简报」的地方都留了口子（见文件末尾注释）。
 *
 * 用法就两步：跑它 → 把打印出来的目录填进工作站「设置 → 采集器目录」（配置项 `collector.dir`）。
 */
import fs from 'node:fs'
import path from 'node:path'

/* ------------------------------------------------------------ 参数 --- */

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const dirArg = args[0]
if (!dirArg) {
  console.error('用法：node scripts/collector-skeleton.mjs <产物目录> [源清单.json]')
  console.error(`例：node scripts/collector-skeleton.mjs ./collector-out`)
  process.exit(2)
}
const DIR = path.resolve(dirArg)
const LIST_ARG = args[1] ? path.resolve(args[1]) : ''

const TIMEOUT_MS = 20_000
/** 每源最多留几条进产物（页面是给人看的，几百条只会把重要的淹掉） */
const DEFAULT_LIMIT = 15

/**
 * 内置的两个公开源（都只要一个 GET，不用登录、不用 key）。
 * 想换/想加：抄一份 `sources.json` 出来改（见下面读清单那一段）。
 */
const DEFAULT_SOURCES = [
  { id: 'hn', name: 'Hacker News', type: 'rss', url: 'https://news.ycombinator.com/rss', everyMinutes: 30, cat: 'tech' },
  { id: 'sspai', name: '少数派', type: 'rss', url: 'https://sspai.com/feed', everyMinutes: 60, cat: 'tech' },
]

/* ------------------------------------------------------------ 小工具 --- */

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
/** 原子写：边车可能正在读这些文件，别让它读到半个 */
const writeJson = (file, obj) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

/** 本地时间 `YYYY-MM-DD-HHMM`（批次 md 的文件名格式，边车按它排批次 —— 别用 UTC） */
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

/** RSS/Atom 里的文本：去 CDATA、去标签、解几个常见实体、收空白 */
function clean(s) {
  let t = String(s ?? '')
  t = t.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  t = t.replace(/<[^>]*>/g, ' ')
  t = t
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
  return t.replace(/\s+/g, ' ').trim()
}

/** 取某个标签的第一段内容（RSS 与 Atom 的写法都很规整，正则够用） */
const tag = (xml, name) => {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml)
  return m ? m[1] : ''
}
/** Atom 的 link 是自闭合带属性的：取 rel="alternate"（没有就取第一个） */
function atomLink(xml) {
  const all = [...xml.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0])
  const pick = all.find((t) => /rel=["']alternate["']/i.test(t)) ?? all[0] ?? ''
  return /href=["']([^"']+)["']/i.exec(pick)?.[1] ?? ''
}

/**
 * 把 RSS 2.0 / Atom 解成统一条目。
 * **不引 XML 库**：这些源的结构二十年没变，正则足够，而且这个脚本要能被人一眼看完。
 */
function parseFeed(xml) {
  const isAtom = /<entry[\s>]/i.test(xml)
  const blocks = isAtom
    ? [...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)].map((m) => m[0])
    : [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map((m) => m[0])
  const out = []
  for (const b of blocks) {
    const title = clean(tag(b, 'title'))
    const url = isAtom ? clean(atomLink(b)) : clean(tag(b, 'link'))
    const desc = clean(tag(b, isAtom ? 'summary' : 'description'))
    const dateRaw = clean(tag(b, isAtom ? 'updated' : 'pubDate')) || clean(tag(b, 'published'))
    const ts = dateRaw ? Date.parse(dateRaw) : NaN
    if (!title || !url) continue
    out.push({
      title,
      url,
      desc: desc.slice(0, 200),
      // 日期给 ISO：边车的时效闸门（> 21 天不进主流程）靠它
      date: Number.isFinite(ts) ? new Date(ts).toISOString() : '',
    })
  }
  return out
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'collector-skeleton/0.1 (+https://github.com/)' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.text()
}

/* -------------------------------------------------------------- 跑 --- */

/** 源清单：给了文件就用文件（并抄一份进产物目录，页面的「后台」读的是那一份） */
function loadSources() {
  if (!LIST_ARG) return DEFAULT_SOURCES
  const list = readJson(LIST_ARG, null)
  if (!Array.isArray(list) || !list.length) {
    console.error(`读不了源清单：${LIST_ARG}（应当是一个 JSON 数组，字段见 docs/news-contract.md §4）`)
    process.exit(2)
  }
  if (path.dirname(LIST_ARG) !== DIR) writeJson(path.join(DIR, 'sources.json'), list)
  return list
}

async function main() {
  const sources = loadSources()
  fs.mkdirSync(path.join(DIR, 'out'), { recursive: true })

  const state = readJson(path.join(DIR, 'state.json'), {}) || {}
  const watch = readJson(path.join(DIR, 'watch.json'), null)
  if (!watch) writeJson(path.join(DIR, 'watch.json'), { topics: [] })

  const results = []
  for (const s of sources) {
    if (s.disabled) continue
    const prev = new Set(state[s.id]?.seen ?? [])
    let items = []
    let status = 'ok'
    let error = ''
    try {
      if (s.type && s.type !== 'rss') throw new Error(`示例采集器只认 type="rss"（这个源写的是 ${s.type}）`)
      items = parseFeed(await fetchText(s.url))
      // 标题排除（页面上「以后别给我 XX」那条反馈落地的就是这个字段）
      if (s.titleExclude) {
        let re = null
        try {
          re = new RegExp(s.titleExclude, 'i')
        } catch {
          re = null
        }
        if (re) items = items.filter((it) => !re.test(it.title))
      }
    } catch (e) {
      status = 'error'
      error = String(e?.message ?? e).slice(0, 160)
    }
    const limit = Number(s.limit) || DEFAULT_LIMIT
    const fresh = items.filter((it) => !prev.has(it.url)).slice(0, limit)
    const head = items.slice(0, limit)
    results.push({
      source: s,
      status,
      error,
      count: items.length,
      fresh,
      head,
      // 见过的 URL 只增不减：留最近 500 条，够判断「新」又不至于把 state.json 养肥
      seen: [...new Set([...items.map((i) => i.url), ...prev])].slice(0, 500),
    })
    const note = status === 'ok' ? `${items.length} 条（新 ${fresh.length}）` : `失败：${error}`
    console.log(`  ${String(s.id).padEnd(12)} ${note}`)
  }

  const at = Date.now()
  const totalNew = results.reduce((n, r) => n + r.fresh.length, 0)

  /* ① out/latest.json —— 页面读的就是它 */
  const latest = {
    generatedAt: at,
    brief: {
      text:
        totalNew > 0
          ? `本批新增 ${totalNew} 条：${results.filter((r) => r.fresh.length).map((r) => `${r.source.name} ${r.fresh.length} 条`).join('、')}。`
          : '本批没有新条目，下面显示各源最近抓到的几条。',
    },
    sources: results.map((r) => ({
      id: r.source.id,
      name: r.source.name,
      type: r.source.type || 'rss',
      status: r.status,
      error: r.error || undefined,
      count: r.count,
      newCount: r.fresh.length,
      // 有新的就给新的，没有就给这一源最近的几条 —— 页面不会是空的
      new: r.fresh.length ? r.fresh.map((it) => ({ ...it, cat: r.source.cat || '' })) : [],
      head: r.head.map((it) => ({ ...it, cat: r.source.cat || '' })),
    })),
  }
  writeJson(path.join(DIR, 'out', 'latest.json'), latest)

  /* ② out/<时间>.md —— 「更早的批次」与「关注命中」从这里读（标题层级是契约的一部分） */
  const lines = [`# 资讯批次 ${stamp(new Date(at))}`, ``, `本批新增 ${totalNew} 条 · 关注命中 0 次`, ``]
  if (latest.brief.text) lines.push('## 简报', '', latest.brief.text, '')
  lines.push('---', '')
  for (const r of results) {
    const pool = r.fresh.length ? r.fresh : r.head
    lines.push(`## ${r.source.name}（共 ${r.count} 条，新 ${r.fresh.length} 条）`, '')
    if (r.status !== 'ok') lines.push(`失败：${r.error}`, '')
    for (const it of pool) {
      lines.push(`- [${r.source.name}] ${it.title}`, `  ${it.url}`)
    }
    lines.push('')
  }
  fs.writeFileSync(path.join(DIR, 'out', `${stamp(new Date(at))}.md`), lines.join('\n'), 'utf8')

  /* ③ state.json —— 每源上次跑的时间 + 见过的 URL（下次靠它算「新」） */
  for (const r of results) {
    state[r.source.id] = { lastRunAt: new Date(at).toISOString(), seen: r.seen, status: r.status }
  }
  writeJson(path.join(DIR, 'state.json'), state)

  /* ④ sources.json —— 内置源时写一份给页面「后台」用 */
  if (!LIST_ARG) writeJson(path.join(DIR, 'sources.json'), sources)

  console.log(`\n[collector-skeleton] 已写入 ${DIR}`)
  console.log(`  把这一行填进工作站「设置 → 采集器目录」：${DIR}`)
  console.log(`  然后打开 #/news（没填之前这个功能不出现在侧边栏）`)
}

main().catch((e) => {
  console.error('[collector-skeleton] 失败：', e?.message ?? e)
  process.exit(1)
})

/**
 * 想再往前走一步的话（都不在这个示例里，各人按需加）：
 *  - **代理**：Node 的 `fetch` 不认代理选项，要么起一个本机代理端口再用 curl，
 *    要么换成 `undici` 的 ProxyAgent；边车侧的评论抓取读的就是 `collector.proxy`。
 *  - **简报**：`latest.brief.text` 现在是一句机械统计。想让模型写「这一段发生了什么」，
 *    在自己的采集器里调任意 OpenAI 兼容端点即可（产物格式不变）。
 *  - **关注命中 / 时间线**：在 `watch.json` 里加 `{id, name, match(正则)}`，
 *    命中的条目你自己写进 `timeline/<id>.md`（格式见契约 §5），页面的「关注主题」就会亮。
 *  - **更多源**：`sources.json` 里加一条就行（RSS/Atom）。要抓 HTML 或 JSON 接口，
 *    在那个文件里加自己的 type，并在自己的采集器里实现它。
 */
