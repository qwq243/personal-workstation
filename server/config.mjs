/**
 * 边车（sidecar）配置。
 *
 * **默认值全是中性的**：没有任何一项指向某台特定机器上的目录。带目录 / 地址的配置项
 * 出厂都是空串，第一次用到时页面会提示「去设置里填」。首次运行会生成 server/config.json。
 *
 * 两类文件分工：
 *   server/config.json  —— 非敏感配置（端口、路径、端点地址等），可以拷来拷去。
 *   server/credentials.json —— 敏感凭据（面板令牌、模型 API Key 等），只在本机躺着。
 * 读写 API 统一走 loadConfig / saveConfig，落盘位置由 SECRET_PATHS 决定；
 * 老版本 config.json 里的明文敏感项会在首次加载时自动迁移过来。
 *
 * 仓库里只有 server/config.example.json（全空默认 + 每项说明），真正的 config.json
 * 不进版本库。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url))
export const ROOT_DIR = path.resolve(SERVER_DIR, '..')
export const CONFIG_PATH = path.join(SERVER_DIR, 'config.json')
/** 敏感项单独存这里，不进 config.json */
export const SECRETS_PATH = path.join(SERVER_DIR, 'credentials.json')

/**
 * 哪些字段算敏感、必须放 server/credentials.json 而不是 config.json。
 *
 * 理由：config.json 是「会被拷来拷去、会被贴出来问人、会进备份」的那类文件，
 * 面板令牌、API Key 混在里面不合适。读写路径完全不变（loadConfig 会把两者合并），
 * 只是落盘位置分开了：非敏感项给人看，敏感项只在本机躺着。
 *
 * 老版本已经把明文写在 config.json 里 —— 首次加载会自动搬到 credentials.json 并从
 * config.json 里删掉，不用手工迁移。
 */
export const SECRET_PATHS = [
  // NewAPI 兼容面板的系统令牌（余额 / 令牌 / 日志那几个接口要它）
  ['newapi', 'token'],
  // 转写后端（OpenAI 兼容 /audio/transcriptions）的 API key
  ['asr', 'apiKey'],
  // 系统提示词里的可选身份补充（学校 / 专业这类）：属于个人信息，落 credentials 不落 config
  ['ai', 'personaPrivate'],
  // 云端文档解析（MinerU）的令牌
  ['wiki', 'mineru', 'token'],
  // 模型预设的 api key（按预设 id 存）与网络搜索 / 嵌入的 key —— 全站统一
  ['llm', 'keys'],
  ['search', 'apiKey'],
  ['embedding', 'apiKey'],
  ['docparse', 'mineru', 'token'],
  // 旧路径保留：迁移期内还没搬完的 credentials.json 也能读到
  ['wiki', 'llm', 'keys'],
  ['wiki', 'search', 'apiKey'],
]

/** 当前用户主目录 —— 自启位这类「跟着用户走」的路径从它派生，不硬编码任何用户名 */
const HOME = os.homedir()
/** 统一成正斜杠，避免 path.join 混出 C:\a/b 这种路径 */
const homeSlash = HOME.replace(/\\/g, '/')

export const DEFAULTS = {
  // ↓ 新配置分节加在这里（只加 DEFAULTS 是不够的：还要挂进 server/lib/config-editable.mjs
  //   的白名单、并在 server/config.example.json 里补一条说明。漏了 npm test 会点名，
  //   流程见 docs/EXTENDING.md §3.4 与 docs/CONFIG.md §10）

  /** 边车监听端口 */
  port: 5278,

  /**
   * 本地访问控制。
   *
   * 边车虽然只监听回环地址，但「只听回环」并不等于「只有你能调」——
   * 浏览器里任何一个网页都能 fetch 到 127.0.0.1，所以必须有这两道闸：
   *   1) Origin 白名单：只接受工作站自己的页面来源（开发 5273 / 生产 5278）。
   *      非白名单来源一律 403，恶意网页连探测都做不到。
   *   2) 本地令牌：/api/* 与 /mcp 都要带 X-WS-Token（或 Authorization: Bearer）。
   *      令牌从本文件读取；页面通过 /api/auth/token 引导获取（该接口本身也过 Origin 白名单）。
   *
   * 令牌首次运行自动生成。想临时恢复旧行为（谁都能调）把 enabled 设为 false。
   */
  auth: {
    enabled: true,
    /** 本地令牌；留空会在首次运行时自动生成并写回本文件 */
    token: '',
    /** 允许的浏览器来源；开发模式是 5273，生产模式是 5278 */
    allowedOrigins: [
      'http://127.0.0.1:5278',
      'http://localhost:5278',
      'http://127.0.0.1:5273',
      'http://localhost:5273',
    ],
  },

  /** NewAPI 兼容端点（面板 + OpenAI 兼容对话都在这个地址上）；令牌在 credentials.json */
  newapi: {
    /** 例如 https://your-newapi.example.com；**出厂留空**，去设置页填 */
    baseUrl: '',
    /** 面板系统令牌（实际值在 credentials.json，这里永远是空串） */
    token: '',
  },

  /**
   * AI 默认模型（走上面那个 OpenAI 兼容端点）。
   * 密钥在 credentials.json 的 `llm.keys.workstation`。
   */
  ai: {
    model: '',
    /** 可选的模型清单（问答页 / 随记页的下拉用）；留空只显示 ai.model 一个 */
    models: [],
    temperature: 0.6,
    /** 系统提示词里的「服务对象」那半句。默认中性，谁用谁改 */
    persona: '服务对象是一名在校大学生',
    /** 可选的补充身份信息（学校 / 专业…）：落 credentials.json，不进 config.json */
    personaPrivate: '',
    // 这里**没有** maxTokens：输出预算由 lib/llm.mjs 按输入字数算（见该文件头部）。
    // 曾经有过一个 1500 的默认值，思考模型会把正文吃成空串 —— 别再把它加回来。
  },

  /**
   * 工作站自身：开机自启走启动文件夹里的**快捷方式**（不需要管理员权限）。
   *
   * autostartEntry = 启动文件夹里那条自启项的文件名，也就是「任务管理器 → 启动应用」
   * 里显示的名字。用 .lnk 而不是直接把 .vbs 放进去，原因：
   *   1) 名字要能自己认出来；
   *   2) Windows 的安全策略**禁止在启动文件夹新建 .vbs / .cmd**，只放行 .txt 与 .lnk
   *      （覆盖已存在的 .vbs 可以，所以老写法是「看着能用、一删就再也装不回去」）。
   * 脚本本体**不进版本库**：它由 `server/lib/panel.mjs` 的 `enable()`（页面「运行与自启」点
   * 「开启 / 重建」）或 `scripts/restart-sidecar.py` 在**运行时**生成到
   * `scripts/Workstation.vbs`，启动文件夹里只放一条指过去的 .lnk。所以仓库里翻不到这个 .vbs
   * 是正常的（`.gitignore` 也专门忽略它），别以为副本剪错了。
   */
  workstation: {
    autostartEntry: 'Workstation.lnk',
    /** 自启时的输出日志（追加） */
    autostartLog: 'logs/sidecar-autostart.log',
  },

  /** 启动文件夹目录（自启位都放这里；留空 = 自动取 %APPDATA% 下那个） */
  startupDir: `${homeSlash}/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup`,

  /**
   * 转写后端（语音随记用）。
   *
   * 只有一个实现：OpenAI 兼容的 `/audio/transcriptions`（whisper 接口）。
   * 本机跑（whisper.cpp / faster-whisper 的 OpenAI 兼容网关）或云端都行 —— 填端点就是。
   * apiKey 是敏感项，落 credentials.json 的 `asr.apiKey`。
   *
   * baseUrl 留空 = 没配：语音随记模块会从侧边栏隐藏（「没配 = 不显示」）。
   */
  asr: {
    /** 'openai' = 走 OpenAI 兼容转写接口；'none' = 关掉转写（模块隐藏） */
    provider: 'openai',
    /** 例如 http://127.0.0.1:8080/v1（本机 faster-whisper-server）或 https://api.openai.com/v1 */
    baseUrl: '',
    model: 'whisper-1',
    /** 提示语言（ISO-639-1，如 zh / en）；留空让服务端自己判断 */
    language: '',
    /** 密钥（实际值在 credentials.json，这里永远是空串） */
    apiKey: '',
    /** 单次请求超时（秒）：长音频转写会慢，别设太小 */
    timeoutSec: 600,
  },

  /**
   * 语音合成（朗读）—— 「每日一句」整句朗读用。
   *
   * 上游是 edge-tts（微软 Edge 的在线朗读，免费、不需要账号）。
   * 本仓库带了一份薄封装 tools/edge-tts/say.py：把它连同 venv 放到任意目录，
   * 用 dir 指过去即可（venv 在 <dir>/.venv，python 在 <dir>/.venv/Scripts/python.exe）。
   * dir 留空 = 没配：朗读接口照常存在，前端会回落浏览器自带的朗读。
   * 合成结果按文本哈希落 data/tts/cache/ 复用。
   */
  tts: {
    /** edge-tts 工具目录（含 say.py 与 .venv）；留空 = 没配 */
    dir: '',
    /** 默认音色（英语）与中文音色 */
    voice: 'en-US-AriaNeural',
    voiceZh: 'zh-CN-XiaoxiaoNeural',
    /** 语速，edge-tts 的格式：+0% / -10% */
    rate: '+0%',
  },

  /**
   * 资讯采集器的产物目录（「资讯」页只读它；采集本身不在这里做）。
   *
   * 采集器是独立进程 —— 本机计划任务、云机器 cron、或者就用 `scripts/collector-skeleton.mjs`
   * 这个最小示例。边车只读它下面的 `out/latest.json`、`out/*.md`、`timeline/*.md`、
   * `cases/*.md`、`sources.json` 这几样，字段契约见 docs/news-contract.md。
   * dir 留空 = 没配：资讯模块从侧边栏隐藏（「没配 = 不显示」）。
   */
  collector: {
    /** 采集结果目录（绝对路径；相对路径按仓库根解析） */
    dir: '',
    /** 抓外网源用的代理（只有「事件卡评论」那条路会出网）；留空 = 直连 */
    proxy: '',
  },

  /** 资讯模块自己的一点配置 */
  news: {
    /** 「与我相关」的关键词：条目命中任一即归 focus 分类；留空 = 只认采集器标的分类 */
    focusKeywords: [],
  },

  /**
   * 做题本：题库池（「推荐同类题」用）。
   *
   * 题干与解析**都不随仓库分发**：自己买课后按 docs/zuotiben-import.md 把试题册与
   * 解析册做成两份 markdown，再把路径填进来。三样都填了池子才可用；
   * 留空 = 没配（池子为空，推荐接口回「没配题库目录」，做题本本体照常可用）。
   */
  zuotiben: {
    pool: { dir: '', problems: '', solutions: '' },
  },

  /**
   * 进程 / 端口 / 智能体三个视图的本地扩展。
   *
   * images 直接命中进程名（.exe 可省），hints 只在 node/python/pwsh 这类主机解释器里查命令行。
   * 识别逻辑见 server/lib/procscan.mjs。出厂空 —— 需要就自己加，例如：
   *   agentExtras: [{ id: 'myagent', images: ['MyAgent'], hints: [] }]
   */
  procscan: {
    agentExtras: [],
  },

  /**
   * 进程守护引擎（pguard）—— 工作台自带的那一套，规则语义见 server/lib/pguard.mjs 头部。
   *
   * 判定与动手都在边车里做，不需要再常驻一个独立客户端；面板直接读引擎自己的状态与审计。
   *
   * 这里只放「开不开、数据放哪」；**规则阈值与名单不在这里** —— 那些在 dataDir 下的
   * config.json 里（面板的「参数」「名单」两页按白名单改，改完即时生效）。
   */
  pguard: {
    /** 引擎总开关：关掉则边车启动时不拉起它（面板上仍可手动启动） */
    enabled: true,
    /** 引擎数据目录（配置 / 审计 / 日志）；留空 = server/data/pguard */
    dataDir: '',
  },


  /**
   * 大模型（**全站统一配置**，2026-09-24 从 wiki 里提出来）：预设 + 每预设一份配置 + 任务路由。
   * 知识库的问答/编译、以及将来别的模块要用模型，都读这一份（`server/lib/wiki-llm.mjs`）。
   * apiKey 走 credentials.json（SECRET_PATHS 的 ['llm','keys']）。
   */
  llm: {
    activePresetId: 'workstation',
    configs: {},
    keys: {},
    customPresets: [],
    taskRouting: { chat: '', ingest: '' },
    reasoning: 'auto',
    maxContextSize: 128000,
  },

  /**
   * 语义检索（嵌入端点）—— 全站统一：这是「工作台的一项能力」，不是某个模块的私产。
   * apiKey 走 credentials.json（['embedding','apiKey']）。
   */
  embedding: {
    enabled: false,
    /** 例如 http://127.0.0.1:11434/v1/embeddings（本机 ollama）；出厂留空 = 语义检索不可用，自动退回词法 */
    endpoint: '',
    model: 'bge-m3',
    apiKey: '',
    batchSize: 8,
    concurrency: 2,
    chunkChars: 500,
    chunkOverlap: 80,
    maxPages: 5000,
    outputDimensionality: 0,
    extraHeaders: {},
  },

  /**
   * 检索（网络搜索 + 本机文件）—— 全站统一：问答、将来的「联网查资料」都用这一份。
   * apiKey 走 credentials.json（['search','apiKey']）。
   */
  search: {
    provider: 'none',
    apiKey: '',
    serpApiEngine: 'google',
    searXngUrl: '',
    searXngCategories: ['general'],
    ollamaUrl: 'https://ollama.com',
    providerConfigs: {},
    defaultSource: 'wiki',
    maxResults: 10,
    anyTxt: { enabled: false, endpoint: 'http://127.0.0.1:9920/', filterDir: '', filterExt: '', limit: 20 },
  },

  /** 文档解析（云端 MinerU + 本机兜底）—— 全站统一：解析是能力，谁要谁调 */
  docparse: {
    mineru: {
      enabled: true,
      endpoint: 'https://mineru.net/api/v4',
      modelVersion: 'vlm',
      language: 'ch',
      isOcr: true,
      timeoutSec: 300,
      token: '',
    },
    /**
     * 本机解析工具的位置。**留空 = 自动**（先按 PATH 找，再回落常见安装位），
     * 找不到时会明确报「缺哪个、怎么装」。装在不常见的位置就填绝对路径。
     */
    tools: {
      pandoc: '',
      soffice: '',
      python: '',
      pdftotext: '',
    },
  },

  /** 网络（只影响本模块自己的外呼：网络搜索 / 抓链接 / 云端解析） */
  network: { proxy: { enabled: false, url: '' } },

  /** 输出语言（编译与问答的提示词按它写） */
  outputLanguage: 'Chinese',

  /**
   * 知识库（格式沿用一套通用的 markdown wiki 约定，见 server/lib/wiki.mjs）。
   *
   * dir 指向的是**库本体**（不在本仓库里）：wiki/ 存编译出的页面、raw/ 存不可变的原始资料。
   * 换库只改这一个路径；库的格式是通用的那一套（schema.md + frontmatter + [[双链]]），
   * Obsidian 也能直接打开 —— 读写通道换过，格式没动。
   */
  wiki: {
    /**
     * 知识库根目录（**默认库**；当前库记在 server/data/wiki-projects.json，可在页面上随时切）。
     * 出厂留空 —— 第一次进「知识库」页会让你选一个目录（空的也行，会给你建好骨架）。
     */
    dir: '',
    /** 编译/问答用哪个模型；留空 = 用全局 ai.model */
    model: '',
    /** 单次编译最多喂给模型多少字（原始资料超长时截断） */
    maxChars: 24000,
    /** 问答单次回答的 token 上限 */
    chatMaxTokens: 1600,

    /**
     * 语义检索（嵌入端点）—— 与对话模型分开配。
     * 留空 = 语义检索不可用，检索自动退回词法，不报错。
     */
    embedding: {
      enabled: false,
      endpoint: '',
      model: 'bge-m3',
      apiKey: '',
      batchSize: 8,
      concurrency: 2,
      chunkChars: 500,
      chunkOverlap: 80,
      maxPages: 5000,
    },

    /**
     * 模型配置（「预设 → 解析」两层）：
     * 预设（厂商/端点/模型/上下文）→ 每预设一份配置 → 任务路由（对话与编译可各点一个预设）。
     * 内置预设见 wiki-llm.mjs 的 PRESETS；`workstation` = 跟随工作台 ai.*（出厂即可用）。
     * apiKey 走 credentials.json（SECRET_PATHS 的 ['wiki','llm','keys']）。
     */
    llm: {
      activePresetId: 'workstation',
      configs: {},
      /** 每个预设的 api key；实际值在 credentials.json */
      keys: {},
      customPresets: [],
      /** 留空 = 用 activePresetId */
      taskRouting: { chat: '', ingest: '' },
      /** auto = 让模型自己决定；off = 明确关掉思考（部分模型支持） */
      reasoning: 'auto',
      maxContextSize: 128000,
    },

    /**
     * 检索（网络搜索 + 本机 AnyTXT）：
     * provider 是网络搜索（无 key 也能用 firecrawl/searxng）；anyTxt 是本机文件全文检索（要装 AnyTXT）。
     * defaultSource 决定问答默认检索哪儿：wiki / web / anytxt / all。
     * apiKey 走 credentials.json（['wiki','search','apiKey']）。
     */
    search: {
      provider: 'none',
      apiKey: '',
      serpApiEngine: 'google',
      searXngUrl: '',
      searXngCategories: ['general'],
      ollamaUrl: 'https://ollama.com',
      providerConfigs: {},
      defaultSource: 'wiki',
      maxResults: 10,
      anyTxt: { enabled: false, endpoint: 'http://127.0.0.1:9920/', filterDir: '', filterExt: '', limit: 20 },
    },

    /** 输出语言（编译与问答的提示词都按它写） */
    output: { language: 'Chinese' },
    /** 网络（只影响本模块的外呼：搜索 / 云端解析） */
    network: { proxy: { enabled: false, url: '' } },
    /** 定时导入：按周期把监听目录里的新文件排进队列（与 watchEnabled 配合） */
    scheduledImport: { enabled: false, intervalMin: 60 },

    /**
     * 云端文档解析（MinerU）—— 本项目的**首选通道**。
     *
     * 为什么默认开：本地 pdf 通道只有文本层（表格塌成碎字、图片拿不到），扫描版更是完全没辙；
     * 云端开着 OCR 能把这两件事一起解决。失败或关掉时自动回落本地通道（pandoc/LibreOffice/Python）。
     * **文档会上传到第三方云端**（mineru.net）—— 页面上明确标注；介意就别开。
     * token 是敏感项，存在 server/credentials.json（SECRET_PATHS 里有 ['wiki','mineru','token']），
     * 只能自己填 —— 没有任何「从别的应用自动搬过来」的通道。
     */
    mineru: {
      enabled: true,
      endpoint: 'https://mineru.net/api/v4',
      /** vlm = 视觉大模型（对扫描件与复杂版式更稳）；pipeline = 传统流水线 */
      modelVersion: 'vlm',
      language: 'ch',
      /** 打开 OCR：扫描版 PDF 只有开着它才有文字 */
      isOcr: true,
      /** 轮询上限：长论文可能几分钟 */
      timeoutSec: 300,
      /** 令牌（实际值在 credentials.json，这里永远是空串） */
      token: '',
    },

    /**
     * 源目录监听：盯几个文件夹，发现「新增或改过」的
     * pdf/docx/xlsx/pptx/md/txt/html/csv 就排队入库。
     * dirs 留空 = 只盯当前库的 raw/sources。
     * autoIngest 默认关：一旦开了，边车会在后台自己花模型额度去编译，得由用户主动打开。
     */
    watchEnabled: false,
    watchAutoIngest: false,
    watchIntervalMin: 30,
    watchMaxFileSizeMb: 100,
    watchDirs: [],
    watchExcludeDirs: ['.git', '.svn', '.hg', '.obsidian', '.idea', '.vscode', 'node_modules', '.cache', '__pycache__', '.trash'],
  },

  /**
   * 数据目录（看板、词单、知识库向量、录音、进程守护审计…全在它下面）。
   * 默认就是仓库内的 server/data，想挪到别的盘直接改这一项；
   * 代码里一律通过 dataDir() 取，不要再直接读 cfg.dataDir。
   */
  dataDir: path.join(SERVER_DIR, 'data'),
}

/**
 * 数据目录的**唯一入口**。
 *
 * 顺序：环境变量 `WS_DATA_DIR`（测试用，可把数据写到别处，不碰真实数据）→ config.json 的 dataDir。
 * 各 lib 一律从这里取 —— 以前有六七个文件各自写了一遍同样的表达式，改一处漏六处。
 */
export function dataDir() {
  return process.env.WS_DATA_DIR || loadConfig().dataDir
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** 深合并（数组直接覆盖） */
function merge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base }
  if (!isPlainObject(patch)) return out
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = merge(out[k], v)
    else if (v !== undefined) out[k] = v
  }
  return out
}

let cached = null
let secretsCache = null

/** 生成一个新的本地令牌 */
function newToken() {
  return randomBytes(24).toString('hex')
}

/* ------------------------------------------------------ 路径读写小工具 --- */

function getPath(obj, p) {
  let cur = obj
  for (const k of p) {
    if (!isPlainObject(cur)) return undefined
    cur = cur[k]
  }
  return cur
}

function setPath(obj, p, value) {
  let cur = obj
  for (let i = 0; i < p.length - 1; i += 1) {
    if (!isPlainObject(cur[p[i]])) cur[p[i]] = {}
    cur = cur[p[i]]
  }
  cur[p[p.length - 1]] = value
}

function delPath(obj, p) {
  const stack = []
  let cur = obj
  for (let i = 0; i < p.length - 1; i += 1) {
    if (!isPlainObject(cur?.[p[i]])) return
    stack.push([cur, p[i]])
    cur = cur[p[i]]
  }
  if (isPlainObject(cur)) delete cur[p[p.length - 1]]
  // 顺手清掉因此变空的父对象，别在 config.json 里留一堆空壳
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const [parent, key] = stack[i]
    if (isPlainObject(parent[key]) && Object.keys(parent[key]).length === 0) delete parent[key]
  }
}

function readJSONFile(file) {
  try {
    if (!fs.existsSync(file)) return {}
    const v = JSON.parse(fs.readFileSync(file, 'utf8'))
    return isPlainObject(v) ? v : {}
  } catch (err) {
    console.warn(`[config] 读取 ${path.basename(file)} 失败：`, err.message)
    return {}
  }
}

function readSecrets() {
  if (secretsCache) return secretsCache
  secretsCache = readJSONFile(SECRETS_PATH)
  return secretsCache
}

function writeSecrets(secrets) {
  secretsCache = secrets
  fs.mkdirSync(path.dirname(SECRETS_PATH), { recursive: true })
  fs.writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2), 'utf8')
}

/**
 * 只留「和出厂默认不一样」的那部分（递归）。
 *
 * 为什么要有它：persistConfig 原来把整个合并结果写回文件，于是**出厂默认值也被写进了
 * config.json** —— 其中有些默认值是运行时推导出来的（比如 `startupDir` 取自 `os.homedir()`）。
 * 结果就是「用户什么都没改，config.json 里却躺着一台机器的绝对路径」：
 * 换台机器读起来莫名其妙，分享/截图/进版本库时还会把主目录名一起带出去。
 *
 * 只写差异之后，config.json ≈「你改过的东西」清单，一眼能看出这台机器上偏离了哪些默认值。
 * 读的时候 DEFAULTS 会再合并回来，所以行为不变。
 */
function diffFromDefaults(obj, base) {
  if (!isPlainObject(obj)) return obj
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    const b = isPlainObject(base) ? base[k] : undefined
    if (isPlainObject(v)) {
      const sub = diffFromDefaults(v, b)
      if (Object.keys(sub).length) out[k] = sub
    } else if (Array.isArray(v)) {
      if (JSON.stringify(v) !== JSON.stringify(b)) out[k] = v
    } else if (v !== b) {
      out[k] = v
    }
  }
  return out
}

/** 把内存里的合并结果写回 config.json —— 敏感项一律剔除（它们只属于 credentials.json），
 *  且**与默认值相同的项不落盘**（见 diffFromDefaults：否则会把本机路径写进文件） */
function persistConfig(cfg = cached) {
  const clean = diffFromDefaults(structuredClone(cfg), DEFAULTS)
  for (const p of SECRET_PATHS) delPath(clean, p)
  // 令牌无论是否等于默认值都要留着（默认是空串，写出去才有意义）
  if (cfg?.auth?.token) clean.auth = { ...(clean.auth ?? {}), token: cfg.auth.token }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(clean, null, 2), 'utf8')
}

/** 敏感项以 credentials.json 为准，覆盖到合并结果上 */
function applySecrets(cfg) {
  const secrets = readSecrets()
  for (const p of SECRET_PATHS) {
    const v = getPath(secrets, p)
    if (v !== undefined) setPath(cfg, p, v)
  }
  return cfg
}

export function loadConfig() {
  if (cached) return cached

  const fileCfg = readJSONFile(CONFIG_PATH)
  const secrets = readSecrets()

  // 一次性迁移：老版本把凭据明文写在 config.json 里，搬进 credentials.json 并删掉
  let migrated = false
  let migratedCount = 0
  for (const p of SECRET_PATHS) {
    const v = getPath(fileCfg, p)
    if (typeof v === 'string' && v) {
      if (!getPath(secrets, p)) setPath(secrets, p, v)
      delPath(fileCfg, p)
      migrated = true
      migratedCount += 1
    }
  }
  if (migrated) {
    try {
      writeSecrets(secrets)
      console.log(`[config] 已把 ${migratedCount} 个敏感项从 config.json 迁到 credentials.json`)
    } catch (err) {
      console.warn('[config] 敏感项迁移失败（将继续按原值使用）：', err.message)
    }
  }

  cached = applySecrets(merge(DEFAULTS, fileCfg))

  // 首次运行（或令牌被清空）时生成令牌并落盘，保证「装着就能用」，不用手工造
  let dirty = !fs.existsSync(CONFIG_PATH) || migrated
  if (cached.auth.enabled !== false && !cached.auth.token) {
    cached.auth.token = newToken()
    dirty = true
  }
  if (dirty) {
    try {
      persistConfig()
    } catch {
      /* 忽略：只读环境下不写 */
    }
  }
  return cached
}

/** 换一个令牌（旧令牌立即失效），并落盘 */
export function rotateAuthToken() {
  const cfg = loadConfig()
  cfg.auth.token = newToken()
  persistConfig(cfg)
  return cfg.auth.token
}

/** 脱敏：只留后 4 位，够确认「有没有填、填的是哪个」就行 */
function mask(v) {
  if (typeof v !== 'string' || !v) return v
  return v.length <= 4 ? '****' : `****${v.slice(-4)}`
}

/** 对外（HTTP 响应）用的配置副本：令牌与敏感项都脱敏 */
export function publicConfig() {
  const cfg = structuredClone(loadConfig())
  if (cfg.auth) cfg.auth.token = cfg.auth.token ? '***（已隐藏，见 server/config.json）' : ''
  for (const p of SECRET_PATHS) {
    const v = getPath(cfg, p)
    if (typeof v === 'string' && v) setPath(cfg, p, mask(v))
  }
  return cfg
}

export function saveConfig(patch) {
  // 护栏：前端拿到的配置里令牌/敏感项是脱敏串，可能被原样 PATCH 回来。
  // 那种值（以及空串）绝不能覆盖真值，否则一次「保存设置」就会把鉴权搞坏或清空。
  const safePatch = isPlainObject(patch) ? patch : {}

  // 拆包：敏感项写 credentials.json，其余写 config.json
  const secretPatch = {}
  const plainPatch = structuredClone(safePatch)
  for (const p of SECRET_PATHS) {
    const v = getPath(plainPatch, p)
    if (v === undefined) continue
    delPath(plainPatch, p)
    if (typeof v === 'string' && v.startsWith('****')) continue // 脱敏串，跳过
    if (v === '') continue // 空串表示「不改」，避免误清
    setPath(secretPatch, p, v)
  }
  if (Object.keys(secretPatch).length) {
    const secrets = structuredClone(readSecrets())
    for (const p of SECRET_PATHS) {
      const v = getPath(secretPatch, p)
      if (v !== undefined) setPath(secrets, p, v)
    }
    writeSecrets(secrets)
  }

  if (isPlainObject(plainPatch.auth)) {
    const t = plainPatch.auth.token
    if (t === undefined || t === '' || (typeof t === 'string' && t.startsWith('***'))) {
      delete plainPatch.auth.token
    }
  }

  const next = applySecrets(merge(loadConfig(), plainPatch))
  if (!next.auth.token) {
    // 兜底：令牌不会因为任何写入而变成空
    next.auth.token = newToken()
  }
  cached = next
  persistConfig(next)
  // 顶层改了就顺手把 wiki.* 那份只读镜像同步过去（不然本次会话里两边又不一致）
  syncConfigMirrors()
  return next
}

/**
 * 把「错放在 wiki 里的全站配置」搬到顶层（2026-09-24 整理的收尾）。
 *
 * 一次性动作：启动时调一次，搬完就把旧键删掉，之后不再触发。
 * 为什么要有它：这些分节（大模型 / 嵌入 / 检索 / 文档解析 / 网络 / 输出）本来写进
 * `wiki.*` 是因为「谁先用谁配」，但它们是全站能力 —— 留在模块里会让设置页散成两处。
 */
export function migrateScopedConfig() {
  const moved = []
  const raw = (() => {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    } catch {
      return null
    }
  })()
  if (raw && isPlainObject(raw.wiki)) {
    const w = raw.wiki
    const patch = {}
    if (w.llm && raw.llm === undefined) {
      patch.llm = w.llm
      delete w.llm
      moved.push('llm')
    }
    if (w.embedding && raw.embedding === undefined) {
      patch.embedding = w.embedding
      delete w.embedding
      moved.push('embedding')
    }
    if (w.search && raw.search === undefined) {
      patch.search = w.search
      delete w.search
      moved.push('search')
    }
    if (w.mineru && (!raw.docparse || raw.docparse.mineru === undefined)) {
      patch.docparse = { ...(raw.docparse ?? {}), mineru: w.mineru }
      delete w.mineru
      moved.push('docparse.mineru')
    }
    if (w.network?.proxy && (!raw.network || raw.network.proxy === undefined)) {
      patch.network = { ...(raw.network ?? {}), proxy: w.network.proxy }
      delete w.network
      moved.push('network.proxy')
    }
    if (w.output?.language && raw.outputLanguage === undefined) {
      patch.outputLanguage = w.output.language
      delete w.output
      moved.push('outputLanguage')
    }
    if (Object.keys(patch).length) {
      raw.wiki = w
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...raw, ...patch }, null, 2), 'utf8')
      resetConfigCache()
    }
  }

  // credentials.json 同理：wiki.llm.keys / wiki.search.apiKey → llm.keys / search.apiKey
  try {
    const sec = readSecrets()
    const sw = sec.wiki
    if (isPlainObject(sw) && (sw.llm?.keys || sw.search?.apiKey || sw.mineru?.token)) {
      if (sw.llm?.keys && !sec.llm?.keys) sec.llm = { ...(sec.llm ?? {}), keys: sw.llm.keys }
      if (sw.search?.apiKey && !sec.search?.apiKey) sec.search = { ...(sec.search ?? {}), apiKey: sw.search.apiKey }
      if (sw.mineru?.token && !sec.docparse?.mineru?.token) {
        sec.docparse = { ...(sec.docparse ?? {}), mineru: { ...((sec.docparse ?? {}).mineru ?? {}), token: sw.mineru.token } }
      }
      const newWiki = { ...sw }
      delete newWiki.llm
      delete newWiki.search
      delete newWiki.mineru
      if (Object.keys(newWiki).length) sec.wiki = newWiki
      else delete sec.wiki
      writeSecrets(sec)
      moved.push('secrets(llm/search keys)')
      resetConfigCache()
    }
  } catch {
    /* secrets 读不到就跳过：调用方下次启动还会试 */
  }
  return moved
}

/* --------------------------------------------------- 老位置只读镜像 ---
 *
 * 全站化的那几个节（模型 / 嵌入 / 检索 / 文档解析 / 网络 / 输出语言）曾经住在 `wiki.*` 下，
 * 2026-09-24 搬到顶层，但**搬的时候只处理「顶层还没有」的情况** —— 顶层已经有了的，
 * 老键就原地留着不动。于是 config.json 里长期躺着两份值，而且会各自变化。
 *
 * 2026-09-26 因此出过一次真实事故：设置页「语义检索」那一段还在读写 `wiki.embedding`，
 * 表现为「改了保存没生效」，而且它每次保存都把过期的老值写回去。
 * 修完之后没有任何代码再读写这些老键了 —— 但**下一个人/下一段代码仍可能被它们误导**。
 *
 * 所以这里把它们做成**只读镜像**：启动时（以及每次保存后）由顶层同步过去，
 * 任何位置读到的都是同一份值。规矩只有一条：**改配置改顶层**，`wiki.*` 里的这几节别手动改
 * （改了也会在下次启动被覆盖），每节下面带一个 `_mirror` 说明，打开文件的人一眼能看见。
 */
const MIRROR_SECTIONS = [
  { from: ['llm'], to: ['llm'] },
  { from: ['embedding'], to: ['embedding'] },
  { from: ['search'], to: ['search'] },
  { from: ['docparse', 'mineru'], to: ['mineru'] },
  { from: ['network', 'proxy'], to: ['network', 'proxy'], nest: 'network' },
  { from: ['outputLanguage'], to: ['output', 'language'], nest: 'output' },
]

const MIRROR_NOTE = '只读镜像：以顶层同名配置为准，启动时自动同步，别改这里'

export function syncConfigMirrors() {
  let raw = null
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return []
  }
  if (!isPlainObject(raw)) return []
  const wiki = isPlainObject(raw.wiki) ? { ...raw.wiki } : {}
  const changed = []
  for (const m of MIRROR_SECTIONS) {
    const value = getPath(raw, m.from)
    if (value === undefined) continue
    const current = getPath(wiki, m.to)
    // nest：老位置是「一个子对象」的形状（如 wiki.network.proxy、wiki.output.language）
    const next = m.nest ? { ...(isPlainObject(current) ? current : {}), _mirror: MIRROR_NOTE } : { ...value }
    if (!m.nest) next._mirror = MIRROR_NOTE
    if (JSON.stringify(current) === JSON.stringify(next)) continue
    setPath(wiki, m.to, next)
    changed.push(`wiki.${m.to.join('.')}`)
  }
  if (changed.length) {
    raw.wiki = wiki
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2), 'utf8')
      resetConfigCache()
    } catch {
      /* 写不进去（只读/占用）就算了：下次启动还会试，不影响运行 */
    }
  }
  return changed
}

export function resetConfigCache() {
  cached = null
  secretsCache = null
}
