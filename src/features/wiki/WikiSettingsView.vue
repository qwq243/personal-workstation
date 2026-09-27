<script setup lang="ts">
/**
 * 知识库 · 设置（只放**强业务**的东西）。
 *
 * 2026-09-24 整理：以前这里还挂着大模型、语义检索、网络搜索、文档解析、输出语言、代理 ——
 * 那些是**工作台的能力**，不是知识库的私产，放在模块设置里等于把同一件事拆成两处配。
 * 现在它们统一在「设置与数据」（`#/settings`）里：大模型 / 语义检索 / 网络搜索 / 文档解析 / 输出与网络。
 * 这一页只留真正只属于知识库的三件：
 *   通用（多库管理）· 源监听与导入（含定时导入）· 关于
 * 顶上给一张「继承自全局设置」的卡片：当前生效的模型 / 嵌入端点 / 检索来源一眼能看到，点进去就能改。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api } from '@/core/sidecar'
import { embedStatus, loadProjects, projects, refresh, status } from './store'
import WikiShell from './WikiShell.vue'

const router = useRouter()
const busy = ref('')
const newDir = ref('')
const newName = ref('')
const watchForm = ref({ dirsText: '', enabled: false, autoIngest: false, intervalMin: 30, maxFileSizeMb: 100 })
const schedForm = ref({ enabled: false, intervalMin: 60 })
/** 继承自全局的那几项（只读展示） */
const inherited = ref<{ llm: string; ingest: string; embed: string; embedReady: boolean; search: string; parse: string }>({
  llm: '—',
  ingest: '—',
  embed: '—',
  embedReady: false,
  search: '—',
  parse: '—',
})

const activeProject = computed(() => (projects.value?.projects ?? []).find((p: any) => p.active))

async function load() {
  const [c, llm, sc, em] = await Promise.all([api.config(), api.wikiLlm(), api.wikiSearchConfig(), api.wikiEmbed()])
  const cfg = c.ok ? (c.data?.config ?? null) : null
  const w = cfg?.wiki ?? {}
  watchForm.value = {
    dirsText: (w.watchDirs ?? []).join('\n'),
    enabled: !!w.watchEnabled,
    autoIngest: !!w.watchAutoIngest,
    intervalMin: w.watchIntervalMin ?? 30,
    maxFileSizeMb: w.watchMaxFileSizeMb ?? 100,
  }
  schedForm.value = { enabled: w.scheduledImport?.enabled === true, intervalMin: w.scheduledImport?.intervalMin ?? 60 }
  const globalModel = cfg?.ai?.model ?? ''
  if (llm.ok) {
    const r = llm.data?.resolved ?? {}
    // 跟随工作台时预设本身没有模型名 —— 显示全局那个，别让人以为「没配」
    const label = (x: any) => `${x?.label ?? '—'}${x?.model ? ` · ${x.model}` : x?.label === '跟随工作台' && globalModel ? ` · ${globalModel}` : ''}`
    inherited.value.llm = label(r.chat)
    inherited.value.ingest = label(r.ingest)
  }
  if (em.ok) inherited.value.embedReady = !!em.data?.enabled
  inherited.value.embed = `${em.data?.model ?? '—'}（${em.data?.indexed ?? 0}/${em.data?.pages ?? 0} 页已索引）`
  if (sc.ok) {
    const p = (sc.data?.providers ?? []).find((x: any) => x.id === sc.data?.provider)
    inherited.value.search = sc.data?.provider === 'none' ? '不用网络搜索' : `${p?.label ?? sc.data.provider}${sc.data?.ready ? '' : '（未配齐）'}`
  }
  const mc = cfg?.docparse?.mineru
  inherited.value.parse = mc?.enabled === false ? '只走本机通道' : `云端 MinerU（${mc?.modelVersion ?? 'vlm'}${mc?.isOcr !== false ? '+OCR' : ''}）`
  if (!status.value) await refresh()
  await loadProjects()
}

async function switchTo(dir: string) {
  busy.value = 'switch'
  const r = await api.wikiSetProject(dir)
  busy.value = ''
  if (!r.ok) return ElMessage.error(r.error ?? '切换失败')
  ElMessage.success(`已切到 ${dir}`)
  await refresh()
  await loadProjects()
}

async function addLibrary() {
  const dir = newDir.value.trim().replace(/\\/g, '/')
  if (!dir) return ElMessage.warning('先填目录')
  busy.value = 'add'
  const r = await api.wikiAddProject(dir, newName.value.trim() || undefined)
  busy.value = ''
  if (!r.ok) return ElMessage.error(r.error ?? '登记失败')
  ElMessage.success('已登记（只登记路径，没动磁盘）')
  newDir.value = ''
  newName.value = ''
  await loadProjects()
}

async function initLibrary() {
  const dir = newDir.value.trim().replace(/\\/g, '/')
  if (!dir) return ElMessage.warning('先填要初始化的目录')
  busy.value = 'init'
  const r = await api.wikiInitProject(dir, newName.value.trim() || undefined)
  busy.value = ''
  if (!r.ok) return ElMessage.error(r.error ?? '初始化失败')
  ElMessage.success(`已初始化（新建 ${r.data?.created?.length ?? 0} 个文件）`)
  await loadProjects()
}

async function forget(dir: string) {
  busy.value = 'forget'
  const r = await api.wikiRemoveProject(dir)
  busy.value = ''
  if (r.ok) ElMessage.success('已从列表移除（磁盘上的文件一个没动）')
  await loadProjects()
}

async function saveWatch() {
  busy.value = 'watch'
  const dirs = watchForm.value.dirsText
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
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
  await load()
}

async function saveSched() {
  busy.value = 'sched'
  const r = await api.patchConfig({
    wiki: { scheduledImport: { enabled: schedForm.value.enabled, intervalMin: Number(schedForm.value.intervalMin) || 60 } },
  })
  busy.value = ''
  if (!r.ok) return ElMessage.error(r.error ?? '保存失败')
  ElMessage.success('已保存（与源监听共用同一个定时器）')
}

onMounted(load)
</script>

<template>
  <WikiShell title="知识库设置" subtitle="多库 · 源监听（模型 / 检索 / 解析 / 代理都统一在「设置与数据」里）" icon="Setting">
    <div class="wk-stack">
      <!-- 继承自全局：只读一眼看全，改去全站设置 -->
      <section class="wk-card">
        <div class="wk-card__head">
          <h3 class="wk-card__title"><el-icon><InfoFilled /></el-icon> 继承自全局设置</h3>
          <el-button size="small" type="primary" plain @click="router.push('/settings')">去「设置与数据」改</el-button>
        </div>
        <p class="wk-card__desc">
          大模型、语义检索、网络搜索、文档解析、输出语言、代理都是<b>工作台的能力</b>，全站只配一份；
          知识库这里只显示当前生效的值（2026-09-24 从本页搬出去的，免得同一件事分两处配）。
        </p>
        <table class="wk-table">
          <tbody>
            <tr>
              <td><b>对话模型</b></td>
              <td>{{ inherited.llm }}</td>
            </tr>
            <tr>
              <td><b>编译模型</b></td>
              <td>{{ inherited.ingest }}</td>
            </tr>
            <tr>
              <td><b>嵌入端点</b></td>
              <td>{{ inherited.embed }}</td>
            </tr>
            <tr>
              <td><b>网络搜索</b></td>
              <td>{{ inherited.search }}</td>
            </tr>
            <tr>
              <td><b>文档解析</b></td>
              <td>{{ inherited.parse }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- 多库 -->
      <section class="wk-card wk-card--flush">
        <div class="wk-card__head">
          <h3 class="wk-card__title"><el-icon><FolderOpened /></el-icon> 知识库（多库）</h3>
          <span class="wk-hint">当前：{{ activeProject?.name ?? '—' }}（{{ status?.pages?.total ?? 0 }} 页 · {{ status?.sources ?? 0 }} 份原始资料）</span>
        </div>
        <table class="wk-table">
          <thead>
            <tr><th>库</th><th>目录</th><th>页数</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="p in projects?.projects ?? []" :key="p.dir">
              <td>
                <b v-if="p.active">▶ {{ p.name }}</b>
                <span v-else>{{ p.name }}</span>
                <span v-if="!p.exists" class="wk-hint--warn">（目录不存在）</span>
                <span v-else-if="!p.isLibrary" class="wk-hint--warn">（不是知识库目录）</span>
              </td>
              <td class="wk-mono wk-ellipsis" :title="p.dir">{{ p.dir }}</td>
              <td class="wk-num">{{ p.pages }}</td>
              <td class="st__actions">
                <el-button v-if="!p.active && p.isLibrary" size="small" :loading="busy === 'switch'" @click="switchTo(p.dir)">切到它</el-button>
                <el-button size="small" text @click="forget(p.dir)">移除登记</el-button>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="st__row st__pad">
          <el-input v-model="newDir" placeholder="目录，如 C:\\资料\\我的知识库" />
          <el-input v-model="newName" placeholder="显示名（可空）" class="st__name" />
          <el-button size="small" :loading="busy === 'add'" @click="addLibrary">登记</el-button>
          <el-button size="small" type="primary" plain :loading="busy === 'init'" @click="initLibrary">初始化为知识库</el-button>
        </div>
        <p class="wk-hint st__pad">
          「登记」只把路径记进列表（不动磁盘）；「初始化为知识库」会在目录里补出
          <code class="wk-code">wiki/ raw/ schema.md purpose.md</code> 骨架，已有文件一律不覆盖。
        </p>
      </section>

      <!-- 源监听与导入 -->
      <section class="wk-card">
        <div class="wk-card__head">
          <h3 class="wk-card__title"><el-icon><Files /></el-icon> 源目录监听</h3>
          <el-button size="small" @click="watchForm.dirsText = status?.root + '/raw/sources'">填当前库 raw/sources</el-button>
        </div>
        <p class="wk-card__desc">
          盯几个文件夹，发现新增/改过的 pdf·docx·xlsx·pptx·md·txt·html·csv 就排队入库（解析 → 编译）。
          留空 = 只盯当前库的 <code class="wk-code">raw/sources</code>；扫描只看支持的类型、跳过
          <code class="wk-code">.git/.obsidian/node_modules</code>。
        </p>
        <el-input v-model="watchForm.dirsText" type="textarea" :autosize="{ minRows: 2, maxRows: 6 }" placeholder="一行一个目录（留空 = raw/sources）" />
        <div class="st__row">
          <el-checkbox v-model="watchForm.enabled">开启定时监听</el-checkbox>
          <el-checkbox v-model="watchForm.autoIngest" :disabled="!watchForm.enabled">发现新文件时自动编译（会花模型额度）</el-checkbox>
          <span class="st__num">每 <el-input-number v-model="watchForm.intervalMin" :min="5" :max="1440" size="small" controls-position="right" /> 分钟</span>
          <span class="st__num">单文件 ≤ <el-input-number v-model="watchForm.maxFileSizeMb" :min="1" :max="2048" size="small" controls-position="right" /> MB</span>
          <el-button size="small" type="primary" :loading="busy === 'watch'" @click="saveWatch">保存</el-button>
        </div>
      </section>

      <section class="wk-card">
        <h3 class="wk-card__title" style="margin-bottom: 8px"><el-icon><AlarmClock /></el-icon> 定时导入</h3>
        <p class="wk-card__desc">
          按周期自动扫一遍监听目录、把新文件排进队列。
          与「开启定时监听」共用同一个定时器：任一开启即生效，周期以这边为准。
        </p>
        <div class="st__row" style="margin-top: 0">
          <el-checkbox v-model="schedForm.enabled">按周期自动扫描</el-checkbox>
          <span class="st__num">每 <el-input-number v-model="schedForm.intervalMin" :min="5" :max="1440" size="small" controls-position="right" /> 分钟</span>
          <el-button size="small" type="primary" :loading="busy === 'sched'" @click="saveSched">保存</el-button>
        </div>
      </section>

      <!-- 关于 -->
      <section class="wk-card">
        <h3 class="wk-card__title" style="margin-bottom: 8px"><el-icon><InfoFilled /></el-icon> 关于</h3>
        <p class="wk-card__desc">
          库本体在 <code class="wk-code">{{ status?.root }}</code>，格式没动（schema.md + frontmatter + 双链）；
          读写通道在边车 <code class="wk-code">server/lib/wiki*.mjs</code>，界面在
          <code class="wk-code">src/features/wiki/*</code>。原始资料在 <code class="wk-code">raw/</code>，
          编译产物在 <code class="wk-code">wiki/</code>；编译默认只新建页面、不重写已有页。
        </p>
      </section>
    </div>
  </WikiShell>
</template>

<style scoped>
.st__row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 10px;
}
.st__pad {
  padding: 12px 18px 0;
}
.st__name {
  width: 170px;
  flex: 0 0 auto;
}
.st__num {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--ws-fs-sm);
  color: var(--ws-text-2);
  white-space: nowrap;
}
.st__num :deep(.el-input-number) {
  width: 118px;
}
.st__actions {
  text-align: right;
  white-space: nowrap;
  width: 1%;
}
.wk-code {
  font-family: var(--ws-mono);
}
</style>
