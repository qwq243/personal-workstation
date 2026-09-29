# 架构（Architecture）

这份文档写给第一次打开仓库的人，也写给下一个来改它的人。

一句话：**一个 Vue 3 页面 + 一个只监听 `127.0.0.1` 的零依赖 Node 边车**。
页面按「功能模块」拼装，侧边栏、首页卡片与路由表全部由一张注册表派生。

```
┌──────────────────────────────────────────────────────────────┐
│ 浏览器（同源页面 · hash 路由 · Element Plus 按需）              │
│   src/core/      内核：注册表 / 路由 / 存储 / UI / 边车客户端    │
│   src/features/  功能模块：每个目录自己声明 id / 路由 / 可见性   │
│   src/views/     内核自带页：/apps · /settings · /dev-guide     │
└───────────────┬──────────────────────────────────────────────┘
                │  HTTP/1.1 · 同源相对路径 · X-WS-Token
                │  SSE（逐字下发）· MCP JSON-RPC（/mcp）
┌───────────────▼──────────────────────────────────────────────┐
│ 本地边车 server/index.mjs   127.0.0.1:5278                     │
│   路由表 route()/send()/applyCors()/readBody()/timed()         │
│   入口两道闸 auth.mjs：Origin 白名单 + 本地令牌                 │
│   能力库 server/lib/*.mjs（每个 lib 负责一件事）               │
│   数据   server/data/（默认，可用 dataDir 配置改到别的盘）      │
└───────────────┬──────────────────────────────────────────────┘
                │  由边车代发请求（密钥不出本机）
┌───────────────▼──────────────────────────────────────────────┐
│ 外部世界：模型端点（OpenAI 兼容）· 嵌入端点 · 网络搜索          │
│           MinerU 云端解析 · 有道词典发音音频 · 你的知识库目录   │
│           采集器产物目录（只读）· 本机 Chrome/Edge（导出 PDF）  │
│           edge-tts（朗读，可选）                                │
└──────────────────────────────────────────────────────────────┘
```

---

## 1. 分层与数据流

### 1.1 三层，各管什么

| 层 | 位置 | 职责 | 不做什么 |
|---|---|---|---|
| 页面（内核） | `src/core/` `src/router/` `src/shell/` `src/components/` `src/views/` | 注册表、路由派生、主题、本地存储命名空间、边车客户端、通用组件 | 不读文件、不调外部 API、不碰密钥 |
| 页面（功能模块） | `src/features/<名字>/` | 自己的页面、自己的状态、`module.ts` 声明 | 不改内核任何一个文件（三步法，见 §2.3） |
| 边车 | `server/index.mjs` + `server/lib/*.mjs` | 一切需要「本机能力」或「持有凭据」的事：出网、读写本地文件、扫进程、起子进程 | 不做页面渲染；业务状态要么在 lib 里、要么在磁盘上 |

分界线只有一条：**凡是要么需要凭据、要么需要操作系统能力的，都在边车这一侧。**
页面只跟 `127.0.0.1` 说话。

### 1.2 一次页面请求的完整链路

以打开 `#/dashboard` 为例（生产态，边车同时发页面）：

1. `GET /` → `serveStatic()`（`server/index.mjs:1274`）→ `dist/index.html`。
   缓存策略是 `no-cache` —— 这个名字固定、内容里写着当次的 chunk 名，不能缓存；
   带内容哈希的 `/assets/*` 才是 `immutable`（`:1310`）。
2. `index.html` → `/assets/index-*.js` → `src/main.ts`：
   - 先 `registerAllModules()`（`src/main.ts:38`）把各模块塞进注册表；
   - 再 `await loadAppConfig()`（`src/main.ts:102`）取一次边车配置 —— 因为 `collectRoutes()`
     会按各模块的 `visible()` 过滤，配置晚到会让路由表少几条，表现为「点了没反应」；
   - 最后 `createAppRouter()`（`src/router/index.ts:153`）：`[...coreRoutes, ...collectRoutes()]`。
3. 页面进入 `DashboardHome.vue` → `api.overview()` → `GET /api/overview` →
   边车 `route('GET', /^\/api\/overview$/)`（`server/index.mjs:224`）：
   - 内存缓存 20s 内 → 直接回；
   - 过期但有值 → **立即回旧值**（标 `stale`）并后台刷新（`refreshOverview()`，`:213`）；
   - 完全没有 → `buildOverview()`（`:188`）现拉。
4. `buildOverview()` → `ai.gatherContext()` + `newapi.aiProvider()` → 由边车出网到模型端点。
5. 结果写进内存与 `server/data/cache/overview.json`（`:152-169`），下次开页面直接命中磁盘缓存。

**这条链路上的三条纪律**（都是踩过才写的，别改回去）：

- 外部慢接口一律**不在请求里等**：能缓存的缓存（`usage-cache.mjs`）、能预热的预热
  （启动 2s 后 `refreshOverview()`，`:1296`）、能 SWR 的 SWR。
- 前端不假设「边车地址」：默认走**相对路径**（`src/core/sidecar.ts:17`），
  只有开发态（Vite 5273）才用 `?sidecar=host:port` 或 `.env.local` 的 `VITE_SIDECAR_URL` 覆盖。
- 凭证只在边车的 `credentials.json` 里；页面手里只有一个**本地令牌**。

### 1.3 三条通道

| 通道 | 形状 | 用在哪 | 代码 |
|---|---|---|---|
| JSON API | `GET/POST/PATCH/PUT/DELETE /api/*`，统一回 `{ ok, ... }` | 绝大多数读写 | `server/index.mjs` 里 199 条 `route()` 注册 |
| SSE | `text/event-stream`，帧是 `data: {json}\n\n` | 需要边生成边看的地方：知识库问答、语音随记总结 | `/api/wiki/chat/stream`、`/api/memo/summarize/stream` |
| MCP | JSON-RPC 2.0 子集（`initialize`/`tools/list`/`tools/call`/`ping`），挂在 `/mcp` | 让智能体（MCP 客户端）读写工作站数据 | `server/mcp.mjs`，54 个工具 |

二进制上传是个**唯一例外**：`Content-Type: application/octet-stream` 时 `readBody()`
不按 utf8 解、原样交给处理器写盘（`server/index.mjs` 的 `readBody()`，`:97` 起）。只有知识库拖文件与语音上传走这条。

### 1.4 鉴权握手

```
页面 fetch  /api/auth/token            ← 免令牌，但过 Origin 白名单
   ├─ Origin 不在白名单 → 403（别的网页连探测都做不到）
   └─ 命中 → { token }
页面后续请求都带  X-WS-Token: <token>
   ├─ 401 → 清掉内存里的令牌、重取一次再试一遍（`src/core/sidecar.ts:114-118`）
   └─ 200
```

- 两道闸分别在 `auth.originAllowed()`（`server/lib/auth.mjs:37`）与
  `auth.needsToken()` / `auth.tokenValid()`（`:44`、`:52` 起）。
- 免令牌的只有两个路径：`/api/health`、`/api/auth/token`（`auth.mjs:23`）。
  健康检查必须免鉴权 —— 前端靠它判断「边车在不在」。
- 令牌**只放内存**，不进 localStorage：换牌子重启后自然重取，避免用到过期值。
- 令牌轮换用 `rotateAuthToken()`（`server/config.mjs:616`），旧令牌立即失效。

**这里能防的和不能防的**（`auth.mjs` 头注释已写明，不再假装更多）：
能防浏览器里的网页（含被注入的 XSS）读写你的本地数据；
**防不住本机上的恶意程序** —— 它能直接读 `server/config.json`。那一层要靠系统权限。

---

## 2. 内核与功能模块的边界

### 2.1 唯一扩展点：注册表

`src/core/registry.ts` 是**全站唯一扩展点**：

```ts
registerModule(mod)      // 登记（id 重复会告警并覆盖）
getModules()             // 按 order 升序返回所有「可见」的功能（visible() 为 false 的滤掉）
getModule(id)            // 取单个
getGroupedModules()      // 按 MODULE_GROUPS 归组；空组不下发，组的先后由组的 order 决定
collectRoutes()          // 汇总所有功能的路由，交给 vue-router
```

`registerModule()` 里还有两条**启动告警**（都是「页面好好的、导航里找不到」那类最难查的错）：
功能没写 `category`、或 `category` 不在 `MODULE_GROUPS` 里，注册时就喊一声。

侧边栏（`src/shell/AppShell.vue`）、首页卡片（`src/views/HomeView.vue`）、
路由表（`src/router/index.ts`）三处**全部由它派生**，没有一处手写模块清单。

### 2.2 一个模块要交什么

`WorkstationModule`（`src/core/types.ts`）：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✓ | 唯一标识，同时是路由与 localStorage 命名空间，**要稳定** |
| `name` / `description` | ✓ | 中文名与一句话说明（侧边栏 / 卡片显示） |
| `icon` | ✓ | Element Plus 图标组件名（大写开头）或 emoji；**用图标名就必须在 `src/main.ts` 的白名单里** |
| `color` | | 卡片主色 hex，只做点缀 |
| `category` | ✓ | `local`（本机）/ `office`（日常）/ `study`（学习）/ `ai`（智能体）/ `tools`（工具）；**不填或写错 = 功能从导航里静默消失** |
| `order` | | 越小越靠前（先比组，再比组内） |
| `homePath` | ✓ | 点击卡片 / 侧边栏进哪 |
| `routes` | ✓ | 子路由（绝对路径）；带 `meta.title` 的自动进二级菜单，`meta.hideInNav` 不进 |
| `visible()` | | 返回 false 就隐藏（**内核级约定：没配 = 不显示**） |
| `stats()` / `badge()` | | 首页卡片指标 / 状态胶囊 |

### 2.3 三步加一个功能

1. `src/features/<名字>/` 写页面 + `module.ts`（实现上面的接口）；
2. `src/features/index.ts` 加一行 `registerModule(xxxModule)`；
3. 要后端能力的话：`server/lib/<名字>.mjs` 写能力，`server/index.mjs` 加它的 `/api/*` 路由。

页面模板与示例见 `src/views/DevGuideView.vue`（`#/dev-guide`），样式约定见
[design-system.md](design-system.md)，逐步的完整版本见 [EXTENDING.md](EXTENDING.md)。
**内核的任何一个文件都不需要改** —— 这是这套结构唯一值得强调的性质。

### 2.4 「没配 = 不显示」是内核约定

`visible()` 是**同步**的，而配置得从边车异步取。两者靠 `src/core/appconfig.ts` 调和：

- 启动时 `loadAppConfig()` 取一次整包存进内存；
- `cfgGet(path)` / `cfgFilled(path)` 只读内存；
- 配置还没到手（或边车根本没起来）时 `cfgFilled` 一律返回 `true` —— 慢启动期间侧边栏
  不该闪一下又变。

于是模块只写一句 `visible: () => cfgFilled('wiki.dir')` 就行，
**不要每个页面各自判空**。现在有三处在用它：

| 模块 | 门槛 | 没配时会怎样 |
|---|---|---|
| `wiki`（知识库） | `cfgFilled('wiki.dir')`（要库目录） | 从侧边栏隐藏 —— 一个库都没有时进去也只能看空页 |
| `memo`（语音随记） | `cfgGet('asr.provider') !== 'none' && cfgFilled('asr.baseUrl')`（要转写端点） | 从侧边栏隐藏 —— 没有转写后端，这个模块一行都用不了 |
| `news`（资讯） | `cfgFilled('collector.dir')`（要采集器产物目录） | 从侧边栏隐藏 —— 采集器是另一个进程，产物目录没配就永远是空的 |

反面例子是**做题本**：它**故意不设门槛**。题目本让智能体直接灌题就能用，
题库池（`zuotiben.pool.*`）只是「推荐同类题」的加分项 —— 这种「功能本身能跑、只是少一档能力」
的情况，应该由页面出空态、由接口回一句「没配题库目录」，而不是把整个功能从导航里藏掉
（藏掉的话，没买题册的人连题目本都找不到）。

### 2.5 内核自带的东西（不属于任何模块）

| 路由 | 页面 | 说明 |
|---|---|---|
| `/` | → 重定向 `/dashboard` | 根路径直接进每日看板 |
| `/apps` | `HomeView.vue` | 全部应用，按大模块分组 |
| `/settings` | `SettingsView.vue` | 外观偏好、服务与外部依赖、全站能力、本地数据导出/清空、MCP 端点 |
| `/dev-guide` | `DevGuideView.vue` | 三步上手 + 「要自己接的几处」 |
| `*` | `NotFoundView.vue` | 404 |

内核还提供：`src/core/storage.ts`（`workstation.*` 命名空间的 localStorage 封装，主题、侧边栏与置顶
状态存这里）、`src/core/ui.ts`（**主题四档** + 手机档 + 侧边栏状态，见 §2.7）、
`src/core/leaf-pages.ts`（导航树模型，见 §2.7）、
`src/components/{PageHeader,EmptyState,MdLite,SidecarOffline}.vue`，
以及 `src/ai/`（统一 AI 套件，规约见 `docs/ai-ui.md`）。

`src/features/settings/` 里的 `LlmSection` / `EmbeddingSection` / `SearchSection` 是
**设置页的段落组件，不是模块**（没有 `module.ts`、不注册），所以不出现在侧边栏。

### 2.6 路由的两个自愈机制

`src/router/index.ts`：

- **chunk 失效自愈**：页面开着的时候重新 `npm run build` 过，dist 里的 chunk 名全换了。
  旧文件名会命中边车的 404（静态资源**不**回落 index.html，`server/index.mjs:1292`），
  浏览器报 MIME/chunk 错误，vue-router 静默失败 —— 表现是「点了没反应，刷新才行」。
  `router.onError` 认这类错误后记住目标路径并重载一次（`src/router/index.ts` 的 `onError` 分支），
  10 秒内只重载一次。
- **hash 路由**：`createWebHashHistory()`。纯静态部署不需要任何重写规则，
  边车也只需要把无扩展名的路径回落 `index.html`。

### 2.7 导航模型与主题 / 手机档（内核级的三处「一个决定，全站生效」）

这三样都不属于任何功能模块，但每个页面都会碰到；改动它们等于改全站，所以集中写清。

#### 侧边栏导航模型：叶子页面与置顶（`src/core/leaf-pages.ts`）

- **侧边栏是一棵树**：大分组（`MODULE_GROUPS`）→ 功能行 → 二级页。一条功能行**有子页面**
  就带展开箭头（点它连带展开），**没有子页面**就是「叶子页面」（点它直接打开这一页）。
- **只有叶子页面能置顶**（2026-09-28 定的规矩）：带箭头的是「入口」，把入口也置顶，
  顶部就会变成和下面分组一样的父级堆，反而更难找。
- **判据只有一处**：`leaf-pages.ts` 的 `subRows()` / `hasSubRows()` / `leafPages()`。
  侧边栏（`AppShell.vue`）与「全部应用」（`HomeView.vue`）**共用**它。
  ⚠️ **别再按「路由 path 的前缀」判叶子**（那是这轮之前的写法，两个方向都翻过车）：
  ① 子页不在同一前缀下时（`/todo` 与 `/paper/plugins` 这种）会把入口判成叶子、多出一颗图钉；
  ② 反方向：单页功能的路由都标了 `hideInNav`，前缀写法会把它们全排除在叶子之外 ——
  规划台 / 做题本 / 知识库这些**最该置顶的页面反而没有图钉**。
- **置顶是用户手动挑的**：`ui.pinnedPages`（path 数组，顺序 = 点进来的顺序）；
  `RECOMMENDED_PINS`（做题本 / 每日一句 / 单词练习 / 规划台 / 资讯）只是
  **从没点过置顶时的默认值**，设置页那颗「用推荐置顶」读的也是它。用户自己点过之后，
  默认值不会再回头覆盖他的选择。
- 收起侧栏时置顶行**只剩图标**，所以每一行都必须有图标（这是 `check:nav` 的断言之一）。

#### 主题四档（`src/core/ui.ts` 的 `ThemeMode`）

| 档位 | 含义 | 备注 |
|---|---|---|
| `auto`（**默认**） | **按时间**自动：默认 19:00 转暗、07:00 转亮（设置页可改，支持跨零点） | 「现在算不算晚上」由本地时间回答，而不是外包给操作系统 |
| `light` / `dark` | 人工指定，一直用它 | — |
| `system` | 跟随操作系统的深浅色偏好（`prefers-color-scheme`） | 保留的老行为：想听系统的就用这档 |

两个变量同时驱动：`html[data-theme]`（本站自己的令牌）与 `html.dark`（Element Plus 的暗色变量）。
「跨零点」要按 `[from, 24:00) ∪ [0, to)` 处理 —— 写成单个 `[from, to)` 区间会让整夜都不生效。

#### 手机档（`ui.isMobile`，断点 760px）

- 断点常量 `MOBILE_MAX` 在 `ui.ts`，**必须与 `AppShell.vue` 的媒体查询一致**：
  CSS 管样式、`isMobile` 管行为（抽屉开合、宽表换卡片），两处不同步就会出现
  「样式已经是手机版、逻辑还当桌面」的错位。
- 侧边栏在手机档变成**抽屉**（`navOpen`，刻意不持久化：每次进来都该是关的）；
  宽表换成 `.ws-cards` 卡片（写法见 [design-system.md](design-system.md) §7）。
- 防回归：`npm run check:mobile`（逐路由断言没有横向溢出）、`npm run check:nav`、
  `npm run check:dark`、`npm run check:theme` —— 四条都需要**起边车 + 本机 Chrome/Edge**，
  所以不进 CI，在真机上跑（见 [verifying.md](verifying.md)）。

---

## 3. 边车的启动与生命周期

### 3.1 启动顺序（`server/index.mjs`）

```
模块顶层
  ├─ loadConfig()                                   :47     读 config.json + credentials.json 并合并
  ├─ migrateScopedConfig() + syncConfigMirrors()     :48-55  一次性迁移 / 只读镜像同步
  ├─ PORT = WS_PORT || cfg.port || 5278              :56
  └─ 清掉 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY，设 NO_PROXY=*    :59-65
        理由：本机边车的出网目标都是公网直连，终端/沙箱注入的代理会把请求截到本地代理
        端口；轻则慢，重则让用量缓存的定时同步整轮静默失败（页面拿到空缓存）。

startServer()                                        :1323
  ├─ ① 单实例闸 singleton.enforce()                   :1324  （见 §4.1）
  ├─ ② http.createServer(...)                         :1333  每个请求：CORS → Origin 闸 →
  │                                                          OPTIONS → 令牌闸 → /mcp →
  │                                                          路由表 → 404 / 静态
  ├─ ③ server.listen(PORT, '127.0.0.1')               :1399
  └─ ④ listen 回调里按顺序点亮子系统                   :1399 起
       ├─ 打印端口 / 配置路径 / 静态或开发态 / MCP / 访问控制状态
       ├─ wikiQueue.startScheduler()                  :1417  源目录监听（默认关）
       ├─ usageCache.startSync()                      :1428  用量缓存两级定时同步
       ├─ setTimeout(refreshOverview, 2000)           :1433  看板数据预热（结果落盘）
       └─ try { pguard.start() }                      :1442  进程守护引擎
```

（行号是 2026-09-30 核对 0.2.0 时的值；真要看细节按函数名 grep，别硬记数字。）

**为什么 pguard 放在最后、还整体 try 住**：它不该把前面的子系统拖下水。
这个回调里早先踩过「一步抛异常、后面整段被跳过」的坑 —— 静态资源与别的东西都在这同一个
回调里初始化，一个失败会静默带走后面全部。

### 3.2 常驻的后台定时器

| 谁 | 周期 | 干什么 | 关得掉吗 |
|---|---|---|---|
| `usage-cache` | live 60s / full 300s（`USAGE_LIVE_SEC` / `USAGE_FULL_SEC`） | 同步模型端点的余额、日志、按密钥花费到磁盘缓存 | 没配端点时同步即空转 |
| `wiki-queue` 调度器 | `wiki.watchIntervalMin`（默认 30 分钟） | 扫监听目录，把新增/改过的文件排进入库队列 | `wiki.watchEnabled`（默认关） |
| `pguard` | 慢/热两档采样（`monitor.*SampleSeconds`） | 判定 +（非演练时）动手 | `pguard.enabled` 或页面上的引擎开关 |
| overview 预热 | 只在启动后 2s 一次 | 让首屏命中缓存 | — |

前端侧另有短轮询（语音随记状态 1s、知识库入库任务等），都在「有任务时」才起，卸载时停。

### 3.3 收尾与异常

- `process.on('SIGINT')` → 打印一行并 `exit(0)`（`:1472`）。
- `uncaughtException` / `unhandledRejection` → 只记日志，**不退出**（`:1466-1471`）。
  这是有意的：一次未捕获异常不值得把整个工作台干掉。
- 每个路由处理器抛异常时**分发处兜底**（`:1378` 一带）：已发响应头就 `res.destroy()`，
  没发头就回 500 JSON。没有这层兜底，请求会永远吊着、页面一直转圈 —— 比报错难查得多。
- `EADDRINUSE` → 明确提示「改 config.json 的 port，或先关掉旧实例」后 `exit(1)`（`:1458`）。

### 3.4 启动姿势（都有哪些入口）

| 方式 | 命令 | 行为 |
|---|---|---|
| 生产 | `npm run start`（`scripts/start.mjs`） | 没有 `dist/index.html` 就先构建；端口已在服务就退出；否则 `spawn(process.execPath, ['server/index.mjs'])` |
| 生产（无窗口） | 双击 `启动工作站.cmd` | 同上。`.cmd` 只做 `cd /d %~dp0` + 转发，**故意只写 ASCII**（cmd 按 OEM 代码页解析，中文会乱），中文提示交给 Node 打 |
| 开发 | `npm run dev:all`（`scripts/dev-all.mjs`）/ `开发模式.cmd` | 边车（后台）+ Vite（前台），日志加前缀混流；任一子进程退出就整体收摊 |
| 只起边车 | `npm run server` | `node server/index.mjs` |
| 自启 | 启动文件夹里的 `Workstation.lnk` | 见 §4.2 |

`scripts/start.mjs` 与 `dev-all.mjs` 都是**纯相对路径**
（`path.resolve(dirname(fileURLToPath(...)), '..')`），不写死任何机器的目录 —— 这是能开源的前提之一。

---

## 4. 单实例与自启

### 4.1 单实例闸（`server/lib/singleton.mjs`）

**问题**：重启边车的方式不止一种（脚本、自启 `.lnk`、手动 `node server/index.mjs`）。
每种都起一个新进程，而旧进程只在「还占着 5278」时才会被顺带杀掉。一旦旧实例因为别的原因
不再监听端口（端口被抢、启动到一半失败、被留在别的端口上跑测试），它就变成孤儿：
窗口挂着、进程活着、下次重启再叠一个。

**三条硬约束**（代码里落死的，`singleton.mjs:10-19`）：

1. **只认自己的入口文件**：命令行里必须出现**本项目 `server/index.mjs` 的绝对路径**
   （两种斜杠都认，`:28-29`、`:69-72`）才动手。别的 node 一律不碰 —— 一台机器上往往还跑着
   别的服务（网关、别的智能体、MCP…），误杀的代价远大于多留一个进程。
   必须是绝对路径：放宽成 `server/index.mjs` 这种片段，两份 checkout（一份在用、一份在改）
   就会互相误杀。**这个坑真踩过，所以有专门的测试盯着**（`scripts/tests/singleton.test.mjs`）。
2. **不杀正在干活的自己**：一次性 CLI 模式不走这条道。
3. **抢不到端口就退出**，而不是硬占：端口被**非本边车**的进程占着时只报错退出
   （`:137-153`），并把「拿不准为什么不敢动手」写在错误里。绝不替用户杀陌生进程。

流程：`findDuplicates()` 收掉同入口的旧实例 → 看端口上还挂着谁 → 是自己人就收 →
是外人就报错退出 → `waitPortFree()` 等端口放掉（最多 8s）。返回 `{ ok, reaped, portFree }`。

顺手还留了两个自检接口：`GET /api/self/instances`（有几个自己人）、
`POST /api/self/reap`（清一次重复实例）。

### 4.2 开机自启（`server/lib/panel.mjs` + `server/lib/autostart.mjs`）

形态：**启动文件夹里放一条 `.lnk`，脚本本体在仓库 `scripts/` 下**。

```
%APPDATA%\...\Startup\Workstation.lnk      ← 指向 ↓（任务管理器「启动应用」显示的就是它）
<仓库>\scripts\Workstation.vbs              ← 由 panel.enable() 在运行时生成
   └─ wscript shell.Run("cmd.exe /c ""<node>"" ""<仓库>\server\index.mjs"" >> 日志 2>&1", 0, False)
```

四条从实测里得来的结论，改动前务必读：

1. **VBS 必须 UTF-16LE + BOM**（`autostart.mjs:6-19` 的编码对照表）。UTF-8 无 BOM 会被
   wscript 按系统 ANSI（中文环境是 GBK）解码 → 中文路径乱码 → `CurrentDirectory` 指向
   不存在的目录 → **自启静默失效**。历史上那条自启位就是这么坏的。
   Node 的 `fs.writeFileSync(..., 'utf8')` 默认正是 UTF-8，所以这里手写 BOM
   （`writeVbsAt()`，`autostart.mjs:82-95`）。
2. **命令外面要再包一层引号**：`cmd.exe /c "…"` 对以引号开头的字符串会剥掉首尾各一个引号，
   于是 `cmd.exe /c "C:\node.exe" "a.mjs"` 被剥坏，**不报错、静默什么都不做**（退出码 0）。
   `buildSilentVbs()`（`:180-200`）包了这层；日志重定向也必须写在外层引号之内。
3. **node 路径取 `process.execPath`，不写死**（`panel.mjs:8-10`）。历史上这里照搬过
   「写死某个工具目录下 node 绝对路径」的版本 —— 那个目录随那个工具升级就变，是定时炸弹。
4. **`.vbs` 不放启动文件夹**：某些机器的安全策略禁止在那里新建 `.vbs`/`.cmd`，只放行
   `.txt` 与 `.lnk`（覆盖已存在的 `.vbs` 却是允许的，所以老写法「看着能用、一删就装不回」）。
   `.lnk` 的改名（`.lnk` → `.lnk.disabled`）是放行的，所以「关闭自启」照样能做。

还自带一次**体检**：`panel.status()` 按 wscript 的实际解码口径读出 VBS 文本，
检查引用的 exe 在不在、入口是不是**当前这份**、用的 node 是不是当前这个（`:79-173`）；
分 `problems`（真起不来）与 `warnings`（现在能用但脆弱）两级。

### 4.3 页面入口：`#/service`（运行与自启）

三条接口 + 一个页面，全在一个地方：

| 层 | 位置 |
|---|---|
| 能力库 | `server/lib/panel.mjs`（`status()` 体检 / `enable()` / `disable()` / `remove()` / `sidecarStatus()`）· 编码与快捷方式在 `server/lib/autostart.mjs` |
| 路由 | `GET /api/panel/sidecar`（当前进程）· `GET /api/panel/status`（自启位 + 体检）· `POST /api/panel/autostart`（`enable` / `disable` / `remove` / `open-startup`） |
| 客户端 | `src/core/sidecar.ts` 的 `panelSidecar` / `panelStatus` / `panelAutostart` |
| 页面 | `src/features/service/`（`module.ts` + `ServiceView.vue`），路由 `#/service`，`category: 'local'`（「本机」组） |

「体检」是这一块的核心，分两级（`panel.status()`）：

- **problems**（真会导致开机起不来）：`.vbs` 里引用的 exe 不存在、或没指向**当前这份**边车入口；
- **warnings**（现在能用但脆弱）：用的 node 不是当前这个（某个工具自带的那个，随它升级会消失）。

判据是**按 wscript 的解码口径把 `.vbs` 读出来、再实际 `existsSync`**，不是猜文件编码 ——
`.vbs` 存成 GBK 也能正常工作，UTF-8 无 BOM 才是真坏的（见 4.2 第 1 条）。

还有一个**刻意没做**的功能：页面上没有「重启边车」按钮。边车重启自己 = 先把自己杀掉，
杀完那一刻没人接请求，页面只会转圈。要重启就跑 `npm run server` 或
`scripts/restart-sidecar.py`（后者带 `.lnk` 修复与就绪轮询），这一页只管
「下次开机还会不会自己起来」。

2026-09-27 之前，这几条接口是**活的但没有页面调用**（`grep panelStatus src/` 只命中
`sidecar.ts` 自己），所以自启只能靠 `curl` 或跑那个 `.py`，README 的命令清单里也没有它们；
现在由 `#/service` 收口。`docs/FEATURES.md` 的「功能清单」与 `README.md` 的模块表都跟着更新了。

---

## 5. 为什么是「零依赖 Node 边车」

**依赖事实**（`package.json`）：运行时只有 7 个包，全在前端
（`vue` / `vue-router` / `pinia` / `element-plus` / `@element-plus/icons-vue` / `katex` /
`vue-element-plus-x` —— 最后这个是 AI 界面的套件，见 `docs/ai-ui.md`）。
`server/` 下 **0 个第三方依赖**，只 import `node:` 内置模块 ——
实测用到的全部是：`crypto` `fs` `fs/promises` `http` `net` `os` `path` `url` `zlib`。
`server/mcp.mjs` 的 JSON-RPC 是手写的子集，没引 MCP SDK。

选这个形态的四个理由：

1. **安装的失败面越小越好。** 这是「双击就该起来」的本机工具，不是部署在服务器上的服务。
   边车的依赖树是 0，就不会因为某个传递依赖的版本漂移而打不开。
2. **要有「本机能力」就必须有个进程在跑。** 扫进程表、读端口、写启动文件夹、起子进程、
   读写任意路径 —— 浏览器一律做不到。Electron 能解决，但代价是一个几百 MB 的运行时；
   一个只监听回环的 Node 进程刚好够。
3. **密钥不出浏览器。** 外部 API Key 全在 `credentials.json`，由边车代发请求。
   页面被 XSS 也拿不到外部凭据（只能拿到本地令牌，而它的作用域就是这个本机端口）。
4. **跨域问题消失。** 前端只跟 `127.0.0.1` 同源说话；要调的那些自建服务 / 面板接口
   大多不回 CORS 头，浏览器直连必被挡。

代价写在下一节。总的来说：**这套形态适合「一个人一台机器」，不适合「一个团队一个服务」**。

---

## 6. 取舍与已知限制

### 6.1 结构上的取舍

| 取舍 | 换来了什么 | 代价 |
|---|---|---|
| 单进程、无数据库，数据是普通 JSON 文件 | 备份 = 目录拷走；出问题能直接打开文件看；没有迁移脚本 | 没有并发控制（靠 `jsonstore` 的 `rev` 乐观并发 + 后写覆盖留证）；数据量大时整份读写 |
| 路由表是数组 + `RegExp` 逐条匹配（`server/index.mjs` 的首条命中即停的匹配循环） | 零依赖、可读、加一条就是一行 | O(n) 匹配（当前 **199** 条 `route()` 注册，实测无感）；没有统一参数校验层，校验散在各处理器里 |
| 同步写（`writeFileSync` + `renameSync`） | 同一进程内「Web 与 MCP 同时写」天然串行，不需要锁 | 真正的风险是进程被杀 / 磁盘满 —— 由原子写 + `.bak` + 每日快照 + `.corrupt` 留证兜 |
| 模型输出预算集中在 `server/lib/llm.mjs` | 「思考 token 吃光正文」这类跨厂商问题只解一次 | 调用方不能自己拍 `maxTokens`；要新档位就改 `BUDGET`（`:27-34`） |
| 边车同时发前端（生产态同源） | 部署 = 双击；不需要配反代 | 首屏与 API 抢同一个 HTTP/1.1 连接 |
| hash 路由 | 不需要任何 rewrite 规则 | URL 带 `#`，不好看；SSR / SEO 无从谈起（这个形态也不需要） |

### 6.2 平台绑定（这是一个 Windows 工具）

边车里的「本机能力」大量依赖 Windows 自带命令，**换到 Linux/macOS 会直接不好用**：
`tasklist` / `netstat -ano` / `taskkill` / `powershell Get-CimInstance` /
`Start-Process -Verb RunAs`（UAC）/ 启动文件夹 / VBS / LibreOffice 的 `.com` 与 `.exe` 之别。
相关实现：`server/lib/net.mjs`、`procs.mjs`、`procscan.mjs`、`pguard.mjs`、
`elevate.mjs`、`autostart.mjs`、`panel.mjs`。要跨平台得先给这一层加实现分派 ——
目前没有做，文档里也不假装做了。

### 6.3 安全边界（诚实的部分）

- 两道闸挡的是**浏览器里的网页**。本机上的恶意程序能直接读 `config.json` 拿令牌 ——
  那是系统权限问题，应用层加 token 解决不了。
- **没有速率限制、没有登录失败审计**。回环地址 + 白名单 + 令牌对本机工具是合理强度，
  但它不是「面向网络的鉴权」。
- **没有 HTTPS**。监听的是 `127.0.0.1`，回环流量不出网卡。
- `auth.enabled = false` 是**真的关掉令牌**（`auth.mjs:44-45`）。别在多人共用的机器上这么干。

### 6.4 数据目录的不一致（改配置前必读）

`server/config.mjs` 导出了 `dataDir()` 作为**唯一入口**（`:396`，顺序：
`WS_DATA_DIR` → `config.json` 的 `dataDir`），注释也写着「各 lib 一律从这里取」。
但现状**不是**这样，改动 `dataDir` / `WS_DATA_DIR` 时会一地碎：

| 类别 | 谁 | 表现 |
|---|---|---|
| 正确走 `config.mjs` 的 `dataDir()` | `dashboard.mjs:57,60`、`memo.mjs:41,152`、`index.mjs` 的 overview 磁盘缓存、`pguard.mjs` 的引擎目录（`<dataDir>/pguard`）、`scripts/seed-demo-data.mjs` | 正常跟随配置 |
| 各自抄了一份同样的表达式 | `plan.mjs:20`、`summaries.mjs:29`、`usage-cache.mjs:19`、`vocab.mjs:19,39` | 认得 `WS_DATA_DIR`，但属复制粘贴，改一处会漏（`vocab.mjs:19` 的注释还专门提了这一点） |
| 只读 `loadConfig().dataDir` | `english-daily.mjs:22`、`elevate.mjs:32`、`procscan.mjs:88`、`school-calendar.mjs:24`、`wiki-chat.mjs:26`、`wiki-embed.mjs:45`、`wiki-queue.mjs:28`、`wiki.mjs:79,278,1293`、`index.mjs:876` | **不认 `WS_DATA_DIR`** |

结论：`WS_DATA_DIR` 目前只在测试脚本与上表前两类模块里生效（第三类只认 `config.json` 的 `dataDir`）。
把它当「一键把数据挪到别的盘」会失望 —— 要挪就改 `config.json` 的 `dataDir`，
并知道第三类那几份不会跟着动。

### 6.5 文档与代码的几处漂移（已核对）

> **本表维护约定：位置只写「文件 + 小节 / 标题 / 一段能 grep 到的原文」，不写行号。**
> 行号会被任何一次编辑弄漂 —— 上一版这张表就是因此把读者带偏的：它按行号点名了
> `docs/PRIVACY.md` 的三处小写链接，而那三处**那时已经是大写了**。
> 「状态」一栏只有两种值：**已修** / **未修**（未修的在下一节也会提一句）。

| 位置 | 现象 | 状态 |
|---|---|---|
| `server/config.example.json` 的 `dataDir` 一项 | 该项的值曾写过一条**作者机器的绝对路径**（工作区下的 `server/data`），与本文件「全空默认」的声明、`.gitignore` 的意图都冲突。整项已从模板删掉，只留 `"// dataDir"` 说明键 —— 注意**不能填 `""`**：空串不是「用默认」，会让数据落到进程 cwd | **已修** |
| `src/views/SettingsView.vue`（「本机文档解析工具」四个输入框 + 转写后端那一栏）↔ 配置白名单 | 页面把 `docparse.tools.{pandoc,soffice,python,pdftotext}` 与 `asr.*` PATCH 上去，而白名单当时只放行 `docparse: ['mineru']` → **永远会被拒**，页面只弹「已保存，但这些字段被拒绝：…」 | **已修（2026-09-30）**：`server/lib/config-editable.mjs` 里 `docparse` 加了 `tools`、`asr` 整节都在表里（见 [CONFIG.md](CONFIG.md) §4） |
| `src/features/office/CalendarView.vue`（课表层与教学周兜底） | **课表层恒为空**：它读 `overview.schedule.weekDays` / `overview.semester.week`，而 `grep -rn "schedule" server/*.mjs server/lib/*.mjs` 只命中 `scheduledImport`（配置项），`buildOverview()` 也不返回这两个字段。于是每天都是「这一天没有课」，「停课 N 节」「满课」图例永不出现；教学周仍正常（走校历那条路，`?? overview.schedule.week` 那段兜底是死代码）。模块描述里的「看课表」属超范围 | **未修**（要么接一个数据源，要么把它改成「校历视图」） |
| `server/lib/wiki-llm.mjs` 的令牌来源说明 | 注释曾写「跟随工作台时交给 `newapi.aiProvider()`，它从另一个客户端的 provider 取」—— 那条跨应用读取通道**已经删掉**，注释已改成实际来源：`config.json` 的 `llm.activePresetId` + `newapi.baseUrl`、`credentials.json` 的 `llm.keys` | **已修** |
| 看板模块的注释（`src/features/dashboard/module.ts`、`DashboardHome.vue`、`DashboardAI.vue`、`DashboardTrend.vue`） | 仍在解释「课表 / 待办 / 早报那几张卡的数据源为什么因人而异（各校接口 / 本机服务都不一样）」。这是**有意保留的设计说明**：告诉读者开源版只留骨架、卡怎么自己加。读的时候当设计说明看，不是残留 bug | 有意保留 |
| `server/config.mjs` 的 `MIRROR_SECTIONS`（顶层 → `wiki.*` 的只读镜像） | 全站配置会同步一份带 `_mirror` 标记的副本到 `wiki.*`，文件里长期躺着两份值。这是历史迁移的残留。**改配置一律改顶层**，`wiki.*` 那几节会在下次启动被覆盖 | 未修（有意的向后兼容） |
| `docs/design-system.md`（验收那一步） | 曾提到用两个已移除的截图脚本做验收 —— 那套截图工作流已随开源一起删掉；现在写的是「视觉改动自己截图看一眼」，验收方法指向 [verifying.md](verifying.md) | **已修** |
| `src/views/DevGuideView.vue`（内核能力清单里的组件库那条） | 写着「Element Plus 已全量注册」—— 实际是 `unplugin-vue-components` 按需引入（`vite.config.ts` + `src/main.ts` 的注释），`main.ts` 里没有 `app.use(ElementPlus)`（**2026-09-30 复查：这一句还在**） | **未修**（一句话的事，但改它要同时确认那一段的其它说法） |
| `src/features/_template/module.ts`（模板里 `category` 那行的注释） | 注释仍写着**旧五组**「`growth / office / study / todo / campus`；不写 = 置顶入口」—— 而现在的分组是 `local / office / study / ai / tools`、且 `category` **必填**（不填会从导航里消失）。模板是给人抄的，这句会直接把人带偏（**2026-09-30 复查：未改**） | **未修**（`scripts/new-feature.mjs` 的 `--group` 校验若是同一份名单，要一起改） |
| 本文档与 [FEATURES.md](FEATURES.md) / [CONFIG.md](CONFIG.md) 里的行号指针 | 这一轮代码位移不小（`server/index.mjs` 157 → 199 条路由、`server/mcp.mjs` 43 → 54 个工具、`server/config.mjs` 787 → 827 行），旧的行号指针整体偏移。2026-09-30 已按 0.2.0 重新核对启动顺序 / 鉴权握手 / 数据目录 / MCP 那几处，并给 §3.1 补了一句「行号以核对当日为准，看细节请按函数名 grep」 | **已修（2026-09-30）** |
| `docs/每日一句导入.md`（句库格式那一段） | 文档按 `en` / `zh` / `words` 描述 `sentences.json`，而 `scripts/english-daily-build.mjs` 的**实际产物**是 `day` / `text` / `source` / `vocab[{term,pos,meaning}]` / `structure[]` / `refTranslation` / `grammar[]` —— 照着旧文档手写句库会整份读不出来 | **已修（2026-09-30）**（以代码为准重写了那一段，并注明字段名以 `english-daily-build.mjs` 的产物为准） |
| `docs/EXTENDING.md`（模块字段表与 MCP 那节）与 `docs/TOP-DESIGN.md`（通道那节） | 两处还停在上一版：EXTENDING 把 `category` 写成可选、值是 `'growth' \| 'office' \| 'study' \| 'todo' \| 'campus'`（现在**必填**、五个分组是 `local / office / study / ai / tools`），并说 `server/mcp.mjs` 里「已有 43 个工具」（现为 54）；TOP-DESIGN 说「157 条 REST 路由」（现为 199） | **未修（2026-09-30 扫出）**：这两份不在本轮允许改动的文件里，已单独回报 —— 抄 EXTENDING 加模块的人会先被卡在 `category` 上 |
| 全仓对本文档的引用大小写 | 本文档的正式名字是 **`ARCHITECTURE.md`**（大写）：Windows 上大小写不敏感、照旧能打开，Linux/macOS 或 GitHub 网页上小写会 404。全仓引用（文档、配置模板、脚本、页面文案）已统一为大写 | **已修**（2026-09-27） |

> ⚠️ 这张表**原来那版数错了**：它写「全仓 10 处」并点名 `docs/PRIVACY.md` 的三处小写链接，
> 而那三处早就是大写 —— 原因是统计时用了 `grep -i`，把**已经正确的大写引用**也数了进去。
> 结论：统计这类「同一名字的两种写法」时不要用 `-i`，也别把统计结果直接抄进表里。

### 6.6 工程面的缺口

- ~~没有 `engines` / `.nvmrc`~~ **已补（2026-09-27）**：`package.json` 的 `engines.node` = `>=22.6`
  （`test:parity` 用的 `--experimental-strip-types` 从 22.6 才有），仓库根也有 `.nvmrc`（`22`）。
  注意 `engines` 默认只是**建议**（不加 `engine-strict` 不会拦安装），真正的门禁是 CI 锁 `node-version: '22'`。
- ~~没有 CI~~ **已补（2026-09-27）**：`.github/workflows/ci.yml` 在 ubuntu + windows 两个平台跑
  `npm ci` → `typecheck` → `npm test` → `parser-parity` → `build`。**刻意不跑** `test:pguard`
  与 `npm run server`（前者要真机的 powershell 采样、结果随机器状态变；后者会常驻）；
  也**不引入任何 linter / formatter**（见下一条）。
  **2026-09-30 复查**：这五步没变；`build` 现在会先跑 `check:pages`（页面宽度门禁），
  所以六条前端门禁里有**一条**顺带进了 CI —— 其余五条要「起边车 + 本机 Chrome/Edge」，不进 CI。
  LICENSE 见仓库根 `LICENSE`（MIT），第三方来源见 `THIRD-PARTY-NOTICES.md`；
  `CONTRIBUTING.md` 仍未单列 —— 那一段并进了 README 的「贡献 · 许可 · 从哪读起」，**不另开第三个事实源**。
- **测试面仍然窄，但最脆的几条约定已经有护栏**：`npm test` 现在 **5 个文件、46 个用例** ——
  校历算法与抓取用的纯函数（`scripts/tests/core.test.mjs`，9）、单实例闸的匹配规则
  （`scripts/tests/singleton.test.mjs`，5）、**配置白名单的三方对账**
  （`scripts/tests/config-whitelist.test.mjs`，10：`DEFAULTS` ↔ 两张白名单 ↔ `config.example.json`）、
  **注册表契约**（`scripts/tests/module-contract.test.mjs`，12：模块必须被注册、图标必须在
  `src/main.ts` 的白名单里且两处一致、路由 path/name 唯一且懒加载、`visible()` 引用的配置项真实存在），
  以及**转写热词的纠错**（`scripts/tests/memo-hotwords.test.mjs`，10）。
  这些全是「漏了不报错、只表现为页面不对」的那类问题。
  零依赖边车天然适合 `node:test`，而 `jsonstore` 的原子写 / 回退链 / `rev` 冲突、
  `vocab` 的七种粘贴格式、`srs` 的 SM-2、`wiki` 的检索与 lint 都是纯函数或纯文件逻辑 ——
  **最该接着补的还是这四块**。
- **六条前端门禁都只在真机上跑**：`check:pages`（构建前自动）以外的 nav / mobile / dark / theme / ai-ui
  需要「在跑的边车 + 本机浏览器 + 真鼠标事件」，所以没进 CI。它们把「靠肉眼看的观感」
  变成了可复跑的断言（思路见 [design-system.md](design-system.md) §7.1），
  但**改版面的人得自己记得跑**。要进 CI 得先给它们一条「起边车 + headless 浏览器」的作业。
- **前端体积没有被盯住**：`vite.config.ts:57` 把 `chunkSizeWarningLimit` 提到 1600，
  于是 300 KB 级的 entry chunk 不再触发构建告警；边车的静态服务也**不做压缩**
  （`serveStatic` 只 `createReadStream(file).pipe(res)`，响应里没有 `Content-Encoding`）。
  这是「本机访问、首屏无所谓」的取舍，但它意味着体积退化不会有人发现
  —— 实测数字与优化清单见 [PERFORMANCE.md](PERFORMANCE.md)。
- **外部工具依赖清单是手写的**：pandoc / LibreOffice / pdftotext / Python（+`python-pptx`、
  `openpyxl`）/ MinerU 令牌 / Chrome / edge-tts 各自散在 lib 注释里，缺工具时
  `wiki-parse.mjs` 会点名「缺哪个、用哪句话装」（`TOOL_HINTS`，`:28` 起）。
  「装哪几个才有完整功能」的总表现在有了一份（[FEATURES.md](FEATURES.md) §5），
  但它是文档、不是 `where` 探活的落地检查 —— 装了却不在 PATH 的坑仍要自己填绝对路径。

---

## 7. 从删掉的模块里留下的设计教训

这几条比失去的那几千行代码值钱 —— 它们都是**在真机上跑出来的**，不是设计时的假设。
（对应模块已不在仓库里；这里只留结论。）

1. **只补登，不登出。** 做「链路认证保活」时，服务说「已认证」就一次登录请求都不要发 ——
   重新登录会把现有会话顶掉，等于自己把网断了。模块里刻意没有 `logoff` 调用。
   推广出去：**保活类逻辑的第一原则是「别动已经好的东西」**。
2. **判定只认权威只读接口，不信探测。** 「通不通」这件事上，探测（ping / 204 端点）
   与真实会话状态经常不一致（热点在的时候探测一直是绿的，会话却可能早没了）。
   能用设备/服务自己的只读状态接口判断，就别用探测结果推断。
3. **「未注册路径」的报错形状是好用的探针。** 某些服务对未注册路径回「签名验证失败」、
   对已注册的给业务错误 —— 用这个差异能摸清一个私有接口有哪些能力，比逐个试参数省事，
   也不会触发副作用。（涉及第三方服务时，先看它的条款。）
4. **多来源凭据要分清。** 同一个服务常有两套凭据（系统令牌 vs 用户 Key、
   open-api 令牌 vs 网页 cookie），混用会出现「元数据读到了、正文是空的」这类
   看起来像 bug 的现象。
5. **长任务一律「起任务 + 轮询」。** 转写、编译、下载都是分钟级，而 Node 的
   `requestTimeout` 默认 5 分钟 —— 在一个请求里等完，大文件必被掐。
   现成的两个实现：`memo.mjs` 的 jobs 状态机、`wiki-queue.mjs` 的入库队列。
6. **边车的路由处理器抛异常必须自己接住**（分发处已加兜底，`server/index.mjs:1378` 一带）：
   不接的话请求会永远吊着，页面一直转圈，比报错难查得多。
7. **进程采样别塞 WMI。** 能自己算的用 Node 的 `os` + 两次快照做差；
   `Win32_OperatingSystem` 这类查询是几百毫秒级的，放进高频路径会把整页拖慢。
8. **要护住某个 node 服务时，白名单只能匹配命令行。** 所有 node 的 imagePath 都是同一个
   `node.exe`，按路径匹配区分不了任何东西（见 `procscan.mjs` 与 pguard 的保护层）。
9. **采样脚本的 stdout 必须显式设成 UTF-8。** PowerShell 5.1 默认按代码页 936 输出，
   中文命令行到 Node 那头是乱码 —— 中文白名单值会**静默失效**（不报错，只是永远不匹配）。

---

## 8. 不在这份架构里的东西

- **文件传输**：仓库不带任何云盘实现。接口约定与一个空的 provider 目录见
  [文件传输.md](文件传输.md)（WebDAV / S3 / rclone 都能接）。
- **校内类能力（校方系统 / 签到 / 认证保活）**：依赖特定学校的私有接口与个人身份，整块没有带 ——
  这是隐私与合规取舍，不是没做完。要接自己学校的接口，见 `src/views/DevGuideView.vue` 的三步模板。
- **账号池 / 刷分自动化**：不做。把商业服务的多账号轮转与自动打卡做成产品，
  等于把服务条款风险与凭据管理责任一起转给使用者。
- **云端那一层网关**：仓库只带「本机」这半层，云网关那半不在版本库里；陌生人拿到手
  只能看到一半架构，所以整块没有带。
- **对第三方客户端做逆向的本机工具链**：不做。需要转写就用标准的
  OpenAI 兼容 `/audio/transcriptions`（见 `server/lib/asr.mjs`）。
- **资讯采集器本体**：不带。「资讯」页只读一个**产物目录**（契约 [news-contract.md](news-contract.md)），
  采集（源清单、代理、浏览器自动化）是各人自己的事 —— 它跑在哪儿、用什么语言写都行，
  只要产出那几个文件。仓库里只有一个抓公开 RSS 的最小示例 `scripts/collector-skeleton.mjs`。
- **做题本的题库与句库原文**：不带。题干 / 解析 / 课件文本都是别人的版权物，
  仓库只带容器（解析器 `kaproblems.mjs`、推荐 `zuotiben-suggest.mjs`、格式契约 [zuotiben-import.md](zuotiben-import.md)）。
- **跨应用读别人的私有配置**：不读。密钥一律只在 `server/credentials.json` 一处。

相关文档：[CONFIG.md](CONFIG.md)（配置与凭据逐项）、
[FEATURES.md](FEATURES.md)（功能清单、移除了什么、怎么加回来）、
[EXTENDING.md](EXTENDING.md)（照着它加一个自己的模块）、
[PERFORMANCE.md](PERFORMANCE.md)（实测的慢点与体积）、
[design-system.md](design-system.md)（样式纪律）、[verifying.md](verifying.md)（改完怎么验）。
