<script setup lang="ts">
/**
 * 练习页：设置 → 答题 → 结果。
 * 键盘：选择题按 1~4 直接选；输入题回车提交，判分后回车进下一题。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useVocabStore } from './store'
import { buildDiagnostic, buildQuestions, judge, skillOf } from './engine'
import { QUESTION_TYPES, type AnswerResult, type Question, type QuestionType, type SessionAnswer, type StudyOrder, type VocabWord } from './types'
import { loadJSON, saveJSON } from '@/core/storage'
import SpeakButton from './SpeakButton.vue'
import { speakTerm, stopSpeaking, unlockAudio } from './speak'

const store = useVocabStore()
const route = useRoute()
const router = useRouter()

type Phase = 'setup' | 'running' | 'done'

interface PersistedForm {
  listId: string
  count: number
  types: QuestionType[]
  order: StudyOrder
}

const savedForm = loadJSON<PersistedForm>('vocab.form.v1', {
  listId: '',
  count: 0,
  types: QUESTION_TYPES.map((t) => t.value),
  order: 'due-first',
})

const form = ref<PersistedForm>({
  listId: savedForm.listId || store.lists[0]?.id || '',
  count: savedForm.count ?? 0,
  types: savedForm.types?.length ? savedForm.types : QUESTION_TYPES.map((t) => t.value),
  order: savedForm.order ?? 'due-first',
})

const phase = ref<Phase>('setup')
const questions = ref<Question[]>([])
const cursor = ref(0)
const results = ref<AnswerResult[]>([])
const input = ref('')
const chosenIndex = ref<number | null>(null)
const revealed = ref(false)
const lastCorrect = ref(false)
const startedAt = ref(0)
const elapsed = ref(0)
const inputRef = ref<HTMLInputElement | null>(null)
const sessionId = ref('')
const resumed = ref(false)
let timer: number | undefined
let persistTimer: ReturnType<typeof setTimeout> | undefined

const activeList = computed(() => store.listById(form.value.listId))
const current = computed<Question | undefined>(() => questions.value[cursor.value])
const currentWord = computed<VocabWord | undefined>(() =>
  current.value ? store.wordIndex.get(current.value.wordId)?.word : undefined,
)
const progress = computed(() =>
  questions.value.length ? Math.round(((cursor.value + (revealed.value ? 1 : 0)) / questions.value.length) * 100) : 0,
)
const correctCount = computed(() => results.value.filter((r) => r.correct).length)
const wrongResults = computed(() => results.value.filter((r) => !r.correct))
const scorePct = computed(() =>
  results.value.length ? Math.round((correctCount.value / results.value.length) * 100) : 0,
)
/** 题干本身就是英文时，旁边给喇叭，并在出题时自动读一遍 */
const stemIsEnglish = computed(() => {
  const q = current.value
  return !!q && (q.type === 'en2zh' || q.type === 'zh-input')
})

function toAnswer(r: AnswerResult, at = Date.now()): SessionAnswer {
  return {
    wordId: r.word.id,
    term: r.word.term,
    meaning: r.word.meaning,
    phonetic: r.word.phonetic,
    type: r.question.type,
    given: r.given,
    expected: r.expected,
    correct: r.correct,
    at,
  }
}

function persistNow() {
  if (phase.value !== 'running' || !sessionId.value) return
  store.saveCheckpoint({
    sessionId: sessionId.value,
    listId: form.value.listId,
    listName: activeList.value?.name ?? '',
    form: { ...form.value },
    questions: questions.value,
    cursor: cursor.value,
    revealed: revealed.value,
    input: input.value,
    chosenIndex: chosenIndex.value,
    lastCorrect: lastCorrect.value,
    answers: results.value.map((r) => toAnswer(r)),
    startedAt: startedAt.value,
    updatedAt: Date.now(),
  })
}

function persistSoon() {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = undefined
    persistNow()
    void store.flush()
  }, 200)
}

function startTimer() {
  if (timer) window.clearInterval(timer)
  timer = window.setInterval(() => {
    elapsed.value = Math.floor((Date.now() - startedAt.value) / 1000)
  }, 1000)
}

function restoreFromCheckpoint(): boolean {
  const cp = store.active
  if (!cp?.questions?.length || !store.listById(cp.listId)) return false
  form.value = { ...cp.form }
  sessionId.value = cp.sessionId
  questions.value = cp.questions
  cursor.value = Math.min(cp.cursor, Math.max(0, cp.questions.length - 1))
  revealed.value = !!cp.revealed
  input.value = cp.input || ''
  chosenIndex.value = cp.chosenIndex
  lastCorrect.value = !!cp.lastCorrect
  startedAt.value = cp.startedAt
  elapsed.value = Math.floor((Date.now() - cp.startedAt) / 1000)
  results.value = cp.answers.map((a) => {
    const q = cp.questions.find((x) => x.wordId === a.wordId && x.type === a.type) || cp.questions[0]
    const hit = store.wordIndex.get(a.wordId)
    return {
      question: q,
      given: a.given,
      correct: a.correct,
      expected: a.expected,
      word: hit?.word ?? { id: a.wordId, term: a.term, meaning: a.meaning, phonetic: a.phonetic },
    }
  })
  resumed.value = true
  phase.value = 'running'
  startTimer()
  focusInput()
  return true
}

function playTerm(term?: string) {
  const t = (term ?? currentWord.value?.term ?? current.value?.term ?? '').trim()
  if (!t) return
  void speakTerm(t).catch(() => {
    /* 按钮自己会报失败；自动朗读失败就静默，不打断答题 */
  })
}

/* ------------------------------------------------------------- 出题 --- */
function start() {
  const list = activeList.value
  if (!list || !list.words.length) {
    ElMessage.warning('请先选择一个有单词的词单')
    return
  }
  if (!form.value.types.length) {
    ElMessage.warning('至少勾选一种题型')
    return
  }
  saveJSON('vocab.form.v1', form.value)
  unlockAudio()

  const qs = buildQuestions({
    words: list.words,
    pool: list.words,
    types: form.value.types,
    order: form.value.order,
    count: form.value.count,
    stats: store.stats,
  })
  if (!qs.length) {
    ElMessage.warning('这个题型组合出不了题：可能是词单里没有例句、或全是短语。换个题型试试。')
    return
  }
  if (store.active?.answers?.length) store.abandonActive()
  questions.value = qs
  cursor.value = 0
  results.value = []
  resetQuestionState()
  startedAt.value = Date.now()
  elapsed.value = 0
  sessionId.value = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  resumed.value = false
  phase.value = 'running'
  startTimer()
  persistNow()
  void store.flush()
  focusInput()
  if (qs[0] && (qs[0].type === 'en2zh' || qs[0].type === 'zh-input' || qs[0].type === 'listen')) playTerm(qs[0].term)
}

function startDiagnostic() {
  const list = activeList.value
  if (!list || !list.words.length) {
    ElMessage.warning('请先选择一个有单词的词单')
    return
  }
  saveJSON('vocab.form.v1', form.value)
  unlockAudio()
  const qs = buildDiagnostic(list.words, list.words, 8)
  if (qs.length < 6) {
    ElMessage.warning('词单里适合诊断的词太少（需要能听、能拼的单词）')
    return
  }
  if (store.active?.answers?.length) store.abandonActive()
  questions.value = qs
  cursor.value = 0
  results.value = []
  resetQuestionState()
  startedAt.value = Date.now()
  elapsed.value = 0
  sessionId.value = `diag_${Date.now().toString(36)}`
  resumed.value = false
  phase.value = 'running'
  startTimer()
  persistNow()
  void store.flush()
  focusInput()
  if (qs[0] && (qs[0].type === 'en2zh' || qs[0].type === 'listen')) playTerm(qs[0].term)
}

function resetQuestionState() {
  input.value = ''
  chosenIndex.value = null
  revealed.value = false
  lastCorrect.value = false
}

function focusInput() {
  nextTick(() => inputRef.value?.focus())
}

/* ------------------------------------------------------------- 判分 --- */
function submitChoice(idx: number) {
  if (revealed.value) return
  chosenIndex.value = idx
  finishQuestion()
}

function submitInput() {
  if (revealed.value) return
  if (!input.value.trim()) {
    ElMessage.info('先写点什么再提交')
    return
  }
  finishQuestion()
}

function giveUp() {
  if (revealed.value) return
  input.value = ''
  finishQuestion()
}

function finishQuestion() {
  const q = current.value
  const word = currentWord.value
  if (!q || !word) return

  let correct: boolean
  let given: string
  if (q.kind === 'choice') {
    correct = chosenIndex.value === q.answerIndex
    given = chosenIndex.value != null ? q.options[chosenIndex.value] : ''
  } else {
    given = input.value
    correct = judge(q, given, store.settings, word)
  }

  lastCorrect.value = correct
  revealed.value = true
  playTerm(word.term)
  results.value.push({
    question: q,
    given,
    correct,
    expected: q.kind === 'choice' ? q.answer : q.display,
    word,
  })
  store.recordAnswer(word.id, word.term, correct, q.type)
  persistSoon()
}

function next() {
  if (!revealed.value) return
  if (cursor.value + 1 >= questions.value.length) {
    finish()
    return
  }
  cursor.value += 1
  resetQuestionState()
  persistSoon()
  focusInput()
  const q = questions.value[cursor.value]
  if (q && (q.type === 'en2zh' || q.type === 'zh-input' || q.type === 'listen')) playTerm(q.term)
}

function finish() {
  if (timer) window.clearInterval(timer)
  timer = undefined
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = undefined
  }
  const list = activeList.value
  store.finishSession({
    id: sessionId.value || `s_${Date.now().toString(36)}`,
    listId: list?.id ?? '',
    listName: list?.name ?? '',
    startedAt: startedAt.value,
    finishedAt: Date.now(),
    updatedAt: Date.now(),
    status: 'done',
    order: form.value.order,
    planned: questions.value.length,
    total: results.value.length,
    correct: correctCount.value,
    types: [...new Set(questions.value.map((q) => q.type))],
    wrong: wrongResults.value.map((r) => ({
      wordId: r.word.id,
      term: r.word.term,
      meaning: r.word.meaning,
      phonetic: r.word.phonetic,
    })),
    answers: results.value.map((r) => toAnswer(r)),
  })
  if (sessionId.value.startsWith('diag_')) store.saveDiagnosis(results.value, list?.id ?? '', list?.name ?? '')
  store.clearCheckpoint()
  void store.flush()
  phase.value = 'done'
}

function retryWrong() {
  const words = wrongResults.value.map((r) => r.word)
  if (!words.length) return
  const qs = buildQuestions({
    words,
    pool: activeList.value?.words ?? words,
    types: form.value.types,
    order: 'random',
    count: 0,
    stats: store.stats,
  })
  if (!qs.length) {
    ElMessage.warning('这些错题在当前题型下出不了题')
    return
  }
  questions.value = qs
  cursor.value = 0
  results.value = []
  resetQuestionState()
  startedAt.value = Date.now()
  elapsed.value = 0
  sessionId.value = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  resumed.value = false
  phase.value = 'running'
  startTimer()
  persistNow()
  void store.flush()
  focusInput()
  if (qs[0] && (qs[0].type === 'en2zh' || qs[0].type === 'zh-input' || qs[0].type === 'listen')) playTerm(qs[0].term)
}

function backToSetup() {
  if (timer) window.clearInterval(timer)
  timer = undefined
  stopSpeaking()
  if (phase.value === 'running' && results.value.length) persistNow()
  phase.value = 'setup'
}

/* ----------------------------------------------------------- 键盘 --- */
function onKeydown(e: KeyboardEvent) {
  if (phase.value !== 'running') return
  const q = current.value
  if (!q) return

  if (e.key === 'Enter') {
    e.preventDefault()
    if (revealed.value) next()
    else if (q.kind === 'input') submitInput()
    return
  }
  // s = speak：选择题随时可读题干；输入题等揭晓后再读，免得拼写题被读出答案
  if ((e.key === 's' || e.key === 'S') && (revealed.value || q.type === 'en2zh' || q.type === 'zh-input' || q.type === 'listen')) {
    if (q.kind === 'input' && !revealed.value && (e.target as HTMLElement | null)?.tagName === 'INPUT') return
    e.preventDefault()
    playTerm(revealed.value ? currentWord.value?.term : q.term)
    return
  }
  if (!revealed.value && q.kind === 'choice') {
    const n = Number(e.key)
    if (n >= 1 && n <= q.options.length) {
      e.preventDefault()
      submitChoice(n - 1)
    }
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  const q = route.query.list as string | undefined
  if (q && store.listById(q)) form.value.listId = q
  if (store.active?.questions?.length) restoreFromCheckpoint()
})
watch(
  () => store.active?.sessionId,
  (id) => {
    if (phase.value === 'setup' && id && store.active?.questions?.length && !sessionId.value) restoreFromCheckpoint()
  },
)
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  if (timer) window.clearInterval(timer)
  if (persistTimer) clearTimeout(persistTimer)
  if (phase.value === 'running') persistNow()
  stopSpeaking()
})

function fmtTime(s: number) {
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}分${String(s % 60).padStart(2, '0')}秒` : `${s}秒`
}

const orderOptions: { label: string; value: StudyOrder; hint: string }[] = [
  { label: '到期优先', value: 'due-first', hint: '按遗忘曲线：逾期 → 学习中 → 新词 → 未到期' },
  { label: '随机顺序', value: 'random', hint: '打乱后出题' },
  { label: '按词表顺序', value: 'list', hint: '按词单里的排列' },
  { label: '错题优先', value: 'wrong-first', hint: '错得多的先考' },
  { label: '未掌握优先', value: 'unmastered-first', hint: '连续答对次数少的先考' },
]

const countOptions = computed(() => {
  const total = activeList.value?.words.length ?? 0
  return [
    { label: '全部', value: 0 },
    { label: '10 个', value: Math.min(10, total) },
    { label: '20 个', value: Math.min(20, total) },
  ].filter((o, i, arr) => o.value > 0 && arr.findIndex((x) => x.value === o.value) === i)
})
</script>

<template>
  <div class="ws-page" :class="{ 'ws-page--wide': phase === 'running' }">
    <!-- ============================================================ 设置 -->
    <template v-if="phase === 'setup'">
      <div class="ws-page-head">
        <div>
          <h1 class="ws-title"><el-icon style="color: var(--ws-accent)"><EditPen /></el-icon>开始练习</h1>
          <p class="ws-subtitle">选词单、定题量与题型，然后开始答题</p>
        </div>
      </div>

      <div class="ws-card pad">
        <div class="field">
          <div class="field__label">词单</div>
          <el-select v-model="form.listId" placeholder="选择词单" style="width: 320px">
            <el-option v-for="l in store.lists" :key="l.id" :label="l.name" :value="l.id">
              <span>{{ l.name }}</span>
              <span class="ws-dim" style="float: right">{{ l.words.length }} 词</span>
            </el-option>
          </el-select>
          <span v-if="activeList" class="ws-dim">{{ activeList.words.length }} 个词条</span>
        </div>

        <div class="field">
          <div class="field__label">题量</div>
          <el-radio-group v-model="form.count">
            <el-radio-button :value="0">全部</el-radio-button>
            <el-radio-button v-for="o in countOptions" :key="o.value" :value="o.value">
              {{ o.label }}
            </el-radio-button>
          </el-radio-group>
          <el-input-number v-model="form.count" :min="0" :max="999" :step="5" size="small" style="width: 120px" />
          <span class="ws-dim">0 = 全部</span>
        </div>

        <div class="field field--top">
          <div class="field__label">题型</div>
          <el-checkbox-group v-model="form.types">
            <el-checkbox v-for="t in QUESTION_TYPES" :key="t.value" :value="t.value">
              <el-tooltip :content="t.hint" placement="top">
                <span>{{ t.label }}</span>
              </el-tooltip>
            </el-checkbox>
          </el-checkbox-group>
        </div>

        <div class="field">
          <div class="field__label">顺序</div>
          <el-radio-group v-model="form.order">
            <el-radio-button v-for="o in orderOptions" :key="o.value" :value="o.value">
              <el-tooltip :content="o.hint" placement="top"><span>{{ o.label }}</span></el-tooltip>
            </el-radio-button>
          </el-radio-group>
        </div>

        <div class="actions">
          <el-button type="primary" size="large" @click="start">
            <el-icon><VideoPlay /></el-icon>&nbsp;开始答题
          </el-button>
          <el-button size="large" @click="startDiagnostic">
            <el-icon><DataBoard /></el-icon>&nbsp;读/听/写诊断
          </el-button>
          <el-button size="large" @click="router.push('/vocab/plan')">训练计划</el-button>
        </div>
      </div>

      <div v-if="store.active?.questions?.length && phase === 'setup'" class="ws-card pad" style="margin-top: 18px">
        <div class="ws-row">
          <el-icon style="color: var(--ws-accent)"><Timer /></el-icon>
          <div>
            <b>上次练到一半</b>
            <div class="ws-dim tiny">
              {{ store.active.listName }} · 已答 {{ store.active.answers.length }} / {{ store.active.questions.length }}
            </div>
          </div>
          <div class="ws-spacer" />
          <el-button type="primary" @click="restoreFromCheckpoint">继续上次</el-button>
          <el-button @click="store.abandonActive()">放弃并记入历史</el-button>
        </div>
      </div>

      <div v-if="store.wrongBook.length" class="ws-card pad" style="margin-top: 18px">
        <div class="ws-row">
          <el-icon style="color: var(--ws-danger)"><WarningFilled /></el-icon>
          <b>你还有 {{ store.wrongBook.length }} 个错题没消化</b>
          <div class="ws-spacer" />
          <el-button plain @click="form.order = 'due-first'; start()">立刻按到期顺序练一轮</el-button>
          <el-button link @click="router.push('/vocab/wrong')">看错题本</el-button>
        </div>
      </div>

      <div class="ws-card pad" style="margin-top: 18px">
        <div class="h">本次累计</div>
        <div class="mini-stats">
          <div><b>{{ store.totalWords }}</b><span>词条</span></div>
          <div><b>{{ store.masteredCount }}</b><span>已掌握</span></div>
          <div><b>{{ store.totalAnswered }}</b><span>总作答</span></div>
          <div><b>{{ store.accuracy }}%</b><span>正确率</span></div>
        </div>
        <div class="ws-dim tiny">
          「已掌握」= 连续答对 {{ store.settings.masterStreak }} 次；可在词单练习里通过判分自动累计。
        </div>
      </div>
    </template>

    <!-- ============================================================ 答题 -->
    <template v-else-if="phase === 'running' && current">
      <div class="bar">
        <div class="bar__left">
          <span class="bar__list">{{ activeList?.name }}</span>
          <span class="ws-dim">{{ cursor + 1 }} / {{ questions.length }}</span>
        </div>
        <div class="bar__mid">
          <el-progress :percentage="progress" :stroke-width="7" :show-text="false" style="width: 220px" />
        </div>
        <div class="bar__right">
          <span class="tag tag--ok">对 {{ correctCount }}</span>
          <span class="tag tag--bad">错 {{ wrongResults.length }}</span>
          <span class="ws-dim ws-mono">{{ fmtTime(elapsed) }}</span>
          <span v-if="resumed" class="ws-dim tiny">已恢复</span>
          <el-button link @click="backToSetup">保存并退出</el-button>
        </div>
      </div>

      <div class="quiz">
        <div class="quiz__instr">
          <span class="pill">{{ QUESTION_TYPES.find((t) => t.value === current!.type)?.label }}</span>
          {{ current!.instruction }}
        </div>

        <!-- 题干 -->
        <div class="stem">
          <div v-if="current!.type === 'listen'" class="stem__listen">
            <SpeakButton :term="current!.term" size="default" />
            <div class="stem__listen-hint">{{ revealed ? current!.term : '点喇叭听发音' }}</div>
          </div>
          <div v-else class="stem__main">
            <span>{{ current!.stem }}</span>
            <SpeakButton v-if="stemIsEnglish || revealed" :term="currentWord?.term || current!.term" />
          </div>
          <div v-if="current!.stemSub && current!.type !== 'listen'" class="stem__sub ws-mono">{{ current!.stemSub }}</div>
        </div>

        <!-- 选择题 -->
        <div v-if="current!.kind === 'choice'" class="options">
          <button
            v-for="(opt, i) in current!.options"
            :key="i"
            class="opt"
            :class="{
              'is-chosen': chosenIndex === i,
              'is-right': revealed && i === current!.answerIndex,
              'is-wrong': revealed && chosenIndex === i && i !== current!.answerIndex,
              'is-dim': revealed && i !== current!.answerIndex && chosenIndex !== i,
            }"
            :disabled="revealed"
            @click="submitChoice(i)"
          >
            <span class="opt__key">{{ i + 1 }}</span>
            <span class="opt__text">{{ opt }}</span>
            <el-icon v-if="revealed && i === current!.answerIndex" class="opt__mark"><Select /></el-icon>
            <el-icon v-else-if="revealed && chosenIndex === i" class="opt__mark"><CloseBold /></el-icon>
          </button>
        </div>

        <!-- 输入题 -->
        <div v-else class="input-area">
          <!--
            回车统一交给 window 上的 onKeydown 处理，这里不要再加 @keydown.enter：
            否则一次 Enter 会先由本元素提交（revealed 变 true），事件继续冒泡到
            window 时又被判为「已判分」而立刻跳下一题，用户根本看不到判分反馈。
          -->
          <input
            ref="inputRef"
            v-model="input"
            class="text-input"
            :class="{ 'is-right': revealed && lastCorrect, 'is-wrong': revealed && !lastCorrect }"
            :disabled="revealed"
            :placeholder="current!.placeholder"
            spellcheck="false"
            autocomplete="off"
          />
          <div class="input-hint ws-dim" v-if="current!.type === 'zh-input'">中文意思写到点上即可，多写少写通常也算对</div>
          <div class="input-hint ws-dim" v-else-if="current!.type === 'spell'">
            {{ store.settings.strictSpelling ? '严格模式：拼写需完全正确' : '宽松模式：允许一个字母之差' }}
          </div>
        </div>

        <!-- 判分反馈（不用 <transition>：过渡事件在渲染被节流时不会到达，会导致面板卡住） -->
        <div>
          <div v-if="revealed" class="feedback" :class="lastCorrect ? 'feedback--ok' : 'feedback--bad'">
            <div class="feedback__top">
              <el-icon class="feedback__icon">
                <CircleCheckFilled v-if="lastCorrect" />
                <CircleCloseFilled v-else />
              </el-icon>
              <span class="feedback__verdict">{{ lastCorrect ? '答对了' : '答错了' }}</span>
              <div class="ws-spacer" />
              <span v-if="!lastCorrect" class="feedback__given">
                你的答案：<b>{{ results[results.length - 1]?.given || '（空）' }}</b>
              </span>
            </div>
            <div class="feedback__body">
              <div class="feedback__word">
                <span class="feedback__term">{{ currentWord?.term }}</span>
                <SpeakButton v-if="currentWord?.term" :term="currentWord.term" />
                <span v-if="currentWord?.phonetic" class="ws-mono ws-dim">/{{ currentWord.phonetic }}/</span>
                <span v-if="currentWord?.pos" class="ws-dim">{{ currentWord.pos }}</span>
              </div>
              <div class="feedback__meaning">{{ currentWord?.meaning }}</div>
              <div v-if="(current!.kind === 'input' && current!.example) || currentWord?.example" class="feedback__ex">
                {{ current!.kind === 'input' ? current!.example : currentWord?.example }}
                <div v-if="(current!.kind === 'input' && current!.exampleZh) || currentWord?.exampleZh" class="ws-dim">
                  {{ current!.kind === 'input' ? current!.exampleZh : currentWord?.exampleZh }}
                </div>
              </div>
              <div v-if="currentWord?.note" class="feedback__note">
                <el-icon><InfoFilled /></el-icon>&nbsp;{{ currentWord.note }}
              </div>
            </div>
          </div>
        </div>

        <!-- 操作条 -->
        <div class="quiz__actions">
          <template v-if="!revealed">
            <template v-if="current!.kind === 'choice'">
              <span class="ws-dim tiny">按数字键 1~{{ current!.options.length }} 快速作答；S 朗读</span>
            </template>
            <template v-else>
              <el-button type="primary" size="large" @click="submitInput">提交（Enter）</el-button>
              <el-button size="large" @click="giveUp">不会，看答案</el-button>
            </template>
          </template>
          <template v-else>
            <el-button type="primary" size="large" @click="next">
              {{ cursor + 1 >= questions.length ? '看结果' : '下一题（Enter）' }}
              <el-icon class="el-icon--right"><Right /></el-icon>
            </el-button>
          </template>
        </div>
      </div>
    </template>

    <!-- ============================================================ 结果 -->
    <template v-else-if="phase === 'done'">
      <div class="ws-page-head">
        <div>
          <h1 class="ws-title"><el-icon style="color: var(--ws-accent)"><Trophy /></el-icon>练习结果</h1>
          <p class="ws-subtitle">{{ activeList?.name }} · 用时 {{ fmtTime(elapsed) }}</p>
        </div>
        <div class="ws-row">
          <el-button @click="backToSetup">再练一轮</el-button>
          <el-button type="primary" @click="router.push('/vocab/wrong')">错题本</el-button>
        </div>
      </div>

      <div class="ws-card pad score">
        <div class="score__ring" :class="{ 'score__ring--good': scorePct >= 80, 'score__ring--mid': scorePct >= 60 && scorePct < 80 }">
          <div class="score__num">{{ scorePct }}<small>%</small></div>
          <div class="score__label">正确率</div>
        </div>
        <div class="score__grid">
          <div><b>{{ results.length }}</b><span>题</span></div>
          <div><b style="color: var(--ws-success)">{{ correctCount }}</b><span>答对</span></div>
          <div><b style="color: var(--ws-danger)">{{ wrongResults.length }}</b><span>答错</span></div>
          <div><b>{{ store.masteredCount }}</b><span>累计已掌握</span></div>
        </div>
      </div>

      <div v-if="wrongResults.length" class="ws-card pad" style="margin-top: 18px">
        <div class="ws-row" style="margin-bottom: 12px">
          <b>错题复盘（{{ wrongResults.length }}）</b>
          <div class="ws-spacer" />
          <el-button type="primary" plain @click="retryWrong">
            <el-icon><RefreshRight /></el-icon>&nbsp;错题重做
          </el-button>
        </div>
        <div class="review">
          <div v-for="(r, i) in wrongResults" :key="i" class="review__item">
            <div class="review__head">
              <span class="review__term">{{ r.word.term }}</span>
              <SpeakButton :term="r.word.term" />
              <span v-if="r.word.phonetic" class="ws-mono ws-dim">/{{ r.word.phonetic }}/</span>
              <span v-if="r.word.pos" class="ws-dim">{{ r.word.pos }}</span>
              <div class="ws-spacer" />
              <span class="pill pill--sm">{{ QUESTION_TYPES.find((t) => t.value === r.question.type)?.label }}</span>
            </div>
            <div class="review__mean">{{ r.word.meaning }}</div>
            <div class="review__wrong">
              你答：<span class="bad">{{ r.given || '（空）' }}</span>
              <template v-if="r.given !== r.expected">
                &nbsp;·&nbsp;正确：<span class="good">{{ r.expected }}</span>
              </template>
            </div>
            <div v-if="r.word.example" class="review__ex ws-dim">
              {{ r.word.example }}
            </div>
          </div>
        </div>
      </div>

      <div v-else class="ws-card pad" style="margin-top: 18px; text-align: center">
        <el-icon style="font-size: 40px; color: var(--ws-success)"><SuccessFilled /></el-icon>
        <div style="font-size: 16px; font-weight: 650; margin-top: 10px">全对，这一组词过关了</div>
        <div class="ws-dim" style="margin-top: 4px">可以换下一个词单，或者增加题量再来一轮。</div>
      </div>

      <div class="ws-card pad" style="margin-top: 18px">
        <div class="h">全部作答明细</div>
        <div class="detail">
          <div v-for="(r, i) in results" :key="i" class="detail__item">
            <el-icon :class="r.correct ? 'good' : 'bad'">
              <CircleCheckFilled v-if="r.correct" /><CircleCloseFilled v-else />
            </el-icon>
            <span class="detail__term">{{ r.word.term }}</span>
            <SpeakButton :term="r.word.term" />
            <span class="detail__mean ws-dim">{{ r.word.meaning }}</span>
            <span class="detail__given" :class="r.correct ? 'good' : 'bad'">{{ r.given || '（空）' }}</span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.pad {
  padding: 22px 24px;
}
.h {
  font-size: 14.5px;
  font-weight: 650;
  margin-bottom: 14px;
}
.tiny {
  font-size: 12px;
}

/* ------------------------------------------------------------ 设置区 -- */
.field {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 13px 0;
  flex-wrap: wrap;
}
.field + .field {
  border-top: 1px dashed var(--ws-border);
}
.field--top {
  align-items: flex-start;
}
.field__label {
  width: 48px;
  flex: 0 0 48px;
  color: var(--ws-text-2);
  font-size: 13.5px;
  padding-top: 2px;
}
.actions {
  display: flex;
  gap: 12px;
  padding-top: 18px;
  margin-top: 6px;
  border-top: 1px solid var(--ws-border);
}
.mini-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 14px;
}
.mini-stats > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.mini-stats b {
  font-size: 21px;
  font-weight: 700;
  color: var(--ws-accent);
  line-height: 1.15;
}
.mini-stats span {
  font-size: 12px;
  color: var(--ws-text-3);
}

/* -------------------------------------------------------------- 答题条 -- */
.bar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 4px 18px;
  flex-wrap: wrap;
}
.bar__left {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 13px;
}
.bar__list {
  font-weight: 600;
}
.bar__mid {
  flex: 1;
  display: flex;
  justify-content: center;
  min-width: 140px;
}
.bar__right {
  display: flex;
  align-items: center;
  gap: 10px;
}
.tag {
  font-size: 12px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: 99px;
}
.tag--ok {
  color: var(--ws-success);
  background: var(--ws-success-soft);
}
.tag--bad {
  color: var(--ws-danger);
  background: var(--ws-danger-soft);
}

/* -------------------------------------------------------------- 题面 --- */
.quiz {
  max-width: 760px;
  margin: 0 auto;
}
.quiz__instr {
  font-size: 13px;
  color: var(--ws-text-2);
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 6px;
}
.pill {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--ws-accent);
  background: var(--ws-accent-soft);
  padding: 2px 9px;
  border-radius: 99px;
}
.pill--sm {
  font-size: 11px;
}
.stem {
  padding: 30px 26px 26px;
  text-align: center;
}
.stem__main {
  font-size: 30px;
  font-weight: 650;
  letter-spacing: -0.02em;
  line-height: 1.4;
  word-break: break-word;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
}
.stem__listen {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.stem__listen-hint {
  font-size: 16px;
  font-weight: 650;
  color: var(--ws-text-2);
}
.stem__sub {
  margin-top: 10px;
  color: var(--ws-text-2);
  font-size: 14px;
}

/* -------------------------------------------------------------- 选项 --- */
.options {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
@media (max-width: 640px) {
  .options {
    grid-template-columns: 1fr;
  }
}
.opt {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 15px 17px;
  border-radius: var(--ws-radius);
  border: 1.5px solid var(--ws-border);
  background: var(--ws-panel);
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: inherit;
  transition: all 0.14s ease;
  min-height: 62px;
}
.opt:hover:not(:disabled) {
  border-color: var(--ws-accent);
  background: var(--ws-accent-soft);
}
.opt:disabled {
  cursor: default;
}
.opt__key {
  width: 22px;
  height: 22px;
  flex: 0 0 22px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  font-size: 11.5px;
  font-weight: 650;
  color: var(--ws-text-2);
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
}
.opt__text {
  flex: 1;
  font-size: var(--ws-fs-base);
  line-height: 1.45;
}
.opt__mark {
  font-size: 18px;
}
.opt.is-right {
  border-color: var(--ws-success);
  background: var(--ws-success-soft);
}
.opt.is-right .opt__mark {
  color: var(--ws-success);
}
.opt.is-right .opt__key {
  color: var(--ws-on-solid);
  background: var(--ws-success);
  border-color: var(--ws-success);
}
.opt.is-wrong {
  border-color: var(--ws-danger);
  background: var(--ws-danger-soft);
}
.opt.is-wrong .opt__mark {
  color: var(--ws-danger);
}
.opt.is-wrong .opt__key {
  color: var(--ws-on-solid);
  background: var(--ws-danger);
  border-color: var(--ws-danger);
}
.opt.is-dim {
  opacity: 0.5;
}

/* ------------------------------------------------------------ 输入题 --- */
.input-area {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.text-input {
  width: 100%;
  max-width: 460px;
  font-size: 20px;
  font-family: inherit;
  padding: 14px 18px;
  text-align: center;
  border-radius: var(--ws-radius);
  border: 1.5px solid var(--ws-border-strong);
  background: var(--ws-panel);
  color: var(--ws-text);
  outline: none;
  transition: all 0.14s ease;
}
.text-input:focus {
  border-color: var(--ws-accent);
  box-shadow: 0 0 0 4px var(--ws-accent-ring);
}
.text-input.is-right {
  border-color: var(--ws-success);
  background: var(--ws-success-soft);
}
.text-input.is-wrong {
  border-color: var(--ws-danger);
  background: var(--ws-danger-soft);
}
.input-hint {
  font-size: 12px;
}

/* ------------------------------------------------------------ 反馈区 --- */
.feedback {
  margin-top: 20px;
  border-radius: var(--ws-radius-lg);
  border: 1px solid var(--ws-border);
  overflow: hidden;
  background: var(--ws-panel);
}
.feedback--ok {
  border-color: color-mix(in srgb, var(--ws-success) 35%, var(--ws-border));
}
.feedback--bad {
  border-color: color-mix(in srgb, var(--ws-danger) 35%, var(--ws-border));
}
.feedback__top {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 12px 18px;
  font-weight: 600;
  font-size: 14px;
}
.feedback--ok .feedback__top {
  background: var(--ws-success-soft);
  color: var(--ws-success);
}
.feedback--bad .feedback__top {
  background: var(--ws-danger-soft);
  color: var(--ws-danger);
}
.feedback__given {
  font-weight: 500;
  color: var(--ws-text-2);
  font-size: 13px;
}
.feedback__given b {
  color: inherit;
}
.feedback__icon {
  font-size: 18px;
}
.feedback__body {
  padding: 16px 18px 18px;
}
.feedback__word {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.feedback__term {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.feedback__meaning {
  font-size: 14.5px;
  margin-top: 5px;
}
.feedback__ex {
  margin-top: 11px;
  padding-left: 12px;
  border-left: 3px solid var(--ws-border);
  font-size: 13.5px;
  color: var(--ws-text-2);
  line-height: 1.65;
}
.feedback__note {
  margin-top: 11px;
  font-size: 12.8px;
  color: var(--ws-text-2);
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
  border-radius: var(--ws-radius-sm);
  padding: 8px 11px;
  display: flex;
  align-items: flex-start;
}

.quiz__actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 22px;
  min-height: 40px;
}

/* -------------------------------------------------------------- 结果 --- */
.score {
  display: flex;
  align-items: center;
  gap: 34px;
  flex-wrap: wrap;
}
.score__ring {
  width: 130px;
  height: 130px;
  flex: 0 0 130px;
  border-radius: 50%;
  display: grid;
  place-content: center;
  text-align: center;
  background: var(--ws-panel-2);
  border: 6px solid var(--ws-danger);
}
.score__ring--mid {
  border-color: var(--ws-warn);
}
.score__ring--good {
  border-color: var(--ws-success);
}
.score__num {
  font-size: 34px;
  font-weight: 700;
  line-height: 1;
}
.score__num small {
  font-size: 16px;
  font-weight: 600;
}
.score__label {
  font-size: 12px;
  color: var(--ws-text-3);
  margin-top: 3px;
}
.score__grid {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
  gap: 16px;
}
.score__grid > div {
  display: flex;
  flex-direction: column;
}
.score__grid b {
  font-size: 22px;
  font-weight: 700;
  line-height: 1.15;
}
.score__grid span {
  font-size: 12px;
  color: var(--ws-text-3);
}

.review {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.review__item {
  border: 1px solid var(--ws-border);
  border-left: 3px solid var(--ws-danger);
  border-radius: var(--ws-radius);
  padding: 13px 16px;
  background: var(--ws-panel-2);
}
.review__head {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
}
.review__term {
  font-size: 16px;
  font-weight: 700;
}
.review__mean {
  font-size: 13.5px;
  margin-top: 4px;
}
.review__wrong {
  font-size: 12.8px;
  margin-top: 5px;
  color: var(--ws-text-2);
}
.review__ex {
  font-size: 12.5px;
  margin-top: 6px;
}
.bad {
  color: var(--ws-danger);
  font-weight: 600;
}
.good {
  color: var(--ws-success);
  font-weight: 600;
}

.detail {
  display: flex;
  flex-direction: column;
}
.detail__item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 2px;
  font-size: 13.5px;
}
.detail__item + .detail__item {
  border-top: 1px solid var(--ws-border);
}
.detail__term {
  font-weight: 600;
  min-width: 140px;
}
.detail__mean {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.detail__given {
  font-size: 12.8px;
}
.detail__item .el-icon {
  font-size: 15px;
}
</style>
