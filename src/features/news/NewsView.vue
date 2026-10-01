<script setup lang="ts">
/**
 * 资讯（`#/news`）—— 采集器产物的阅读面。
 *
 * **页面的形状见 `docs/news-contract.md`**。页面只认三样东西：
 *  ① **AI 大总结**：上一批的一段话，最上面，最重要；
 *  ② **批次概要**：每批一句（更早的批次轮播，点一下停在那一批）；
 *  ③ **事件卡**：AI 高度概括的同类事件（不是原始标题），每张卡带**可点的平台图标**、
 *     **单事件情绪**、👍/👎/✎ 备注（备注会变成采集规则）。
 *
 * 不做的事：主题构成环图、信息来源条形图、整体情绪分布、以原始标题为主的流。
 * 采集器的档位 / 关注时间线合并进「后台」一块，默认收起。
 *
 * **采集不在本页做**：边车只读 `collector.dir` 下的产物（契约见 `docs/news-contract.md`），
 * 所以这里只有两个本机动作：「现在概括」（跑一轮 AI 概括）与「刷新」（重算看板）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import SidecarOffline from '@/components/SidecarOffline.vue'
import { api, ensureSidecar } from '@/core/sidecar'
import { usePolling } from '@/core/polling'
import { useUiStore } from '@/core/ui'
import NewsCard from './NewsCard.vue'
import { ChsiIcon, XIcon, LinuxDoIcon, V2exIcon, HnIcon, GithubIcon, SspaiIcon, WeixinIcon, BiliIcon, RssIcon } from './sourceIcons'

const ui = useUiStore()
const ready = ref(false)
const loading = ref(true)
const digesting = ref(false)
const error = ref('')
const board = ref<any>(null)
const batches = ref<any[]>([])
const tlIndex = ref<any[]>([])
const tlOpen = ref('')
const tl = ref<any>(null)
const allOpen = ref(false)
const backOpen = ref(false)
const carousel = ref(0)
/** 页签：`mine` = focus + kaoyan（与我相关） */
const TABS = ['mine', 'ai', 'tech', 'world', 'all'] as const
type Tab = (typeof TABS)[number]
const view = ref<Tab>('mine')
/** 标签筛选（点卡片上的标签胶囊进来的）；空 = 不筛 */
const tagFilter = ref('')
/** 排序：热度（有评论数的排前面）或时间（新→旧） */
const sortBy = ref<'heat' | 'time'>('heat')
/** 版式规格：wide=宽松单列、compact=紧凑双列（一行两张） */
const density = ref<'wide' | 'compact'>('wide')
let timer: any = null

/* ------------------------------------------------------------- 数据 --- */

const items = computed<any[]>(() => board.value?.items ?? [])
/** 过期条目（超过 staleDays 天且有日期，服务端已从主流程里摘出来）—— 抽屉里折叠展示 */
const oldItems = computed<any[]>(() => board.value?.oldItems ?? [])
const oldOpen = ref(false)
const staleDays = computed<number>(() => board.value?.stats?.staleDays ?? 21)
const topics = computed<any[]>(() => board.value?.topics ?? [])
const sourceMeta = computed(() => {
  const m = new Map<string, any>()
  for (const s of board.value?.sources ?? []) m.set(s.id, s)
  return m
})

async function load(force = false) {
  loading.value = true
  error.value = ''
  const [d, b, t] = await Promise.all([api.newsDashboard(force), api.newsBatches(8), api.newsTimeline()])
  const dd = d.data as any
  if (!d.ok || dd?.ok === false) {
    error.value = dd?.error ?? d.error ?? '拉不到采集结果'
    loading.value = false
    return
  }
  board.value = dd
  batches.value = (b.data as any)?.list ?? []
  tlIndex.value = (t.data as any)?.list ?? []
  loading.value = false
  watchAiBatch()
}

/* ------------------------------------------------- 等这一轮 AI 概括 --- */

/**
 * 出卡是**懒的**：打开页面时如果到点了，边车才在后台跑一轮（20–60 秒）。
 * 不盯着的话，看到的永远是上一轮的结果 —— 观感就是「资讯不更新」。
 *
 * 所以：到点 / 正在跑的时候，每 12 秒问一次那个几百字节的小状态接口，
 * 看到新批落了盘（`at` 变了且不在跑了）就整页重载一次；
 * 最多盯 5 分钟（25 次），失败就不管了 —— 页面不许因为一个后台任务转圈不停。
 */
let aiBeforeAt = 0
let aiTries = 0
const aiPoll = usePolling(async () => {
  if (++aiTries > 25) {
    aiPoll.stop()
    return
  }
  const r = await api.newsAiStatus()
  if (!r.ok) return
  const s = (r.data ?? {}) as any
  if (!s.running && Number(s.at || 0) > aiBeforeAt) {
    aiPoll.stop()
    await load(true)
  }
}, 12_000)

function watchAiBatch() {
  const st = (board.value?.ai?.status ?? {}) as any
  aiBeforeAt = Number(st.at || 0)
  aiTries = 0
  if (st.due || st.running) aiPoll.start()
  else aiPoll.stop()
}

/** 「现在概括」：立刻把这一批变成 AI 事件卡（会等它跑完） */
async function digestNow() {
  if (digesting.value) return
  digesting.value = true
  await api.newsDigest()
  await load(true)
  digesting.value = false
}

/* --------------------------------------------------------- 格式化 --- */

function ago(ms?: number | null) {
  if (!ms) return '—'
  const min = Math.round((Date.now() - Number(ms)) / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  if (min < 60 * 24) return `${Math.round(min / 60)} 小时前`
  return `${Math.round(min / 1440)} 天前`
}
/** 批次/时间点的短标签：MM-DD HH:mm（本地时区，别用 toISOString —— 它按 UTC 切） */
const clock = (ms?: number | null) => {
  if (!ms) return '—'
  const d = new Date(Number(ms))
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const tierText = (min?: number | null) => (!min ? '手动' : min >= 60 ? `${Math.round(min / 60)} 小时` : min >= 1 ? `${Math.round(min)} 分` : '每分钟')
const watchNames = (it: any) => (it.watch ?? []).map((id: string) => topics.value.find((t) => t.id === id)?.name ?? id)

/* 每个源一枚图标（图标是平台身份，来源名在 title 里） */
const SOURCE_ICON: Record<string, any> = {
  'chsi-yz': ChsiIcon,
  'x-openai': XIcon,
  /* 同一个平台的一批账号挂同一枚图标（实验室官方号 + 几位博主…） */
  'x-anthropic': XIcon,
  'x-deepmind': XIcon,
  'x-deepseek': XIcon,
  'x-qwen': XIcon,
  'x-xai': XIcon,
  'x-meta': XIcon,
  'linuxdo-top': LinuxDoIcon,
  'linuxdo-news': LinuxDoIcon,
  v2ex: V2exIcon,
  hn: HnIcon,
  'github-hot': GithubIcon,
  sspai: SspaiIcon,
  'wx-jiqizhixin': WeixinIcon,
  'wx-qbitai': WeixinIcon,
  'wx-paperweekly': WeixinIcon,
  // B 站视频渠道：整个平台挂一枚图标（键是平台名，不是某一个账号）
  bili: BiliIcon,
}
/** 先精确匹配源 id，再按平台前缀兜底（`bili-xxx` 这类「一个平台挂多个账号」的源） */
const sourceIcon = (id: string) =>
  SOURCE_ICON[id] ?? SOURCE_ICON[String(id).split('-')[0]] ?? RssIcon

/* ------------------------------------------------------------ 视图 --- */

/**
 * 分类的中文名（服务端 `news-board.mjs` 的 CAT_NAME 是同一套）。
 * 卡片上的 `cat` 用的是采集侧的分类，页签是**合并过的**（见下）。
 */
const CAT_NAME: Record<string, string> = {
  focus: '与我相关',
  kaoyan: '考研',
  ai: 'AI',
  tech: '科技',
  tools: '工具',
  world: '世界',
  other: '其他',
}

/**
 * 分类 → 页签。页签只有 5 个（`mine/ai/tech/world/all`），所以这里做一次合并：
 * 「与我相关」= focus + kaoyan（这两类在页面上从来是同一件事：跟我有关的）；
 * 工具并进科技（两者都是「工程 / 能上手」那一档）。`other` 只在「全部」里出现。
 */
function tabOf(cat: string): Tab {
  if (cat === 'focus' || cat === 'kaoyan') return 'mine'
  if (cat === 'tools') return 'tech'
  if (cat === 'ai') return 'ai'
  if (cat === 'world') return 'world'
  return 'all'
}

const BUCKET: Record<Tab, { name: string; note: string }> = {
  mine: { name: '与我相关', note: '设置里 focusKeywords 命中的条目 + 考研节点' },
  ai: { name: 'AI 圈', note: '模型 / 智能体 / 平台动向' },
  tech: { name: '科技工具', note: '工程 / 开源 / 行业' },
  world: { name: '世界', note: '宏观 / 地缘' },
  all: { name: '全部', note: '不分类' },
}
const viewNote = computed(() => BUCKET[view.value]?.note ?? '')

/** 顶部标签筛选条：只列这一批真出现过的标签，带计数 */
const TAG_ORDER = ['新产品', '教程', '薅羊毛', '工具', '论文', '政策', '招聘', '讨论']
const tagCounts = computed(() => {
  /**
   * 计数取 **cardsBeforeTag**（分类 + 时段筛完、但**不按标签筛**的那一份）。
   * 两个坑都踩过：一开始取「全部 AI 卡」（数字与眼前列表对不上，像假的）；
   * 改成 cards 之后，选中某个标签会让计数自己塌成一条（还是假的）。
   */
  const m = new Map<string, number>()
  for (const c of cardsBeforeTag.value) for (const t of c.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1)
  return TAG_ORDER.filter((t) => m.has(t)).map((t) => ({ t, n: m.get(t)! }))
})
/** 标签筛之前的那一份（只给 tagCounts 用） */
const cardsBeforeTag = computed(() => {
  const aiCards = board.value?.ai?.cards ?? []
  const list = aiCards.length ? aiCards.map((c: any) => ({ tab: tabOf(c.cat), tags: c.tags ?? [], ts: c.ts ?? null })) : []
  const byTab = (c: any) => view.value === 'all' || c.tab === view.value
  const byRange =
    range.value.min > 0 ? (c: any) => (c.ts ? Date.now() - c.ts <= range.value.min * 60_000 : false) : () => true
  return list.filter(byTab).filter(byRange)
})

/**
 * 原始条目 → 卡（没有 AI 概括时的退路：宁可用原始标题，也不能让页面空着）。
 * `cat` 保留采集侧的分类，`tab` 是页签用的合并结果。
 */
function fromItem(it: any) {
  return {
    key: 'raw:' + it.id,
    title: it.title,
    summary: it.desc || '',
    cat: it.cat,
    catName: CAT_NAME[it.cat] ?? it.catName ?? '',
    tab: tabOf(it.cat),
    mood: it.sent,
    moodScore: it.sentScore,
    sentN: it.sentN,
    sentFrom: it.sentFrom,
    hot: it.hot,
    ts: it.ts,
    weight: it.w,
    sources: [
      { id: it.sourceId, name: it.source, url: it.url, official: it.official },
      ...(it.alsoFrom ?? []).map((name: string) => ({ id: '', name, url: '', official: false })),
    ],
    watch: it.watch,
    isNew: it.isNew,
    kws: it.kws,
    ai: false,
  }
}

/**
 * 页面主体：**AI 概括卡**（`board.ai.cards`，结构见 `docs/news-contract.md` §1）。
 * 一张卡就是一个「同类事件」，sources 是它的原始出处（图标点了去原文）。
 * AI 还没概括出来时退回原始条目，并标 `ai:false` 让卡片自己说明来源。
 */
const cards = computed(() => {
  const aiCards = board.value?.ai?.cards ?? []
  const list = aiCards.length
    ? aiCards.map((c: any, i: number) => ({
        key: `ai:${i}:${c.title}`,
        title: c.title,
        summary: c.summary,
        cat: c.cat,
        catName: CAT_NAME[c.cat] ?? '',
        tab: tabOf(c.cat),
        tags: c.tags ?? [],
        tracked: !!c.tracked,
        heat: c.heat ?? null,
        /** 右栏「数据面」：关键词（词云）/ 评论情绪条 —— 服务端给了就带着，没给就是空 */
        keywords: c.keywords ?? [],
        sentiment: c.sentiment ?? null,
        mood: c.mood,
        moodScore: c.mood === 'pos' ? 1 : c.mood === 'neg' ? -1 : 0,
        sources: (c.sources ?? []).map((s: any) => ({
          id: s.id || sourceIdOf(s.source),
          name: s.source || s.title,
          url: s.url || '',
          official: !!sourceMeta.value.get(s.id)?.official,
        })),
        watch: [],
        isNew: false,
        kws: [],
        ai: true,
        ts: c.at ?? board.value?.ai?.status?.at ?? null,
      }))
    : items.value.map(fromItem)

  const byTab = (c: any) => view.value === 'all' || c.tab === view.value
  // 时间段：只看这个区间内的条目（「全部时间」= 不筛）
  const byRange =
    range.value.min > 0
      ? (c: any) => (c.ts ? Date.now() - c.ts <= range.value.min * 60_000 : false)
      : () => true
  const byTag = tagFilter.value ? (c: any) => (c.tags ?? []).includes(tagFilter.value) : () => true
  const out = list.filter(byTab).filter(byRange).filter(byTag)
  return sortBy.value === 'heat'
    ? out.slice().sort((a: any, b: any) => (b.heat?.n ?? 0) - (a.heat?.n ?? 0) || (b.ts ?? 0) - (a.ts ?? 0))
    : out.slice().sort((a: any, b: any) => (b.ts ?? 0) - (a.ts ?? 0))
})

/** AI 卡只给了来源名时，凭名字找回源 id（图标要靠它） */
function sourceIdOf(name: string) {
  for (const [id, meta] of sourceMeta.value.entries()) if (meta.name === name) return id
  for (const [id, meta] of sourceMeta.value.entries()) if (name && String(meta.name).includes(String(name).slice(0, 6))) return id
  return ''
}

/** 页签上的计数：与我相关 = focus + kaoyan */
const mineCount = computed(() => (board.value?.ai?.cards ?? []).filter((c: any) => tabOf(c.cat) === 'mine').length)

/**
 * 上一轮概括是不是挂了：失败时间**晚于**最近一次成功出批的时间才提示。
 * （只要后来成功过一次，`at` 就会跑到 `lastErrorAt` 后面，这条提示自动消失。）
 */
const aiFailed = computed(() => {
  const st = board.value?.ai?.status
  if (!st?.lastError) return false
  return Number(st.lastErrorAt || 0) > Number(st.at || 0)
})

/* ------------------------------------------------------- 反馈/采纳 --- */

async function apply(row: any, action: string) {
  await api.newsApply({ id: row.t, action })
  await load(true)
}

/* --------------------------------------------------- 时段 / 批次概要 --- */

/**
 * 时间段筛选：全部时间 / 1小时 / 3小时 / … / 7天。
 * 它同时承担原来「更早的时段」轮播的活：选了区间，下面那行就显示**落在该区间里最近一批**的 AI 概要。
 */
const RANGES: { id: string; label: string; min: number }[] = [
  { id: 'all', label: '全部时间', min: 0 },
  { id: '1h', label: '1 小时', min: 60 },
  { id: '3h', label: '3 小时', min: 180 },
  { id: '6h', label: '6 小时', min: 360 },
  { id: '12h', label: '12 小时', min: 720 },
  { id: '24h', label: '24 小时', min: 1440 },
  { id: '3d', label: '3 天', min: 4320 },
  { id: '7d', label: '7 天', min: 10080 },
]
const rangeId = ref('all')
const range = computed(() => RANGES.find((r) => r.id === rangeId.value) ?? RANGES[0])

const periods = computed<any[]>(() => board.value?.ai?.status?.periods ?? [])
// 轮播只放**更早**的批次：最新的那条已经在「AI 大总结」里了，再来一遍是重复
const olderPeriods = computed<any[]>(() => periods.value.slice(1))

/**
 * 大总结的每条里，如果提到了某张事件卡，就把那句话做成**可点跳转**（滚到那张卡）。
 * 不做额外的后端字段：用「标题里的 2 字片段出现在句子里」来判定，命中就给那条挂上卡片 key。
 */
const bulletLinks = computed<{ text: string; key: string }[]>(() => {
  const list = (board.value?.ai?.cards ?? []).map((c: any, i: number) => ({ key: `ai:${i}:${c.title}`, title: String(c.title) }))
  return summaryBullets.value.map((t) => {
    const flat = t.replace(/[\s，。、·—（）()「」]/g, '')
    // 匹配放宽：从标题里切若干 2 字片段，命中任意一个就算「这条提到了那张卡」
    // （原来按前 6 字严格匹配，实测一条都命中不了 → 跳转永远不出现）
    const hit = list.find((c: any) => {
      const clean = String(c.title).replace(/[\s，。、·—（）()「」]/g, '')
      if (clean.length < 4) return false
      for (let i = 0; i + 2 <= Math.min(clean.length, 12); i += 2) {
        if (flat.includes(clean.slice(i, i + 2))) return true
      }
      return false
    })
    return { text: t, key: hit?.key ?? '' }
  })
})
function jumpToCard(key: string) {
  const el = document.getElementById(`card-${key}`)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  el.classList.add('is-flash')
  setTimeout(() => el.classList.remove('is-flash'), 1200)
}

const rangeSummary = computed(() => {
  const list = periods.value
  if (!list.length) return ''
  // 全部时间：上面 hero 已经完整说了这段，这里再写一遍是重复（占手机 1/8 屏）
  if (range.value.min === 0) return ''
  const hit = list.find((p) => Date.now() - Number(p.at) <= range.value.min * 60_000)
  return hit?.summary || ''
})

/**
 * 大总结的正文：优先 AI 概括层这一批的 `batchSummary`；
 * 它还没有（或模型没给总览）就退回采集器自己写的简报（批次 md 里的「## 简报」）。
 * 两处都空才显示「还没生成总览」—— 信息流不能因为概括没跑成而断掉。
 */
const brief = computed(() => {
  const own = board.value?.brief
  if (own?.text) return { text: String(own.text), own: true }
  const last = batches.value.find((x: any) => x.brief)
  return last ? { text: String(last.brief), own: false } : null
})
const headline = computed(() => String(board.value?.ai?.batchSummary || brief.value?.text || ''))

/**
 * 总览拆成编号条目：一整段读起来累，拆成 1./2./3. 才扫得动。
 * 按句号/分号/换行切，视图层只封顶条数，内容长短交给模型。
 */
const summaryBullets = computed<string[]>(() => {
  const t = headline.value.trim()
  if (!t) return []
  const parts = t
    .split(/[。；;\n]+/)
    // 只剥掉模型自己写的序号（「1.」「2、」「3）」这种带标点的整枚标记）。
    // 早先这里是 /^[\s\d.、]+/，把「9 月 29 日…」开头的「9 」也一起吃了 ——
    // 2026-09-29 实测：条目 1、3 变成「月 29 日」。
    .map((x) => x.replace(/^\s*\d{1,2}\s*[.．、)）]\s*/, '').trim())
    .filter((x) => x.length >= 6)
  return parts.slice(0, 6)
})

async function openTimeline(id: string) {
  if (tlOpen.value === id) {
    tlOpen.value = ''
    return
  }
  tlOpen.value = id
  tl.value = null
  const r = await api.newsTimeline(id)
  tl.value = (r.data as any) ?? null
}

function pauseCarousel() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
function resumeCarousel() {
  pauseCarousel()
  timer = setInterval(() => {
    if (olderPeriods.value.length > 1) carousel.value = (carousel.value + 1) % olderPeriods.value.length
  }, 7000)
}
/** 点某批的胶囊：停在那一批（别刚点完又被自动轮播翻走） */
function pickPeriod(i: number) {
  carousel.value = i
  pauseCarousel()
}

onMounted(async () => {
  ready.value = await ensureSidecar()
  if (!ready.value) {
    loading.value = false
    return
  }
  await load()
  resumeCarousel()
})
onBeforeUnmount(() => pauseCarousel())
</script>

<template>
  <div class="ws-page nw">
    <PageHeader title="资讯" icon="Promotion">
      <template #desc>
        采集器把外网源抓成条目，这里概括成同类事件。每条带可点的来源图标与单事件情绪，👍/👎/备注会调教采集方向。
        <template v-if="board"> 数据 {{ ago(board.generatedAt) }}</template>
      </template>
      <template #actions>
        <el-button :loading="digesting" @click="digestNow">现在概括</el-button>
        <el-button :loading="loading" @click="load(true)">刷新</el-button>
        <el-button @click="allOpen = true">原始条目</el-button>
      </template>
    </PageHeader>

    <SidecarOffline v-if="!ready && !loading" />

    <el-empty v-else-if="error" :description="error">
      <div class="nw__hint">
        资讯页只读<b>采集器产物的目录</b>：去「设置 → 采集器目录」填上（配置项 <code>collector.dir</code>），
        再按 <code>docs/news-contract.md</code> 的契约跑一次采集器 —— 仓库里带了一个最小示例
        <code>scripts/collector-skeleton.mjs</code>，跑完这一页就有东西了。
      </div>
    </el-empty>

    <template v-else-if="board">
      <!-- ① AI 大总结（最重要的一块）：编号条目，扫一眼就懂 -->
      <section class="nw__hero">
        <header class="nw__hero-head">
          <span class="nw__hero-tag">AI 大总结</span>
          <span class="nw__hero-when">
            <template v-if="board.ai?.status?.lastCount">
              {{ board.ai.status.lastCount }} 张事件卡 · {{ ago(board.ai.status.at) }}
            </template>
            <template v-else>还没概括出来</template>
          </span>
          <span v-if="brief && !board.ai?.batchSummary" class="nw__hero-src">来自采集器简报</span>
        </header>
        <!-- 上一轮概括全挂了（上游偶发 504）就说清楚：不是没新东西，是没跑成 ——
             不说的话页面只会「保持上一批」，看起来永远像「资讯没更新」 -->
        <p v-if="aiFailed" class="nw__hero-fail">
          上一轮概括没跑成（{{ board.ai.status.lastError }}）·
          <button class="nw__hero-retry" :disabled="digesting" @click="digestNow">现在概括</button>
        </p>
        <ol v-if="bulletLinks.length" class="nw__hero-list">
          <li v-for="(b, i) in bulletLinks" :key="i" :class="{ 'is-clickable': b.key }" @click="b.key && jumpToCard(b.key)">
            {{ b.text }}
            <span v-if="b.key" class="nw__hero-jump">跳到卡片 →</span>
          </li>
        </ol>
        <p v-else class="nw__hero-text nw__dim">
          这一批还没生成总览。下面是采集到的条目，点「现在概括」就换成 AI 版。
        </p>
      </section>

      <!-- ② 时间段：选区间，下面一行是该区间的 AI 概要；③ 更早的批次轮播 -->
      <section class="nw__ranges">
        <div class="nw__range-pills">
          <button
            v-for="r in RANGES"
            :key="r.id"
            class="nw__range"
            :class="{ 'is-active': rangeId === r.id }"
            @click="rangeId = r.id"
          >
            {{ r.label }}
          </button>
        </div>
        <p v-if="rangeSummary" class="nw__range-text">{{ rangeSummary }}</p>
        <template v-if="olderPeriods.length">
          <div class="nw__range-pills nw__periods-pills">
            <span class="nw__filterlabel">更早的批次</span>
            <button
              v-for="(p, i) in olderPeriods"
              :key="p.at"
              class="nw__range"
              :class="{ 'is-active': carousel === i }"
              @click="pickPeriod(i)"
            >
              {{ clock(p.at) }}
            </button>
          </div>
          <p class="nw__range-text">{{ olderPeriods[carousel]?.summary || '（这一批没写概要）' }}</p>
        </template>
      </section>

      <!-- ④ 事件卡（页面主体） -->
      <section class="nw__main">
        <header class="nw__tabs">
          <div class="nw__tabs-row">
            <button
              v-for="k in TABS"
              :key="k"
              class="nw__tab"
              :class="{ 'is-active': view === k }"
              @click="view = k"
            >
              {{ BUCKET[k].name }}
              <em v-if="k === 'mine' && mineCount">{{ mineCount }}</em>
            </button>
            <span class="nw__tabs-note">{{ viewNote }}</span>
          </div>

          <div class="nw__filters-row">
            <span class="nw__filtergroup">
              <span class="nw__filterlabel">标签</span>
              <button class="nw__pill" :class="{ 'is-active': !tagFilter }" @click="tagFilter = ''">全部</button>
              <button
                v-for="x in tagCounts"
                :key="x.t"
                class="nw__pill"
                :class="{ 'is-active': tagFilter === x.t }"
                @click="tagFilter = tagFilter === x.t ? '' : x.t"
              >
                {{ x.t }}<em>{{ x.n }}</em>
              </button>
            </span>
            <span class="nw__filtergroup nw__filtergroup--right">
              <!-- 宽松/紧凑只在宽屏有意义（手机上两种都落成单列，切换看不出区别） -->
              <span v-if="!ui.isMobile" class="nw__seg">
                <button :class="{ 'is-active': density === 'wide' }" @click="density = 'wide'">宽松</button>
                <button :class="{ 'is-active': density === 'compact' }" @click="density = 'compact'">紧凑</button>
              </span>
              <span class="nw__seg">
                <button :class="{ 'is-active': sortBy === 'heat' }" @click="sortBy = 'heat'">热度</button>
                <button :class="{ 'is-active': sortBy === 'time' }" @click="sortBy = 'time'">时间</button>
              </span>
            </span>
          </div>
        </header>

        <div class="nw__cards" :class="{ 'nw__cards--compact': density === 'compact' }">
          <NewsCard :id="`card-${c.key}`" v-for="c in cards" :key="c.key" :card="c" @changed="load(true)" @tag="tagFilter = $event" />
          <div v-if="!cards.length" class="nw__dim nw__empty">
            这一类现在没有内容
            <!-- 默认那一栏是「与我相关」，而新一批常常全是 AI/科技 —— 不点一下别的栏，
                 会以为整页没更新。给个一步切换的出口。 -->
            <button v-if="view !== 'all'" class="nw__empty-jump" @click="view = 'all'">看全部 ›</button>
          </div>
        </div>
      </section>

      <!-- ⑤ 调教记录：用户反馈 → 采集倾向 -->
      <section v-if="board.learned?.kws?.length || board.suggestions?.length" class="nw__panel">
        <header class="nw__panel-head">
          <b>调教记录</b>
          <span class="nw__dim">👍/👎/备注正在改变采集方向</span>
        </header>
        <div class="nw__learned">
          <span v-for="x in board.learned.kws" :key="x.w" class="nw__tag" :class="x.dir === 'up' ? 'is-hit' : 'is-hot'" :title="`权重 ${x.v}`">
            {{ x.w }} <b>{{ x.v > 0 ? '+' : '' }}{{ x.v }}</b>
          </span>
        </div>
        <div v-if="board.suggestions?.length" class="nw__sugg">
          <div v-for="r in board.suggestions" :key="r.t" class="nw__sugg-row">
            <span class="nw__sugg-note">「{{ r.note }}」</span>
            <span class="nw__dim">{{ r.title?.slice(0, 24) }}</span>
            <span class="nw__sugg-actions">
              <button v-if="r.kind === 'blacklist' || r.kind === 'reduce'" class="nw__apply" @click="apply(r, 'exclude')">加入排除</button>
              <button v-if="r.kind === 'blacklist'" class="nw__apply" @click="apply(r, 'disable')">停用该源</button>
              <button v-if="r.kind === 'boost'" class="nw__apply" @click="apply(r, 'boost')">加权 +20%</button>
              <button v-if="r.kind === 'reduce'" class="nw__apply" @click="apply(r, 'reduce')">降权 −20%</button>
            </span>
          </div>
        </div>
      </section>

      <!-- ⑥ 后台（默认收起）：采集器档位 / 关注主题 -->
      <section class="nw__panel">
        <header class="nw__panel-head">
          <b>后台</b>
          <span class="nw__dim">
            {{ board.tasks?.collector?.length ?? 0 }} 个采集源 · 关注主题 {{ tlIndex.length }} 个
          </span>
          <button class="nw__linkbtn" @click="backOpen = !backOpen">{{ backOpen ? '收起' : '展开' }}</button>
        </header>
        <div v-if="backOpen" class="nw__back">
          <div class="nw__back-col">
            <div class="nw__back-head">采集器 · 每源档位</div>
            <div v-for="t in board.tasks?.collector ?? []" :key="t.id" class="nw__back-row">
              <component :is="sourceIcon(t.id)" class="nw__back-icon" />
              <span class="nw__back-name" :title="t.note">{{ t.name }}</span>
              <span class="nw__back-when">{{ tierText(t.everyMinutes) }}</span>
              <span class="nw__time">{{ ago(Date.parse(t.lastRunAt)) }}</span>
            </div>
            <div v-if="!(board.tasks?.collector ?? []).length" class="nw__dim">采集器还没报上档位（source.json 里没有启用的源）</div>
          </div>
          <div class="nw__back-col">
            <div class="nw__back-head">关注主题</div>
            <div v-for="t in tlIndex" :key="t.id" class="nw__back-row nw__back-row--click" @click="openTimeline(t.id)">
              <span class="nw__back-name">{{ t.name }}</span>
              <span class="nw__back-when">{{ t.count }}</span>
              <span class="nw__time">{{ tlOpen === t.id ? '收起' : '展开' }}</span>
            </div>
            <div v-if="!tlIndex.length" class="nw__dim">还没配关注主题（采集器的 watch.json）</div>
            <ul v-if="tlOpen" class="nw__tl-body">
              <li v-for="(e, i) in tl?.entries ?? []" :key="i">
                <span class="nw__time">{{ e.at.slice(5, 16) }}</span>
                <a :href="e.url" target="_blank" rel="noreferrer">{{ e.title }}</a>
              </li>
            </ul>
          </div>
        </div>
      </section>
    </template>

    <!-- 原始条目（抽屉）：只用来回指与对账，不是页面主体 -->
    <el-drawer v-model="allOpen" title="原始条目" size="70%">
      <div class="nw__rawhead">
        这批采集到 {{ items.length }} 条原始条目。页面主体是上面那些 AI 概括卡，这里只用来核对出处。
      </div>
      <!-- 过期条目：服务端只按「有日期且超过 N 天」摘出来，折叠着放，别混在上面冒充今天的消息 -->
      <div v-if="oldItems.length" class="nw__rawhead nw__rawhead--old">
        <button class="nw__oldbtn" @click="oldOpen = !oldOpen">
          {{ oldOpen ? '收起' : '展开' }} {{ oldItems.length }} 条过期条目（超过 {{ staleDays }} 天，仅备查）
        </button>
      </div>
      <div v-for="it in oldOpen ? oldItems : []" :key="'old-' + it.id" class="nw__raw is-old">
        <component :is="sourceIcon(it.sourceId)" class="nw__raw-icon" />
        <a class="nw__raw-title" :href="it.url" target="_blank" rel="noreferrer">{{ it.title }}</a>
        <span class="nw__tag is-plain">{{ it.source }}</span>
        <span class="nw__time">{{ ago(it.ts) }}</span>
      </div>
      <div v-for="it in items" :key="it.id" class="nw__raw">
        <component :is="sourceIcon(it.sourceId)" class="nw__raw-icon" />
        <a class="nw__raw-title" :href="it.url" target="_blank" rel="noreferrer">{{ it.title }}</a>
        <span class="nw__tag is-plain">{{ it.source }}</span>
        <span v-for="w in watchNames(it)" :key="w" class="nw__tag is-hit">{{ w }}</span>
        <span class="nw__time">{{ ago(it.ts) }}</span>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.nw {
  display: flex;
  flex-direction: column;
  gap: var(--ws-space-4);
}

/* ① AI 大总结 —— 页面最重要的一块：浅靛底 + 左侧粗边 + 编号条目 */
.nw__hero {
  position: relative;
  background: linear-gradient(180deg, var(--ws-accent-soft), var(--ws-panel) 70%);
  border: 1px solid var(--ws-border);
  border-radius: var(--ws-radius-lg);
  padding: var(--ws-space-4) var(--ws-space-5);
  box-shadow: var(--ws-shadow-1);
}
.nw__hero::before {
  content: '';
  position: absolute;
  left: 0;
  top: 14px;
  bottom: 14px;
  width: 4px;
  border-radius: 4px;
  background: var(--ws-accent);
}
.nw__hero-head {
  display: flex;
  align-items: center;
  gap: var(--ws-space-3);
  margin-bottom: var(--ws-space-3);
  flex-wrap: wrap;
}
.nw__hero-tag {
  font-size: var(--ws-fs-sm);
  font-weight: 700;
  color: var(--ws-on-accent);
  background: var(--ws-accent);
  border-radius: var(--ws-radius-pill);
  padding: 2px 12px;
}
.nw__hero-when {
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-3);
}
/* 总览的来源标一下（这条是采集器写的，不是模型写的） */
.nw__hero-src {
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-3);
  border: 1px solid var(--ws-border);
  border-radius: var(--ws-radius-pill);
  padding: 0 8px;
}
/* 「上一轮没跑成」那行提示：低调的红，别抢 AI 大总结的注意力 */
.nw__hero-fail {
  margin: 6px 0 0;
  font-size: var(--ws-fs-xs);
  color: var(--ws-danger, #c0392b);
}
.nw__hero-retry {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  color: var(--ws-accent, #3b6ef5);
  cursor: pointer;
  text-decoration: underline;
}
.nw__hero-retry:disabled {
  opacity: 0.5;
  cursor: default;
}
.nw__hero-list {
  margin: 0;
  padding-left: 1.5em;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.nw__hero-list li {
  font-size: var(--ws-fs-md);
  line-height: 1.7;
  color: var(--ws-text);
  text-wrap: pretty;
}
.nw__hero-list li::marker {
  color: var(--ws-accent);
  font-weight: 700;
}
.nw__hero-list li.is-clickable {
  cursor: pointer;
}
.nw__hero-list li.is-clickable:hover {
  color: var(--ws-accent);
}
.nw__hero-jump {
  font-size: var(--ws-fs-xs);
  color: var(--ws-accent);
  margin-left: 6px;
  white-space: nowrap;
}
/* 跳过去的那张卡闪一下，让人知道「就是这张」 */
:deep(.is-flash) {
  box-shadow: 0 0 0 2px var(--ws-accent), var(--ws-shadow-2);
}

.nw__hero-text {
  max-width: 52em;
  margin: 0;
  text-wrap: pretty;
  font-size: var(--ws-fs-md);
  line-height: 1.75;
  color: var(--ws-text);
  white-space: pre-wrap;
}

/* ② 时间段胶囊条：选中=实心靛，其余=浅底无边框 */
.nw__ranges {
  background: var(--ws-panel);
  border: 1px solid var(--ws-border);
  border-radius: var(--ws-radius);
  padding: 10px var(--ws-space-4) 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.nw__range-pills {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
}
/* 更早的批次那一排：与时间段同一套控件，中间隔一条线，免得看成一排 */
.nw__periods-pills {
  border-top: 1px solid var(--ws-border);
  padding-top: 8px;
}
.nw__range {
  border: 0;
  background: var(--ws-panel-2);
  color: var(--ws-text-2);
  border-radius: var(--ws-radius-pill);
  padding: 5px 16px;
  font-size: var(--ws-fs-base);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.nw__range:hover {
  color: var(--ws-accent);
}
:global(html[data-theme='dark']) .nw__hero-tag,
:global(html[data-theme='dark']) .nw__range.is-active {
  background: var(--ws-accent-deep);
}
.nw__range.is-active {
  background: var(--ws-accent);
  color: var(--ws-on-accent);
  font-weight: 600;
  box-shadow: 0 1px 6px var(--ws-accent-ring);
}
.nw__range-text {
  margin: 0;
  font-size: var(--ws-fs-sm);
  color: var(--ws-text-2);
  line-height: 1.65;
}

/* ④ 事件卡主体 */
.nw__main {
  display: flex;
  flex-direction: column;
  gap: var(--ws-space-2);
}
.nw__tabs {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-bottom: 1px solid var(--ws-border);
}
.nw__tabs-row {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
/* 分类 tab：下划线式（一行只有一个「选中」） */
.nw__tab {
  border: 0;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--ws-text-2);
  padding: 5px 12px;
  font-size: var(--ws-fs-base);
  cursor: pointer;
  border-radius: 0;
  margin-bottom: -1px;
}
.nw__tab em {
  font-style: normal;
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-3);
  margin-left: 5px;
}
.nw__tab:hover {
  color: var(--ws-accent);
}
.nw__tab.is-active {
  color: var(--ws-accent-deep);
  border-bottom-color: var(--ws-accent);
  font-weight: 700;
}
.nw__tab.is-active em {
  color: var(--ws-accent);
}
.nw__tabs-note {
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-2);
  margin-left: var(--ws-space-2);
}
/* 第二层：筛选。**统一成一种控件**（细边药丸，选中浅靛底）——
   之前标签/版式/排序各是一种样子，挤在一行里就显乱。 */
.nw__filters-row {
  display: flex;
  align-items: center;
  gap: var(--ws-space-4);
  flex-wrap: wrap;
}
.nw__filtergroup {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  min-width: 0;
}
.nw__filtergroup--right {
  margin-left: auto;
}
.nw__filterlabel {
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-2);
  margin-right: 2px;
  flex: none;
  white-space: nowrap;
}
.nw__pill {
  border: 1px solid var(--ws-border);
  background: transparent;
  color: var(--ws-text-2);
  border-radius: var(--ws-radius-pill);
  padding: 2px 11px;
  font-size: var(--ws-fs-xs);
  cursor: pointer;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
  /* 手机上别把胶囊压成竖排蛋形（窄屏下 flex 会把子项压到内容宽度以下） */
  flex: none;
  white-space: nowrap;
}
@media (max-width: 760px) {
  .nw__pill {
    min-height: 28px;
  }
  /* 密度/热度那排分段按钮 22px 高（手机门禁 2026-09-29）；按钮文字不折行 */
  .nw__seg button {
    min-height: 30px;
    white-space: nowrap;
  }
  /* 文章脚上的标签（政策/招生这类）只有 22px 高 */
  .nc__tagsec > * {
    min-height: 28px;
  }
  /* 建议行的动作（「加权 +20%」这类）只有 20px 高 */
  .nw__sugg-actions button,
  .nw__sugg-actions .el-button {
    min-height: 28px;
  }
}
.nw__pill em {
  font-style: normal;
  color: var(--ws-text-3);
  margin-left: 4px;
}
.nw__pill:hover {
  border-color: var(--ws-accent);
  color: var(--ws-accent);
}
/* 选中不再用实心靛：一屏五个实心块等于没有「选中」，
   改成浅靛底 + 深靛字；全页只留「AI 大总结」徽章与时间段那几颗实心。 */
.nw__pill.is-active {
  background: var(--ws-accent-soft);
  border-color: var(--ws-accent);
  color: var(--ws-accent-deep);
  font-weight: 600;
}
.nw__pill.is-active em {
  color: var(--ws-accent);
}
/* 版式 / 排序：一个轨道两个选项（分段控件），比两个独立胶囊安静 */
.nw__seg {
  display: inline-flex;
  border: 1px solid var(--ws-border);
  border-radius: var(--ws-radius-pill);
  overflow: hidden;
}
.nw__seg button {
  border: 0;
  background: transparent;
  color: var(--ws-text-2);
  font-size: var(--ws-fs-xs);
  padding: 3px 12px;
  cursor: pointer;
}
.nw__seg button + button {
  border-left: 1px solid var(--ws-border);
}
.nw__seg button.is-active {
  background: var(--ws-accent-soft);
  color: var(--ws-accent-deep);
  font-weight: 600;
}
.nw__cards {
  display: grid;
  gap: var(--ws-space-3);
}
/*
 * 紧凑 = **一行两张**（原来 minmax(340px) 在宽屏会挤成 4 列，
 * 每张只剩 280px，摘要一行十个字、右栏还把卡片压扁 —— 2026-09-28 实测）。
 * 窄屏自动回落成一列。
 */
.nw__cards--compact {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
@media (max-width: 900px) {
  .nw__cards--compact {
    grid-template-columns: 1fr;
  }
}
/* 紧凑档下右栏不再占一列：降级成卡片底部一条细数据带（情绪条 + 热度），
   关键词那行留白给正文；这样两张并排时正文宽度够读。 */
.nw__cards--compact :deep(.nc__body) {
  flex-direction: column;
  gap: 8px;
}
.nw__cards--compact :deep(.nc__side) {
  flex: 1 1 auto;
  width: 100%;
  border-left: 0;
  border-top: 1px solid var(--ws-border);
  padding: 8px 0 0;
  flex-direction: row;
  flex-wrap: wrap;
  gap: 4px 14px;
}
.nw__cards--compact :deep(.nc__side-row--cloud) {
  display: none;
}
.nw__cards--compact :deep(.nc__side-label) {
  flex: 0 0 auto;
}
/* 折叠/清除/链接按钮：统一细描边胶囊 */
.nw__collapse,
.nw__clear,
.nw__linkbtn {
  margin-left: auto;
  border: 1px solid var(--ws-border);
  background: var(--ws-panel);
  color: var(--ws-text-2);
  border-radius: var(--ws-radius-pill);
  padding: 2px 12px;
  font-size: var(--ws-fs-xs);
  line-height: 1.7;
  cursor: pointer;
}
.nw__collapse:hover,
.nw__clear:hover,
.nw__linkbtn:hover {
  border-color: var(--ws-accent);
  color: var(--ws-accent);
}
.nw__filter-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--ws-accent);
  background: var(--ws-accent-soft);
  color: var(--ws-accent-deep);
  border-radius: var(--ws-radius-pill);
  padding: 1px 4px 1px 10px;
  font-size: var(--ws-fs-xs);
  cursor: pointer;
}
.nw__search {
  border: 1px solid var(--ws-border-strong);
  border-radius: var(--ws-radius-pill);
  padding: 3px 10px;
  font-size: var(--ws-fs-sm);
  background: var(--ws-panel);
  color: var(--ws-text);
}
.nw__density {
  display: inline-flex;
  gap: 2px;
  border-left: 1px solid var(--ws-border);
  padding-left: var(--ws-space-2);
}
.nw__density button {
  border: 0;
  background: none;
  color: var(--ws-text-3);
  font-size: var(--ws-fs-xs);
  padding: 3px 8px;
  border-radius: var(--ws-radius-sm);
  cursor: pointer;
}
.nw__density button.is-active {
  color: var(--ws-accent);
  background: var(--ws-accent-soft);
}
.nw__empty {
  padding: var(--ws-space-6) 0;
  text-align: center;
}
/* 空态里的「看全部 ›」：跟着正文的灰，不要做成大按钮抢走这一块的注意力 */
.nw__empty-jump {
  margin-left: 8px;
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  color: var(--ws-accent, #3b6ef5);
  cursor: pointer;
}
.nw__empty-jump:hover {
  text-decoration: underline;
}

/* 通用面板（调教记录 / 后台） */
.nw__panel {
  background: var(--ws-panel);
  border: 1px solid var(--ws-border);
  border-radius: var(--ws-radius);
  box-shadow: var(--ws-shadow-1);
  padding: var(--ws-space-3) var(--ws-space-4);
}
.nw__panel-head {
  display: flex;
  align-items: center;
  gap: var(--ws-space-2);
  flex-wrap: wrap;
}
.nw__panel-head b {
  font-size: var(--ws-fs-md);
  color: var(--ws-text);
}
.nw__dim {
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-2);
}
.nw__hint {
  font-size: var(--ws-fs-sm);
  color: var(--ws-text-2);
}
.nw__time {
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-3);
  white-space: nowrap;
}

/* 调教记录 */
.nw__learned {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: var(--ws-space-2);
}
.nw__tag {
  font-size: var(--ws-fs-xs);
  padding: 1px 7px;
  border-radius: var(--ws-radius-sm);
  border: 1px solid var(--ws-border);
  color: var(--ws-text-2);
  white-space: nowrap;
}
.nw__tag b {
  margin-left: 3px;
}
.nw__tag.is-hit {
  border-color: var(--ws-info);
  color: var(--ws-info);
  background: var(--ws-info-soft);
}
.nw__tag.is-hot {
  border-color: var(--ws-warn);
  color: var(--ws-warn);
  background: var(--ws-warn-soft);
}
.nw__tag.is-plain {
  color: var(--ws-text-3);
}
.nw__sugg {
  margin-top: var(--ws-space-2);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.nw__sugg-row {
  display: flex;
  align-items: center;
  gap: var(--ws-space-2);
  flex-wrap: wrap;
  font-size: var(--ws-fs-sm);
  border-top: 1px solid var(--ws-border);
  padding-top: 4px;
}
.nw__sugg-note {
  color: var(--ws-text);
}
.nw__sugg-actions {
  margin-left: auto;
  display: inline-flex;
  gap: 4px;
}
.nw__apply {
  border: 1px solid var(--ws-accent);
  background: var(--ws-accent-soft);
  color: var(--ws-accent-deep);
  border-radius: var(--ws-radius-pill);
  padding: 1px 10px;
  font-size: var(--ws-fs-xs);
  cursor: pointer;
}
.nw__apply:hover {
  background: var(--ws-accent);
  color: var(--ws-on-accent);
}

/* ⑤ 后台 */
.nw__back {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: var(--ws-space-4);
  margin-top: var(--ws-space-3);
}
.nw__back-head {
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-3);
  margin-bottom: 4px;
}
.nw__back-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
  font-size: var(--ws-fs-sm);
  border-bottom: 1px solid var(--ws-border);
}
.nw__back-row:last-child {
  border-bottom: 0;
}
.nw__back-row--click {
  cursor: pointer;
}
.nw__back-icon {
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
}
.nw__back-name {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--ws-text);
  overflow-wrap: anywhere;
}
.nw__back-when {
  font-size: var(--ws-fs-xs);
  color: var(--ws-accent);
  white-space: nowrap;
}
.nw__tl-body {
  list-style: none;
  margin: 4px 0 0;
  padding: 0 0 0 12px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 180px;
  overflow-y: auto;
}
.nw__tl-body li {
  display: flex;
  gap: 6px;
  align-items: baseline;
  font-size: var(--ws-fs-xs);
}
.nw__tl-body a {
  color: var(--ws-text-2);
  text-decoration: none;
}
.nw__tl-body a:hover {
  color: var(--ws-accent);
}

/* 抽屉里的原始条目 */
.nw__rawhead {
  font-size: var(--ws-fs-sm);
  color: var(--ws-text-2);
  margin-bottom: var(--ws-space-3);
}
/* 过期条目那一行：只有一颗描边小按钮，别抢主列表的注意力 */
.nw__rawhead--old {
  margin-bottom: var(--ws-space-2);
}
.nw__oldbtn {
  background: none;
  border: 1px solid var(--ws-border);
  border-radius: 999px;
  padding: 2px 10px;
  font-size: var(--ws-fs-sm);
  color: var(--ws-text-2);
  cursor: pointer;
}
.nw__oldbtn:hover {
  color: var(--ws-accent);
  border-color: var(--ws-accent);
}
/* 过期条目本体：压暗一档，一眼看出不是今天的 */
.nw__raw.is-old {
  opacity: 0.62;
}
.nw__raw {
  display: flex;
  align-items: center;
  gap: var(--ws-space-2);
  padding: 4px 6px;
  border-bottom: 1px solid var(--ws-border);
  flex-wrap: wrap;
}
.nw__raw-icon {
  width: 15px;
  height: 15px;
  flex: 0 0 15px;
}
.nw__raw-title {
  flex: 1 1 320px;
  color: var(--ws-text);
  font-size: var(--ws-fs-base);
  text-decoration: none;
}
.nw__raw-title:hover {
  color: var(--ws-accent);
}
</style>
