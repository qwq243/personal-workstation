<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import { useUiStore, type ThemeMode } from '@/core/ui'
import { exportAll, importAll, listKeys, loadJSON, removeJSON, usedBytes } from '@/core/storage'
import { getModules } from '@/core/registry'
import { api, ensureSidecar, sidecarBase, sidecarState } from '@/core/sidecar'
import LlmSection from '@/features/settings/LlmSection.vue'
import EmbeddingSection from '@/features/settings/EmbeddingSection.vue'
import SearchSection from '@/features/settings/SearchSection.vue'

const ui = useUiStore()
const keys = ref(listKeys())
const busy = ref(false)

const sidecar = ref<{ online: boolean; info: any } | null>(null)
const overview = ref<any>(null)

async function checkSidecar() {
  const ok = await ensureSidecar(true)
  sidecar.value = { online: ok, info: null }
  if (ok) {
    const r = await api.overview()
    overview.value = r.ok ? r.data : null
    const h = await api.health()
    if (h.ok) sidecar.value.info = h.data
  } else {
    overview.value = null
  }
}

onMounted(checkSidecar)

const modules = computed(() => getModules())
const sizeText = computed(() => {
  const b = usedBytes()
  return b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`
})

const themeOptions: { label: string; value: ThemeMode }[] = [
  { label: '浅色', value: 'light' },
  { label: '深色', value: 'dark' },
  { label: '跟随系统', value: 'auto' },
]

function refresh() {
  keys.value = listKeys()
}

function download(filename: string, text: string) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function doExport() {
  const data = exportAll()
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  download(`workstation-backup-${stamp}.json`, JSON.stringify(data, null, 2))
  ElMessage.success('已导出备份文件')
}

async function onImportFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    const text = await file.text()
    const data = JSON.parse(text) as Record<string, unknown>
    const n = importAll(data)
    refresh()
    ElMessage.success(`已恢复 ${n} 条数据，刷新页面后生效`)
  } catch (err) {
    ElMessage.error('导入失败：文件不是合法的备份 JSON')
    console.warn(err)
  }
  input.value = ''
}

async function clearKey(key: string) {
  await ElMessageBox.confirm(`确定删除「${key}」这条数据吗？此操作不可撤销。`, '删除确认', {
    type: 'warning',
    confirmButtonText: '删除',
    cancelButtonText: '取消',
  })
  removeJSON(key)
  refresh()
  ElMessage.success('已删除')
}

async function clearAll() {
  await ElMessageBox.confirm(
    '将清空本工作站的全部本地数据（所有功能的词单、进度、设置）。建议先导出备份。',
    '清空全部数据',
    { type: 'error', confirmButtonText: '全部清空', cancelButtonText: '取消' },
  )
  for (const k of listKeys()) removeJSON(k)
  refresh()
  ElMessage.success('已清空全部数据，刷新页面后生效')
}

function previewOf(key: string): string {
  const v = loadJSON(key, null)
  const s = JSON.stringify(v)
  return s.length > 60 ? `${s.slice(0, 60)}…` : s
}

async function copyMcp() {
  try {
    await navigator.clipboard.writeText(`${sidecarBase()}/mcp`)
    ElMessage.success('已复制 MCP 端点')
  } catch {
    ElMessage.warning(`请手动复制：${sidecarBase()}/mcp`)
  }
}

/* ------------------------------------------------------------- 服务配置 ---
   这些以前只能改 server/config.json。放进设置页是因为它们是「本机路径/地址」
   这类会被环境变化打破的东西（换个目录、端口被占、换成别处的服务）。
   服务端是白名单式 PATCH：没列上的字段会被拒绝并在 rejected 里点名，
   免得一个手滑把边车自己的配置写坏（写坏就连设置页都打不开了）。
*/
const configForm = ref<any>(null)
const configDefaults = ref<any>(null)
const configBusy = ref(false)
const configLoaded = ref(false)

/** 从接口返回值里挑出可编辑字段，做成表单（不把整个配置摆到页面上） */
function toForm(c: any) {
  return {
    newapi: { baseUrl: c?.newapi?.baseUrl ?? '' },
    ai: {
      model: c?.ai?.model ?? '',
      models: Array.isArray(c?.ai?.models) ? c.ai.models.join(', ') : '',
      persona: c?.ai?.persona ?? '',
    },
    asr: {
      provider: c?.asr?.provider === 'none' ? 'none' : 'openai',
      baseUrl: c?.asr?.baseUrl ?? '',
      model: c?.asr?.model ?? '',
    },
    wiki: { dir: c?.wiki?.dir ?? '' },
    docparse: {
      tools: {
        pandoc: c?.docparse?.tools?.pandoc ?? '',
        soffice: c?.docparse?.tools?.soffice ?? '',
        python: c?.docparse?.tools?.python ?? '',
        pdftotext: c?.docparse?.tools?.pdftotext ?? '',
      },
    },
    pguard: { enabled: c?.pguard?.enabled !== false, dataDir: c?.pguard?.dataDir ?? '' },
    startupDir: c?.startupDir ?? '',
  }
}

async function loadConfigForm() {
  const r = await api.config()
  if (!r.ok || !r.data?.config) {
    configLoaded.value = false
    return
  }
  configForm.value = toForm(r.data.config)
  // 默认值也来自服务端（DEFAULTS），不在前端硬编码 —— 两份默认值必然漂移
  configDefaults.value = toForm(r.data.defaults)
  configLoaded.value = true
}

async function saveConfigForm() {
  if (!configForm.value) return
  configBusy.value = true
  try {
    const f = configForm.value
    const r = await api.patchConfig({
      newapi: { baseUrl: f.newapi.baseUrl },
      ai: {
        model: f.ai.model,
        // 逗号 / 换行分隔都认，空串 = 不下发（避免把已有清单清空）
        ...(f.ai.models.trim() ? { models: f.ai.models.split(/[,，\n]/).map((x: string) => x.trim()).filter(Boolean) } : {}),
        persona: f.ai.persona,
      },
      asr: { provider: f.asr.provider, baseUrl: f.asr.baseUrl, model: f.asr.model },
      wiki: { dir: f.wiki.dir },
      docparse: { tools: { ...f.docparse.tools } },
      pguard: { enabled: f.pguard.enabled, dataDir: f.pguard.dataDir },
      startupDir: f.startupDir,
    })
    const d = (r.data ?? {}) as any
    if (!r.ok || d.ok === false) {
      ElMessage.error(d.error ?? r.error ?? '保存失败')
      return
    }
    const rejected = (d.rejected ?? []) as string[]
    if (rejected.length) ElMessage.warning(`已保存，但这些字段被拒绝：${rejected.join('、')}`)
    else ElMessage.success('已保存（地址/目录改动在相关服务重启后生效）')
    await loadConfigForm()
  } finally {
    configBusy.value = false
  }
}

async function resetConfigForm() {
  await loadConfigForm()
  ElMessage.info('已还原为当前保存的配置')
}

/** 填回默认值（不自动保存，让人先看一眼改了什么） */
function fillConfigDefaults() {
  if (!configDefaults.value) {
    ElMessage.warning('还没取到默认值')
    return
  }
  // startupDir 不动：它是这台机器的实际启动文件夹，默认值未必等于现状
  const keepStartup = configForm.value?.startupDir
  configForm.value = { ...structuredClone(configDefaults.value), startupDir: keepStartup }
  ElMessage.info('已填回默认值，确认无误后点「保存」')
}

onMounted(checkSidecar)
onMounted(loadConfigForm)

/* ---- 全站能力：文档解析 / 输出语言 / 代理（2026-09-24 从知识库设置提上来） ---- */
const docForm = ref({ enabled: true, modelVersion: 'vlm', language: 'ch', isOcr: true, timeoutSec: 300, token: '' })
const docProbe = ref(null) as any
const busyDoc = ref('')
const outForm = ref({ language: 'Chinese' })
const netForm = ref({ enabled: false, url: '' })
const busyOut = ref('')
const env = ref(null) as any

async function loadGlobalCapabilities() {
  const [c, e] = await Promise.all([api.config(), api.wikiEnvironment()])
  const cfgv = c.ok ? c.data?.config ?? null : null
  const mc = cfgv?.docparse?.mineru ?? {}
  docForm.value = {
    enabled: mc.enabled !== false,
    modelVersion: mc.modelVersion ?? 'vlm',
    language: mc.language ?? 'ch',
    isOcr: mc.isOcr !== false,
    timeoutSec: mc.timeoutSec ?? 300,
    token: '',
  }
  outForm.value = { language: cfgv?.outputLanguage ?? 'Chinese' }
  netForm.value = { enabled: cfgv?.network?.proxy?.enabled === true, url: cfgv?.network?.proxy?.url ?? '' }
  env.value = e.ok ? e.data : null
}

async function saveDoc() {
  busyDoc.value = 'save'
  const patch: { enabled: boolean; modelVersion: string; language: string; isOcr: boolean; timeoutSec: number; token?: string } = {
    enabled: docForm.value.enabled,
    modelVersion: docForm.value.modelVersion,
    language: docForm.value.language,
    isOcr: docForm.value.isOcr,
    timeoutSec: Number(docForm.value.timeoutSec) || 300,
  }
  if (docForm.value.token.trim()) patch.token = docForm.value.token.trim()
  const r = await api.wikiMineruSave(patch)
  busyDoc.value = ''
  if (!r.ok) return ElMessage.error(r.error ?? '保存失败')
  ElMessage.success('已保存')
  docForm.value.token = ''
  await loadGlobalCapabilities()
}

async function testDoc() {
  busyDoc.value = 'test'
  docProbe.value = null
  const r = await api.wikiMineruTest()
  busyDoc.value = ''
  docProbe.value = r.ok ? r.data : { ok: false, error: r.error }
}

async function saveOut() {
  busyOut.value = 'out'
  const r = await api.patchConfig({ outputLanguage: outForm.value.language })
  busyOut.value = ''
  if (!r.ok) return ElMessage.error(r.error ?? '保存失败')
  ElMessage.success('已保存')
}

async function saveNet() {
  busyOut.value = 'net'
  const r = await api.patchConfig({ network: { proxy: { enabled: netForm.value.enabled, url: netForm.value.url.trim() } } })
  busyOut.value = ''
  if (!r.ok) return ElMessage.error(r.error ?? '保存失败')
  ElMessage.success('已保存（下一次外呼生效）')
}

onMounted(loadGlobalCapabilities)
</script>

<template>
  <div class="ws-page">
    <PageHeader title="设置与数据" subtitle="外观偏好、本地数据备份与恢复" icon="Setting" />

    <div class="ws-card block">
      <div class="block__title">本地边车服务</div>
      <div class="block__row">
        <span class="dot" :class="sidecar?.online ? 'dot--ok' : 'dot--off'" />
        <b>{{ sidecar?.online ? '已连接' : '未连接' }}</b>
        <code class="ws-mono ws-dim">{{ sidecarBase() }}</code>
        <el-button size="small" @click="checkSidecar">重新检测</el-button>
        <span class="ws-spacer" />
        <span class="ws-dim" v-if="sidecar?.online && overview">
          连续记录 {{ overview.streak ?? 0 }} 天 ·
          今日花费 ¥{{ overview.spend?.totalYuan ?? 0 }} · AI {{ overview.ai?.provider || '未配置' }}
        </span>
      </div>
      <div v-if="sidecar && !sidecar.online" class="sidecar-help">
        边车负责代理外部端点、读写本地数据、给智能体提供 MCP。所有请求只在本机内。启动方式：
        <code class="ws-mono">npm run server</code> 或双击项目根目录的
        <code class="ws-mono">启动工作站.cmd</code>。
      </div>
    </div>

    <div class="ws-card block">
      <div class="block__title">「跟随工作台」这一档模型</div>
      <div class="block__row">
        <span class="block__label">当前模型</span>
        <code class="ws-mono">{{ overview?.ai?.model ?? '—' }}</code>
        <span class="ws-dim">provider：{{ overview?.ai?.provider ?? '—' }}</span>
        <span v-if="overview?.ai?.models?.length" class="ws-dim">可用：{{ overview.ai.models.join(' / ') }}</span>
      </div>
      <div class="ws-dim" style="margin-top: 10px; font-size: 12.5px; line-height: 1.7">
        「跟随工作台」是模型预设里的一档：它不自己填端点与密钥，而是读
        <code class="ws-mono">newapi.baseUrl</code>（下面「服务与外部依赖」里填）+ 模型名
        <code class="ws-mono">ai.model</code>，密钥取
        <code class="ws-mono">credentials.json</code> 的
        <code class="ws-mono">llm.keys.workstation</code>（在下面「大模型」里填）。
        浏览器始终不接触密钥 —— 请求都经边车代理。
      </div>
    </div>

    <!-- ------------------------------------------------ 全站能力（2026-09-24 从各模块提上来）
         这几件以前散在知识库的设置里：大模型、语义检索、网络搜索、文档解析、输出语言、代理。
         它们是「工作台的能力」，不是某个模块的私产 —— 放这里一份，谁要谁调。 -->

    <div class="ws-card block">
      <div class="block__title">大模型</div>
      <div class="ws-dim" style="margin-bottom: 10px; font-size: 12.5px">
        全站唯一的一份模型配置：知识库的问答与编译、以及将来别的模块都读它。预设列表与任务路由都在下面。
      </div>
      <LlmSection />
    </div>

    <div class="ws-card block">
      <div class="block__title">语义检索（嵌入端点）</div>
      <EmbeddingSection />
    </div>

    <div class="ws-card block">
      <div class="block__title">网络搜索（含本机文件）</div>
      <SearchSection />
    </div>

    <div class="ws-card block">
      <div class="block__title">文档解析</div>
      <div class="ws-dim" style="margin-bottom: 10px; font-size: 12.5px">
        导入 pdf / docx / ppt / xls / 图片时用哪条通道：默认送云端 MinerU（真表格 + 抽图 + 扫描件 OCR），
        失败自动回落本机（pandoc / LibreOffice / Python / pdftotext）。<b>文档会上传第三方云端</b>，介意可在此关掉。
      </div>
      <div class="block__row">
        <el-checkbox v-model="docForm.enabled">启用云端解析</el-checkbox>
        <el-select v-model="docForm.modelVersion" style="width: 260px" size="small">
          <el-option label="vlm（视觉大模型，扫描件/复杂版式更稳）" value="vlm" />
          <el-option label="pipeline（传统流水线）" value="pipeline" />
        </el-select>
        <el-select v-model="docForm.language" style="width: 130px" size="small">
          <el-option label="中文 ch" value="ch" />
          <el-option label="英文 en" value="en" />
          <el-option label="自动 auto" value="auto" />
        </el-select>
        <el-checkbox v-model="docForm.isOcr">开 OCR</el-checkbox>
        <el-input v-model="docForm.token" type="password" show-password placeholder="令牌（留空 = 不改）" style="width: 240px" />
        <el-button size="small" type="primary" :loading="busyDoc === 'save'" @click="saveDoc">保存</el-button>
        <el-button size="small" :loading="busyDoc === 'test'" @click="testDoc">测云端</el-button>
        <span v-if="docProbe" class="ws-dim" :style="{ color: docProbe.ok ? 'var(--ws-success)' : 'var(--ws-danger)' }">
          {{ docProbe.ok ? `云端可用：${docProbe.modelVersion} · ${docProbe.ms}ms` : `不可用：${docProbe.error}` }}
        </span>
      </div>
      <div class="block__row" style="margin-top: 10px">
        <span class="ws-dim">本机通道：</span>
        <span class="ws-dim">pandoc {{ env?.pandoc ? '✓' : '✗' }} · LibreOffice {{ env?.soffice ? '✓' : '✗' }} ·
          Python {{ env?.python ? '✓' : '✗' }} · pdftotext {{ env?.pdftotext ? '✓' : '✗' }} ·
          AnyTXT {{ env?.anyTxt?.running ? '在跑' : '未装/未启动' }}</span>
      </div>
    </div>

    <div class="ws-card block">
      <div class="block__title">输出与网络</div>
      <div class="block__row">
        <span class="ws-dim">输出语言</span>
        <el-select v-model="outForm.language" size="small" style="width: 180px">
          <el-option label="中文" value="Chinese" />
          <el-option label="English" value="English" />
          <el-option label="不强制（跟随资料）" value="auto" />
        </el-select>
        <el-button size="small" :loading="busyOut === 'out'" @click="saveOut">保存</el-button>
        <span class="ws-spacer" />
        <el-checkbox v-model="netForm.enabled">走代理</el-checkbox>
        <el-input v-model="netForm.url" size="small" placeholder="http://127.0.0.1:7890" style="width: 220px" />
        <el-button size="small" :loading="busyOut === 'net'" @click="saveNet">保存</el-button>
      </div>
      <div class="ws-dim" style="margin-top: 8px; font-size: 12.5px">
        编译与问答的提示词按「输出语言」写；代理只影响本模块自己的外呼（网络搜索 / 抓链接 / 云端解析）。
      </div>
    </div>


    <div class="ws-card block">
      <div class="block__title">服务与外部依赖</div>
      <div class="ws-dim" style="font-size: 12.5px; line-height: 1.75; margin-bottom: 14px">
        外部端点与本机目录。改完点「保存」写入 <code class="ws-mono">server/config.json</code>，
        改动在相关服务下一次被读取时生效（地址 / 目录变了记得重启边车）。
        <b>密钥不在这里填</b>：面板令牌、模型 API Key、MinerU 令牌都在
        <code class="ws-mono">server/credentials.json</code>（首次运行会自动建）。
        带目录的模块「没填就不显示」—— 填完保存，刷新页面它才出现在侧边栏。
      </div>

      <template v-if="configLoaded && configForm">
        <div class="cfg-group">模型端点（OpenAI 兼容）</div>
        <div class="cfg-row">
          <span class="cfg-label">地址</span>
          <el-input v-model="configForm.newapi.baseUrl" size="small" placeholder="https://your-endpoint.example.com" />
        </div>
        <div class="cfg-row">
          <span class="cfg-label">默认模型</span>
          <el-input v-model="configForm.ai.model" size="small" placeholder="deepseek-chat（示例）" />
          <el-input v-model="configForm.ai.models" size="small" placeholder="可选模型清单，逗号分隔" />
        </div>
        <div class="cfg-row">
          <span class="cfg-label">助手语气</span>
          <el-input v-model="configForm.ai.persona" size="small" placeholder="服务对象是一名在校大学生" />
        </div>

        <div class="cfg-group">转写后端（语音随记）</div>
        <div class="cfg-row">
          <span class="cfg-label">开关</span>
          <el-select v-model="configForm.asr.provider" size="small" style="width: 160px">
            <el-option label="用（OpenAI 兼容）" value="openai" />
            <el-option label="不用" value="none" />
          </el-select>
          <el-input v-model="configForm.asr.baseUrl" size="small" placeholder="http://127.0.0.1:8080/v1" />
          <el-input v-model="configForm.asr.model" size="small" placeholder="whisper-1" style="width: 160px" />
        </div>
        <div class="cfg-row">
          <span class="cfg-label ws-dim" style="font-weight: 400">说明</span>
          <span class="ws-dim" style="font-size: 12px">
            任一 OpenAI 兼容的 /audio/transcriptions 端点都行（本机 whisper.cpp / faster-whisper 网关也可以）。
            没填地址时「语音随记」不显示在侧边栏。
          </span>
        </div>

        <div class="cfg-group">知识库</div>
        <div class="cfg-row">
          <span class="cfg-label">库目录</span>
          <el-input v-model="configForm.wiki.dir" size="small" placeholder="C:\\资料\\我的知识库" />
        </div>

        <div class="cfg-group">本机文档解析工具</div>
        <div class="cfg-row">
          <span class="cfg-label">留空自动找</span>
          <el-input v-model="configForm.docparse.tools.pandoc" size="small" placeholder="pandoc（留空按 PATH 找）" />
          <el-input v-model="configForm.docparse.tools.soffice" size="small" placeholder="soffice.com" />
        </div>
        <div class="cfg-row">
          <span class="cfg-label"> </span>
          <el-input v-model="configForm.docparse.tools.python" size="small" placeholder="python" />
          <el-input v-model="configForm.docparse.tools.pdftotext" size="small" placeholder="pdftotext" />
        </div>

        <div class="cfg-group">进程守护与自启</div>
        <div class="cfg-row">
          <span class="cfg-label">引擎</span>
          <el-switch v-model="configForm.pguard.enabled" size="small" />
          <el-input v-model="configForm.pguard.dataDir" size="small" placeholder="数据目录（留空 = server/data/pguard）" />
        </div>
        <div class="cfg-row">
          <span class="cfg-label">启动文件夹</span>
          <el-input v-model="configForm.startupDir" size="small" />
        </div>

        <div class="block__row" style="margin-top: 16px">
          <el-button type="primary" :loading="configBusy" @click="saveConfigForm">保存</el-button>
          <el-button :disabled="configBusy" @click="resetConfigForm">还原</el-button>
          <el-button :disabled="configBusy" @click="fillConfigDefaults">填回默认值</el-button>
        </div>
      </template>
      <div v-else class="ws-dim" style="font-size: 12.5px">
        未连接边车，读不到配置。启动边车后点上面的「重新检测」。
      </div>
    </div>

    <div class="ws-card block">
      <div class="block__title">MCP（给智能体用）</div>
      <div class="block__row">
        <code class="ws-mono">http://127.0.0.1:5278/mcp</code>
        <el-button size="small" @click="copyMcp">复制端点</el-button>
      </div>
      <div class="ws-dim" style="margin-top: 10px; font-size: 12.5px; line-height: 1.7">
        智能体可通过它读今日看板/课表/待办/早报/余额，也能写计划与笔记、勾待办、生成 AI 总结。
        接入方式见项目根目录 README 的「MCP 接入」一节。
      </div>
    </div>

    <div class="ws-card block">
      <div class="block__title">外观</div>
      <div class="block__row">
        <span class="block__label">主题</span>
        <el-radio-group :model-value="ui.theme" @update:model-value="(v: any) => ui.setTheme(v)">
          <el-radio-button v-for="o in themeOptions" :key="o.value" :value="o.value">
            {{ o.label }}
          </el-radio-button>
        </el-radio-group>
        <span class="ws-dim">当前实际：{{ ui.resolvedTheme === 'dark' ? '深色' : '浅色' }}</span>
      </div>
    </div>

    <div class="ws-card block">
      <div class="block__title">已注册功能</div>
      <el-table :data="modules" style="width: 100%" size="small">
        <el-table-column prop="id" label="id" width="130">
          <template #default="{ row }"><code class="ws-mono">{{ row.id }}</code></template>
        </el-table-column>
        <el-table-column prop="name" label="名称" width="140" />
        <el-table-column prop="description" label="说明" show-overflow-tooltip />
        <el-table-column prop="homePath" label="入口" width="130">
          <template #default="{ row }"><code class="ws-mono">{{ row.homePath }}</code></template>
        </el-table-column>
      </el-table>
      <div class="ws-dim" style="margin-top: 10px; font-size: 12.5px">
        功能由代码里的注册表声明，不是在这里增删；这里只是查看当前装载了哪些模块。
      </div>
    </div>

    <div class="ws-card block">
      <div class="block__title">本地数据</div>
      <div class="block__row">
        <el-button type="primary" @click="doExport">
          <el-icon><Download /></el-icon>&nbsp;导出全部数据
        </el-button>
        <label class="upload-btn">
          <input type="file" accept="application/json,.json" hidden @change="onImportFile" />
          <el-icon><Upload /></el-icon>&nbsp;从备份恢复
        </label>
        <span class="ws-spacer" />
        <span class="ws-dim">共 {{ keys.length }} 项 · 约 {{ sizeText }}</span>
        <el-button type="danger" plain :disabled="!keys.length" @click="clearAll">清空全部</el-button>
      </div>

      <el-table v-if="keys.length" :data="keys.map((k) => ({ key: k, preview: previewOf(k) }))" style="width: 100%; margin-top: 14px" size="small">
        <el-table-column prop="key" label="键（均为 workstation.* 命名空间）" width="300">
          <template #default="{ row }"><code class="ws-mono">{{ row.key }}</code></template>
        </el-table-column>
        <el-table-column prop="preview" label="内容预览" show-overflow-tooltip />
        <el-table-column width="90" align="right">
          <template #default="{ row }">
            <el-button link type="danger" size="small" @click="clearKey(row.key)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div v-else class="ws-dim" style="margin-top: 12px">暂无数据 —— 用一次功能就会在这里出现记录。</div>
    </div>
  </div>
</template>

<style scoped>
.block {
  padding: 20px 22px;
  margin-bottom: 18px;
}
.block__title {
  font-size: 14.5px;
  font-weight: 650;
  margin-bottom: 14px;
}
.block__row {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
.block__label {
  font-size: 13.5px;
  color: var(--ws-text-2);
  min-width: 42px;
}
.upload-btn {
  display: inline-flex;
  align-items: center;
  padding: 8px 15px;
  border-radius: var(--el-border-radius-base);
  border: 1px solid var(--ws-border-strong);
  background: var(--ws-panel);
  color: var(--ws-text);
  font-size: 14px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.upload-btn:hover {
  color: var(--ws-accent);
  border-color: var(--ws-accent);
  background: var(--ws-accent-soft);
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex: 0 0 9px;
}
.dot--ok {
  background: var(--ws-success);
  box-shadow: 0 0 0 3px var(--ws-success-soft);
}
.dot--off {
  background: var(--ws-text-3);
}
.sidecar-help {
  margin-top: 12px;
  padding: 11px 13px;
  border-radius: var(--ws-radius-sm);
  background: var(--ws-warn-soft);
  font-size: 12.8px;
  line-height: 1.75;
  color: var(--ws-text-2);
}
.sidecar-help code {
  background: var(--ws-panel);
  border: 1px solid var(--ws-border);
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 12px;
}
/* ---- 服务与外部依赖（可编辑配置） ---- */
.cfg-group {
  font-size: 12.5px;
  font-weight: 650;
  color: var(--ws-text-2);
  margin: 16px 0 8px;
  padding-bottom: 5px;
  border-bottom: 1px solid var(--ws-border);
}
.cfg-group:first-of-type {
  margin-top: 4px;
}
.cfg-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 9px;
  flex-wrap: wrap;
}
/* 标签固定宽度，让几行的输入框左边缘对齐、眼睛不用来回扫 */
.cfg-label {
  flex: 0 0 84px;
  font-size: 12.5px;
  color: var(--ws-text-2);
}
.cfg-row :deep(.el-input) {
  flex: 1 1 260px;
  min-width: 200px;
}
</style>
