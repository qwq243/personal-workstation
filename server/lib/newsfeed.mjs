/**
 * 资讯采集读入口 —— 给「资讯」页（`#/news`）用。
 *
 * 读的全是**采集器的产物**，本模块**只读**，不负责抓取；采集器是独立进程
 * （本机计划任务 / 定时器 / 你自己手动跑都行），产物目录由配置 `collector.dir` 指定，
 * 文件契约见 `docs/news-contract.md`：
 *   - `out/latest.json`  最新一批（结构化：每源 count/newCount/items + 模型简报）
 *   - `out/*.md`         历史批次（给「批次概要」用，从文件名取时间）
 *   - `timeline/*.md`    关注主题的时间线
 *   - `cases/*.md`       案卷（`--trace` 那类溯源记录）
 *   - `reports/`         深度报告（可选，`index.json` + 若干 md）
 *   - `sources.json` / `state.json` / `watch.json`  源清单、档位与上次抓取时间
 *
 * 目录没配就是空态：页面显示「还没配采集器目录」，模块自己也从侧边栏隐藏
 * （「没配 = 不显示」，见 `src/core/appconfig.ts`）。
 *
 * 页面上的规矩：**除了官方来源，其他来源不分开成块，只打来源标签**。
 * 所以这里给每条加了 `official` 标记，前端据此高亮置顶，其余合并成一条流。
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../config.mjs'

/** 采集器产物目录；留空 = 没配（所有读函数都返回空态，不抛） */
const dir = () => String(loadConfig().collector?.dir || '').trim()

const p = (...a) => path.join(dir(), ...a)
const readJson = (file, d = null) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return d
  }
}
const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 「官方来源」的判据：名字里带这些词的算官方（页面上单独高亮、排序靠前）。
 * 它是**启发式**，认不出就让采集器在 `sources.json` 里把源名写清楚 —— 别在这里堆特例。
 */
const OFFICIAL_RE = /官方|官网|公告|研究生院|教务处|研招网/

const isOfficial = (name) => OFFICIAL_RE.test(String(name || ''))

/**
 * 给页面看的标题要干净：解 HTML 实体 + 收空白。
 * 为什么在这里再解一遍：采集器**沿用上一批**时（比如那个源这轮没跑成），
 * 拿过来的是历史数据 —— 采集器后来修了实体解码也管不到旧记录，
 * 直接展示就会在页面上看到 `Don&#x27;t`（2026-09-28 就是这么冒出来的）。
 */
function cleanTitle(s) {
  let t = String(s || '').replace(/<[^>]*>/g, '')
  const once = (x) =>
    x
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
  for (let i = 0; i < 3 && /&[#a-z]/i.test(t); i++) t = once(t)
  return t.replace(/\s+/g, ' ').trim()
}

/** 去重键：同一条新闻可能被多个源抓到 */
const keyOf = (it) => String(it.url || it.title || '')

/**
 * 摘要行（喂给面板的「一句话」，不是原文）。
 * 采集器抓 RSS/JSON 时存了 `desc`（≤200 字），但一半是噪音：
 * HN 的 `Article URL:` / `Comments`、Reddit 的 `submitted by`、GitHub 的 `Contribute to …`；
 * 少数派这类还给**正文开头**（带「编注：」「Matrix首页推荐」「…查看全文」这类版式前缀）。
 * 面板要的是摘要，所以挡掉机械行与版式前缀；挡不掉就整行不显示（宁缺勿噪）。
 */
const DESC_JUNK = /^(comments?|article url|points?:|submitted by|\[link\]|\[comments\]|contribute to|shared by|via )/i
const DESC_BOILER = /^(编注：|往期文章|Matrix首页推荐|本周新预告|📅)/
function cleanDesc(s, title) {
  let t = cleanTitle(s).replace(/查看全文$/, '').replace(/\s*[·・|]\s*$/, '').trim()
  if (!t || t.length < 20) return ''
  if (DESC_JUNK.test(t) || DESC_BOILER.test(t)) return ''
  if (t === title) return ''
  // 标题本身已经很长时，摘要就不再重复一遍
  if (title && t.slice(0, 40) === title.slice(0, 40)) return ''
  return t.slice(0, 120)
}

export function feed() {
  if (!dir()) return { ok: false, error: '还没配采集器目录（配置项 collector.dir）—— 见 docs/news-contract.md' }
  const latest = readJson(p('out', 'latest.json'))
  if (!latest) {
    return { ok: false, error: `读不到采集结果（${p('out', 'latest.json')}）—— 先按 docs/news-contract.md 跑一次采集器（仓库自带 scripts/collector-skeleton.mjs 示例）` }
  }
  const sources = readJson(p('sources.json'), []) || []
  const state = readJson(p('state.json'), {}) || {}
  const watch = readJson(p('watch.json'), { topics: [] }) || { topics: [] }

  // 合并成一条流：本批有新的就显示新的，没有就显示该源抓到的前几条（让页面不会是空的）
  const raw = []
  for (const s of latest.sources ?? []) {
    const pool = (s.new?.length ? s.new : s.head) ?? []
    for (const it of pool) {
      raw.push({
        title: cleanTitle(it.title),
        desc: cleanDesc(it.desc, cleanTitle(it.title)),
        url: it.url,
        date: it.date || '',
        sourceId: s.id,
        source: s.name,
        via: s.via || 'direct',
        official: isOfficial(s.name),
        /**
         * 采集器自己标的分类（条目级优先于源级）—— 这是**最权威**的一手信息：
         * 采集器的源清单是人工挑的，比关键词猜得准。分类规则见 `news-board.mjs`。
         */
        cat: it.cat || s.cat || '',
        watch: it.watch || [],
        isNew: !!(s.new?.length),
      })
    }
  }
  const seen = new Set()
  const items = raw.filter((x) => {
    const k = keyOf(x)
    if (!k || seen.has(k)) return false
    seen.add(k)
    // 官方来源优先展示：同一条既被官方源抓到又被论坛抓到，保留官方那条
    return true
  })

  const topics = (watch.topics ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    note: t.note || '',
    match: t.match || '',
    count: 0,
  }))

  // 关注命中在**这里重算**，不依赖采集器存下来的 watch —— 会话里带过来的条目（没跑到的源沿用上一批）
  // 本身没有 watch 字段，只看存量会把命中数算成 0（2026-09-28 踩过）。
  const rules = topics.map((t) => {
    let re = null
    try {
      re = new RegExp(t.match, 'i')
    } catch {
      re = null
    }
    return { id: t.id, re }
  })
  for (const it of items) {
    const hit = rules.filter((r) => r.re && r.re.test(`${it.title} ${it.desc || ''}`)).map((r) => r.id)
    it.watch = [...new Set([...(it.watch || []), ...hit])]
  }
  for (const t of topics) t.count = items.filter((x) => x.watch.includes(t.id)).length

  return {
    ok: true,
    generatedAt: latest.generatedAt ?? 0,
    dir: dir(),
    brief: latest.brief ?? null,
    items,
    topics,
    stats: {
      shown: items.length,
      official: items.filter((x) => x.official).length,
      watchHits: items.filter((x) => x.watch.length).length,
      newItems: items.filter((x) => x.isNew).length,
      activeSources: sources.filter((s) => !s.disabled).length,
      officialSources: sources.filter((s) => !s.disabled && isOfficial(s.name)).length,
    },
    sources: sources.map((s) => ({
      id: s.id,
      name: s.name,
      everyMinutes: s.everyMinutes ?? null,
      disabled: !!s.disabled,
      official: isOfficial(s.name),
      /** 采集器标的分类（源级默认值）；条目级还能覆盖它 */
      cat: s.cat || '',
      lastRunAt: state[s.id]?.lastRunAt ?? null,
      seenCount: (state[s.id]?.seen ?? []).length,
      status: s.disabled ? 'disabled' : (latest.sources ?? []).find((x) => x.id === s.id)?.status ?? 'idle',
      count: (latest.sources ?? []).find((x) => x.id === s.id)?.count ?? 0,
      newCount: (latest.sources ?? []).find((x) => x.id === s.id)?.newCount ?? 0,
      note: s.note || '',
    })),
  }
}

/**
 * 批次里的「依据来源」：简报是总结，但总结要能回指到网址（「多总结而非原文，返回对应的网址信息源即可」）。
 * 取法：优先「关注命中」段（简报讲的就是这些），不够再补「有新条目的源」段；
 * 每行格式是 `- [主题] [来源] 标题` + 缩进一行的 url（采集器自己写的，格式固定）。
 */
function parseBatchRefs(text, limit = 6) {
  const blocks = []
  const hit = text.match(/## 关注命中（\d+ 条）\n+([\s\S]*?)(?=\n## |\n---)/)
  if (hit) blocks.push(hit[1])
  for (const m of text.matchAll(/## (.+?)（共 \d+ 条，新 (\d+) 条）\n+([\s\S]*?)(?=\n## |\n---)/g)) {
    if (Number(m[2]) > 0) blocks.push(m[3])
  }
  const out = []
  const seen = new Set()
  for (const b of blocks) {
    for (const m of b.matchAll(/^- (.*?)\s*\n\s+(https?:\S+)$/gm)) {
      const label = m[1]
      const url = m[2]
      if (seen.has(url) || url.includes('/#')) continue
      seen.add(url)
      const tags = [...label.matchAll(/\[([^\]]+)\]/g)].map((x) => x[1])
      const title = label.replace(/^(\[[^\]]+\]\s*)+/, '').trim()
      if (!title) continue
      out.push({
        title: cleanTitle(title).slice(0, 80),
        url,
        // 最后一个方括号是来源名（`[主题] [来源] 标题`）；只有一个括号时就当来源
        source: cleanTitle(tags.length ? tags[tags.length - 1] : ''),
      })
      if (out.length >= limit) return out
    }
  }
  return out
}

/** 从批次 md 里抠出简报与条目数（md 是采集器生成的，格式固定，正则够用） */
function parseBatch(file, name) {
  const text = readText(file)
  const briefMatch = text.match(/## 简报\n+([\s\S]*?)(?=\n## |\n---)/)
  const brief = briefMatch ? briefMatch[1].trim() : ''
  const sections = [...text.matchAll(/^## (.+?)（(.+?)）$/gm)].map((m) => ({
    name: m[1],
    meta: m[2],
  }))
  const totalMatch = text.match(/新增合计 (\d+) 条/)
  const hitMatch = text.match(/关注命中 (\d+) 次/)
  // 新格式（2026-09-28 起）在 md 顶部有一行汇总；老批次没有就退回「逐源的新 M 条」求和
  const sumMatch = text.match(/本批新增 (\d+) 条 · 关注命中 (\d+) 次/)
  const fallbackNew = sections.reduce((n, s) => {
    const m = /新 (\d+) 条/.exec(s.meta || '')
    return n + (m ? Number(m[1]) : 0)
  }, 0)
  const failed = text.match(/^失败：(.+)$/m)
  const st = fs.statSync(file)
  return {
    name,
    at: name.replace('.md', ''),
    mtime: st.mtimeMs,
    brief,
    refs: parseBatchRefs(text),
    failed: failed ? failed[1].trim().slice(0, 200) : '',
    sections: sections.filter((s) => !s.name.includes('简报') && !s.name.includes('关注命中')),
    newTotal: sumMatch ? Number(sumMatch[1]) : (totalMatch ? Number(totalMatch[1]) : fallbackNew),
    watchHits: sumMatch ? Number(sumMatch[2]) : (hitMatch ? Number(hitMatch[1]) : 0),
  }
}

/** 最近几批（给「批次概要」用；文件名固定 `YYYY-MM-DD-HHMM.md`） */
export function batches(limit = 8) {
  if (!dir()) return { ok: true, list: [] }
  const outDir = p('out')
  let files = []
  try {
    files = fs.readdirSync(outDir).filter((f) => /^\d{4}-\d{2}-\d{2}-\d{4}\.md$/.test(f))
  } catch {
    return { ok: false, error: `读不到批次目录 ${outDir}` }
  }
  files.sort().reverse()
  const list = files.slice(0, Math.max(1, Math.min(30, limit))).map((f) => parseBatch(path.join(outDir, f), f))
  return { ok: true, list }
}

/** 时间线：不传 id 就返回索引（含每主题条数与最近几条） */
export function timeline(id = '') {
  if (!dir()) return { ok: true, list: [] }
  const tDir = p('timeline')
  const watch = readJson(p('watch.json'), { topics: [] }) || { topics: [] }
  const meta = new Map((watch.topics ?? []).map((t) => [t.id, t]))

  if (!id) {
    let files = []
    try {
      files = fs.readdirSync(tDir).filter((f) => f.endsWith('.md'))
    } catch {
      return { ok: true, list: [] }
    }
    const list = files.map((f) => {
      const key = f.replace('.md', '')
      const entries = parseTimeline(readText(path.join(tDir, f)))
      return {
        id: key,
        name: meta.get(key)?.name || key,
        note: meta.get(key)?.note || '',
        count: entries.length,
        recent: entries.slice(-4).reverse(),
      }
    })
    return { ok: true, list }
  }

  const entries = parseTimeline(readText(path.join(tDir, `${id}.md`)))
  return { ok: true, id, name: meta.get(id)?.name || id, note: meta.get(id)?.note || '', entries }
}

/** 时间线一行的固定格式：`- **2026-09-28 09:05** [来源] 标题\n  url` */
function parseTimeline(text) {
  const out = []
  const re = /- \*\*(.+?)\*\* \[(.+?)\] (.+)\n\s+(\S+)/g
  for (const m of text.matchAll(re)) {
    out.push({ at: m[1], source: m[2], title: m[3].trim(), url: m[4].trim() })
  }
  return out
}

/** 深度报告（可选）：采集器产出的 `reports/index.json` */
export function reports(limit = 20) {
  const idx = readJson(p('reports', 'index.json'), { list: [] }) || { list: [] }
  return { ok: true, list: (idx.list ?? []).slice(0, Math.max(1, Math.min(50, limit))) }
}

/** 一份报告的 markdown 原文 */
export function report(file = '') {
  if (!file) return { ok: false, error: '缺 file' }
  // 只允许 reports/ 下的文件名，挡掉路径穿越
  const name = path.basename(String(file))
  const text = readText(p('reports', name))
  if (!text) return { ok: false, error: `没有这份报告：${name}` }
  return { ok: true, file: name, text }
}

/** 案卷（溯源记录）：原文返回，前端按 md 段落渲染 */
export function caseFile(id = '') {
  if (!dir()) return id ? { ok: false, error: `没有案卷 ${id}` } : { ok: true, list: [] }
  if (!id) {
    let files = []
    try {
      files = fs.readdirSync(p('cases')).filter((f) => f.endsWith('.md'))
    } catch {
      return { ok: true, list: [] }
    }
    return { ok: true, list: files.map((f) => ({ id: f.replace('.md', ''), mtime: fs.statSync(p('cases', f)).mtimeMs })) }
  }
  const text = readText(p('cases', `${id}.md`))
  if (!text) return { ok: false, error: `没有案卷 ${id}` }
  return { ok: true, id, text }
}
