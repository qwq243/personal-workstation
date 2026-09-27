<script setup lang="ts">
/**
 * 语音随记 · 热词（`#/memo/hotwords`）。
 *
 * 一个分类 = 一张词表：`词（正确写法） + 常见错写别名 + 来源 + 命中次数`。
 * 它在两处起作用：
 *   ① **转写纠错** —— 别名先在本地做一遍确定性替换（`hotwords.applyAliases`），再把词表交给模型复核；
 *   ② **打标签** —— 提示词里要求标签优先从词表里挑，整理出来的主题词也会回填到这里。
 *
 * 出厂预设是**通用词**（常见同音错写 / 技术 / AI / 学术 / 教学 / 医学），没有任何身份信息；
 * 把它当模板，换成自己的词就是。
 */
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageHeader from '@/components/PageHeader.vue'
import SidecarOffline from '@/components/SidecarOffline.vue'
import { api, ensureSidecar } from '@/core/sidecar'

const router = useRouter()
const ready = ref(false)
const loading = ref(true)

const categories = ref<any[]>([])
const presets = ref<any[]>([])
const total = ref(0)
const pickedId = ref('')
const busy = ref(false)
const catDraft = ref('')
const termDraft = ref<{ term: string; aliases: string; note: string }>({ term: '', aliases: '', note: '' })
const termEditing = ref('')
const termFormEl = ref<HTMLElement | null>(null)
const batchOpen = ref(false)
const batchText = ref('')

const picked = computed(() => categories.value.find((c: any) => c.id === pickedId.value) ?? null)

function sourceLabel(source: string) {
  return source === 'preset' ? '预设' : source === 'auto' ? '自动' : '手加'
}

function apply(d: any) {
  categories.value = d?.categories ?? []
  presets.value = d?.presets ?? []
  total.value = Number(d?.total ?? 0)
  if (!categories.value.some((c: any) => c.id === pickedId.value)) pickedId.value = categories.value[0]?.id ?? ''
}

async function load() {
  loading.value = true
  const ok = await ensureSidecar()
  ready.value = ok
  if (ok) {
    const r = await api.memoHotwords()
    if (r.ok && (r.data as any)?.ok !== false) apply(r.data)
  }
  loading.value = false
}

/** 写操作都走这一个口（分支在边车 hotwords.act） */
async function act(payload: Record<string, any>, okText?: string) {
  busy.value = true
  const r = await api.memoHotwordAct(payload)
  busy.value = false
  const d = r.data as any
  if (!r.ok || d?.ok === false) {
    ElMessage.error(d?.error ?? r.error ?? '操作失败')
    return null
  }
  if (d.categories) apply(d)
  if (okText) ElMessage.success(okText)
  return d
}

async function addCategory() {
  const name = catDraft.value.trim()
  if (!name) return
  const d = await act({ action: 'category-add', name }, `已建分类「${name}」`)
  if (d?.category?.id) {
    pickedId.value = d.category.id
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
  await act({ action: 'category-update', categoryId: cat.id, patch: { name: next } }, '已改名')
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
  await act({ action: 'category-remove', categoryId: cat.id }, '已删掉')
}

async function importPreset(preset: any) {
  if (!pickedId.value) {
    ElMessage.warning('先选一个分类（没有就新建一个），预设包是往分类里导')
    return
  }
  const cat = picked.value
  const d = await act({ action: 'import-preset', categoryId: pickedId.value, presetId: preset.id })
  if (d) ElMessage.success(`「${preset.name}」→「${cat?.name ?? ''}」：新增 ${d.added ?? 0} 个（并入别名 ${d.merged ?? 0}）`)
}

function resetDraft() {
  termDraft.value = { term: '', aliases: '', note: '' }
  termEditing.value = ''
}

function editTerm(item: any) {
  termEditing.value = item.term
  termDraft.value = { term: item.term, aliases: (item.aliases ?? []).join('、'), note: item.note ?? '' }
  void nextTick(() => termFormEl.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
}

async function saveTerm() {
  const term = termDraft.value.term.trim()
  if (!term) return
  const patch = { term, aliases: termDraft.value.aliases, note: termDraft.value.note }
  const d = termEditing.value
    ? await act({ action: 'term-update', categoryId: pickedId.value, oldTerm: termEditing.value, patch })
    : await act({ action: 'term-add', categoryId: pickedId.value, term: patch })
  if (d) {
    resetDraft()
    ElMessage.success('已保存')
  }
}

async function removeTerm(item: any) {
  const d = await act({ action: 'term-remove', categoryId: pickedId.value, term: item.term }, `已删掉「${item.term}」`)
  if (d && termEditing.value === item.term) resetDraft()
}

async function moveTerm(item: any, toId: string) {
  await act({ action: 'term-move', categoryId: pickedId.value, toCategoryId: toId, term: item.term }, `「${item.term}」已挪走`)
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
  const cat = picked.value
  const d = await act({ action: 'terms-add', categoryId: pickedId.value, terms })
  if (!d) return
  ElMessage.success(`「${cat?.name ?? ''}」新增 ${d.added ?? 0} 个（并入别名 ${d.merged ?? 0}）`)
  batchOpen.value = false
}

onMounted(load)
</script>

<template>
  <div class="ws-page ws-page--wide memo-hot">
    <PageHeader title="语音随记 · 热词" subtitle="分类 → 词表；纠错与标签都从这儿来。" icon="Notebook">
      <template #actions>
        <el-button size="small" @click="router.push('/memo')">
          <el-icon><Microphone /></el-icon>&nbsp;回随记
        </el-button>
        <el-button size="small" :loading="loading" @click="load">
          <el-icon><Refresh /></el-icon>&nbsp;刷新
        </el-button>
      </template>
    </PageHeader>

    <SidecarOffline v-if="!loading && !ready" what="热词库" @ready="load" />
    <template v-else>
      <section v-loading="loading" class="ws-card hot">
        <aside class="hot__cats">
          <header class="hot__head">
            <b>分类</b>
            <span class="ws-dim">{{ total }} 词</span>
          </header>
          <ul class="hot__list">
            <li
              v-for="c in categories"
              :key="c.id"
              class="hot__cat"
              :class="{ 'is-active': c.id === pickedId }"
              @click="pickedId = c.id"
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
            <li v-if="!categories.length" class="ws-dim hot__empty">还没有分类：先在下面建一个，再导入预设包。</li>
          </ul>
          <div class="hot__new">
            <el-input v-model="catDraft" size="small" placeholder="新建分类" @keyup.enter="addCategory" />
            <el-button size="small" :loading="busy" @click="addCategory">加</el-button>
          </div>
        </aside>

        <div class="hot__terms">
          <header class="hot__head">
            <b>{{ picked?.name ?? '先选一个分类' }}</b>
            <span v-if="picked?.note" class="ws-dim">{{ picked.note }}</span>
            <span class="ws-spacer" />
            <el-button size="small" :disabled="!picked" @click="openBatch">批量粘贴</el-button>
            <el-dropdown :disabled="!picked" @command="importPreset">
              <el-button size="small" :disabled="!picked">导入预设<el-icon><ArrowDown /></el-icon></el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item v-for="p in presets" :key="p.id" :command="p">{{ p.name }}（{{ p.count }} 词）</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </header>

          <div ref="termFormEl" class="hot__form" :class="{ 'is-editing': Boolean(termEditing) }">
            <span v-if="termEditing" class="hot__form-tag">改「{{ termEditing }}」</span>
            <el-input v-model="termDraft.term" size="small" placeholder="词（正确写法）" />
            <el-input v-model="termDraft.aliases" size="small" placeholder="常见错写，顿号分隔" />
            <el-input v-model="termDraft.note" size="small" placeholder="备注（可空）" />
            <el-button size="small" type="primary" :loading="busy" :disabled="!picked" @click="saveTerm">
              {{ termEditing ? '保存' : '新增' }}
            </el-button>
            <el-button v-if="termEditing" size="small" @click="resetDraft">取消</el-button>
          </div>

          <el-table :data="picked?.terms ?? []" size="small" max-height="52vh" class="hot__table">
            <el-table-column prop="term" label="词" width="170" show-overflow-tooltip />
            <el-table-column label="常见错写" min-width="200">
              <template #default="{ row }">
                <span v-if="(row.aliases ?? []).length" class="hot__aliases">{{ row.aliases.join('、') }}</span>
                <span v-else class="ws-dim">—</span>
              </template>
            </el-table-column>
            <el-table-column label="来源" width="82" align="center">
              <template #default="{ row }"><span class="src" :class="`src--${row.source}`">{{ sourceLabel(row.source) }}</span></template>
            </el-table-column>
            <el-table-column label="命中" width="68" align="center">
              <template #default="{ row }"><span :class="{ 'ws-dim': !row.hits }">{{ row.hits || '—' }}</span></template>
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
                          v-for="c in categories.filter((x: any) => x.id !== pickedId)"
                          :key="c.id"
                          :command="c.id"
                          >挪到「{{ c.name }}」</el-dropdown-item
                        >
                        <el-dropdown-item v-if="categories.length < 2" disabled>没有别的分类</el-dropdown-item>
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
                「{{ picked?.name ?? '这个分类' }}」还没有词：右上「导入预设」从预设包导，或在上面手动加/批量粘贴。
              </p>
            </template>
          </el-table>
          <p class="hot__foot ws-dim">
            纠错按「别名 → 词」先在本地替换一遍，再交给模型复核；标签优先从这里挑。改完对下一次整理生效。
          </p>
        </div>
      </section>
    </template>

    <el-dialog v-model="batchOpen" title="批量加词" width="620px" append-to-body>
      <p class="ws-dim">一行一个词；要给别名就写「词 | 别名1、别名2」。同名词自动并入别名，不会重复。</p>
      <el-input
        v-model="batchText"
        type="textarea"
        :autosize="{ minRows: 8, maxRows: 18 }"
        spellcheck="false"
        placeholder="登录 | 登陆、登路"
      />
      <template #footer>
        <span class="ws-dim" style="float: left; line-height: 32px">导入到「{{ picked?.name ?? '—' }}」</span>
        <el-button @click="batchOpen = false">取消</el-button>
        <el-button type="primary" :loading="busy" @click="submitBatch">加进去</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.memo-hot {
  --hot-pane: 58vh;
}
.hot {
  display: flex;
  gap: 18px;
  min-height: 420px;
}
.hot__cats {
  flex: 0 0 195px;
  display: flex;
  flex-direction: column;
  padding-right: 14px;
  border-right: 1px solid var(--ws-border);
}
.hot__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 10px;
  font-size: 13px;
}
.hot__head .ws-spacer {
  flex: 1 1 auto;
}
.hot__list {
  flex: 1 1 auto;
  min-height: 0;
  max-height: var(--hot-pane);
  overflow-y: auto;
  margin: 0;
  padding: 0;
  list-style: none;
}
.hot__cat {
  padding: 7px 9px;
  border-radius: var(--ws-radius);
  cursor: pointer;
}
.hot__cat:hover {
  background: var(--el-fill-color-light);
}
.hot__cat.is-active {
  background: var(--el-color-primary-light-9);
}
.hot__cat-name {
  font-size: 12.5px;
  font-weight: 600;
}
.hot__cat-meta {
  display: flex;
  gap: 8px;
  margin-top: 2px;
  font-size: 11px;
  color: var(--ws-text-3);
}
.hot__cat-ops {
  display: none;
  gap: 2px;
  margin-top: 2px;
}
.hot__cat:hover .hot__cat-ops,
.hot__cat.is-active .hot__cat-ops {
  display: flex;
}
.hot__empty {
  padding: 6px 0;
  font-size: 12px;
}
.hot__new {
  display: flex;
  gap: 6px;
  margin-top: 10px;
}
.hot__terms {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.hot__form {
  position: relative;
  display: grid;
  grid-template-columns: 170px minmax(200px, 1fr) 190px auto auto;
  gap: 8px;
  align-items: center;
  margin-bottom: 10px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: var(--ws-radius);
}
.hot__form.is-editing {
  border-color: var(--el-color-primary-light-6);
  background: var(--el-color-primary-light-9);
  padding-top: 20px;
}
.hot__form-tag {
  position: absolute;
  top: 3px;
  left: 12px;
  font-size: 11px;
  color: var(--ws-accent);
}
@media (max-width: 1100px) {
  .hot__form {
    grid-template-columns: 1fr 1fr;
  }
}
.hot__table :deep(.el-table__cell) {
  padding: 6px 0;
}
.hot__aliases {
  color: var(--ws-text-3);
  font-family: var(--ws-mono);
  font-size: 11.5px;
}
.hot__table-empty {
  margin: 18px 0;
  color: var(--ws-text-3);
  font-size: 12px;
  text-align: center;
}
.hot__ops {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
}
.hot__ops .el-button {
  padding: 3px 5px;
  font-size: 14px;
  color: var(--ws-text-3);
}
.hot__ops .el-button:hover {
  color: var(--ws-accent);
}
.hot__ops .hot__del:hover {
  color: var(--el-color-danger);
}
.src {
  padding: 0 5px;
  border: 1px solid var(--ws-border);
  border-radius: 999px;
  color: var(--ws-text-3);
  font-size: 10.5px;
  line-height: 15px;
}
.src--auto {
  border-color: var(--el-color-success-light-6);
  background: var(--el-color-success-light-9);
}
.src--manual {
  border-color: var(--el-color-primary-light-6);
  background: var(--el-color-primary-light-9);
  color: var(--ws-accent);
}
.hot__foot {
  margin: 10px 0 0;
  font-size: 11.5px;
  line-height: 1.7;
}
</style>
