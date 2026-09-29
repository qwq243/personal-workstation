<script setup lang="ts">
/**
 * 语音随记 · 转写（`#/memo`）。
 *
 * 这一页只干一件事：**给一段音频 → 拿一个任务号 → 等它落成一条记录**。
 * 记录列表 / 编辑 / 回放 / 热词库 / 提示词分别在另外两页（`#/memo/records`、`#/memo/settings`），
 * 免得一个页面既当上传台又当档案柜。
 *
 * 两个刻意的设计：
 *  1. **起任务 + 轮询**，不在一个请求里等完：转写是分钟级的，
 *     HTTP 请求超时扛不住（边车侧也一样，见 server/index.mjs 的 /api/memo/transcribe）。
 *  2. **没配就不显示**：转写端点没填时这个模块会从侧边栏消失（core/appconfig.ts 的约定），
 *     直接敲 `#/memo` 进来则看到下面的引导卡，而不是一个报错。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageHeader from '@/components/PageHeader.vue'
import SidecarOffline from '@/components/SidecarOffline.vue'
import { usePolling } from '@/core/polling'
import { api, ensureSidecar } from '@/core/sidecar'

const router = useRouter()
const ready = ref(false)
const loading = ref(true)
const error = ref('')

/** 转写后端状态：{ configured, reason, provider, baseUrl, model, audioExt } */
const asr = ref<any>(null)
const activeJob = ref<any>(null)
const recent = ref<any[]>([])

const fileInput = ref<HTMLInputElement | null>(null)
const dropActive = ref(false)
const uploading = ref(false)

/** 这次怎么整理：类型 + 分类 + 想理清的重点（都可空，转写时随任务一起带过去） */
const options = ref<{ type: string; hotwordCategories: string[]; autoHotwords: boolean }>({
  type: 'oral',
  hotwordCategories: [],
  autoHotwords: true,
})
const startType = ref('oral')
const startCategory = ref('')
const startFocus = ref('')
const hotCategories = ref<any[]>([])
const hotTotal = ref(0)

/** 正在轮询的那个任务 id（转写是分钟级的，所以走「起任务 + 轮询」） */
let jobId = ''
// 轮询走统一助手（页面不可见时自动暂停，卸载自动停）；起停时机由起任务 / 终态掌握
const jobPoll = usePolling(tickJob, 1500, { immediate: true })

const asrReady = computed(() => !!asr.value?.configured)
const acceptExt = computed(() => (asr.value?.audioExt ?? []).join(','))
const hasRecent = computed(() => recent.value.length > 0)

function clock(seconds: number | undefined) {
  const s = Math.max(0, Math.round(Number(seconds) || 0))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function humanDuration(seconds: number | undefined | null) {
  if (!seconds) return '' // 时长读不出来（非 WAV）就不显示，别写「0 秒」
  const total = Math.max(0, Math.round(Number(seconds)))
  if (total < 60) return `${total} 秒`
  const m = Math.floor(total / 60)
  const s = total % 60
  return s ? `${m} 分 ${s} 秒` : `${m} 分钟`
}

function fmtStamp(ms: number | undefined) {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/* ------------------------------------------------------------------ 加载 --- */

async function loadStatus() {
  const r = await api.memoStatus()
  if (!r.ok) {
    error.value = r.error ?? '读不到状态'
    return
  }
  const d = r.data ?? {}
  asr.value = d.asr ?? null
  if (d.lastJob) activeJob.value = d.lastJob
  error.value = ''
}

async function loadOptions() {
  const r = await api.memoOptions()
  const d = r.data as any
  if (!r.ok || d?.ok === false) return
  if (d.options) {
    options.value = { ...options.value, ...d.options }
    startType.value = options.value.type
  }
  hotCategories.value = d.hotwords?.categories ?? []
  hotTotal.value = Number(d.hotwords?.total ?? 0)
}

async function loadRecent() {
  const r = await api.memoRecords(5)
  if (r.ok) recent.value = r.data?.records ?? []
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const ok = await ensureSidecar()
    ready.value = ok
    if (!ok) return
    await Promise.all([loadStatus(), loadOptions(), loadRecent()])
    // 上次离开时还在跑的任务：回来接着轮询它，不然页面会一直停在「running」
    if (activeJob.value?.status === 'running') pollJob(activeJob.value.id)
  } finally {
    loading.value = false
  }
}

/* ------------------------------------------------------------ 任务：转写 --- */

function pollJob(id: string) {
  jobId = id
  jobPoll.stop()
  jobPoll.start()
}

async function tickJob() {
  const r = await api.memoJob(jobId)
  if (!r.ok) return
  activeJob.value = r.data?.job ?? activeJob.value
  const st = activeJob.value?.status
  if (st && st !== 'running') {
    jobPoll.stop()
    // 转写结束（成功或失败）都会动记录列表，这里重新拉一次
    await loadRecent()
    await loadStatus()
    if (st === 'done') ElMessage.success('转写完成，去「记录」里看整理稿')
    else ElMessage.error(activeJob.value?.error ?? '转写失败')
  }
}

/** 上传 + 起任务。两步分开：上传走二进制，起任务走 JSON */
async function submitFile(file: File) {
  if (!file) return
  if (!asrReady.value) {
    ElMessage.warning('还没配转写后端：去「配置」页填一个端点')
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
    const r = await api.memoTranscribe(abs, file.name, {
      type: startType.value,
      category: startCategory.value,
      focus: startFocus.value,
    })
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

async function setStartType(value: string | number | boolean | undefined) {
  startType.value = value === 'interview' ? 'interview' : 'oral'
  const r = await api.memoSetOptions({ type: startType.value })
  const d = r.data as any
  if (!r.ok || d?.ok === false) ElMessage.error(d?.error ?? r.error ?? '记录类型没存上')
}

function openRecord(id: string) {
  router.push(`/memo/records?id=${encodeURIComponent(id)}`)
}

onMounted(load)
</script>

<template>
  <div class="ws-page memo">
    <PageHeader title="语音随记" subtitle="传一段录音，自动转写、起标题写摘要，落成一条记录。" icon="Microphone">
      <template #actions>
        <el-button size="small" @click="router.push('/memo/records')">
          <el-icon><Notebook /></el-icon>&nbsp;记录
        </el-button>
        <el-button size="small" @click="router.push('/memo/settings')">
          <el-icon><Setting /></el-icon>&nbsp;配置
          <span v-if="hotTotal" class="pill">{{ hotTotal }}</span>
        </el-button>
      </template>
    </PageHeader>

    <SidecarOffline v-if="!loading && !ready" what="语音随记" @ready="load" />

    <template v-else>
      <!-- 没配转写后端：给引导卡，而不是报错（模块本身也会从侧边栏消失） -->
      <el-alert
        v-if="!asrReady && !loading"
        type="info"
        :closable="false"
        show-icon
        title="转写后端还没配"
        style="margin-bottom: 14px"
      >
        <template #default>
          <p style="margin: 6px 0 8px">
            {{ asr?.reason || '去「配置」页填一个 OpenAI 兼容的 /audio/transcriptions 端点。' }}
          </p>
          <p style="margin: 0; font-size: 12.5px; color: var(--ws-text-3); line-height: 1.7">
            本机跑（whisper.cpp / faster-whisper-server 之类）或云端都行，形状是
            <code class="ws-mono">POST {baseUrl}/audio/transcriptions</code>（multipart：
            <code class="ws-mono">file</code> + <code class="ws-mono">model</code>）。
          </p>
          <p style="margin: 8px 0 0">
            <el-button size="small" type="primary" plain @click="router.push('/memo/settings')">去配置</el-button>
          </p>
        </template>
      </el-alert>

      <!-- ==================================================== 这次怎么整理 -->
      <section class="ws-card panel">
        <header class="panel__head">
          <span class="panel__title"><i class="dot" />这次怎么整理</span>
          <span class="ws-dim">跟这一段音频一起交给后台；不填就用「配置」页里的默认值</span>
        </header>
        <div class="cfg__grid">
          <div class="field">
            <label>记录类型</label>
            <div class="field__row">
              <el-radio-group :model-value="startType" size="small" @update:model-value="setStartType">
                <el-radio-button value="oral">口述</el-radio-button>
                <el-radio-button value="interview">访谈</el-radio-button>
              </el-radio-group>
            </div>
          </div>
          <div class="field">
            <label>热词分类</label>
            <div class="field__row">
              <el-select v-model="startCategory" size="small" class="field__ctl" clearable placeholder="自动识别">
                <el-option value="" label="自动识别" />
                <el-option v-for="c in hotCategories" :key="c.id" :value="c.name" :label="c.name" />
              </el-select>
            </div>
          </div>
          <div class="field cfg__wide">
            <label>这次的重点</label>
            <div class="field__row">
              <el-input
                v-model="startFocus"
                size="small"
                class="field__ctl"
                placeholder="可空。访谈就把提纲或研究问题贴进来，成稿时会做「问题对照」"
              />
            </div>
          </div>
        </div>
        <p class="cfg__tip">
          口述走「摘要 / 讲了什么 / 决定 / 待办 / 风险」那套骨架；访谈走「受访者 / 关键引语 / 主题与编码 / 待追问」——
          两套骨架都能在「配置 → 提示词」里改。
        </p>
      </section>

      <!-- ==================================================== 上传区 -->
      <div
        class="drop"
        :class="{ 'is-active': dropActive, 'is-off': !asrReady }"
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
      <section v-if="activeJob" class="ws-card job">
        <div class="job__row">
          <span class="chip" :class="`chip--${activeJob.status}`"><i />{{ activeJob.status }}</span>
          <span class="job__name">{{ activeJob.name }}</span>
          <span class="ws-dim ws-mono">
            {{ clock(activeJob.elapsedSec) }}
            <template v-if="activeJob.chars"> · {{ activeJob.chars }} 字</template>
            <template v-if="activeJob.asrMs"> · 转写 {{ (activeJob.asrMs / 1000).toFixed(1) }}s</template>
          </span>
          <span class="ws-spacer" style="flex: 1 1 auto" />
          <el-button v-if="activeJob.recordId" link size="small" @click="openRecord(activeJob.recordId)">
            看这条记录 ›
          </el-button>
        </div>
        <div v-if="activeJob.error" class="job__err">{{ activeJob.error }}</div>
        <div class="ws-dim" style="font-size: 12px; margin-top: 4px">
          任务在边车后台跑，可以离开这一页；回来点「刷新」还能看到。
        </div>
      </section>

      <!-- ==================================================== 最近转的 / 引导 -->
      <section v-if="hasRecent" class="ws-card panel">
        <header class="panel__head">
          <span class="panel__title"><i class="dot" />最近转的</span>
          <el-button link size="small" @click="router.push('/memo/records')">全部记录 ›</el-button>
        </header>
        <ul class="mini">
          <li v-for="r in recent" :key="r.id" class="mini__row" @click="openRecord(r.id)">
            <div class="mini__title">{{ r.title || '（还没起标题）' }}</div>
            <div class="mini__meta">
              <span>{{ fmtStamp(r.startedAt) }}</span>
              <span>{{ r.chars }} 字</span>
              <span v-if="humanDuration(r.durationSec)">{{ humanDuration(r.durationSec) }}</span>
              <span v-if="r.audio" class="ws-dim">有原始音频</span>
              <span v-if="r.categoryName">{{ r.categoryName }}</span>
            </div>
          </li>
        </ul>
      </section>

      <section v-else class="ws-card onboard">
        <ol class="steps">
          <li><b>1</b> 准备一段音频（手机录音、会议录制、自己念一段都行）</li>
          <li><b>2</b> 拖进上面的方框，或点它选文件 —— 传完立刻返回任务号</li>
          <li><b>3</b> 转写完成后自动起标题写摘要，去「记录」页看整理稿、听原始音频</li>
        </ol>
      </section>

      <el-alert v-if="error" class="memo-error" type="warning" :closable="false" :title="error" />
    </template>
  </div>
</template>

<style>
@import './memo.css';
</style>
