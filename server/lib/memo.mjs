/**
 * 语音随记：给一段音频 → 转成文字 → 自动起标题写摘要 → 落成一条可回看的记录。
 *
 * 页面三个子页（`#/memo` 转写 / `#/memo/records` 记录 / `#/memo/settings` 配置）共用这一份服务端。
 *
 * 任务模型（**通用**，与转写后端无关）：
 *   ① start  起一个任务：音频落盘、置 running、立刻返回 jobId（不在请求里等转写）
 *   ② poll   看任务：`GET /api/memo/job?id=` 拿进度；转写完成后**顺手把总结也做掉**，
 *            结果里带上记录 id —— 页面只需要轮询这一个接口
 *   ③ done   任务结束后写 records.json 与 records/<日期>-<slug>.md
 *
 * 为什么是「起任务 + 轮询」而不是一个请求里等完：转写是分钟级的，
 * 而 Node 的默认 requestTimeout 是 5 分钟，长音频必被掐。
 *
 * 转写后端是一个可换的 provider 接口，见 server/lib/asr.mjs
 * （出厂只带一个实现：OpenAI 兼容的 /audio/transcriptions）。这里不关心它是本机还是云端，
 * 也不依赖任何第三方客户端的私有接口 —— 换实现就是换 asr.baseUrl。
 *
 * 数据落 server/data/memo/：
 *   records.json             记录索引（createJsonStore，原子写 + .bak + 按天快照）
 *   records/<日期>-<slug>.md 单条记录的可读正文（摘要 + 原文）
 *   audio/                   上传进来的原始音频（转写完不删，留着回放/重跑；
 *                            转写失败的那份也留在原地，记录里没挂上，可以手动清）
 *   hotwords.json            热词库：分类 → 词（词 + 常见错写别名），见 hotwords.mjs
 *   jobs.json                任务快照（边车重启后把死掉的 running 标 interrupted）
 *
 * 音频与正文是两处文件，别混：`record.file` 永远是 **md 正文**，`record.audio.file` 才是音频。
 * 混过一次的后果是用「md 的路径」去喂 <audio>（也可回放接口读不到文件）。
 *
 * 边界：不做录屏；不自动入知识库（页面给「复制 / 导出 Markdown」）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, dataDir, saveConfig } from '../config.mjs'
import * as hotwords from './hotwords.mjs'
import { createJsonStore, todayStr } from './jsonstore.mjs'
import { aiModels } from './newapi.mjs'
import { chatGuarded, chatStreamGuarded } from './llm.mjs'
import * as asr from './asr.mjs'

const MEMO_DIR = () => path.join(dataDir(), 'memo')
const RECORDS_DIR = () => path.join(MEMO_DIR(), 'records')
const RECORDS_FILE = () => path.join(MEMO_DIR(), 'records.json')
/** 上传进来的原始音频都放这儿（按「时间戳-原文件名」命名，路径记在记录的 audio.file 上） */
const AUDIO_DIR = () => path.join(MEMO_DIR(), 'audio')
const JOBS_FILE = () => path.join(MEMO_DIR(), 'jobs.json')

/** 记录库最多留这么多条（旧的连同 md、音频一起清掉） */
const KEEP_RECORDS = 300
/** 内存里保留的任务条数（轮询用；落盘的那份只为「重启后对账」） */
const KEEP_JOBS = 50

/* ------------------------------------------------------------------ 设置 --- */

const SETTINGS_FILE = () => path.join(MEMO_DIR(), 'settings.json')

/** 页面选项：总结模型 / 自定义提示词 / 记录类型 / 默认热词分类 / 自动学新词 */
function settings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf-8'))
    // 保留整包（prompts 等）——只挑 model 出去会把别的键在写回时丢掉
    return {
      ...(raw && typeof raw === 'object' ? raw : {}),
      model: typeof raw?.model === 'string' ? raw.model : '',
      type: raw?.type === 'interview' ? 'interview' : 'oral',
      hotwordCategories: Array.isArray(raw?.hotwordCategories) ? raw.hotwordCategories.map(String) : [],
      autoHotwords: raw?.autoHotwords !== false,
    }
  } catch {
    return { model: '', type: 'oral', hotwordCategories: [], autoHotwords: true }
  }
}

// 词库空的时候先铺几个起步分类，否则开局一个可用的词都没有
hotwords.ensureSeeded()

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

/** 记录类型 / 默认热词分类 / 自动学词 —— 页面上的几个开关 */
export function options() {
  const s = settings()
  return { type: s.type, hotwordCategories: s.hotwordCategories, autoHotwords: s.autoHotwords }
}

export function setOptions(patch = {}) {
  const s = settings()
  const next = { ...s }
  if ('type' in patch) next.type = patch.type === 'interview' ? 'interview' : 'oral'
  if ('hotwordCategories' in patch) {
    next.hotwordCategories = (Array.isArray(patch.hotwordCategories) ? patch.hotwordCategories : [])
      .map((x) => String(x ?? '').trim())
      .filter(Boolean)
      .slice(0, 8)
  }
  if ('autoHotwords' in patch) next.autoHotwords = patch.autoHotwords !== false
  writeSettings(next)
  return { ok: true, options: options() }
}

/** 一次整理要用的词表：页面选定的分类（空 = 全部，让模型自己挑） */
function activeTerms(refs) {
  const wanted = (refs ?? []).filter(Boolean)
  if (!wanted.length) return hotwords.termsOf(hotwords.list().categories.map((cat) => cat.id))
  return hotwords.termsOf(wanted)
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
  // 音频文件可能被手动删掉（或换过盘）：报给页面前先核一遍在不在，
  // 不然记录列表上带着 ♪、点开播放器却 404
  const audio = record.audio?.file && fs.existsSync(record.audio.file) ? record.audio : null
  return {
    id: record.id,
    title: record.title,
    summary: record.summary,
    chars: record.chars,
    /** 音频时长（秒）：只有能从文件头算出来的时候才有，否则 null —— 页面按「未知」显示 */
    durationSec: record.durationSec ?? null,
    /** 转写本身花了多久（毫秒）—— 别把它当时长用，那是两件事 */
    asrMs: record.asrMs ?? null,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    device: record.device,
    model: record.model ?? null,
    type: record.type ?? 'oral',
    tags: record.tags ?? [],
    categoryId: record.categoryId ?? '',
    categoryName: record.categoryName ?? '',
    sections: (record.sections ?? []).map((s) => ({ key: s.key, title: s.title, items: s.items?.length ?? 0 })),
    stageSummaries: (record.liveSummaries ?? []).length,
    parts: (record.parts ?? []).length,
    hotwords: record.hotwords ?? [],
    newTerms: record.newTerms ?? [],
    /** 有原始音频才能回放（见 streamAudio）。只下发名字与体积，绝对路径不出边车 */
    audio: audio ? { bytes: audio.bytes, seconds: audio.seconds ?? null, name: audio.name ?? '' } : null,
  }
}

/** 记录上「用了哪些热词 / 学到哪些新词」两行摘要（页面与 Markdown 共用） */
function hotwordLine(record) {
  const used = (record.hotwords ?? []).map((x) => x.term).filter(Boolean)
  const fresh = (record.newTerms ?? []).map((x) => x.term ?? x).filter(Boolean)
  return { used, fresh }
}

export function list({ limit = 50 } = {}) {
  return store.read().records.slice(0, Math.max(1, Math.min(Number(limit) || 50, KEEP_RECORDS))).map(brief)
}

export function get(id) {
  const record = store.read().records.find((item) => item.id === id)
  return record ?? null
}

/** 删一条记录留在这台机器上的两个文件（md 正文 + 原始音频）；不在了就当删过了 */
function deleteRecordFiles(record) {
  for (const file of [record?.file, record?.audio?.file]) {
    if (!file) continue
    try {
      fs.unlinkSync(file)
    } catch {
      /* 文件不在了就算了 */
    }
  }
}

function put(record) {
  const data = store.read()
  const rest = data.records.filter((item) => item.id !== record.id)
  const next = { ...data, records: [record, ...rest].slice(0, KEEP_RECORDS) }
  // 索引裁掉的那些记录：正文与音频也一起删，否则磁盘只涨不降
  const kept = new Set(next.records.map((item) => item.id))
  for (const item of data.records) {
    if (kept.has(item.id)) continue
    deleteRecordFiles(item)
  }
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
  // 正文与音频跟着一起走：留个孤儿音频只会白占磁盘
  deleteRecordFiles(record)
  return { ok: true, removed: id }
}

/* ------------------------------------------------------------ 转写后端 --- */

/**
 * 转写后端状态（透传 asr.mjs）：页面据此决定显示引导还是操作区。
 *
 * 顺带把「当前值」也带上（`timeoutSec` + 密钥末四位），配置页那一块要用；
 * **明文密钥永远不下发** —— 页面能拿到就等于它进了浏览器历史、缓存、截图。
 * 这样 `GET /api/memo/asr` 一条就够读写两端都用，不必再加一个「读配置」的口。
 */
export function asrStatus() {
  const c = asr.conf()
  return {
    ...asr.status(),
    audioExt: [...asr.AUDIO_EXT],
    timeoutSec: c.timeoutSec,
    keyHint: c.apiKey ? `****${c.apiKey.slice(-4)}` : '',
  }
}

/** provider 就这两个值：openai = 走 OpenAI 兼容接口；none = 关掉转写（模块从侧边栏消失） */
const ASR_PROVIDERS = new Set(['openai', 'none'])

/**
 * 写转写后端配置（配置页 → 转写后端）。
 *
 * 为什么不让页面直接 `PATCH /api/config`：那一套只放行 DEFAULTS 里声明过的子字段，
 * 而 **asr.apiKey 不在 DEFAULTS 里**（它是敏感项，按 SECRET_PATHS 落 credentials.json）。
 * 密钥要能在页面上改，就得由模块自己收下来。写入仍然走 config.mjs 的 saveConfig ——
 * 脱敏串与空串会被它挡掉（避免「保存一次就把密钥清空」），落盘位置也还是那一套。
 */
export function setAsrBackend(patch = {}) {
  const next = {}
  if ('provider' in patch) {
    const p = String(patch.provider ?? '').trim() || 'openai'
    if (!ASR_PROVIDERS.has(p)) return { ok: false, error: `provider 只认 ${[...ASR_PROVIDERS].join(' / ')}` }
    next.provider = p
  }
  if ('baseUrl' in patch) {
    // 末尾的斜杠去掉：asr.mjs 会自己拼 `/audio/transcriptions`，多一条斜杠就是 404
    next.baseUrl = String(patch.baseUrl ?? '').trim().replace(/\/+$/, '')
  }
  if ('model' in patch) next.model = String(patch.model ?? '').trim()
  if ('language' in patch) next.language = String(patch.language ?? '').trim()
  if ('timeoutSec' in patch) next.timeoutSec = Math.max(30, Number(patch.timeoutSec) || 600)
  if ('apiKey' in patch) {
    const key = String(patch.apiKey ?? '').trim()
    // 留空 = 不改（要清掉就去 credentials.json 删 asr.apiKey）；脱敏串也不许覆盖真值
    if (key && !key.startsWith('****')) next.apiKey = key
  }
  if (!Object.keys(next).length) return { ok: false, error: '没有要改的字段' }
  const r = saveConfig({ asr: next })
  if (r && r.ok === false) return { ok: false, error: r.error ?? '保存失败' }
  return { ok: true, saved: Object.keys(next), ...asrStatus() }
}

/**
 * 把浏览器传上来的音频落盘到 `data/memo/audio/`。
 *
 * 文件名做一次清洗：只留基名、去掉路径分隔与可疑字符，避免 `../` 跑到目录外面；
 * 前面再缀一个时间戳，同名的两次上传才不会互相覆盖。返回绝对路径（起任务时按它转写）。
 */
export function stashUploadedAudio(name, buffer) {
  const safe = String(name || '')
    .replace(/[\\/]+/g, '_')
    .replace(/[\x00-\x1f<>:"|?*]/g, '')
    .trim()
  const base = safe || `audio-${Date.now().toString(36)}`
  const withName = path.extname(base) ? base : `${base}.wav`
  const dir = AUDIO_DIR()
  fs.mkdirSync(dir, { recursive: true })
  const abs = path.join(dir, `${Date.now().toString(36)}-${withName}`)
  fs.writeFileSync(abs, buffer)
  return abs
}

/**
 * 从 WAV 头里读时长（秒）；读不出来返回 null。
 *
 * 为什么只认 WAV：其它格式（mp3 / m4a / …）要算时长就得真解码，为一行元数据装个解码器不值得 ——
 * 页面那边的播放器会从 `<audio>` 的元数据里拿到真实时长，这里只是让列表与 Markdown 先有个数。
 * 偏移量按标准 PCM 头写：12 = "fmt "、28 = byteRate、44 = data 起点。
 */
function wavSeconds(file) {
  let fd
  try {
    const size = fs.statSync(file).size
    if (size < 44) return null
    fd = fs.openSync(file, 'r')
    const head = Buffer.alloc(44)
    if (fs.readSync(fd, head, 0, 44, 0) < 44) return null
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return null
    const byteRate = head.readUInt32LE(28)
    if (!byteRate) return null
    return Math.round(((size - 44) / byteRate) * 10) / 10
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* 关不上就算了 */
      }
    }
  }
}

/** 音频挂到记录上的形状：{file, name, bytes, seconds}。name 供页面显示/下载用 */
function audioMeta(file, name) {
  return {
    file,
    name: String(name || path.basename(file)),
    bytes: fs.statSync(file).size,
    seconds: wavSeconds(file),
  }
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
 * 起一个转写任务。立刻返回 jobId，转写在后台跑（转完顺手做总结、落成一条记录）。
 *
 * @param {{ path: string, name?: string, source?: string, type?: string, category?: string, focus?: string }} opts
 *   path     = 音频文件（先用 POST /api/memo/upload 传上来，或自己放一个到 data/memo/audio/）
 *   type     = 'interview' 走访谈骨架，其余（含不传）按设置里的默认类型
 *   category = 热词分类名/id：定了就只用这一类的词表，不定则用设置里的默认分类
 *   focus    = 这次想理清的重点 / 访谈提纲（成稿时做「问题对照」）
 */
export function startTranscribe({ path: file, name, source = 'web', type, category, focus } = {}) {
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
    /** 这次按什么类型整理（口述/访谈）与想理清的重点，转写完成后一起交给整理那一步 */
    type: type === 'interview' ? 'interview' : undefined,
    category: String(category ?? '').trim() || undefined,
    focus: String(focus ?? '').slice(0, 2000),
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

/**
 * 跑完一个任务：转写 → 落成记录（顺带做总结）。
 *
 * 失败时**不删音频**：那份还躺在 data/memo/audio/ 里，任务上只留 error（没落成记录），
 * 页面据此提示重试；用户也可以在配置页的「存储」里看到它占的体积。
 */
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

  const opts = settings()
  const picked = job.category ? hotwords.findCategory(job.category) : null
  const base = activeTerms(picked ? [picked.id] : opts.hotwordCategories)
  /**
   * 上传进来的那份音频挂到记录上（转写完**不删**：页面要回放、要重跑都靠它）。
   * 转写后端只回整篇文字、没有段级时间戳，所以 `segments` 空着 —— 有没有它都不影响成稿，
   * 见 finalTranscript()：拿不到时间轴就用整篇文本。
   */
  let audio = null
  try {
    audio = audioMeta(job.file, job.name)
  } catch (err) {
    console.warn(`[memo] 读不到音频元信息（不影响转写）：${err.message}`)
  }
  const record = {
    id: job.id,
    title: '',
    summary: '',
    sections: [],
    transcript: r.text,
    /** 转写后端不给段级时间戳（asr.mjs 只要正文），时间轴这一栏就永远是空的 */
    segments: [],
    chars: r.text.length,
    startedAt: job.startedAt,
    endedAt: Date.now(),
    /** 音频自己的时长（不是这次处理花了多久）；算不出来就是 null */
    durationSec: audio?.seconds ?? null,
    device: null,
    source: job.source,
    /** 正文路径由 writeMarkdown 落成 records/<日期>-<slug>.md；音频在 audio/，别混 */
    file: '',
    audio,
    asrMs: job.asrMs,
    errors: [],
    liveSummary: '',
    liveSummaries: [],
    model: null,
    type: job.type === 'interview' ? 'interview' : opts.type,
    /** 这次想理清的重点 / 访谈提纲（可空），成稿时用来做「问题对照」 */
    focus: String(job.focus ?? '').slice(0, 2000),
    categoryId: picked?.id ?? '',
    categoryName: picked?.name ?? '',
    suggestedCategories: [],
    /** 这次用的词表快照：纠错、命中与自动学词都以它为准 */
    hotwordTerms: base.terms,
    hotwords: [],
    newTerms: [],
  }

  try {
    if (record.transcript.trim().length >= 8) {
      const s = await summarizeRecord(record)
      // 总结失败（模型没配、超时、上游 504）不该把转写结果一起丢掉：
      // 标题退回原文开头，失败原因留在记录里 —— 页面上能看到「这条为什么只有原文」，
      // 也能自己点「重新总结」再试一次
      if (!s.ok) {
        record.title = record.title || fallbackTitle(record.transcript) || '未命名随记'
        record.errors = [
          { at: Date.now(), text: `自动总结失败：${s.error ?? '未知原因'}（可在「记录」页点「重新总结」再试）` },
        ]
      }
    } else {
      record.title = fallbackTitle(record.transcript) || '未命名随记'
      record.summary = ''
    }
  } catch (err) {
    // 抛出来的那条路径（网络层炸了之类）跟上面一样处理
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

/**
 * 没有段级时间戳时，按句子把整篇文本切块（`start/end` 一律 null）。
 *
 * 为什么要这条兜底：转写后端只回整篇正文（OpenAI 兼容的 /audio/transcriptions 就是这样），
 * `record.segments` 是空的 —— 早先长稿路径直接 `chunkSegments(record.segments)`，
 * 于是**任何超过 LONG_THRESHOLD 的音频都报「没有可用的转写分段」，一句总结都出不来**。
 * 切块只需要字数，不需要时间码：宁可少一个时间轴栏目，也不能整条总结不出来。
 */
function chunkText(text, limit = CHUNK_CHARS) {
  const body = String(text ?? '').trim()
  if (!body) return []
  // 先按句末标点与换行切开，再按 limit 攒块；单句就超长的（无标点的长串）硬切
  const pieces = body.split(/(?<=[。！？!?；;\n])/)
  const chunks = []
  let buf = ''
  const flush = () => {
    if (buf.trim()) chunks.push([{ start: null, end: null, text: buf.trim() }])
    buf = ''
  }
  for (const piece of pieces) {
    if (piece.length > limit) {
      flush()
      for (let i = 0; i < piece.length; i += limit) {
        const part = piece.slice(i, i + limit).trim()
        if (part) chunks.push([{ start: null, end: null, text: part }])
      }
      continue
    }
    if (buf && buf.length + piece.length > limit) flush()
    buf += piece
  }
  flush()
  return chunks
}

/** 长稿要切的块：优先用段级时间戳，没有就用整篇文本（见 chunkText 的注释） */
function recordChunks(record) {
  const segs = (record.segments ?? []).filter((s) => String(s?.text ?? '').trim())
  if (segs.length) return chunkSegments(segs)
  return chunkText(record.transcript)
}

/** 块的首尾时间码：没有时间戳（上传式转写）时给空串，别写 00:00 假装有时间轴 */
function chunkRange(chunk) {
  const first = chunk?.[0]?.start
  const last = chunk?.[chunk.length - 1]?.end
  if (!Number.isFinite(Number(first)) || first === null) return { startLabel: '', endLabel: '' }
  return { startLabel: mmss(first), endLabel: mmss(last ?? first) }
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
    transcript: hotwords.applyAliases(timelineOf(chunk), recordTerms(record)).text,
    plain: chunk.map((seg) => String(seg.text ?? '').trim()).join('\n'),
    process: '',
    duration: record.durationSec ? humanLen(record.durationSec) : '未知',
    chars: String(record.chars ?? ''),
    hotwords: hotwords.promptBlock(recordTerms(record)),
    categories: hotwords.list().categories.map((c) => c.name).join('、'),
    focus: String(record.focus ?? '').trim(),
    type: record.type === 'interview' ? '访谈' : '口述',
  }
  const preamble =
    `（注意：这是同一份记录的第 ${index}/${total} 段，前后还有别的内容；` +
    '**只整理这一段**，把这一段的细节尽量写全，整份总稿会由各段整理合并而成。）\n\n'
  return [
    { role: 'system', content: record.type === 'interview' ? p.interviewSystem : p.summarySystem },
    {
      role: 'user',
      content: preamble + renderPrompt(record.type === 'interview' ? p.interviewUser : p.summaryUser, values),
    },
  ]
}

/** 合并那一轮的提示词：输入是各段整理结果，不是原文 */
function mergeMessages(parts) {
  const body = parts
    .map((part, i) => {
      const sections = (part.sections ?? [])
        .map((sec) => [`### ${sec.title}`, ...sec.items.map((item) => `- ${item}`)].join('\n'))
        .join('\n')
      // 有时间码就带上（模型合并时能排时间轴），没有就只写「第 N 段」
      const range = part.startLabel && part.endLabel ? `（${part.startLabel}~${part.endLabel}）` : ''
      return [`## 第 ${i + 1} 段${range}`, sections || part.summary].join('\n')
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
 * 默认提示词模板（配置页「提示词」弹窗可改；`{{transcript}}` 会被替换成转写原文）。
 * 两套骨架各两段，是有意的：系统那段管「怎么对待这份转写」，用户那段管「输出什么形状」——
 * 口述要的是复盘清单（决定 / 待办 / 风险），访谈要的是逐字稿纪律（原话、编码、待追问）。
 * 长稿（> LONG_THRESHOLD 字）的分段详析复用同一套模板，前面加一句「这是第 i/n 段」；
 * 合并那一轮用的是模块内的 MERGE_INSTRUCTION（它要的是跨段总览，跟单段那两段不是一回事）。
 */
export const DEFAULT_PROMPTS = {
  summarySystem:
    '你在整理用户的口述记录（多半是他自己讲研究思路、设计或复盘的录音）。原文是语音转写，' +
    '可能有同音字/错别字、缺标点、句子断裂——按上下文纠正明显错误（热词表里给了就该用表里的写法），' +
    '但**不要增补原文没有的信息**。\n' +
    '这份整理的用途是**当材料反复看**：宁可多留信息点，也不要压成空泛的概括；' +
    '**详细程度要跟着内容体量走**——几分钟的闲聊几句就够，十分钟以上的正经讲述必须分条展开、' +
    '把讲过的每个决定、数字、待办都留下来。不要 emoji，不要空话，不要「总之」「综上」这类填充。',
  summaryUser:
    '这是一次口述：时长 {{duration}}，转写 {{chars}} 字。\n\n' +
    '【热词表】——遇到表里的错写就改成表里的正名（这一条优先于你自己猜的同音字）；' +
    '标签也优先从表里挑：\n{{hotwords}}\n\n' +
    '【分类候选】{{categories}}（在「分类」栏里挑一个最贴的；都不合适就写「新建：<名字>」）\n\n' +
    '【这次想理清的重点（可能没填）】{{focus}}\n\n' +
    '【转写原文】\n{{transcript}}\n\n' +
    '【转写过程中的阶段摘要】（可当作叙事线索，但**不完整**，缺失处以转写为准）\n{{process}}\n\n' +
    '请输出一份 Markdown 整理稿，按下面的骨架（**栏目名照抄**，不适合内容的栏目整段略去，' +
    '不要写「无」「略」）：\n\n' +
    '# 标题\n' +
    '（≤ 16 字，点明这份记录是什么，例如「会议口述：需求梳理」）\n\n' +
    '## 摘要\n' +
    '**3-6 句连贯的段落**（不要用列表、不要压成一句）：先说这段口述在讲什么、分几块讲的，' +
    '再给结论或走向。这一段要能**单独拿出来读懂**，别写成「本文记录了一次口述」这种空话。\n\n' +
    '## 标签\n' +
    '3-6 个，每个 ≤ 6 字：**优先用热词表里的词**，表里没有合适的才自己写。' +
    '要的是主题词/关键词（例如「需求」「方案」「流程」），' +
    '**不要**写「摘要」「要点」「待办」这类结构词，也不要带数字或条目数；一行一个，不要解释。\n\n' +
    '## 分类\n' +
    '一个分类名（从上面的候选里挑），或「新建：<名字>」。\n\n' +
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
    '一行一个，写成「正名 ← 转写里的错写」（只列你有把握的），把本文出现的专名/术语对齐成一套写法，' +
    '方便以后检索；顺带一句话解释它在本文里指什么。\n\n' +
    '## 时间轴\n' +
    '- [mm:ss] 关键点（回听用，只挑真正重要的 5~12 个时间点）\n\n' +
    '要求：**只写原文里有的东西**；不确定的地方标注「（听不清）」，不要猜；' +
    '不要输出 JSON、不要代码块、不要解释你在做什么、不要在开头加「好的」。',

  interviewSystem:
    '你在整理一份**访谈录音**的逐字稿（清洁逐字档：只去无意义的「呃/那个」，保留所有表达确定程度的词）。\n' +
    '六条纪律：\n' +
    '① 关键引语必须是**受访者原话**——只能修明显错别字与标点，不许换词、不许润色、不许把话理顺；\n' +
    '② 「可能/一般/大概/我不太确定/看情况」是**证据**（说明他有多确定），不是口癖，一律保留；否定与自我更正（「不是 A，是 B」）保留更正后的说法；\n' +
    '③ 严格区分「他说的」与「你的判断」：判断只写进「初步解读」栏，每条标 [推断] 并给置信度（高/中/低）+ 一条替代解释；\n' +
    '④ 转写**没有说话人分离**：分不清谁说的就整段转述或标「（说话人不明）」，**绝不编造说话人身份**；\n' +
    '⑤ 听不清标「（听不清）」，不确定的专名保持原样标「（待确认）」，数字/单位/日期原样——**绝不补全**；\n' +
    '⑥ 隐私：不写真实姓名、单位、联系方式这类可识别信息，用「受访者」「老师 A」这样的代号。',
  interviewUser:
    '这是一次访谈：时长 {{duration}}，转写 {{chars}} 字，记录类型：{{type}}。\n\n' +
    '【热词表】——遇到表里的错写就改成表里的正名（优先于你自己猜的同音字）：\n{{hotwords}}\n\n' +
    '【分类候选】{{categories}}\n\n' +
    '【研究问题 / 访谈提纲（可能没填）】\n{{focus}}\n\n' +
    '【转写原文】\n{{transcript}}\n\n' +
    '【转写过程中的阶段摘要】（不完整，缺失处以转写为准）\n{{process}}\n\n' +
    '输出 Markdown 访谈整理稿（**栏目名照抄**，没有内容的整段略去，不要写「无」「略」）：\n\n' +
    '# 标题（≤ 16 字：谁 + 谈了什么）\n\n' +
    '## 摘要（3-6 句连贯段落：谈了哪几块、核心主张是什么、有没有结论）\n\n' +
    '## 标签（3-6 个，每个 ≤ 6 字，优先用热词表里的词，一行一个）\n\n' +
    '## 分类（一个分类名，或「新建：<名字>」）\n\n' +
    '## 受访者与场景\n' +
    '- 受访者自述的身份/背景（原话口径；没说明就写「未说明」）、访谈方式、录制时长、在场人员\n\n' +
    '## 研究问题对照\n' +
    '- 问题/主题 → 答得怎么样（说清楚了 / 只提一句 / 没答 / 被岔开）；上面没给提纲就按「他主动展开的话题」列\n\n' +
    '## 关键引语\n' +
    '- [mm:ss]「原话」—— 为什么重要（一句说明，和引语分开写）\n' +
    '（挑 3-8 条真有信息量或情绪强度的；引语里允许带「（笑）」「（停顿）」这类现场标注；引语内部一个字都不要改）\n\n' +
    '## 主题与编码\n' +
    '- 主题：<主题名> —— 支撑：受访者原意（不要替他下结论）；出现：他在哪个问题下提到、本访谈内主动提了几次、语气强弱\n' +
    '（3-6 条；一条一个主题，主题要能回答「他为什么这么想」，不是「他提到了什么」的话题桶）\n\n' +
    '## 讲了什么（按叙述顺序的主线，5-15 条，一条一个信息点）\n\n' +
    '## 矛盾与张力\n' +
    '- 前后不一致、含糊回避、被追问后改口、情绪明显的地方（**保留矛盾，不要替他调和**；写清在哪一段）\n\n' +
    '## 待追问 / 空白\n' +
    '- 下次要问清的问题（他没展开、听出没说完、需要举例的点）；分不清的专名也列这里\n\n' +
    '## 初步解读\n' +
    '- [推断·置信度] 解释与假设 + 一条替代解释（必须能指回上面的材料；没把握就整段略去）\n\n' +
    '## 术语与专名\n' +
    '- 正名 ← 转写里的错写（对齐专名，方便以后检索）\n\n' +
    '## 时间轴\n' +
    '- [mm:ss] 关键点（5~15 个，回听用）\n\n' +
    '只写材料里有的东西；不要输出 JSON 或代码块。\n' +
    '提醒：访谈是**证据**不是素材——会议纪要那套「替人总结成决定和待办」的写法会把研究价值洗掉，别那么写。',
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
  const table = {
    transcript: values.transcript ?? '',
    plain: values.plain ?? '',
    process: values.process || '（暂无）',
    duration: values.duration ?? '',
    chars: values.chars ?? '',
    hotwords: values.hotwords || '（还没有热词）',
    categories: values.categories || '（还没建分类）',
    focus: values.focus || '（没填：按内容自己判断）',
    type: values.type || '口述',
  }
  return String(template).replace(/\{\{\s*([a-z]+)\s*\}\}/g, (whole, key) => (key in table ? table[key] : whole))
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
  const lines = (segments ?? []).map((seg) => {
    const text = String(seg.text ?? '').trim()
    // 没有时间戳的块（上传式转写按句子切出来的）不挂 `[00:00]`：
    // 那会让模型以为全文都发生在 0 秒，进而编出一串假时间码
    if (seg.start === null || seg.start === undefined || !Number.isFinite(Number(seg.start))) return text
    return `[${mmss(seg.start)}] ${text}`
  })
  const text = lines.join('\n')
  return text.length > limit ? text.slice(-limit) : text
}

/** 这条记录该用哪套词表：记录里存的快照优先，没有就按分类现取 */
function recordTerms(record) {
  if (Array.isArray(record.hotwordTerms) && record.hotwordTerms.length) return record.hotwordTerms
  if (record.categoryId) return hotwords.termsOf([record.categoryId]).terms
  return []
}

/**
 * 整理时的取材：能拿到逐段时间轴就用时间轴，拿不到就用整篇文本
 * （不是所有转写后端都返回段级时间戳）；两种情况都先按热词表做一遍本地纠错。
 */
function finalTranscript(record) {
  const terms = recordTerms(record)
  const timeline = timelineOf(record.segments)
  const body = timeline || String(record.transcript ?? '').slice(-12_000)
  return hotwords.applyAliases(body, terms).text
}

/** 一次总结的取材（占位符替换用） */
function promptValues(record) {
  const process = (record.liveSummaries ?? [])
    .map((item, i) => `${i + 1}. ${String(item.text ?? '').trim()}`)
    .join('\n')
  const terms = recordTerms(record)
  return {
    transcript: finalTranscript(record),
    plain: String(record.transcript ?? '').slice(-12_000),
    process,
    // 时长是从音频文件头里读的（上传的 mp3/m4a 读不到）——读不到就写「未知」，
    // 别把「0 秒」交给模型，那会让摘要里出现一句莫名其妙的时长
    duration: record.durationSec ? humanLen(record.durationSec) : '未知',
    chars: String(record.chars ?? String(record.transcript ?? '').length),
    hotwords: hotwords.promptBlock(terms),
    categories: hotwords.list().categories.map((c) => c.name).join('、'),
    focus: String(record.focus ?? '').trim(),
    type: record.type === 'interview' ? '访谈' : '口述',
  }
}


/** 总结用的两条消息（system 管态度、user 管形状）；访谈与口述各一套骨架 */
function buildSummaryMessages(record) {
  const p = activePrompts()
  const values = promptValues(record)
  const interview = record.type === 'interview'
  return [
    { role: 'system', content: interview ? p.interviewSystem : p.summarySystem },
    { role: 'user', content: renderPrompt(interview ? p.interviewUser : p.summaryUser, values) },
  ]
}

/* --------------------------------------------------- 热词：命中、自学、标签 --- */

/** 命中重算：词表里的词在这篇里出现过就算命中 */
function refreshHits(record) {
  const terms = recordTerms(record)
  if (!terms.length) {
    record.hotwords = record.hotwords ?? []
    return record.hotwords
  }
  const text = `${record.transcript ?? ''}`
  record.hotwords = terms
    .filter((t) => t.term && text.includes(t.term))
    .map((t) => ({ term: t.term, categoryId: record.categoryId ?? '', categoryName: record.categoryName ?? '' }))
  return record.hotwords
}

/**
 * 词表落地：命中记账 + 新词进分类。不额外调模型 —— 材料就是总稿里的「术语与专名」栏、标签与转写原文。
 *
 * 过滤故意严：模型会把「本段未出现热词表内任何专名」这种整句当术语交上来，
 * 所以要求词形像词（长度、无句子标点与虚词）**并且**（词或它的别名）在原文里真出现过。
 */
export function learnHotwords(record) {
  refreshHits(record)
  const used = (record.hotwords ?? []).map((x) => x.term ?? x).filter(Boolean)
  if (settings().autoHotwords === false) {
    if (used.length) hotwords.recordHits(used)
    return { added: [], used }
  }

  const known = new Set()
  for (const cat of hotwords.list().categories) for (const t of cat.terms) known.add(t.term)
  const text = String(record.transcript ?? '')
  const seenInText = (word) => {
    const w = String(word ?? '').trim()
    return w.length >= 2 && text.includes(w)
  }
  const looksLikeTerm = (word) => {
    const w = String(word ?? '').trim()
    if (w.length < 2 || w.length > 16) return false
    if (/[，。；：！？、,.;:!?（）()「」【】\s]/.test(w)) return false
    // 带虚词的基本是句子不是词（「本段未出现热词表内任何专名」这类）
    return !/[的了吗呢吧啊把被就是都还也而且]/i.test(w)
  }
  const items = []
  const push = (item, { requireInText = true } = {}) => {
    const term = String(item?.term ?? '').trim()
    if (!looksLikeTerm(term) || known.has(term)) return
    if (items.some((x) => x.term === term)) return
    if (requireInText && !seenInText(term) && !(item.aliases ?? []).some(seenInText)) return
    items.push({ term, aliases: item.aliases ?? [] })
  }
  // ① 总稿「术语与专名」栏最准：正名 ← 错写（要求至少一边在原文里出现过）
  for (const sec of record.sections ?? []) {
    if (!/术语|专名/.test(String(sec.title ?? ''))) continue
    for (const line of sec.items ?? []) push(parseTermLine(line) ?? {})
  }
  // ② 之前认到过的词：换过分类之后再「学热词」，它们要被收进新分类（不然只能重录一遍）
  for (const item of record.newTerms ?? []) push(item)
  // ③ 标签：主题词本来就可能不逐字出现在原文里（例如「先试一下」写成了别的说法），只做形状检查
  for (const tag of record.tags ?? []) push({ term: tag }, { requireInText: false })

  if (!items.length) {
    if (used.length) hotwords.recordHits(used)
    return { added: [], used }
  }
  const target = record.categoryId || ensureFallbackCategory()
  const r = hotwords.addTerms(target, items, 'auto')
  if (!r.ok) return { added: [], used, error: r.error }
  const cat = hotwords.list().categories.find((c) => c.id === target)
  record.categoryId = record.categoryId || target
  record.categoryName = record.categoryName || cat?.name || ''
  record.newTerms = items.map((x) => ({ term: x.term, aliases: x.aliases, categoryId: target, categoryName: cat?.name ?? '' }))
  for (const item of record.newTerms) if (text.includes(item.term)) record.hotwords.push(item)
  hotwords.recordHits(record.hotwords.map((x) => x.term))
  return { added: record.newTerms, used, categoryName: cat?.name ?? '' }
}

/** 没有分类的记录：新词先进「未分类」，页面里能再挪走 */
function ensureFallbackCategory() {
  const found = hotwords.findCategory('未分类')
  if (found) return found.id
  const created = hotwords.addCategory({ name: '未分类', note: '还没归类的记录自动落这里' })
  return created.ok ? created.category?.id ?? '' : ''
}

/** 总稿里认到的分类：命中已有分类就认领；写着「新建：X」才真的建一个 */
function resolveRecordCategory(record) {
  const want = String(record.detectedCategory ?? '').trim()
  if (!want || record.categoryId) return
  const name = want.replace(/^新建[:：]\s*/, '').replace(/[。，,．]$/, '').trim().slice(0, 24)
  if (!name) return
  const existing = hotwords.findCategory(name)
  if (existing) {
    record.categoryId = existing.id
    record.categoryName = existing.name
    return
  }
  if (!/^新建[:：]/.test(want)) {
    record.suggestedCategories = [...new Set([...(record.suggestedCategories ?? []), name])]
    return
  }
  const created = hotwords.addCategory({ name, note: '整理时自动建的分类' })
  if (created.ok) {
    record.categoryId = created.category?.id ?? ''
    record.categoryName = name
  } else {
    record.suggestedCategories = [...new Set([...(record.suggestedCategories ?? []), name])]
  }
}

function cleanTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags ?? '').split(/[、,，;；/|]/)
  return [
    ...new Set(
      list
        .map((t) => String(t ?? '').trim().replace(/\s+/g, ' ').slice(0, 12))
        .filter(Boolean),
    ),
  ].slice(0, MAX_TAGS)
}

/** 记录的标签：页面直接改（去重、限长）；toHotwords=true 时顺手把标签收进热词库 */
export function setTags(id, tags = [], { toHotwords = false } = {}) {
  const record = get(id)
  if (!record) return { ok: false, error: `没有这条记录：${id}` }
  record.tags = cleanTags(tags)
  let learned = null
  if (toHotwords && record.tags.length) {
    const target = record.categoryId || ensureFallbackCategory()
    const r = hotwords.addTerms(target, record.tags.map((term) => ({ term })), 'manual')
    if (r.ok) {
      const cat = hotwords.list().categories.find((c) => c.id === target)
      record.categoryId = record.categoryId || target
      record.categoryName = record.categoryName || cat?.name || ''
      learned = { added: r.added, merged: r.merged ?? 0, categoryName: cat?.name ?? '' }
    }
  }
  const stored = persist(record)
  return { ok: true, record: brief(stored), tags: stored.tags, learned }
}

/** 换分类：同时把词表快照换掉，并重算命中 */
export function setCategory(id, ref) {
  const record = get(id)
  if (!record) return { ok: false, error: `没有这条记录：${id}` }
  const key = String(ref ?? '').trim()
  if (!key) {
    record.categoryId = ''
    record.categoryName = ''
  } else {
    const cat = hotwords.findCategory(key)
    if (!cat) return { ok: false, error: `没有这个分类：${key}` }
    record.categoryId = cat.id
    record.categoryName = cat.name
    record.hotwordTerms = hotwords.termsOf([cat.id]).terms
  }
  refreshHits(record)
  const stored = persist(record)
  return { ok: true, record: brief(stored), categoryId: stored.categoryId, categoryName: stored.categoryName }
}

/** 这次想理清的重点 / 访谈提纲：记完也能补，补完重新整理就会按它对照 */
export function setFocus(id, focus) {
  const record = get(id)
  if (!record) return { ok: false, error: `没有这条记录：${id}` }
  record.focus = String(focus ?? '').slice(0, 2000)
  const stored = persist(record)
  return { ok: true, record: brief(stored), focus: stored.focus }
}

/** 手工从一条记录里学热词（换过分类、或当时自动学词关着的时候用） */
export function learnFromRecord(id) {
  const record = get(id)
  if (!record) return { ok: false, error: `没有这条记录：${id}` }
  const learned = learnHotwords(record)
  const stored = persist(record)
  return { ok: true, learned, record: brief(stored) }
}

/**
 * 把这条记录的原始音频按 Range 交给 `<audio>`。
 * 为什么自己写：浏览器拖进度条靠 206 + Content-Range，一次给完整文件的话每次跳都得重下。
 *
 * 注意取的是 `record.audio.file`（音频），不是 `record.file`（md 正文）—— 这两个字段差一个字，
 * 拿错就成了「用 Markdown 文档当音频播」。
 */
export function streamAudio(req, res, id) {
  const record = get(String(id ?? ''))
  const file = record?.audio?.file ? path.resolve(record.audio.file) : ''
  let size = 0
  try {
    if (!file || !fs.existsSync(file)) throw new Error('no file')
    size = fs.statSync(file).size
  } catch {
    res.statusCode = 404
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ ok: false, error: '这条记录没有可回放的音频（文件被删了或记录里没存）' }))
    return 'handled'
  }

  const ext = path.extname(file).toLowerCase()
  const mime =
    {
      '.mp3': 'audio/mpeg',
      '.m4a': 'audio/mp4',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
      '.oga': 'audio/ogg',
      '.opus': 'audio/opus',
      '.flac': 'audio/flac',
      '.aac': 'audio/aac',
      '.wma': 'audio/x-ms-wma',
      '.webm': 'audio/webm',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.mkv': 'video/x-matroska',
    }[ext] ?? 'application/octet-stream'

  const range = String(req.headers.range ?? '')
  const m = range.match(/bytes=(\d*)-(\d*)/)
  const base = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=600' }
  if (m) {
    let start = m[1] ? Number(m[1]) : 0
    let end = m[2] ? Number(m[2]) : size - 1
    if (!m[1] && m[2]) {
      // `bytes=-500`：末尾 N 字节
      start = Math.max(0, size - Number(m[2]))
      end = size - 1
    }
    if (start >= size || end >= size || start > end) {
      res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}` })
      res.end()
      return 'handled'
    }
    res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) })
    fs.createReadStream(file, { start, end }).pipe(res)
    return 'handled'
  }
  res.writeHead(200, { ...base, 'Content-Length': String(size) })
  fs.createReadStream(file).pipe(res)
  return 'handled'
}

/** 音频占用（配置页显示用）：audio/ 下所有文件的总量与条数 */
export function audioUsage() {
  let bytes = 0
  let count = 0
  try {
    for (const name of fs.readdirSync(AUDIO_DIR())) {
      try {
        const st = fs.statSync(path.join(AUDIO_DIR(), name))
        if (!st.isFile()) continue
        bytes += st.size
        count += 1
      } catch {
        /* 单个文件读不到就跳过 */
      }
    }
  } catch {
    /* 目录还没有 */
  }
  return { count, bytes, mb: Math.round((bytes / 1024 / 1024) * 10) / 10 }
}

/** 只删某条记录的音频（转写与整理稿留着），返回删完之后的占用 */
export function removeAudio(id) {
  const record = get(id)
  if (!record) return { ok: false, error: `没有这条记录：${id}` }
  if (record.audio?.file) {
    try {
      fs.unlinkSync(record.audio.file)
    } catch {
      /* 文件不在了就算了 */
    }
  }
  record.audio = null
  persist(record)
  return { ok: true, ...audioUsage() }
}

export function prompts() {
  const current = customPrompts()
  return {
    ok: true,
    defaults: DEFAULT_PROMPTS,
    current,
    active: activePrompts(),
    placeholders: [
      '{{transcript}}',
      '{{plain}}',
      '{{process}}',
      '{{duration}}',
      '{{chars}}',
      '{{hotwords}}',
      '{{categories}}',
      '{{focus}}',
      '{{type}}',
    ],
    customized: Object.keys(current).length > 0,
  }
}

/** 这几段正文模板必须留一个内容占位符，否则模型看不到转写 */
const CONTENT_KEYS = new Set(['summaryUser', 'interviewUser'])

/** 保存提示词：只认这两套骨架（四个键）；空串 = 该字段回默认；正文模板必须带 {{transcript}} */
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
    if (CONTENT_KEYS.has(key) && !/\{\{\s*(transcript|plain)\s*\}\}/.test(value)) {
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
/** 「分类」是热词分类，不是栏目 */
const CATEGORY_TITLES = new Set(['分类', '类别', '热词分类'])
const MAX_TAGS = 8

/**
 * 「正名 ← 错写」或「正名 | 错写」；也认「错写 → 正名」（箭头右边才是正名）。
 * 整理稿的术语栏、热词自学都要用它，所以方向必须写死，不能靠猜。
 */
export function parseTermLine(body) {
  const line = String(body ?? '').trim().replace(/^[-*•]\s*/, '')
  const forward = line.match(/^(.+?)\s*(?:→|->|=>)\s*(.+)$/)
  const backward = line.match(/^(.+?)\s*(?:←|<-|=|\||丨|｜)\s*(.+)$/)
  const pick = forward ?? backward
  const rawTerm = (pick ? (forward ? pick[2] : pick[1]) : line).replace(/[（(][^)）]*[)）]\s*$/, '').trim()
  const rawAlias = pick ? (forward ? pick[1] : pick[2]) : ''
  // 模型常写出「词 |」这种只有分隔符没别名的行：两种写法都要收干净
  const term = rawTerm
    .replace(/^["“「『]|["”」』]$/g, '')
    .replace(/[\s|｜丨、,，;；:：\-—]+$/g, '')
    .trim()
    .slice(0, 24)
  const aliases = rawAlias
    .split(/[、,，;；/|丨｜]/)
    .map((s) => s.replace(/^["“「『]|["”」』]$/g, '').replace(/^常见错写[:：]\s*/, '').trim())
    .filter((s) => s && s !== term && s.length <= 24)
    .slice(0, 6)
  return term ? { term, aliases } : null
}

export function parseSummaryDoc(content) {
  const title = { value: '' }
  const summaryLines = []
  const sections = []
  const tags = []
  let category = ''
  let current = null
  let inTags = false
  let inCategory = false
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
        inCategory = false
        continue
      }
      if (TAG_TITLES.has(text)) {
        inTags = true
        inCategory = false
        continue
      }
      if (CATEGORY_TITLES.has(text)) {
        inCategory = true
        inTags = false
        continue
      }
      inTags = false
      inCategory = false
      current = { key: SECTION_KEYS[text] ?? 'other', title: text, items: [] }
      continue
    }
    const item = line.match(/^(?:[-*•]|\d+[.、)])\s+(.+)$/)
    const body = (item ? item[1] : line).trim()
    if (inTags) {
      // 一行一个标签，也可能一行写多个、用顿号分隔，都拆开
      for (const piece of body.split(/[、,，;；/|]/)) {
        const tag = piece.replace(/^#+\s*/, '').trim()
        if (tag) tags.push(tag)
      }
      continue
    }
    if (inCategory) {
      if (!category) category = body.replace(/^[-*•]\s*/, '').trim()
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
    category,
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
  // 模型这轮没给标签就留着页面里改过的，别清空
  if ((doc.tags ?? []).length) record.tags = doc.tags
  if (doc.category) record.detectedCategory = doc.category
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
      resolveRecordCategory(record)
      record.learned = learnHotwords(record)
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
    resolveRecordCategory(record)
    record.learned = learnHotwords(record)
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
  const chunks = recordChunks(record)
  const total = chunks.length
  if (!total) return { ok: false, error: '这条记录没有可用的正文，没法分段' }
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
      ...chunkRange(chunk),
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
    chunks: isLong ? recordChunks(record).length : 1,
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
  resolveRecordCategory(record)
  record.learned = learnHotwords(record)
  record.model = useModel ?? loadConfig().ai?.model ?? null
  const stored = persist(record)
  console.log(
    `[memo] summarize ${record.id} ok：${isLong ? `分段 ${parts?.length ?? 0} 段 + 合并` : `${deltas} 个 delta`}` +
      `，正文 ${String(content).length} 字，分类=${stored.categoryName || '未定'}，学词 ${record.learned?.added?.length ?? 0} 个`,
  )
  onEvent?.({ type: 'learned', categoryName: stored.categoryName, terms: record.learned?.added ?? [] })
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
  lines.push(`- 时间：${stamp(record.startedAt)}`)
  // 时长只有从音频文件头里读出来才有（见 wavSeconds）：没有就不写「时长 00:00」这种假信息
  if (record.durationSec) lines.push(`- 音频时长：${clock(record.durationSec)}`)
  lines.push(`- 字数：${record.chars}`)
  if (record.asrMs) lines.push(`- 转写耗时：${(record.asrMs / 1000).toFixed(1)}s`)
  if (record.audio?.name) {
    const mb = Math.round(((record.audio.bytes ?? 0) / 1024 / 1024) * 10) / 10
    lines.push(`- 原始音频：${record.audio.name}（${mb} MB）`)
  }
  if (record.device) lines.push(`- 设备：${record.device}`)
  if (record.model) lines.push(`- 模型：${record.model}`)
  lines.push(`- 类型：${record.type === 'interview' ? '访谈' : '口述'}`)
  if (record.categoryName) lines.push(`- 分类：${record.categoryName}`)
  if ((record.tags ?? []).length) lines.push(`- 主题：${record.tags.join(' / ')}`)
  const { used, fresh } = hotwordLine(record)
  if (used.length) lines.push(`- 热词命中：${used.join(' / ')}`)
  if (fresh.length) lines.push(`- 新学热词：${fresh.join(' / ')}`)
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
      // 没有时间码的分段（上传式转写）就别印「（）」里那对空括号
      const range = part.startLabel && part.endLabel ? `（${part.startLabel}–${part.endLabel}）` : ''
      const head = `### 第 ${part.index} 段${range}`
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
  if ((record.segments ?? []).length) {
    for (const segment of record.segments) {
      lines.push(`[${clock(segment.start)}-${clock(segment.end)}] ${segment.text}`)
    }
  } else if (String(record.transcript ?? '').trim()) {
    // 转写后端只回整篇、没有段级时间戳时，整段贴出来就是 —— 别留下一个空标题
    lines.push(String(record.transcript).trim())
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

/** 配置页「存储」那一块用：这些目录都在哪（音频占用另走 audioUsage()） */
export function dir() {
  return { data: MEMO_DIR(), records: RECORDS_DIR(), file: RECORDS_FILE(), audio: AUDIO_DIR(), jobs: JOBS_FILE() }
}
