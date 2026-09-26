/**
 * 出题与判分引擎 —— 纯函数，不碰 DOM / store，便于单测和复用。
 *
 * 设计要点：
 *   - 一个词默认只出一道题，题型从用户勾选的题型里随机挑一个该词支持的；
 *     这样题量可预测（= 参试词数），又能做到题型混合。
 *   - 选择题的干扰项从「整个词单」里取，而不是只从本次参试的词里取，
 *     这样词少的时候也能凑出像样的选项。
 *   - 判分对中文宽松、对英文拼写可选严格。
 */
import type {
  AnswerResult,
  ChoiceQuestion,
  InputQuestion,
  Question,
  QuestionType,
  StudyOrder,
  VocabSettings,
  VocabWord,
  WordStat,
} from './types'
import { dueRank, weakestTypes } from './srs'

/* ----------------------------------------------------------- 基础工具 --- */

export function shuffle<T>(arr: readonly T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function pickOne<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

/** 英文归一化：小写、去首尾与多余空白、去标点 */
export function normalizeEn(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[.,!?;:"“”()\[\]{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 中文归一化：去空白与常见标点 */
export function normalizeZh(s: string): string {
  return s
    .replace(/[\s\u3000]/g, '')
    .replace(/[，。、；：！？,.;:!?"'“”‘’()（）\[\]【】<>《》~—-]/g, '')
    .trim()
}

/** 把一条释义拆成若干可接受的义项 */
export function splitMeanings(meaning: string): string[] {
  return meaning
    .split(/[;；]|(?<=\S)\s*\/\s*(?=\S)/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    prev = cur
  }
  return prev[b.length]
}

/* --------------------------------------------------------------- 判分 --- */

/** 判断中文释义是否答对 */
export function judgeZh(input: string, word: VocabWord): boolean {
  const given = normalizeZh(input)
  if (!given) return false

  const candidates = [word.meaning, ...(word.meaningAliases ?? [])]
    .flatMap(splitMeanings)
    .map(normalizeZh)
    .filter(Boolean)

  for (const c of candidates) {
    if (given === c) return true
    // 中文释义允许多写 / 少写：只要有一方完整包含另一方（且不短于 2 字）就算对
    if (c.length >= 2 && given.length >= 2 && (given.includes(c) || c.includes(given))) return true
  }
  return false
}

/** 判断英文拼写是否答对 */
export function judgeEn(input: string, answers: string[], strict: boolean): boolean {
  const given = normalizeEn(input)
  if (!given) return false
  for (const ans of answers) {
    const target = normalizeEn(ans)
    if (!target) continue
    if (given === target) return true
    if (!strict && target.replace(/\s/g, '').length > 3 && levenshtein(given, target) <= 1) return true
  }
  return false
}

/** 统一入口：给一道题和用户输入，返回是否答对 */
export function judge(q: Question, input: string, settings: VocabSettings, word?: VocabWord): boolean {
  if (q.kind === 'choice') return normalizeEn(input) === normalizeEn(q.answer)
  if (q.type === 'spell') return judgeEn(input, q.answers, settings.strictSpelling)
  if (q.type === 'cloze') return judgeEn(input, q.answers, settings.strictSpelling)
  // zh-input
  if (word) return judgeZh(input, word)
  return normalizeZh(input) === normalizeZh(q.display)
}

/* ------------------------------------------------------------ 出题 ------ */

const INSTRUCTION: Record<QuestionType, string> = {
  en2zh: '选出正确的中文释义',
  zh2en: '选出对应的英文单词',
  spell: '根据中文与音标，拼写出英文',
  'zh-input': '写出这个单词的中文意思',
  cloze: '在例句的空格处填上正确的单词',
  listen: '只听发音，不要看英文，选出正确的中文释义',
}

export function skillOf(type: QuestionType): 'reading' | 'listening' | 'writing' {
  if (type === 'listen') return 'listening'
  if (type === 'spell' || type === 'cloze') return 'writing'
  return 'reading'
}

export function typesForGoal(goal: VocabWord['goal']): QuestionType[] {
  if (goal === 'write') return ['en2zh', 'listen', 'spell', 'zh-input', 'cloze', 'zh2en']
  if (goal === 'listen') return ['en2zh', 'listen', 'zh-input', 'zh2en']
  return ['en2zh', 'zh2en', 'zh-input']
}

export function defaultGoal(word: VocabWord): NonNullable<VocabWord['goal']> {
  if (word.goal) return word.goal
  if (/\s/.test(word.term.trim())) return 'read'
  return 'listen'
}

/** 该词是否支持某种题型 */
export function supports(word: VocabWord, type: QuestionType): boolean {
  switch (type) {
    case 'spell':
      // 短语（含空格）不适合做拼写默写
      return !/\s/.test(word.term.trim())
    case 'cloze':
      return usableExamples(word).length > 0
    case 'zh-input':
      return word.meaning !== '（未填写释义）'
    case 'listen':
      return word.meaning !== '（未填写释义）' && !/\s/.test(word.term.trim())
    default:
      return true
  }
}

export function allExamples(word: VocabWord): Array<{ en: string; zh?: string }> {
  const out: Array<{ en: string; zh?: string }> = []
  const seen = new Set<string>()
  const push = (en?: string, zh?: string) => {
    const t = String(en ?? '').trim()
    if (!t) return
    const key = t.toLowerCase().replace(/\s+/g, ' ')
    if (seen.has(key)) return
    seen.add(key)
    out.push({ en: t, zh: zh?.trim() || undefined })
  }
  for (const ex of word.examples ?? []) push(ex.en, ex.zh)
  push(word.example, word.exampleZh)
  return out
}

export function usableExamples(word: VocabWord): Array<{ en: string; zh?: string }> {
  return allExamples(word).filter((ex) => containsTerm(ex.en, word.term))
}

/** 例句里是否真的出现了这个词（忽略大小写与词形末尾变化） */
function containsTerm(sentence: string, term: string): boolean {
  const stem = term.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`\\b${stem}(s|es|ed|d|ing|ies|ied)?\\b`, 'i')
  return re.test(sentence)
}

/** 把例句里的目标词挖成空格 */
function makeCloze(sentence: string, term: string): string {
  const stem = term.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`\\b${stem}(s|es|ed|d|ing|ies|ied)?\\b`, 'i')
  return sentence.replace(re, '______')
}

function makeChoice(
  type: 'en2zh' | 'zh2en' | 'listen',
  word: VocabWord,
  pool: VocabWord[],
): ChoiceQuestion | null {
  const isEn2Zh = type === 'en2zh' || type === 'listen'
  const answer = isEn2Zh ? word.meaning : word.term

  const exclude = new Set([normalizeZh(word.meaning), normalizeEn(word.term)])
  const distractors: string[] = []
  for (const w of shuffle(pool)) {
    if (w.id === word.id) continue
    const text = isEn2Zh ? w.meaning : w.term
    const key = isEn2Zh ? normalizeZh(text) : normalizeEn(text)
    if (exclude.has(key)) continue
    if (distractors.some((d) => (isEn2Zh ? normalizeZh(d) : normalizeEn(d)) === key)) continue
    distractors.push(text)
    if (distractors.length >= 3) break
  }

  // 干扰项不足就不出选择题（宁可换成输入题）
  if (distractors.length < 2) return null

  const options = shuffle([answer, ...distractors])
  const answerIndex = options.findIndex(
    (o) => (isEn2Zh ? normalizeZh(o) : normalizeEn(o)) === (isEn2Zh ? normalizeZh(answer) : normalizeEn(answer)),
  )

  return {
    id: `q_${word.id}_${type}`,
    kind: 'choice',
    type,
    wordId: word.id,
    term: word.term,
    meaning: word.meaning,
    phonetic: word.phonetic,
    pos: word.pos,
    instruction: INSTRUCTION[type],
    stem: type === 'listen' ? '播放发音' : isEn2Zh ? word.term : word.meaning,
    stemSub: type === 'listen' ? undefined : isEn2Zh ? [word.phonetic ? `/${word.phonetic}/` : '', word.pos ?? ''].filter(Boolean).join('  ') || undefined : undefined,
    options,
    answerIndex,
    answer,
  }
}

function makeInput(type: 'spell' | 'zh-input' | 'cloze', word: VocabWord): InputQuestion | null {
  if (type === 'cloze') {
    const pool = usableExamples(word)
    if (!pool.length) return null
    const picked = pool[Math.floor(Math.random() * pool.length)]
    return {
      id: `q_${word.id}_cloze_${pool.length}`,
      kind: 'input',
      type,
      wordId: word.id,
      term: word.term,
      meaning: word.meaning,
      phonetic: word.phonetic,
      pos: word.pos,
      instruction: INSTRUCTION.cloze,
      stem: makeCloze(picked.en, word.term),
      stemSub: picked.zh,
      placeholder: '填入这个单词',
      answers: [word.term],
      display: word.term,
      example: picked.en,
      exampleZh: picked.zh,
    }
  }

  if (type === 'spell') {
    if (/\s/.test(word.term.trim())) return null
    return {
      id: `q_${word.id}_spell`,
      kind: 'input',
      type,
      wordId: word.id,
      term: word.term,
      meaning: word.meaning,
      phonetic: word.phonetic,
      pos: word.pos,
      instruction: INSTRUCTION.spell,
      stem: word.meaning,
      stemSub: [word.phonetic ? `/${word.phonetic}/` : '', word.pos ?? ''].filter(Boolean).join('  ') || undefined,
      placeholder: '拼写英文单词',
      answers: [word.term],
      display: word.term,
    }
  }

  // zh-input
  if (word.meaning === '（未填写释义）') return null
  return {
    id: `q_${word.id}_zh-input`,
    kind: 'input',
    type,
    wordId: word.id,
    term: word.term,
    meaning: word.meaning,
    phonetic: word.phonetic,
    pos: word.pos,
    instruction: INSTRUCTION[type],
    stem: word.term,
    stemSub: [word.phonetic ? `/${word.phonetic}/` : '', word.pos ?? ''].filter(Boolean).join('  ') || undefined,
    placeholder: '写出中文意思',
    answers: [word.meaning, ...(word.meaningAliases ?? [])],
    display: word.meaning,
    example: word.example,
    exampleZh: word.exampleZh,
  }
}

/** 按用户选择的顺序策略，对参试词排序 */
function orderWords(
  words: VocabWord[],
  order: StudyOrder,
  stats: Record<string, WordStat>,
): VocabWord[] {
  switch (order) {
    case 'list':
      return [...words]
    case 'due-first':
      return [...words].sort((a, b) => dueRank(stats[a.id]) - dueRank(stats[b.id]))
    case 'wrong-first':
      return [...words].sort((a, b) => {
        const sa = stats[a.id]
        const sb = stats[b.id]
        // 错得越多越靠前
        const wa = sa ? sa.wrong / Math.max(1, sa.right + sa.wrong) : 0
        const wb = sb ? sb.wrong / Math.max(1, sb.right + sb.wrong) : 0
        if (wa !== wb) return wb - wa
        return (sa?.lastWrongAt ?? 0) > (sb?.lastWrongAt ?? 0) ? -1 : 1
      })
    case 'unmastered-first':
      return [...words].sort((a, b) => {
        const ma = stats[a.id]?.streak ?? 0
        const mb = stats[b.id]?.streak ?? 0
        return ma - mb
      })
    case 'random':
    default:
      return shuffle(words)
  }
}

export interface BuildQuestionsInput {
  words: VocabWord[]
  /** 整个词单，用于生成干扰项 */
  pool: VocabWord[]
  types: QuestionType[]
  order: StudyOrder
  count: number
  stats: Record<string, WordStat>
}

/**
 * 生成一次练习的题目。
 * 返回的题目数量可能少于参试词数 —— 某些词在所选题型下无法出题（无例句、是短语等）会被跳过。
 */
export function buildQuestions(opts: BuildQuestionsInput): Question[] {
  const { words, pool, types, order, count, stats } = opts
  const activeTypes = types.length ? types : (['en2zh'] as QuestionType[])

  let candidates = words.filter((w) => activeTypes.some((t) => supports(w, t)))
  candidates = orderWords(candidates, order, stats)
  if (count > 0) candidates = candidates.slice(0, count)

  const questions: Question[] = []
  for (const word of candidates) {
    const goalTypes = typesForGoal(defaultGoal(word))
    const usable = activeTypes.filter((t) => supports(word, t) && goalTypes.includes(t))
    if (!usable.length) continue

    // 该词错得多的题型优先，其余再打乱；选择题出不来就退到输入题
    const weak = weakestTypes(stats[word.id]).filter((t) => usable.includes(t))
    const rest = shuffle(usable.filter((t) => !weak.includes(t)))
    for (const type of [...weak, ...rest]) {
      if (type === 'en2zh' || type === 'zh2en' || type === 'listen') {
        const q = makeChoice(type, word, pool)
        if (q) {
          questions.push(q)
          break
        }
      } else {
        const q = makeInput(type, word)
        if (q) {
          questions.push(q)
          break
        }
      }
    }
  }
  return questions
}

/** 诊断：每个词各出阅读 / 听力 / 拼写一题，用来摸底而不是按遗忘曲线排。 */
export function buildDiagnostic(words: VocabWord[], pool: VocabWord[], perSkill = 8): Question[] {
  const skills: QuestionType[] = ['en2zh', 'listen', 'spell']
  const picked = shuffle(words.filter((w) => skills.every((t) => supports(w, t)))).slice(0, perSkill)
  const fallback = shuffle(words).slice(0, perSkill)
  const use = picked.length >= Math.min(4, perSkill) ? picked : fallback
  const out: Question[] = []
  for (const word of use) {
    for (const type of skills) {
      if (!supports(word, type)) continue
      if (type === 'en2zh' || type === 'listen') {
        const q = makeChoice(type, word, pool)
        if (q) out.push(q)
      } else {
        const q = makeInput('spell', word)
        if (q) out.push(q)
      }
    }
  }
  return out
}

/** 把作答结果组装成一份可展示的解析 */
export function toAnswerResult(q: Question, given: string, correct: boolean, word: VocabWord): AnswerResult {
  return {
    question: q,
    given,
    correct,
    expected: q.kind === 'choice' ? q.answer : q.display,
    word,
  }
}
