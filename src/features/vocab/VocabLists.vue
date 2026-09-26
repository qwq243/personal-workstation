<script setup lang="ts">
/**
 * 词单管理：新建 / 导入 / 查看编辑词条 / 导出 / 复制 / 删除。
 * 词条编辑直接改 store 里的对象，deep watch 会自动落盘。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useVocabStore } from './store'
import { exportWordsToCSV, exportWordsToText, newId, parseWordText } from './parser'
import { GOAL_LABEL, type VocabWord, type WordGoal, type WordList } from './types'
import SpeakButton from './SpeakButton.vue'
import { dueBucket, viewStat } from './srs'

const store = useVocabStore()
const router = useRouter()

/* ------------------------------------------------------------ 新建词单 --- */
const createOpen = ref(false)
const createForm = ref({ name: '', description: '', text: '' })
const createPreview = ref<ReturnType<typeof parseWordText> | null>(null)

function openCreate() {
  createForm.value = { name: '', description: '', text: '' }
  createPreview.value = null
  createOpen.value = true
}

function doPreview() {
  createPreview.value = createForm.value.text.trim() ? parseWordText(createForm.value.text) : null
}

function formatImportMsg(prefix: string, r: { added: number; skippedDuplicate: number; skippedGlobal: number; enriched: number }, parsed = 0) {
  const bits = [`${prefix}，新增 ${r.added} 条`]
  if (r.skippedDuplicate) bits.push(`本词单重复 ${r.skippedDuplicate}`)
  if (r.skippedGlobal) bits.push(`全库已有 ${r.skippedGlobal}`)
  if (r.enriched) bits.push(`补全已有词 ${r.enriched} 处`)
  if (parsed && !r.added && !r.skippedDuplicate && !r.skippedGlobal) bits.push(`解析 ${parsed} 条但都没写入`)
  return bits.join('，')
}

function saveCreate() {
  if (!createForm.value.name.trim()) {
    ElMessage.warning('给词单起个名字')
    return
  }
  const parsed = createForm.value.text.trim() ? parseWordText(createForm.value.text) : { words: [], stats: { parsed: 0, skipped: 0, bare: 0 } }
  const now = Date.now()
  const id = `list_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`
  store.addList({
    id,
    name: createForm.value.name.trim(),
    description: createForm.value.description.trim() || undefined,
    words: [],
    createdAt: now,
    updatedAt: now,
    source: 'user',
  })
  const r = parsed.words.length ? store.addWordsToList(id, parsed.words) : { added: 0, skippedDuplicate: 0, skippedGlobal: 0, enriched: 0 }
  createOpen.value = false
  ElMessage.success(formatImportMsg('已创建词单', r, parsed.words.length))
}

/* -------------------------------------------------------------- 导入 --- */
const importOpen = ref(false)
const importText = ref('')
const importTarget = ref('__new__')
const importName = ref('')
const importPreview = ref<ReturnType<typeof parseWordText> | null>(null)

function openImport() {
  importText.value = ''
  // 默认新建词单：内置词单的内容由代码维护，追加进去的词不会长期保留
  importTarget.value = '__new__'
  importName.value = ''
  importPreview.value = null
  importOpen.value = true
}

function doImportPreview() {
  importPreview.value = importText.value.trim() ? parseWordText(importText.value) : null
  if (importPreview.value && !importName.value) {
    importName.value = `导入词单 ${new Date().toLocaleDateString('zh-CN')}`
  }
}

function runImport() {
  if (!importText.value.trim()) {
    ElMessage.warning('先把单词内容粘进来')
    return
  }
  const parsed = parseWordText(importText.value)
  if (!parsed.words.length) {
    ElMessage.error('没解析出任何词条，检查一下格式')
    return
  }
  if (importTarget.value === '__new__') {
    const now = Date.now()
    const id = `list_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`
    store.addList({
      id,
      name: importName.value.trim() || `导入词单 ${now}`,
      description: '由文本导入生成',
      words: [],
      createdAt: now,
      updatedAt: now,
      source: 'import',
    })
    const r = store.addWordsToList(id, parsed.words)
    ElMessage.success(formatImportMsg('已新建词单', r, parsed.words.length))
  } else {
    const r = store.addWordsToList(importTarget.value, parsed.words)
    ElMessage.success(formatImportMsg('已写入该词单', r, parsed.words.length))
  }
  importOpen.value = false
}

/** 支持直接拖 / 选 .txt .csv 文件 */
async function onPickFile(e: Event) {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  if (!f) return
  importText.value = await f.text()
  doImportPreview()
  input.value = ''
}

/* ---------------------------------------------------------- 词条抽屉 --- */
const editing = ref<WordList | null>(null)
const drawerOpen = ref(false)
const wordFilter = ref('')
const addWordsText = ref('')
const addWordsOpen = ref(false)

function openEdit(list: WordList) {
  editing.value = list
  wordFilter.value = ''
  drawerOpen.value = true
}

const filteredWords = computed<VocabWord[]>(() => {
  const l = editing.value
  if (!l) return []
  const q = wordFilter.value.trim().toLowerCase()
  if (!q) return l.words
  return l.words.filter(
    (w) => w.term.toLowerCase().includes(q) || w.meaning.toLowerCase().includes(q),
  )
})

function removeWordRow(id: VocabWord['id']) {
  if (!editing.value) return
  store.removeWord(editing.value.id, id)
}

function confirmAddWords() {
  if (!editing.value || !addWordsText.value.trim()) return
  const parsed = parseWordText(addWordsText.value)
  const r = store.addWordsToList(editing.value.id, parsed.words)
  addWordsText.value = ''
  addWordsOpen.value = false
  ElMessage.success(formatImportMsg('已加入', r, parsed.words.length))
}

function exampleCount(row: VocabWord) {
  const n = row.examples?.length ?? 0
  return n || (row.example ? 1 : 0)
}

function addExample(row: VocabWord) {
  if (!row.examples) row.examples = row.example ? [{ en: row.example, zh: row.exampleZh, source: 'user' }] : []
  row.examples.push({ en: '', zh: '', source: 'user' })
}

function addBlankRow() {
  if (!editing.value) return
  editing.value.words.push({ id: newId('w'), term: '', meaning: '', tags: [] } as VocabWord)
  ElMessage.info('已在末尾插入一行，直接在表格里填写')
}

/* ------------------------------------------------------------ 操作 --- */
function practice(listId: string) {
  router.push({ path: '/vocab/study', query: { list: listId } })
}

async function exportList(list: WordList, kind: 'txt' | 'csv') {
  const text = kind === 'csv' ? exportWordsToCSV(list.words) : exportWordsToText(list.words)
  const type = kind === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8'
  const blob = new Blob([text], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${list.name.replace(/[\\/:*?"<>|]/g, '_')}.${kind}`
  a.click()
  URL.revokeObjectURL(url)
  ElMessage.success(`已导出 ${list.words.length} 个词条`)
}

async function removeList(list: WordList) {
  await ElMessageBox.confirm(
    `删除词单「${list.name}」？词条会一并删除，相关做题记录也会从错题本里消失。`,
    '删除词单',
    { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
  )
  store.removeList(list.id)
  ElMessage.success('已删除')
}

async function clearListStats(list: WordList) {
  await ElMessageBox.confirm(`清空「${list.name}」里所有词条的做题记录？词条本身保留。`, '清空学情', {
    type: 'warning',
    confirmButtonText: '清空',
    cancelButtonText: '取消',
  })
  store.clearStatsForList(list.id)
  ElMessage.success('已清空该词单的做题记录')
}

const sourceLabel: Record<WordList['source'], string> = {
  builtin: '内置',
  user: '自建',
  import: '导入',
}

function statLine(list: WordList) {
  const answered = list.words.reduce((s, w) => {
    const st = store.statOf(w.id)
    return s + (st ? st.right + st.wrong : 0)
  }, 0)
  const mastered = list.words.filter((w) => (store.statOf(w.id)?.streak ?? 0) >= store.settings.masterStreak).length
  const due = list.words.filter((w) => {
    const b = dueBucket(viewStat(store.statOf(w.id), w.id, w.term))
    return b === 'overdue' || b === 'learning'
  }).length
  return { answered, mastered, due }
}
</script>

<template>
  <div class="ws-page ws-page--wide">
    <div class="ws-page-head">
      <div>
        <h1 class="ws-title"><el-icon style="color: var(--ws-accent)"><Notebook /></el-icon>词单管理</h1>
        <p class="ws-subtitle">共 {{ store.lists.length }} 个词单、{{ store.totalWords }} 个词条</p>
      </div>
      <div class="ws-row">
        <el-button @click="openImport">
          <el-icon><Upload /></el-icon>&nbsp;导入单词
        </el-button>
        <el-button type="primary" @click="openCreate">
          <el-icon><Plus /></el-icon>&nbsp;新建词单
        </el-button>
      </div>
    </div>

    <div class="cards">
      <div v-for="list in store.lists" :key="list.id" class="lcard">
        <div class="lcard__head">
          <div class="lcard__title">{{ list.name }}</div>
          <span class="src" :class="`src--${list.source}`">{{ sourceLabel[list.source] }}</span>
        </div>
        <div class="lcard__desc">{{ list.description || '（无描述）' }}</div>

        <div class="lcard__metrics">
          <div><b>{{ list.words.length }}</b><span>词条</span></div>
          <div><b>{{ statLine(list).due }}</b><span>到期</span></div>
          <div><b>{{ statLine(list).mastered }}</b><span>已掌握</span></div>
        </div>

        <div class="lcard__actions">
          <el-button type="primary" size="small" @click="practice(list.id)">
            <el-icon><VideoPlay /></el-icon>&nbsp;练习
          </el-button>
          <el-button size="small" @click="openEdit(list)">词条</el-button>
          <el-dropdown trigger="click">
            <el-button size="small"><el-icon><MoreFilled /></el-icon></el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item @click="store.duplicateList(list.id, false)">
                  <el-icon><CopyDocument /></el-icon>复制词单
                </el-dropdown-item>
                <el-dropdown-item @click="exportList(list, 'txt')">
                  <el-icon><Document /></el-icon>导出 TXT
                </el-dropdown-item>
                <el-dropdown-item @click="exportList(list, 'csv')">
                  <el-icon><Document /></el-icon>导出 CSV（Excel）
                </el-dropdown-item>
                <el-dropdown-item divided @click="clearListStats(list)">
                  <el-icon><Refresh /></el-icon>清空该词单学情
                </el-dropdown-item>
                <el-dropdown-item v-if="list.source !== 'builtin'" divided @click="removeList(list)">
                  <el-icon><Delete /></el-icon>删除词单
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </div>
    </div>

    <!-- =================================================== 新建词单对话框 -->
    <el-dialog v-model="createOpen" title="新建词单" width="640px">
      <el-form label-width="72px">
        <el-form-item label="名称" required>
          <el-input v-model="createForm.name" placeholder="例如：核心词 Day 3" maxlength="60" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="createForm.description" placeholder="可选，写点备注" maxlength="120" />
        </el-form-item>
        <el-form-item label="词条">
          <el-input
            v-model="createForm.text"
            type="textarea"
            :rows="9"
            placeholder="每行一个词，可只写单词，也可带上释义与例句：&#10;conceal /kənˈsiːl/ v. 隐藏，隐瞒&#10;coincidence 巧合&#10;supper&#10;&#10;也支持 Tab / | / 逗号分隔：&#10;reward&#9;奖励&#9;He received a reward."
            @blur="doPreview"
          />
          <div class="hint">
            支持格式：<code>单词</code>、<code>单词 释义</code>、<code>单词 /音标/ 词性 释义</code>、
            <code>单词Tab释义Tab例句</code>、<code>单词 | 释义 | 例句</code>；行首编号会自动去掉。
          </div>
        </el-form-item>
        <el-form-item v-if="createPreview" label="预览">
          <div class="preview">
            解析出 <b>{{ createPreview.stats.parsed }}</b> 个词条
            <span v-if="createPreview.stats.bare">（其中 {{ createPreview.stats.bare }} 个只有单词、没释义）</span>
            <span v-if="createPreview.stats.skipped">，跳过 {{ createPreview.stats.skipped }} 行</span>
            <div v-for="w in createPreview.words.slice(0, 6)" :key="w.id" class="preview__row">
              <b>{{ w.term }}</b>
              <span class="ws-dim" v-if="w.phonetic">/{{ w.phonetic }}/</span>
              <span class="ws-dim" v-if="w.pos">{{ w.pos }}</span>
              <span>{{ w.meaning }}</span>
            </div>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createOpen = false">取消</el-button>
        <el-button @click="doPreview">解析预览</el-button>
        <el-button type="primary" @click="saveCreate">创建</el-button>
      </template>
    </el-dialog>

    <!-- ======================================================= 导入对话框 -->
    <el-dialog v-model="importOpen" title="导入单词" width="660px">
      <el-form label-width="72px">
        <el-form-item label="导入到">
          <el-select v-model="importTarget" style="width: 100%">
            <el-option label="新建一个词单" value="__new__" />
            <el-option v-for="l in store.lists" :key="l.id" :label="`追加到：${l.name}`" :value="l.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="importTarget === '__new__'" label="新词单名">
          <el-input v-model="importName" placeholder="留空则自动命名" />
        </el-form-item>
        <el-form-item label="内容">
          <el-input
            v-model="importText"
            type="textarea"
            :rows="10"
            placeholder="把单词粘在这里，一行一个。也支持带释义、音标、例句的多种格式。"
            @blur="doImportPreview"
          />
          <div class="hint">
            <label class="pick-file">
              或选择文件（.txt / .csv）
              <input type="file" accept=".txt,.csv,text/plain,text/csv" hidden @change="onPickFile" />
            </label>
            <span v-if="importPreview" style="margin-left: 12px">
              已解析 <b>{{ importPreview.stats.parsed }}</b> 条
            </span>
          </div>
        </el-form-item>
        <el-form-item v-if="importPreview" label="预览">
          <div class="preview">
            <div v-for="w in importPreview.words.slice(0, 8)" :key="w.id" class="preview__row">
              <b>{{ w.term }}</b>
              <span class="ws-dim" v-if="w.phonetic">/{{ w.phonetic }}/</span>
              <span class="ws-dim" v-if="w.pos">{{ w.pos }}</span>
              <span>{{ w.meaning }}</span>
            </div>
            <div v-if="importPreview.words.length > 8" class="ws-dim">
              …还有 {{ importPreview.words.length - 8 }} 条
            </div>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="importOpen = false">取消</el-button>
        <el-button @click="doImportPreview">解析预览</el-button>
        <el-button type="primary" @click="runImport">导入</el-button>
      </template>
    </el-dialog>

    <!-- ==================================================== 词条编辑抽屉 -->
    <el-drawer v-model="drawerOpen" size="72%" :title="editing ? `词条 · ${editing.name}` : '词条'">
      <div v-if="editing" class="drawer">
        <div class="drawer__bar">
          <el-input v-model="wordFilter" placeholder="搜索单词或释义" clearable style="width: 230px" size="small" />
          <span class="ws-dim">{{ filteredWords.length }} / {{ editing.words.length }}</span>
          <div class="ws-spacer" />
          <el-button size="small" @click="addBlankRow"><el-icon><Plus /></el-icon>&nbsp;加一行</el-button>
          <el-button size="small" @click="addWordsOpen = !addWordsOpen">
            <el-icon><Upload /></el-icon>&nbsp;批量粘贴
          </el-button>
          <el-button size="small" @click="exportList(editing, 'csv')">导出 CSV</el-button>
        </div>

        <div v-if="addWordsOpen" class="drawer__add">
          <el-input
            v-model="addWordsText"
            type="textarea"
            :rows="4"
            placeholder="粘贴要追加的单词（每行一个，格式同导入）"
          />
          <el-button type="primary" size="small" style="margin-top: 8px" @click="confirmAddWords">
            加入词单
          </el-button>
        </div>

        <el-table :data="filteredWords" height="calc(100vh - 260px)" size="small" border>
          <el-table-column label="单词 / 短语" width="230">
            <template #default="{ row }">
              <div class="term-cell">
                <el-input v-model="row.term" size="small" placeholder="term" />
                <SpeakButton v-if="row.term" :term="row.term" />
              </div>
            </template>
          </el-table-column>
          <el-table-column label="要求" width="120">
            <template #default="{ row }">
              <el-select v-model="row.goal" size="small" placeholder="听懂" clearable>
                <el-option v-for="(lab, g) in GOAL_LABEL" :key="g" :label="lab" :value="g as WordGoal" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="音标" width="150">
            <template #default="{ row }">
              <el-input v-model="row.phonetic" size="small" placeholder="可选" />
            </template>
          </el-table-column>
          <el-table-column label="词性" width="90">
            <template #default="{ row }">
              <el-input v-model="row.pos" size="small" placeholder="v." />
            </template>
          </el-table-column>
          <el-table-column label="中文释义" min-width="200">
            <template #default="{ row }">
              <el-input v-model="row.meaning" size="small" placeholder="多个义项用 ; 分隔" />
            </template>
          </el-table-column>
          <el-table-column label="例句" min-width="320">
            <template #default="{ row }">
              <div class="ex-stack">
                <template v-if="row.examples?.length">
                  <div v-for="(ex, i) in row.examples" :key="i" class="ex-row">
                    <el-input v-model="ex.en" size="small" placeholder="英文例句" />
                    <el-input v-model="ex.zh" size="small" placeholder="中文" />
                    <el-button link type="danger" size="small" @click="row.examples.splice(i, 1)">删</el-button>
                  </div>
                </template>
                <template v-else>
                  <el-input v-model="row.example" size="small" placeholder="英文例句" />
                  <el-input v-model="row.exampleZh" size="small" placeholder="中文" style="margin-top: 4px" />
                </template>
                <el-button link type="primary" size="small" @click="addExample(row as VocabWord)">+ 加例句（{{ exampleCount(row as VocabWord) }}）</el-button>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="备注" min-width="180">
            <template #default="{ row }">
              <el-input v-model="row.note" size="small" placeholder="可选" />
            </template>
          </el-table-column>
          <el-table-column width="64" align="center">
            <template #default="{ row }">
              <el-button link type="danger" size="small" @click="removeWordRow(row.id)">删</el-button>
            </template>
          </el-table-column>
        </el-table>
        <div class="ws-dim" style="font-size: 12px; margin-top: 10px">
          表格里的修改会即时保存。例句可不断追加，填空会从含该词的句子里轮换出题。
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
}
.lcard {
  border: 1px solid var(--ws-border);
  border-radius: var(--ws-radius-lg);
  background: var(--ws-panel);
  padding: 18px;
  box-shadow: var(--ws-shadow-sm);
  display: flex;
  flex-direction: column;
  transition: box-shadow 0.16s ease, transform 0.16s ease;
}
.lcard:hover {
  box-shadow: var(--ws-shadow);
  transform: translateY(-2px);
}
.lcard__head {
  display: flex;
  align-items: center;
  gap: 9px;
}
.lcard__title {
  font-size: 15px;
  font-weight: 650;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.src {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 99px;
  flex: 0 0 auto;
}
.src--builtin {
  color: var(--ws-accent);
  background: var(--ws-accent-soft);
}
.src--user {
  color: var(--ws-success);
  background: var(--ws-success-soft);
}
.src--import {
  color: var(--ws-warn);
  background: var(--ws-warn-soft);
}
.lcard__desc {
  color: var(--ws-text-2);
  font-size: 12.8px;
  margin-top: 6px;
  min-height: 34px;
  line-height: 1.5;
}
.lcard__metrics {
  display: flex;
  gap: 22px;
  padding: 13px 0;
  margin-top: 6px;
  border-top: 1px dashed var(--ws-border);
  border-bottom: 1px dashed var(--ws-border);
}
.lcard__metrics > div {
  display: flex;
  flex-direction: column;
}
.lcard__metrics b {
  font-size: 18px;
  font-weight: 700;
  color: var(--ws-accent);
  line-height: 1.2;
}
.lcard__metrics span {
  font-size: 11.5px;
  color: var(--ws-text-3);
}
.lcard__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
}

.hint {
  font-size: 12px;
  color: var(--ws-text-3);
  margin-top: 6px;
  line-height: 1.7;
}
.hint code,
.drawer code {
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
  border-radius: 4px;
  padding: 0 4px;
  font-size: 11.5px;
}
.pick-file {
  color: var(--ws-accent);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.preview {
  width: 100%;
  font-size: 12.5px;
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
  border-radius: var(--ws-radius-sm);
  padding: 10px 12px;
  line-height: 1.8;
  max-height: 200px;
  overflow-y: auto;
}
.preview__row {
  display: flex;
  gap: 8px;
  align-items: baseline;
  border-top: 1px dashed var(--ws-border);
  padding-top: 3px;
  margin-top: 3px;
}

.drawer {
  display: flex;
  flex-direction: column;
}
.drawer__bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.drawer__add {
  margin-bottom: 12px;
  padding: 12px;
  border: 1px dashed var(--ws-border-strong);
  border-radius: var(--ws-radius);
  background: var(--ws-panel-2);
}
.term-cell {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ex-stack { display: flex; flex-direction: column; gap: 4px; }
.ex-row { display: flex; gap: 6px; align-items: center; }
</style>
