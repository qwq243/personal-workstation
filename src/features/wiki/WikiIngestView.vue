<script setup lang="ts">
/**
 * 知识库 · 入库：抓链接 / 导本地文件 / 盯源目录 —— 三条路都排进同一条队列。
 *
 * 队列状态机：pending → parsing（抽文本）→ extracted → ingesting（模型编译）→ done / error。
 * 文档默认走**云端解析**（MinerU）：能出真表格、抽图片、OCR 扫描件；云端不可用时自动回落本地通道。
 * 页面上明确标注「文档会上传云端」—— 不偷偷传。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '@/core/sidecar'
import { pendingRaw, refresh, refreshQueue, queue as queueRef, status } from './store'
import WikiShell from './WikiShell.vue'

const url = ref('')
const pathInput = ref('')
const ingestAfterParse = ref(true)
const dragging = ref(false)
const busy = ref('')
const watch = ref<any>(null)
const env = ref<any>(null)
const watchForm = ref({ dirsText: '', enabled: false, autoIngest: false, intervalMin: 30, maxFileSizeMb: 100 })
let timer: ReturnType<typeof setInterval> | null = null

const queue = computed(() => queueRef.value)
const STATUS: Record<string, { text: string; type: 'info' | 'success' | 'warning' | 'danger' }> = {
  pending: { text: '待处理', type: 'info' },
  parsing: { text: '抽文本', type: 'warning' },
  extracted: { text: '已抽文本', type: 'warning' },
  ingesting: { text: '编译中', type: 'warning' },
  done: { text: '完成', type: 'success' },
  error: { text: '失败', type: 'danger' },
}

async function loadWatch() {
  const r = await api.wikiWatch()
  if (!r.ok) return
  watch.value = r.data
  watchForm.value = {
    dirsText: (r.data.dirs ?? []).join('\n'),
    enabled: !!r.data.enabled,
    autoIngest: !!r.data.autoIngest,
    intervalMin: r.data.intervalMin ?? 30,
    maxFileSizeMb: r.data.maxFileSizeMb ?? 100,
  }
}

async function addUrl() {
  const u = url.value.trim()
  if (!u) return
  busy.value = 'url'
  const r = await api.wikiQueueAdd({ kind: 'url', target: u, ingest: ingestAfterParse.value })
  busy.value = ''
  if (!r.ok) return ElMessage.error(r.error ?? '入队失败')
  url.value = ''
  ElMessage.success(r.data?.duplicate ? '队列里已经有这条链接了' : '已入队')
  await poll()
}

async function addPath() {
  const p = pathInput.value.trim()
  if (!p) return
  busy.value = 'path'
  const r = await api.wikiQueueAdd({ kind: 'file', target: p, ingest: ingestAfterParse.value })
  busy.value = ''
  if (!r.ok) return ElMessage.error(r.error ?? '入队失败')
  pathInput.value = ''
  ElMessage.success('已入队')
  await poll()
}

async function addRaw(path: string) {
  busy.value = 'raw'
  const r = await api.wikiQueueAdd({ kind: 'raw', target: path, ingest: true })
  busy.value = ''
  if (!r.ok) return ElMessage.error(r.error ?? '入队失败')
  ElMessage.success('已入队（这份料在 raw/ 里，直接编译）')
  await poll()
}

async function onDrop(e: DragEvent) {
  dragging.value = false
  const files = Array.from(e.dataTransfer?.files ?? [])
  if (!files.length) return
  busy.value = 'upload'
  let ok = 0
  for (const f of files) {
    const r = await api.wikiUpload(f, ingestAfterParse.value)
    if (r.ok) ok += 1
    else ElMessage.error(`${f.name}：${r.error}`)
  }
  busy.value = ''
  if (ok) ElMessage.success(`已收下 ${ok} 个文件并排队`)
  await poll()
}

async function runQueue(limit: number) {
  busy.value = 'run'
  const r = await api.wikiQueueRun(limit)
  busy.value = ''
  if (!r.ok) return ElMessage.error(r.error ?? '跑队列失败')
  if (!r.data?.processed) return ElMessage.info('没有待处理的条目')
  const errs = (r.data.result?.results ?? []).filter((x: any) => !x.ok)
  ElMessage[errs.length ? 'warning' : 'success'](`处理了 ${r.data.processed} 条${errs.length ? `，${errs.length} 条失败（看队列详情）` : ''}`)
  await poll()
  await refresh()
  if (ingestAfterParse.value) await refresh()
}

async function removeItem(id: string) {
  await api.wikiQueueRemove(id)
  await poll()
}
async function clearDone() {
  const r = await api.wikiQueueClear('done')
  ElMessage.success(`清掉 ${r.data?.removed ?? 0} 条已完成`)
  await poll()
}

async function saveWatch() {
  busy.value = 'watch'
  const dirs = watchForm.value.dirsText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  const r = await api.wikiWatchSettings({
    dirs,
    enabled: watchForm.value.enabled,
    autoIngest: watchForm.value.autoIngest,
    intervalMin: watchForm.value.intervalMin,
    maxFileSizeMb: watchForm.value.maxFileSizeMb,
  })
  busy.value = ''
  if (!r.ok) return ElMessage.error(r.error ?? '保存失败')
  ElMessage.success(r.data?.enabled ? '监听已开（边车按周期自动扫）' : '设置已保存（监听关闭）')
  await loadWatch()
}

async function scanNow() {
  busy.value = 'scan'
  const r = await api.wikiWatchScan(true)
  busy.value = ''
  if (!r.ok) return ElMessage.error(r.error ?? '扫描失败')
  const n = r.data?.enqueued ?? 0
  ElMessage[n ? 'success' : 'info'](n ? `发现并排队 ${n} 个新文件` : '没有发现新文件')
  await poll()
}

async function poll() {
  await refreshQueue()
}
function fmt(iso: string) {
  return iso ? String(iso).slice(5, 16).replace('T', ' ') : ''
}

onMounted(async () => {
  if (!status.value) await refresh()
  await poll()
  await loadWatch()
  const e = await api.wikiEnvironment()
  env.value = e.ok ? e.data : null
  timer = setInterval(poll, 3000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <WikiShell title="入库" subtitle="抓链接 / 导本地文件 / 盯源目录 → 抽文本 → 编译成 wiki 页面" icon="Upload">
    <template #actions>
      <el-button size="small" :loading="busy === 'run'" type="primary" @click="runQueue(3)">跑队列（3 条）</el-button>
      <el-button size="small" :disabled="busy === 'run'" @click="runQueue(10)">跑 10 条</el-button>
    </template>

    <div class="wk-cols wk-cols--2">
      <section class="wk-card">
        <h3 class="wk-card__title"><el-icon><Link /></el-icon> 抓外部链接</h3>
        <p class="wk-card__desc">支持 X（Twitter）推文与长文。正文存成 <code>raw/sources/*.md</code>；图片只保留原图链接（本机取不到图床）。</p>
        <div class="ig__row">
          <el-input v-model="url" placeholder="https://x.com/<用户>/status/<id>" @keyup.enter="addUrl" />
          <el-button :loading="busy === 'url'" @click="addUrl">入队</el-button>
        </div>
      </section>

      <section
        class="wk-card ig__drop"
        :class="{ 'is-drag': dragging }"
        @dragover.prevent="dragging = true"
        @dragleave.prevent="dragging = false"
        @drop.prevent="onDrop"
      >
        <h3 class="wk-card__title"><el-icon><Upload /></el-icon> 导入本地文件</h3>
        <p class="wk-card__desc">
          拖到这里，或填绝对路径。支持 pdf / docx / xls(x) / ppt(x) / md / txt / html / csv / 图片。
        </p>
        <div class="wk-chips" style="margin-bottom: 10px">
          <span class="wk-chip" :class="env?.cloud?.ok ? 'wk-chip--ok' : 'wk-chip--warn'">
            云端解析 {{ env?.cloud?.ok ? `开（${env.cloud.modelVersion}${env.cloud.isOcr ? '+OCR' : ''}）` : '不可用' }}
          </span>
          <span class="wk-chip is-static">本地兜底 pandoc {{ env?.pandoc ? '✓' : '✗' }} · LO {{ env?.soffice ? '✓' : '✗' }} · Py {{ env?.python ? '✓' : '✗' }}</span>
        </div>
        <div class="ig__row">
          <el-input v-model="pathInput" placeholder="C:\\资料\\xxx.pdf" @keyup.enter="addPath" />
          <el-button :loading="busy === 'path'" @click="addPath">入队</el-button>
        </div>
      </section>
    </div>

    <p class="wk-hint">
      文档默认送 <b>MinerU 云端</b>解析（能出真表格、抽图片、OCR 扫描件）—— 也就是**文档内容会上传到第三方云端**；
      介意就在设置里关掉，关掉后走本机通道（只能抽文本层、图片与扫描件拿不到）。
      <el-checkbox v-model="ingestAfterParse" size="small" style="margin-left: 8px">入队后顺带编译成页面</el-checkbox>
    </p>

    <section class="wk-card wk-card--flush">
      <div class="wk-card__head">
        <h3 class="wk-card__title"><el-icon><List /></el-icon> 队列（{{ queue?.total ?? 0 }}{{ queue?.running ? ' · 正在跑' : '' }}）</h3>
        <div class="wk-chips">
          <el-button size="small" @click="clearDone">清掉已完成</el-button>
          <el-button size="small" :loading="busy === 'poll'" @click="poll">刷新</el-button>
        </div>
      </div>
      <table v-if="queue?.items?.length" class="wk-table">
        <thead>
          <tr><th>状态</th><th>标题</th><th>来源</th><th>结果</th><th>时间</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="it in queue.items" :key="it.id">
            <td><el-tag size="small" :type="STATUS[it.status]?.type ?? 'info'">{{ STATUS[it.status]?.text ?? it.status }}</el-tag></td>
            <td>{{ it.title }}</td>
            <td class="wk-mono wk-ellipsis" :title="it.target">{{ it.kind }} · {{ it.target }}</td>
            <td>
              <span v-if="it.pages?.length" class="wk-hint--ok">{{ it.pages.join('、') }}</span>
              <span v-else>{{ it.message }}</span>
            </td>
            <td class="wk-num">{{ fmt(it.addedAt) }}</td>
            <td class="rv__actions"><el-button size="small" text type="danger" @click="removeItem(it.id)">移除</el-button></td>
          </tr>
        </tbody>
      </table>
      <div v-else class="wk-empty">队列是空的</div>
    </section>

    <section class="wk-card">
      <div class="wk-card__head">
        <h3 class="wk-card__title"><el-icon><Files /></el-icon> 源目录监听</h3>
        <div class="wk-chips">
          <el-button size="small" @click="watchForm.dirsText = `${status?.root ?? ''}/raw/sources`">填当前库 raw/sources</el-button>
          <el-button size="small" :loading="busy === 'scan'" @click="scanNow">立即扫描并入队</el-button>
        </div>
      </div>
      <p class="wk-card__desc">
        留空 = 只盯当前库的 <code>raw/sources</code>；扫描只看支持的类型、跳过 <code>.git/.obsidian/node_modules</code> 这类目录。
        现在盯：<code>{{ (watch?.dirsResolved ?? []).join('、') || '（未设置）' }}</code>，上次扫描 {{ fmt(watch?.lastScan) || '还没扫过' }}。
      </p>
      <el-input v-model="watchForm.dirsText" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" placeholder="一行一个目录（留空 = raw/sources）" />
      <div class="ig__opts">
        <el-checkbox v-model="watchForm.enabled">开启定时监听</el-checkbox>
        <el-checkbox v-model="watchForm.autoIngest" :disabled="!watchForm.enabled">发现新文件时自动编译（会花模型额度）</el-checkbox>
        <span class="ig__num">每 <el-input-number v-model="watchForm.intervalMin" :min="5" :max="1440" size="small" controls-position="right" /> 分钟</span>
        <span class="ig__num">单文件 ≤ <el-input-number v-model="watchForm.maxFileSizeMb" :min="1" :max="2048" size="small" controls-position="right" /> MB</span>
        <el-button size="small" type="primary" :loading="busy === 'watch'" @click="saveWatch">保存</el-button>
      </div>
    </section>

    <section v-if="pendingRaw.length" class="wk-card">
      <h3 class="wk-card__title" style="margin-bottom: 8px"><el-icon><Timer /></el-icon> 还没编译的料（{{ pendingRaw.length }}）</h3>
      <p class="wk-card__desc">这些文件已经在 <code>raw/sources</code> 里，但还没有对应的 source 页。</p>
      <ul class="wk-list">
        <li v-for="r in pendingRaw" :key="r.path" class="wk-list__row">
          <span class="wk-list__main">
            <span class="wk-list__title wk-mono">{{ r.name }}</span>
            <span class="wk-list__meta">{{ Math.round(r.size / 1024) }} KB</span>
          </span>
          <el-button size="small" text type="primary" :loading="busy === 'raw'" @click="addRaw(r.path)">入队编译</el-button>
        </li>
      </ul>
    </section>
  </WikiShell>
</template>

<style scoped>
.ig__row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.ig__drop {
  border-style: dashed;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.ig__drop.is-drag {
  border-color: var(--ws-accent);
  background: var(--ws-accent-soft);
}
.ig__opts {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  margin-top: 10px;
  font-size: var(--ws-fs-sm);
  color: var(--ws-text-2);
}
.ig__num {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.ig__num :deep(.el-input-number) {
  width: 112px;
}
.rv__actions {
  text-align: right;
  white-space: nowrap;
  width: 1%;
}
</style>
