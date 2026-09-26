/** 背单词功能的数据模型 */

export interface VocabWord {
  /** 词条内唯一 id */
  id: string
  /** 单词或短语，如 conceal / do away with sth */
  term: string
  /** 音标，如 kənˈsiːl */
  phonetic?: string
  /** 词性缩写，如 v. / adj. / n. */
  pos?: string
  /** 中文释义，多个义项用 ; 或 ； 分隔 */
  meaning: string
  /** 其他可接受的中文说法（判分宽松模式会用） */
  meaningAliases?: string[]
  /** 英文例句（兼容旧数据：单句） */
  example?: string
  /** 例句中文翻译（与 example 配对） */
  exampleZh?: string
  /** 多条例句。出题时从能挖空的句子里轮换，避免总考同一句 */
  examples?: WordExample[]
  /** 词根词缀 / 辨析等备注 */
  note?: string
  /** 标签，方便按标签筛题 */
  tags?: string[]
  /** 首次写入时间 */
  addedAt?: number
  /** 谁写入的：builtin / user / import / agent / web */
  addedBy?: 'builtin' | 'user' | 'import' | 'agent' | 'web'
  /**
   * 这个词要做到哪一档：
   * read = 阅读认识即可；listen = 还要听懂；write = 听懂且会拼会用。
   */
  goal?: WordGoal
}

export interface WordExample {
  en: string
  zh?: string
  /** 来源：import / user / agent */
  source?: string
}

export type WordGoal = 'read' | 'listen' | 'write'
export type VocabSkill = 'reading' | 'listening' | 'writing'

export interface WordList {
  id: string
  name: string
  description?: string
  words: VocabWord[]
  createdAt: number
  updatedAt: number
  /** builtin = 内置（不可删除，可复制）；user = 自己建的；import = 导入的 */
  source: 'builtin' | 'user' | 'import'
}

export type QuestionType = 'en2zh' | 'zh2en' | 'spell' | 'zh-input' | 'cloze' | 'listen'
export type StudyOrder = 'due-first' | 'random' | 'list' | 'wrong-first' | 'unmastered-first'

/** 每个词条的累计做题表现（含 SuperMemo-2 间隔重复字段） */
export interface WordStat {
  wordId: string
  term: string
  right: number
  wrong: number
  /** 连续答对次数，达到阈值记为已掌握（兼容旧界面） */
  streak: number
  lastSeen: number
  lastWrongAt?: number
  /** SM-2 难度系数，默认 2.5，下限 1.3 */
  ease?: number
  /** 当前复习间隔（天） */
  interval?: number
  /** 连续答对的复习次数（答错归零） */
  repetitions?: number
  /** 下次该复习的时间戳；0 = 新词 */
  dueAt?: number
  /** 从已毕业状态答错的次数 */
  lapses?: number
  lastResult?: boolean
  lastType?: QuestionType
  typeStats?: Partial<Record<QuestionType, { right: number; wrong: number }>>
}

export interface SessionWrongItem {
  wordId: string
  term: string
  meaning: string
  phonetic?: string
}

/** 单题作答，供中断恢复与事后溯源 */
export interface SessionAnswer {
  wordId: string
  term: string
  meaning: string
  phonetic?: string
  type: QuestionType
  given: string
  expected: string
  correct: boolean
  at: number
}

export type SessionStatus = 'running' | 'done' | 'abandoned'

export interface SessionRecord {
  id: string
  listId: string
  listName: string
  startedAt: number
  finishedAt: number
  updatedAt?: number
  status?: SessionStatus
  order?: StudyOrder
  planned?: number
  total: number
  correct: number
  types: QuestionType[]
  wrong: SessionWrongItem[]
  answers?: SessionAnswer[]
}

export interface QuestionTypeMeta {
  value: QuestionType
  label: string
  hint: string
  /** 是否为选择题 */
  choice: boolean
}

export const QUESTION_TYPES: QuestionTypeMeta[] = [
  { value: 'en2zh', label: '看英选中', hint: '给出英文，选出正确的中文释义', choice: true },
  { value: 'zh2en', label: '看中选英', hint: '给出中文，选出正确的英文单词', choice: true },
  { value: 'spell', label: '拼写', hint: '给出中文与音标，拼写出英文（短语不参与）', choice: false },
  { value: 'zh-input', label: '写释义', hint: '给出英文，写出中文意思', choice: false },
  { value: 'cloze', label: '例句填空', hint: '在例句空格里填出这个单词（需有例句）', choice: false },
  { value: 'listen', label: '听音选义', hint: '只放发音，选出正确的中文释义（测听力）', choice: true },
]

export interface StudyOptions {
  listId: string
  /** 本次考多少词，0 表示全部 */
  count: number
  types: QuestionType[]
  order: StudyOrder
}

export interface VocabSettings {
  /** 每词连续答对几次算已掌握 */
  masterStreak: number
  /** 写释义 / 拼写是否严格（允许一个字母之差 / 中文需精确匹配） */
  strictSpelling: boolean
}

export const DEFAULT_SETTINGS: VocabSettings = {
  masterStreak: 2,
  strictSpelling: true,
}

export const TYPE_LABEL: Record<QuestionType, string> = {
  en2zh: '看英选中',
  zh2en: '看中选英',
  spell: '拼写',
  'zh-input': '写释义',
  cloze: '例句填空',
  listen: '听音选义',
}

export const GOAL_LABEL: Record<WordGoal, string> = {
  read: '阅读认识',
  listen: '听懂',
  write: '会写会用',
}

export const SKILL_LABEL: Record<VocabSkill, string> = {
  reading: '阅读',
  listening: '听力',
  writing: '写作/拼写',
}

export interface SkillScore {
  right: number
  wrong: number
  accuracy: number
}

export interface VocabDiagnosis {
  at: number
  listId: string
  listName: string
  skills: Record<VocabSkill, SkillScore>
  sample: Array<{ term: string; skill: VocabSkill; correct: boolean }>
  plan: string[]
}

/**
 * 学习者自述的目标画像。
 *
 * 字段都是**自由文本**（不是枚举）：工具不该预设任何人的年级 / 目标考试 / 考试日期，
 * 那些由使用者自己在「训练计划」页里填。选项列表只用来给常见值做候选（见 VocabPlan.vue），
 * 代码里不拿它们的值做判断 —— 空 = 没填，页面显示引导。
 */
export interface LearnerProfile {
  /** 年级，例如「大一」「研一」；空 = 没填 */
  grade: string
  /** 正在准备的考试（可多选），例如「四级」「考研」；空 = 没填 */
  exams: string[]
  /** 听力习惯：daily（每天听）/ often（隔几天）/ rarely（很少） */
  listenHabit: string
  note?: string
}

export interface VocabPlanState {
  profile: LearnerProfile
  diagnosis: VocabDiagnosis | null
}

export interface ChoiceQuestion {
  id: string
  kind: 'choice'
  type: QuestionType
  wordId: string
  term: string
  meaning: string
  phonetic?: string
  pos?: string
  /** 题干上方的指令，如「选出正确的中文释义」 */
  instruction: string
  /** 题干主体 */
  stem: string
  /** 题干副信息（音标 / 词性等） */
  stemSub?: string
  options: string[]
  answerIndex: number
  /** 正确答案文本 */
  answer: string
}

export interface InputQuestion {
  id: string
  kind: 'input'
  type: QuestionType
  wordId: string
  term: string
  meaning: string
  phonetic?: string
  pos?: string
  instruction: string
  stem: string
  stemSub?: string
  placeholder: string
  /** 所有可接受答案（已归一化前的原始形式） */
  answers: string[]
  /** 展示用的标准答案 */
  display: string
  /** 例句（cloze 用，含 ___ 空格；作答后可展示完整句） */
  example?: string
  exampleZh?: string
}

export type Question = ChoiceQuestion | InputQuestion

/** 进行中的练习检查点：刷新 / 关页后还能接着做 */
export interface StudyCheckpoint {
  sessionId: string
  listId: string
  listName: string
  form: {
    listId: string
    count: number
    types: QuestionType[]
    order: StudyOrder
  }
  questions: Question[]
  cursor: number
  revealed: boolean
  input: string
  chosenIndex: number | null
  lastCorrect: boolean
  answers: SessionAnswer[]
  startedAt: number
  updatedAt: number
}

/** 作答结果，用于统计与错题本 */
export interface AnswerResult {
  question: Question
  /** 用户原始输入 / 选中的选项文本 */
  given: string
  correct: boolean
  /** 正确答案展示文本 */
  expected: string
  /** 选项原文里是否含该词的中文（供解析展示） */
  word: VocabWord
}
