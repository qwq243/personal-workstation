# 配置与凭据（Configuration）

这份文档回答四件事：**哪些文件管什么、每个字段是什么意思、怎么改、什么绝对不能提交。**

所有默认值的唯一事实源是 `server/config.mjs` 的 `DEFAULTS`（第 62–388 行）。
本文逐项解释它；代码改动后请顺手改这里。

---

## 1. 四个位置，各管什么

| 文件 / 目录 | 放什么 | 进版本库？ | 谁创建 |
|---|---|---|---|
| `server/config.example.json` | 模板 + 每项说明（**程序不读它**） | 是 | 人写的 |
| `server/config.json` | 你的实际配置：端口、目录、端点地址、白名单… | **否** | 首次运行自动生成 |
| `server/credentials.json` | 敏感项：面板令牌、模型 API Key、云端令牌、身份补充 | **否** | 第一次保存密钥时（`saveConfig()` 收到敏感项，或启动时从 `config.json` 迁移明文密钥）。**没配过密钥就一直不存在，属正常状态** |
| `server/data/` | 看板、词单、向量、录音、审计、缓存、备份 | 否（只放行 7 个示例文件） | 运行时生成 |

三者关系（`server/config.mjs:22-26`）：

```js
export const SERVER_DIR  = <仓库>/server
export const ROOT_DIR    = <仓库>
export const CONFIG_PATH = SERVER_DIR/config.json
export const SECRETS_PATH = SERVER_DIR/credentials.json      // 敏感项单独存这儿
```

---

## 2. 读写机制（动配置前先懂这四条）

### 2.1 合并与读取

`loadConfig()`（`config.mjs:530`）的顺序：

```
readJSONFile(config.json)  ─┐
readJSONFile(credentials.json) ─┴─► merge(DEFAULTS, fileCfg) ─► applySecrets() ─► 缓存到内存
```

- `merge()` 是**深合并**，但**数组直接整体覆盖**（`config.mjs:405-413`）——
  `allowedOrigins`、`watchDirs`、`models` 这类改动是替换而不是追加。
- 结果缓存在模块内存里（`cached`）；`resetConfigCache()` 清缓存，`saveConfig()` 会重算。
- 读配置一律用 `loadConfig()`；**不要再自己 `readFileSync` 这两个文件**。

### 2.2 敏感项：`SECRET_PATHS`

哪些字段算敏感由 `SECRET_PATHS`（`config.mjs:38-55`）决定，当前共 10 条：

| 路径 | 是什么 |
|---|---|
| `['newapi','token']` | NewAPI 面板系统令牌（余额 / 令牌 / 日志接口要它） |
| `['asr','apiKey']` | 转写后端（OpenAI 兼容 `/audio/transcriptions`）的 key |
| `['ai','personaPrivate']` | 系统提示词里可选的补充身份（学校 / 专业这类） |
| `['llm','keys']` | 各模型预设的 api key（按预设 id 存） |
| `['search','apiKey']` | 网络搜索的 key |
| `['embedding','apiKey']` | 嵌入端点的 key |
| `['docparse','mineru','token']` | 云端文档解析（MinerU）令牌 |
| `['wiki','mineru','token']` | 旧路径（迁移期兼容） |
| `['wiki','llm','keys']` | 旧路径 |
| `['wiki','search','apiKey']` | 旧路径 |

规则：

- **落盘位置**由它决定：写配置时敏感项被剔出 `config.json`、写进 `credentials.json`
  （`persistConfig()`，`:512`；`saveConfig()` 的拆包，`:605-623`）。
- **读的时候两者拼回一份**（`applySecrets()`，`:521`），所以调用方不关心值在哪个文件。
- **一致迁移**：老版本把明文写在 `config.json` 里 —— 首次加载会自动搬到
  `credentials.json` 并从 `config.json` 删掉（`:536-555`），不用手工做。
- `DEFAULTS.asr` 里**没有** `apiKey` 这个键：它只在 `SECRET_PATHS` 里，属于「有才写」的字段。
  用 `publicConfig()` 读时会脱敏成 `****xxxx`。

### 2.3 写回：只写「与默认值不同」的部分

`persistConfig()`（`:512`）做两件事：

1. `diffFromDefaults(cfg, DEFAULTS)`（`:493`）—— **只把偏离出厂默认的项写进文件**。
   为什么：默认值有些是运行时推导的（例如 `startupDir` 取自 `os.homedir()`）。
   全量写回会让「用户什么都没改，`config.json` 里却躺着一台机器的绝对路径」。
   只写差异之后，`config.json` ≈「**我改过什么**」清单。
2. 剔除 `SECRET_PATHS`；但 **`auth.token` 例外**：它无论是否等于默认（空串）都要写出去。

读的时候 `DEFAULTS` 会再合并回来，所以行为不变。

### 2.4 对外脱敏与写入护栏

| 函数 | 行为 |
|---|---|
| `publicConfig()`（`:590`） | 给 HTTP 响应用的副本：`auth.token` → `***（已隐藏…）`，其余敏感项 `mask()` 成 `****` + 后 4 位 |
| `saveConfig(patch)`（`:600`） | ① 以 `****` 开头的值跳过（那是脱敏串，不能覆盖真值）；② **空串 = 不改**（避免误清）；③ 写入后若 `auth.token` 为空则重新生成 —— **令牌不会因为任何写入变空** |
| `rotateAuthToken()`（`:576`） | 换一个新令牌，旧令牌立即失效 |
| `migrateScopedConfig()`（`:651`） | 一次性：把「错放在 `wiki.*` 里的全站配置」搬到顶层（`llm`/`embedding`/`search`/`docparse.mineru`/`network.proxy`/`outputLanguage`），搬完删旧键 |
| `syncConfigMirrors()`（`:751`） | 把顶层那几节**同步一份只读镜像**回 `wiki.*`（带 `_mirror` 说明）。**改配置只改顶层**；`wiki.*` 里那几节会在下次启动被覆盖 |

---

## 3. `DEFAULTS` 逐项

> 「留空会怎样」一列是**实际行为**，不是愿望。写「模块隐藏」的，依据是
> `visible()` 走 `cfgFilled()`（`src/core/appconfig.ts:52`）。

### 3.1 边车自身

| 字段 | 默认 | 含义 | 留空 / 改动的后果 |
|---|---|---|---|
| `port` | `5278` | 边车监听端口（只监听 `127.0.0.1`） | 改端口见 §6，**必须同时改 `auth.allowedOrigins`** |
| `dataDir` | `path.join(SERVER_DIR,'data')` | 数据目录（看板、词单、向量、录音、审计…） | 留空会被当成相对路径 → 数据落到进程 cwd 下。**建议保持默认**；要挪见 §9.2 |

### 3.2 访问控制 `auth`

| 字段 | 默认 | 含义 |
|---|---|---|
| `auth.enabled` | `true` | 是否开启「Origin 白名单 + 本地令牌」两道闸 |
| `auth.token` | `''` | 本地令牌，**留空会在首次运行时随机生成并写回**（`crypto.randomBytes(24).toString('hex')`，`:419-421`） |
| `auth.allowedOrigins` | `['http://127.0.0.1:5278','http://localhost:5278','http://127.0.0.1:5273','http://localhost:5273']` | 允许的浏览器来源（5278 = 生产，5273 = Vite 开发） |

判定逻辑（`server/lib/auth.mjs`）：无 `Origin` 头的请求（curl / 本机脚本 / MCP 客户端）
**不算跨源，直接放行**，由令牌把关；有 `Origin` 且不在白名单 → 403。

### 3.3 模型端点 `newapi` 与默认模型 `ai`

| 字段 | 默认 | 含义 | 留空会怎样 |
|---|---|---|---|
| `newapi.baseUrl` | `''` | OpenAI 兼容端点根地址（面板类接口如 `/api/user/self` 与 `/v1/chat/completions` 都在它下面） | 面板类调用直接回「还没填 NewAPI 地址：设置 → NewAPI 地址」 |
| `newapi.token` | `''`（**敏感**） | 面板系统令牌 | 「还没填 NewAPI 面板令牌」 |
| `ai.model` | `''` | 默认对话模型名 | AI 相关功能会报错（没模型可调） |
| `ai.models` | `[]` | 可选模型清单（问答页 / 随记页的下拉用） | 只显示 `ai.model` 一个 |
| `ai.maxTokens` | `1500` | 单次回答的 token 上限（**注意**：模型类调用现在统一走 `server/lib/llm.mjs` 的预算守卫，那里按输入体量算并允许放大；这个值只在少数直连处生效） | — |
| `ai.temperature` | `0.6` | 采样温度 | — |
| `ai.persona` | `'服务对象是一名在校大学生'` | 系统提示词里「服务对象」那半句（**中性默认，谁用谁改**） | 代码里还有一份同样的兜底（`ai.mjs:107`） |
| `ai.personaPrivate` | `''`（**敏感**） | 可选的补充身份（学校 / 专业…），落 `credentials.json` | 不拼进提示词 |

### 3.4 工作站自身 `workstation` 与 `startupDir`

| 字段 | 默认 | 含义 |
|---|---|---|
| `workstation.autostartEntry` | `'Workstation.lnk'` | 启动文件夹里那条自启项的**文件名**，也就是「任务管理器 → 启动应用」显示的名字 |
| `workstation.autostartLog` | `'logs/sidecar-autostart.log'` | 自启脚本的输出日志（追加）。相对 `ROOT_DIR` |
| `startupDir` | 由 `os.homedir()` 推导：`<home>/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup` | 启动文件夹目录。**不硬编码用户名**（`config.mjs:57-60`） |

⚠️ **别把 `startupDir` 手工设成 `""`**。合并时空串会覆盖掉推导出来的默认值，
`autostart.startupDir()` 返回 `''`，`path.join('', 'Workstation.lnk')` 就成了相对路径 ——
自启位会写到进程 cwd 下。`server/config.example.json:36` 里恰好是 `""`，
**照着它整份复制成 `config.json` 会踩这个坑**（那份模板程序不读，但人会抄）。

### 3.5 转写后端 `asr`

只有一个实现：OpenAI 兼容的 `/audio/transcriptions`（`server/lib/asr.mjs:1-17`）。

| 字段 | 默认 | 含义 | 留空会怎样 |
|---|---|---|---|
| `asr.provider` | `'openai'` | `openai` = 走 OpenAI 兼容转写；`none` = 关掉转写 | `none` → 语音随记模块**从侧边栏隐藏** |
| `asr.baseUrl` | `''` | 例如 `http://127.0.0.1:8080/v1`（本机 whisper 网关）或云端 | 空 → `visible()` 为 false，**模块隐藏** |
| `asr.model` | `'whisper-1'` | 模型名 | — |
| `asr.language` | `''` | 提示语言（ISO-639-1，如 `zh`/`en`） | 空 = 让服务端自己判断 |
| `asr.timeoutSec` | `600` | 单次转写请求超时（秒）。下限被夹到 30（`asr.mjs:30`） | — |
| `asr.apiKey` | （不在 `DEFAULTS` 里，**敏感**） | 转写后端的 key；本机服务不需要就留空 | 有 key 才写这一项 |

### 3.6 本机视图扩展 `procscan`

| 字段 | 默认 | 含义 |
|---|---|---|
| `procscan.agentExtras` | `[]` | 「智能体」视图的本地扩展。每项形状 `{ id, images: ['进程名'], hints: ['命令行片段'] }`。`images` 直接命中进程名（`.exe` 可省），`hints` 只在 node/python/pwsh 这类主机解释器里查命令行。识别逻辑见 `server/lib/procscan.mjs` |

出厂为空：不加就只认内置那套规则。

### 3.7 进程守护 `pguard`

**这里只放「开不开、数据放哪」；规则阈值与名单不在 `config.json`** ——
它们在 `dataDir` 下的 `pguard/config.json` 里，由页面「参数」「名单」两页按白名单改。

| 字段 | 默认 | 含义 | 留空会怎样 |
|---|---|---|---|
| `pguard.enabled` | `true` | 边车启动时是否拉起引擎（关掉后页面上仍可手动启动） | — |
| `pguard.dataDir` | `''` | 引擎数据目录（配置 / 审计 / 日志） | 空 = `SERVER_DIR/data/pguard`（**注意**：这条不走 `dataDir()`，见 §9.2） |

出厂是**演练模式**（`dryRun: true`，写在引擎自己的配置里，不在这个文件）：
照常评估、照常写审计，但不动手。

### 3.8 全站能力：`llm` / `embedding` / `search` / `docparse` / `network` / `outputLanguage`

这几节 2026-09-24 从 `wiki.*` 提到顶层，理由：它们是**全站能力**，不是某个模块的私产。
知识库、问答、随记、看板 AI 都读这一份。

#### `llm`（模型预设 + 任务路由）

| 字段 | 默认 | 含义 |
|---|---|---|
| `llm.activePresetId` | `'workstation'` | 当前预设。`workstation` = **跟随工作台**（用 `newapi.baseUrl` + `llm.keys.workstation`） |
| `llm.configs` | `{}` | 每个预设一份配置（`baseUrl` / `model` / `apiMode` / `maxContextSize`…） |
| `llm.keys` | `{}`（**敏感**） | 每个预设的 api key，按预设 id 存 |
| `llm.customPresets` | `[]` | 自定义预设（内置预设表在 `server/lib/wiki-llm.mjs` 的 `PRESETS`） |
| `llm.taskRouting` | `{chat:'',ingest:''}` | 任务路由：对话与编译可各指一个预设；**留空 = 用 `activePresetId`** |
| `llm.reasoning` | `'auto'` | `auto` = 让模型自己决定思考；`off` = 明确关掉（部分模型支持） |
| `llm.maxContextSize` | `128000` | 上下文预算（字 / token 级的粗算，用于截断原始资料） |

> 代码注释里曾经有「跟随工作台时读作者机器 AI 客户端 provider」的说法（`wiki-llm.mjs:126,258,348`）——
> 那条跨应用读取通道**已经删掉**，注释也已按实际来源改过：就是本节这两项（`newapi.mjs:66-71`）。

#### `embedding`（语义检索的嵌入端点）

| 字段 | 默认 | 含义 | 留空会怎样 |
|---|---|---|---|
| `embedding.enabled` | `false` | 是否启用语义检索 | 关 → 检索自动退回词法 |
| `embedding.endpoint` | `''` | 例如 `http://127.0.0.1:11434/v1/embeddings`（本机 ollama） | 空 → 语义不可用，**自动退回词法，不报错** |
| `embedding.model` | `'bge-m3'` | 嵌入模型名 | — |
| `embedding.apiKey` | `''`（**敏感**） | 有的端点要 key | — |
| `embedding.batchSize` | `8` | 每批编码多少块 | — |
| `embedding.concurrency` | `2` | 并发批数 | — |
| `embedding.chunkChars` | `500` | 每块字数（下限夹到 200） | — |
| `embedding.chunkOverlap` | `80` | 块间重叠，防切断关键句 | — |
| `embedding.maxPages` | `5000` | 参与索引的最大页面数（防手滑把整个硬盘导进来） | — |
| `embedding.outputDimensionality` | `0` | Gemini 的降维参数（OpenAI 兼容端点会忽略） | `0` = 不设 |
| `embedding.extraHeaders` | `{}` | 自建网关的额外鉴权头 | — |

#### `search`（网络搜索 + 本机文件检索）

| 字段 | 默认 | 含义 |
|---|---|---|
| `search.provider` | `'none'` | 网络搜索提供方：`none` / `serpapi` / `searxng` / … （完整表见 `server/lib/wiki-websearch.mjs`） |
| `search.apiKey` | `''`（**敏感**） | 搜索服务的 key（无 key 的 provider 可留空） |
| `search.serpApiEngine` | `'google'` | SerpAPI 用哪个引擎 |
| `search.searXngUrl` | `''` | 自建 SearXNG 的地址 |
| `search.searXngCategories` | `['general']` | SearXNG 分类 |
| `search.ollamaUrl` | `'https://ollama.com'` | ollama 的搜索端点 |
| `search.providerConfigs` | `{}` | 各 provider 的额外配置 |
| `search.defaultSource` | `'wiki'` | 问答默认检索哪儿：`wiki` / `web` / `anytxt` / `all` |
| `search.maxResults` | `10` | 单次结果条数 |
| `search.anyTxt.enabled` | `false` | 本机文件全文检索（要装 AnyTXT） |
| `search.anyTxt.endpoint` | `'http://127.0.0.1:9920/'` | AnyTXT 的本地端口 |
| `search.anyTxt.filterDir` / `filterExt` / `limit` | `''` / `''` / `20` | 检索范围与条数 |

#### `docparse`（文档解析）

| 字段 | 默认 | 含义 | 留空 / 缺工具会怎样 |
|---|---|---|---|
| `docparse.mineru.enabled` | `true` | 云端 MinerU 作为**首选**通道 | 关 → 回落本机通道 |
| `docparse.mineru.endpoint` | `'https://mineru.net/api/v4'` | 云端端点 | — |
| `docparse.mineru.modelVersion` | `'vlm'` | `vlm` = 视觉大模型（扫描件与复杂版式更稳）；`pipeline` = 传统流水线 | — |
| `docparse.mineru.language` | `'ch'` | 文档语言 | — |
| `docparse.mineru.isOcr` | `true` | 开 OCR：**扫描版 PDF 只有开着它才有文字** | — |
| `docparse.mineru.timeoutSec` | `300` | 轮询上限（长论文要几分钟） | — |
| `docparse.mineru.token` | `''`（**敏感**） | MinerU 令牌 | 空 → 云端不可用，回落本机通道 |
| `docparse.tools.pandoc` | `''` | pandoc 可执行文件路径 | 空 = **自动**：先按 PATH（`where`/`which`）找，再回落常见安装位 |
| `docparse.tools.soffice` | `''` | 同上。**必须是 `soffice.com` 不是 `soffice.exe`**（`.exe` 是 GUI 子系统程序，无控制台时会挂到超时） | 同上 |
| `docparse.tools.python` | `''` | Python 解释器（pptx/xlsx 用它，要 `python-pptx`+`openpyxl`） | 同上 |
| `docparse.tools.pdftotext` | `''` | pdftotext（Xpdf / poppler 都行） | 同上 |

⚠️ **隐私提示**：MinerU 开着时**文档会上传到 mineru.net**。这是第三方云端解析，
页面上有标注；介意就把 `docparse.mineru.enabled` 关掉，只走本机通道。

⚠️ **已知缺陷**：`docparse.tools.*` 这四个字段**在设置页里能填、但保存会被服务端拒绝** ——
`CONFIG_EDITABLE.docparse` 只放行 `mineru`（`server/index.mjs:633`），
而页面会 PATCH `docparse.tools`（`src/views/SettingsView.vue:187`），
结果是弹一句「已保存，但这些字段被拒绝：docparse.tools」。
要现在就用这四个字段，直接编辑 `server/config.json`。

#### `network` 与 `outputLanguage`

| 字段 | 默认 | 含义 |
|---|---|---|
| `network.proxy.enabled` | `false` | 是否让本模块自己的外呼走代理（网络搜索 / 抓链接 / 云端解析） |
| `network.proxy.url` | `''` | 例如 `http://127.0.0.1:7890` |
| `outputLanguage` | `'Chinese'` | 编译与问答的提示词按它写（`Chinese` / `English` / `auto`） |

### 3.9 知识库 `wiki`

| 字段 | 默认 | 含义 | 留空会怎样 |
|---|---|---|---|
| `wiki.dir` | `''` | 知识库根目录（`wiki/` 存编译出的页面，`raw/` 存不可变原始资料）。**默认库**；当前库记在 `data/wiki-projects.json`，页面上可切 | 空 → **模块从侧边栏隐藏** |
| `wiki.model` | `''` | 编译/问答用哪个模型 | 空 = 用全局 `ai.model` |
| `wiki.maxChars` | `24000` | 单次编译最多喂给模型多少字（超长截断） | — |
| `wiki.chatMaxTokens` | `1600` | 问答单次回答的 token 上限 | — |
| `wiki.watchEnabled` | `false` | 源目录监听总开关 | 关 = 不扫 |
| `wiki.watchAutoIngest` | `false` | 发现新文件是否**自动**编译入库 | 关 = 只排队，等人点。**默认关的理由：开了会后台自己花模型额度** |
| `wiki.watchIntervalMin` | `30` | 扫描周期（分钟） | — |
| `wiki.watchMaxFileSizeMb` | `100` | 单个文件大小上限 | — |
| `wiki.watchDirs` | `[]` | 要盯的目录 | 空 = 只盯当前库的 `raw/sources` |
| `wiki.watchExcludeDirs` | `['.git','.svn','.hg','.obsidian','.idea','.vscode','node_modules','.cache','__pycache__','.trash']` | 排除目录 | — |
| `wiki.scheduledImport` | `{enabled:false, intervalMin:60}` | 按周期把监听目录里的新文件排进队列 | — |

`wiki.*` 里还有五节 **只读镜像**：`llm` / `search` / `output` / `network` / `mineru` /
`embedding`，以及旧的 `wiki.mineru`。它们由顶层的同名配置在启动时同步过来（带 `_mirror` 标记），
**不要手改** —— 改了下次启动会被覆盖。改配置改顶层（§3.8）。

---

## 4. 页面上能改什么（白名单）

改配置推荐走页面「设置与数据」：那里的写入是**白名单式**的 —— 一个手滑（或前端传了个多余字段）
不会把边车自己的配置写坏（写坏之后连「打开设置页改回来」都做不到）。
服务端放行清单分**两张**（都在 `server/index.mjs`），按「这一项在 `config.json` 里的形状」分：

**① `CONFIG_EDITABLE` —— 分节（值是对象）**，逐子字段放行：

| 分节 | 放行的字段 |
|---|---|
| `newapi` | `baseUrl` |
| `ai` | `model` `models` `maxTokens` `temperature` `persona` `personaPrivate` |
| `workstation` | `autostartEntry` `autostartLog` |
| `pguard` | `enabled` `dataDir` |
| `llm` | `activePresetId` `configs` `keys` `customPresets` `taskRouting` `reasoning` `maxContextSize` |
| `embedding` | `enabled` `endpoint` `model` `apiKey` `batchSize` `concurrency` `chunkChars` `chunkOverlap` `maxPages` `outputDimensionality` `extraHeaders` |
| `search` | `provider` `apiKey` `serpApiEngine` `searXngUrl` `searXngCategories` `ollamaUrl` `providerConfigs` `defaultSource` `maxResults` `anyTxt` |
| `docparse` | `mineru`（**没有 `tools`**，见 §3.8 的已知缺陷） |
| `network` | `proxy` |
| `wiki` | `dir` `model` `maxChars` `chatMaxTokens` `embedding` `mineru` `llm` `search` `output` `network` `scheduledImport` `watchEnabled` `watchAutoIngest` `watchIntervalMin` `watchMaxFileSizeMb` `watchDirs` `watchExcludeDirs` |
| **不在表里的** | `port`、`auth.*`、`dataDir`、`asr.*`、`procscan.*` —— **只能手工编辑 `config.json`** |

**② `CONFIG_EDITABLE_SCALARS` —— 标量（值是字符串 / 数字 / 布尔）**，整项放行：

| 顶层键 | 放行原因 |
|---|---|
| `startupDir` | 启动文件夹绝对路径（留空 = 自动取 `%APPDATA%` 下那个） |
| `outputLanguage` | 输出语言单值下拉：`Chinese` / `English` / `auto`（设置页那一栏） |

> 为什么标量要单列一张表：分节那条循环用 `typeof v !== 'object'` 判形状，标量会被当成
> 「无效分节」直接拒掉。`outputLanguage` 曾经就是这么坏的 —— 页面发
> `{"outputLanguage":"English"}`、服务端回 `{ok:false,error:'没有可改的字段（被拒绝：outputLanguage）'}`，
> 而页面把 200 当成功。加新配置项时**两张表 + `DEFAULTS` 都要动**，
> `scripts/tests/config-whitelist.test.mjs` 会替你查漏（见 §10）。

被拒的字段不会让整个请求失败：响应里带 `rejected: ['docparse.tools']`，
页面会提示「已保存，但这些字段被拒绝：…」。`GET /api/config` 同时返回
`config`（脱敏副本）、`defaults`（设置页「恢复默认值」用）、`editable`（分节那张表）、
`editableScalars`（标量那张表，数组）、`path`。

> ⚠️ `asr.*` 也不在 PATCH 白名单里，但设置页确实有转写后端那一栏并会 PATCH `asr`
> （`src/views/SettingsView.vue:185`）—— 与 `docparse.tools` 同一类问题。
> 结果是**转写端点也只能手工编辑 `config.json`**。

---

## 5. 环境变量

边车本身只认下面这些（`grep` 全仓确认过的清单）：

| 变量 | 谁读 | 作用 | 默认 |
|---|---|---|---|
| `WS_PORT` | `server/index.mjs:49`；`scripts/restart-sidecar.py:69`；`scripts/sidecar-keepalive.py:28` | 覆盖监听端口 | `config.json` 的 `port` → `5278` |
| `WS_DATA_DIR` | `server/config.mjs:397`（`dataDir()`）；`plan.mjs:20`、`summaries.mjs:30`、`usage-cache.mjs:20`、`vocab.mjs:39` 各抄了一份 | 覆盖数据目录（**测试用**：把数据写到别处，不碰真实数据） | `config.json` 的 `dataDir` |
| `WS_NODE` | `scripts/restart-sidecar.py:41`；`scripts/sidecar-keepalive.py:12` | 指定用哪个 `node.exe` | 先 PATH（`shutil.which('node')`），再常见安装位 |
| `USAGE_LIVE_SEC` | `server/lib/usage-cache.mjs:24` | 用量缓存「轻同步」周期（秒），下限夹到 15 | `60` |
| `USAGE_FULL_SEC` | `server/lib/usage-cache.mjs:25` | 「全量同步」周期（秒），下限 = `LIVE_SEC` | `300` |
| `VITE_SIDECAR_URL` | `src/core/sidecar.ts:17`（构建期注入，类型在 `src/types/env.d.ts:11`） | 前端调边车的地址。**留空 = 同源相对路径**（生产态本来就同源） | `''` |

**被边车主动清掉的**（`server/index.mjs:55-58`，故意为之）：

```
HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / http_proxy / https_proxy / all_proxy  → 删除
NO_PROXY = '*'                                                                → 强制设置
```

理由：本机边车的出网目标（模型端点 / 网络搜索 / 抓链接）都是公网直连，
终端或沙箱注入的代理会把请求截到本地代理端口 —— 轻则慢，重则让用量缓存的定时同步
**整轮静默失败**（页面拿到空缓存，看起来像「额度页坏了」）。
所以「给边车挂代理」这件事不在环境变量里做，而是走 `config.json` 的 `network.proxy`
（这是应用级、按模块生效的代理，而 `HTTP_PROXY` 是给整个进程的）。

**顺带被读的系统变量**（不是配置项，不用管）：`SystemRoot`（找 `wscript.exe`，`panel.mjs:199`）、
`ProgramFiles` / `LOCALAPPDATA` / `APPDATA`（两个 python 脚本找 node、拼启动文件夹路径）。

开发态另有一份 `.env.local`（可选，见 README 的快速开始）：

```
VITE_SIDECAR_URL=http://127.0.0.1:5278
```

---

## 6. 怎么改端口

假设要从 `5278` 改成 `6000`。**下面五处一处都不能漏**：

| # | 位置 | 改什么 | 漏了会怎样 |
|---|---|---|---|
| 1 | `server/config.json` | `"port": 6000` | 端口不变 |
| 2 | `server/config.json` → `auth.allowedOrigins` | 加 `http://127.0.0.1:6000`、`http://localhost:6000` | ⚠️ **页面所有请求 403**：「来源未被允许（Origin 不在白名单）」。因为页面自己的来源就是新端口，而白名单里只有旧端口 |
| 3 | 启动脚本（若用 `WS_PORT` 覆盖） | 环境变量改成 `6000` | 脚本按 5278 探测健康检查，会误判「已在服务」或起不来 |
| 4 | 前端（仅开发态） | `vite.config.ts` 的 `server.port`（这是 Vite 自己的 5273），并在 `.env.local` 里把 `VITE_SIDECAR_URL` 指到新端口 | 开发态页面调不到边车 |
| 5 | 自启位（若开了自启） | 不用改 —— VBS 里没有端口，端口来自 `config.json` | — |

改完重启边车。验证：

```bash
curl -s http://127.0.0.1:6000/api/health
# 期望：{"ok":true,"service":"workstation","version":"0.1.0","port":6000,...}
```

`/api/health` 免令牌，所以这条 curl 不需要带 `X-WS-Token`。
注意边车的静态服务、`scripts/start.mjs`（用 `cfg.port`）、`dev-all.mjs`（用 `cfg.port`）、
`panel.sidecarStatus()`（用 `cfg.port`）都读同一份配置，改 `config.json` 它们会一起跟上；
只有**白名单是手写的**，必须自己加。

---

## 7. 怎么关鉴权 / 怎么用令牌

### 7.1 关掉两道闸

```jsonc
// server/config.json
{ "auth": { "enabled": false } }
```

效果：`auth.needsToken()` 对任何路径都返回 false（`auth.mjs:44-45`），
`/api/*` 与 `/mcp` 不再要令牌。**Origin 白名单那一关也一起失效**吗？不 ——
白名单判定在边车入口（`index.mjs:1206`）独立执行，与 `enabled` 无关，
非白名单来源仍然 403。要连它一起放开，就把来源加进 `allowedOrigins`。

关掉意味着：**本机任何网页都能读写你的看板、词单、知识库、进程操作**。
只在一人一台、且你清楚风险的机器上这么做。

### 7.2 加白名单（比关鉴权更好的办法）

```jsonc
{ "auth": { "allowedOrigins": ["http://127.0.0.1:5278", "http://localhost:5173"] } }
```

给「自己写的另一个前端页面」用这条；不要把 `*` 或陌生域名加进来。

### 7.3 换令牌

没有页面入口（设置页不暴露 `auth.*`）。做法：编辑 `server/config.json`，
把 `auth.token` 删掉或设为 `""`，重启边车 —— `loadConfig()` 会在启动时生成新令牌并写回
（`:560-573`）。页面会通过 `/api/auth/token` 自动取到新令牌，不用手工同步。

### 7.4 脚本 / MCP 客户端怎么带令牌

三种写法都认（`auth.tokenFromRequest()`，`auth.mjs:52` 起）：

```bash
# 1. 首选：请求头
curl -s -H "X-WS-Token: <token>" http://127.0.0.1:5278/api/dashboard/day

# 2. Authorization: Bearer
curl -s -H "Authorization: Bearer <token>" http://127.0.0.1:5278/api/dashboard/day

# 3. 查询参数（只有 <video>/<img> 这类传不了头的场景才用，会进浏览器历史）
curl -s "http://127.0.0.1:5278/api/vocab/audio?q=test&token=<token>"
```

令牌的值在 `server/config.json` 的 `auth.token`（**别把它贴进任何文档或对话**）；
页面自己走 `/api/auth/token` 取，那个接口只对白名单来源开放。

免令牌的白名单只有两个路径：`/api/health`、`/api/auth/token`。

---

## 8. 哪些绝对不能提交

`.gitignore` 已经拦下下面这些（逐条对照过 `.gitignore`）：

| 不能提交 | 为什么 | 忽略规则 |
|---|---|---|
| `server/config.json` | 里面有**可用的边车访问令牌** `auth.token`，以及你这台机器的目录 | `server/config.json` |
| `server/credentials.json` | 面板令牌、模型 API Key、MinerU 令牌、`personaPrivate` 身份信息 | `server/credentials.json` + 兜底 `**/*secret*.json` |
| `server/data/**` | 看板记录、词单与学情、知识库向量与聊天、录音、转写、审计、缓存、每日快照 | `server/data/*`，只 `!` 放行 `.gitkeep` / `README.md` / `dashboard.json` / `plan.json` / `school-calendar.json` / `vocab/lists.json` / `vocab/progress.json` |
| `logs/` | 运行日志；截图里含个人身份与院校数据，故整目录忽略 | `logs/`（整目录；光靠 `*.log` 挡不住） |
| `Workstation.vbs` | 运行时产物，由 `panel.mjs` 按 `process.execPath` 生成，**根本不需要入库** | `Workstation.vbs` |
| `.env` / `.env.*` / `*.session` / `*.pem` / `*.key` / `cookies*` | 通用凭据与会话 | 对应五行 |
| `/data/` | 本机 sqlite（别的一次性脚本留下的库文件） | 对应的那一行 |
| `node_modules/`、`dist/`、`dist-ssr/`、`.vite/`、`*.local` | 依赖与构建产物 | 对应五行 |

### 8.1 提交前自查

```bash
# 1) 有没有本该忽略的东西被加进来
git status --short

# 2) 某个文件到底被哪条规则管（或没被管）
git check-ignore -v server/config.json server/credentials.json logs/x.log

# 3) 数据目录里只该出现那 7 个示例文件
cd server/data && git status --short .

# 4) 万一曾经用 git add -f 强加过：查历史里有没有敏感文件
git log --all --oneline -- server/config.json server/credentials.json server/data logs | head

# 5) 全仓扫一遍「像密钥 / 像本机路径」的字符串
grep -rniE "sk-[a-z0-9]{16,}|C:\\\\Users|D:\\\\|/Users/" --include='*.json' --include='*.mjs' \
  --include='*.ts' --include='*.vue' --include='*.md' . | grep -v node_modules
```

> 那条真问题**已经清掉**：`server/config.example.json` 里的 `dataDir` 曾写着一条作者的绝对路径，
> 现在整项已从模板里删除（只留 `"// dataDir"` 说明键）—— **别改成 `""`**，空串不是「用默认」，
> 相对路径会落到进程 cwd。详见 [ARCHITECTURE.md §6.5](ARCHITECTURE.md) 的漂移表。
>
> 跑这条命令时**仍会命中几行，这是预期的**：命中的都是「文档在讨论这个形状」——
> 本文件里这条命令自己（模式里的盘符转义写法）、[PRIVACY.md](PRIVACY.md) §7.2 与 §8 里
> 用占位符写出来的形状示例、`vite.config.ts` 里讲「cwd 盘符可能是小写」的那句注释。
> 判断标准见 [PRIVACY.md](PRIVACY.md) 第 7.2 节 ⑧：中性占位符（`C:\资料\…`）可以留，
> 带个人痕迹的（`C:\<装 node 的目录>\…`）必须清。

---

## 9. 已知的坑

### 9.1 配置没生效？先分清「有没有重启」

- `config.json` 在**模块加载时缓存**（`cached`）。用 `PATCH /api/config` 改的会立刻生效；
  直接编辑文件改的**要重启边车**。
- 「设置与数据」页写着「地址 / 目录改动在相关服务重启后生效」—— 端口、目录、白名单都属于这类。
- 有些项是**启动时读一次**就不再看配置文件：`usage-cache` 的周期（环境变量，要改就重启）、
  以及手工编辑 `config.json` 里的 `port` / `auth.*` / `dataDir` / `pguard.dataDir`
  —— `loadConfig()` 有内存缓存，写文件不会让运行中的边车改主意。
  用页面或 `PATCH /api/config` 改的会立刻生效（`saveConfig()` 会重算缓存）。
- 例外（**不用重启**）：`wiki-queue` 的监听设置改完页面会立刻重排定时器
  （`server/index.mjs:909-915`）；pguard 的规则阈值与名单每次 `tick()` 重新读，
  带 5 秒 mtime 缓存（`server/lib/pguard.mjs:183-203,631`）。

### 9.2 `dataDir` / `WS_DATA_DIR` 现在推不动全部模块

`server/config.mjs` 导出了 `dataDir()` 当唯一入口，但仓库里**只有一部分模块真的走它**。
完整的分裂清单（谁认、谁不认、谁干脆写死在仓库里）见
[ARCHITECTURE.md §6.4](ARCHITECTURE.md)。
结论：**要挪数据目录，改 `config.json` 的 `dataDir`**，并且知道
`server/data/cache/overview.json`（`index.mjs:148`）与 `dataDir/pguard`（`pguard.mjs:46-48`）
这两份搬不走。

### 9.3 别整份抄 `config.example.json`

那份模板**程序不读**，它只是给人看的（每条上面还有 `// 说明` 键）。
拿它整份覆盖 `config.json` 会踩两个坑：
① `startupDir: ""` 会覆盖掉按 `os.homedir()` 推导的默认值（见 §3.4）；
② 里面带着历史迁移留下的 `wiki.{llm,embedding,search,mineru,network,output}` 只读镜像节。

### 9.4 改了 `wiki.*` 里的全站节，白改

顶层与 `wiki.*` 有六节是**镜像关系**（§2.4）。启动时会用顶层覆盖 `wiki.*`。
判断依据：`wiki.*` 里那几节带 `_mirror: "只读镜像：以顶层同名配置为准…"`。

### 9.5 脱敏串不会覆盖真值（这是有意设计的）

`saveConfig()` 对以 `****` 开头的值和空串一律跳过。所以**「把密钥清空」这件事
不能靠页面把输入框清空来做** —— 空串被解释成「不改」。要撤掉某个密钥，
直接编辑 `server/credentials.json` 删掉那一项。

### 9.6 `auth.token` 不会变空

即使写入的配置里把令牌设成空，`saveConfig()` 也会在最后补一个新令牌（`:633-636`）。
想换令牌就照 §7.3 做；想彻底不要令牌就关 `auth.enabled`。

---

## 10. 加一项配置要改哪几处（以及漏了会怎样）

配置项有**三处**，缺一处不会报错，只会在某个地方表现为「改不动」或「别人不知道有这一项」：

| # | 改哪 | 作用 | 漏了的表现 |
|---|---|---|---|
| 1 | `server/config.mjs` 的 `DEFAULTS` | 这一项存在，且有出厂值 | 读到的永远是 `undefined`，模块按「没配」处理 |
| 2 | `server/lib/config-editable.mjs` 的白名单 | 页面上改得动 | 页面 PATCH 被拒、`rejected` 里点名（**但页面把 HTTP 200 当成功**，所以看着像「保存了没生效」） |
| 3 | `server/config.example.json` | 别人知道有这一项、怎么填 | 陌生人不知道有它 |

第 2 处**分两张表**，判据是「这一项在 `config.json` 里是什么形状」：

- 值是**对象**（一个分节）→ 加进 `CONFIG_EDITABLE` 的对应分节数组；
- 值是**字符串 / 数字 / 布尔**（标量）→ 加进 `CONFIG_EDITABLE_SCALARS`。
  标量项误放进 `CONFIG_EDITABLE`（尤其写成空数组）的后果就是**永远改不动** ——
  分发处的分节循环用 `typeof v !== 'object'` 判形状，字符串一律被算成「无效分节」。
  `outputLanguage` 就是真踩过的这一脚（2026-09-27 修）。

如果这一项是**密钥**，还要在第 1 步之后加进 `SECRET_PATHS`（`server/config.mjs`），
它会自动落到 `credentials.json`、响应里自动脱敏成 `****后四位`，详见 §2。

### 10.1 有没有东西替我查漏

有：`npm test` 里的 **`scripts/tests/config-whitelist.test.mjs`**（零依赖、不连网、不读真实数据），
它做四件对账：

1. `config.example.json` 去掉 `"//*"` 与 `_readme` 之后的每个顶层键，都必须能在 `DEFAULTS` 里找到
   （反向不要求 —— 模板可以少写）；
2. `CONFIG_EDITABLE` 的每个值必须是**非空数组**，里面的每个字段必须真在 `DEFAULTS` 的对应分节里存在
   （放行一个不存在的字段会让 PATCH 把垃圾写进 `config.json`）；
3. `CONFIG_EDITABLE_SCALARS` 的每一项都必须在 `DEFAULTS` 里**且确实是标量**；
4. 两张表不重叠，且 `outputLanguage` / `startupDir` 这两个「页面发字符串下来」的键留在标量表里。

所以加配置项的规矩可以简化成一句：**改完跑 `npm test`，红了就照它点名的位置补。**

---

相关文档：[ARCHITECTURE.md](ARCHITECTURE.md)（分层、启动与生命周期、已知限制）、
[FEATURES.md](FEATURES.md)（功能清单与依赖）、
[verifying.md](verifying.md)（改完怎么验）、
[校历格式.md](校历格式.md)（`server/data/school-calendar.json` 的字段语义）、
[文件传输.md](文件传输.md)（想接 WebDAV / S3 / rclone 时该实现什么）。
