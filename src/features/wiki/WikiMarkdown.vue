<script setup lang="ts">
/**
 * 知识库用的 markdown 渲染（零依赖）。
 *
 * 为什么不用 MdLite：那个是给看板/简报用的「只要标题、列表、加粗」的极简版，
 * 而知识库的页面是正经 markdown —— 有代码块、表格、分隔线、嵌套列表，还有 [[双链]]。
 * 硬塞进 MdLite 会渲染成「半渲染的错版」（那正是 MdLite 注释里警告的情况），
 * 所以这里单独一份，规则同源：**先转义、再替换**，不把库里的文本当 HTML 信任。
 *
 * [[双链]] 渲染成可点的 <a data-wl="slug">，点击交给父组件处理（这里只负责画，
 * 不做路由跳转 —— 组件保持无依赖，图谱/搜索结果也能复用同一套跳转逻辑）。
 */
import { computed } from 'vue'
import { sidecarMedia } from '@/core/sidecar'
import { typesetMath } from './math-typeset'

/**
 * refs 传进来时，正文里的 [1][2]… 会渲染成可点的引用上标（问答回答的内联依据）：
 * 匹配模型按系统提示标的编号，点击抛 cite 事件给父组件（滚到/跳到对应依据页）。
 * 只在问答场景传 refs；普通页面渲染不传，[1] 原样当文本。
 */
const props = defineProps<{ text?: string; refs?: { path: string; title: string; kind?: string }[] }>()
const emit = defineEmits<{ (e: 'wiki-link', slug: string): void; (e: 'cite', index: number): void }>()

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 库内图片（wiki/、raw/ 下的相对路径）走边车的 /api/wiki/asset；外链原样保留 */
function imgSrc(url: string) {
  const u = url.trim()
  if (/^https?:\/\//i.test(u)) return u
  if (u.startsWith('/api/')) return sidecarMedia(u)
  return sidecarMedia(`/api/wiki/asset?path=${encodeURIComponent(u)}`)
}

/**
 * 云端解析（MinerU）的正文里，表格是**原生 HTML `<table>`**（带 rowspan/colspan，
 * 这点 markdown 表格表达不了），所以阅读器必须能渲染它 —— 但整份正文默认是「先转义」，
 * 直接放行 HTML 等于开 XSS 口子。折中：只放行表格这一族标签，属性白名单收窄，
 * 事件属性（on*）、script/style、javascript: 一律剥掉，`src` 走库内图片通道。
 */
const ALLOWED_TAGS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'br', 'img', 'b', 'strong', 'i', 'em', 'sup', 'sub', 'p'])
const ALLOWED_ATTR = new Set(['rowspan', 'colspan', 'src', 'alt', 'title'])

function sanitizeTable(html: string) {
  // 先把 script/style 连内容一起丢掉 —— 只按标签过滤的话，标签被剥了但脚本正文会当文本留下
  const clean = String(html).replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, '')
  return clean.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g, (_m, slash, tagRaw, attrsRaw) => {
    const tag = String(tagRaw).toLowerCase()
    if (!ALLOWED_TAGS.has(tag)) return ''
    if (slash) return `</${tag}>`
    const keep: string[] = []
    const re = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g
    let m: RegExpExecArray | null
    while ((m = re.exec(String(attrsRaw ?? '')))) {
      const name = m[1].toLowerCase()
      const val = String(m[2] ?? m[3] ?? m[4] ?? '')
      if (!ALLOWED_ATTR.has(name)) continue
      if (name === 'src') {
        if (/^\s*(javascript|data|vbscript):/i.test(val)) continue
        keep.push(`src="${imgSrc(val).replace(/"/g, '&quot;')}"`)
        continue
      }
      keep.push(`${name}="${val.replace(/"/g, '&quot;')}"`)
    }
    return `<${tag}${keep.length ? ` ${keep.join(' ')}` : ''}>`
  })
}

/** 行内：图片 → 行内码 → 双链 → 引用编号 [N] → 链接 → 加粗/斜体/删除线 → 数学排版
 * 数学排版放最后：代码、链接、双链、图片先换成「保护性 token」（不含公式符号的占位串），
 * typesetMath 只碰还剩的裸文本；占位符在排版完再换回真 HTML。
 * 为什么不用裸数字占位：a^b 里的 ^ 会把相邻数字当上下标，HTML 里会漏出裸占位数字。 */
function inline(src: string) {
  const stash: string[] = []
  const keep = (html: string) => {
    stash.push(html)
    return `WMDKEEP${stash.length - 1}WMDKEEP`
  }
  let out = esc(src)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, alt, url) => {
      const src2 = imgSrc(String(url).replace(/&amp;/g, '&'))
      return keep(`<img class="wmd__img" src="${src2}" alt="${alt || ''}" loading="lazy" />`)
    })
    .replace(/`([^`]+)`/g, (_m, code) => keep(`<code>${code}</code>`))
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_m, target, label) => {
      const t = String(target).trim()
      return keep(`<a href="#" class="wmd__wl" data-wl="${t}">${(label ?? t).trim()}</a>`)
    })
  // 引用编号 [N]：只在传了 refs 时替换（问答回答）；标题里带编号、普通文章里的 [1] 不动
  if (props.refs?.length) {
    out = out.replace(/\[(\d{1,2})\]/g, (m, num) => {
      const i = Number(num) - 1
      const r = props.refs![i]
      if (!r) return m
      return keep(`<sup class="wmd__cite" data-cite="${i}" title="${r.title.replace(/"/g, '&quot;')}">[${num}]</sup>`)
    })
  }
  out = out
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_m, label, url) =>
      keep(`<a href="${url}" target="_blank" rel="noreferrer">${label}</a>`),
    )
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(（])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
  // 数学排版：此时只剩裸文本（代码/链接/双链/图片都被占位成 WMDKEEP 串），对公式段排斜体+上下标
  out = typesetMath(out)
  // 占位符换回真 HTML
  out = out.replace(/WMDKEEP(\d+)WMDKEEP/g, (_m, i) => stash[Number(i)] ?? '')
  return out
}

type Block =
  | { kind: 'h'; level: number; html: string }
  | { kind: 'p'; html: string }
  | { kind: 'quote'; html: string[] }
  | { kind: 'ul'; items: { html: string; depth: number }[] }
  | { kind: 'ol'; items: { html: string; depth: number }[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'html'; html: string }
  | { kind: 'hr' }

const blocks = computed<Block[]>(() => {
  const lines = String(props.text ?? '').split(/\r?\n/)
  const out: Block[] = []
  let i = 0
  const tableRow = (l: string) =>
    l
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim())

  while (i < lines.length) {
    const line = lines[i]
    const t = line.trim()

    // 围栏代码块
    const fence = t.match(/^```(.*)$/)
    if (fence) {
      const lang = fence[1].trim()
      const buf: string[] = []
      i += 1
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        buf.push(lines[i])
        i += 1
      }
      i += 1
      out.push({ kind: 'code', lang, text: buf.join('\n') })
      continue
    }
    if (!t) {
      i += 1
      continue
    }
    // 原生 HTML 表格（云端解析产物）：整块收走、白名单清洗后原样渲染
    if (/^<table[\s>]/i.test(t)) {
      const buf: string[] = []
      while (i < lines.length) {
        buf.push(lines[i])
        if (/<\/table>/i.test(lines[i])) {
          i += 1
          break
        }
        i += 1
      }
      out.push({ kind: 'html', html: sanitizeTable(buf.join('\n')) })
      continue
    }
    // 分隔线
    if (/^([-*_])\1{2,}$/.test(t)) {
      out.push({ kind: 'hr' })
      i += 1
      continue
    }
    // 标题
    const h = t.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      out.push({ kind: 'h', level: h[1].length, html: inline(h[2]) })
      i += 1
      continue
    }
    // 表格：当前行是 | a | b |，下一行是 |---|---|
    if (/^\|.*\|$/.test(t) && /^\|[\s:|-]+\|$/.test((lines[i + 1] ?? '').trim())) {
      const head = tableRow(t).map((c) => inline(c))
      i += 2
      const rows: string[][] = []
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        rows.push(tableRow(lines[i].trim()).map((c) => inline(c)))
        i += 1
      }
      out.push({ kind: 'table', head, rows })
      continue
    }
    // 引用（连续 > 行合成一块）
    if (/^>\s?/.test(t)) {
      const buf: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(inline(lines[i].replace(/^\s*>\s?/, '')))
        i += 1
      }
      out.push({ kind: 'quote', html: buf })
      continue
    }
    // 列表（有序/无序；按缩进记一层 depth）
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/)
    if (li) {
      const ordered = /\d/.test(li[2])
      const items: { html: string; depth: number }[] = []
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/)
        if (!m || /\d/.test(m[2]) !== ordered) break
        items.push({ html: inline(m[3]), depth: Math.min(2, Math.floor(m[1].length / 2)) })
        i += 1
      }
      out.push({ kind: ordered ? 'ol' : 'ul', items })
      continue
    }
    // 普通段落（连续非空行合并）
    const buf: string[] = [line]
    i += 1
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i].trim()) &&
      !/^\s*>/.test(lines[i]) &&
      !/^```/.test(lines[i].trim()) &&
      !/^\|.*\|$/.test(lines[i].trim())
    ) {
      buf.push(lines[i])
      i += 1
    }
    out.push({ kind: 'p', html: inline(buf.join(' ')) })
  }
  return out
})

function onClick(e: MouseEvent) {
  const el = (e.target as HTMLElement)?.closest?.('[data-wl],[data-cite]') as HTMLElement | null
  if (!el) return
  e.preventDefault()
  const slug = el.getAttribute('data-wl')
  if (slug) return emit('wiki-link', slug)
  const cite = el.getAttribute('data-cite')
  if (cite !== null) emit('cite', Number(cite))
}
</script>

<template>
  <div class="wmd" @click="onClick">
    <template v-for="(b, i) in blocks" :key="i">
      <component :is="`h${b.level}`" v-if="b.kind === 'h'" class="wmd__h" :class="`wmd__h--${b.level}`" v-html="b.html" />
      <hr v-else-if="b.kind === 'hr'" class="wmd__hr" />
      <pre v-else-if="b.kind === 'code'" class="wmd__code"><code v-html="b.text" /></pre>
      <blockquote v-else-if="b.kind === 'quote'" class="wmd__quote">
        <p v-for="(q, j) in b.html" :key="j" v-html="q" />
      </blockquote>
      <ul v-else-if="b.kind === 'ul'" class="wmd__list">
        <li v-for="(it, j) in b.items" :key="j" :class="`wmd__li--d${it.depth}`"><span v-html="it.html" /></li>
      </ul>
      <ol v-else-if="b.kind === 'ol'" class="wmd__list wmd__list--num">
        <li v-for="(it, j) in b.items" :key="j" :class="`wmd__li--d${it.depth}`"><span v-html="it.html" /></li>
      </ol>
      <table v-else-if="b.kind === 'table'" class="wmd__table">
        <thead>
          <tr><th v-for="(c, j) in b.head" :key="j" v-html="c" /></tr>
        </thead>
        <tbody>
          <tr v-for="(r, j) in b.rows" :key="j"><td v-for="(c, k) in r" :key="k" v-html="c" /></tr>
        </tbody>
      </table>
      <div v-else-if="b.kind === 'html'" class="wmd__html" v-html="b.html" />
      <p v-else class="wmd__p" v-html="b.html" />
    </template>
  </div>
</template>

<style scoped>
.wmd {
  font-size: var(--ws-fs-base);
  line-height: 1.85;
  color: var(--ws-text-2);
  overflow-wrap: anywhere;
}
.wmd__h {
  color: var(--ws-text);
  font-weight: 650;
  margin: 18px 0 6px;
  line-height: 1.45;
}
/* 阅读器排版：h1/h2 带一条很淡的分隔线，正文不是一坨整字 */
.wmd__h--1 {
  font-size: var(--ws-fs-lg);
  margin: 4px 0 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--ws-border);
}
.wmd__h--2 {
  font-size: var(--ws-fs-md);
  margin-top: 20px;
  padding-bottom: 5px;
  border-bottom: 1px solid var(--ws-border);
}
.wmd__h--3,
.wmd__h--4,
.wmd__h--5,
.wmd__h--6 { font-size: var(--ws-fs-sm); color: var(--ws-text-2); }
.wmd__p { margin: 8px 0; }
.wmd__hr {
  border: none;
  border-top: 1px solid var(--ws-border);
  margin: 16px 0;
}
.wmd__quote {
  margin: 10px 0;
  padding: 2px 0 2px 12px;
  border-left: 3px solid var(--ws-accent);
  color: var(--ws-text-3);
  font-size: var(--ws-fs-sm);
}
.wmd__quote p { margin: 4px 0; }
.wmd__list { margin: 8px 0; padding-left: 20px; }
.wmd__list--num { list-style: decimal; }
.wmd__list li { margin: 4px 0; }
.wmd__list li::marker { color: var(--ws-text-3); }
.wmd__li--d1 { margin-left: 16px; }
.wmd__li--d2 { margin-left: 32px; }
.wmd__code {
  margin: 10px 0;
  padding: 12px 14px;
  border-radius: var(--ws-radius-sm);
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
  overflow-x: auto;
  font-family: var(--ws-mono);
  font-size: var(--ws-fs-xs);
  line-height: 1.7;
  color: var(--ws-text-2);
}
.wmd__table {
  width: 100%;
  margin: 12px 0;
  border-collapse: collapse;
  font-size: var(--ws-fs-sm);
}
.wmd__table th,
.wmd__table td {
  border: 1px solid var(--ws-border);
  padding: 6px 10px;
  text-align: left;
  vertical-align: top;
}
.wmd__table th {
  background: var(--ws-panel-2);
  color: var(--ws-text);
  font-weight: 600;
}
/* 云端解析出的原生表格：结构与 markdown 表格同款，另允许横向滚动（列可能很多） */
.wmd__html {
  margin: 12px 0;
  overflow-x: auto;
}
.wmd__html :deep(table) {
  border-collapse: collapse;
  font-size: var(--ws-fs-sm);
  min-width: 60%;
}
.wmd__html :deep(th),
.wmd__html :deep(td) {
  border: 1px solid var(--ws-border);
  padding: 6px 10px;
  text-align: left;
  vertical-align: top;
}
.wmd__html :deep(th) {
  background: var(--ws-panel-2);
  color: var(--ws-text);
  font-weight: 600;
}
.wmd__html :deep(caption) {
  caption-side: top;
  text-align: left;
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-3);
  padding-bottom: 4px;
}
.wmd :deep(img.wmd__img) {
  display: block;
  max-width: 100%;
  max-height: 380px;
  margin: 12px 0;
  border-radius: var(--ws-radius-sm);
  border: 1px solid var(--ws-border);
  background: var(--ws-panel-2);
  object-fit: contain;
}
.wmd :deep(a) {
  color: var(--ws-accent);
  text-decoration: none;
  border-bottom: 1px solid var(--ws-accent-ring);
}
.wmd :deep(a:hover) { border-bottom-color: var(--ws-accent); }
/* 双链：库内跳转，跟外链区分开（软底 + 无下划线） */
.wmd :deep(a.wmd__wl) {
  color: var(--ws-accent);
  background: var(--ws-accent-soft);
  border: none;
  border-radius: 4px;
  padding: 0 4px;
  cursor: pointer;
}
/* 内联引用编号：小上标、可点，点它 = 点下方对应的依据条目 */
.wmd :deep(sup.wmd__cite) {
  color: var(--ws-accent);
  font-size: 0.72em;
  font-weight: 600;
  padding: 0 1px;
  cursor: pointer;
  line-height: 0;
}
.wmd :deep(sup.wmd__cite:hover) {
  background: var(--ws-accent-soft);
  border-radius: 3px;
}
.wmd :deep(strong) { color: var(--ws-text); font-weight: 650; }
.wmd :deep(code) {
  font-family: var(--ws-mono);
  font-size: 0.92em;
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
  padding: 0 4px;
  border-radius: 4px;
}

/* ------------------------------------------------------- 数学排版 --- */
/* KaTeX 字体（只带 5 个 woff2，~92KB）：Math-Italic 排变量斜体，Main 排数字与运算 */
@font-face {
  font-family: 'KaTeX_Math';
  src: url('@/assets/katex-fonts/KaTeX_Math-Italic.woff2') format('woff2');
  font-weight: normal;
  font-style: italic;
  font-display: swap;
}
@font-face {
  font-family: 'KaTeX_Main';
  src: url('@/assets/katex-fonts/KaTeX_Main-Regular.woff2') format('woff2');
  font-weight: normal;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'KaTeX_Main';
  src: url('@/assets/katex-fonts/KaTeX_Main-Bold.woff2') format('woff2');
  font-weight: bold;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'KaTeX_Main';
  src: url('@/assets/katex-fonts/KaTeX_Main-Italic.woff2') format('woff2');
  font-weight: normal;
  font-style: italic;
  font-display: swap;
}

/* 公式段：变量斜体（KaTeX_Math 里没有的字符 —— 希腊/中文 —— 回落 KaTeX_Main/系统斜体） */
.wmd :deep(.wmd__math) {
  font-family: 'KaTeX_Math', 'KaTeX_Main', 'STIX Two Math', 'Cambria Math', serif;
  font-style: italic;
  font-size: 1.02em;
  letter-spacing: 0.01em;
  white-space: nowrap;
}
/* 上下标：0.72em + 垂直位移（sup 上偏 0.45em、sub 下偏 0.3em），和 KaTeX 的排法一致 */
.wmd :deep(sup.wmd__ss),
.wmd :deep(sub.wmd__ss) {
  font-size: 0.72em;
  line-height: 0;
  font-style: inherit;
}
.wmd :deep(sup.wmd__ss) { vertical-align: 0.45em; }
.wmd :deep(sub.wmd__ss) { vertical-align: -0.3em; }
</style>
