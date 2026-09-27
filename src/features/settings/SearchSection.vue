<script setup lang="ts">
/**
 * 设置 · 网络搜索与本地文件检索。
 *
 * 7 家 provider 的字段与提示按各家公开文档写：需要 key 的四家（tavily/serpapi/brave/bocha）、
 * 一个只要 URL 的（searxng）、一个可匿名可带 key 的（firecrawl）、一个要 key 但要 ollama.com 的（ollama）。
 * 另有「本机文件」：AnyTXT 的 JSON-RPC 服务（未装时这里会明确说连不上，不会假装搜到了）。
 *
 * 结果来源（defaultSource）决定问答默认检索哪儿：库内 / 网络 / 本机文件 / 全部。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '@/core/sidecar'

const busy = ref('')
const data = ref<any>(null)
const form = ref({ provider: 'none', apiKey: '', serpApiEngine: 'google', searXngUrl: '', searXngCategories: ['general'], ollamaUrl: 'https://ollama.com', defaultSource: 'wiki', maxResults: 10 })
const any = ref({ enabled: false, endpoint: 'http://127.0.0.1:9920/', filterDir: '', filterExt: '', limit: 20 })
const anyStatus = ref<any>(null)
const probe = ref<any>(null)
const sample = ref<any>(null)

const meta = computed(() => (data.value?.providers ?? []).find((p: any) => p.id === form.value.provider) ?? null)
const needKey = computed(() => ['tavily', 'serpapi', 'brave', 'bocha', 'ollama'].includes(form.value.provider))
const needUrl = computed(() => form.value.provider === 'searxng')

async function load() {
  const r = await api.wikiSearchConfig()
  if (!r.ok) return ElMessage.error(r.error ?? '读不到检索配置')
  data.value = r.data
  form.value = {
    provider: r.data.provider,
    apiKey: '',
    serpApiEngine: r.data.serpApiEngine,
    searXngUrl: r.data.searXngUrl,
    searXngCategories: r.data.searXngCategories ?? ['general'],
    ollamaUrl: r.data.ollamaUrl,
    defaultSource: r.data.defaultSource,
    maxResults: r.data.maxResults,
  }
  any.value = { ...r.data.anyTxt }
  probe.value = null
  void checkAny()
}

async function save() {
  busy.value = 'save'
  const patch: Record<string, unknown> = {
    provider: form.value.provider,
    serpApiEngine: form.value.serpApiEngine,
    searXngUrl: form.value.searXngUrl,
    searXngCategories: form.value.searXngCategories,
    ollamaUrl: form.value.ollamaUrl,
    defaultSource: form.value.defaultSource,
    maxResults: Number(form.value.maxResults) || 10,
    anyTxt: { ...any.value, limit: Number(any.value.limit) || 20 },
  }
  if (form.value.apiKey.trim()) patch.apiKey = form.value.apiKey.trim()
  const r = await api.wikiSearchConfigSave(patch)
  busy.value = ''
  if (!r.ok) return ElMessage.error(r.error ?? '保存失败')
  await load()
  ElMessage.success('已保存（key 写进 credentials.json）')
}

async function testSearch() {
  busy.value = 'test'
  probe.value = null
  const r = await api.wikiSearchTest()
  busy.value = ''
  probe.value = r.ok ? r.data : { ok: false, error: r.error }
  if (probe.value?.ok) ElMessage.success(`搜索可用：${probe.value.provider} · ${probe.value.ms}ms`)
  else ElMessage.error(probe.value?.error ?? '搜索不可用')
}

async function runSample() {
  busy.value = 'sample'
  sample.value = null
  const r = await api.wikiWebSearch('知识库 检索', 3)
  busy.value = ''
  if (!r.ok) return ElMessage.error(r.error ?? '搜不到')
  sample.value = r.data
  if (!r.data?.total) ElMessage.warning('搜到了 0 条（provider 通了但没结果）')
}

async function checkAny() {
  const r = await api.wikiAnyTxtStatus()
  anyStatus.value = r.ok ? r.data : { running: false, error: r.error }
}

onMounted(load)
</script>

<template>
  <div class="wk-page">
    <section class="wk-card">
      <div class="wk-card__head">
        <h3 class="wk-card__title">网络搜索</h3>
        <span class="wk-chip" :class="data?.ready ? 'wk-chip--ok' : 'wk-chip--warn'">{{ data?.ready ? '已就绪' : '未配置' }}</span>
      </div>
      <p class="wk-card__desc">
        <b>全站共用的检索配置</b>。问答时可以把网络结果一并作为材料（在问答页勾选「网络」）。各家的协议与结果上限见下面 provider 列表：
        部分 provider 在受限网络下可能不可达，按提示换一家即可。
      </p>

      <div class="st__grid-search">
        <label class="st__field">
          <span>Provider</span>
          <el-select v-model="form.provider">
            <el-option v-for="p in data?.providers ?? []" :key="p.id" :value="p.id" :label="p.label" />
          </el-select>
        </label>
        <label v-if="needKey" class="st__field">
          <span>API Key <em v-if="data?.hasKey">（已存：尾号 {{ data.keyTail }}，留空不改）</em></span>
          <el-input v-model="form.apiKey" type="password" show-password :placeholder="data?.hasKey ? '留空 = 不改' : '粘贴 key'" />
        </label>
        <label v-if="form.provider === 'serpapi'" class="st__field">
          <span>搜索引擎</span>
          <el-select v-model="form.serpApiEngine">
            <el-option v-for="e in data?.serpApiEngines ?? []" :key="e.value" :value="e.value" :label="e.label" />
          </el-select>
        </label>
        <label v-if="needUrl" class="st__field">
          <span>SearXNG 实例</span>
          <el-input v-model="form.searXngUrl" placeholder="https://search.example.com" />
        </label>
        <label v-if="needUrl" class="st__field">
          <span>分类</span>
          <el-select v-model="form.searXngCategories" multiple collapse-tags>
            <el-option v-for="c in data?.searxngCategoryOptions ?? []" :key="c" :value="c" :label="c" />
          </el-select>
        </label>
        <label v-if="form.provider === 'ollama'" class="st__field">
          <span>Ollama 地址</span>
          <el-input v-model="form.ollamaUrl" placeholder="https://ollama.com" />
        </label>
        <label class="st__field">
          <span>默认来源（问答）</span>
          <el-select v-model="form.defaultSource">
            <el-option label="只用库内" value="wiki" />
            <el-option label="库内 + 网络" value="web" />
            <el-option label="库内 + 本机文件" value="anytxt" />
            <el-option label="全都开" value="all" />
          </el-select>
        </label>
        <label class="st__field">
          <span>条数上限</span>
          <el-input-number v-model="form.maxResults" :min="1" :max="50" controls-position="right" />
        </label>
      </div>

      <p v-if="meta?.hint" class="wk-hint" style="margin-top: 8px">{{ meta.hint }}</p>

      <div class="st__row" style="margin-top: 12px">
        <el-button size="small" type="primary" :loading="busy === 'save'" @click="save">保存</el-button>
        <el-button size="small" :loading="busy === 'test'" @click="testSearch">测搜索</el-button>
        <el-button size="small" :disabled="!data?.ready" :loading="busy === 'sample'" @click="runSample">试搜一条</el-button>
      </div>

      <p v-if="probe" class="wk-hint" :class="probe.ok ? 'wk-hint--ok' : 'wk-hint--warn'" style="margin-top: 8px">
        {{ probe.ok ? `搜索可用：${probe.provider} · ${probe.ms}ms · ${(probe.sample ?? []).join(' / ')}` : `搜索失败：${probe.error}` }}
      </p>
      <ul v-if="sample?.results?.length" class="wk-list" style="margin-top: 8px">
        <li v-for="(r, i) in sample.results" :key="i" class="wk-list__row">
          <span class="wk-list__main">
            <span class="wk-list__title">{{ r.title }}</span>
            <span class="wk-list__meta">{{ r.source }} · {{ r.url }}</span>
          </span>
        </li>
      </ul>
    </section>

    <section class="wk-card">
      <div class="wk-card__head">
        <h3 class="wk-card__title">本机文件（AnyTXT）</h3>
        <span class="wk-chip" :class="anyStatus?.running ? 'wk-chip--ok' : 'wk-chip--warn'">
          {{ anyStatus?.running ? '服务在跑' : '连不上' }}
        </span>
      </div>
      <p class="wk-card__desc">
        AnyTXT 是全盘文件全文检索工具；工作台通过它的本地 JSON-RPC（默认 <code>127.0.0.1:9920</code>）搜本机文档，
        结果与网络结果一起作为问答材料。<b>这台机器上没装 AnyTXT</b> —— 装好并让它常驻后这里会显示「服务在跑」。
      </p>
      <div class="st__grid-search">
        <label class="st__field">
          <span>服务地址</span>
          <el-input v-model="any.endpoint" placeholder="http://127.0.0.1:9920/" />
        </label>
        <label class="st__field">
          <span>限定目录（可空）</span>
          <el-input v-model="any.filterDir" placeholder="如 C:\\资料（留空 = 不限目录）" />
        </label>
        <label class="st__field">
          <span>限定后缀（可空）</span>
          <el-input v-model="any.filterExt" placeholder="如 pdf;docx;md" />
        </label>
        <label class="st__field">
          <span>条数上限</span>
          <el-input-number v-model="any.limit" :min="1" :max="100" controls-position="right" />
        </label>
      </div>
      <div class="st__row" style="margin-top: 12px">
        <el-checkbox v-model="any.enabled">启用本机文件检索</el-checkbox>
        <el-button size="small" :loading="busy === 'any'" @click="checkAny">重新检测</el-button>
      </div>
      <p v-if="anyStatus && !anyStatus.running" class="wk-hint wk-hint--warn" style="margin-top: 8px">{{ anyStatus.error }}</p>
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
.st__grid-search {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 12px 14px;
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
