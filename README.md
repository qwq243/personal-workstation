# 工作站 Workstation（开源版）

**一句话**：一个跑在自己电脑上的个人工作台 —— Vue 3 页面 + 一个只监听 `127.0.0.1` 的本地边车（Node，只用内置模块），功能以「模块」为单位插拔。

**一段话**：前端是「内核 + 功能模块」的结构。内核（`src/core/`、`src/router/`、`src/shell/`）负责路由、侧边栏、存储、主题与边车客户端；每个功能自己一个目录（`src/features/<名字>/`），通过 `module.ts`（一个目录装多个模块时用 `<id>.module.ts`）向 `src/core/registry.ts` 登记自己（id / 名称 / 图标 / 路由 / 可选的可见性钩子）—— **侧边栏、首页卡片、路由表全部由这张注册表派生**，所以加功能**不需要改 `src/core/`、`src/router/`、`src/shell/`**。但「不用改内核」不等于「一个文件都不用动」：新图标要在 `src/main.ts` 的白名单里加**两处**（import 与 `ICONS` 映射，漏了不报错、只表现成那块图标是空白），后端能力要在边车的 `server/lib/*.mjs` 里写、再在 `server/index.mjs` 里挂一条 `/api/*`。完整清单（纯页面 / +接口 / +配置 / +MCP 各动几个文件）见 [docs/EXTENDING.md §2](docs/EXTENDING.md)。边车存在的三个理由：绕开浏览器的 CORS、把密钥留在浏览器之外、做浏览器做不到的本机操作（扫进程、读端口、写启动项、起子进程）。它只监听回环地址，并且有两道闸：**Origin 白名单 + 本地令牌**。

---

## 核心特性

- **一个扩展点**：`src/core/registry.ts`。`registerModule()` 之后，侧边栏分组、首页卡片、路由表自动生成（`getGroupedModules()` / `collectRoutes()`）。
- **加功能有脚手架，还有护栏**：`node scripts/new-feature.mjs <id>` 一条命令建模块 + 注册 + 补图标白名单（+ `--api` 后端骨架、`--config` 配置三处）；骨架与替换表在 `src/features/_template/`。`npm test` 里的 `module-contract` / `config-whitelist` 两条会替你把「漏了不报错」的那几处（没注册、图标没进白名单、配置项漏挂）变成红色。
- **边车零第三方依赖**：`server/` 下没有任何 `import` 指向 npm 包 —— 只有 `node:` 内置模块与相对路径。前端依赖也只有 Vue 3 / vue-router / pinia / Element Plus / KaTeX。
- **访问控制不是可选项**：边车只监听回环，但浏览器里任何网页都能 `fetch('http://127.0.0.1:5278/...')`。所以有 `server/lib/auth.mjs` 的两道闸：Origin 白名单（非白名单来源 403）+ 本地令牌（`/api/*` 与 `/mcp` 要带 `X-WS-Token`，首次运行随机生成）。
- **数据是加固写盘**：`server/lib/jsonstore.mjs` 给「不能丢」的 JSON 提供原子写、`.bak` 回退、每日快照、坏文件留证（`.corrupt-<时间>`）与 `rev` 乐观并发。
- **单实例闸**：`server/lib/singleton.mjs` 只收掉「命令行指向本项目 `server/index.mjs`」的旧实例，别的 node 进程一律不碰；端口被陌生进程占着时只报错退出。
- **长任务一律「起任务 + 轮询」**：转写、文档解析、入库编译都不在一个请求里等完（Node 默认 `requestTimeout` 是 5 分钟）。
- **「没配 = 不显示」是内核约定**：模块的 `visible()` 在依赖的目录 / 端点没填时返回 false，它就从侧边栏消失，而不是点进去看一页报错（`src/core/appconfig.ts`）。
- **配置分层**：非敏感配置与密钥分两个文件放，密钥由 `SECRET_PATHS` 自动分流，仓库里只提交带说明的模板。
- **给智能体留了入口**：边车上挂了一个 MCP（JSON-RPC 子集，`/mcp`），43 个工具覆盖看板、规划台、词单、知识库、语音随记、进程与端口查询。

## 架构一览

```
┌────────────────────────── 浏览器（Vue 3，src/） ──────────────────────────┐
│  src/shell/AppShell.vue      侧边栏（按大模块归组）+ 顶栏 + 面包屑         │
│  src/views/                  全部应用 · 设置与数据 · 扩展开发 · 404        │
│  src/features/<模块>/        一个功能一个目录：module.ts + 自己的页面      │
│  src/core/                   注册表 · 类型 · 存储 · UI · 边车客户端        │
│  src/router/                 路由 = 内核固定几页 + 注册表派生（hash 模式） │
└─────────────────────────────────┬──────────────────────────────────────────┘
                                  │  fetch（默认同源相对路径；开发态指到 5278）
                                  │  Origin 白名单 + X-WS-Token
┌─────────────────────────────────▼──────── 本地边车 server/index.mjs ──────┐
│  两道闸（server/lib/auth.mjs）：Origin 白名单 → 本地令牌                   │
│  路由表：route(method, /^\/api\/x$/, handler)  →  /api/* 与 /mcp          │
│  能力库：server/lib/*.mjs（一件事一个文件，零第三方依赖）                  │
│  启动收口：单实例闸 · 静态服务 dist/ · 路由异常兜底（try/catch）          │
└───────────────┬─────────────────────────────────┬──────────────────────────┘
                │                                 │
   server/data/（本机数据）                外部端点（模型 / 嵌入 / 搜索 / 云端解析）
   原子写 + .bak + 每日快照                 密钥留在 credentials.json，不进浏览器
```

### 为什么要有本地边车

不是「为了好看的多层架构」，是三个具体问题（`server/index.mjs` 头部也写了）：

1. **CORS**：很多自建 / 第三方服务不回 CORS 头，浏览器直连必被挡。把外呼收进边车，前端只跟 `127.0.0.1` 说话。
2. **密钥不进浏览器**：前端只有本地令牌；真正的外部 API Key 留在 `server/credentials.json`，由边车代发请求。
3. **本机能力只有 Node 能做**：扫进程表、读端口占用、写启动文件夹、起子进程、读本地文件 —— 浏览器一律做不到，而它们恰好是「本机工作台」的主要内容。

「只监听回环」**不等于**「只有你能调」。所以那两道闸不是可选项，细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 快速开始

### 环境要求

**Node.js**：`package.json` 声明了 `engines.node` = `>=22.6`，仓库根也有 `.nvmrc`（`22`）。
下面是实测口径（本机 `node --version` = `v22.20.0`）：

- `npm test`（`node --test`）跑通：4 个文件、36 个用例全过；
- `npm run test:parity` 用了 `node --experimental-strip-types`（在 `.ts` 上直接跑类型剥离），**需要 Node ≥ 22.6**（脚本自己的注释写的是「Node 22 起支持」）—— `engines` 那条下限就是为它定的；
- 对 `server/`、`server/lib/`、`scripts/` 下的 `.mjs` 逐个跑 `node --check`，全部通过。

> `engines` 默认只是**建议**（不配 `engine-strict` 时 npm 只警告不拦）；CI 那条 `node-version: '22'`
> 才是真的门禁。低于 22.6 时应用本身可能跑得起来，但 `test:parity` 会失败。

**操作系统：这是一个 Windows 工具**（页面与纯逻辑跨平台，本机能力不跨）。分开说清楚：

| 能跨平台跑 | 只在 Windows 上可用 |
|---|---|
| 前端与内核：`npm run build` / `npm run dev` / `npm test` / `npm run test:parity` | **进程 / 端口 / 智能体三个视图**：硬调 `tasklist` / `netstat -ano` / `taskkill` / `powershell Get-CimInstance`（`server/lib/net.mjs`、`procs.mjs`、`procscan.mjs`） |
| 边车里「不碰本机」的部分：看板、规划台、词单、校历、知识库读写与检索、MCP | **进程守护引擎**：Windows 工作集 / 待机列表那套（`server/lib/pguard.mjs`） |
| | **开机自启**：启动文件夹 + `.lnk` + `wscript.exe` + UTF-16LE 的 `.vbs`（`server/lib/panel.mjs`、`autostart.mjs`、`src/features/service/`，以及 `scripts/*.py`） |
| | **提权动作**（清系统待机列表）：`Start-Process -Verb RunAs` 弹 UAC（`server/lib/elevate.mjs`） |
| | **文档解析回落通道**：pandoc / LibreOffice（`.com` 与 `.exe` 在 Windows 上不是一回事）/ pdftotext（`server/lib/wiki-parse.mjs`） |

换到 Linux / macOS：页面能开、构建与测试能过，但上面右列那几块要先给这一层**加实现分派**
（按 `process.platform` 分叉），目前**没有做**，文档里也不假装做了 —— 细节见
[docs/ARCHITECTURE.md §6.2](docs/ARCHITECTURE.md)。

### 拿到这份代码

**请用 `git clone`**（或在 GitHub 上点 Download ZIP）—— 这样你拿到的是**版本库里的那份**，
运行时状态一律不在里面：`dist/`、`node_modules/`、`server/config.json`、
`server/credentials.json`、`server/data/` 里的个人数据、`logs/`、`scripts/Workstation.vbs`、`__pycache__/`。

⚠️ **如果是别人「按文件夹拷一份」给你的**（而不是 clone），那份副本很可能带着**他的运行时状态**，
先按下面清一遍再跑：

```bash
# 只列不删：看看除了版本库里的东西，还多带了什么
git clean -xdn

# 手动确认后要删的话（⚠️ 没有 -n 就是真删，且会连你未提交的新文件一起删）
# git clean -xdf

# 不想用 git 的话，按这个清单手动删：
#   dist/                          —— 旧构建产物（npm run build 会重新生成）
#   server/config.json             —— 他的端口、目录、**本地访问令牌**（含令牌就别外传）
#   server/credentials.json        —— 他的模型 Key / 云端令牌（更要删）
#   server/data/ 里除下面这些以外的全部内容 —— 他的看板、词单、向量、录音、审计
#     .gitkeep · README.md · dashboard.json · plan.json · school-calendar.json · vocab/{lists,progress}.json
#   logs/ · scripts/Workstation.vbs · scripts/__pycache__/   —— 日志与运行时产物
```

删完第一次 `npm run server` 时会重新生成 `server/config.json`（含**新的**随机令牌），
数据目录缺文件时按空结构处理 —— 所以「删干净」不会把程序弄坏，见下面「配置与密钥放哪」。
`git clean -xdn` 有个容易误会的地方：`-x` 会**连未提交的新文件一起列出来**（包括你自己刚写的功能），
所以它只是一份「这份副本多带了什么」的清单，别直接 `-xdf` 扫掉手上的活。

### 安装与运行

```bash
npm install
```

**生产模式**（边车同时提供页面与 API）：

```bash
npm run build      # 构建前端到 dist/
npm run server     # 起边车；打开 http://127.0.0.1:5278/
```

`npm run start` 等价于「dist 不存在就先构建，再起边车」（见 `scripts/start.mjs`）：已在服务时它只提示并退出，不会叠起第二个实例。Windows 上也可以双击 `启动工作站.cmd` —— 它跑的就是 `scripts/start.mjs`，**控制台窗口关掉服务就停**。

**开发模式**（前端热更新 + 边车，两个进程）：

```bash
npm run dev:all    # 一条命令起两个：边车（后台）+ Vite（前台）
```

或者分开两个终端：`npm run server` 与 `npm run dev`。

> ⚠️ 开发态前端在 **5273**、边车在 **5278**，而前端默认按**同源相对路径**调边车 —— 直接在 5273 上打开页面会连不上。二选一：
> 1. 在 URL 上带 `?sidecar=127.0.0.1:5278`（临时试）；
> 2. 建一个 `.env.local`，写 `VITE_SIDECAR_URL=http://127.0.0.1:5278`（长期）。

### 端口

| 端口 | 谁 | 怎么改 |
|---|---|---|
| **5278** | 边车：`/api/*`、`/mcp`，生产态还负责发 `dist/` | `server/config.json` 的 `port`；环境变量 `WS_PORT` 优先级更高（`server/index.mjs`） |
| **5273** | Vite 开发服务器（只有开发模式有） | `vite.config.ts` 的 `server.port` |

改端口要一起改：`server/config.json` 的 `auth.allowedOrigins`（否则页面自己的来源被白名单挡掉）与前端 `.env.local` 的 `VITE_SIDECAR_URL`。

---

## 贡献 · 许可 · 从哪读起

**第一次来**：按这个顺序读三份文档，20 分钟就能自己加出一个功能 ——

1. [docs/EXTENDING.md](docs/EXTENDING.md) —— **加功能怎么加**（内核概念 → 三步法 → 加接口 → 加配置 → 长任务约定 → 别这么做的坑）；
2. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §6「取舍与已知限制」—— **它现在哪里不行**（平台绑定、安全边界、数据目录的不一致、已知缺口）；
3. [docs/verifying.md](docs/verifying.md) —— **改完怎么验**。

想直接动手就在项目根跑一条命令（它会连注册、图标白名单、按需的后端文件一起改好）：

```bash
node scripts/new-feature.mjs reading --name 阅读笔记 --icon Reading --group study            # 纯页面
node scripts/new-feature.mjs reading --name 阅读笔记 --icon Reading --group study --api --config   # 带接口与配置
node scripts/new-feature.mjs reading --name 阅读笔记 --icon Reading --dry-run                # 只看会改什么
```

模板与逐项说明在 [`src/features/_template/`](src/features/_template/)；生成器**不允许**产生半截状态
（锚点找不齐、id / 路由 / 图标撞车、生成的页面 SFC 解析不过 —— 任一条不成立就整体不动）。

### 许可证

**MIT** —— 见仓库根的 [`LICENSE`](LICENSE)。你可以自由使用、修改、分发、商用，只需保留那份版权声明与许可全文。

**第三方来源与许可**：见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。摘要：

- **后端（`server/`）零第三方依赖**（只有 `node:` 内置模块），所以那一半没有授权负担；
- 前端依赖**全是宽松许可**，与本项目的 MIT 兼容 —— 直接依赖 6 个（vue / vue-router / pinia /
  element-plus / @element-plus/icons-vue / katex，均 MIT），传递闭包 59 个里非 MIT 的只有
  `entities`（BSD-2-Clause）、`normalize-wheel-es` / `source-map-js` / `speakingurl`（BSD-3-Clause）
  与 `picocolors`（ISC）。
- 随代码分发的非 npm 资源里，`src/assets/katex-fonts/*.woff2` 已核实为上游 KaTeX 自带字体（MIT，
  与 `node_modules/katex/dist/fonts/` 逐字节相同）；**`src/assets/brand/ws-logo.webp` 是唯一一处
  来源待权利人确认**（仓库里没留下出处，文件里也没有署名信息）—— 详见那份文件 §5.2。

只带了**一部分**文件时（例如只拷 `dist/` 给别人）：至少把 `LICENSE` 与
`THIRD-PARTY-NOTICES.md` 一起带上，因为构建产物里内联着上面那些依赖。

### 提交前

四条硬性要求（都是**能自动验**的，不靠自觉）：

```bash
npm test              # 纯逻辑回归（node:test，4 个文件 36 个用例）
npm run typecheck     # vue-tsc --noEmit（含 .vue 模板）
npm run build         # 前端能构建（会连带发现删了模块忘清 import 之类）
npm run server        # 边车能起，看启动日志与 /api/health
```

CI（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)）在 ubuntu 与 windows 两个平台跑前三条 +
`test:parity`。**它刻意不跑 `test:pguard` 与 `npm run server`**：前者要真机的 powershell 采样、
结果随 runner 上跑着什么而变；后者会常驻。这两条要在真机上手工验（见 [docs/verifying.md](docs/verifying.md)）。

提交信息没有强制格式（**没有** commitlint / husky / linter —— 见下面「不引入什么」），
但请写清「改了什么 + 为什么」；一个改动一个提交，别把格式化噪声混进来。

发现问题 / 想加功能：到本仓库的 GitHub Issues 开一条（仓库地址见 `git remote -v`）。
带**复现步骤**与 `npm run server` 的启动日志最有帮助；安全 / 隐私相关请看 [docs/PRIVACY.md](docs/PRIVACY.md)
里「哪六类东西不该进仓库」——**别把密钥贴进 issue**。

几条硬性约定（改代码前先读）：

1. **不要动内核去加功能**。新功能一律走「`src/features/<名字>/` + `registerModule()`」三步法
   （见 [docs/EXTENDING.md](docs/EXTENDING.md)，或者直接跑 `node scripts/new-feature.mjs`）。
2. **不要把个人路径、学号、密钥、令牌写进代码或文档**。要放路径就放配置项，要放密钥就进 `credentials.json`（在 `SECRET_PATHS` 里加一条）。
3. **新配置项要同时改三处**（`DEFAULTS` / 白名单 / `server/config.example.json`），否则别人不知道有这一项；漏了 `npm test` 会点名（见 [docs/CONFIG.md](docs/CONFIG.md) §10）。
4. **不要提交** `server/config.json`、`server/credentials.json`、`server/data/` 里除示例之外的内容、以及 `logs/`；提交前 `git status --short` 看一眼。
5. 样式只引用 `src/styles/tokens.css` 的变量，不要新增硬编码颜色（见 [docs/design-system.md](docs/design-system.md)）。

**不引入什么（这是取舍，不是没做）**：任何 linter / formatter / 测试框架 —— 它们会往 `devDependencies`
里塞东西，破坏「**边车零第三方依赖 + 前端只有 6 个包**」这个卖点（[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §5 把它当核心取舍）。
`node --test` + `vue-tsc` + 上面那几条零依赖脚本已经够用；**也给 `server/` 加任何 npm 包**是同样理由。

**不包含什么（以及为什么）**：仓库刻意不带任何依赖**特定学校私有接口**、**个人账号池**或**对第三方客户端做逆向**的能力 —— 这些东西要么依赖别人拿不到的接口与身份，要么把服务条款风险与凭据管理责任转给使用者；云盘实现同理，所以只留接口位与 [docs/文件传输.md](docs/文件传输.md)。进程守护是自研引擎（`server/lib/pguard.mjs`），不需要任何外部工具配合。

---

## 配置与密钥放哪

**四个位置，一个原则：能拷给人看的和不能示人的分开放，且都不进版本库。**

| 文件 | 放什么 | 进版本库？ | 什么时候出现 / 不出现会怎样 |
|---|---|---|---|
| `server/config.example.json` | 模板 + 逐项说明（`"//"` 开头的键是注释） | **是**（唯一提交的一份） | 一直都有。**程序不读它**，它只供你照着改 |
| `server/config.json` | 你的实际配置：端口、目录、端点地址… | 否 | 首次运行（`loadConfig()` 发现文件不存在）时生成，里面含**随机生成的 `auth.token`**。删掉它再启动＝回到出厂默认 + 一枚新令牌 |
| `server/credentials.json` | 凭据：模型 API Key、MinerU 令牌、身份补充… | 否 | **第一次保存密钥时**才出现（`saveConfig()` 收到敏感项，或启动时把老 `config.json` 里的明文密钥迁过来）。**从来没配过密钥就一直不存在 —— 这是正常状态，不是装坏了**；读不到时按「没有任何密钥」处理，各模块会自己降级/隐藏 |
| `server/data/` | 看板、词单、向量、上传的音频、审计… | 否（只放行 7 个示例文件，见 `server/data/README.md`） | **用到时才生成**；文件缺失时 `jsonstore.mjs` 按**空结构**处理，所以「没有任何数据」也是正常状态 |

- 代码里读写配置一律走 `server/config.mjs` 的 `loadConfig()` / `saveConfig()`。哪些字段算敏感由 `SECRET_PATHS` 决定（`server/config.mjs`），保存时会自动从 `config.json` 拆到 `credentials.json`；老配置里混在 `config.json` 的明文密钥首次加载会自动搬迁。**改配置改顶层**：`wiki.*` 里有几节是只读镜像，启动时会被顶层覆盖（`syncConfigMirrors()`）。
- **页面令牌**：`auth.token` 首次运行随机生成并写回 `server/config.json`；页面通过 `/api/auth/token` 自助取（该接口本身过 Origin 白名单），脚本与 MCP 客户端则带 `X-WS-Token`（也认 `Authorization: Bearer` 与 `?token=`，见 `server/lib/auth.mjs`）。
- **改配置推荐在页面「设置与数据」里改**：`PATCH /api/config` 是**白名单式**写入，白名单分两张（**分节** / **标量**，都在 `server/lib/config-editable.mjs`），多余的字段会被拒绝并在响应里点名，不会一个手滑把边车自己的配置写坏。加新配置项要同时改 `DEFAULTS` + 白名单 + 模板三处，漏了 `npm test` 会拦（`scripts/tests/config-whitelist.test.mjs`）。
- 密钥文件的实际名字是 **`credentials.json`**（不是 `secrets.json`）。`.gitignore` 里除了逐个列名，还兜底忽略任何 `*secret*.json`、`.env*`、`*session*`、`cookies*`、`*.pem`、`*.key`。
- `server/config.example.json` 是**模板**：要改配置就编辑首次运行生成的 `server/config.json`，或在页面「设置与数据」里改。模板里**故意不写 `dataDir` 这一项** —— 不写就用默认的仓库内 `server/data/`；**写 `""` 不算回默认**（`dataDir()` 会返回空串，相对路径会把数据落到进程 cwd 下），要挪盘就填绝对路径。数据目录的代码入口只有一个 —— `server/config.mjs` 的 `dataDir()`（读 `WS_DATA_DIR` 环境变量或配置里的 `dataDir`），细节见 [docs/CONFIG.md](docs/CONFIG.md)。
- **路径一律写正斜杠**（`C:/data/x`）。JSON 会把反斜杠当转义吃掉：`%APPDATA%\\Microsoft\\…` 写进模板后变成 `%APPDATA%Microsoft…`，看着是合法 JSON、实际路径连不起来 —— 模板里那条注释本身踩过这个坑。

## 目录结构

```
workstation-oss/
├─ LICENSE                     本项目许可（MIT）
├─ THIRD-PARTY-NOTICES.md      第三方来源与许可清单（依赖闭包、字体、品牌图）
├─ .nvmrc                      Node 版本（22；与 package.json 的 engines >=22.6 对齐）
├─ .github/workflows/ci.yml    CI：ubuntu + windows 跑 typecheck / test / parity / build
├─ index.html                  页面壳
├─ vite.config.ts              Vite：Element Plus 按需引入、@ → src、dedupe、dev 端口 5273
├─ tsconfig.json
├─ package.json                npm 脚本（dev / build / server / start / test …）
├─ 启动工作站.cmd              生产式启动（构建 + 起边车）
├─ 开发模式.cmd                开发式启动（边车 + Vite）
├─ src/
│  ├─ main.ts                  注册模块 → 建路由 → 图标白名单 → 挂载
│  ├─ App.vue                  ConfigProvider（中文 locale）+ AppShell + router-view
│  ├─ core/                    registry.ts（注册表）· types.ts（模块接口）· appconfig.ts
│  │                           storage.ts（localStorage）· ui.ts（主题/侧栏）· sidecar.ts（API 客户端）
│  ├─ router/index.ts          路由派生 + chunk 失效自愈重载
│  ├─ shell/AppShell.vue       侧边栏（大模块归组）+ 顶栏 + 二级导航
│  ├─ components/              PageHeader · EmptyState · MdLite · SidecarOffline · SentencePractice
│  ├─ views/                   HomeView（全部应用）· SettingsView · DevGuideView · NotFoundView
│  ├─ features/                功能模块，一个目录一个模块
│  │  ├─ index.ts              ★ 总装配处：registerModule 全在这里（有 `// ↓ 新模块 import / 下一个功能` 锚点）
│  │  ├─ _template/            ★ 功能模板（**不在注册表里**，不是功能）；也是 new-feature.mjs 的输入
│  │  ├─ dashboard/            每日看板（今日 / 趋势 / AI 三页）
│  │  ├─ office/               日历日程 · 模型用量
│  │  ├─ plan/                 规划台
│  │  ├─ vocab/                英语学习（每日一句 + 单词，含 srs.ts / parser.ts / engine.ts）
│  │  ├─ wiki/                 知识库（工作区 + 5 个 panel + 问答 + 入库 + 设置）
│  │  ├─ memo/                 语音随记
│  │  ├─ guard/                进程守护（概览 / 进程 / 参数 / 名单 / 日志 / 端口 / 智能体）
│  │  ├─ service/              运行与自启（边车状态 + 开机自启位；一个模块只占一个页面 + 一条接口，可当范本抄）
│  │  └─ settings/             LlmSection · EmbeddingSection · SearchSection（**不是模块**，只被设置页引用）
│  ├─ styles/                  tokens.css（设计令牌 = 唯一配色源）· index.css · wiki.css
│  ├─ assets/                  brand/ws-logo.webp · katex-fonts/（5 个 woff2）
│  └─ types/                   assets.d.ts · env.d.ts · router.d.ts
├─ server/
│  ├─ index.mjs                ★ 边车入口：分发骨架 + 路由表 + 静态服务 + 启动收口
│  ├─ config.mjs               配置：DEFAULTS · SECRET_PATHS · loadConfig/saveConfig · dataDir()
│  ├─ config.example.json      配置模板（仓库里唯一提交的一份配置）
│  ├─ mcp.mjs                  MCP 工具表（TOOLS / HANDLERS）+ JSON-RPC 子集
│  ├─ lib/                     能力库，一件事一个文件（见下表）
│  └─ data/                    本机数据（只提交 7 个示例文件）
├─ scripts/                    start.mjs · dev-all.mjs · seed-demo-data.mjs
│  │                            parser-parity.mjs · pguard-smoke.mjs
│  ├─ new-feature.mjs          ★ 生成一个功能模块骨架（注册 / 图标 / 接口 / 配置一起改好）
│  ├─ panel-autostart.mjs      自启位的命令行开关（`#/service` 那一页的无界面版）
│  ├─ lib/feature-scan.mjs     扫描 src/features 的静态解析（生成器与契约测试共用）
│  ├─ tests/                   node:test 用例（core · singleton · config-whitelist · module-contract）
│  └─ restart-sidecar.py · sidecar-keepalive.py（两个 .py，见下面）
└─ docs/                       ARCHITECTURE · EXTENDING · FEATURES · CONFIG
                               PRIVACY · PERFORMANCE · design-system · verifying
                               校历格式 · 每日一句导入 · 文件传输
```

**两个 `.py`（Windows 专用，只在需要「重启 / 保活」时才用）**：

| 脚本 | 干什么 | 什么时候用 |
|---|---|---|
| `scripts/restart-sidecar.py` | 杀旧实例 → 缺就生成 `scripts/Workstation.vbs` → 修好启动文件夹里的 `.lnk` → 无窗口起新边车 → 轮询 `/api/health` 到就绪 | 改完边车要重启、自启位坏了要修、或者不想让终端窗口一直开着。「运行与自启」页（`#/service`）只做自启位，**不重启**（边车重启自己会先把自己杀掉） |
| `scripts/sidecar-keepalive.py` | 边车掉线就把它拉回来（探测 `/api/health`） | 想「挂了自动回来」时手动挂上；默认不自启 |

两个脚本都只用标准库、都不写死本机路径（node 走 `WS_NODE` → `PATH` → 常见安装位）；
`restart-sidecar.py` 的详细流程写在它自己的文件头。它们**没有**进 `package.json` 的 scripts
（要跨平台就得先给这一层做实现分派，见「环境要求」）。

`server/lib/` 一览（按用途分组）：

| 用途 | 文件 |
|---|---|
| 骨架 / 安全 | `auth.mjs`（两道闸）· `singleton.mjs`（单实例）· `net.mjs`（端口/进程/spawn/HTTP）· `elevate.mjs`（一次性 UAC）· `config-editable.mjs`（`PATCH /api/config` 的白名单，独立成文件是为了能被测试对账） |
| 存储 / 模型调用 | `jsonstore.mjs`（加固 JSON 存储）· `llm.mjs`（输出预算守卫）· `usage-cache.mjs`（两级定时同步 + 落盘缓存） |
| 看板 / 规划 / 校历 | `dashboard.mjs` · `plan.mjs` · `school-calendar.mjs` · `summaries.mjs` · `ai.mjs` |
| 英语学习 | `vocab.mjs` · `srs.mjs` · `english-daily.mjs` |
| 知识库 | `wiki.mjs` · `wiki-queue.mjs` · `wiki-parse.mjs` · `wiki-cloud.mjs` · `wiki-embed.mjs` · `wiki-llm.mjs` · `wiki-chat.mjs` · `wiki-fetch.mjs` · `wiki-websearch.mjs` |
| 语音随记 | `memo.mjs` · `asr.mjs`（OpenAI 兼容转写） |
| 本机监控 | `pguard.mjs`（进程守护引擎）· `procs.mjs`（采样）· `procscan.mjs`（进程/端口/智能体快照） |
| 系统集成 | `panel.mjs` · `autostart.mjs`（启动文件夹自启位）—— 页面在「运行与自启」`#/service` |
| 外部面板 | `newapi.mjs`（余额 / 令牌 / 日志 / 聊天，OpenAI 兼容） |
| 留给你接的 | `transfer/`（文件传输的接口位，目前只有 README，见 [docs/文件传输.md](docs/文件传输.md)） |

## 有哪些功能模块

下表与代码里的 `src/features/*/module.ts` 一一对应（这也是 `src/features/index.ts` 的注册顺序）：

| 模块 | 入口 | 干什么 | 需要配什么 |
|---|---|---|---|
| **每日看板** | `#/dashboard` | 今天的计划 / 记录 / 心情 / 复盘 + 连续记录天数 + AI 总结卡（按天存档）+ 近 7 天 | 模型端点（AI 卡用，不配也能记） |
| **日历日程** | `#/office/calendar` | 月 / 周视图：哪天放假、第几教学周、哪天有记录 | 校历文件（见 [docs/校历格式.md](docs/校历格式.md)） |
| **模型用量** | `#/office/usage` | 余额、今日花费、按模型 / 密钥的分布、请求日志（走缓存，打开秒显） | `newapi.baseUrl` + 令牌 |
| **规划台** | `#/plan` | 关键日期倒计时 + 项目与下一步 + 备考清单 | 无（出厂空态） |
| **英语学习** | `#/vocab` | 每日一句（写翻译 → 核对 → 自评打卡）+ 单词（词单 / 练习 / 错题本 / 训练计划，SuperMemo-2） | 句库要自己导（见 [docs/每日一句导入.md](docs/每日一句导入.md)） |
| **知识库** | `#/wiki` | 抓链接 / 拖文件 → 队列 → 编译成互链页面；语义检索、双链图谱、会话问答、结构体检 | `wiki.dir`（**没配就不显示**） |
| **语音随记** | `#/memo` | 传一段录音 → 转写 → 自动起标题写摘要 → 落成一条记录 | `asr.baseUrl`（**没配就不显示**） |
| **进程守护** | `#/process-guard` | 按 CPU 阈值释放开发工具内存、结束失控进程、定时回收；另带端口与智能体视图。**出厂演练模式：只记录不动手** | 无 |
| **运行与自启** | `#/service` | 边车自己的状态（端口 / PID / node / 入口）＋ 开机自启位体检（编码 / 路径 / 用的哪个 node）与开启 / 关闭 / 删除 | 无（Windows 才用得上，见「环境要求」） |

> 「运行与自启」也有命令行版（装机器、无界面场景更顺）：`npm run autostart:on` / `npm run autostart:off`，
> 或者 `node scripts/panel-autostart.mjs status`（只读体检）。它们都要求边车已经在跑。

两点补充：

- **分组与置顶**：侧边栏按 `MODULE_GROUPS`（成长 / 办公 / 学习 / 待办 / 校内）归组，空组不渲染；`category` 留空的模块固定在导航最上方（当前是「进程守护」与「运行与自启」）。模块自己的二级菜单来自它路由里带 `meta.title` 且没标 `meta.hideInNav` 的项。
- **看板是容器，不是功能全集**：看板保留的是存储模型（`server/lib/dashboard.mjs`）+ AI 总结卡（`server/lib/summaries.mjs`）+ 卡片位。想加自己的卡：后端往 `/api/overview` 的返回里加一节（或另开 `/api/*`），前端在 `src/features/dashboard/DashboardHome.vue` 里加一张卡，写法照现有卡片抄。

## MCP 接入

边车在 `/mcp` 上挂了一个 **JSON-RPC 2.0 子集**（Streamable HTTP）：`initialize` / `tools/list` / `tools/call` / `ping`，
无状态调用（每次 POST 直接回结果，不强制 session），GET 用来做能力探测 / 保活（见 `server/mcp.mjs`）。

- **端点**：`http://127.0.0.1:5278/mcp`（页面「设置与数据」里有一个「复制端点」按钮）
- **令牌**：`/mcp` 要带 `X-WS-Token: <server/config.json 的 auth.token>`；也认 `Authorization: Bearer <token>`
  与 `?token=<token>` 三种写法（`server/lib/auth.mjs`）。所以能自定义请求头的 MCP 客户端直接把令牌配成头；
  只能填 URL 的客户端就把 `?token=` 挂在端点后面。
- **工具表**：43 个（`server/mcp.mjs` 的 `TOOLS`），覆盖看板、规划台、词单、知识库、语音随记，以及进程 / 端口的只读速查。
  进程守护引擎的开关与规则**没有**开放成工具（只在页面里调）。

手工验证一条（令牌换成你自己的）：

```bash
curl -s -X POST http://127.0.0.1:5278/mcp \
  -H "Content-Type: application/json" -H "X-WS-Token: <token>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

返回里 `result.tools` 就是全部工具定义；把 `method` 换成 `tools/call`、`params` 写 `{"name":"get_dashboard","arguments":{}}`
就能读今天的看板。想加工具：`server/mcp.mjs` 的 `TOOLS` 与 `HANDLERS` 各加一条，**名字必须一致**（[EXTENDING.md](docs/EXTENDING.md) §3.5）。

## 文档

- [docs/TOP-DESIGN.md](docs/TOP-DESIGN.md) —— **顶层设计**：分层、单一事实源、复用声明机制、债务台账、文案与注释规约、性能基线
- [docs/EXTENDING.md](docs/EXTENDING.md) —— **上手扩展指南**：内核概念、加页面模块 / 加边车接口的完整步骤、数据与长任务约定、别这么做的坑
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 架构：分层与数据流、一次请求的完整链路、鉴权握手、边车的启动与生命周期、单实例与自启、取舍与已知限制
- [docs/FEATURES.md](docs/FEATURES.md) —— 功能清单：注册了哪些模块、内核自带页面、边车能力清单、MCP 工具（43 个）、外部依赖清单、命令一览，以及**本开源版移除 / 泛化了什么**
- [docs/CONFIG.md](docs/CONFIG.md) —— 配置与凭据：四个位置、读写机制（合并 / 脱敏 / 只写差异）、`DEFAULTS` 逐项、页面上能改什么（白名单）、环境变量、改端口、关鉴权与换令牌
- [docs/PRIVACY.md](docs/PRIVACY.md) —— 脱敏说明：哪六类东西不该进仓库、复查方法（字面量 + 模式扫描）、待办清单
- [docs/PERFORMANCE.md](docs/PERFORMANCE.md) —— 性能盘点：已知慢点与首屏体积，按收益排的改进计划
- [docs/design-system.md](docs/design-system.md) —— 颜色、字体、间距、组件约定（唯一配色源是 `src/styles/tokens.css`）
- [docs/verifying.md](docs/verifying.md) —— 改完怎么验，哪几块要额外看一眼
- [docs/校历格式.md](docs/校历格式.md) —— 校历文件怎么写、换学年改哪个文件
- [docs/每日一句导入.md](docs/每日一句导入.md) —— 自己买课之后怎么把句库转成能读的格式
- [docs/文件传输.md](docs/文件传输.md) —— 想接 WebDAV / S3 / rclone 时该实现哪些函数
- [server/data/README.md](server/data/README.md) —— 数据目录里哪些是示例、哪些是运行时生成的
- [`LICENSE`](LICENSE) · [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) —— 本项目许可（MIT）与第三方来源清单（含唯一的来源待确认项：品牌图）

## 常见问题

**Q：页面报「连不上边车服务」，或者某个页面显示一张「本地边车服务没有连上」的卡片？**
边车没在跑（或者跑在别的端口）。那张卡片就是为此准备的（`src/components/SidecarOffline.vue`）：上面写着启动命令，还有「重新检测」按钮。手动确认：浏览器打开 <http://127.0.0.1:5278/api/health> 应该回 `{"ok":true,...}`；命令行 `npm run server` 或双击 `启动工作站.cmd`。边车不在时前端不会白屏 —— 调用一律返回 `{ ok:false }`，由页面自己显示引导。

**Q：启动时报「端口 5278 已被占用」？**
这是 `server/index.mjs` 在 `EADDRINUSE` 时的原话：**「端口 5278 已被占用。改 config.json 的 port，或先关掉旧实例。」** 处理顺序：

1. 先确认是不是自己的旧边车：`server/lib/singleton.mjs` 启动时会自动收掉「命令行里出现本项目 `server/index.mjs` 绝对路径」的旧实例，正常不该出现这个错；
2. 用 `npm run start` / 双击启动时，`scripts/start.mjs` 会先探测端口：如果端口在服务且 `/api/health` 通，它会直接退出（说明已经在跑，用浏览器打开就行）；如果端口被占但健康检查失败，它会给一句提示仍尝试启动，这时才需要你去关掉占用者；
3. 端口被**别的程序**占着时，单实例闸**不会**替你杀陌生进程 —— 它只报错退出。要么关掉那个程序，要么改端口（记得同步 `auth.allowedOrigins` 与 `VITE_SIDECAR_URL`，见上面的「端口」表）。

**Q：第一次启动，什么东西会自动生成？**
按顺序：

1. `server/config.json` —— `loadConfig()` 发现文件不存在时写入，含一个**随机生成的 `auth.token`**（`server/config.mjs`）。你什么都不会改时，这个文件里也只会躺着与默认值不同的项（`diffFromDefaults` 只写差异）。
2. `server/credentials.json` —— 在你第一次保存密钥（模型 Key、MinerU 令牌、面板令牌…）时才生成，没写过就一直不存在。
3. `server/data/` 下的数据文件 —— 各模块**用到时才生成**；文件不存在时 `jsonstore.mjs` 按**空结构**处理，所以「没有任何数据」是正常状态而不是坏掉。数据目录里预置的只有 7 个文件（`.gitkeep`、一份说明，加看板 / 规划台的空结构、一份示例校历、两份空词单），见 [server/data/README.md](server/data/README.md)。
4. **日志**：`logs/` 整个目录不进版本库（自启日志写 `logs/sidecar-autostart.log`）。

想看「有数据长什么样」：`npm run demo:seed` 写入示例看板与规划台（日期按今天推算），`npm run demo:reset` 清回空结构。它只碰 `dashboard.json` 与 `plan.json`，非空时默认拒绝覆盖（要覆盖加 `--force`）。

**Q：明明有「知识库」「语音随记」这些功能，侧边栏里却看不到？**
这是**内核约定**而不是 bug：它们依赖的配置没填（`wiki.dir` / `asr.baseUrl`），`visible()` 返回 false 就从侧边栏和首页消失 —— 与其让你点进去看一页报错，不如先不显示。在「设置与数据」里填好并保存，刷新页面它们就出现。原理见 `src/core/types.ts` 的 `WorkstationModule.visible` 与 `src/core/appconfig.ts`。

**Q：开发模式下页面能开，但数据全是空的 / 一直提示边车没连上？**
前端在 5273、边车在 5278，默认的相对路径会打到 Vite 上。照「快速开始」里那段警告处理：URL 加 `?sidecar=127.0.0.1:5278`，或建 `.env.local` 写 `VITE_SIDECAR_URL=http://127.0.0.1:5278`。页面「设置与数据」里只**显示**当前连的是哪个地址（`sidecarBase()`），不提供修改入口 —— 地址一旦被写进 `localStorage` 的 `workstation.sidecar.url`，要清掉得在浏览器开发者工具里删这个键（或换一个端口 / 换一个来源）。

**Q：点了侧边栏没反应，刷新一下才好？**
大概率是你开着页面的时候重新 `npm run build` 过：`dist/` 里的 chunk 名换了一批，页面手里还攥着旧名字。边车对 `/assets/*` 与带扩展名的路径**故意回 404**（不回落 index.html），前端路由的 `router.onError` 认出这类失败后会自愈重载并接回你要去的那一页（`src/router/index.ts` 的 `recoverFromStaleBuild`，10 秒内最多重载一次）。

**Q：脚本 / 智能体怎么调边车？**
带令牌：`X-WS-Token: <token>`（也认 `Authorization: Bearer` 与 `?token=`）。令牌值在 `server/config.json` 的 `auth.token`；`/api/health` 与 `/api/auth/token` 免令牌，其余 `/api/*` 与 `/mcp` 都要带。MCP 端点就是 `http://127.0.0.1:5278/mcp`。

