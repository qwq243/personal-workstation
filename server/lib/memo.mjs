/**
 * 语音随记：给一段音频 → 转成文字 → 自动起标题写摘要 → 落成一条可回看的记录。
 *
 * 任务模型（**通用**，与转写后端无关）：
 *   ① start  起一个任务：文件落盘、置 running、立刻返回 jobId（不在请求里等转写）
 *   ② poll   看任务：`GET /api/memo/job?id=` 拿进度；转写完成后**顺手把总结也做掉**，
 *            结果里带上记录 id —— 页面只需要轮询这一个接口
 *   ③ done   任务结束后写 records.json 与 records/<日期>-<slug>.md
 *
 * 为什么是「起任务 + 轮询」而不是一个请求里等完：转写是分钟级的，
 * 而 Node 的默认 requestTimeout 是 5 分钟，长音频必被掐。
 *
 * 转写后端是一个可换的 provider 接口，见 server/lib/asr.mjs
 * （出厂只带一个实现：OpenAI 兼容的 /audio/transcriptions）。这里不关心它是本机还是云端。
 *
 * 数据落 server/data/memo/：
 *   records.json             记录索引（createJsonStore，原子写 + .bak + 按天快照）
 *   records/<日期>-<slug>.md 单条记录的可读正文（摘要 + 原文）
 *   inbox/                   上传进来的原始音频（转写完不删，留着方便重跑）
 *   jobs.json                任务快照（边车重启后把死掉的 running 标 interrupted）
 *
 * 边界：不做录屏；不自动入知识库（页面给「复制 Markdown」）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, dataDir } from '../config.mjs'
import { createJsonStore, todayStr } from './jsonstore.mjs'
import { aiModels } from './newapi.mjs'
import { chatGuarded, chatStreamGuarded } from './llm.mjs'
import * as asr from './asr.mjs'

const MEMO_DIR = () => path.join(dataDir(), 'memo')
const RECORDS_DIR = () => path.join(MEMO_DIR(), 'records')
const RECORDS_FILE = () => path.join(MEMO_DIR(), 'records.json')
const INBOX_DIR = () => path.join(MEMO_DIR(), 'inbox')
const JOBS_FILE = () => path.join(MEMO_DIR(), 'jobs.json')

/** 记录库最多留这么多条（旧的连同 md 一起清掉） */
const KEEP_RECORDS = 300
/** 内存里保留的任务条数（polll 用；落盘的那份只为「重启后对账」） */
const KEEP_JOBS = 50

/* ------------------------------------------------------------------ 设置 --- */

const SETTINGS_FILE = () => path.join(MEMO_DIR(), 'settings.json')

/** 页面选的总结模型（空 = 跟随「设置 → 模型」的 chat 预设）+ 自定义提示词 */
function settings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf-8'))
    // 保留整包（prompts 等）——只挑 model 出去会把别的键在写回时丢掉
    return {
      ...(raw && typeof raw === 'object' ? raw : {}),
      model: typeof raw?.model === 'string' ? raw.model : '',
    }
  } catch {
    return { model: '' }
  }
}

function writeSettings(next) {
  try {
    fs.mkdirSync(MEMO_DIR(), { recursive: true })
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(next, null, 2), 'utf-8')
  } catch (err) {
    console.warn(`[memo] 设置写不进去：${err.message}`)
  }
}

/** 可用模型清单 + 默认 + 页面选中的那个（形状对照 /api/wiki/llm/models，前端好复用） */
export function models() {
  const cfg = loadConfig()
  const list = aiModels()
  return {
    ok: true,
    provider: cfg.ai?.providerName ?? '',
    default: cfg.ai?.model ?? '',
    models: list.length ? list : cfg.ai?.model ? [cfg.ai.model] : [],
    chosen: settings().model,
  }
}

export function setModel(model) {
  const clean = String(model ?? '').trim()
  const list = aiModels()
  if (clean && list.length && !list.includes(clean)) {
    return { ok: false, error: `「${clean}」不在当前模型清单里`, models: list }
  }
  writeSettings({ ...settings(), model: clean })
  return { ok: true, model: clean, ...models() }
}

/** 显式传的模型优先，其次页面选的，最后交给 config 的默认（返回 undefined） */
function resolveModel(explicit) {
  const clean = String(explicit ?? '').trim()
  if (clean) return clean
  const chosen = settings().model
  return chosen || undefined
}


/* ------------------------------------------------------------------ 记录库 --- */

const store = createJsonStore({
  name: 'memo',
  file: RECORDS_FILE,
  version: 1,
  backupDir: () => path.join(dataDir(), 'backups'),
  empty: () => ({ version: 1, rev: 0, updatedAt: 0, records: [] }),
  migrate: (raw) => ({
    version: 1,
    rev: Number(raw?.rev) || 0,
    updatedAt: Number(raw?.updatedAt) || 0,
    savedBy: raw?.savedBy,
    records: Array.isArray(raw?.records) ? raw.records : [],
  }),
})

function brief(record) {
  return {
    id: record.id,
    title: record.title,
    summary: record.summary,
    chars: record.chars,
    durationSec: record.durationSec,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    device: record.device,
    tags: record.tags ?? [],
    sections: (record.sections ?? []).map((s) => ({ key: s.key, title: s.title, items: s.items?.length ?? 0 })),
    stageSummaries: (record.liveSummaries ?? []).length,
    parts: (record.parts ?? []).length,
  }
}

export function list({ limit = 50 } = {}) {
  return store.read().records.slice(0, Math.max(1, Math.min(Number(limit) || 50, KEEP_RECORDS))).map(brief)
}

export function get(id) {
  const record = store.read().records.find((item) => item.id === id)
  return record ?? null
}

function put(record) {
  const data = store.read()
  const rest = data.records.filter((item) => item.id !== record.id)
  const next = { ...data, records: [record, ...rest].slice(0, KEEP_RECORDS) }
  store.write(next, { baseRev: data.rev, source: 'memo' })
  return record
}

export function rename(id, title) {
  const record = get(id)
  if (!record) return { ok: false, error: `没有这条记录：${id}` }
  const clean = String(title ?? '').trim()
  if (!clean) return { ok: false, error: '标题不能为空' }
  record.title = clean
  put(record)
  writeMarkdown(record)
  return { ok: true, record: brief(record) }
}

export function remove(id) {
  const record = get(id)
  if (!record) return { ok: false, error: `没有这条记录：${id}` }
  const data = store.read()
  store.write({ ...data, records: data.records.filter((item) => item.id !== id) }, { baseRev: data.rev, source: 'memo' })
  if (record.file) {
    try {
      fs.unlinkSync(record.file)
    } catch {
      /* 文件不在了就算了 */
    }
  }
  return { ok: true, removed: id }
}

/* ------------------------------------------------------------ 转写后端 --- */

/** 转写后端状态（透传 asr.mjs）：页面据此决定显示引导还是操作区 */
export function asrStatus() {
  return { ...asr.status(), audioExt: [...asr.AUDIO_EXT] }
}

/**
 * 把浏览器拖进来的音频落盘到 inbox/。
 * 文件名做一次清洗：只留基名、去掉路径分隔与可疑字符，避免 `../` 跑到目录外面。
 */
export function stashUploadedAudio(name, buffer) {
  const safe = String(name || '')
    .replace(/[\\/]+/g, '_')
    .replace(/[\x00-\x1f<>:"|?*]/g, '')
    .trim()
  const base = safe || `audio-${Date.now().toString(36)}`
  const withName = path.extname(base) ? base : `${base}.wav`
  const dir = INBOX_DIR()
  fs.mkdirSync(dir, { recursive: true })
  const abs = path.join(dir, `${Date.now().toString(36)}-${withName}`)
  fs.writeFileSync(abs, buffer)
  return abs
}

/* ------------------------------------------------------------------ 任务 --- */

/**
 * 任务表：`id -> { status, file, name, startedAt, endedAt, chars, error, recordId, ... }`
 *
 * 只放内存 + 一份 jobs.json 快照。快照的唯一用途是**重启后对账**：
 * 边车死在转写中途时，那条 running 会在下次启动时被标成 interrupted，
 * 而不是永远转圈（页面轮询一个不存在的任务会一直 pending）。
 */
let jobs = new Map()

function jobsFileWrite() {
  try {
    fs.mkdirSync(MEMO_DIR(), { recursive: true })
    const arr = [...jobs.values()].slice(-KEEP_JOBS)
    fs.writeFileSync(JOBS_FILE(), JSON.stringify({ at: Date.now(), jobs: arr }, null, 2), 'utf-8')
  } catch {
    /* 快照失败不影响转写 */
  }
}

/** 启动时对账：上次边车退出时还在跑的任务，标成 interrupted */
function reconcileJobs() {
  try {
    const raw = JSON.parse(fs.readFileSync(JOBS_FILE(), 'utf-8'))
    const list = Array.isArray(raw?.jobs) ? raw.jobs : []
    for (const job of list) {
      if (job?.status === 'running') {
        job.status = 'interrupted'
        job.error = '边车在做这个任务时退出了，请重新转写'
        job.endedAt = job.endedAt ?? Date.now()
      }
      if (job?.id) jobs.set(job.id, job)
    }
  } catch {
    /* 没有快照就是干净的 */
  }
}
reconcileJobs()

function briefJob(job) {
  if (!job) return null
  return {
    id: job.id,
    status: job.status,
    name: job.name,
    chars: job.chars ?? 0,
    startedAt: job.startedAt,
    endedAt: job.endedAt ?? null,
    elapsedSec: Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000),
    error: job.error ?? null,
    recordId: job.recordId ?? null,
    model: job.model ?? null,
    asrMs: job.asrMs ?? null,
  }
}

/** 整体状态：转写后端能不能用 + 最近的任务 + 记录条数 */
export function status() {
  const list = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt)
  return {
    ok: true,
    asr: asrStatus(),
    running: list.filter((j) => j.status === 'running').length,
    lastJob: briefJob(list[0]),
    jobs: list.slice(0, 20).map(briefJob),
    records: store.read().records.length,
  }
}

export function jobStatus(id) {
  const job = jobs.get(String(id ?? ''))
  if (!job) return { ok: false, error: `没有这个任务：${id ?? ''}` }
  return { ok: true, job: briefJob(job), record: job.recordId ? brief(get(job.recordId) ?? {}) : null }
}

/**
 * 起一个转写任务。立刻返回 jobId，转写在后台跑。
 *
 * @param {{ path: string, name?: string, source?: string }} opts
 */
export function startTranscribe({ path: file, name, source = 'web' } = {}) {
  const st = asrStatus()
  if (!st.configured) return { ok: false, error: st.reason }
  const abs = String(file ?? '').trim()
  if (!abs) return { ok: false, error: '没给音频文件路径' }
  if (!fs.existsSync(abs)) return { ok: false, error: `文件不存在：${abs}` }

  const id = `memo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const job = {
    id,
    status: 'running',
    file: abs,
    name: String(name || path.basename(abs)),
    source,
    startedAt: Date.now(),
    endedAt: null,
    chars: 0,
    error: null,
    recordId: null,
    model: null,
    asrMs: null,
  }
  jobs.set(id, job)
  if (jobs.size > KEEP_JOBS) {
    const oldest = [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt)[0]
    if (oldest) jobs.delete(oldest.id)
  }
  jobsFileWrite()
  console.log(`[memo] transcribe ${id} file=${path.basename(abs)} source=${source}`)

  // 故意不 await：调用方要的是「立刻拿到 jobId」
  void runJob(job)
  return { ok: true, job: briefJob(job) }
}

/** 跑完一个任务：转写 → 落成记录（顺带做总结） */
async function runJob(job) {
  const r = await asr.transcribeFile(job.file, {})
  if (!r.ok) {
    job.status = 'error'
    job.error = r.error
    job.endedAt = Date.now()
    jobsFileWrite()
    console.warn(`[memo] 转写失败 ${job.id}：${r.error}`)
    return
  }
  job.chars = r.text.length
  job.model = r.model ?? null
  job.asrMs = r.ms ?? null

  const record = {
    id: job.id,
    title: '',
    summary: '',
    sections: [],
    transcript: r.text,
    segments: [],
    chars: r.text.length,
    startedAt: job.startedAt,
    endedAt: Date.now(),
    durationSec: Math.round((Date.now() - job.startedAt) / 1000),
    device: null,
    source: job.source,
    file: job.file,
    errors: [],
    liveSummary: '',
    liveSummaries: [],
    model: null,
  }

  try {
    if (record.transcript.trim().length >= 8) await summarizeRecord(record)
    else {
      record.title = fallbackTitle(record.transcript) || '未命名随记'
      record.summary = ''
    }
  } catch (err) {
    // 总结失败不该把转写结果一起丢掉：记录照存，标题用兜底
    record.title = record.title || fallbackTitle(record.transcript) || '未命名随记'
    record.errors = [{ at: Date.now(), text: `自动总结失败：${err.message}` }]
  }

  const stored = persist(record)
  job.status = 'done'
  job.recordId = stored.id
  job.endedAt = Date.now()
  jobsFileWrite()
  console.log(`[memo] done ${job.id} chars=${job.chars} record=${stored.id}`)
}

/** 总结用的提示词：要 Markdown 文档（能流式展示、也能直接当 md 存），不要 JSON */
/**
 * 长稿处理：**分段详析 → 合并**
 *
 * 为什么不一次喂完（2026-09-27 实测）：把 5202 字的口述一次交给这个模型，
 * 它会「从头想到尾」——思考 1.5~2.3 万字，最后 361 秒被上游 504，或者正文只剩 466 字。
 * 分段之后每次调用的输入只有一千多字，思考量可控；而且每段单独看能留下更多细节（这才是「深」）。
 * 各段详析本身也留档（record.parts），就是用户要的「阶段性材料」。
 */
const LONG_THRESHOLD = 1500
const CHUNK_CHARS = 1200

/** 把 segments 按字数切成块（不切断单句） */
function chunkSegments(segments, limit = CHUNK_CHARS) {
  const chunks = []
  let current = []
  let size = 0
  for (const seg of segments ?? []) {
    const text = String(seg.text ?? '').trim()
    if (!text) continue
    if (size && size + text.length > limit) {
      chunks.push(current)
      current = []
      size = 0
    }
    current.push(seg)
    size += text.length
  }
  if (current.length) chunks.push(current)
  return chunks
}

/** 合并用的内部模板：各段详析已经写得很细，这里只要跨段的总览与清单 */
const MERGE_INSTRUCTION = [
  '下面是同一份口述记录**按时间顺序**分段整理的结果。请把它们合并成一份完整的整理稿：',
  '',
  '{{parts}}',
  '',
  '输出 Markdown（**只出这些栏目**）：',
  '# 标题（≤ 16 字，点明整份记录是什么）',
  '## 摘要（3-6 句连贯段落：整体在讲什么、分几块、结论或走向；不要列表、不要一句话概括）',
  '## 标签（3-6 个主题词，每个 ≤ 6 字，回答「这份记录主要讲什么」；不要结构词、不要数字，一行一个）',
  '## 讲了什么（按叙述顺序的**主线**，5-12 条；细节留在分段里，不要逐段搬运）',
  '## 关键决定与理由',
  '## 待办 / 下一步（跨段汇总，按依赖排序，去重）',
  '## 待确认 / 要查的',
  '## 风险与坑',
  '## 术语与专名（列表「转写写法 → 应该是」，全篇统一）',
  '## 时间轴（- [mm:ss] 关键点，合并各段里最重要的 6~15 个）',
  '',
  '没有内容的栏目整段略去；只依据上面材料，不要补新内容；不要输出 JSON 或代码块。',
].join('\n')

/** 分段那一轮的提示词：用同一套「要求」模板，前面加一句「这是第 i/n 段」 */
function partMessages(record, chunk, index, total) {
  const p = activePrompts()
  const values = {
    transcript: timelineOf(chunk),
    plain: chunk.map((seg) => String(seg.text ?? '').trim()).join('\n'),
    process: '',
    duration: humanLen(record.durationSec),
    chars: String(record.chars ?? ''),
  }
  const preamble =
    `（注意：这是同一份口述的第 ${index}/${total} 段，前后还有别的内容；` +
    '**只整理这一段**，把这一段的细节尽量写全，整份总稿会由各段整理合并而成。）\n\n'
  return [
    { role: 'system', content: p.summarySystem },
    { role: 'user', content: preamble + renderPrompt(p.summaryUser, values) },
  ]
}

/** 合并那一轮的提示词：输入是各段整理结果，不是原文 */
function mergeMessages(parts) {
  const body = parts
    .map((part, i) => {
      const sections = (part.sections ?? [])
        .map((sec) => [`### ${sec.title}`, ...sec.items.map((item) => `- ${item}`)].join('\n'))
        .join('\n')
      return [`## 第 ${i + 1} 段（${part.startLabel}~${part.endLabel}）`, sections || part.summary].join('\n')
    })
    .join('\n\n')
  return [
    {
      role: 'system',
      content: '你在把同一份口述记录的分段整理合并成一份总稿。只依据给定材料，不编造、不补新内容。',
    },
    { role: 'user', content: MERGE_INSTRUCTION.replace('{{parts}}', body) },
  ]
}

/**
 * 默认提示词模板（页面「提示词」弹窗可改；`{{transcript}}` 会被替换成转写原文）。
 * 分成四段是有意的：系统那段管「怎么对待这份转写」，用户那段管「输出什么形状」，
 * 滚动摘要单独一套（它要短、只要一句进展，不起标题）。
 */
export const DEFAULT_PROMPTS = {
  summarySystem:
    '你在整理用户的口述记录（多半是他自己讲研究思路、设计或复盘的录音）。原文是语音转写，' +
    '可能有同音字/错别字、缺标点、句子断裂——按上下文纠正明显错误（例如把「刺客云舒」按上下文改成「智课云枢」、' +
    '「追尾/追月」改成「Jev」），但**不要增补原文没有的信息**。\n' +
    '这份整理的用途是**当材料反复看**：宁可多留信息点，也不要压成空泛的概括；' +
    '**详细程度要跟着内容体量走**——几分钟的闲聊几句就够，十分钟以上的正经讲述必须分条展开、' +
    '把讲过的每个决定、数字、待办都留下来。不要 emoji，不要空话，不要「总之」「综上」这类填充。',
  summaryUser:
    '这是一次口述：时长 {{duration}}，转写 {{chars}} 字。\n\n' +
    '【带时间轴的转写】\n{{transcript}}\n\n' +
    '【录音过程中的阶段摘要】（每约 220 字自动压一次，可当作叙事线索，但**不完整**，' +
    '缺失处以转写为准）\n{{process}}\n\n' +
    '请输出一份 Markdown 整理稿，按下面的骨架（**栏目名照抄**，不适合内容的栏目整段略去，' +
    '不要写「无」「略」）：\n\n' +
    '# 标题\n' +
    '（≤ 16 字，点明这份记录是什么，例如「论文设计口述：平台行为链 + Jev 工作流」）\n\n' +
    '## 摘要\n' +
    '**3-6 句连贯的段落**（不要用列表、不要压成一句）：先说这段口述在讲什么、分几块讲的，' +
    '再给结论或走向。这一段要能**单独拿出来读懂**，别写成「本文记录了一次口述」这种空话。\n\n' +
    '## 标签\n' +
    '3-6 个，每个 ≤ 6 字，回答「这份记录主要讲什么」——写**主题词/关键词**' +
    '（例如「论文设计」「智课云枢」「Jev 判断模型」「行为链」「预实验」），' +
    '**不要**写「摘要」「要点」「待办」这类结构词，也不要带数字或条目数；一行一个，不要解释。\n\n' +
    '## 讲了什么\n' +
    '按叙述顺序分条，**一条一个信息点**，把讲到的内容尽量留住（人和事、平台/系统名、' +
    '方法、数字、判断、举例都算）。内容越长条数越多，不要合并成一句概括。\n\n' +
    '## 关键决定与理由\n' +
    '只收「已经定下来的做法」，每条写成「决定 —— 理由」，理由必须来自原文。\n\n' +
    '## 待办 / 下一步\n' +
    '他说要做的动作，按他给的顺序或依赖关系排，每条以动词开头。\n\n' +
    '## 待确认 / 要查的\n' +
    '他自己说还没想清楚、要看文献、要问人、要试的点。\n\n' +
    '## 风险与坑\n' +
    '他提到的隐患、失败、效果不好的地方（例如「防注入效果不太好」这种）。\n\n' +
    '## 术语与专名\n' +
    '列表「转写里的写法 → 应该是」（只列你有把握的），把本文出现的专名/术语对齐成一套写法，' +
    '方便以后检索；顺带一句话解释它在本文里指什么。\n\n' +
    '## 时间轴\n' +
    '- [mm:ss] 关键点（回听用，只挑真正重要的 5~12 个时间点）\n\n' +
    '要求：**只写原文里有的东西**；不确定的地方标注「（听不清）」，不要猜；' +
    '不要输出 JSON、不要代码块、不要解释你在做什么、不要在开头加「好的」。',
  liveSystem: '你在帮用户把正在进行中的口述记录压成一段进展。只依据原文，不编造，不用 emoji。',
  liveUser:
    '这是到目前为止的转写（可能还没说完）：\n{{transcript}}\n\n' +
    '用 2-4 句说清「现在讲到哪、说了什么要点」，作为后续分析的线索留档；直接给内容，不要标题。',
}

const PROMPT_KEYS = Object.keys(DEFAULT_PROMPTS)

/** 自定义过的提示词（空串 = 回到默认） */
function customPrompts() {
  const raw = settings().prompts
  if (!raw || typeof raw !== 'object') return {}
  const out = {}
  for (const key of PROMPT_KEYS) {
    if (typeof raw[key] === 'string' && raw[key].trim()) out[key] = raw[key]
  }
  return out
}

/** 实际生效的模板 = 默认 + 自定义覆盖 */
function activePrompts() {
  return { ...DEFAULT_PROMPTS, ...customPrompts() }
}

function renderPrompt(template, values) {
  return String(template)
    .replace(/\{\{\s*transcript\s*\}\}/g, values.transcript ?? '')
    .replace(/\{\{\s*plain\s*\}\}/g, values.plain ?? '')
    .replace(/\{\{\s*process\s*\}\}/g, values.process || '（暂无）')
    .replace(/\{\{\s*duration\s*\}\}/g, values.duration ?? '')
    .replace(/\{\{\s*chars\s*\}\}/g, values.chars ?? '')
}

function mmss(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function humanLen(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const m = Math.floor(total / 60)
  return m >= 1 ? `${m} 分 ${total % 60} 秒` : `${total} 秒`
}

/** 带时间轴的转写：`[mm:ss] 文本`。模型能据此给「时间轴」栏目，回听方便 */
function timelineOf(segments, limit = 12_000) {
  const lines = (segments ?? []).map((seg) => `[${mmss(seg.start)}] ${String(seg.text ?? '').trim()}`)
  const text = lines.join('\n')
  return text.length > limit ? text.slice(-limit) : text
}

/** 一次总结的取材（占位符替换用） */
function promptValues(record) {
  const process = (record.liveSummaries ?? [])
    .map((item, i) => `${i + 1}. ${String(item.text ?? '').trim()}`)
    .join('\n')
  return {
    transcript: timelineOf(record.segments),
    plain: String(record.transcript ?? '').slice(-12_000),
    process,
    duration: humanLen(record.durationSec),
    chars: String(record.chars ?? String(record.transcript ?? '').length),
  }
}


/** 总结用的两条消息（system 管态度、user 管形状） */
function buildSummaryMessages(record) {
  const p = activePrompts()
  const values = promptValues(record)
  return [
    { role: 'system', content: p.summarySystem },
    { role: 'user', content: renderPrompt(p.summaryUser, values) },
  ]
}

export function prompts() {
  const current = customPrompts()
  return {
    ok: true,
    defaults: DEFAULT_PROMPTS,
    current,
    active: activePrompts(),
    placeholders: ['{{transcript}}'],
    customized: Object.keys(current).length > 0,
  }
}

/** 保存提示词：只认这四个键；空串 = 该字段回默认；两个正文模板必须带 {{transcript}} */
export function setPrompts(patch = {}) {
  const next = {}
  for (const key of PROMPT_KEYS) {
    if (!(key in patch)) {
      const keep = customPrompts()[key]
      if (keep) next[key] = keep
      continue
    }
    const value = String(patch[key] ?? '').trim()
    if (!value) continue
    if (
      (key === 'summaryUser' || key === 'liveUser') &&
      !/\{\{\s*(transcript|plain)\s*\}\}/.test(value)
    ) {
      return {
        ok: false,
        error: `${key} 里必须保留 {{transcript}}（或 {{plain}}）占位符，它会被替换成转写原文`,
      }
    }
    next[key] = value
  }
  writeSettings({ ...settings(), prompts: next })
  return prompts()
}

const SECTION_KEYS = { 要点: 'points', 待办: 'todos', 决定: 'decisions', 疑问: 'questions' }

/**
 * 把模型输出的 Markdown 文档解析成 {title, summary, sections}。
 * 形状：第一行标题（`# x` 或 `【x】`）→ 正文段落即摘要 → 后面的小标题各自成栏目。
 */
/** 「摘要」这类小标题下的内容要并进 summary，而不是当成一个栏目 */
const SUMMARY_TITLES = new Set(['摘要', '总结', '概要', 'summary', '一句话'])
/** 「标签」这类小标题下是主题词，收进 tags */
const TAG_TITLES = new Set(['标签', '关键词', '主题', 'tags', 'keywords'])
const MAX_TAGS = 8

export function parseSummaryDoc(content) {
  const title = { value: '' }
  const summaryLines = []
  const sections = []
  const tags = []
  let current = null
  let inTags = false
  const closeSection = () => {
    if (current && current.items.length) sections.push(current)
    current = null
  }
  for (const raw of String(content ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const heading = line.match(/^#{1,6}\s*(.+)$/) ?? line.match(/^【(.+)】$/)
    if (heading) {
      const text = heading[1].trim().replace(/[:：]$/, '')
      if (!title.value) {
        title.value = text
        continue
      }
      closeSection()
      // 模型有时把摘要写成小标题（## 摘要）：那一段属于 summary，不要再开一个栏目
      if (SUMMARY_TITLES.has(text)) {
        inTags = false
        continue
      }
      if (TAG_TITLES.has(text)) {
        inTags = true
        continue
      }
      inTags = false
      current = { key: SECTION_KEYS[text] ?? 'other', title: text, items: [] }
      continue
    }
    const item = line.match(/^(?:[-*•]|\d+[.、)])\s+(.+)$/)
    const body = (item ? item[1] : line).trim()
    if (inTags) {
      // 一行一个，也可能一行写「论文设计、Jev 判断模型」，都拆开
      for (const piece of body.split(/[、,，;；/|]/)) {
        const tag = piece.replace(/^#+\s*/, '').trim()
        if (tag) tags.push(tag)
      }
      continue
    }
    if (current) current.items.push(body)
    else summaryLines.push(body)
  }
  closeSection()
  return {
    title: title.value,
    summary: summaryLines.join('\n').replace(/^摘要[:：]\s*/, '').trim(),
    sections,
    tags: [...new Set(tags)].slice(0, MAX_TAGS),
  }
}

/** 把模型输出落到 record 上（兼容模型偶尔直接回 JSON 的情况） */
function applySummary(record, content) {
  const text = String(content ?? '').trim()
  if (text.startsWith('{')) {
    const parsed = parseSummaryJson(text)
    if (parsed) {
      record.title = String(parsed.title ?? '').trim().slice(0, 30) || fallbackTitle(record.transcript)
      record.summary = String(parsed.summary ?? '').trim()
      record.sections = sectionList(parsed)
      return
    }
  }
  const doc = parseSummaryDoc(text)
  if (!doc.title && !doc.summary) {
    record.title = fallbackTitle(record.transcript)
    record.summary = text.slice(0, 500)
    record.sections = []
    record.tags = []
    return
  }
  record.title = doc.title.slice(0, 30) || fallbackTitle(record.transcript)
  record.summary = doc.summary
  record.sections = doc.sections
  record.tags = doc.tags ?? []
}

/** 停止后（或事后手动）总结：一次非流式调用 */
export async function summarizeRecord(record, { model } = {}) {
  const transcript = String(record.transcript ?? '').slice(-8000)
  if (!transcript.trim()) return { ok: false, error: '这条记录没有文字，没法总结' }
  const messages = buildSummaryMessages(record)
  const useModel = resolveModel(model)
  const isLong = Number(record.chars ?? 0) > LONG_THRESHOLD
  try {
    if (isLong) {
      // 长稿走分段（同 summarizeLong）：一次喂完会 504 / 正文被思考挤空，实测过
      const r = await summarizeLong(record, {
        useModel,
        onEvent: null,
        setPhase: () => {},
        addReasoning: () => {},
      })
      if (!r.ok) return { ok: false, error: r.error }
      applySummary(record, r.content)
      record.parts = r.parts
      record.model = useModel ?? loadConfig().ai?.model ?? null
      return { ok: true, model: record.model }
    }
    // 预算与"思考吃光正文"的守卫统一在 server/lib/llm.mjs（长任务按字数放大）
    const r = await chatGuarded(messages, {
      tier: 'doc',
      chars: record.chars,
      label: 'memo.summary',
      model: useModel,
      temperature: 0.3,
      timeout: 300_000,
    })
    if (!r.ok) return { ok: false, error: r.error ?? '模型调用失败' }
    if (!String(r.content ?? '').trim()) return { ok: false, error: '模型没返回正文（输出预算可能被思考吃光）' }
    applySummary(record, r.content)
    record.model = r.model ?? null
    return { ok: true, model: record.model }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

/**
 * 长稿：分段详析 → 合并。
 * 每段一次调用（输入小、思考量可控、细节更多），各段结果留档成 record.parts，
 * 最后一次合并只看各段整理（不看原文），产出总标题与跨段清单。
 */
async function summarizeLong(record, { useModel, signal, onEvent, setPhase, addReasoning }) {
  const chunks = chunkSegments(record.segments)
  const total = chunks.length
  if (!total) return { ok: false, error: '没有可用的转写分段' }
  const parts = []

  for (let i = 0; i < total; i += 1) {
    if (signal?.aborted) return { ok: false, error: '已取消' }
    const chunk = chunks[i]
    const chunkChars = chunk.reduce((n, seg) => n + String(seg.text ?? '').length, 0)
    setPhase(`part ${i + 1}/${total}`)
    onEvent?.({ type: 'stage', phase: 'part', index: i + 1, total, chars: chunkChars, running: true })

    const r = await chatGuarded(partMessages(record, chunk, i + 1, total), {
      tier: 'doc',
      chars: chunkChars,
      label: `memo.part${i + 1}`,
      model: useModel,
      temperature: 0.3,
      timeout: 300_000,
    })
    if (!r.ok || !String(r.content ?? '').trim()) {
      onEvent?.({ type: 'stage', phase: 'part', index: i + 1, total, failed: true })
      return { ok: false, error: `第 ${i + 1}/${total} 段整理失败：${r.error ?? '没返回正文'}` }
    }
    addReasoning?.(String(r.reasoning ?? '').length)
    const doc = parseSummaryDoc(r.content)
    parts.push({
      index: i + 1,
      title: doc.title,
      summary: doc.summary,
      sections: doc.sections,
      startLabel: mmss(chunk[0]?.start ?? 0),
      endLabel: mmss(chunk[chunk.length - 1]?.end ?? 0),
    })
    onEvent?.({ type: 'stage', phase: 'part', index: i + 1, total, title: doc.title })
  }

  setPhase('merge')
  onEvent?.({ type: 'stage', phase: 'merge', total })
  const mergedChars = parts.reduce(
    (n, part) =>
      n +
      String(part.summary ?? '').length +
      (part.sections ?? []).reduce((m, sec) => m + sec.items.join('').length, 0),
    0,
  )
  const r = await chatStreamGuarded(mergeMessages(parts), {
    tier: 'doc',
    chars: mergedChars,
    label: 'memo.merge',
    model: useModel,
    temperature: 0.3,
    timeout: 600_000,
    signal,
    onEvent: (evt) => {
      if (evt?.type === 'reasoning' && evt.text) addReasoning?.(String(evt.text).length)
    },
    onDelta: (delta) => {
      setPhase('writing')
      onEvent?.({ type: 'delta', text: delta })
    },
  })
  if (!r.ok || !String(r.content ?? '').trim()) {
    return { ok: false, error: r.error ?? '合并各段失败' }
  }
  return { ok: true, content: r.content, parts }
}

/**
 * 流式总结：边生成边 onEvent({type:'delta', text})，最后一次解析 + 落盘 + onEvent({type:'done'})。
 * 短稿一次调用；长稿走 summarizeLong（分段详析 → 合并），中途用 {type:'stage'} 报进度。
 */
export async function summarizeStream({ id, model, onEvent, signal } = {}) {
  const record = get(String(id ?? ''))
  if (!record) return { ok: false, error: `没有这条记录：${id ?? ''}` }
  if (!String(record.transcript ?? '').trim()) return { ok: false, error: '这条记录没有文字，没法总结' }

  const useModel = resolveModel(model)
  const isLong = Number(record.chars ?? 0) > LONG_THRESHOLD
  onEvent?.({
    type: 'start',
    id: record.id,
    model: useModel ?? loadConfig().ai?.model ?? '',
    mode: isLong ? 'chunked' : 'single',
    chunks: isLong ? chunkSegments(record.segments).length : 1,
  })

  let deltas = 0
  let reasoningChars = 0
  let phase = 'thinking'
  const startedAt = Date.now()
  // 心跳：长稿要几百秒，没有心跳页面就像卡死了
  const ticker = setInterval(() => {
    onEvent?.({
      type: 'tick',
      elapsedSec: Math.round((Date.now() - startedAt) / 1000),
      phase,
      reasoningChars,
    })
  }, 2000)
  ticker.unref?.()
  const setPhase = (next) => {
    phase = next
  }
  const addReasoning = (n) => {
    reasoningChars += Math.max(0, Number(n) || 0)
  }

  let content = ''
  let parts = null
  let error = null
  try {
    if (isLong) {
      const r = await summarizeLong(record, { useModel, signal, onEvent, setPhase, addReasoning })
      if (r.ok) {
        content = r.content
        parts = r.parts
      } else {
        error = r.error
      }
    } else {
      const r = await chatStreamGuarded(buildSummaryMessages(record), {
        tier: 'doc',
        chars: record.chars,
        label: 'memo.summary',
        model: useModel,
        temperature: 0.3,
        timeout: 300_000,
        signal,
        // 思考过程也转发：页面能显示「在想什么」，不是空等
        onEvent: (evt) => {
          if (evt?.type === 'reasoning' && evt.text) {
            addReasoning(String(evt.text).length)
            onEvent?.({ type: 'reasoning', text: evt.text, chars: reasoningChars })
          }
        },
        onDelta: (delta) => {
          setPhase('writing')
          deltas += 1
          onEvent?.({ type: 'delta', text: delta })
        },
      })
      if (!r.ok || !String(r.content ?? '').trim()) error = r.error ?? '模型没返回正文'
      else content = r.content
    }
  } catch (err) {
    error = err.message
  } finally {
    clearInterval(ticker)
  }

  if (error || !String(content ?? '').trim()) {
    const finalError = error ?? '模型没返回正文（输出预算可能被思考吃光）'
    console.warn(`[memo] summarize ${record.id} 失败：${finalError}`)
    onEvent?.({ type: 'error', error: finalError })
    return { ok: false, error: finalError }
  }

  applySummary(record, content)
  if (parts) record.parts = parts
  record.model = useModel ?? loadConfig().ai?.model ?? null
  const stored = persist(record)
  console.log(
    `[memo] summarize ${record.id} ok：${isLong ? `分段 ${parts?.length ?? 0} 段 + 合并` : `${deltas} 个 delta`}，正文 ${String(content).length} 字`,
  )
  onEvent?.({ type: 'done', id: stored.id, title: stored.title, record: brief(stored) })
  return { ok: true, record: brief(stored) }
}

const SECTION_TITLES = { points: '要点', todos: '待办', decisions: '决定', questions: '疑问' }

function sectionList(parsed) {
  const out = []
  for (const [key, title] of Object.entries(SECTION_TITLES)) {
    const value = parsed?.[key]
    if (!Array.isArray(value)) continue
    const items = value.map((item) => String(item ?? '').trim()).filter(Boolean)
    if (items.length) out.push({ key, title, items })
  }
  return out
}

/** 模型偶尔会包 ```json；也兼容前后带解释文字的情况 */
function parseSummaryJson(content) {
  const text = String(content ?? '').trim()
  const candidates = [text]
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) candidates.push(fenced[1].trim())
  const braced = text.match(/\{[\s\S]*\}/)
  if (braced) candidates.push(braced[0])
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      /* 试下一个 */
    }
  }
  return null
}

function fallbackTitle(transcript) {
  const clean = String(transcript ?? '').replace(/\s+/g, '')
  return clean.slice(0, 14) || ''
}

function slugify(text) {
  return (
    String(text ?? '')
      .replace(/[\\/:*?"<>|\s]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'memo'
  )
}

function stamp(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function clock(seconds) {
  const total = Math.max(0, Math.round(seconds))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/**
 * 一条记录 → 一份 Markdown 文档（页面上「摘要 / 各栏目 / 过程摘要 / 分段详析 / 转写原文」全在这里）。
 * 落盘那份（records/*.md）与页面「复制 / 导出 MD」共用它，别在前端再拼一份 —— 两边格式会走岔。
 */
export function markdown(record) {
  const lines = [`# ${record.title || '未命名随记'}`, '']
  lines.push(`- 时间：${stamp(record.startedAt)}（时长 ${clock(record.durationSec)}）`)
  lines.push(`- 字数：${record.chars}`)
  if (record.device) lines.push(`- 设备：${record.device}`)
  if (record.model) lines.push(`- 模型：${record.model}`)
  if ((record.tags ?? []).length) lines.push(`- 主题：${record.tags.join(' / ')}`)
  lines.push('')
  if (record.summary) lines.push('## 摘要', '', record.summary, '')
  for (const section of record.sections ?? []) {
    lines.push(`## ${section.title}`, '')
    for (const item of section.items) lines.push(`- ${item}`)
    lines.push('')
  }
  if ((record.liveSummaries ?? []).length) {
    lines.push('## 过程摘要', '')
    for (const live of record.liveSummaries) lines.push(`- 第 ${live.chars} 字处：${live.text}`)
    lines.push('')
  }
  if ((record.parts ?? []).length) {
    lines.push('## 分段详析', '')
    for (const part of record.parts) {
      const head = `### 第 ${part.index} 段（${part.startLabel}–${part.endLabel}）`
      lines.push(part.title ? `${head} ${part.title}` : head, '')
      if (part.summary) lines.push(part.summary, '')
      for (const sec of part.sections ?? []) {
        lines.push(`**${sec.title}**`, '')
        for (const item of sec.items ?? []) lines.push(`- ${item}`)
        lines.push('')
      }
    }
  }
  lines.push('## 转写原文', '')
  for (const segment of record.segments ?? []) {
    lines.push(`[${clock(segment.start)}-${clock(segment.end)}] ${segment.text}`)
  }
  return lines.join('\n') + '\n'
}

/** 页面「导出 MD」：文件名 + 全文（内容与 records/ 里那份同源，随时按当前记录现生成，不会是旧的） */
export function exportDoc(id) {
  const record = get(String(id ?? ''))
  if (!record) return { ok: false, error: `没有这条记录：${id ?? ''}` }
  const day = todayStr(new Date(record.startedAt || Date.now()))
  const name =
    String(record.title ?? '')
      .replace(/[\\/:*?"<>|\s]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'memo'
  return { ok: true, filename: `${day}-${name}.md`, content: markdown(record) }
}

function writeMarkdown(record) {
  try {
    fs.mkdirSync(RECORDS_DIR(), { recursive: true })
    if (!record.file) {
      const day = todayStr(new Date(record.startedAt))
      record.file = path.join(RECORDS_DIR(), `${day}-${slugify(record.title)}-${record.id.slice(-4)}.md`)
    }
    fs.writeFileSync(record.file, markdown(record), 'utf-8')
  } catch (err) {
    record.errors = [...(record.errors ?? []), { at: Date.now(), text: `写 md 失败：${err.message}` }]
  }
  return record
}

function persist(record) {
  const withFile = writeMarkdown(record)
  return put(withFile)
}

/** 对已存的记录重新总结（模型换了 / 想再压一次） */
export async function resummarize(id, { model } = {}) {
  const record = get(id)
  if (!record) return { ok: false, error: `没有这条记录：${id}` }
  const r = await summarizeRecord(record, { model })
  if (!r.ok) return r
  const stored = persist(record)
  return { ok: true, record: brief(stored), model: r.model, fallback: r.fallback ?? false }
}

/** 页面「环境」一栏用：这些目录在哪 */
export function dir() {
  return { data: MEMO_DIR(), records: RECORDS_DIR(), file: RECORDS_FILE(), inbox: INBOX_DIR(), jobs: JOBS_FILE() }
}
