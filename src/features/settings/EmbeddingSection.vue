<script setup lang="ts">
/**
 * 设置 · 语义检索（嵌入端点）。
 *
 * 字段：端点 / 模型 / key / 维度（Gemini 的 output_dimensionality，OpenAI 兼容端点会忽略）
 * / 批量 / 并发 / 切块（目标字数 + 重叠）/ 索引上限 / 额外请求头（自建网关鉴权）。
 *
 * **模型是下拉、不是输入框**（2026-09-26）：同一台嵌入服务上往往挂着好几个模型
 * （ollama 上 `bge-m3` / `nomic-embed-text` / `qwen3-embedding`…），得能看见再挑。
 * 「拉取模型」按 OpenAI 兼容的 `/v1/models` 问一次，不认这条路就退回 ollama 的 `/api/tags`；
 * 列不出来也不挡手填（下拉是 allow-create）。
 *
 * **换模型 = 旧索引作废**：不同模型的向量不在一个空间里，余弦相似度算出来是垃圾
 * （维度还可能不同）。所以这里把「索引是用哪个模型建的」摆出来，不一致就标红并提示重建；
 * 语义检索那一侧也会直接拒答（见 lib/wiki-embed.mjs 的 search）。
 *
 * 读写位置：**顶层 `embedding`**。这一段原先读写的是 `wiki.embedding` —— 那是 2026-09-24
 * 全站化之前的旧位置，`migrateScopedConfig()` 搬走之后就没人再看它了，等于「点了保存没反应」。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '@/core/sidecar'

/** 索引状态自己拉：这一段现在是全站设置的一块，不该反过来依赖知识库模块的内部状态 */
const embedStatus = ref(null) as any
async function loadEmbedStatus() {
  const r = await api.wikiEmbed()
  if (r.ok) embedStatus.value = r.data
}

const busy = ref('')
const form = ref({
  enabled: true,
  endpoint: '',
  model: '',
  apiKey: '',
  outputDimensionality: 0,
  batchSize: 8,
  concurrency: 2,
  chunkChars: 500,
  chunkOverlap: 80,
  maxPages: 5000,
  headersText: '{}',
})
const probe = ref<any>(null)
/** 从端点上拉到的可选模型（拉不到就空着，模型名仍可手填） */
const modelOptions = ref<string[]>([])
const modelsMsg = ref('')
/** 保存时如果动了模型名，记一笔，用来提示「索引要重建」 */
const savedModel = ref('')

/** 索引是用别的模型建的 —— 这时候语义检索是拒答的 */
const stale = computed(() => embedStatus.value?.modelStale === true)
const indexModel = computed(() => String(embedStatus.value?.indexModel ?? ''))

async function load() {
  const r = await api.config()
  // 顶层 embedding（全站唯一事实源）；wiki.embedding 是旧位置，不再读
  const em = r.ok ? (r.data?.config?.embedding ?? {}) : {}
  form.value = {
    enabled: em.enabled !== false,
    endpoint: em.endpoint ?? '',
    model: em.model ?? 'bge-m3',
    apiKey: '',
    outputDimensionality: em.outputDimensionality ?? 0,
    batchSize: em.batchSize ?? 8,
    concurrency: em.concurrency ?? 2,
    chunkChars: em.chunkChars ?? 500,
    chunkOverlap: em.chunkOverlap ?? 80,
    maxPages: em.maxPages ?? 5000,
    headersText: JSON.stringify(em.extraHeaders ?? {}, null, 0),
  }
  savedModel.value = String(em.model ?? '')
  await Promise.all([loadEmbedStatus(), pullModels(true)])
}

/** 拉端点上的模型清单。silent=首次自动拉，失败不弹报错（只是没有下拉） */
async function pullModels(silent = false) {
  busy.value = 'models'
  let headers: Record<string, string> = {}
  try {
    const parsed = JSON.parse(form.value.headersText || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) headers = parsed
  } catch {
    /* 下面的保存会报这类错，这里不重复 */
  }
  const r = await api.wikiEmbedModels({
    endpoint: form.value.endpoint,
    apiKey: form.value.apiKey || undefined,
    extraHeaders: headers,
  })
  busy.value = ''
  if (r.ok) {
    modelOptions.value = r.data?.models ?? []
    modelsMsg.value = `从 ${r.data?.via ?? '端点'} 拉到 ${modelOptions.value.length} 个模型`
    if (!silent) ElMessage.success(modelsMsg.value)
  } else {
    modelsMsg.value = ''
    modelOptions.value = []
    if (!silent) ElMessage.warning(r.error ?? '列不出模型（模型名仍可手填）')
  }
}

async function save() {
  let headers: Record<string, string> = {}
  try {
    const parsed = JSON.parse(form.value.headersText || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) headers = parsed
    else throw new Error('要是一个对象')
  } catch (err: any) {
    return ElMessage.error(`额外请求头不是合法 JSON：${err.message}`)
  }
  busy.value = 'save'
  const modelChanged = form.value.model !== savedModel.value
  const patch: Record<string, unknown> = {
    enabled: form.value.enabled,
    endpoint: form.value.endpoint,
    model: form.value.model,
    outputDimensionality: Number(form.value.outputDimensionality) || 0,
    batchSize: Number(form.value.batchSize) || 8,
    concurrency: Number(form.value.concurrency) || 2,
    chunkChars: Number(form.value.chunkChars) || 500,
    chunkOverlap: Number(form.value.chunkOverlap) || 0,
    maxPages: Number(form.value.maxPages) || 5000,
    extraHeaders: headers,
  }
  const r = await api.patchConfig({ embedding: patch })
  busy.value = ''
  if (!r.ok) return ElMessage.error(r.error ?? '保存失败')
  savedModel.value = form.value.model
  if (modelChanged) {
    ElMessage.warning(`已保存。嵌入模型换成了「${form.value.model}」，向量索引必须重建（下面点「建 / 更新索引」）`)
  } else {
    ElMessage.success('已保存')
  }
  await loadEmbedStatus()
}

async function test() {
  busy.value = 'test'
  probe.value = null
  const r = await api.wikiEmbedProbe()
  busy.value = ''
  probe.value = r.ok ? r.data : { ok: false, error: r.error }
  if (probe.value?.ok) ElMessage.success(`端点正常：${probe.value.model} · ${probe.value.dim} 维 · ${probe.value.ms}ms`)
  else ElMessage.error(probe.value?.error ?? '端点不可用')
}

async function build() {
  busy.value = 'build'
  const r = await api.wikiEmbedBuild({})
  busy.value = ''
  if (!r.ok) return ElMessage.error(r.error ?? '建索引失败')
  ElMessage.success(`索引完成：${r.data.indexed}/${r.data.total} 页 · ${r.data.chunks} 块${r.data.failed ? `（${r.data.failed} 页失败）` : ''}`)
  await loadEmbedStatus()
}

async function drop() {
  await api.wikiEmbedDrop()
  ElMessage.success('已清掉向量索引（不影响页面）')
  await loadEmbedStatus()
}

onMounted(load)
</script>

<template>
  <div class="wk-page">
    <section class="wk-card">
      <div class="wk-card__head">
        <h3 class="wk-card__title">嵌入端点</h3>
        <span class="wk-chips">
          <span class="wk-chip is-static">索引 {{ embedStatus?.indexed ?? 0 }}/{{ embedStatus?.pages ?? 0 }} 页</span>
          <span class="wk-chip is-static">{{ embedStatus?.chunks ?? 0 }} 块 · {{ embedStatus?.dim ?? 0 }} 维</span>
          <span v-if="stale" class="wk-chip wk-chip--warn">索引是「{{ indexModel }}」建的，要重建</span>
        </span>
      </div>
      <p class="wk-card__desc">
        <b>全站共用</b>（知识库的语义检索、以及将来别的模块要用向量，都读这一份）：对话走
        <code>chat/completions</code>，这里是 <code>embeddings</code>。端点不通时检索自动退回词法，
        不报错也不假装有语义结果。
      </p>

      <div class="st__grid-embed">
        <label class="st__field st__field--wide">
          <span>端点</span>
          <el-input v-model="form.endpoint" placeholder="http://127.0.0.1:11434/v1/embeddings" />
        </label>
        <label class="st__field">
          <span>模型（下拉里的都是端点上报的，也能自己填）</span>
          <el-select
            v-model="form.model"
            filterable
            allow-create
            default-first-option
            placeholder="bge-m3 / text-embedding-3-small …"
            :loading="busy === 'models'"
            style="width: 100%"
          >
            <el-option v-for="m in modelOptions" :key="m" :value="m" :label="m" />
          </el-select>
        </label>
        <label class="st__field">
          <span>API Key <em>（留空 = 不改）</em></span>
          <el-input v-model="form.apiKey" type="password" show-password placeholder="有的端点要 key" />
        </label>
        <label class="st__field">
          <span>维度（可空）</span>
          <el-input-number v-model="form.outputDimensionality" :min="0" :max="8192" :step="64" controls-position="right" />
        </label>
        <label class="st__field">
          <span>批量</span>
          <el-input-number v-model="form.batchSize" :min="1" :max="128" controls-position="right" />
        </label>
        <label class="st__field">
          <span>并发</span>
          <el-input-number v-model="form.concurrency" :min="1" :max="16" controls-position="right" />
        </label>
        <label class="st__field">
          <span>每块字数</span>
          <el-input-number v-model="form.chunkChars" :min="200" :max="4000" :step="100" controls-position="right" />
        </label>
        <label class="st__field">
          <span>块间重叠</span>
          <el-input-number v-model="form.chunkOverlap" :min="0" :max="1000" :step="20" controls-position="right" />
        </label>
        <label class="st__field">
          <span>最多索引页数</span>
          <el-input-number v-model="form.maxPages" :min="10" :max="100000" :step="500" controls-position="right" />
        </label>
        <label class="st__field st__field--wide">
          <span>额外请求头（JSON，自建网关鉴权用）</span>
          <el-input v-model="form.headersText" placeholder='{"X-Api-Key": "…"}' />
        </label>
      </div>

      <div class="st__row" style="margin-top: 12px">
        <el-checkbox v-model="form.enabled">启用语义检索</el-checkbox>
        <el-button size="small" type="primary" :loading="busy === 'save'" @click="save">保存</el-button>
        <el-button size="small" :loading="busy === 'models'" @click="pullModels(false)">拉取模型</el-button>
        <el-button size="small" :loading="busy === 'test'" @click="test">测端点</el-button>
        <el-button size="small" :loading="busy === 'build'" @click="build">建 / 更新索引</el-button>
        <el-button size="small" :disabled="!embedStatus?.indexed" @click="drop">清索引</el-button>
      </div>

      <p v-if="modelsMsg" class="wk-hint" style="margin-top: 8px">{{ modelsMsg }}</p>
      <p v-if="stale" class="wk-hint wk-hint--warn">
        当前配的是「{{ embedStatus?.model }}」，但向量索引是用「{{ indexModel }}」建的 —— 两者的向量不在同一个
        空间里，语义检索这会儿会直接拒答（词法检索照常）。点上面的「建 / 更新索引」重建即可。
      </p>
      <p v-if="probe" class="wk-hint" :class="probe.ok ? 'wk-hint--ok' : 'wk-hint--warn'" style="margin-top: 8px">
        {{ probe.ok ? `端点正常：${probe.model} · ${probe.dim} 维 · ${probe.ms}ms` : `端点不可用：${probe.error}` }}
      </p>
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
.st__grid-embed {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px 14px;
}
.st__field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-3);
}
.st__field--wide {
  grid-column: span 2;
}
@media (max-width: 900px) {
  .st__field--wide {
    grid-column: span 1;
  }
}
.st__field em {
  font-style: normal;
  color: var(--ws-text-3);
}
</style>
