/**
 * 外部资料抓取：把一个**公开可读**的链接抓成 markdown，落到知识库的 raw/sources/。
 *
 * 支持两类来源：
 *   1. **RSS / Atom feed** —— 抓成「一页按时间倒序的条目清单」（标题 + 链接 + 摘要），
 *      存成一个源文件；每次重抓覆盖同一份（feed 本来就是滚动的）。
 *   2. **普通网页** —— 抓 HTML，剥掉脚本/样式/导航，把正文转成 markdown。
 *
 * 三条边界，写清楚免得被当成 bug：
 *   1. **只支持公开可读的页面**。要登录的、要 JS 渲染出正文的（SPA、需 cookie 的站点）
 *      一律拿不到 —— 这不是「没做完」，是刻意不做：那类抓取要带个人凭据、
 *      并绕过站点的访问控制，不该由一份能开源的工具替使用者决定。
 *      正文抽取是**启发式**的（按块密度挑主内容），不是浏览器级渲染，复杂版式会漏。
 *   2. **不下载图片**：正文里遇到 <img> 只保留原始链接，不假装下载成功。
 *   3. 抓回来的文件只是「料」，不是「知识」：写进 raw/sources/ 之后由 wiki.ingest()
 *      编译成 wiki/ 页面。这一步不改 raw/ 里任何既有文件（同名要 overwrite 才覆盖）。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/** 抓取用的 UA：有些站点会因为「不认识」直接 403，署个名比默认的 node 好一些 */
const UA = 'workstation-wiki/0.1 (+local knowledge base importer)'

/** feed 的识别：先看 Content-Type，再看正文开头 */
const FEED_MIME = /(application\/(rss|atom)\+xml|application\/xml|text\/xml)/i

async function fetchText(url, { timeout = 30000, maxBytes = 8 * 1024 * 1024 } = {}) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'User-Agent': UA },
    })
    const ctype = String(res.headers.get('content-type') ?? '')
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}${res.status === 403 || res.status === 401 ? '（这个页面大概需要登录，本工具只抓公开页面）' : ''}` }
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > maxBytes) {
      return { ok: false, error: `页面太大（${Math.round(buf.length / 1024 / 1024)}MB > ${Math.round(maxBytes / 1024 / 1024)}MB），先下载到本地再作为文件导入` }
    }
    return { ok: true, text: buf.toString('utf8'), contentType: ctype, finalUrl: res.url || url, bytes: buf.length }
  } catch (err) {
    const msg = err?.name === 'AbortError' ? `请求超时（${timeout}ms）` : err?.message ?? String(err)
    return { ok: false, error: msg }
  } finally {
    clearTimeout(t)
  }
}

/* --------------------------------------------------------------- 解析 --- */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ldquo: '“', rdquo: '”', hellip: '…', mdash: '—', ndash: '–',
}

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
}

function stripTags(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 极简 XML 取字段（feed 这种结构规整的用不着完整 XML 解析器） */
function tag(block, name) {
  const m = String(block).match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'))
  return m ? m[1] : ''
}

function attr(block, name, attrName) {
  const m = String(block).match(new RegExp(`<${name}[^>]*\\b${attrName}=["']([^"']+)["'][^>]*>`, 'i'))
  return m ? m[1] : ''
}

function parseFeed(xml, baseUrl) {
  const blocks = String(xml).match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? []
  const items = blocks.map((b) => {
    const link =
      decodeEntities(attr(b, 'link', 'href')) ||
      decodeEntities(tag(b, 'link')) ||
      decodeEntities(tag(b, 'guid'))
    let abs = link
    try {
      abs = new URL(link, baseUrl).href
    } catch {
      /* 相对链接解析不了就原样留着 */
    }
    const summaryHtml = tag(b, 'description') || tag(b, 'summary') || tag(b, 'content')
    return {
      title: stripTags(tag(b, 'title')).slice(0, 200) || '(无标题)',
      url: abs,
      date: stripTags(tag(b, 'pubDate') || tag(b, 'updated') || tag(b, 'published')).slice(0, 40),
      summary: stripTags(summaryHtml).replace(/\n+/g, ' ').slice(0, 400),
    }
  })
  const feedTitle =
    stripTags(tag(xml.match(/<channel[\s>][\s\S]*?<\/channel>/i)?.[0] ?? xml, 'title')) ||
    stripTags(tag(xml, 'title')) ||
    ''
  return { title: feedTitle.slice(0, 120), items }
}

/**
 * 正文抽取（启发式）：把 <body> 切成块，按「文字密度」挑主内容。
 *
 * 不是浏览器级渲染，也不追求 100% 准确 —— 目标是「公开博客/文档站的文章页面」，
 * 对这些站点足够用；失败时会退回整页文本，并如实标注 `via: 'page(整页)'`。
 */
function extractArticle(html) {
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) ?? [])[1] ?? '').trim()
  const h1 = stripTags((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) ?? [])[1] ?? '').trim()
  const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)
  const description = decodeEntities(descMatch?.[1] ?? '').trim()

  // 候选容器：article / main / 常见的正文 class 名；都没有就整页
  const candidates = []
  for (const re of [/<article[\s>][\s\S]*?<\/article>/gi, /<main[\s>][\s\S]*?<\/main>/gi]) {
    const found = html.match(re)
    if (found) candidates.push(...found)
  }
  const body = html.match(/<body[\s>][\s\S]*?<\/body>/i)?.[0] ?? html
  if (!candidates.length) candidates.push(body)

  const best = candidates
    .map((c) => stripTags(c))
    .sort((a, b) => b.length - a.length)[0] ?? ''

  const text = best.length > 400 ? best : stripTags(body)
  return { title: h1 || title, description, text, via: best.length > 400 ? 'page(主内容)' : 'page(整页)' }
}

/** 链接是不是 feed（后缀或内容特征） */
export function looksLikeFeed(url, contentType = '') {
  if (FEED_MIME.test(contentType)) return true
  try {
    const p = new URL(url).pathname.toLowerCase()
    if (/\.(rss|atom|xml)$/.test(p)) return true
    if (/\/(feed|rss|atom)\/?$/.test(p)) return true
  } catch {
    /* URL 解析不了就靠内容判断 */
  }
  return false
}

/* --------------------------------------------------------------- 落盘 --- */

/** 文件名 slug：保留中文可读，压掉标点与空格 */
export function slugify(title, fallback = 'article') {
  const s = String(title ?? '')
    .trim()
    .toLowerCase()
    .replace(/[（(]\s*(上|中|下)\s*[)）]/g, ' $1')
    .replace(/[·:：,，。!！?？"'“”‘’、/\\|<>*]+/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return s || fallback
}

function isoDay(v) {
  if (!v) return ''
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v).slice(0, 10)
  return d.toISOString().slice(0, 10)
}

function hostOf(url) {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/**
 * 抓一个链接并写成 raw/sources/<slug>.md。
 *
 * opts.dir —— 知识库根目录；opts.slug —— 指定文件名（不给就用标题推导）；
 * opts.overwrite —— 同名时是否覆盖（raw/ 是原始资料，**默认不覆盖**，宁可报错也不默默改）。
 */
export async function fetchToSource(url, { dir, slug, overwrite = false } = {}) {
  let u
  try {
    u = new URL(String(url).trim())
  } catch {
    return { ok: false, error: `这不是一个完整的网址：${url}` }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: `只支持 http/https，收到的是 ${u.protocol}` }
  }

  const got = await fetchText(u.href)
  if (!got.ok) return { ok: false, error: got.error, status: got.status }

  const isFeed = looksLikeFeed(got.finalUrl, got.contentType) || /^\s*<\?xml|<rss|<feed/i.test(got.text.slice(0, 300))
  let title = ''
  let body = ''
  let via = ''
  let kind = ''

  if (isFeed) {
    const feed = parseFeed(got.text, got.finalUrl)
    kind = 'feed'
    via = 'feed'
    title = feed.title || hostOf(got.finalUrl) || '订阅源'
    if (!feed.items.length) {
      return { ok: false, error: '这是一个 feed，但里面没解析出条目（可能不是标准 RSS/Atom）' }
    }
    const lines = ['按发布时间倒序（抓取当时）：', '']
    for (const it of feed.items) {
      lines.push(`## ${it.title}`)
      if (it.date) lines.push(`- 时间：${it.date}`)
      if (it.url) lines.push(`- 链接：${it.url}`)
      if (it.summary) lines.push('', it.summary)
      lines.push('')
    }
    body = lines.join('\n').trim()
  } else {
    const art = extractArticle(got.text)
    kind = 'page'
    via = art.via
    title = art.title || hostOf(got.finalUrl) || '网页'
    body = [art.description ? `> ${art.description}` : '', art.text].filter(Boolean).join('\n\n').trim()
  }

  if (!body) return { ok: false, error: '抓到了页面，但正文是空的（多半要靠 JS 渲染，本工具只做静态抽取）' }

  // feed 是滚动的：同一份源文件反复更新是正常的，所以 slug 固定用主机名 + feed
  const finalSlug = slugify(
    slug || (kind === 'feed' ? `feed-${hostOf(got.finalUrl)}` : title),
    kind === 'feed' ? 'feed' : 'page',
  )
  const rel = `raw/sources/${finalSlug}.md`
  const abs = path.join(dir, rel)
  const exists = fs.existsSync(abs)
  // 网页默认不覆盖（raw 是原始资料）；feed 默认覆盖（它本来就是滚动的同一份文档）
  const shouldWrite = !exists || overwrite || kind === 'feed'
  if (!shouldWrite) {
    return { ok: false, error: `同名源文件已存在：${rel}（要覆盖请带 overwrite）`, path: rel, exists: true }
  }

  const lines = [
    '---',
    `title: ${title}`,
    'type: raw-source',
    `origin: ${got.finalUrl}`,
    `kind: ${kind}`,
    `fetched: ${isoDay(new Date().toISOString())}`,
    `via: ${via}`,
    '---',
    '',
    `# ${title}`,
    '',
    body,
    '',
  ]

  await fsp.mkdir(path.dirname(abs), { recursive: true })
  await fsp.writeFile(abs, lines.join('\n'), 'utf8')
  return { ok: true, path: rel, abs, title, via, kind, slug: finalSlug, chars: body.length, bytes: got.bytes }
}
