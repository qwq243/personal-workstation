<script setup lang="ts">
/**
 * 库 · 搜索面板：词法（搜词）与语义（搜意思）两种检索 + 向量索引管理。
 * 索引状态摆在最上面：没建索引时语义检索不出结果，得让人当场知道是这个原因。
 */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api } from '@/core/sidecar'
import { embedStatus, refresh, typeColor, typeLabel } from '../store'
import WikiMarkdown from '../WikiMarkdown.vue'

const router = useRouter()
const q = ref('')
const mode = ref<'lexical' | 'auto' | 'semantic'>('auto')
/** 来源：库内（词法/语义）· 网络 · 本机文件 —— 后两个走 /api/wiki/websearch 与 /api/wiki/anytxt */
const source = ref<'wiki' | 'web' | 'anytxt'>('wiki')
const ext = ref<any>(null)
const results = ref<any[]>([])
const meta = ref<any>(null)
const busy = ref('')
const preview = ref<any>(null)
const env = ref<any>(null)

async function run() {
  const text = q.value.trim()
  if (!text) return
  if (source.value !== 'wiki') {
    busy.value = 'search'
    ext.value = null
    const r = source.value === 'web' ? await api.wikiWebSearch(text, 15) : await api.wikiAnyTxtSearch(text, 20)
    busy.value = ''
    if (!r.ok) {
      results.value = []
      return ElMessage.error(r.error ?? '检索失败')
    }
    ext.value = r.data
    results.value = (r.data.results ?? []).map((x: any) => ({ ...x, path: x.url, title: x.title, type: source.value, snippet: x.snippet, score: '—' }))
    meta.value = { mode: source.value === 'web' ? `网络 · ${r.data.provider}` : '本机文件 · AnyTXT', total: r.data.total }
    preview.value = null
    return
  }
  busy.value = 'search'
  const r = await api.wikiSearch(text, { topK: 20, mode: mode.value })
  busy.value = ''
  if (!r.ok) {
    results.value = []
    return ElMessage.error(r.error ?? '检索失败')
  }
  meta.value = r.data
  results.value = r.data.results ?? []
  if (r.data.semanticError) ElMessage.warning(r.data.semanticError)
  preview.value = null
}

async function build() {
  busy.value = 'build'
  const t0 = Date.now()
  const r = await api.wikiEmbedBuild({})
  busy.value = ''
  if (!r.ok) return ElMessage.error(r.error ?? '建索引失败')
  const d = r.data
  ElMessage.success(
    `索引完成：${d.indexed}/${d.total} 页 · ${d.chunks} 块 · ${((Date.now() - t0) / 1000).toFixed(1)}s${d.failed ? `（${d.failed} 页失败）` : ''}`,
  )
  await refresh()
}

async function probe() {
  busy.value = 'probe'
  const r = await api.wikiEmbedProbe()
  busy.value = ''
  if (!r.ok) return ElMessage.error(r.error ?? '探测失败')
  r.data.ok ? ElMessage.success(`嵌入端点正常：${r.data.model} · ${r.data.dim} 维 · ${r.data.ms}ms`) : ElMessage.error(r.data.error ?? '嵌入端点不可用')
}

async function previewPage(path: string) {
  const r = await api.wikiPage(path)
  preview.value = r.ok ? r.data : null
}

onMounted(async () => {
  if (!embedStatus.value) await refresh()
  const e = await api.wikiEnvironment()
  env.value = e.ok ? e.data : null
})
</script>

<template>
  <div class="wk-stack">
    <div class="wk-card se__strip">
      <div class="se__strip-main">
        <span class="wk-chip is-static">向量索引 {{ embedStatus?.indexed ?? 0 }}/{{ embedStatus?.pages ?? 0 }} 页</span>
        <span class="wk-chip is-static">{{ embedStatus?.chunks ?? 0 }} 块</span>
        <span class="wk-chip is-static">{{ embedStatus?.dim ?? 0 }} 维</span>
        <span class="wk-mono se__dim">{{ embedStatus?.model }}</span>
        <span v-if="embedStatus?.pending" class="wk-chip wk-chip--warn">{{ embedStatus.pending }} 页未索引</span>
        <span v-if="embedStatus && !embedStatus.enabled" class="wk-chip wk-chip--warn">语义检索已关闭</span>
      </div>
      <div class="se__strip-actions">
        <el-button size="small" :loading="busy === 'probe'" @click="probe">测嵌入端点</el-button>
        <el-button size="small" type="primary" plain :loading="busy === 'build'" @click="build">建 / 更新索引</el-button>
      </div>
    </div>

    <div class="se__row">
      <el-input v-model="q" class="se__q" placeholder="例：怎样训练看东西的眼力 / 比较法怎么练" clearable @keyup.enter="run" />
      <el-select v-model="source" class="se__mode">
        <el-option label="库内" value="wiki" />
        <el-option label="网络" value="web" />
        <el-option label="本机文件" value="anytxt" />
      </el-select>
      <el-select v-if="source === 'wiki'" v-model="mode" class="se__mode">
        <el-option label="混合（词法+语义）" value="auto" />
        <el-option label="词法（快、可解释）" value="lexical" />
        <el-option label="纯语义" value="semantic" />
      </el-select>
      <el-button type="primary" :loading="busy === 'search'" @click="run">检索</el-button>
    </div>

    <p v-if="meta" class="wk-hint">
      模式 {{ meta.mode }} · 命中 {{ meta.total }} 页{{ meta.model ? ` · 嵌入 ${meta.model}` : '' }}
      <span v-if="meta.semanticError" class="wk-hint--warn">（{{ meta.semanticError }}）</span>
    </p>

    <div class="wk-cols" :class="preview ? 'wk-cols--2' : ''">
      <section class="wk-stack">
        <component
          :is="source === 'wiki' ? 'button' : 'a'"
          v-for="r in results"
          :key="r.path"
          class="wk-card se__card"
          :href="source === 'wiki' ? undefined : r.path"
          :target="source === 'wiki' ? undefined : '_blank'"
          :rel="source === 'wiki' ? undefined : 'noreferrer'"
          @click="source === 'wiki' ? previewPage(r.path) : undefined"
        >
          <div class="se__card-top">
            <span class="wk-list__title">{{ r.title }}</span>
            <span v-if="source === 'wiki'" class="wk-chip is-static" :style="{ color: typeColor(r.type) }">{{ typeLabel(r.type) }}</span>
            <span v-else class="wk-chip is-static">{{ r.source ?? source }}</span>
            <span class="se__score">
              <template v-if="meta?.mode === 'hybrid' || meta?.mode === 'semantic'">
                词法 #{{ r.lexicalRank ?? '—' }} · 语义 {{ r.semanticScore?.toFixed?.(3) ?? r.score }}
              </template>
              <template v-else>{{ r.score }}</template>
            </span>
          </div>
          <div class="wk-mono se__path">{{ r.path }}</div>
          <p class="se__snip">{{ r.snippet }}</p>
        </component>
        <div v-if="q && !results.length && busy !== 'search'" class="wk-empty">没有命中 —— 换个问法、换来源，或去「入库」添资料</div>
        <div v-if="!q" class="wk-empty">
          词法搜「词」（标题加权 + 中文二元切分），语义搜「意思」（bge-m3 向量）<br />
          解析通道：pandoc {{ env?.pandoc ? '✓' : '✗' }} · LibreOffice {{ env?.soffice ? '✓' : '✗' }} · Python {{ env?.python ? '✓' : '✗' }} ·
          云端 {{ env?.cloud?.ok ? '✓' : '✗' }}
        </div>
      </section>

      <section v-if="preview && source === 'wiki'" class="wk-card se__preview">
        <div class="wk-card__head">
          <h3 class="wk-card__title"><el-icon><Document /></el-icon> {{ preview.page?.title }}</h3>
          <div class="wk-chips">
            <button class="wk-link" @click="router.push(`/wiki/browse?path=${encodeURIComponent(preview.path)}`)">去这一页</button>
            <button class="wk-link" @click="preview = null">关闭</button>
          </div>
        </div>
        <WikiMarkdown :text="preview.body" @wiki-link="(s) => router.push(`/wiki/browse?slug=${encodeURIComponent(s)}`)" />
      </section>
    </div>
  </div>
</template>

<style scoped>
.se__strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  justify-content: space-between;
}
.se__strip-main {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.se__strip-actions {
  display: flex;
  gap: 8px;
}
.se__dim {
  font-size: 11px;
  color: var(--ws-text-3);
}
.se__row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.se__mode {
  width: 200px;
  flex: 0 0 auto;
}

/* 手机档：输入框 + 两个 200px select + 按钮合计约 700px，一行必然溢出。
   让这一行换行：输入框独占一行，两个 select 平分下一行。 */
@media (max-width: 760px) {
  .se__row {
    flex-wrap: wrap;
  }
  .se__q {
    flex: 1 1 100%;
  }
  .se__mode {
    flex: 1 1 130px;
    width: auto;
  }
}
.se__card {
  display: flex;
  flex-direction: column;
  gap: 5px;
  text-align: left;
  font: inherit;
  cursor: pointer;
  transition: border-color 0.15s ease, transform 0.15s ease;
}
.se__card:hover {
  border-color: var(--ws-accent-ring);
  transform: translateY(-1px);
}
.se__card-top {
  display: flex;
  align-items: center;
  gap: 8px;
}
.se__score {
  margin-left: auto;
  font-family: var(--ws-mono);
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-3);
}
.se__path {
  font-size: 11px;
  color: var(--ws-text-3);
}
.se__snip {
  margin: 0;
  font-size: var(--ws-fs-sm);
  color: var(--ws-text-2);
  line-height: 1.75;
}
.se__preview {
  max-height: 74vh;
  overflow: auto;
  position: sticky;
  top: 0;
}
</style>
