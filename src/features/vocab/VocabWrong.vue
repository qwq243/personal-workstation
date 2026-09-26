<script setup lang="ts">
/** 错题本：所有错过的词集中复习，可按词单筛、可清空单条记录。 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import EmptyState from '@/components/EmptyState.vue'
import { useVocabStore } from './store'
import SpeakButton from './SpeakButton.vue'

const store = useVocabStore()
const router = useRouter()

const listFilter = ref<string>('all')
const keyword = ref('')
const expanded = ref<string | null>(null)

const listOptions = computed(() => [
  { label: '全部词单', value: 'all' },
  ...store.lists
    .filter((l) => store.wrongBook.some((w) => w.listId === l.id))
    .map((l) => ({ label: l.name, value: l.id })),
])

const rows = computed(() =>
  store.wrongBook
    .filter((e) => (listFilter.value === 'all' ? true : e.listId === listFilter.value))
    .filter((e) => {
      const q = keyword.value.trim().toLowerCase()
      if (!q) return true
      return e.word.term.toLowerCase().includes(q) || e.word.meaning.toLowerCase().includes(q)
    }),
)

const totalWrong = computed(() => store.wrongBook.reduce((s, e) => s + e.stat.wrong, 0))

function toggle(term: string) {
  expanded.value = expanded.value === term ? null : term
}

function practiceList(listId: string) {
  router.push({ path: '/vocab/study', query: { list: listId } })
}

function practiceAllWrong() {
  // 用所有错题词所在的第一个词单开始练，并强制错题优先
  const first = store.wrongBook[0]
  if (first) router.push({ path: '/vocab/study', query: { list: first.listId } })
}

function forget(wordId: string, term: string) {
  const next = { ...store.stats }
  delete next[wordId]
  store.stats = next
  ElMessage.success(`已从错题本移除「${term}」`)
}
</script>

<template>
  <div class="ws-page ws-page--wide">
    <div class="ws-page-head">
      <div>
        <h1 class="ws-title"><el-icon style="color: var(--ws-danger)"><WarningFilled /></el-icon>错题本</h1>
        <p class="ws-subtitle">
          {{ store.wrongBook.length }} 个词进过错题，累计错 {{ totalWrong }} 次
        </p>
      </div>
      <div class="ws-row">
        <el-button v-if="store.wrongBook.length" type="primary" @click="practiceAllWrong">
          <el-icon><VideoPlay /></el-icon>&nbsp;开始练错题
        </el-button>
        <el-button @click="router.push('/vocab/study')">常规练习</el-button>
      </div>
    </div>

    <div v-if="store.wrongBook.length" class="ws-card pad toolbar">
      <el-select v-model="listFilter" style="width: 220px">
        <el-option v-for="o in listOptions" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>
      <el-input v-model="keyword" placeholder="搜索单词或释义" clearable style="width: 230px" />
      <span class="ws-dim">{{ rows.length }} 条</span>
      <div class="ws-spacer" />
      <span class="ws-dim tiny">排在前面的错得更多、更近</span>
    </div>

    <div v-if="!store.wrongBook.length" class="ws-card" style="margin-top: 8px">
      <EmptyState
        title="错题本是空的"
        description="答错的词会自动进到这里；连续答对后也会保留记录，方便你回看。"
        icon="CircleCheck"
      >
        <el-button type="primary" @click="router.push('/vocab/study')">去做一轮练习</el-button>
      </EmptyState>
    </div>

    <div v-else class="ws-card">
      <div v-for="e in rows" :key="e.word.id" class="wrow" :class="{ 'is-open': expanded === e.word.term }">
        <div class="wrow__main" @click="toggle(e.word.term)">
          <div class="wrow__term">
            {{ e.word.term }}
            <SpeakButton :term="e.word.term" @click.stop />
            <span v-if="e.word.phonetic" class="ws-mono ws-dim">/{{ e.word.phonetic }}/</span>
            <span v-if="e.word.pos" class="ws-dim">{{ e.word.pos }}</span>
          </div>
          <div class="wrow__mean">{{ e.word.meaning }}</div>
          <div class="wrow__tags">
            <span class="tag tag--bad">错 {{ e.stat.wrong }}</span>
            <span class="tag tag--ok">对 {{ e.stat.right }}</span>
            <span class="tag">{{ e.listName }}</span>
          </div>
          <el-icon class="wrow__chev" :class="{ 'is-open': expanded === e.word.term }"><ArrowDown /></el-icon>
        </div>

        <div v-if="expanded === e.word.term" class="wrow__detail">
          <div v-if="e.word.examples?.length || e.word.example" class="wrow__ex">
            <div v-for="(ex, i) in (e.word.examples?.length ? e.word.examples : [{ en: e.word.example, zh: e.word.exampleZh }])" :key="i">
              {{ ex.en }}
              <div v-if="ex.zh" class="ws-dim">{{ ex.zh }}</div>
            </div>
          </div>
          <div v-if="e.word.note" class="wrow__note">
            <el-icon><InfoFilled /></el-icon>&nbsp;{{ e.word.note }}
          </div>
          <div class="wrow__ops">
            <el-button size="small" @click="practiceList(e.listId)">
              <el-icon><VideoPlay /></el-icon>&nbsp;练这个词单
            </el-button>
            <el-button size="small" type="danger" plain @click="forget(e.word.id, e.word.term)">
              <el-icon><Delete /></el-icon>&nbsp;从错题本移除
            </el-button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pad {
  padding: 14px 18px;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.tiny {
  font-size: 12px;
}
.wrow {
  border-bottom: 1px solid var(--ws-border);
}
.wrow:last-child {
  border-bottom: none;
}
.wrow__main {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 13px 20px;
  cursor: pointer;
  transition: background 0.14s ease;
}
.wrow__main:hover {
  background: var(--ws-panel-2);
}
.wrow__term {
  font-size: 15.5px;
  font-weight: 650;
  min-width: 210px;
  display: flex;
  gap: 8px;
  align-items: baseline;
}
.wrow__mean {
  flex: 1;
  min-width: 0;
  font-size: 13.5px;
  color: var(--ws-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wrow__tags {
  display: flex;
  gap: 6px;
  flex: 0 0 auto;
}
.tag {
  font-size: 11.5px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 99px;
  color: var(--ws-text-2);
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
}
.tag--bad {
  color: var(--ws-danger);
  background: var(--ws-danger-soft);
  border-color: transparent;
}
.tag--ok {
  color: var(--ws-success);
  background: var(--ws-success-soft);
  border-color: transparent;
}
.wrow__chev {
  color: var(--ws-text-3);
  transition: transform 0.16s ease;
}
.wrow__chev.is-open {
  transform: rotate(180deg);
}
.wrow__detail {
  padding: 0 20px 16px 20px;
}
.wrow__ex {
  font-size: 13.5px;
  color: var(--ws-text-2);
  padding-left: 12px;
  border-left: 3px solid var(--ws-danger);
  line-height: 1.65;
}
.wrow__note {
  margin-top: 10px;
  font-size: 12.8px;
  color: var(--ws-text-2);
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
  border-radius: var(--ws-radius-sm);
  padding: 8px 11px;
  display: flex;
  align-items: flex-start;
}
.wrow__ops {
  display: flex;
  gap: 10px;
  margin-top: 13px;
}
</style>
