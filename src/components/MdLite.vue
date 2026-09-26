<script setup lang="ts">
/**
 * 极简 Markdown 渲染（零依赖，先转义再替换）。
 *
 * 为什么不用 marked/markdown-it：看板只需要这几样 —— 标题、列表、加粗、行内码、引用。
 * 引一个库不如 60 行可控：① 所有颜色走令牌（深浅主题自动成立）；
 * ② **先 escape 再替换**，AI 的输出不可信，直接 v-html 会开出 XSS 口子。
 *
 * 支持：`# 标题`、`【标题】`、`- 列表`、`1. 列表`、`> 引用`、`**加粗**`、`` `行内码` ``、普通段落。
 * 颜色语义：小标题/列表圆点 = 主色；加粗 = 高亮底（数字、截止日这类关键词会自动跳出来）；
 * 引用 = 左侧竖线。其它的 markdown 语法不渲染、按原文显示（宁可朴素也不要半渲染的错版）。
 */
import { computed } from 'vue'
import { sidecarMedia } from '@/core/sidecar'

const props = defineProps<{ text?: string; dense?: boolean }>()

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function rewriteImg(url: string) {
  const u = url.trim()
  if (/^i:(\d+)$/i.test(u)) return ''
  if (/^https?:\/\//i.test(u) || u.startsWith('/api/')) {
    return u.startsWith('/api/') ? sidecarMedia(u) : u
  }
  if (/^[A-Za-z]:[\\/]/.test(u) || u.startsWith('file:')) {
    const file = u.replace(/^file:\/\//i, '')
    // 只认知识库自己的资源通道：别的页面要显示本地图，请自带一个 /api/... 端点
    return sidecarMedia(`/api/wiki/asset?path=${encodeURIComponent(file)}`)
  }
  return u
}

/** 行内：加粗、行内码、图片、链接 */
function inline(s: string) {
  return esc(s)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, url) => {
      const src = rewriteImg(String(url).replace(/&amp;/g, '&'))
      if (!src) return `<span class="mdl__img-miss">[图：${alt || '本地图，没有可用的取图通道'}]</span>`
      return `<img class="mdl__img" src="${src}" alt="${alt || ''}" />`
    })
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

type Block = { kind: 'h' | 'li' | 'q' | 'p'; html: string }

const blocks = computed<Block[]>(() => {
  const out: Block[] = []
  for (const raw of String(props.text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const h = line.match(/^#{1,6}\s*(.+)$/)
    if (h) {
      out.push({ kind: 'h', html: inline(h[1]) })
      continue
    }
    const bracket = line.match(/^【(.+)】$/)
    if (bracket) {
      out.push({ kind: 'h', html: inline(bracket[1]) })
      continue
    }
    const li = line.match(/^(?:[-*•]|\d+[.、)])\s+(.+)$/)
    if (li) {
      out.push({ kind: 'li', html: inline(li[1]) })
      continue
    }
    const q = line.match(/^>\s?(.*)$/)
    if (q) {
      out.push({ kind: 'q', html: inline(q[1]) })
      continue
    }
    out.push({ kind: 'p', html: inline(line) })
  }
  return out
})
</script>

<template>
  <div class="mdl" :class="{ 'mdl--dense': dense }">
    <template v-for="(b, i) in blocks" :key="i">
      <div v-if="b.kind === 'h'" class="mdl__h" v-html="b.html" />
      <div v-else-if="b.kind === 'li'" class="mdl__li">
        <i class="mdl__dot" />
        <span class="mdl__li-text" v-html="b.html" />
      </div>
      <div v-else-if="b.kind === 'q'" class="mdl__q" v-html="b.html" />
      <div v-else class="mdl__p" v-html="b.html" />
    </template>
  </div>
</template>

<style scoped>
.mdl {
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-size: 13px;
  line-height: 1.78;
  color: var(--ws-text-2);
}
.mdl--dense {
  gap: 5px;
  font-size: 12.5px;
  line-height: 1.7;
}
/* 关键词（加粗）——给一层主色软底，让数字/截止日在一段话里自己跳出来 */
.mdl :deep(strong) {
  font-weight: 650;
  color: var(--ws-text-1);
  background: var(--ws-accent-soft);
  padding: 0 4px;
  border-radius: 4px;
}
.mdl :deep(code) {
  font-family: var(--ws-mono);
  font-size: 0.92em;
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
  padding: 0 4px;
  border-radius: 4px;
}
.mdl__h {
  font-size: 12px;
  font-weight: 650;
  color: var(--ws-accent);
  letter-spacing: 0.02em;
  margin-top: 3px;
}
.mdl__li {
  display: flex;
  gap: 8px;
  align-items: baseline;
}
.mdl__dot {
  flex: 0 0 auto;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--ws-accent);
  transform: translateY(-2px);
}
.mdl__li-text {
  min-width: 0;
}
.mdl__q {
  border-left: 2px solid var(--ws-accent);
  padding-left: 8px;
  color: var(--ws-text-3);
}
.mdl :deep(.mdl__img) {
  display: block;
  max-width: 100%;
  max-height: 220px;
  margin: 6px 0;
  border-radius: 6px;
  border: 1px solid var(--ws-border);
  object-fit: contain;
  background: var(--ws-panel);
}
.mdl :deep(.mdl__img-miss) {
  color: var(--ws-text-3);
  font-size: 12px;
}
</style>
