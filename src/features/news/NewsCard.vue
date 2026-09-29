<script setup lang="ts">
/**
 * 一条事件卡：`#/news` 的主体。
 *
 * 形状：
 *  - **标题 + 一段「它到底在讲什么」**（不是原始标题的搬运 —— 原始标题放在行尾小字里当锚点，
 *    正文是源的 desc / 后续 AI 高度概括；没有 AI 的时候就用源给的那一段，绝不留空）
 *  - **来源以平台图标给**：每枚图标都能点（去那条原文）；同一事件被多个源抓到就多枚
 *  - **情绪是这一条自己的**（不是整批的统计）；词典判定，标题里明说
 *  - **反馈组**：👍 / 👎 / 备注 —— 这是调教采集方向的信号，落 `data/news-prefs/`
 */
import { computed, ref } from 'vue'
import { api } from '@/core/sidecar'
import { useUiStore } from '@/core/ui'
import { ChsiIcon, XIcon, LinuxDoIcon, V2exIcon, HnIcon, GithubIcon, SspaiIcon, WeixinIcon, RssIcon } from './sourceIcons'

const ui = useUiStore()

const props = defineProps<{ card: any }>()
const emit = defineEmits<{ (e: 'changed'): void; (e: 'tag', tag: string): void }>()

/** 标签样式名（中文标签不能直接当 class） */
const tagKey = (t: string) =>
  (({ 新产品: 'new', 教程: 'how', 薅羊毛: 'free', 工具: 'tool', 论文: 'paper', 政策: 'gov', 招聘: 'job', 讨论: 'talk' }) as any)[t] ?? 'talk'

/** 追踪：让下一轮概括在**原卡**上补齐（见 docs/news-contract.md §1.3） */
const tracking = ref(false)
/** 追踪状态本地先翻转（乐观更新）：点下去立刻变，不等网络 */
const trackedLocal = ref<boolean | null>(null)
const isTracked = computed(() => trackedLocal.value ?? !!props.card.tracked)
async function track() {
  if (tracking.value) return
  tracking.value = true
  const next = !isTracked.value
  trackedLocal.value = next
  await api.newsTrack({ title: props.card.title, summary: props.card.summary, on: next })
  tracking.value = false
}

/**
 * 源 id → 平台图标。**新增源要在 `sourceIcons.ts` 与这里各补一条**
 * （页面 `NewsView.vue` 里还有一份同样的表，两处一起改），否则会退化成通用 RSS 图标。
 */
const SOURCE_ICON: Record<string, any> = {
  'chsi-yz': ChsiIcon,
  'x-openai': XIcon,
  'linuxdo-top': LinuxDoIcon,
  'linuxdo-news': LinuxDoIcon,
  v2ex: V2exIcon,
  hn: HnIcon,
  'github-hot': GithubIcon,
  sspai: SspaiIcon,
  'wx-jiqizhixin': WeixinIcon,
  'wx-qbitai': WeixinIcon,
  'wx-paperweekly': WeixinIcon,
}
const icon = (id: string) => SOURCE_ICON[id] ?? RssIcon

/** 情绪三段（有评论数就用真实条数，没有就按词典判定给一个比例，标了来源） */
const moodPct = computed(() => {
  const s = props.card.sentiment
  const n = Number(s?.n ?? props.card.sentN ?? 0)
  if (n > 0) {
    const p = Number(s?.pos ?? 0), u = Number(s?.neu ?? 0), g = Number(s?.neg ?? 0)
    const sum = Math.max(1, p + u + g)
    return { pos: `${(p / sum) * 100}%`, neu: `${(u / sum) * 100}%`, neg: `${(g / sum) * 100}%`, n, p, u, g }
  }
  return { pos: '33%', neu: '34%', neg: '33%', n: 0, p: 0, u: 0, g: 0 }
})
/** 关键词：模型给的 keywords 优先；没有再退回词表命中的关键词；都没有就显示「暂无」 */
const keywords = computed<string[]>(() => {
  const k = props.card.keywords
  if (Array.isArray(k) && k.length) return k.slice(0, 6)
  return (props.card.kws ?? []).slice(0, 6)
})
/**
 * 词云：按顺序递减字号/透明度（第一个是这件事的主角）。
 * 手机上限幅到 ≥12px —— 11px 在手机上要眯眼，而且会被手机门禁判「小字」（2026-09-29 调）。
 */
const cloudSize = (i: any) => {
  const desk = [15, 14, 13, 12, 12, 11]
  const mob = [16, 15, 14, 13, 13, 12]
  return `${(ui.isMobile ? mob : desk)[i] ?? (ui.isMobile ? 12 : 11)}px`
}
const cloudOpacity = (i: any) => String([1, 0.92, 0.85, 0.78, 0.72, 0.66][i] ?? 0.6)
/** 热度柱：有历史画历史，没有就单柱占位（不编趋势）；手机上柱子加高，太矮看不出趋势 */
const heatBars = computed<number[]>(() => {
  const h = ui.isMobile ? 26 : 18
  const floor = ui.isMobile ? 5 : 3
  const series = props.card.heat?.series ?? props.card.heatSeries
  if (Array.isArray(series) && series.length > 1) {
    const max = Math.max(...series, 1)
    return series.slice(-7).map((v: number) => Math.max(floor, Math.round((v / max) * h)))
  }
  return props.card.heat?.n ? [h - 2] : []
})

/**
 * 情绪只有两处来源：原始条目给 `sent`（词典/评论算的），AI 卡给 `mood`（模型给的）。
 * 统一读一个值，卡片左边那条情绪色才不会被漏掉 —— 只读 `sent` 时 AI 卡（页面主体）
 * 全是灰边（2026-09-30 修正）。
 */
const moodValue = computed(() => props.card.sent ?? props.card.mood ?? 'neu')
const sentText = computed(() => (moodValue.value === 'pos' ? '偏正面' : moodValue.value === 'neg' ? '偏负面' : '中性'))

/** 来源名**不截断**：内容都要展示全，没有省略的做法 */
const shortName = (s: any) => String(s?.name ?? '')

/**
 * 同一来源常常出好几篇（四条公告来自同一个源 → 四个一样的来源胶囊），底行就花了。
 * 按来源名去重，重复的给个 ×N；点进去仍然取第一篇的链接（同一来源的入口是一样的）。
 */
const dedupedSources = computed(() => {
  const m = new Map<string, any>()
  for (const s of props.card.sources ?? []) {
    const k = shortName(s) || s.id || s.name
    const cur = m.get(k)
    if (cur) cur.n++
    else m.set(k, { ...s, n: 1 })
  }
  return [...m.values()]
})

const busy = ref(false)
const voted = ref<'up' | 'down' | ''>('')
const noteOpen = ref(false)
const note = ref('')
const noteSaved = ref(false)

async function vote(v: 'up' | 'down') {
  if (busy.value) return
  busy.value = true
  voted.value = v
  await api.newsFeedback({
    id: props.card.key,
    title: props.card.title,
    url: props.card.sources?.[0]?.url,
    cat: props.card.cat,
    sourceId: props.card.sources?.[0]?.id,
    kws: props.card.kws ?? [],
    vote: v,
  })
  busy.value = false
  // 不 emit('changed')：那是「整页重拉三个接口 + 重渲染整列卡片」，
  // 点一个赞要等几百毫秒，就是不跟手的原因（2026-09-28）。本地状态已经够了。
}

async function saveNote() {
  if (busy.value || !note.value.trim()) return
  busy.value = true
  noteSaved.value = false
  await api.newsFeedback({
    id: props.card.key,
    title: props.card.title,
    url: props.card.sources?.[0]?.url,
    cat: props.card.cat,
    sourceId: props.card.sources?.[0]?.id,
    kws: props.card.kws ?? [],
    note: note.value.trim(),
  })
  busy.value = false
  noteSaved.value = true
  noteOpen.value = false
  note.value = ''
}

const ago = (ms?: number) => {
  if (!ms) return ''
  const min = Math.round((Date.now() - Number(ms)) / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  if (min < 60 * 24) return `${Math.round(min / 60)} 小时前`
  return `${Math.round(min / 1440)} 天前`
}
</script>

<template>
  <article class="nc" :class="`is-${moodValue}`">
    <!-- 标题行：情绪点 · 标题 · 时间 -->
    <header class="nc__head">
      <h3 class="nc__title">{{ card.title }}</h3>
      <span v-if="card.hot" class="nc__tag is-hot">热帖</span>
      <span v-if="card.isNew" class="nc__tag is-new">新</span>
      <span v-if="card.heat?.n" class="nc__heat" :title="`${card.heat.n} ${card.heat.unit}`">🔥 {{ card.heat.n }}</span>
      <span v-if="card.tracked" class="nc__tracked" title="已在追踪：下一轮会在这张卡上继续补齐">✓ 已追踪</span>
      <time class="nc__time">{{ ago(card.ts) }}</time>
    </header>

    <div class="nc__body">
      <div class="nc__left">
        <!-- 它在讲什么：整段显示，绝不截断、绝不省略（这是卡片的正文） -->
        <p v-if="card.summary" class="nc__summary">{{ card.summary }}</p>
      </div>
      <!-- 右栏：这件事的「数据面」——评论情绪 / 关键词 / 热度趋势 -->
      <aside v-if="moodPct.n || keywords.length || card.heat?.n" class="nc__side">
        <div v-if="moodPct.n" class="nc__side-row">
          <span class="nc__side-label">评论情绪</span>
          <span class="nc__moodbar" :title="`正面 ${moodPct.p} / 中性 ${moodPct.u} / 负面 ${moodPct.g}`">
            <i class="is-pos" :style="{ width: moodPct.pos }" /><i class="is-neu" :style="{ width: moodPct.neu }" /><i class="is-neg" :style="{ width: moodPct.neg }" />
          </span>
          <span class="nc__side-num">{{ moodPct.n }} 条</span>
        </div>
        <div v-if="keywords.length" class="nc__side-row nc__side-row--cloud">
          <span class="nc__side-label">关键词</span>
          <span class="nc__cloud">
            <em v-for="(k, i) in keywords" :key="k" :style="{ fontSize: cloudSize(i), opacity: cloudOpacity(i) }">{{ k }}</em>
          </span>
        </div>
        <div v-if="card.heat?.n" class="nc__side-row">
          <span class="nc__side-label">热度</span>
          <span class="nc__bars"><i v-for="(v, i) in heatBars" :key="i" :style="{ height: `${v}px` }" /></span>
          <span class="nc__side-num nc__side-num--hot">🔥 {{ card.heat.n }}<template v-if="card.heat.unit"> {{ card.heat.unit }}</template></span>
        </div>
      </aside>
    </div>

    <!-- 底行：标签（先）→ 来源（后）→ 四个动作（最右） -->
    <footer class="nc__foot">
      <span v-if="card.tags?.length" class="nc__tagsec">
        <button
          v-for="t in card.tags"
          :key="t"
          class="nc__tagchip"
          :class="`is-${tagKey(t)}`"
          :title="`只看「${t}」`"
          @click.stop="$emit('tag', t)"
        >
          {{ t }}
        </button>
      </span>
      <span class="nc__sources">
        <a
          v-for="(sr, i) in dedupedSources"
          :key="i"
          class="nc__src"
          :class="{ 'is-official': sr.official, 'is-dead': !sr.url }"
          :href="sr.url || undefined"
          target="_blank"
          rel="noreferrer"
          :title="sr.url ? `${sr.name}${sr.n > 1 ? `（${sr.n} 篇）` : ''} · 点开看原文` : sr.name"
          @click.stop
        >
          <component :is="icon(sr.id)" class="nc__src-icon" />
          <span class="nc__src-name">{{ shortName(sr) }}</span>
          <span v-if="sr.n > 1" class="nc__src-n">×{{ sr.n }}</span>
        </a>
      </span>
      <span class="nc__actions">
        <button class="nc__ico" :class="{ 'is-on': voted === 'up' }" title="有用，多来点" @click="vote('up')">
          <svg viewBox="0 0 24 24" width="15" height="15"><path d="M7 22V10l5-8 1.2.7c.7.4 1 1.2.8 2L13 9h5.2c1.4 0 2.4 1.2 2.1 2.5l-1.6 8c-.2 1-1 1.5-2 1.5H7Zm-2 0H3V10h2v12Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
        </button>
        <button class="nc__ico" :class="{ 'is-on': voted === 'down' }" title="没用，少来点" @click="vote('down')">
          <svg viewBox="0 0 24 24" width="15" height="15"><path d="M17 2v12l-5 8-1.2-.7c-.7-.4-1-1.2-.8-2L11 15H5.8c-1.4 0-2.4-1.2-2.1-2.5l1.6-8c.2-1 1-1.5 2-1.5H17Zm2 0h2v12h-2V2Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
        </button>
        <button class="nc__ico" :class="{ 'is-on': isTracked }" :title="isTracked ? '取消追踪' : '追踪：下一轮 AI 在这张卡上继续补齐'" @click="track()">
          <svg viewBox="0 0 24 24" width="15" height="15"><path d="M6 3h12v18l-6-4.5L6 21V3Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path v-if="isTracked" d="M9 10.5l2 2 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
        <button class="nc__ico" :class="{ 'is-on': noteOpen || noteSaved }" title="备注一句（变成采集规则）" @click="noteOpen = !noteOpen">
          <svg viewBox="0 0 24 24" width="15" height="15"><path d="M4 20h4L20 8a2.8 2.8 0 0 0-4-4L4 16v4Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
        </button>
      </span>
    </footer>

    <div v-if="noteOpen" class="nc__note">
      <input v-model="note" type="text" placeholder="比如：以后别给我 GitHub 仓库推荐 / 多来点大模型落地" @keyup.enter="saveNote" />
      <button :class="{ 'is-ready': note.trim() }" :disabled="busy || !note.trim()" @click="saveNote">记下</button>
    </div>
    <div v-else-if="noteSaved" class="nc__note-saved">已记下，会调教采集方向</div>
  </article>
</template>

<style scoped>
.nc {
  border: 1px solid var(--ws-border);
  border-left-width: 3px;
  border-radius: var(--ws-radius);
  background: var(--ws-panel);
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  box-shadow: var(--ws-shadow-1);
  transition: box-shadow 0.15s;
}
.nc:hover {
  box-shadow: var(--ws-shadow-2);
}
/* 左边框沿用**情绪色**：正面=绿 · 负面=红 · 中性=灰 */
.nc.is-pos { border-left-color: var(--ws-success); }
.nc.is-neg { border-left-color: var(--ws-danger); }
.nc.is-neu { border-left-color: var(--ws-border-strong); }

.nc__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.nc__head .nc__time {
  margin-left: auto;
}
.nc__title {
  margin: 0;
  font-size: var(--ws-fs-md);
  font-weight: 650;
  line-height: 1.45;
  color: var(--ws-text);
  flex: 1 1 auto;
  min-width: 0;
}
.nc__time {
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-2);
  white-space: nowrap;
}
.nc__tag {
  font-size: var(--ws-fs-xs);
  padding: 0 6px;
  border-radius: var(--ws-radius-sm);
  border: 1px solid var(--ws-border);
  color: var(--ws-text-3);
}
.nc__tag.is-hot {
  border-color: var(--ws-warn);
  color: var(--ws-warn);
  background: var(--ws-warn-soft);
}
.nc__tag.is-new {
  border-color: var(--ws-accent);
  color: var(--ws-accent);
  background: var(--ws-accent-soft);
}

/* 两栏：左内容 / 右数据面板 */
.nc__body {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}
.nc__left {
  flex: 1 1 auto;
  min-width: 0;
}
.nc__side {
  flex: 0 0 190px;
  border-left: 1px solid var(--ws-border);
  padding-left: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.nc__side-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.nc__side-row--cloud {
  align-items: baseline;
  flex-wrap: wrap;
}
.nc__side-label {
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-2);
  flex: 0 0 56px;
  white-space: nowrap;
}
.nc__side-none {
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-3);
  white-space: nowrap;
}
.nc__moodbar {
  flex: 1 1 auto;
  display: flex;
  height: 8px;
  border-radius: var(--ws-radius-pill);
  overflow: hidden;
  background: var(--ws-bg);
}
.nc__moodbar i.is-pos {
  background: var(--ws-success);
}
.nc__moodbar i.is-neu {
  background: var(--ws-border-strong);
}
.nc__moodbar i.is-neg {
  background: var(--ws-danger);
}
.nc__side-num {
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-2);
  font-variant-numeric: tabular-nums;
}
.nc__side-num--hot {
  color: var(--ws-warn);
}
.nc__cloud {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 6px;
  line-height: 1.2;
  align-items: baseline;
}
.nc__cloud em {
  font-style: normal;
  color: var(--ws-text);
}
.nc__bars {
  flex: 1 1 auto;
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 18px;
}
.nc__bars i {
  flex: 1 1 0;
  background: var(--ws-warn);
  border-radius: 2px 2px 0 0;
  opacity: 0.85;
}
@media (max-width: 760px) {
  .nc__body {
    flex-direction: column;
  }
  .nc__side {
    flex: 1 1 auto;
    width: 100%;
    border-left: 0;
    border-top: 1px solid var(--ws-border);
    padding-left: 0;
    padding-top: 8px;
  }
}

.nc__summary {
  margin: 0;
  font-size: var(--ws-fs-base);
  color: var(--ws-text-2);
  line-height: 1.65;
  word-break: break-word;
  white-space: pre-wrap;
}

.nc__heat {
  font-size: var(--ws-fs-xs);
  color: var(--ws-warn);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.nc__tracked {
  font-size: var(--ws-fs-xs);
  color: var(--ws-success);
  border: 1px solid var(--ws-success);
  background: var(--ws-success-soft);
  border-radius: var(--ws-radius-pill);
  padding: 0 8px;
  white-space: nowrap;
}
/* 标签胶囊：可点=筛选；颜色按类分（暗色自动跟令牌走） */
.nc__tags {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
}
:root {
  /* 与工具栏的筛选胶囊同一规格：统一尺寸/圆角，扫视时不用重新识别 */
}
/*
 * 标签胶囊：**实心底 + 白字**（原型图二那种实心彩色胶囊）。
 * 底色一律用 -deep 系列：白字压在上面的对比度 4.9–6.9:1，12px 也达标。
 */
.nc__tagchip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: 0;
  border-radius: var(--ws-radius-pill);
  height: 22px;
  padding: 0 10px 0 8px;
  font-size: var(--ws-fs-xs);
  font-weight: 600;
  cursor: pointer;
  background: var(--ws-text-2);
  color: var(--ws-on-solid);
  white-space: nowrap;
}
.nc__tagchip:hover {
  filter: brightness(1.08);
}
.nc__tagchip.is-new {
  background: var(--ws-accent);
}
.nc__tagchip.is-tool {
  background: var(--ws-accent-deep);
}
.nc__tagchip.is-how {
  background: var(--ws-success-deep);
}
.nc__tagchip.is-free {
  background: var(--ws-warn-deep);
}
.nc__tagchip.is-paper {
  background: var(--ws-info-deep);
}
.nc__tagchip.is-gov {
  background: var(--ws-danger-deep);
}
.nc__tagchip.is-job {
  background: var(--ws-module-office);
}
.nc__tagchip.is-talk {
  background: var(--ws-text-2);
}
/* 暗色档：底色换成亮一档的原色，实心块在深底上才立得住（白字仍达标） */
:global(html[data-theme='dark']) .nc__tagchip.is-new {
  background: var(--ws-accent);
}
:global(html[data-theme='dark']) .nc__tagchip.is-how {
  background: var(--ws-success);
}
:global(html[data-theme='dark']) .nc__tagchip.is-free {
  background: var(--ws-warn);
}
:global(html[data-theme='dark']) .nc__tagchip.is-paper {
  background: var(--ws-info);
}
:global(html[data-theme='dark']) .nc__tagchip.is-gov {
  background: var(--ws-danger);
}
:global(html[data-theme='dark']) .nc__tagchip {
  color: #0f1117;
  font-weight: 700;
}

.nc__foot {
  display: flex;
  align-items: center;
  gap: 8px 10px;
  flex-wrap: wrap;
  min-width: 0;
  border-top: 1px solid var(--ws-border);
  margin-top: 6px;
  padding-top: 10px;
}
.nc__tagsec {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  flex-wrap: wrap;
  flex: 0 0 auto;
}
.nc__sources {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  min-width: 0;
  padding-left: 0;
}
/* 只有「标签后面还跟着来源」时才画那根竖线（否则第一行会多一根孤立的线） */
.nc__tagsec + .nc__sources {
  border-left: 1px solid var(--ws-border);
  padding-left: 10px;
}
/* 来源：图标 + 名字，整体是个链接（比光图标好认） */
.nc__src {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  text-decoration: none;
  padding: 1px 6px 1px 2px;
  border-radius: var(--ws-radius-sm);
  color: var(--ws-text-2);
}
.nc__src:hover {
  background: var(--ws-panel-2);
  color: var(--ws-accent);
}
.nc__src.is-dead {
  color: var(--ws-text-3);
  cursor: default;
}
.nc__src.is-official .nc__src-name {
  color: var(--ws-text-2);
  font-weight: 600;
}
.nc__src-icon {
  width: 15px;
  height: 15px;
  flex: 0 0 15px;
}
.nc__src,
.nc__tagchip {
  min-height: 22px;
  line-height: 1;
}
.nc__src-name {
  font-size: var(--ws-fs-xs);
  white-space: nowrap;
}
.nc__src-n {
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-3);
  margin-left: 1px;
}
.nc__kw {
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-3);
}
.nc__w {
  font-size: var(--ws-fs-xs);
  color: var(--ws-accent);
}
/*
 * 反馈图标：**无边框裸图标**（之前那版带圆圈/方框描边，看着像十年前的按钮）。
 * 现在是：17px 灰线图标，悬停给浅底，选中变靛色 —— 安静但明确。
 */
.nc__actions {
  margin-left: auto;
  display: inline-flex;
  gap: 2px;
}
.nc__ico {
  display: inline-grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: 0;
  background: transparent;
  border-radius: 7px;
  cursor: pointer;
  color: var(--ws-text-2);
  padding: 0;
  transition: background 0.12s, color 0.12s;
}
.nc__ico:hover {
  background: var(--ws-panel-2);
  color: var(--ws-text);
}
.nc__ico.is-on {
  background: var(--ws-accent-soft);
  color: var(--ws-accent);
}

.nc__note {
  display: flex;
  gap: 6px;
}
.nc__note input {
  flex: 1 1 auto;
  border: 1px solid var(--ws-border-strong);
  border-radius: var(--ws-radius-pill);
  padding: 4px 10px;
  font-size: var(--ws-fs-sm);
  background: var(--ws-panel);
  color: var(--ws-text);
}
.nc__note input:focus {
  outline: none;
  border-color: var(--ws-accent);
  box-shadow: 0 0 0 3px var(--ws-accent-ring);
}
.nc__note button {
  border: 1px solid var(--ws-accent);
  background: var(--ws-accent);
  color: var(--ws-on-accent);
  border-radius: var(--ws-radius-pill);
  padding: 0 14px;
  font-size: var(--ws-fs-sm);
  cursor: pointer;
}
.nc__note button:disabled {
  opacity: 0.5;
  cursor: default;
}
.nc__note-saved {
  font-size: var(--ws-fs-xs);
  color: var(--ws-success);
}

/* 手机档：文章脚上的标签（政策/招生这类）只有 22px 高，抬到 28。
   **必须放在 .nc__tagchip{min-height:22px} 之后**，并用 .nc__tagsec > .nc__tagchip 提高优先级 ——
   只写 .nc__tagsec > * 会因为同优先级、源码更靠前而被盖掉（2026-09-29 踩过）。 */
@media (max-width: 760px) {
  .nc__tagsec > .nc__tagchip,
  .nc__tagsec > .nc__src {
    min-height: 28px;
  }
}
</style>
