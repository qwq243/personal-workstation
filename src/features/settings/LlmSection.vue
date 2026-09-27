<script setup lang="ts">
/**
 * 设置 · 模型（「预设 → 解析」）。
 *
 * 三层结构：
 *   预设下拉（厂商/端点/上下文建议）→ 每预设一份配置（端点、模型、key、线协议、上下文、思考模式）
 *   → 任务路由（对话 / 编译 可各点一个预设）。
 * 差异只有一处：多一个「跟随工作台」预设，出厂就能用，不必先配 key。
 *
 * key 存 credentials.json，这里只显示尾号；留空 = 不改（避免一次保存把已存的清掉）。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '@/core/sidecar'

const busy = ref('')
const data = ref<any>(null)
const picked = ref('')
const form = ref({ baseUrl: '', model: '', apiKey: '', apiMode: 'chat_completions', maxContextSize: 128000, reasoning: 'auto', azureApiVersion: '' })
const probe = ref<any>(null)
const routing = ref({ chat: '', ingest: '' })
const custom = ref({ id: '', label: '', baseUrl: '', defaultModel: '' })

const current = computed(() => (data.value?.presets ?? []).find((p: any) => p.id === picked.value) ?? null)
const isWorkstation = computed(() => picked.value === 'workstation')

async function load() {
  const r = await api.wikiLlm()
  if (!r.ok) return ElMessage.error(r.error ?? '读不到模型配置')
  data.value = r.data
  picked.value = data.value.activePresetId
  routing.value = { ...data.value.taskRouting }
  syncForm()
}

function syncForm() {
  const p = current.value
  if (!p) return
  form.value = {
    baseUrl: p.baseUrl ?? '',
    model: p.model ?? '',
    apiKey: '',
    apiMode: p.apiMode ?? 'chat_completions',
    maxContextSize: p.maxContextSize ?? 128000,
    reasoning: p.reasoning ?? 'auto',
    azureApiVersion: '',
  }
  probe.value = null
}

function onPick(id: string) {
  picked.value = id
  syncForm()
}

/** 换预设 = 同时把「当前用哪个」记下来（选中即生效） */
async function activate() {
  busy.value = 'active'
  const r = await api.wikiLlmSave({ activePresetId: picked.value })
  busy.value = ''
  if (!r.ok) return ElMessage.error(r.error ?? '切换失败')
  await load()
  ElMessage.success(`当前预设：${current.value?.label}`)
}

async function savePreset() {
  busy.value = 'save'
  const payload: Record<string, unknown> = {
    id: picked.value,
    baseUrl: form.value.baseUrl,
    model: form.value.model,
    apiMode: form.value.apiMode,
    maxContextSize: Number(form.value.maxContextSize) || 128000,
    reasoning: form.value.reasoning,
  }
  if (form.value.azureApiVersion.trim()) payload.azureApiVersion = form.value.azureApiVersion.trim()
  if (form.value.apiKey.trim()) payload.apiKey = form.value.apiKey.trim()
  const r = await api.wikiLlmSave({ config: payload })
  busy.value = ''
  if (!r.ok) return ElMessage.error(r.error ?? '保存失败')
  await load()
  ElMessage.success('已保存（key 写进 credentials.json）')
}

async function saveRouting() {
  busy.value = 'routing'
  const r = await api.wikiLlmSave({ taskRouting: { chat: routing.value.chat, ingest: routing.value.ingest } })
  busy.value = ''
  if (!r.ok) return ElMessage.error(r.error ?? '保存失败')
  await load()
  ElMessage.success('任务路由已保存（留空 = 用当前预设）')
}

async function testCurrent() {
  busy.value = 'test'
  probe.value = null
  const r = await api.wikiLlmTest(picked.value)
  busy.value = ''
  probe.value = r.ok ? r.data : { ok: false, error: r.error }
  if (probe.value?.ok) ElMessage.success(`连通：${probe.value.model} · ${probe.value.ms}ms`)
  else ElMessage.error(probe.value?.error ?? '连不上')
}

async function addCustom() {
  const id = custom.value.id.trim()
  const baseUrl = custom.value.baseUrl.trim()
  if (!id || !baseUrl) return ElMessage.warning('自定义预设至少要填 id 与端点')
  busy.value = 'custom'
  const list = [...(data.value?.presets ?? []).filter((p: any) => p.custom).map((p: any) => ({ id: p.id, label: p.label, provider: 'custom', baseUrl: p.baseUrl }))]
  list.push({ id, label: custom.value.label.trim() || id, provider: 'custom', baseUrl, defaultModel: custom.value.defaultModel.trim() || undefined })
  const r = await api.wikiLlmSave({ customPresets: list })
  busy.value = ''
  if (!r.ok) return ElMessage.error(r.error ?? '新增失败')
  custom.value = { id: '', label: '', baseUrl: '', defaultModel: '' }
  await load()
  ElMessage.success('自定义预设已加入（点「设为当前」生效）')
}

async function removeCustom(id: string) {
  const list = (data.value?.presets ?? []).filter((p: any) => p.custom && p.id !== id).map((p: any) => ({ id: p.id, label: p.label, provider: 'custom', baseUrl: p.baseUrl }))
  await api.wikiLlmSave({ customPresets: list })
  await load()
  ElMessage.success('已删除自定义预设（其它设置没动）')
}

onMounted(load)
</script>

<template>
  <div class="wk-page">
    <section class="wk-card">
      <div class="wk-card__head">
        <h3 class="wk-card__title">模型预设</h3>
        <span class="wk-chips">
          <span class="wk-chip is-static">对话：{{ data?.resolved?.chat?.label ?? '—' }}{{ data?.resolved?.chat?.model ? ` · ${data.resolved.chat.model}` : '' }}</span>
          <span class="wk-chip is-static">编译：{{ data?.resolved?.ingest?.label ?? '—' }}{{ data?.resolved?.ingest?.model ? ` · ${data.resolved.ingest.model}` : '' }}</span>
        </span>
      </div>
      <p class="wk-card__desc">
        <b>全站唯一的大模型配置</b>：预设只是「端点 + 模型 + 上下文」的预填；每预设各存一份配置，
        换预设不会把上一家的 key 弄丢。「跟随工作台」= 直接用
        <code>newapi.baseUrl</code> + <code>ai.model</code>，密钥取
        <code>credentials.json</code> 的 <code>llm.keys.workstation</code>，不用在这里再配一份。
        知识库的问答与编译、以及别的模块都用这一份。
      </p>

      <div class="st__row">
        <el-select :model-value="picked" class="st__select" filterable @change="onPick">
          <el-option v-for="p in data?.presets ?? []" :key="p.id" :value="p.id" :label="p.label">
            <span>{{ p.label }}</span>
            <span class="st__opt-hint">{{ p.configured ? (p.model || p.baseUrl || '已配置') : '未配置' }}{{ p.usedBy?.length ? ` · 供 ${p.usedBy.join('/')}` : '' }}</span>
          </el-option>
        </el-select>
        <el-button size="small" type="primary" :disabled="current?.active" :loading="busy === 'active'" @click="activate">
          {{ current?.active ? '当前预设' : '设为当前' }}
        </el-button>
        <el-button size="small" :loading="busy === 'test'" @click="testCurrent">测连通</el-button>
        <el-button v-if="current?.custom" size="small" text type="danger" @click="removeCustom(picked)">删除此预设</el-button>
      </div>

      <p v-if="current?.hint" class="wk-hint" style="margin-top: 8px">{{ current.hint }}</p>

      <div v-if="isWorkstation" class="wk-hint" style="margin-top: 10px">
        跟随工作台时不用在这里填任何东西 —— 模型名由「回答上限 / 编译喂入」下面的全局模型决定。
      </div>

      <div v-else class="st__grid-llm">
        <label class="st__field">
          <span>端点（baseUrl）</span>
          <el-input v-model="form.baseUrl" placeholder="https://…/v1" />
        </label>
        <label class="st__field">
          <span>模型名</span>
          <el-input v-model="form.model" placeholder="如 deepseek-chat / gpt-4o-mini" />
        </label>
        <label class="st__field">
          <span>API Key <em v-if="current?.hasKey">（已存：尾号 {{ current.keyTail ?? '****' }}，留空不改）</em></span>
          <el-input v-model="form.apiKey" type="password" show-password :placeholder="current?.hasKey ? '留空 = 不改' : '粘贴 key'" />
        </label>
        <label class="st__field">
          <span>线协议</span>
          <el-select v-model="form.apiMode">
            <el-option label="OpenAI 兼容（chat/completions）" value="chat_completions" />
            <el-option label="Anthropic（messages）" value="anthropic_messages" />
          </el-select>
        </label>
        <label class="st__field">
          <span>上下文窗口</span>
          <el-input-number v-model="form.maxContextSize" :min="4000" :max="2000000" :step="8000" controls-position="right" />
        </label>
        <label class="st__field">
          <span>思考模式</span>
          <el-select v-model="form.reasoning">
            <el-option label="auto（模型自己决定）" value="auto" />
            <el-option label="off（不要思考过程）" value="off" />
            <el-option label="low（少量思考）" value="low" />
            <el-option label="medium（中等思考）" value="medium" />
            <el-option label="high（充分思考）" value="high" />
          </el-select>
        </label>
        <label v-if="current?.provider === 'azure'" class="st__field">
          <span>api-version</span>
          <el-input v-model="form.azureApiVersion" placeholder="如 2024-10-21" />
        </label>
      </div>

      <div v-if="!isWorkstation" class="st__row" style="margin-top: 12px">
        <el-button size="small" type="primary" :loading="busy === 'save'" @click="savePreset">保存这个预设</el-button>
      </div>

      <p v-if="probe" class="wk-hint" :class="probe.ok ? 'wk-hint--ok' : 'wk-hint--warn'" style="margin-top: 10px">
        {{ probe.ok ? `连通正常：${probe.model} · ${probe.ms}ms` : `连不上：${probe.error}` }}
      </p>
    </section>

    <section class="wk-card">
      <h3 class="wk-card__title" style="margin-bottom: 8px">任务路由</h3>
      <p class="wk-card__desc">
        对话与编译可以用不同的预设：例如编译用便宜的、问答用强的。
        留空 = 跟着上面的「当前预设」。
      </p>
      <div class="st__row">
        <span class="st__num">对话</span>
        <el-select v-model="routing.chat" class="st__select" clearable placeholder="跟随当前预设">
          <el-option v-for="p in data?.presets ?? []" :key="p.id" :value="p.id" :label="p.label" />
        </el-select>
        <span class="st__num">编译</span>
        <el-select v-model="routing.ingest" class="st__select" clearable placeholder="跟随当前预设">
          <el-option v-for="p in data?.presets ?? []" :key="p.id" :value="p.id" :label="p.label" />
        </el-select>
        <el-button size="small" type="primary" :loading="busy === 'routing'" @click="saveRouting">保存</el-button>
      </div>
    </section>

    <section class="wk-card">
      <h3 class="wk-card__title" style="margin-bottom: 8px">加一个自定义预设</h3>
      <p class="wk-card__desc">任何 OpenAI 兼容或 Anthropic 兼容端点都能加成预设（中转站、公司内网、本地服务…）。</p>
      <div class="st__row">
        <el-input v-model="custom.id" placeholder="id（英文，如 my-relay）" class="st__name" />
        <el-input v-model="custom.label" placeholder="显示名" class="st__name" />
        <el-input v-model="custom.baseUrl" placeholder="https://…/v1" />
        <el-button size="small" :loading="busy === 'custom'" @click="addCustom">加入</el-button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.st__row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.st__select {
  min-width: 260px;
  flex: 0 0 auto;
}
.st__opt-hint {
  margin-left: 10px;
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-3);
}
.st__name {
  width: 180px;
  flex: 0 0 auto;
}
/* 预设字段：两列网格，窄屏塌成一列 */
.st__grid-llm {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 12px 14px;
  margin-top: 12px;
}
.st__field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-3);
}
.st__field em {
  font-style: normal;
  color: var(--ws-success);
}
</style>
