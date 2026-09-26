/**
 * 背单词功能的 store：词单、做题统计、练习历史、设置。
 *
 * 数据归属（重要）：
 *   源   = 边车的 server/data/vocab/{lists,progress}.json —— 网页与智能体/MCP 读写同一份，
 *          这正是「智能体帮我录词、我在网页里练」能成立的前提；
 *   缓存 = localStorage —— 边车没启动时照旧能用（双击即用这条不能丢），联网后自动对上。
 *
 * 同步规则：
 *   1. 首次 hydrate：服务端没数据、本地有 → 把本地这份推上去（老数据的一次性迁移）；
 *      两边都有 → 以服务端为准；
 *   2. 改动先在本地生效（界面零延迟），再防抖写回服务端；写回带 baseRev，
 *      版本不一致时服务端会把「对方那一版」另存 .conflict 副本，界面给提示；
 *   3. 写回前比较内容，内容没变就不发请求（避免每次拉取后又无意义地回写一遍）；
 *   4. 窗口重新获得焦点时先 flush 再回拉一次，智能体刚录的词会自动出现。
 *
 * 本 store 的对外字段与方法保持原样，四个视图不需要改。
 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { loadJSON, saveJSON } from '@/core/storage'
import { api } from '@/core/sidecar'
import { DEFAULT_SETTINGS, type AnswerResult, type QuestionType, type SessionRecord, type StudyCheckpoint, type VocabDiagnosis, type VocabPlanState, type VocabSettings, type VocabSkill, type VocabWord, type WordList, type WordStat } from './types'
import { skillOf } from './engine'
import { BUILTIN_LIST_ID, makeBuiltinList } from './builtin'
import { applyAnswer, dueBucket, dueRank, isMastered, termKey, viewStat, type DueBucket } from './srs'

const K_LISTS = 'vocab.lists.v1'
const K_STATS = 'vocab.stats.v1'
const K_SESSIONS = 'vocab.sessions.v1'
const K_SETTINGS = 'vocab.settings.v1'
const K_ACTIVE = 'vocab.active.v1'
const K_PLAN = 'vocab.plan.v1'

/**
 * 出厂是**空画像**：年级 / 目标考试 / 备注都由用户第一次进「训练计划」时自己填
 * （页面里有一段引导表单）。这里不预置任何人的身份与目标 —— 那是个人信息，不是默认值。
 */
const DEFAULT_PLAN: VocabPlanState = {
  profile: { grade: '', exams: [], listenHabit: 'daily', note: '' },
  diagnosis: null,
}

/** 写回服务端的防抖间隔：词单改动少、学情每答一题就变，分开设 */
const PUSH_DEBOUNCE: Record<Scope, number> = { lists: 800, progress: 1500 }
/** 窗口/标签页重新激活时，距上次回拉多久才再拉一次 */
const FOCUS_PULL_MS = 30000

type Scope = 'lists' | 'progress'
export type SyncState = 'unknown' | 'syncing' | 'online' | 'offline'

export interface WrongEntry {
  word: VocabWord
  stat: WordStat
  listId: string
  listName: string
}

export const useVocabStore = defineStore('vocab', () => {
  const lists = ref<WordList[]>(loadJSON<WordList[]>(K_LISTS, []))
  const stats = ref<Record<string, WordStat>>(loadJSON<Record<string, WordStat>>(K_STATS, {}))
  const sessions = ref<SessionRecord[]>(loadJSON<SessionRecord[]>(K_SESSIONS, []))
  const active = ref<StudyCheckpoint | null>(loadJSON<StudyCheckpoint | null>(K_ACTIVE, null))
  const settings = ref<VocabSettings>({ ...DEFAULT_SETTINGS, ...loadJSON<Partial<VocabSettings>>(K_SETTINGS, {}) })
  const plan = ref<VocabPlanState>({ ...DEFAULT_PLAN, ...loadJSON<Partial<VocabPlanState>>(K_PLAN, {}) })

  /* --------------------------------------------------------- 同步状态 --- */
  const syncState = ref<SyncState>('unknown')
  const lastSyncAt = ref(0)
  const lastError = ref<string | null>(null)
  /** 最近一次「别处也改过」的冲突提示（服务端已把对方版本另存为 .conflict 副本） */
  const lastConflict = ref<{ scope: Scope; at: number; file: string | null } | null>(null)
  /** 首次把浏览器里的老数据迁移到服务端的时间 */
  const migratedAt = ref<number | null>(null)

  /** 服务端版本号（非响应式：它变了不该触发 watch 回写） */
  const revs = { lists: 0, progress: 0 }
  /** 上一次成功写回的内容快照，用于「内容没变就不发请求」 */
  const lastPushed: Record<Scope, string> = { lists: '', progress: '' }
  /** 采用服务端数据期间挂起回写，避免把刚拉下来的数据又推回去 */
  let applying = false
  let hydrating: Promise<boolean> | null = null
  let lastFocusPullAt = 0
  const timers: Partial<Record<Scope, ReturnType<typeof setTimeout>>> = {}

  /* --------------------------------------------------------- 内置词单 --- */
  function syncBuiltin() {
    const builtin = makeBuiltinList()
    const idx = lists.value.findIndex((l) => l.id === BUILTIN_LIST_ID)
    if (idx === -1) {
      lists.value.unshift(builtin)
      return
    }
    // 内置词单的释义/例句以代码为准，但用户手动追加过的词要保留下来
    const existing = lists.value[idx]
    const builtinIds = new Set(builtin.words.map((w) => w.id))
    const extras = existing.words.filter((w) => !builtinIds.has(w.id))
    existing.name = builtin.name
    existing.description = builtin.description
    existing.words = [...builtin.words, ...extras]
    existing.source = 'builtin'
  }
  syncBuiltin()

  /* ----------------------------------------------------------- 持久化 --- */
  watch(lists, () => {
    saveJSON(K_LISTS, lists.value)
    schedulePush('lists')
  }, { deep: true })
  watch(stats, () => {
    saveJSON(K_STATS, stats.value)
    schedulePush('progress')
  }, { deep: true })
  watch(sessions, () => {
    saveJSON(K_SESSIONS, sessions.value)
    schedulePush('progress')
  }, { deep: true })
  watch(settings, () => {
    saveJSON(K_SETTINGS, settings.value)
    schedulePush('progress')
  }, { deep: true })
  watch(active, () => {
    saveJSON(K_ACTIVE, active.value)
    schedulePush('progress')
  }, { deep: true })
  watch(plan, () => {
    saveJSON(K_PLAN, plan.value)
    schedulePush('progress')
  }, { deep: true })

  /* ------------------------------------------------------- 与服务端同步 --- */

  function scopePayload(scope: Scope): string {
    if (scope === 'lists') return JSON.stringify(lists.value)
    return JSON.stringify({ stats: stats.value, sessions: sessions.value, settings: settings.value, active: active.value, plan: plan.value })
  }

  function schedulePush(scope: Scope) {
    if (applying || syncState.value !== 'online') return
    if (timers[scope]) clearTimeout(timers[scope])
    timers[scope] = setTimeout(() => {
      delete timers[scope]
      void push(scope)
    }, PUSH_DEBOUNCE[scope])
  }

  /** 把本地改动写回服务端；内容没变就跳过 */
  async function push(scope: Scope): Promise<boolean> {
    if (applying || syncState.value !== 'online') return false
    const payload = scopePayload(scope)
    if (payload === lastPushed[scope]) return false

    const r =
      scope === 'lists'
        ? await api.vocabPutLists(lists.value, revs.lists, 'web')
        : await api.vocabPutProgress({ stats: stats.value, sessions: sessions.value, settings: settings.value, active: active.value, plan: plan.value }, revs.progress, 'web')

    if (!r.ok) {
      lastError.value = r.error ?? '写回失败'
      if (r.status === 0) syncState.value = 'offline' // 边车掉了：退回纯本地
      return false
    }
    const d: any = r.data ?? {}
    revs[scope] = Number(d.rev) || revs[scope]
    lastPushed[scope] = payload
    lastSyncAt.value = Date.now()
    lastError.value = null
    if (d.conflict) {
      lastConflict.value = { scope, at: Date.now(), file: d.conflict.copy ?? null }
      console.warn(`[vocab] ${scope} 在别处也被改过，对方版本已存为 ${d.conflict.copy ?? '(未留证)'}`)
    }
    return true
  }

  /** 立即把待写回的内容推上去（切页面前 / 回拉前用） */
  async function flush() {
    for (const scope of ['lists', 'progress'] as Scope[]) {
      if (timers[scope]) {
        clearTimeout(timers[scope])
        delete timers[scope]
      }
    }
    if (syncState.value !== 'online') return
    await push('lists')
    await push('progress')
  }

  /**
   * 与服务端对齐。
   * @param adoptServer true = 无条件采用服务端数据（回拉）；false = 服务端为空且本地有数据时反向迁移
   */
  async function hydrate(adoptServer = false): Promise<boolean> {
    if (hydrating) return hydrating
    hydrating = (async () => {
      syncState.value = 'syncing'
      const r = await api.vocabSnapshot()
      if (!r.ok || !r.data) {
        syncState.value = 'offline'
        lastError.value = r.error ?? '连不上边车，词单暂存本机浏览器'
        return false
      }
      const d: any = r.data
      const serverLists: WordList[] = Array.isArray(d.lists) ? d.lists : []
      const serverStats = d.progress?.stats ?? {}
      const localHas = lists.value.length > 0 || Object.keys(stats.value).length > 0 || sessions.value.length > 0
      const serverHas = serverLists.length > 0 || Object.keys(serverStats).length > 0

      let migrate = false
      /** 采用服务端数据之后仍需补推的范围（目前只有「服务端还没有内置词单」这一种） */
      const pushAfter: Scope[] = []
      applying = true
      try {
        revs.lists = Number(d.listsRev) || 0
        revs.progress = Number(d.progressRev) || 0
        if (!adoptServer && !serverHas && localHas) {
          // 服务端还空着、本地有老数据 → 把本地这份推上去（一次性迁移）
          migrate = true
        } else {
          const serverHadBuiltin = serverLists.some((l) => l.id === BUILTIN_LIST_ID)
          lists.value = serverLists
          stats.value = serverStats
          sessions.value = Array.isArray(d.progress?.sessions) ? d.progress.sessions : []
          settings.value = { ...DEFAULT_SETTINGS, ...(d.progress?.settings ?? {}) }
          if (d.progress?.plan) plan.value = { ...DEFAULT_PLAN, ...d.progress.plan, profile: { ...DEFAULT_PLAN.profile, ...(d.progress.plan.profile ?? {}) } }
          const serverActive = d.progress?.active && typeof d.progress.active === 'object' ? d.progress.active : null
          const localActive = active.value
          if (serverActive && (!localActive || (serverActive.updatedAt || 0) >= (localActive.updatedAt || 0))) {
            active.value = serverActive
          } else if (!serverActive && localActive) {
            pushAfter.push('progress')
          }
          syncBuiltin() // 服务端可能还没有内置词单，本地补上
          // 内置词单是代码里带的，推上去之后智能体也能看到它，不必每次打开都本地重新生成
          if (!serverHadBuiltin) pushAfter.push('lists')
        }
      } finally {
        applying = false
      }

      syncState.value = 'online'
      if (migrate) {
        lastPushed.lists = ''
        lastPushed.progress = ''
        await push('lists')
        await push('progress')
        migratedAt.value = Date.now()
      } else {
        // 刚拉下来的就是服务端现状，记为「已写回」，避免无意义回写
        lastPushed.lists = scopePayload('lists')
        lastPushed.progress = scopePayload('progress')
        for (const scope of pushAfter) await push(scope)
      }
      lastSyncAt.value = Date.now()
      lastError.value = null
      return true
    })()
      .catch((err) => {
        syncState.value = 'offline'
        lastError.value = err?.message ?? '同步失败'
        return false
      })
      .finally(() => {
        hydrating = null
      })
    return hydrating
  }

  /** 回拉服务端（先把本地待写回内容推上去，避免拉取时覆盖掉刚改的东西） */
  async function refresh(): Promise<boolean> {
    await flush()
    return hydrate(true)
  }

  /* ------------------------------------------------------------- 查询 --- */
  const wordIndex = computed(() => {
    const m = new Map<string, { word: VocabWord; list: WordList }>()
    for (const list of lists.value) {
      for (const w of list.words) m.set(w.id, { word: w, list })
    }
    return m
  })

  const totalWords = computed(() => lists.value.reduce((s, l) => s + l.words.length, 0))

  function statOf(wordId: string): WordStat | undefined {
    return stats.value[wordId]
  }

  const masteredCount = computed(
    () =>
      lists.value.reduce((n, l) => n + l.words.filter((w) => isMastered(stats.value[w.id], settings.value.masterStreak)).length, 0),
  )

  /** 全库按英文去重后的到期分布（同一词在多个词单里只计一次） */
  const dueCounts = computed(() => {
    const now = Date.now()
    const counts: Record<DueBucket, number> = { overdue: 0, learning: 0, new: 0, upcoming: 0, mature: 0 }
    const seen = new Set<string>()
    for (const list of lists.value) {
      for (const w of list.words) {
        const k = termKey(w.term)
        if (!k || seen.has(k)) continue
        seen.add(k)
        counts[dueBucket(viewStat(stats.value[w.id], w.id, w.term), now)] += 1
      }
    }
    return { ...counts, dueToday: counts.overdue + counts.learning, unique: seen.size }
  })

  const totalAnswered = computed(() =>
    Object.values(stats.value).reduce((s, x) => s + x.right + x.wrong, 0),
  )
  const totalCorrect = computed(() => Object.values(stats.value).reduce((s, x) => s + x.right, 0))
  const accuracy = computed(() =>
    totalAnswered.value ? Math.round((totalCorrect.value / totalAnswered.value) * 100) : 0,
  )

  /** 错题本：错过的词，按「错得最多、最近错」排在前面 */
  const wrongBook = computed<WrongEntry[]>(() => {
    const out: WrongEntry[] = []
    for (const [wordId, s] of Object.entries(stats.value)) {
      if (s.wrong <= 0) continue
      const hit = wordIndex.value.get(wordId)
      if (!hit) continue
      out.push({ word: hit.word, stat: s, listId: hit.list.id, listName: hit.list.name })
    }
    return out.sort((a, b) => {
      const d = b.stat.wrong - b.stat.right - (a.stat.wrong - a.stat.right)
      if (d !== 0) return d
      return (b.stat.lastWrongAt ?? 0) - (a.stat.lastWrongAt ?? 0)
    })
  })

  const recentSessions = computed(() => [...sessions.value].sort((a, b) => b.finishedAt - a.finishedAt))

  function listById(id: string): WordList | undefined {
    return lists.value.find((l) => l.id === id)
  }

  /** 同步状态的一句话描述（界面提示用） */
  const syncText = computed(() => {
    if (syncState.value === 'online') {
      if (lastConflict.value) return '已连服务端 · 检测到外部改动'
      return lastSyncAt.value ? `已连服务端 · ${new Date(lastSyncAt.value).toLocaleTimeString('zh-CN')}` : '已连服务端'
    }
    if (syncState.value === 'syncing') return '同步中…'
    if (syncState.value === 'offline') return '离线 · 词单只存在本机浏览器'
    return '未同步'
  })

  /** 悬浮说明：文件位置与版本号，排查「为什么没同步上」用 */
  const syncDetail = computed(() => {
    const lines = [
      `状态：${syncText.value}`,
      `词单 rev ${revs.lists} · 学情 rev ${revs.progress}`,
      '数据文件：server/data/vocab/lists.json 与 progress.json（智能体读写的是同一份）',
    ]
    if (migratedAt.value) lines.push(`本地数据已迁移到服务端：${new Date(migratedAt.value).toLocaleString('zh-CN')}`)
    if (lastConflict.value) lines.push(`最近冲突：${lastConflict.value.scope}，对方版本 ${lastConflict.value.file ?? '(未留证)'}`)
    if (lastError.value) lines.push(`最近错误：${lastError.value}`)
    return lines.join('\n')
  })

  /* --------------------------------------------------------- 词单维护 --- */
  function addList(list: WordList) {
    lists.value.unshift(list)
  }

  function updateList(id: string, patch: Partial<WordList>) {
    const l = listById(id)
    if (!l) return
    Object.assign(l, patch, { updatedAt: Date.now() })
  }

  function removeList(id: string) {
    if (id === BUILTIN_LIST_ID) return
    lists.value = lists.value.filter((l) => l.id !== id)
  }

  function duplicateList(id: string, withStats = false): WordList | null {
    const src = listById(id)
    if (!src) return null
    const copy: WordList = {
      id: `list_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      name: `${src.name} 副本`,
      description: src.description,
      words: src.words.map((w) => ({ ...w, id: `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}` })),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      source: 'user',
    }
    addList(copy)
    if (withStats) {
      // 保留学情：把原词的表现搬到新词上
      src.words.forEach((old, i) => {
        const s = stats.value[old.id]
        if (s && copy.words[i]) stats.value[copy.words[i].id] = { ...s, wordId: copy.words[i].id, term: copy.words[i].term }
      })
    }
    return copy
  }

  function mergeExamplesInto(target: VocabWord, incoming: VocabWord): number {
    const seen = new Set(
      [...(target.examples ?? []), ...(target.example ? [{ en: target.example, zh: target.exampleZh }] : [])]
        .map((x) => x.en.trim().toLowerCase().replace(/\s+/g, ' ')),
    )
    let n = 0
    const extras: NonNullable<VocabWord['examples']> = []
    const candidates = [...(incoming.examples ?? []), ...(incoming.example ? [{ en: incoming.example, zh: incoming.exampleZh, source: incoming.addedBy }] : [])]
    for (const ex of candidates) {
      const t = String(ex.en ?? '').trim()
      if (!t) continue
      const key = t.toLowerCase().replace(/\s+/g, ' ')
      if (seen.has(key)) continue
      seen.add(key)
      extras.push({ en: t, zh: ex.zh?.trim() || undefined, source: ex.source || incoming.addedBy })
      n += 1
    }
    if (!extras.length) return 0
    const base = target.examples?.length ? [...target.examples] : target.example ? [{ en: target.example, zh: target.exampleZh }] : []
    target.examples = [...base, ...extras]
    if (!target.example && target.examples[0]) {
      target.example = target.examples[0].en
      target.exampleZh = target.examples[0].zh
    }
    return n
  }

  function findByTerm(term: string): { list: WordList; word: VocabWord } | null {
    const k = termKey(term)
    if (!k) return null
    for (const list of lists.value) {
      const word = list.words.find((w) => termKey(w.term) === k)
      if (word) return { list, word }
    }
    return null
  }

  function enrichWord(target: VocabWord, incoming: VocabWord): number {
    let n = 0
    n += mergeExamplesInto(target, incoming)
    for (const k of ['phonetic', 'pos', 'note'] as const) {
      if (!target[k] && incoming[k]) {
        target[k] = incoming[k]
        n += 1
      }
    }
    if ((!target.meaning || target.meaning === '（未填写释义）') && incoming.meaning && incoming.meaning !== '（未填写释义）') {
      target.meaning = incoming.meaning
      n += 1
    }
    if (incoming.tags?.length) {
      const set = new Set(target.tags ?? [])
      for (const t of incoming.tags) if (t && !set.has(t)) {
        set.add(t)
        n += 1
      }
      target.tags = [...set]
    }
    return n
  }

  function addWordsToList(listId: string, words: VocabWord[]) {
    const l = listById(listId)
    if (!l) return { added: 0, skippedDuplicate: 0, skippedGlobal: 0, enriched: 0 }
    let added = 0
    let skippedDuplicate = 0
    let skippedGlobal = 0
    let enriched = 0
    const inList = new Set(l.words.map((w) => termKey(w.term)))
    for (const w of words) {
      const k = termKey(w.term)
      if (!k) continue
      if (inList.has(k)) {
        const cur = l.words.find((x) => termKey(x.term) === k)
        if (cur) enriched += enrichWord(cur, w)
        skippedDuplicate += 1
        continue
      }
      const hit = findByTerm(w.term)
      if (hit) {
        enriched += enrichWord(hit.word, w)
        skippedGlobal += 1
        continue
      }
      inList.add(k)
      l.words.push({
        ...w,
        addedAt: w.addedAt || Date.now(),
        addedBy: w.addedBy || 'user',
      })
      added += 1
    }
    l.updatedAt = Date.now()
    return { added, skippedDuplicate, skippedGlobal, enriched }
  }

  function removeWord(listId: string, wordId: string) {
    const l = listById(listId)
    if (!l) return
    l.words = l.words.filter((w) => w.id !== wordId)
    l.updatedAt = Date.now()
  }

  function replaceWords(listId: string, words: VocabWord[]) {
    const l = listById(listId)
    if (!l) return
    l.words = words
    l.updatedAt = Date.now()
  }

  /* ------------------------------------------------------------- 学情 --- */
  function recordAnswer(wordId: string, term: string, correct: boolean, type?: QuestionType) {
    const next = applyAnswer(stats.value[wordId], { wordId, term, correct, type })
    stats.value = { ...stats.value, [wordId]: next }
  }

  function finishSession(rec: SessionRecord) {
    const next = { ...rec, status: rec.status ?? 'done', updatedAt: rec.updatedAt ?? Date.now() }
    sessions.value = [next, ...sessions.value.filter((s) => s.id !== next.id)].slice(0, 200)
    if (active.value?.sessionId === next.id) active.value = null
  }

  function saveCheckpoint(cp: StudyCheckpoint) {
    active.value = { ...cp, updatedAt: Date.now() }
  }

  function clearCheckpoint() {
    active.value = null
  }

  function saveDiagnosis(results: AnswerResult[], listId: string, listName: string) {
    const skills: Record<VocabSkill, { right: number; wrong: number; accuracy: number }> = {
      reading: { right: 0, wrong: 0, accuracy: 0 },
      listening: { right: 0, wrong: 0, accuracy: 0 },
      writing: { right: 0, wrong: 0, accuracy: 0 },
    }
    const sample: VocabDiagnosis['sample'] = []
    for (const r of results) {
      const skill = skillOf(r.question.type)
      if (r.correct) skills[skill].right += 1
      else skills[skill].wrong += 1
      sample.push({ term: r.word.term, skill, correct: r.correct })
    }
    for (const s of Object.values(skills)) {
      const n = s.right + s.wrong
      s.accuracy = n ? Math.round((s.right / n) * 100) : 0
    }
    const ranked = (['listening', 'writing', 'reading'] as VocabSkill[]).sort((a, b) => skills[a].accuracy - skills[b].accuracy)
    const weakest = ranked[0]
    // 计划只从**这次诊断的数字**推出来，不预设任何人的年级 / 目标考试 / 考试日期 ——
    // 那些是使用者自己的事，由他在「训练计划」页里填（profile）。
    const planLines = [
      `这次诊断：阅读 ${skills.reading.accuracy}% · 听力 ${skills.listening.accuracy}% · 拼写 ${skills.writing.accuracy}%。最弱的是${weakest === 'listening' ? '听力' : weakest === 'writing' ? '写作/拼写' : '阅读'}。`,
      weakest === 'listening'
        ? '本周每天 10 分钟听音选义（到期优先 + 只勾听力题），听完必须作答。'
        : weakest === 'writing'
          ? '本周每天 10 个拼写/例句填空 —— 要写要译的那批词，光认识是不够的。'
          : '阅读还行，把到期词过完即可，别停在只看英文选中文。',
      '词的要求分开：阅读里见过能懂的标「阅读认识」；听力材料和口语音标要标「听懂」；作文/翻译会用到的标「会写会用」。',
      '认识即可的词不必全逼自己会拼；需要动笔的那批单独练听和写。',
    ]
    plan.value = {
      ...plan.value,
      diagnosis: {
        at: Date.now(),
        listId,
        listName,
        skills,
        sample,
        plan: planLines,
      },
    }
  }

  function setWordGoal(listId: string, wordId: string, goal: VocabWord['goal']) {
    const l = listById(listId)
    const w = l?.words.find((x) => x.id === wordId)
    if (w) w.goal = goal
  }

  function abandonActive(reason = 'abandoned') {
    const cp = active.value
    if (!cp) return
    const correct = cp.answers.filter((a) => a.correct).length
    finishSession({
      id: cp.sessionId,
      listId: cp.listId,
      listName: cp.listName,
      startedAt: cp.startedAt,
      finishedAt: Date.now(),
      updatedAt: Date.now(),
      status: reason === 'done' ? 'done' : 'abandoned',
      order: cp.form.order,
      planned: cp.questions.length,
      total: cp.answers.length,
      correct,
      types: [...new Set(cp.answers.map((a) => a.type))],
      wrong: cp.answers.filter((a) => !a.correct).map((a) => ({
        wordId: a.wordId,
        term: a.term,
        meaning: a.meaning,
        phonetic: a.phonetic,
      })),
      answers: cp.answers,
    })
  }

  function clearStatsForList(listId: string) {
    const l = listById(listId)
    if (!l) return
    const next = { ...stats.value }
    for (const w of l.words) delete next[w.id]
    stats.value = next
  }

  function resetAllStats() {
    stats.value = {}
  }

  function resetEverything() {
    lists.value = []
    stats.value = {}
    sessions.value = []
    active.value = null
    settings.value = { ...DEFAULT_SETTINGS }
    syncBuiltin()
  }

  /* --------------------------------------------------- 自动接入服务端 --- */
  // store 第一次被用到就尝试连服务端：连不上就安静退回纯本地，不打扰任何现有功能
  if (typeof window !== 'undefined') {
    void hydrate()
    const onActive = () => {
      if (document.hidden) return
      if (Date.now() - lastFocusPullAt < FOCUS_PULL_MS) return
      lastFocusPullAt = Date.now()
      void refresh()
    }
    window.addEventListener('focus', onActive)
    document.addEventListener('visibilitychange', onActive)
    // 关页面前尽量把最后几秒的改动推上去（best-effort）
    window.addEventListener('beforeunload', () => {
      void flush()
    })
  }

  return {
    lists,
    stats,
    sessions,
    active,
    plan,
    settings,
    // 查询
    wordIndex,
    totalWords,
    masteredCount,
    dueCounts,
    totalAnswered,
    accuracy,
    wrongBook,
    recentSessions,
    statOf,
    listById,
    // 维护
    addList,
    updateList,
    removeList,
    duplicateList,
    addWordsToList,
    removeWord,
    replaceWords,
    // 学情
    recordAnswer,
    finishSession,
    saveCheckpoint,
    clearCheckpoint,
    abandonActive,
    saveDiagnosis,
    setWordGoal,
    clearStatsForList,
    resetAllStats,
    resetEverything,
    syncBuiltin,
    BUILTIN_LIST_ID,
    // 同步状态（界面显示）
    syncState,
    syncText,
    syncDetail,
    lastSyncAt,
    lastError,
    lastConflict,
    migratedAt,
    hydrate,
    refresh,
    flush,
  }
})
