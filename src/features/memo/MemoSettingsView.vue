<script setup lang="ts">
/**
 * 语音随记 · 配置（`#/memo/settings`）。
 *
 * 三块：
 *   ① 转写后端 —— 一个 OpenAI 兼容的 /audio/transcriptions 端点（provider / 端点 / 模型 / 语言 / 密钥）。
 *      本机跑 whisper.cpp、faster-whisper-server 之类，或直接填云端接口，都是同一个形状。
 *   ② 整理与模型 —— 默认记录类型、总结模型、自动学热词、两套提示词骨架、数据目录与音频占用。
 *   ③ 热词与分类 —— 词库本体（分类 / 词 / 别名 / 预设包 / 批量粘贴）。
 *
 * 「转写后端」这一块的读写走 `/api/memo/asr`（读 = api.memoAsr，写 = 下面那个 saveAsr）：
 * apiKey 是敏感项，不能走 `PATCH /api/config` 的白名单（那一套只放行 config 里声明过的子字段）。
 */
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageHeader from '@/components/PageHeader.vue'
import SidecarOffline from '@/components/SidecarOffline.vue'
import { api, ensureSidecar, sidecarBase, sidecarToken } from '@/core/sidecar'
import { useUiStore } from '@/core/ui'

const router = useRouter()
const ui = useUiStore()
const ready = ref(false)
const loading = ref(true)

/* ------------------------------------------------------------------ 转写后端 --- */
const asr = ref<any>(null)
const asrForm = ref<{ provider: string; baseUrl: string; model: string; language: string; timeoutSec: number; apiKey: string }>({
  provider: 'openai',
  baseUrl: '',
  model: 'whisper-1',
  language: '',
  timeoutSec: 600,
  apiKey: '',
})
const asrSaving = ref(false)
const asrTesting = ref(false)

/**
 * 写转写后端。core/sidecar.ts 里没有这一项（本次只加 lib 与页面），
 * 所以这里自己发一次请求 —— 地址与令牌都从 core/sidecar 导出的函数取，别在页面里硬编码端口。
 * 带 20s 超时：请求吊着的话保存按钮会一直转，比报个错更难查。
 */
async function saveAsr(patch: Record<string, unknown>) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 20000)
  const token = sidecarToken()
  try {
    const res = await fetch(`${sidecarBase()}/api/memo/asr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-WS-Token': token } : {}) },
      body: JSON.stringify(patch),
      signal: ctl.signal,
    })
    const json: any = await res.json().catch(() => null)
    if (!res.ok) return { ok: false, error: json?.error ?? `HTTP ${res.status}` }
    return json ?? { ok: false, error: '边车没回内容' }
  } catch (err: any) {
    const aborted = err?.name === 'AbortError'
    return { ok: false, error: aborted ? '请求超时（20s）' : '连不上边车服务（可能没启动）' }
  } finally {
    clearTimeout(timer)
  }
}

async function loadAsr() {
  const r = await api.memoAsr()
  const d = r.data as any
  if (!r.ok || d?.ok === false) {
    asr.value = d ?? { configured: false, reason: r.error }
    return
  }
  asr.value = d
  asrForm.value = {
    provider: d.provider === 'none' ? 'none' : 'openai',
    baseUrl: d.baseUrl ?? '',
    model: d.model ?? '',
    language: d.language ?? '',
    timeoutSec: Number(d.timeoutSec) || 600,
    // 密钥永远是空的输入框：只显示「已配置 ****abcd」这种提示，明文不下发
    apiKey: '',
  }
}

async function submitAsr() {
  asrSaving.value = true
  const patch: Record<string, unknown> = {
    provider: asrForm.value.provider,
    baseUrl: asrForm.value.baseUrl,
    model: asrForm.value.model,
    language: asrForm.value.language,
    timeoutSec: asrForm.value.timeoutSec,
  }
  // 留空 = 不改（要清密钥就去 credentials.json 删 asr.apiKey）
  if (asrForm.value.apiKey.trim()) patch.apiKey = asrForm.value.apiKey.trim()
  const d: any = await saveAsr(patch)
  asrSaving.value = false
  if (!d.ok) {
    ElMessage.error(d.error ?? '保存失败')
    return
  }
  await loadAsr()
  ElMessage.success('已保存（模块显隐按新配置算，刷新页面后生效）')
}

/** 探活：只能证明「配置齐了」，真正的转写要放一段音频才算数 */
async function testAsr() {
  asrTesting.value = true
  await loadAsr()
  asrTesting.value = false
  if (asr.value?.configured) ElMessage.success(`转写后端可用：${asr.value.baseUrl}（${asr.value.model}）`)
  else ElMessage.warning(asr.value?.reason ?? '还没配齐')
}

/* ------------------------------------------------------------ 整理与模型 --- */
const models = ref<string[]>([])
const defaultModel = ref('')
const model = ref('')
const modelRoute = ref('')
const options = ref<{ type: string; hotwordCategories: string[]; autoHotwords: boolean }>({
  type: 'oral',
  hotwordCategories: [],
  autoHotwords: true,
})

/* 提示词 */
const promptOpen = ref(false)
const promptLoading = ref(false)
const promptSaving = ref(false)
const promptDefaults = ref<Record<string, string>>({})
const promptForm = ref<Record<string, string>>({})
const promptCustomized = ref(false)
const promptFields = [
  { key: 'summarySystem', label: '口述 · 系统提示词', hint: '管态度：怎么对待这份转写、要不要纠错', rows: 5 },
  { key: 'summaryUser', label: '口述 · 要求', hint: '管形状：标题 / 摘要 / 栏目怎么写，必须含 {{transcript}}', rows: 16 },
  { key: 'interviewSystem', label: '访谈 · 系统提示词', hint: '逐字稿纪律：引语是原话、推断单独写、隐私化成代号', rows: 5 },
  { key: 'interviewUser', label: '访谈 · 要求', hint: '受访者 / 关键引语 / 主题与编码 / 待追问，必须含 {{transcript}}', rows: 18 },
]

/* 存储 */
const dirInfo = ref<any>({})
const audioUsage = ref<any>({ count: 0, mb: 0 })

/* ------------------------------------------------------------ 热词与分类 --- */
const hotLoading = ref(false)
const hotBusy = ref(false)
const hotCategories = ref<any[]>([])
const hotPresets = ref<any[]>([])
const hotTotal = ref(0)
const hotPickedId = ref('')
const termDraft = ref<{ term: string; aliases: string; note: string }>({ term: '', aliases: '', note: '' })
const termEditing = ref('')
const termBusy = ref(false)
const batchOpen = ref(false)
const batchText = ref('')
const catDraft = ref('')
const termFormEl = ref<HTMLElement | null>(null)

const hotPicked = computed(() => hotCategories.value.find((c: any) => c.id === hotPickedId.value) ?? null)

function sourceLabel(source: string) {
  return source === 'preset' ? '预设' : source === 'auto' ? '自动' : '手加'
}

async function loadModels() {
  const r = await api.memoModels()
  const d = r.data as any
  if (!r.ok || d?.ok === false) return
  models.value = d.models ?? []
  defaultModel.value = d.default ?? ''
  modelRoute.value = d.provider ?? ''
  model.value = d.chosen ?? ''
}

async function loadOptions() {
  const r = await api.memoOptions()
  const d = r.data as any
  if (!r.ok || d?.ok === false) return
  if (d.options) options.value = { ...options.value, ...d.options }
}

async function setModel() {
  const r = await api.memoSetModel(model.value)
  const d = r.data as any
  if (!r.ok || d?.ok === false) {
    ElMessage.error(d?.error ?? r.error ?? '换模型失败')
    return
  }
  if (d.models) models.value = d.models
  ElMessage.success(model.value ? `总结改用 ${model.value}` : `总结跟随默认（${defaultModel.value}）`)
}

async function saveOption(patch: Record<string, any>) {
  options.value = { ...options.value, ...patch }
  const r = await api.memoSetOptions(patch)
  const d = r.data as any
  if (!r.ok || d?.ok === false) {
    ElMessage.error(d?.error ?? r.error ?? '设置没存上')
    return
  }
  if (d.options) options.value = { ...options.value, ...d.options }
}

async function saveDefaultCategories(names: string[]) {
  await saveOption({ hotwordCategories: names })
  await loadHotwords()
}

/* 提示词：读「实际生效的那一份」，存「与默认不同才发的那些」 */
async function loadPrompts() {
  promptLoading.value = true
  const r = await api.memoPrompts()
  const d = r.data as any
  promptLoading.value = false
  if (!r.ok || d?.ok === false) return
  promptDefaults.value = d.defaults ?? {}
  promptCustomized.value = Boolean(d.customized)
  const form: Record<string, string> = {}
  for (const f of promptFields) form[f.key] = d.active?.[f.key] ?? d.defaults?.[f.key] ?? ''
  promptForm.value = form
}

function openPrompts() {
  promptOpen.value = true
  void loadPrompts()
}

function useDefaultPrompt(key: string) {
  promptForm.value[key] = promptDefaults.value[key] ?? ''
}

async function savePrompts() {
  promptSaving.value = true
  const payload: Record<string, string> = {}
  for (const f of promptFields) {
    const value = String(promptForm.value[f.key] ?? '').trim()
    // 与默认一样就发空串：服务端把空串当成「这一段回默认」，别把默认值存成自定义
    payload[f.key] = value === String(promptDefaults.value[f.key] ?? '').trim() ? '' : value
  }
  const r = await api.memoSetPrompts(payload)
  promptSaving.value = false
  const d = r.data as any
  if (!r.ok || d?.ok === false) {
    ElMessage.error(d?.error ?? r.error ?? '保存失败')
    return
  }
  promptCustomized.value = Boolean(d.customized)
  ElMessage.success(promptCustomized.value ? '提示词已保存（下一次总结生效）' : '已恢复为默认提示词')
  promptOpen.value = false
}

async function loadStorage() {
  const [dir, usage] = await Promise.all([api.memoDir(), api.memoAudioUsage()])
  const dd = dir.data as any
  const uu = usage.data as any
  if (dd?.ok !== false) dirInfo.value = dd ?? {}
  if (uu?.ok !== false) audioUsage.value = uu ?? {}
}

/* ------------------------------------------------------------ 热词：读写 --- */

async function loadHotwords() {
  hotLoading.value = true
  const r = await api.memoHotwords()
  hotLoading.value = false
  const d = r.data as any
  if (!r.ok || d?.ok === false) return
  applyHotwords(d)
}

function applyHotwords(d: any) {
  hotCategories.value = d?.categories ?? []
  hotPresets.value = d?.presets ?? []
  hotTotal.value = Number(d?.total ?? 0)
  if (!hotCategories.value.some((c: any) => c.id === hotPickedId.value)) hotPickedId.value = hotCategories.value[0]?.id ?? ''
}

async function hotAct(payload: Record<string, any>, okText?: string) {
  hotBusy.value = true
  const r = await api.memoHotwordAct(payload)
  hotBusy.value = false
  const d = r.data as any
  if (!r.ok || d?.ok === false) {
    ElMessage.error(d?.error ?? r.error ?? '操作失败')
    return null
  }
  if (d.categories) applyHotwords(d)
  if (okText) ElMessage.success(okText)
  return d
}

async function addCategory() {
  const name = catDraft.value.trim()
  if (!name) return
  const d = await hotAct({ action: 'category-add', name }, `已建分类「${name}」`)
  if (d?.category?.id) {
    hotPickedId.value = d.category.id
    catDraft.value = ''
  }
}

async function renameCategory(cat: any) {
  let next = ''
  try {
    const r = await ElMessageBox.prompt('分类名', '改名', {
      inputValue: cat.name,
      confirmButtonText: '保存',
      cancelButtonText: '取消',
    })
    next = String(r.value ?? '').trim()
  } catch {
    return
  }
  if (!next || next === cat.name) return
  await hotAct({ action: 'category-update', categoryId: cat.id, patch: { name: next } }, '已改名')
}

async function removeCategory(cat: any) {
  try {
    await ElMessageBox.confirm(`删掉分类「${cat.name}」？里面的 ${cat.count} 个词会一起没。`, '删分类', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await hotAct({ action: 'category-remove', categoryId: cat.id }, '已删掉')
}

async function importPreset(preset: any) {
  if (!hotPickedId.value) {
    ElMessage.warning('先选一个分类（没有就新建一个），预设包是往分类里导')
    return
  }
  const cat = hotPicked.value
  const d = await hotAct({ action: 'import-preset', categoryId: hotPickedId.value, presetId: preset.id })
  if (d) ElMessage.success(`「${preset.name}」→「${cat?.name ?? ''}」：新增 ${d.added ?? 0} 个（并入别名 ${d.merged ?? 0}）`)
}

function resetTermDraft() {
  termDraft.value = { term: '', aliases: '', note: '' }
  termEditing.value = ''
}

function editTerm(item: any) {
  termEditing.value = item.term
  termDraft.value = { term: item.term, aliases: (item.aliases ?? []).join('、'), note: item.note ?? '' }
  // 词表很长时，「改」在下面点、表单在上面 —— 把表单拉进视野，别让人以为没反应
  void nextTick(() => termFormEl.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
}

async function saveTerm() {
  const term = termDraft.value.term.trim()
  if (!term) return
  const patch = { term, aliases: termDraft.value.aliases, note: termDraft.value.note }
  termBusy.value = true
  const d = termEditing.value
    ? await hotAct({ action: 'term-update', categoryId: hotPickedId.value, oldTerm: termEditing.value, patch })
    : await hotAct({ action: 'term-add', categoryId: hotPickedId.value, term: patch })
  termBusy.value = false
  if (d) {
    resetTermDraft()
    ElMessage.success('已保存')
  }
}

async function removeTerm(item: any) {
  const d = await hotAct({ action: 'term-remove', categoryId: hotPickedId.value, term: item.term }, `已删掉「${item.term}」`)
  if (d && termEditing.value === item.term) resetTermDraft()
}

async function moveTerm(item: any, toCategoryId: string) {
  await hotAct({ action: 'term-move', categoryId: hotPickedId.value, toCategoryId, term: item.term }, `「${item.term}」已挪走`)
}

function openBatch() {
  batchText.value = ''
  batchOpen.value = true
}

async function submitBatch() {
  const lines = batchText.value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (!lines.length) {
    ElMessage.warning('一行一个词；要给别名就写「词 | 别名1、别名2」')
    return
  }
  const terms = lines.map((line) => {
    const [term, aliasPart = ''] = line.split(/[|｜]/)
    return { term: term.trim(), aliases: aliasPart.split(/[、,，;；]/).map((a) => a.trim()).filter(Boolean) }
  })
  const cat = hotPicked.value
  const d = await hotAct({ action: 'terms-add', categoryId: hotPickedId.value, terms })
  if (!d) return
  ElMessage.success(`「${cat?.name ?? ''}」新增 ${d.added ?? 0} 个（并入别名 ${d.merged ?? 0}）`)
  batchOpen.value = false
}

/* ------------------------------------------------------------------ 载入 --- */

async function load() {
  loading.value = true
  const ok = await ensureSidecar()
  ready.value = ok
  if (ok) await Promise.all([loadAsr(), loadModels(), loadOptions(), loadHotwords(), loadStorage()])
  loading.value = false
}

onMounted(load)
</script>

<template>
  <div class="ws-page memo">
    <PageHeader title="语音随记 · 配置" subtitle="转写后端、整理方式与热词库，动手之前先在这儿定。" icon="Setting">
      <template #actions>
        <el-button size="small" @click="router.push('/memo')">
          <el-icon><Microphone /></el-icon>&nbsp;去转写
        </el-button>
        <el-button size="small" @click="router.push('/memo/records')">
          <el-icon><Notebook /></el-icon>&nbsp;记录
        </el-button>
      </template>
    </PageHeader>

    <SidecarOffline v-if="!loading && !ready" what="语音随记配置" @ready="load" />
    <template v-else>
      <!-- ====================================================== 转写后端 -->
      <section class="ws-card panel">
        <header class="panel__head">
          <span class="panel__title"><i class="dot" />转写后端</span>
          <span class="ws-dim">
            {{ asr?.configured ? '已配置' : '没配齐' }}
            <template v-if="asr?.baseUrl"> · {{ asr.baseUrl }}</template>
            <template v-if="asr?.hasKey"> · 带密钥 {{ asr.keyHint }}</template>
          </span>
        </header>
        <div class="cfg__grid">
          <div class="field">
            <label>接口类型</label>
            <div class="field__row">
              <el-radio-group v-model="asrForm.provider" size="small">
                <el-radio-button value="openai">OpenAI 兼容</el-radio-button>
                <el-radio-button value="none">关掉</el-radio-button>
              </el-radio-group>
            </div>
          </div>
          <div class="field">
            <label>模型</label>
            <div class="field__row">
              <el-input v-model="asrForm.model" size="small" class="field__ctl" placeholder="whisper-1 / large-v3" />
            </div>
          </div>
          <div class="field cfg__wide">
            <label>端点</label>
            <div class="field__row">
              <el-input v-model="asrForm.baseUrl" size="small" class="field__ctl" placeholder="http://127.0.0.1:8080/v1" />
            </div>
          </div>
          <div class="field">
            <label>语言</label>
            <div class="field__row">
              <el-input v-model="asrForm.language" size="small" class="field__ctl" placeholder="留空让服务端判断（zh / en …）" />
            </div>
          </div>
          <div class="field">
            <label>超时</label>
            <div class="field__row">
              <el-input-number v-model="asrForm.timeoutSec" size="small" :min="30" :max="7200" controls-position="right" />
              <span class="ws-dim">秒</span>
            </div>
          </div>
          <div class="field cfg__wide">
            <label>密钥</label>
            <div class="field__row">
              <el-input
                v-model="asrForm.apiKey"
                size="small"
                class="field__ctl"
                type="password"
                show-password
                :placeholder="asr?.hasKey ? `已配置 ${asr.keyHint}，留空 = 不改` : '本机服务一般不需要；留空 = 不发送 Authorization'"
              />
            </div>
          </div>
          <div class="field cfg__wide">
            <label>操作</label>
            <div class="field__row">
              <el-button size="small" type="primary" :loading="asrSaving" @click="submitAsr">保存</el-button>
              <el-button size="small" :loading="asrTesting" @click="testAsr">检查配置</el-button>
              <span class="ws-dim">
                {{ asr?.reason || `支持 ${(asr?.audioExt ?? []).join(' ')}` }}
              </span>
            </div>
          </div>
        </div>
        <p class="cfg__tip">
          形状是 <code>POST {端点}/audio/transcriptions</code>（multipart：<code>file</code> + <code>model</code>）——
          本机跑（whisper.cpp / faster-whisper-server 之类）或云端都行，换实现就是换端点。
          <b>端点留空 = 语音随记从侧边栏隐藏</b>（「没配 = 不显示」是内核约定，不是坏了）；
          密钥只落在本机的凭据文件里，页面上永远只显示后四位。
        </p>
      </section>

      <!-- ====================================================== 整理与模型 -->
      <section class="ws-card panel">
        <header class="panel__head">
          <span class="panel__title"><i class="dot" />整理与模型</span>
          <span class="ws-dim">模型清单来自 {{ modelRoute || '设置页' }}</span>
        </header>
        <div class="cfg__grid">
          <div class="field">
            <label>默认类型</label>
            <div class="field__row">
              <el-radio-group :model-value="options.type" size="small" @update:model-value="(v: any) => saveOption({ type: v })">
                <el-radio-button value="oral">口述</el-radio-button>
                <el-radio-button value="interview">访谈</el-radio-button>
              </el-radio-group>
            </div>
          </div>
          <div class="field">
            <label>总结模型</label>
            <div class="field__row">
              <el-select v-model="model" size="small" class="field__ctl" :placeholder="`默认（${defaultModel || '跟随设置'}）`" @change="setModel">
                <el-option value="" :label="`默认（${defaultModel || '跟随设置'}）`" />
                <el-option v-for="m in models" :key="m" :value="m" :label="m" />
              </el-select>
            </div>
          </div>
          <div class="field">
            <label>自动学热词</label>
            <div class="field__row">
              <el-switch
                :model-value="options.autoHotwords"
                size="small"
                @update:model-value="(v: any) => saveOption({ autoHotwords: v })"
              />
              <span class="ws-dim">总结时顺手把术语栏与标签收进词库</span>
            </div>
          </div>
          <div class="field">
            <label>提示词</label>
            <div class="field__row">
              <span class="ws-dim">口述 / 访谈两套骨架，共四段</span>
              <span class="field__link">
                <el-button link size="small" @click="openPrompts">编辑提示词</el-button>
                <i v-if="promptCustomized" class="field__mark" />
              </span>
            </div>
          </div>
          <div class="field cfg__wide">
            <label>存储</label>
            <p class="cfg__tip" style="margin: 0">
              数据目录 <code>{{ dirInfo.data || '—' }}</code>；
              原始音频 {{ audioUsage.count }} 份 / {{ audioUsage.mb }} MB（在 <code>audio/</code> 下，转写完不删，留着回放与重跑；
              要清就去「记录」页点「只删录音」，或直接删那个目录里的文件）。
            </p>
          </div>
        </div>
      </section>

      <!-- ====================================================== 热词与分类 -->
      <section class="ws-card panel">
        <header class="panel__head">
          <span class="panel__title"><i class="dot" />热词与分类</span>
          <span class="ws-dim">{{ hotTotal }} 个词 · 纠错与标签都从这儿来</span>
        </header>
        <div v-loading="hotLoading" class="hot hot--page">
          <aside class="hot__cats">
            <ul class="hot__list">
              <li
                v-for="c in hotCategories"
                :key="c.id"
                class="hot__cat"
                :class="{ 'is-active': c.id === hotPickedId }"
                @click="hotPickedId = c.id"
              >
                <div class="hot__cat-name">{{ c.name }}</div>
                <div class="hot__cat-meta">
                  <span>{{ c.count }} 词</span>
                  <span v-if="c.auto">自动 {{ c.auto }}</span>
                </div>
                <div class="hot__cat-ops" @click.stop>
                  <el-button link size="small" @click="renameCategory(c)">改名</el-button>
                  <el-button link size="small" type="danger" @click="removeCategory(c)">删</el-button>
                </div>
              </li>
              <li v-if="!hotCategories.length" class="ws-muted hot__empty">还没有分类：先在下面建一个，再导入预设包。</li>
            </ul>
            <div class="hot__new">
              <el-input v-model="catDraft" size="small" placeholder="新建分类" @keyup.enter="addCategory" />
              <el-button size="small" :loading="hotBusy" @click="addCategory">加</el-button>
            </div>
            <p class="cfg__tip">
              默认分类（不选则全部）：
              <el-button link size="small" :type="!options.hotwordCategories.length ? 'primary' : ''" @click="saveDefaultCategories([])">
                全部
              </el-button>
              <template v-for="c in hotCategories" :key="'d' + c.id">
                <el-button
                  link
                  size="small"
                  :type="options.hotwordCategories.includes(c.name) ? 'primary' : ''"
                  @click="
                    saveDefaultCategories(
                      options.hotwordCategories.includes(c.name)
                        ? options.hotwordCategories.filter((x) => x !== c.name)
                        : [...options.hotwordCategories, c.name],
                    )
                  "
                  >{{ c.name }}</el-button
                >
              </template>
            </p>
          </aside>

          <div class="hot__terms">
            <header class="hot__head">
              <b>{{ hotPicked?.name ?? '先选一个分类' }}</b>
              <span v-if="hotPicked?.note" class="ws-dim">{{ hotPicked.note }}</span>
              <span class="hot__spacer" />
              <el-button size="small" :disabled="!hotPicked" @click="openBatch">批量粘贴</el-button>
              <el-dropdown :disabled="!hotPicked" @command="importPreset">
                <el-button size="small" :disabled="!hotPicked">导入预设<el-icon><ArrowDown /></el-icon></el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item v-for="p in hotPresets" :key="p.id" :command="p">{{ p.name }}（{{ p.count }} 词）</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </header>

            <div ref="termFormEl" class="hot__form" :class="{ 'is-editing': Boolean(termEditing) }">
              <span v-if="termEditing" class="hot__form-tag">改「{{ termEditing }}」</span>
              <el-input v-model="termDraft.term" size="small" placeholder="词（正确写法）" />
              <el-input v-model="termDraft.aliases" size="small" placeholder="常见错写，顿号分隔" />
              <el-input v-model="termDraft.note" size="small" placeholder="备注（可空）" />
              <el-button size="small" type="primary" :loading="termBusy" :disabled="!hotPicked" @click="saveTerm">
                {{ termEditing ? '保存' : '新增' }}
              </el-button>
              <el-button v-if="termEditing" size="small" @click="resetTermDraft">取消</el-button>
            </div>

            <!-- 手机档换卡片：5 列（词 170 + 常见错写 200 + 来源 82 + 命中 68 + 操作 112）
                 最小合计 632px，手机上要左右拖才看得到右侧三个操作按钮。 -->
            <div v-if="ui.isMobile" class="ws-cards">
              <div v-for="row in hotPicked?.terms ?? []" :key="row.term" class="ws-cards__item">
                <div class="ws-cards__head">
                  <div class="ws-cards__title">{{ row.term }}</div>
                </div>
                <div class="ws-cards__sub">
                  <span v-if="(row.aliases ?? []).length" class="hot__aliases">{{ row.aliases.join('、') }}</span>
                  <span v-else class="ws-muted">—</span>
                </div>
                <div class="ws-cards__fields">
                  <span class="ws-cards__field">
                    <span class="ws-cards__field-k">来源</span>
                    <span class="ws-cards__field-v">
                      <span class="src" :class="`src--${row.source}`">{{ sourceLabel(row.source) }}</span>
                    </span>
                  </span>
                  <span class="ws-cards__field">
                    <span class="ws-cards__field-k">命中</span>
                    <span class="ws-cards__field-v" :class="{ 'ws-muted': !row.hits }">{{ row.hits || '—' }}</span>
                  </span>
                </div>
                <div class="ws-cards__act">
                  <el-button size="small" @click="editTerm(row)"><el-icon><EditPen /></el-icon>&nbsp;改</el-button>
                  <el-dropdown trigger="click" @command="(id: string) => moveTerm(row, id)">
                    <el-button size="small"><el-icon><Switch /></el-icon>&nbsp;挪分类</el-button>
                    <template #dropdown>
                      <el-dropdown-menu>
                        <el-dropdown-item
                          v-for="c in hotCategories.filter((x: any) => x.id !== hotPickedId)"
                          :key="c.id"
                          :command="c.id"
                          >挪到「{{ c.name }}」</el-dropdown-item
                        >
                        <el-dropdown-item v-if="hotCategories.length < 2" disabled>没有别的分类</el-dropdown-item>
                      </el-dropdown-menu>
                    </template>
                  </el-dropdown>
                  <el-button size="small" type="danger" plain @click="removeTerm(row)">
                    <el-icon><Delete /></el-icon>&nbsp;删
                  </el-button>
                </div>
              </div>
            </div>

            <el-table v-else :data="hotPicked?.terms ?? []" size="small" max-height="46vh" class="hot__table">
              <el-table-column prop="term" label="词" width="170" show-overflow-tooltip />
              <el-table-column label="常见错写" min-width="200">
                <template #default="{ row }">
                  <span v-if="(row.aliases ?? []).length" class="hot__aliases">{{ row.aliases.join('、') }}</span>
                  <span v-else class="ws-muted">—</span>
                </template>
              </el-table-column>
              <el-table-column label="来源" width="82" align="center">
                <template #default="{ row }">
                  <span class="src" :class="`src--${row.source}`">{{ sourceLabel(row.source) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="命中" width="68" align="center">
                <template #default="{ row }">
                  <span :class="{ 'ws-muted': !row.hits }">{{ row.hits || '—' }}</span>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="112" align="right">
                <template #default="{ row }">
                  <div class="hot__ops">
                    <el-tooltip content="改这个词与别名" placement="top" :show-after="300">
                      <el-button link size="small" @click="editTerm(row)"><el-icon><EditPen /></el-icon></el-button>
                    </el-tooltip>
                    <el-dropdown trigger="click" @command="(id: string) => moveTerm(row, id)">
                      <el-tooltip content="挪到别的分类" placement="top" :show-after="300">
                        <el-button link size="small"><el-icon><Switch /></el-icon></el-button>
                      </el-tooltip>
                      <template #dropdown>
                        <el-dropdown-menu>
                          <el-dropdown-item
                            v-for="c in hotCategories.filter((x: any) => x.id !== hotPickedId)"
                            :key="c.id"
                            :command="c.id"
                            >挪到「{{ c.name }}」</el-dropdown-item
                          >
                          <el-dropdown-item v-if="hotCategories.length < 2" disabled>没有别的分类</el-dropdown-item>
                        </el-dropdown-menu>
                      </template>
                    </el-dropdown>
                    <el-tooltip content="删掉这个词" placement="top" :show-after="300">
                      <el-button link size="small" class="hot__del" @click="removeTerm(row)">
                        <el-icon><Delete /></el-icon>
                      </el-button>
                    </el-tooltip>
                  </div>
                </template>
              </el-table-column>
              <template #empty>
                <p class="hot__table-empty">
                  「{{ hotPicked?.name ?? '这个分类' }}」还没有词：右上「导入预设」从预设包导，或在上面手动加 / 批量粘贴。
                </p>
              </template>
            </el-table>

            <p class="hot__foot ws-dim">
              纠错按「别名 → 词」先在本地替换一遍，再交给模型复核；标签优先从这里挑。改完对下一次整理生效。
            </p>
          </div>
        </div>
      </section>
    </template>

    <!-- ====================================================== 提示词弹窗 -->
    <el-dialog v-model="promptOpen" title="给 AI 的提示词" width="800px" top="5vh" append-to-body>
      <p v-pre class="prompt-hint">
        占位符会在每次调用时替换：{{transcript}} 转写原文、{{plain}} 不带时间码的原文、{{hotwords}} 热词表、
        {{categories}} 分类候选、{{focus}} 这次的重点、{{duration}} 音频时长、{{chars}} 字数、{{type}} 记录类型。
        两个「要求」里必须保留 {{transcript}}（或 {{plain}}），否则保存会被拒绝。改完<b>下一次整理生效</b>，
        已经生成的记录不会跟着变。长稿（超约 1500 字）会先按段详析再合并，分段那一步复用这两套模板。
      </p>
      <div v-loading="promptLoading" class="prompt-list">
        <div v-for="f in promptFields" :key="f.key" class="prompt-row">
          <div class="prompt-row__head">
            <b>{{ f.label }}</b>
            <span class="ws-dim">{{ f.hint }}</span>
            <el-button link size="small" @click="useDefaultPrompt(f.key)">用默认</el-button>
          </div>
          <el-input
            v-model="promptForm[f.key]"
            type="textarea"
            :autosize="{ minRows: f.rows, maxRows: f.rows + 6 }"
            spellcheck="false"
          />
        </div>
      </div>
      <template #footer>
        <span class="ws-dim prompt-foot">{{ promptCustomized ? '当前：有自定义' : '当前：全部默认' }}</span>
        <el-button @click="promptOpen = false">取消</el-button>
        <el-button type="primary" :loading="promptSaving" @click="savePrompts">保存</el-button>
      </template>
    </el-dialog>

    <!-- ====================================================== 批量加词 -->
    <el-dialog v-model="batchOpen" title="批量加词" width="620px" append-to-body>
      <p v-pre class="prompt-hint">一行一个词；要给别名就写「词 | 别名1、别名2」。同名词自动并入别名，不会重复。</p>
      <el-input
        v-model="batchText"
        type="textarea"
        :autosize="{ minRows: 8, maxRows: 18 }"
        spellcheck="false"
        placeholder="登录 | 登陆、登路
阈值 | 阀值、域值"
      />
      <template #footer>
        <span class="ws-dim prompt-foot">导入到「{{ hotPicked?.name ?? '—' }}」</span>
        <el-button @click="batchOpen = false">取消</el-button>
        <el-button type="primary" :loading="hotBusy" @click="submitBatch">加进去</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style>
@import './memo.css';
</style>
