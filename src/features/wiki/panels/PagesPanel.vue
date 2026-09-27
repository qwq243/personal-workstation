<script setup lang="ts">
/**
 * 库 · 页面面板：左栏按类型列页面，右栏读一页（frontmatter / 正文 / 出链 / 反链），可编辑改名。
 * 支持 ?type= 与 ?path= / ?slug= 进来（搜索结果、问答依据、概览页的数字都往这里跳）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '@/core/sidecar'
import { contentPages, refresh, typeColor, typeLabel, TYPE_META, status } from '../store'
import WikiMarkdown from '../WikiMarkdown.vue'

const route = useRoute()
const router = useRouter()

const keyword = ref('')
/** 左栏宽度：可拖拽，存 localStorage，双击分隔条复位 */
const sideW = ref(Number(localStorage.getItem('workstation.wiki.sideW')) || 280)
const resizing = ref(false)
function startResize(e: MouseEvent) {
  resizing.value = true
  const startX = e.clientX
  const startW = sideW.value
  const move = (ev: MouseEvent) => {
    const next = Math.min(520, Math.max(200, startW + (ev.clientX - startX)))
    sideW.value = next
  }
  const up = () => {
    resizing.value = false
    localStorage.setItem('workstation.wiki.sideW', String(sideW.value))
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}
function resetSide() {
  sideW.value = 280
  localStorage.setItem('workstation.wiki.sideW', '280')
}
/** 右侧元信息栏（frontmatter / 反链 / 出链）。
 *  默认**收起** —— 它一开就吃掉 250px，正文会被挤窄（这正是「宽度异常」的成因）。 */
const showMeta = ref(localStorage.getItem('workstation.wiki.meta') === '1')
function toggleMeta() {
  showMeta.value = !showMeta.value
  localStorage.setItem('workstation.wiki.meta', showMeta.value ? '1' : '0')
}
const typeFilter = ref('')
const current = ref<any>(null)
const editing = ref(false)
const draft = ref('')
const busy = ref('')
const newPage = ref({ type: 'concept', slug: '', title: '' })

const shown = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return contentPages.value
    .filter((p: any) => !typeFilter.value || p.type === typeFilter.value)
    .filter((p: any) => !kw || `${p.title} ${p.path} ${(p.tags ?? []).join(' ')}`.toLowerCase().includes(kw))
})
const typeChips = computed(() => {
  const by = status.value?.pages?.byType ?? {}
  return TYPE_META.map((t) => ({ ...t, n: by[t.id] ?? 0 }))
})

async function open(path: string) {
  if (!path) return
  busy.value = 'page'
  const r = await api.wikiPage(path)
  busy.value = ''
  if (!r.ok) return ElMessage.warning(r.error ?? '读不到这一页')
  current.value = r.data
  editing.value = false
}

async function openSlug(slug: string) {
  const hit = contentPages.value.find((p: any) => p.slug === slug) ?? contentPages.value.find((p: any) => p.title === slug)
  if (hit) await open(hit.path)
  else ElMessage.info(`库里还没有 [[${slug}]] 这一页（图谱里是虚线圈；体检页能一键建骨架）`)
}

function startEdit() {
  draft.value = current.value?.content ?? ''
  editing.value = true
}

async function save() {
  busy.value = 'save'
  const r = await api.wikiSave(current.value.path, draft.value)
  busy.value = ''
  if (!r.ok) return ElMessage.error(r.error ?? '保存失败')
  ElMessage.success(r.data?.backedUp ? '已保存（旧版本已备份）' : '已保存')
  editing.value = false
  await open(current.value.path)
  await refresh()
}

async function createPage() {
  const { type, slug, title } = newPage.value
  if (!slug.trim()) return ElMessage.warning('先填 slug（文件名，英文 kebab-case）')
  busy.value = 'create'
  const r = await api.wikiCreate({ type, slug: slug.trim(), title: title.trim() || slug.trim() })
  busy.value = ''
  if (!r.ok) return ElMessage.error(r.error ?? '新建失败')
  newPage.value = { type: 'concept', slug: '', title: '' }
  await refresh()
  await open(r.data.path)
  startEdit()
  ElMessage.success('骨架建好了，直接写内容')
}

async function renamePage() {
  if (!current.value) return
  const from = current.value.path
  const base = String(from.split('/').pop() ?? '').replace(/\.md$/, '')
  try {
    const input = await ElMessageBox.prompt('新的文件名（不含目录与 .md）。改名不会自动修别处的 [[双链]]，断链会由体检页报出来。', '重命名页面', {
      inputValue: base,
      inputPattern: /^[\w\u4e00-\u9fff][\w\u4e00-\u9fff-]*$/,
      inputErrorMessage: '只能是字母 / 数字 / 中文 / 连字符',
    })
    const slug = String(input.value).trim()
    const to = `${from.split('/').slice(0, -1).join('/')}/${slug}.md`
    if (to === from) return
    busy.value = 'rename'
    const r = await api.wikiRename(from, to)
    busy.value = ''
    if (!r.ok) return ElMessage.error(r.error ?? '改名失败')
    ElMessage.success(`已重命名为 ${slug}.md（旧版本已备份）`)
    await refresh()
    await open(to)
  } catch {
    /* 取消 */
  }
}

async function applyQuery() {
  typeFilter.value = String(route.query.type ?? '')
  const path = String(route.query.path ?? '')
  const slug = String(route.query.slug ?? '')
  if (path) await open(path)
  else if (slug) await openSlug(slug)
}

onMounted(async () => {
  if (!status.value) await refresh()
  await applyQuery()
})
watch(() => [route.query.type, route.query.path, route.query.slug], applyQuery)
</script>

<template>
  <div class="pg__layout" :style="{ gridTemplateColumns: `${sideW}px 6px minmax(0, 1fr)` + (showMeta ? ' 250px' : '') }">
    <aside class="wk-card pg__side">
      <el-input v-model="keyword" placeholder="筛标题 / 标签" clearable size="small" />
      <div class="wk-chips">
        <button class="wk-chip" :class="{ 'is-on': !typeFilter }" @click="typeFilter = ''">全部 {{ contentPages.length }}</button>
        <button
          v-for="t in typeChips"
          :key="t.id"
          class="wk-chip"
          :class="{ 'is-on': typeFilter === t.id }"
          :title="t.hint"
          @click="typeFilter = typeFilter === t.id ? '' : t.id"
        >
          <i :style="{ background: t.color }" />{{ t.label }} {{ t.n }}
        </button>
      </div>
      <div class="wk-list wk-scroll">
        <button
          v-for="p in shown"
          :key="p.path"
          class="wk-list__row"
          :class="{ 'is-active': current?.path === p.path }"
          @click="open(p.path)"
        >
          <span class="wk-list__main">
            <span class="wk-list__title">{{ p.title }}</span>
            <span class="wk-list__meta">
              <i class="pg__dot" :style="{ background: typeColor(p.type) }" />{{ typeLabel(p.type) }} · {{ p.chars }} 字
            </span>
          </span>
        </button>
        <div v-if="!shown.length" class="wk-empty">没有页面</div>
      </div>
      <details class="pg__new">
        <summary>新建页面</summary>
        <div class="pg__new-body">
          <el-select v-model="newPage.type" size="small">
            <el-option v-for="t in TYPE_META" :key="t.id" :label="t.label" :value="t.id" />
          </el-select>
          <el-input v-model="newPage.slug" size="small" placeholder="slug（英文 kebab-case）" />
          <el-input v-model="newPage.title" size="small" placeholder="标题（可留空）" />
          <el-button size="small" :loading="busy === 'create'" @click="createPage">建</el-button>
        </div>
      </details>
    </aside>

    <!-- 拖拽条：左右拖改宽度，双击复位 -->
    <div class="pg__grip" :class="{ 'is-drag': resizing }" title="拖动改宽度，双击复位" @mousedown.prevent="startResize" @dblclick="resetSide" />

    <section class="wk-card">
      <div v-if="!current" class="wk-empty">选一页开始读 —— 左栏按类型列页面，正文里的 [[双链]] 可以直接跳</div>
      <template v-else>
        <div class="pg__head">
          <div class="pg__head-main">
            <h2 class="pg__title">{{ current.page?.title }}</h2>
            <div class="wk-chips">
              <span class="wk-chip is-static" :style="{ color: typeColor(current.page?.type) }">{{ typeLabel(current.page?.type) }}</span>
              <span class="wk-mono pg__path">{{ current.path }}</span>
              <span v-if="current.page?.updated" class="pg__dim">更新 {{ current.page.updated }}</span>
              <span v-if="current.page?.tags?.length" class="pg__dim">标签 {{ current.page.tags.join('、') }}</span>
              <span v-if="current.page?.sourceFile" class="pg__src">源：{{ current.page.sourceFile }}</span>
            </div>
          </div>
          <div class="pg__actions">
            <template v-if="!editing">
              <el-button size="small" :title="showMeta ? '收起页面信息' : '显示页面信息（frontmatter / 反链 / 出链）'" @click="toggleMeta">
                {{ showMeta ? '收起信息' : '页面信息' }}
              </el-button>
              <el-button size="small" @click="startEdit">编辑</el-button>
              <el-button size="small" @click="renamePage">改名</el-button>
            </template>
            <template v-else>
              <el-button size="small" type="primary" :loading="busy === 'save'" @click="save">保存</el-button>
              <el-button size="small" @click="editing = false">取消</el-button>
            </template>
          </div>
        </div>

        <el-input v-if="editing" v-model="draft" type="textarea" :autosize="{ minRows: 16, maxRows: 46 }" class="pg__editor" />
        <div v-else class="pg__reader">
          <WikiMarkdown :text="current.body" @wiki-link="openSlug" />
        </div>

      </template>
    </section>

    <!-- 右侧元信息栏：frontmatter / 统计 / 反链 / 出链 -->
    <aside v-if="showMeta && current" class="wk-card pg__meta">
      <div class="wk-card__head">
        <h3 class="wk-card__title"><el-icon><InfoFilled /></el-icon> 页面信息</h3>
        <button class="wk-link" @click="toggleMeta">收起</button>
      </div>
      <ul class="wk-list">
        <li class="wk-list__row"><span class="wk-list__main wk-hint">类型</span><span class="wk-list__tail">{{ typeLabel(current.page?.type) }}</span></li>
        <li class="wk-list__row"><span class="wk-list__main wk-hint">字数</span><span class="wk-list__tail">{{ current.page?.chars }}</span></li>
        <li class="wk-list__row"><span class="wk-list__main wk-hint">更新</span><span class="wk-list__tail">{{ current.page?.updated || '—' }}</span></li>
        <li class="wk-list__row"><span class="wk-list__main wk-hint">源文件</span><span class="wk-list__tail wk-mono">{{ (current.page?.sourceFile || '—').replace('raw/sources/', '') }}</span></li>
      </ul>
      <p v-if="current.page?.tags?.length" class="wk-hint" style="margin-top: 10px">标签：{{ current.page.tags.join('、') }}</p>

      <template v-if="current.backlinks?.length">
        <h3 class="wk-card__title" style="margin: 14px 0 8px"><el-icon><Link /></el-icon> 被引用（{{ current.backlinks.length }}）</h3>
        <div class="wk-chips">
          <button v-for="b in current.backlinks" :key="b.path" class="wk-chip" @click="open(b.path)">{{ b.title }}</button>
        </div>
      </template>
      <template v-if="current.outlinks?.length">
        <h3 class="wk-card__title" style="margin: 14px 0 8px"><el-icon><Share /></el-icon> 链接到（{{ current.outlinks.length }}）</h3>
        <div class="wk-chips">
          <button
            v-for="o in current.outlinks"
            :key="o.target"
            class="wk-chip"
            :class="{ 'wk-chip--warn': !o.exists }"
            @click="openSlug(o.target)"
          >
            {{ o.title }}{{ o.exists ? '' : '（未建）' }}
          </button>
        </div>
      </template>
    </aside>

  </div>
</template>

<style scoped>
/* 布局：左栏（可拖）｜拖拽条｜正文（铺满）｜右元信息栏。
   正文不再限宽 —— 限宽会在宽屏上留一条空带。 */
.pg__layout {
  display: grid;
  gap: 12px;
  align-items: start;
}
@media (max-width: 1100px) {
  .pg__layout {
    grid-template-columns: 1fr !important;
  }
  .pg__grip { display: none; }
}
.pg__grip {
  align-self: stretch;
  border-radius: 3px;
  cursor: col-resize;
  background: linear-gradient(var(--ws-border), var(--ws-border)) center / 2px 100% no-repeat;
  transition: background-color 0.15s ease;
}
.pg__grip:hover,
.pg__grip.is-drag {
  background: var(--ws-accent-ring) center / 3px 100% no-repeat;
}
.pg__meta {
  position: sticky;
  top: 0;
  max-height: 78vh;
  overflow: auto;
}
.pg__meta-toggle {
  position: sticky;
  top: 0;
  writing-mode: vertical-rl;
  padding: 10px 3px;
  font: inherit;
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-3);
  background: var(--ws-panel);
  border: 1px solid var(--ws-border);
  border-radius: var(--ws-radius-sm);
  cursor: pointer;
}
.pg__meta-toggle:hover { color: var(--ws-accent); border-color: var(--ws-accent-ring); }
.pg__side {
  display: flex;
  flex-direction: column;
  gap: 10px;
  position: sticky;
  top: 0;
}
.pg__dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-right: 5px;
  vertical-align: 1px;
}
.pg__new > summary {
  cursor: pointer;
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-3);
  padding-top: 8px;
  border-top: 1px dashed var(--ws-border);
}
.pg__new-body {
  display: grid;
  gap: 6px;
  margin-top: 8px;
}
.pg__head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
  padding-bottom: 12px;
  margin-bottom: 14px;
  border-bottom: 1px solid var(--ws-border);
}
.pg__title {
  margin: 0 0 8px;
  font-size: var(--ws-fs-lg);
  color: var(--ws-text);
  line-height: 1.3;
}
.pg__path {
  font-size: 11px;
  color: var(--ws-text-3);
}
.pg__dim {
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-3);
}
.pg__src {
  font-size: var(--ws-fs-xs);
  color: var(--ws-info);
}
.pg__actions {
  display: flex;
  gap: 8px;
  flex: 0 0 auto;
}
.pg__editor :deep(textarea) {
  font-family: var(--ws-mono);
  font-size: var(--ws-fs-xs);
  line-height: 1.75;
}
/* 正文铺满卡片；行宽靠字号与行高控制，不加 max-width */
.pg__reader {
  min-width: 0;
}
.pg__links {
  margin-top: 22px;
  padding-top: 14px;
  border-top: 1px dashed var(--ws-border);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pg__links-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
</style>
