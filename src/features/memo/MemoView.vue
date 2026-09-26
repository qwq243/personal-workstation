<script setup lang="ts">
/**
 * 语音随记（`#/memo`）。
 *
 * 一条链路：**给一段音频 → 转写后端出文字 → 大模型起标题写摘要 → 落成一条记录**。
 * 转写后端是一个可换的 provider（出厂只有 OpenAI 兼容的 /audio/transcriptions，
 * 本机 whisper 网关或云端都行）—— 见 server/lib/asr.mjs。
 *
 * 两个刻意的设计：
 *  1. **起任务 + 轮询**，不在一个请求里等完：转写是分钟级的，
 *     HTTP 请求超时扛不住（边车侧也一样，见 server/index.mjs 的 /api/memo/transcribe）。
 *  2. **没配就不显示**：转写端点没填时这个模块会从侧边栏消失（core/appconfig.ts 的约定），
 *     直接敲 `#/memo` 进来则看到下面的配置引导卡，而不是一个报错。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import SidecarOffline from '@/components/SidecarOffline.vue'
import MdLite from '@/components/MdLite.vue'
import { api, ensureSidecar, memoSummarizeStream } from '@/core/sidecar'

const ready = ref(false)
const loading = ref(true)
const error = ref('')

/** 转写后端状态：{ configured, reason, model, audioExt } */
const asr = ref<any>(null)
const jobs = ref<any[]>([])
const activeJob = ref<any>(null)

const fileInput = ref<HTMLInputElement | null>(null)
const dropActive = ref(false)
const uploading = ref(false)

const models = ref<string[]>([])
const defaultModel = ref('')
const model = ref('')

const promptOpen = ref(false)
const promptLoading = ref(false)
const promptSaving = ref(false)
const promptDefaults = ref<Record<string, string>>({})
const promptForm = ref<Record<string, string>>({})
const promptCustomized = ref(false)
/** 占位符字面量放在脚本里：直接写进模板会被 Vue 插值语法吃掉（模板里遇到 }} 就提前收尾） */
const PLACEHOLDER = '{' + '{transcript}' + '}'
const PLACEHOLDER_RAW = '{' + '{transcript}' + '}'

/** 字段提示里把原始占位符换成它能安全显示的形式 */
function hintOf(f: { hint: string }) {
  return f.hint.replace(PLACEHOLDER_RAW, PLACEHOLDER)
}

const promptFields = [
  { key: 'summarySystem', label: '总结 · 系统', hint: '给模型的角色设定与硬要求' },
  { key: 'summaryUser', label: '总结 · 要求', hint: '{{transcript}} 会被替换成带时间轴的转写正文' },
  { key: 'liveSystem', label: '滚动摘要 / 分段详析 · 系统', hint: '长稿分段详析时也用它' },
  { key: 'liveUser', label: '滚动摘要 / 分段详析 · 要求', hint: '{{transcript}} 占位符' },
]

const records = ref<any[]>([])
const current = ref<any>(null)
const titleDraft = ref('')
const busy = ref(false)

const streaming = ref(false)
const streamText = ref('')
const streamReasoning = ref('')
const streamPhase = ref('')
const streamStages = ref<{ index: number; total: number; title: string }[]>([])
const showReasoning = ref(false)
let streamCtl: AbortController | null = null
let jobTimer: ReturnType<typeof setInterval> | null = null

const hasRecords = computed(() => records.value.length > 0)
const asrReady = computed(() => !!asr.value?.configured)
const acceptExt = computed(() => (asr.value?.audioExt ?? []).join(','))

function clock(seconds: number | undefined) {
  const s = Math.max(0, Math.round(Number(seconds) || 0))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function fmtStamp(ms: number | undefined) {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const modelLabel = computed(() => model.value || `默认（${defaultModel.value || '跟随设置'}）`)

/* ------------------------------------------------------------------ 加载 --- */

async function loadStatus() {
  const r = await api.memoStatus()
  if (!r.ok) {
    error.value = r.error ?? '读不到状态'
    return
  }
  const d = r.data ?? {}
  asr.value = d.asr ?? null
  jobs.value = d.jobs ?? []
  if (d.lastJob) activeJob.value = d.lastJob
  error.value = ''
}

async function loadModels() {
  const r = await api.memoModels()
  if (!r.ok) return
  models.value = r.data?.models ?? []
  defaultModel.value = r.data?.default ?? ''
  model.value = r.data?.chosen ?? ''
}

async function loadRecords() {
  const r = await api.memoRecords(50)
  if (r.ok) records.value = r.data?.records ?? []
}

async function load() {
  loading.value = true
  try {
    await loadStatus()
    await loadModels()
    await loadRecords()
  } finally {
    loading.value = false
  }
}

async function init() {
  const ok = await ensureSidecar()
  ready.value = ok
  if (ok) await load()
}

/* ------------------------------------------------------------ 任务：转写 --- */

function pollJob(id: string) {
  stopPoll()
  const tick = async () => {
    const r = await api.memoJob(id)
    if (!r.ok) return
    activeJob.value = r.data?.job ?? activeJob.value
    const st = activeJob.value?.status
    if (st && st !== 'running') {
      stopPoll()
      // 转写结束后记录才落盘，这里重新拉一次列表并打开它
      await loadRecords()
      await loadStatus()
      if (activeJob.value?.recordId) await open(activeJob.value.recordId)
      if (st === 'done') ElMessage.success('转写完成')
      else ElMessage.error(activeJob.value?.error ?? '转写失败')
    }
  }
  void tick()
  jobTimer = setInterval(tick, 1500)
}

function stopPoll() {
  if (jobTimer) clearInterval(jobTimer)
  jobTimer = null
}

/** 上传 + 起任务。两步分开：上传走二进制，起任务走 JSON */
async function submitFile(file: File) {
  if (!file) return
  if (!asrReady.value) {
    ElMessage.warning('还没配转写后端：先在设置里填端点')
    return
  }
  uploading.value = true
  try {
    const up = await api.memoUpload(file.name, file)
    if (!up.ok) {
      ElMessage.error(up.error ?? '上传失败')
      return
    }
    const abs = up.data?.path
    if (!abs) {
      ElMessage.error('上传成功但没拿到路径')
      return
    }
    const r = await api.memoTranscribe(abs, file.name)
    if (!r.ok) {
      ElMessage.error(r.error ?? '起任务失败')
      return
    }
    activeJob.value = r.data?.job ?? null
    if (activeJob.value?.id) pollJob(activeJob.value.id)
  } finally {
    uploading.value = false
  }
}

function onPick(e: Event) {
  const files = (e.target as HTMLInputElement).files
  if (files?.length) void submitFile(files[0])
  ;(e.target as HTMLInputElement).value = ''
}

function onDrop(e: DragEvent) {
  dropActive.value = false
  const f = e.dataTransfer?.files?.[0]
  if (f) void submitFile(f)
}

/* ------------------------------------------------------------ 记录：读写 --- */

async function open(id: string) {
  const r = await api.memoRecord(id)
  if (!r.ok) {
    ElMessage.error(r.error ?? '读不到记录')
    return
  }
  current.value = r.data?.record ?? null
  titleDraft.value = current.value?.title ?? ''
  streamText.value = ''
  streamReasoning.value = ''
  streamPhase.value = ''
}

async function saveTitle() {
  const t = titleDraft.value.trim()
  if (!current.value || !t || t === current.value.title) return
  busy.value = true
  try {
    const r = await api.memoRename(current.value.id, t)
    if (!r.ok) ElMessage.error(r.error ?? '改名失败')
    else {
      current.value = { ...current.value, title: t }
      await loadRecords()
      ElMessage.success('已改名')
    }
  } finally {
    busy.value = false
  }
}

async function remove(id: string) {
  try {
    await ElMessageBox.confirm('删掉这条记录？md 文件也一起删。', '删除随记', {
      confirmButtonText: '删除',
      cancelButtonText: '算了',
      type: 'warning',
    })
  } catch {
    return
  }
  const r = await api.memoDelete(id)
  if (!r.ok) {
    ElMessage.error(r.error ?? '删除失败')
    return
  }
  if (current.value?.id === id) current.value = null
  await loadRecords()
  ElMessage.success('已删除')
}

async function copyMarkdown() {
  if (!current.value) return
  const r = await api.memoExport(current.value.id)
  if (!r.ok) {
    ElMessage.error(r.error ?? '导出失败')
    return
  }
  try {
    await navigator.clipboard.writeText(r.data?.content ?? '')
    ElMessage.success('已复制 Markdown')
  } catch {
    ElMessage.info('浏览器不让写剪贴板，用「下载 MD」吧')
  }
}

async function downloadMarkdown() {
  if (!current.value) return
  const r = await api.memoExport(current.value.id)
  if (!r.ok) {
    ElMessage.error(r.error ?? '导出失败')
    return
  }
  const blob = new Blob([r.data?.content ?? ''], { type: 'text/markdown;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = r.data?.filename ?? 'memo.md'
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 4000)
}

/** 重新总结：走流式（边生成边看，结束时服务端已落盘） */
async function resummarize() {
  if (!current.value || streaming.value) return
  streaming.value = true
  streamText.value = ''
  streamReasoning.value = ''
  streamStages.value = []
  streamPhase.value = '准备中…'
  streamCtl = new AbortController()
  try {
    await memoSummarizeStream(
      current.value.id,
      (e) => {
        if (e.type === 'stage') {
          streamPhase.value =
            e.phase === 'merge' ? `合并（第 ${e.index}/${e.total} 段）` : `分段详析（第 ${e.index}/${e.total} 段）`
          if (e.title) {
            const i = streamStages.value.findIndex((s) => s.index === e.index)
            const item = { index: e.index ?? 0, total: e.total ?? 0, title: e.title ?? '' }
            if (i >= 0) streamStages.value[i] = item
            else streamStages.value.push(item)
          }
        } else if (e.type === 'delta') {
          streamText.value += e.text ?? ''
        } else if (e.type === 'reasoning') {
          streamReasoning.value += e.text ?? ''
        } else if (e.type === 'done') {
          streamPhase.value = '已落盘'
        } else if (e.type === 'error') {
          streamPhase.value = e.error
        }
      },
      streamCtl.signal,
      model.value,
    )
  } finally {
    streaming.value = false
    streamCtl = null
    await open(current.value.id)
    await loadRecords()
  }
}

function stopStream() {
  streamCtl?.abort()
}

async function changeModel() {
  const r = await api.memoSetModel(model.value)
  if (!r.ok) {
    ElMessage.error(r.error ?? '存不下这个模型')
    return
  }
  await loadModels()
}

/* ------------------------------------------------------------ 提示词模板 --- */

async function loadPrompts() {
  promptLoading.value = true
  try {
    const r = await api.memoPrompts()
    if (!r.ok) {
      ElMessage.error(r.error ?? '读不到提示词')
      return
    }
    promptDefaults.value = r.data?.defaults ?? {}
    promptForm.value = { ...promptDefaults.value, ...(r.data?.current ?? {}) }
    promptCustomized.value = !!r.data?.customized
  } finally {
    promptLoading.value = false
  }
}

function openPrompts() {
  promptOpen.value = true
  void loadPrompts()
}

function useDefaultPrompt(key: string) {
  promptForm.value = { ...promptForm.value, [key]: promptDefaults.value[key] ?? '' }
}

async function savePrompts() {
  promptSaving.value = true
  try {
    const r = await api.memoSetPrompts(promptForm.value)
    if (!r.ok) {
      ElMessage.error(r.error ?? '保存失败')
      return
    }
    promptCustomized.value = true
    ElMessage.success('已保存（下一条记录起生效）')
    promptOpen.value = false
  } finally {
    promptSaving.value = false
  }
}

onMounted(init)
onUnmounted(stopPoll)
</script>

<template>
  <div class="ws-page">
    <SidecarOffline v-if="ready === false" what="语音随记" @ready="init" />

    <template v-else>
      <PageHeader title="语音随记" subtitle="给一段音频 → 自动转写 → 起标题写摘要 → 存成一条记录" icon="Microphone">
        <template #actions>
          <el-select v-model="model" size="small" style="width: 210px" @change="changeModel">
            <el-option :label="`默认（${defaultModel || '跟随设置'}）`" value="" />
            <el-option v-for="m in models" :key="m" :label="m" :value="m" />
          </el-select>
          <el-button size="small" :disabled="streaming" @click="openPrompts">提示词</el-button>
          <el-button size="small" :loading="loading" @click="load">
            <el-icon><Refresh /></el-icon>&nbsp;刷新
          </el-button>
        </template>
      </PageHeader>

      <!-- 没配转写后端：给引导卡，而不是报错 -->
      <el-alert
        v-if="!asrReady"
        type="info"
        :closable="false"
        show-icon
        title="转写后端还没配"
        style="margin-bottom: 14px"
      >
        <template #default>
          <p style="margin: 6px 0 8px">
            {{ asr?.reason || '去「设置与数据 → 转写后端」填一个 OpenAI 兼容的 /audio/transcriptions 端点。' }}
          </p>
          <p style="margin: 0; font-size: 12.5px; color: var(--ws-text-3); line-height: 1.7">
            本机 whisper.cpp / faster-whisper-server 或者任意云端接口都行，形状是
            <code class="ws-mono">POST {baseUrl}/audio/transcriptions</code>（multipart：
            <code class="ws-mono">file</code> + <code class="ws-mono">model</code>）。
            密钥填在 <code class="ws-mono">server/credentials.json</code> 的 <code class="ws-mono">asr.apiKey</code>。
          </p>
        </template>
      </el-alert>

      <el-skeleton v-if="loading && !asr" :rows="6" animated />

      <template v-else>
        <!-- ==================================================== 上传区 -->
        <div
          class="ws-card drop"
          :class="{ 'drop--active': dropActive, 'drop--off': !asrReady }"
          @dragover.prevent="dropActive = true"
          @dragleave.prevent="dropActive = false"
          @drop.prevent="onDrop"
          @click="asrReady && fileInput?.click()"
        >
          <input ref="fileInput" type="file" :accept="acceptExt" hidden @change="onPick" />
          <el-icon class="drop__icon"><Upload /></el-icon>
          <div class="drop__title">
            把音频拖进来，或点击选择文件<template v-if="uploading"> · 正在上传…</template>
          </div>
          <div class="drop__hint ws-dim">
            支持 {{ acceptExt || '常见音频格式' }}；传完立刻返回任务号，转写与总结在后台跑，页面自动轮询。
          </div>
        </div>

        <!-- 任务状态条 -->
        <div v-if="activeJob" class="ws-card job">
          <div class="job__row">
            <span class="chip" :class="`chip--${activeJob.status}`">{{ activeJob.status }}</span>
            <span class="job__name">{{ activeJob.name }}</span>
            <span class="ws-dim ws-mono">
              {{ clock(activeJob.elapsedSec) }}
              <template v-if="activeJob.chars"> · {{ activeJob.chars }} 字</template>
              <template v-if="activeJob.asrMs"> · 转写 {{ (activeJob.asrMs / 1000).toFixed(1) }}s</template>
            </span>
          </div>
          <div v-if="activeJob.error" class="job__err">{{ activeJob.error }}</div>
          <div class="ws-dim" style="font-size: 12px; margin-top: 4px">
            任务在边车后台跑，可以离开这一页；回来点「刷新」还能看到。
          </div>
        </div>

        <!-- ==================================================== 主体 -->
        <div class="grid">
          <!-- 左：记录列表 -->
          <div class="ws-card block list">
            <div class="block__title">记录（{{ records.length }}）</div>
            <div v-if="!hasRecords" class="muted-line">还没有记录。上传一段音频试试。</div>
            <div
              v-for="r in records"
              :key="r.id"
              class="item"
              :class="{ 'item--on': current?.id === r.id }"
              @click="open(r.id)"
            >
              <div class="item__title">{{ r.title || '（还没起标题）' }}</div>
              <div class="item__meta ws-dim">
                {{ fmtStamp(r.startedAt) }} · {{ r.chars }} 字
                <template v-if="r.sections?.length"> · {{ r.sections.length }} 个栏目</template>
              </div>
            </div>
          </div>

          <!-- 右：详情 -->
          <div class="ws-card block detail">
            <div v-if="!current" class="muted-line">左边点一条记录看详情。</div>
            <template v-else>
              <div class="detail__head">
                <el-input v-model="titleDraft" size="small" style="max-width: 320px" @keydown.enter="saveTitle" />
                <el-button size="small" :loading="busy" @click="saveTitle">存标题</el-button>
                <span class="ws-spacer" />
                <el-button size="small" :loading="streaming" @click="resummarize">
                  {{ streaming ? '总结中…' : '重新总结' }}
                </el-button>
                <el-button v-if="streaming" size="small" @click="stopStream">停</el-button>
                <el-button size="small" @click="copyMarkdown">复制 MD</el-button>
                <el-button size="small" @click="downloadMarkdown">下载 MD</el-button>
                <el-button size="small" type="danger" plain @click="remove(current.id)">删除</el-button>
              </div>

              <div class="detail__meta ws-dim">
                {{ fmtStamp(current.startedAt) }} · {{ current.chars }} 字 · 用 {{ modelLabel }}
                <template v-if="current.file"> · <span class="ws-mono">{{ current.file }}</span></template>
              </div>

              <div v-if="streaming" class="stream">
                <div class="stream__phase">{{ streamPhase }}</div>
                <div v-if="streamStages.length" class="stream__stages">
                  <span v-for="s in streamStages" :key="s.index" class="chip">{{ s.index }}. {{ s.title }}</span>
                </div>
                <div v-if="streamText" class="stream__text"><MdLite :text="streamText" /></div>
                <div v-if="streamReasoning" class="stream__reason">
                  <el-button link size="small" @click="showReasoning = !showReasoning">
                    {{ showReasoning ? '收起' : '展开' }}思考过程（{{ streamReasoning.length }} 字）
                  </el-button>
                  <pre v-if="showReasoning" class="reason">{{ streamReasoning }}</pre>
                </div>
              </div>

              <template v-else>
                <div v-if="current.summary" class="detail__summary"><MdLite :text="current.summary" /></div>

                <div v-if="current.sections?.length" class="sections">
                  <div v-for="s in current.sections" :key="s.key" class="section">
                    <div class="section__title">{{ s.title }}</div>
                    <ul class="section__items">
                      <li v-for="(it, i) in s.items" :key="i">{{ it }}</li>
                    </ul>
                  </div>
                </div>

                <div class="transcript">
                  <div class="transcript__title">转写原文</div>
                  <pre class="transcript__body">{{ current.transcript }}</pre>
                </div>

                <div v-if="current.errors?.length" class="ws-dim" style="font-size: 12px; margin-top: 10px">
                  <div v-for="(e, i) in current.errors" :key="i">· {{ e.text }}</div>
                </div>
              </template>
            </template>
          </div>
        </div>
      </template>

      <!-- 提示词抽屉 -->
      <el-drawer v-model="promptOpen" title="总结用的提示词" size="620px">
        <div v-if="promptLoading" class="muted-line">读取中…</div>
        <template v-else>
          <p class="ws-dim" style="font-size: 12.5px; line-height: 1.75; margin-top: 0">
            四段模板分开写：系统的负责角色与硬要求，用户那段里 <code class="ws-mono">{{ PLACEHOLDER }}</code>
            会被替换成转写正文。留空 = 用默认；改完对<b>下一次总结</b>生效（已经落盘的记录不会跟着变）。
          </p>
          <div v-for="f in promptFields" :key="f.key" class="pf">
            <div class="pf__head">
              <span>{{ f.label }}</span>
              <el-button link size="small" @click="useDefaultPrompt(f.key)">用默认</el-button>
            </div>
            <div class="pf__hint ws-dim">{{ hintOf(f) }}</div>
            <el-input v-model="promptForm[f.key]" type="textarea" :rows="5" resize="vertical" />
          </div>
          <div class="ws-dim" style="font-size: 12px; margin: 8px 0 14px">
            当前状态：{{ promptCustomized ? '已自定义' : '用默认' }}
          </div>
          <el-button type="primary" :loading="promptSaving" @click="savePrompts">保存</el-button>
        </template>
      </el-drawer>
    </template>
  </div>
</template>

<style scoped>
.drop {
  padding: 22px 20px;
  text-align: center;
  cursor: pointer;
  border: 1.5px dashed var(--ws-border-strong);
  transition: all 0.15s ease;
  margin-bottom: 14px;
}
.drop--active {
  border-color: var(--ws-accent);
  background: var(--ws-accent-soft);
}
.drop--off {
  cursor: not-allowed;
  opacity: 0.6;
}
.drop__icon {
  font-size: 26px;
  color: var(--ws-text-3);
}
.drop__title {
  font-size: 14px;
  font-weight: 600;
  margin-top: 8px;
}
.drop__hint {
  font-size: 12.5px;
  margin-top: 6px;
}

.job {
  padding: 12px 16px;
  margin-bottom: 14px;
}
.job__row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.job__name {
  font-weight: 550;
  word-break: break-all;
}
.job__err {
  color: var(--ws-danger);
  font-size: 12.5px;
  margin-top: 6px;
}
.chip {
  padding: 2px 9px;
  border-radius: 99px;
  font-size: 11.5px;
  border: 1px solid var(--ws-border-strong);
  background: var(--ws-panel-2);
}
.chip--running {
  border-color: var(--ws-accent);
  color: var(--ws-accent);
}
.chip--done {
  border-color: #16a34a;
  color: #16a34a;
}
.chip--error,
.chip--interrupted {
  border-color: var(--ws-danger);
  color: var(--ws-danger);
}

.grid {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  gap: 16px;
}
@media (max-width: 980px) {
  .grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
.block {
  padding: 14px 16px 16px;
}
.block__title {
  font-weight: 600;
  font-size: 13.5px;
  margin-bottom: 10px;
}
.list {
  max-height: calc(100vh - 300px);
  overflow-y: auto;
}
.item {
  padding: 8px 9px;
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid transparent;
}
.item:hover {
  background: var(--ws-panel-2);
}
.item--on {
  background: var(--ws-accent-soft);
  border-color: var(--ws-accent);
}
.item__title {
  font-size: 13px;
  font-weight: 550;
  word-break: break-word;
}
.item__meta {
  font-size: 11.5px;
  margin-top: 2px;
}
.muted-line {
  color: var(--ws-text-3);
  font-size: 12.5px;
  padding: 4px 0;
}

.detail__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.detail__meta {
  font-size: 12px;
  margin: 8px 0 12px;
  word-break: break-all;
}
.detail__summary {
  font-size: var(--ws-fs-sm);
  line-height: 1.8;
  padding: 12px 14px;
  background: var(--ws-panel-2);
  border-radius: var(--ws-radius);
}
.sections {
  margin-top: 14px;
}
.section {
  margin-bottom: 12px;
}
.section__title {
  font-weight: 600;
  font-size: 13px;
}
.section__items {
  margin: 6px 0 0;
  padding-left: 20px;
  font-size: var(--ws-fs-sm);
  line-height: 1.8;
}
.transcript {
  margin-top: 16px;
}
.transcript__title {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 6px;
}
.transcript__body {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.85;
  background: var(--ws-panel-2);
  border-radius: var(--ws-radius);
  padding: 12px 14px;
  margin: 0;
  max-height: 46vh;
  overflow-y: auto;
}

.stream {
  border: 1px solid var(--ws-border);
  border-radius: var(--ws-radius);
  padding: 10px 12px;
}
.stream__phase {
  font-size: 12.5px;
  color: var(--ws-text-2);
}
.stream__stages {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.stream__text {
  margin-top: 10px;
  font-size: var(--ws-fs-sm);
  line-height: 1.8;
}
.stream__reason {
  margin-top: 8px;
}
.reason {
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--ws-mono);
  font-size: 11.5px;
  line-height: 1.6;
  max-height: 240px;
  overflow-y: auto;
  background: var(--ws-panel-2);
  border-radius: 6px;
  padding: 10px;
}

.pf {
  margin-bottom: 14px;
}
.pf__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
  font-weight: 550;
}
.pf__hint {
  font-size: 12px;
  margin: 2px 0 6px;
}
</style>
