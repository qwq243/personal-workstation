<script setup lang="ts">
/**
 * 语音随记 · 记录（`#/memo/records`）。
 *
 * 左列表右详情。列表上三个筛选器（搜索框 / 分类 / 标签）都是**客户端**筛：
 * `GET /api/memo/records` 一次给最近 50 条的摘要版，够翻的了；要翻更早的得改 limit，
 * 不值得为此加一个服务端搜索接口（记录里没有正文索引，搜全文也会漏）。
 *
 * 详情里那几块（摘要 / 各栏目 / 分段详析 / 转写原文）全部来自边车 `memo.markdown()` 的同一份数据，
 * 页面不自己拼 —— 落盘的 records/*.md 与「导出 MD」都是它。
 */
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PageHeader from '@/components/PageHeader.vue'
import SidecarOffline from '@/components/SidecarOffline.vue'
import EmptyState from '@/components/EmptyState.vue'
import MdLite from '@/components/MdLite.vue'
import MemoAudioPlayer from './MemoAudioPlayer.vue'
import { api, ensureSidecar, memoSummarizeStream } from '@/core/sidecar'
import { copyText } from '@/core/clipboard'
import AiThoughts from '@/ai/AiThoughts.vue'
import { adaptMemoEvent, applyEvent } from '@/ai/adapt'
import { makeMessage, type AiMessage } from '@/ai/model'

const route = useRoute()
const router = useRouter()
const ready = ref(false)
const loading = ref(true)
const error = ref('')

const records = ref<any[]>([])
const current = ref<any>(null)
const titleDraft = ref('')
const exporting = ref(false)

/* 列表筛选（都在客户端做，见文件头） */
const keyword = ref('')
const filterCategory = ref('')
const filterTag = ref('')

/* 播放器 */
const player = ref<any>(null)
const audioUrl = ref('')

const detailBox = ref<HTMLElement | null>(null)
const detailStuck = ref(false)
function onDetailScroll() {
  detailStuck.value = (detailBox.value?.scrollTop ?? 0) > 4
}

/* 成稿过程 */
const streaming = ref(false)
/**
 * 正在成稿的那条消息。正文 / 推理 / 分块进度全部装在这一个对象里，由 `applyEvent`（共享 reducer）填 ——
 * 与知识库问答、测聊是同一套，别在这儿再写一遍 switch。
 */
const streamMsg = ref<AiMessage | null>(null)
let summaryAbort: AbortController | null = null

/* 标签 / 分类 / 重点 */
const tagsDraft = ref<string[]>([])
const tagsSaving = ref(false)
const focusDraft = ref('')
const focusSaving = ref(false)
const hotCategories = ref<any[]>([])
const hotTermHints = ref<string[]>([])
const tagsToHotBusy = ref(false)

function clock(seconds: number | undefined) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function fmtStamp(ms: number | undefined) {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function humanDuration(seconds: number | undefined | null) {
  if (!seconds) return '' // 读不出时长（非 WAV）就不显示，别写「0 秒」
  const total = Math.max(0, Math.round(Number(seconds)))
  if (total < 60) return `${total} 秒`
  const m = Math.floor(total / 60)
  const s = total % 60
  return s ? `${m} 分 ${s} 秒` : `${m} 分钟`
}

function mb(bytes: number | undefined) {
  return `${Math.round((Number(bytes ?? 0) / 1024 / 1024) * 10) / 10} MB`
}

const modelLabel = computed(() => current.value?.model ?? '')
const hasAudio = computed(() => Boolean(current.value?.audio && audioUrl.value))

/** 列表里出现过的分类 / 标签：筛选项从数据里长出来，不另配一份清单 */
const categoryOptions = computed(() => [...new Set(records.value.map((r) => r.categoryName).filter(Boolean))])
const tagOptions = computed(() => [...new Set(records.value.flatMap((r) => r.tags ?? []))])

const filtered = computed(() => {
  const q = keyword.value.trim().toLowerCase()
  return records.value.filter((r) => {
    if (filterCategory.value && r.categoryName !== filterCategory.value) return false
    if (filterTag.value && !(r.tags ?? []).includes(filterTag.value)) return false
    if (!q) return true
    return [r.title, r.summary, r.categoryName, ...(r.tags ?? [])]
      .filter(Boolean)
      .some((v: string) => String(v).toLowerCase().includes(q))
  })
})

/** 成稿进行到哪一步：从消息本身推导，不再单开一个 ref（两个来源必然对不齐） */
const streamPhaseText = computed(() => {
  const m = streamMsg.value
  if (!m) return '准备中'
  if (m.error) return '出错了，稍后会用非流式重试'
  if (m.content) return '正在写'
  return '正在读原文、思考'
})

function clearFilters() {
  keyword.value = ''
  filterCategory.value = ''
  filterTag.value = ''
}

/* ------------------------------------------------------------------ 加载 --- */

async function loadRecords() {
  const r = await api.memoRecords(50)
  const d = r.data as any
  if (r.ok && d?.ok) records.value = d.records ?? []
}

async function loadHotwords() {
  const r = await api.memoHotwords()
  const d = r.data as any
  if (!r.ok || d?.ok === false) return
  hotCategories.value = d.categories ?? []
  const terms: string[] = []
  for (const cat of hotCategories.value) for (const t of cat.terms ?? []) if (t.term) terms.push(t.term)
  hotTermHints.value = [...new Set(terms)].slice(0, 300)
}

async function open(id: string) {
  const r = await api.memoRecord(id)
  const d = r.data as any
  if (!r.ok || !d?.ok) return
  current.value = d.record
  titleDraft.value = d.record.title ?? ''
  tagsDraft.value = [...(d.record.tags ?? [])]
  focusDraft.value = d.record.focus ?? ''
  audioUrl.value = d.record.audio ? await api.memoAudioUrl(id) : ''
  if (detailBox.value) detailBox.value.scrollTop = 0
  detailStuck.value = false
  // id 写进地址栏：刷新 / 从转写页跳过来都还能停在同一条
  if (route.query.id !== id) router.replace({ path: '/memo/records', query: { id } })
}

async function load() {
  loading.value = true
  error.value = ''
  const ok = await ensureSidecar()
  ready.value = ok
  if (ok) {
    await Promise.all([loadRecords(), loadHotwords()])
    const wanted = String(route.query.id ?? '')
    const target = wanted && records.value.some((x) => x.id === wanted) ? wanted : records.value[0]?.id
    if (target) await open(target)
    // 刚转完的那条：后端可能还在写摘要，等一拍再读一次
    if (target && !current.value?.summary) setTimeout(() => void open(target), 1500)
  }
  loading.value = false
}

/* ------------------------------------------------------------ 详情：标题 --- */

async function saveTitle() {
  if (!current.value) return
  const title = titleDraft.value.trim()
  if (!title || title === current.value.title) return
  const r = await api.memoRename(current.value.id, title)
  const d = r.data as any
  if (!r.ok || d?.ok === false) {
    ElMessage.error(d?.error ?? r.error ?? '改标题失败')
    return
  }
  current.value.title = title
  const item = records.value.find((x) => x.id === current.value.id)
  if (item) item.title = title
}

/* ------------------------------------------------------------ 重新总结 --- */

async function resummarize() {
  if (!current.value) return
  await streamSummary(current.value.id)
}

async function streamSummary(id: string) {
  streaming.value = true
  const msg = makeMessage({ role: 'assistant', model: current.value?.model ?? '' })
  streamMsg.value = msg
  summaryAbort?.abort()
  summaryAbort = new AbortController()
  let failed = ''

  await memoSummarizeStream(
    id,
    (e) => {
      for (const ev of adaptMemoEvent(e)) {
        // 学出新热词是页面私事（提示 + 重载词库），走 side 通道，不进消息模型
        if (ev.kind === 'side' && ev.name === 'learned') {
          const p = ev.payload as { categoryName?: string; terms?: { term: string }[] } | undefined
          const terms = (p?.terms ?? []).map((t) => t.term).filter(Boolean)
          if (terms.length) {
            ElMessage.success(`自动学热词：${terms.join('、')} → 「${p?.categoryName || '未分类'}」`)
            void loadHotwords()
          }
          continue
        }
        if (ev.kind === 'error') failed = ev.error
        applyEvent(msg, ev)
        // 长稿的推理能滚出几万字：只留末 4000 字，不然手机端光字符串就是几 MB
        if (msg.reasoning && msg.reasoning.length > 4000) msg.reasoning = msg.reasoning.slice(-4000)
      }
    },
    summaryAbort.signal,
    current.value?.model ?? '',
  )
  streaming.value = false

  // 不管流式成不成，都回读一次记录（done 帧丢了 / 后端其实写好了都会走到这儿）
  await open(id)
  await loadRecords()
  if (current.value?.summary) {
    streamMsg.value = null
    return
  }
  if (failed) {
    ElMessage.warning(`流式成稿没成功（${failed}），改用非流式重试`)
    const r = await api.memoSummarize(id, '')
    const d = r.data as any
    if (!r.ok || d?.ok === false) ElMessage.error(d?.error ?? r.error ?? '重试也失败了')
    await open(id)
    await loadRecords()
  }
  if (!current.value?.summary) ElMessage.warning('这次没写出正文：可以换个模型或把提示词放宽一点再试')
  streamMsg.value = null
}

/* ------------------------------------------------------------ 导出 / 删除 --- */

async function fetchDoc(rec: any): Promise<{ filename: string; content: string } | null> {
  const r = await api.memoExport(rec.id)
  const d = r.data as any
  if (!r.ok || d?.ok === false) {
    ElMessage.error(d?.error ?? r.error ?? '读不到 Markdown 文档')
    return null
  }
  return { filename: d.filename ?? `${rec.title || 'memo'}.md`, content: String(d.content ?? '') }
}

async function copyDoc() {
  if (!current.value) return
  const doc = await fetchDoc(current.value)
  if (doc) await copyText(doc.content, '已复制 Markdown')
}

async function exportDoc() {
  if (!current.value || exporting.value) return
  exporting.value = true
  const doc = await fetchDoc(current.value)
  exporting.value = false
  if (!doc) return
  const url = URL.createObjectURL(new Blob([doc.content], { type: 'text/markdown;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = doc.filename
  a.click()
  URL.revokeObjectURL(url)
  ElMessage.success(`已导出 ${doc.filename}`)
}

async function removeOne() {
  if (!current.value) return
  const hasRec = Boolean(current.value.audio)
  try {
    await ElMessageBox.confirm(
      `删掉「${current.value.title}」？转写、摘要${hasRec ? '和原始录音' : ''}都会一起删。`,
      '删除记录',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  const r = await api.memoDelete(current.value.id)
  const d = r.data as any
  if (!r.ok || d?.ok === false) {
    ElMessage.error(d?.error ?? r.error ?? '删除失败')
    return
  }
  current.value = null
  audioUrl.value = ''
  await loadRecords()
  if (records.value.length) await open(records.value[0].id)
}

/** 只删音频、留记录：转写与整理稿是「材料」，音频是「原始证据」，两件事分开删 */
async function removeAudioOnly() {
  if (!current.value?.audio) return
  try {
    await ElMessageBox.confirm('只删这一条的原始录音？转写与整理稿都留着。', '删录音', {
      type: 'warning',
      confirmButtonText: '删录音',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  const r = await api.memoAudioRemove(current.value.id)
  const d = r.data as any
  if (!r.ok || d?.ok === false) {
    ElMessage.error(d?.error ?? r.error ?? '删不掉')
    return
  }
  current.value.audio = null
  audioUrl.value = ''
  ElMessage.success('录音已删（记录还在）')
}

/* --------------------------------------------------- 标签 / 分类 / 重点 --- */

async function saveTags() {
  if (!current.value) return
  tagsSaving.value = true
  const r = await api.memoTags(current.value.id, tagsDraft.value, false)
  tagsSaving.value = false
  const d = r.data as any
  if (!r.ok || d?.ok === false) {
    ElMessage.error(d?.error ?? r.error ?? '标签没存上')
    return
  }
  if (d.record) {
    current.value = { ...current.value, tags: d.record.tags }
    const item = records.value.find((x) => x.id === current.value.id)
    if (item) item.tags = d.record.tags
  }
}

async function tagsToHotwords() {
  if (!current.value || !tagsDraft.value.length) {
    ElMessage.warning('这条还没有标签')
    return
  }
  tagsToHotBusy.value = true
  const r = await api.memoTags(current.value.id, tagsDraft.value, true)
  tagsToHotBusy.value = false
  const d = r.data as any
  if (!r.ok || d?.ok === false) {
    ElMessage.error(d?.error ?? r.error ?? '收不进去')
    return
  }
  await loadHotwords()
  const learned = d.learned
  ElMessage.success(
    learned
      ? `已收进「${learned.categoryName || '未分类'}」：新增 ${learned.added} 个（已有的并进别名 ${learned.merged ?? 0}）`
      : '已经都在词库里了',
  )
}

async function changeRecordCategory(name: string) {
  if (!current.value) return
  const r = await api.memoCategory(current.value.id, name)
  const d = r.data as any
  if (!r.ok || d?.ok === false) {
    ElMessage.error(d?.error ?? r.error ?? '换分类失败')
    return
  }
  if (d.record) {
    current.value = { ...current.value, categoryId: d.categoryId, categoryName: d.categoryName, hotwords: d.record.hotwords }
    const item = records.value.find((x) => x.id === current.value.id)
    if (item) {
      item.categoryName = d.categoryName
      item.hotwords = d.record.hotwords
    }
  }
  await loadHotwords()
  ElMessage.success(name ? `分类改成「${d.categoryName}」` : '已清掉分类')
}

async function saveFocus() {
  if (!current.value) return
  const text = focusDraft.value.trim()
  if (text === String(current.value.focus ?? '').trim()) return
  focusSaving.value = true
  const r = await api.memoFocus(current.value.id, text)
  focusSaving.value = false
  const d = r.data as any
  if (!r.ok || d?.ok === false) {
    ElMessage.error(d?.error ?? r.error ?? '没存上')
    return
  }
  current.value = { ...current.value, focus: text }
  ElMessage.success(text ? '已记下：重新总结会按它做对照' : '已清掉')
}

async function learnFromRecord() {
  if (!current.value) return
  const r = await api.memoExtractHotwords(current.value.id)
  const d = r.data as any
  if (!r.ok || d?.ok === false) {
    ElMessage.error(d?.error ?? r.error ?? '学不了')
    return
  }
  await loadHotwords()
  await open(current.value.id)
  const added = d.learned?.added ?? []
  ElMessage.success(
    added.length
      ? `学到 ${added.length} 个新词（${d.learned?.categoryName || '未分类'}）：${added.map((t: any) => t.term).join('、')}`
      : '没有新词可学（都已收过）',
  )
}

onMounted(load)
onUnmounted(() => summaryAbort?.abort())
</script>

<template>
  <div class="ws-page memo">
    <PageHeader title="语音随记 · 记录" subtitle="整理稿、原始音频、标签与分类都在这儿改。" icon="Notebook">
      <template #actions>
        <el-button size="small" @click="router.push('/memo')">
          <el-icon><Microphone /></el-icon>&nbsp;去转写
        </el-button>
        <el-button size="small" @click="router.push('/memo/settings')">
          <el-icon><Setting /></el-icon>&nbsp;配置
        </el-button>
      </template>
    </PageHeader>

    <SidecarOffline v-if="!loading && !ready" what="语音随记" @ready="load" />
    <template v-else>
      <section v-if="!records.length" class="ws-card onboard">
        <EmptyState title="还没有记录" description="去「转写」传一段音频，转完就会有一条记录。" icon="Microphone" />
      </section>

      <section v-else class="workspace">
        <aside class="ws-card list">
          <header class="panel__head">
            <span class="panel__title"><i class="dot" />记录</span>
            <span class="pill">{{ filtered.length }} / {{ records.length }}</span>
          </header>

          <div class="filters">
            <el-input v-model="keyword" size="small" clearable placeholder="搜标题 / 摘要 / 标签">
              <template #prefix><el-icon><Search /></el-icon></template>
            </el-input>
            <div class="filters__row">
              <el-select v-model="filterCategory" size="small" clearable placeholder="按分类">
                <el-option v-for="c in categoryOptions" :key="c" :value="c" :label="c" />
              </el-select>
              <el-select v-model="filterTag" size="small" clearable placeholder="按标签">
                <el-option v-for="t in tagOptions" :key="t" :value="t" :label="t" />
              </el-select>
            </div>
          </div>

          <p v-if="!filtered.length" class="ws-muted" style="font-size: 12px; padding: 6px 0">
            没有命中：
            <el-button link size="small" @click="clearFilters">清掉筛选</el-button>
          </p>

          <ul class="list__ul">
            <li
              v-for="r in filtered"
              :key="r.id"
              class="item"
              :class="{ 'is-active': r.id === current?.id }"
              @click="open(r.id)"
            >
              <div class="item__title">{{ r.title || '（还没起标题）' }}</div>
              <div class="item__meta">
                <span>{{ fmtStamp(r.startedAt) }}</span>
                <span v-if="humanDuration(r.durationSec)">{{ humanDuration(r.durationSec) }}</span>
                <span>{{ r.chars }} 字</span>
                <span v-if="r.audio" class="item__rec" title="有原始音频">♪</span>
              </div>
              <p v-if="r.summary" class="item__sum">{{ r.summary }}</p>
              <div v-if="(r.tags ?? []).length" class="item__tags">
                <span v-for="tag in r.tags" :key="tag" class="tag tag--topic">{{ tag }}</span>
              </div>
            </li>
          </ul>
        </aside>

        <article
          ref="detailBox"
          class="ws-card detail"
          :class="{ 'detail--empty': !current }"
          @scroll="onDetailScroll"
        >
          <EmptyState v-if="!current" title="选一条记录看详情" description="摘要、各栏目、原文与原始音频都在这里。" icon="Document" />
          <template v-else>
            <header class="detail__head" :class="{ 'is-stuck': detailStuck }">
              <el-input v-model="titleDraft" size="large" class="detail__title" placeholder="标题" @change="saveTitle" />
              <div class="detail__ops">
                <el-button size="small" @click="copyDoc">
                  <el-icon><CopyDocument /></el-icon>&nbsp;复制
                </el-button>
                <el-button size="small" :loading="exporting" @click="exportDoc">
                  <el-icon><Download /></el-icon>&nbsp;导出 MD
                </el-button>
                <el-button size="small" :loading="streaming" @click="resummarize">
                  <el-icon><MagicStick /></el-icon>&nbsp;重新总结
                </el-button>
                <el-button size="small" @click="learnFromRecord">
                  <el-icon><Notebook /></el-icon>&nbsp;学热词
                </el-button>
                <el-button size="small" type="danger" plain @click="removeOne">删除</el-button>
              </div>
            </header>

            <div class="meta">
              <span class="chip"><i />{{ fmtStamp(current.startedAt) }}</span>
              <span v-if="humanDuration(current.durationSec)" class="chip">
                <i />{{ humanDuration(current.durationSec) }}
              </span>
              <span class="chip"><i />{{ current.chars }} 字</span>
              <span class="chip"><i />{{ current.type === 'interview' ? '访谈' : '口述' }}</span>
              <span v-if="current.categoryName" class="chip"><i />{{ current.categoryName }}</span>
              <span v-if="modelLabel" class="chip"><i />{{ modelLabel }}</span>
            </div>

            <!-- 原始音频：转写完不删，这里直接回放（读边车那条支持 Range 的接口） -->
            <div v-if="hasAudio" class="audio-wrap">
              <MemoAudioPlayer ref="player" :record="current" :url="audioUrl" />
              <div class="audio-wrap__ops">
                <span class="ws-dim">{{ mb(current.audio?.bytes) }}</span>
                <el-button link size="small" @click="removeAudioOnly">只删录音</el-button>
              </div>
            </div>
            <p v-else class="audio-none ws-dim">这条没有原始音频（文件被删过，或记录里没存）。</p>

            <!-- 分类 / 标签 / 热词 / 重点 -->
            <div class="organize">
              <div class="organize__row">
                <label>分类</label>
                <el-select
                  :model-value="current.categoryName"
                  size="small"
                  class="organize__ctl"
                  placeholder="未分类"
                  clearable
                  filterable
                  @change="changeRecordCategory"
                >
                  <el-option v-for="c in hotCategories" :key="c.id" :value="c.name" :label="c.name" />
                </el-select>
                <span v-if="(current.suggestedCategories ?? []).length" class="ws-dim organize__hint">
                  模型建议
                  <el-button
                    v-for="s in current.suggestedCategories"
                    :key="s"
                    link
                    size="small"
                    @click="changeRecordCategory(s)"
                    >新建「{{ s }}」</el-button
                  >
                </span>
              </div>
              <div class="organize__row">
                <label>标签</label>
                <el-select
                  v-model="tagsDraft"
                  size="small"
                  class="organize__ctl"
                  multiple
                  filterable
                  allow-create
                  default-first-option
                  :reserve-keyword="false"
                  :disabled="tagsSaving"
                  placeholder="主题词，输入后可回车新建"
                  @change="saveTags"
                >
                  <el-option v-for="t in hotTermHints" :key="t" :value="t" :label="t" />
                </el-select>
                <el-button link size="small" :loading="tagsToHotBusy" @click="tagsToHotwords">收进热词库</el-button>
              </div>
              <div v-if="(current.hotwords ?? []).length || (current.newTerms ?? []).length" class="organize__row">
                <label>热词</label>
                <div class="organize__tags">
                  <span v-for="h in current.hotwords ?? []" :key="'u-' + h.term" class="tag tag--word" :title="h.categoryName">
                    {{ h.term }}
                  </span>
                  <span v-for="t in current.newTerms ?? []" :key="'n-' + t.term" class="tag tag--new" title="这次新学到的">
                    +{{ t.term }}
                  </span>
                </div>
              </div>
              <div class="organize__row">
                <label>重点</label>
                <el-input
                  v-model="focusDraft"
                  size="small"
                  class="organize__ctl"
                  :disabled="focusSaving"
                  placeholder="这次想理清什么 / 访谈提纲（可空，改完重新总结会按它做对照）"
                  @change="saveFocus"
                />
              </div>
            </div>

            <!-- 成稿过程：推理与分块进度走套件里的 AiThoughts，不在这儿自己画进度行 -->
            <div v-if="streaming && streamMsg" class="stream">
              <div class="stream__head">
                <span>{{ modelLabel }} · {{ streamPhaseText }}</span>
                <span v-if="streamMsg.elapsedMs" class="ws-dim stream__meta">
                  {{ Math.round(streamMsg.elapsedMs / 1000) }}s
                </span>
              </div>
              <AiThoughts :tools="streamMsg.tools" :reasoning="streamMsg.reasoning" :phase="streamMsg.status" />
              <MdLite v-if="streamMsg.content" :text="streamMsg.content" />
              <p v-else class="ws-muted">正文还没开始——长稿会先分段详析再合并，上面的进度在动。</p>
            </div>

            <template v-else>
              <section v-if="current.summary" class="sec">
                <h3 class="sec__title">摘要</h3>
                <MdLite :text="current.summary" />
              </section>

              <section v-for="section in current.sections ?? []" :key="section.key + section.title" class="sec">
                <h3 class="sec__title">{{ section.title }}</h3>
                <MdLite :text="section.items.map((i: string) => `- ${i}`).join('\n')" />
              </section>

              <section v-if="(current.parts ?? []).length" class="sec">
                <div class="sec__head">
                  <h3 class="sec__title">分段详析</h3>
                  <span class="ws-dim">长稿按段整理，总稿由它们合并而成</span>
                </div>
                <el-collapse>
                  <el-collapse-item v-for="p in current.parts" :key="p.index" :name="String(p.index)">
                    <template #title>
                      <span class="part-title">
                        <!-- 上传式转写没有时间码：那就只写「第 N 段」，别印一对空括号 -->
                        <span v-if="p.startLabel && p.endLabel" class="ws-dim">{{ p.startLabel }}–{{ p.endLabel }}</span>
                        <span v-else class="ws-dim">第 {{ p.index }} 段</span>
                        {{ p.title }}
                      </span>
                    </template>
                    <p v-if="p.summary" class="ws-muted part-sum">{{ p.summary }}</p>
                    <div v-for="sec in p.sections ?? []" :key="sec.title" class="part-sec">
                      <b>{{ sec.title }}</b>
                      <MdLite :text="sec.items.map((i: string) => `- ${i}`).join('\n')" dense />
                    </div>
                  </el-collapse-item>
                </el-collapse>
              </section>

              <section v-if="current.transcript" class="sec">
                <div class="sec__head">
                  <h3 class="sec__title">转写原文</h3>
                  <span v-if="current.asrMs" class="ws-dim">转写耗时 {{ (current.asrMs / 1000).toFixed(1) }}s</span>
                  <el-button link size="small" @click="copyText(current.transcript, '已复制原文')">复制原文</el-button>
                </div>
                <div class="lines lines--boxed">
                  <p class="lines__text">{{ current.transcript }}</p>
                </div>
              </section>

              <!-- 自动总结失败之类：写在记录上的原因，别让它只躺在服务端 -->
              <div v-if="(current.errors ?? []).length" class="ws-dim" style="font-size: 12px; margin-top: 12px">
                <div v-for="(e, i) in current.errors" :key="i">· {{ e.text }}</div>
              </div>
            </template>
          </template>
        </article>
      </section>

      <el-alert v-if="error" class="memo-error" type="warning" :closable="false" :title="error" />
    </template>
  </div>
</template>

<style>
@import './memo.css';
</style>
