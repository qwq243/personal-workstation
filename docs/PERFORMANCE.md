# 性能

面向维护者。每条都带**在哪个文件哪一行**、**怎么量出来的**、**量到多少** —— 没有「感觉有点慢」这种话。
所有行号对应本仓库当前代码（仓库根目录），改动后请顺手更新。

---

## 一句话结论

整个仓库**只剩一个用户能感觉到的慢**：进程守护页「进程」标签一次加载 **5.0 秒**（本次实测 5,039 / 4,683 ms）。
其余全是「首屏多下几十到一百来 KB」，不影响可用性，但值得顺手收拾。优先级见下表。

### 这份盘点怎么来的（先看，否则会找错文件）

原盘点是在**开源前那份完整副本**上做的，里面有几条指向的模块（看板纸片、教务、签到、校园网、夸克网盘、
第三方进程守护接入层）**在开源版里已经整块删除**。那些问题随之消失，代码也不用改。所以下面每条都标了状态：

| 状态 | 含义 |
|---|---|
| 🔴 **仍在** | 开源版里代码还在，问题还在 —— 附**本次在 workstation-oss 上的实测数字** |
| ⚪ **已消失** | 目标模块已删，不需要再修 —— 保留原盘点数字供追溯，不要再去找那个文件 |
| 🟡 **变死代码** | 调用方随模块删了，函数还留着但没人调 —— 是清理项，不是性能项 |

**本次复测的方式**（都是只读手段，逐个说明，方便你复现）：

- 把 `server/lib/*.mjs` 直接 `import` 进 Node 计时、直接调 `pguard.processTable()` 计时 —— 调用前后比对
  `server/data/` 全目录的文件清单，确认**没有任何文件被创建或改动**；
- 读已构建的 `dist/`（不是重新构建）做体积与字节偏移统计；
- PowerShell `Measure-Command` 计时单条命令。

**本次没跑的**（避免误导）：

- **没跑 `npm run build`** —— 它会覆盖现有 `dist/`，本次只读；
- **没起边车** —— 5278 端口被本机真实工作站占着，起第二个会互相干扰，也会写出 `config.json`。
  所以凡是要「起服务打 HTTP」才能量的（`Content-Encoding` 响应头、`/api/wiki/*` 冷读延迟），本文标注为**未实测**，
  只给代码依据。

---

## 结论与优先级

| 优先级 | 问题 | 位置 | 现状 | 影响 |
|---|---|---|---|---|
| **P0** | 进程守护页「进程」标签一次 5 秒 | `src/features/guard/GuardView.vue:135-141,151-153` → `server/index.mjs:686` → `server/lib/pguard.mjs:1364` | 🔴 实测 **5,039 / 4,683 ms** | 点开那个标签要干等 5 秒，且串起 **6 次** PowerShell 子进程 |
| **P1** | 主 CSS 有 42 KB 只有模块页用得上，却是渲染阻塞 | `src/main.ts:27,30` | 🔴 主 CSS 102,731 B，其中 KaTeX 26,252 B + `wiki.css` ≈15.8 KB | 每次首屏都为「知识库正文排版」付下载与解析成本 |
| **P1** | KaTeX 字体 59 个共 1.07 MB 进包（项目自己只打算带 5 个） | `katex/dist/katex.min.css` 连带 | 🔴 59 个文件 / 1,072,948 B，占 `dist` 总体积 **38.4%** | 装进静态目录 1 MB 垃圾；真用到时也是白等 |
| **P1** | 边车不压缩、只走 HTTP/1.1，首屏 315 KB JS 原样下发 | `server/index.mjs:1135-1181`、`server/index.mjs:1196` | 🔴 代码里**零** `Content-Encoding` / gzip / brotli；`dist` 里 **0** 个 `.gz`/`.br` | 局域网无所谓，远程/隧道访问时体积就是时间 |
| **P2** | `chunkSizeWarningLimit: 1600` 把体积告警压住了 | `vite.config.ts:57` | 🔴 仍是 1600，315 KB 的 entry 不报警 | 体积劣化不会被构建发现 |
| **P2** | 两个 `tasklist` 封装成了死代码 | `server/lib/net.mjs:50-73` | 🟡 全仓 **0 个调用点**（含 `src/`） | 留着像「能用的工具」，谁接上去就继承 441 ms/次 的税 |
| ⚪ | 看板冷读 1.33–1.64 s | `papertodo.mjs`（已删） | ⚪ 模块已删 | 不需要改 |
| ⚪ | `/api/pguard/status` 约 500 ms × 每 12 s | 第三方进程守护接入层（已删） | ⚪ 路由现在走自研引擎，实测 **4 ms** | 已消失 |
| ⚪ | `/api/campus/status` 2.19 s 只缓存 3 s | `campus.mjs`（已删） | ⚪ 模块已删 | 不需要改 |
| ⚪ | 常驻出网轮询（签到 60 s / 校园网 25 s / 夸克 1.2 s） | 三个模块均已删 | ⚪ | 不需要改 |
| ✅ | 路由懒加载、无重复依赖、静态服务流式、模块加载 46 ms | 见文末「已核对不是问题」 | ✅ 本次复核仍然成立 | — |

---

## P0 —— 一个三秒以上的等待

### P0-1 进程守护页「进程」标签：一次 5.0 秒，串了 6 个 PowerShell

**位置**

- 前端：`src/features/guard/GuardView.vue:135-141`（`loadProcs()` 调 `api.pguardProcesses(60)`），
  由 `:151-153` 的 `onTab()` 在切到「进程」标签时触发；
- 路由：`server/index.mjs:686-687` → `pguard.processTable({ limit: 60 })`；
- 实现：`server/lib/pguard.mjs:1364-1394`。

**现象**

点开「进程」标签后空白 5 秒才有表。

**依据（本次实测，不是推测）**

```
# 直接调实现层，读进程表
node --input-type=module -e "… await pg.processTable({limit:60}) …"
  → pguard.processTable({limit:60})  5039 ms
  → 第二次                        4683 ms     ← 两次独立复现
    返回 JSON 4,456 B，29 行，全机进程数 446
    （行数按 CPU 排序取前 60，随当时机器负载在 13–29 之间浮动 —— 复测时行数不一样是正常的）
  → server/data 变化：无（只读，未落盘）

# 同一进程里对照，状态接口
  → pguard.status()  4 ms，JSON 4,917 B
```

**为什么这么慢 —— 拆开看（每一步都是独立的 `powershell.exe` 启动）**

`processTable()` 的骨架（`server/lib/pguard.mjs:1364-1378`）：

```js
export async function processTable({ limit = 60 } = {}) {
  const before = await snapshot()                       // ① 全表快照
  await new Promise((r) => setTimeout(r, 700))          // ② 硬编码 700ms 睡觉
  const after = await snapshot()                        // ③ 又一次全表快照
  ...
  const gate = await gateContext(                       // ④⑤⑥ 三条贵检查
    top.map((t) => t.pid), after, before,
  )
```

| 步 | 做什么 | 本次实测 | 依据 |
|---|---|---|---|
| ① | `snapshot()` 全表快照 | **511 ms** | 实测（446 个进程） |
| ② | `setTimeout(700)` —— 为算 CPU 增量必须有时间差 | 700 ms | `pguard.mjs:1366` |
| ③ | `snapshot()` 第二次全表快照 | **513 ms** | 实测 |
| ④ | `gateContext()` 里**再拍一次**快照（`pguard.mjs:1017`），只为了拿这几个 pid 的详情 | ~511 ms | 同一函数，未单独计时 |
| ⑤ | `visibleWindowPids()`：现场 `Add-Type` 编译 C# 再 EnumWindows（`pguard.mjs:1081-1105`） | ~500 ms（估） | **未单独实测**（未导出）；同类 `Add-Type` 的 `foregroundPid()` 实测 494 / 471 ms |
| ⑥ | `foregroundPid()`：又一套 `Add-Type`（`server/lib/procs.mjs:148-165`） | **494 / 471 ms** | 实测 |
| ⑦ | `Get-CimInstance Win32_Process` 查父子关系（`pguard.mjs:1023`） | **463 ms** | 实测 `Measure-Command` |

每一步的 `snapshot()` 都会**往系统 temp 写一个 `.ps1` 再 `spawn powershell.exe -File`**（`server/lib/procs.mjs:88-92`）：

```js
const psFile = path.join(os.tmpdir(), `procs-snap-${process.pid}.ps1`)
fs.writeFileSync(psFile, `\uFEFF${snapshotScript(pids, withThreads)}`, 'utf8')
const r = await runHidden(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`, { timeout })
```

**诚实交代**：上表逐项加起来约 **3.7 s**，而端到端实测 **5.0 s**。差的约 1.3 s 我没能归因到具体哪一步 ——
最可能是 PowerShell 冷启动抖动、446 条进程 JSON 的解析，以及本机当时的负载。**不要**把上表当成精确的成本模型，
它只说明「慢在两件事上：快照拍了三次、Add-Type 编译了两次」。

**影响**

- 用户侧：点一下等 5 秒（**不是**每 12 秒都付 —— 见下面「已消失」里的澄清，轮询只打 4 ms 的状态接口）；
- 机器侧：一次加载 ≈ **6 个 PowerShell 进程**（3 次快照 + 2 次 Add-Type + 1 次 CIM），
  而进程守护引擎本身就是「别让机器被拖垮」的那类工具，这个开销方向是反的。

**顺带一提（这不是 bug，是取舍）**：`pguard.mjs:1009-1012` 的注释写得很清楚 ——
贵检查只在「有候选要动手」时才做，平时每个 tick 只读 `os.cpus()` 零 spawn。
所以 `processTable` 慢是因为它是**按需**的全量视图，不是引擎每拍都在烧。

---

## P1 —— 首屏体积

### P1-1 主 CSS 里 42 KB 只有模块页用得上，而且是渲染阻塞

**位置**：`src/main.ts:25,27,30`

```ts
import '@/styles/index.css'      // :25  真正全局的
import '@/styles/wiki.css'       // :27  知识库 8 个界面共用 —— 但首屏不需要
import 'katex/dist/katex.min.css'// :30  知识库正文的 LaTeX —— 但首屏不需要
```

**现象**：`index.html` 用普通 `<link rel="stylesheet">` 引这份 CSS（没有 `media` 之类的可选属性），
浏览器必须下完解析完才首屏渲染。

**依据（对已构建 dist 逐字节定位，本次实测）**

```
主 CSS  index-Ddag27zR.css   102,731 B
  `.katex` 首次出现在第      76,479 B   → 尾部 102,731 − 76,479 = 26,252 B 是 KaTeX 的布局 + 20 条 @font-face
  `wk-`（styles/wiki.css 的前缀）首次出现在 60,700 B → 中间约 15.8 KB 是 wiki.css
  → 只被模块页用到的部分 ≈ 42,031 B（41.0 KiB）

对照：src/styles/wiki.css 源文件 10,077 B、index.css 3,347 B、tokens.css 10,378 B
```

**对照 JS 侧是对的**：KaTeX 的 JS 只在 `WikiMarkdown-UGEDScev.js`（268,634 B）里，
那是懒加载的。**样式泄进了首屏，脚本没有** —— 说明这是个遗漏，不是有意的设计。

**影响**：每次首屏（包括每日看板这种根本不用 LaTeX 的页）多下、多解析 42 KB CSS，
其中 26 KB 是「20 条字体表 + 排版规则」。慢的不只是字节数，还有 CSS 解析与字体表构建。

### P1-2 KaTeX 字体：59 个文件 1.07 MB，项目自己只打算带 5 个

**位置**：`src/assets/katex-fonts/` 与 dist 里的 `KaTeX_*`

**现象**：`katex/dist/katex.min.css` 给每个字族声明了 woff2 / woff / ttf 三套，
Vite 把三套全当资源发出来了。

**依据（本次实测）**

```
dist/assets/KaTeX_* ：59 个文件，合计 1,072,948 B
    .woff2  19 个   256,168 B
    .woff   20 个   303,116 B
    .ttf    20 个   513,664 B     ← 全是给老浏览器兜底的，现代浏览器一份都不会下载
src/assets/katex-fonts/ ：5 个 woff2，合计 90,492 B   ← 项目自己写的 5 条 @font-face 指向它

dist 总体积 2,796,314 B / 153 个文件 → 字体占 38.4%
```

**影响**：静态目录白胖 1 MB（ttf + woff 那 40 个文件在现代浏览器里**永远不会被请求**，
纯属占位与备份体积）；KaTeX 自带字体表还会让浏览器多做无用的候选匹配。

### P1-3 边车不压缩、HTTP/1.1，首屏 315 KB JS 原样下发

**位置**：`server/index.mjs:1135-1181`（`serveStatic`）、`server/index.mjs:1196`（`http.createServer`）

**现象**：`http.createServer` 就是 `node:http` 的 HTTP/1.1 服务器；`serveStatic` 只设
`Content-Type` 与 `Cache-Control`，然后 `fs.createReadStream(file).pipe(res)`。

**依据（本次实测 / 代码核对）**

```
# 代码里搜不到任何压缩实现
$ grep -n "gzip|brotli|Content-Encoding|createGzip" server/index.mjs
  → 无输出
# dist 里也没有预压产物
$ node -e "…统计 dist/assets 下 .gz/.br 文件…"
  → 预压缩产物: 0
# 服务器类型
server/index.mjs:10   import http from 'node:http'
server/index.mjs:1196 const server = http.createServer(…)

# 首屏（/ → /dashboard）
# ① index.html 只引 entry 一份 JS，而 entry 的静态 import 闭包就是它自己 —— 下面这段量的就是这 315 KB
entry  index-CW9fDOkg.js        315,047 B / 1 个文件（无任何静态 import，全部懒加载）
# ② 落地页还要再加一个**动态** import 的 chunk（路由的 () => import()），手数结果：
+ DashboardHome 及其依赖 15 个    86,965 B
= 首屏 JS 实际总量                402,012 B / 16 个文件
+ 渲染阻塞 CSS  index-Ddag27zR.css 102,731 B
```

注意 ① 和 ② 的区别：**① 是脚本能稳定复现的**（不依赖 chunk 哈希），
② 里那几个动态 chunk 的名字带哈希、由各 `module.ts` 的 `() => import()` 决定，脚本没法静态推 ——
所以下面的复测脚本量的是 ①，`402,012` 这个数请照 ② 的加法手算。

**未实测**：带 `Accept-Encoding` 请求时响应头确实没有 `Content-Encoding` —— 这一步要起边车才能验，
本次没起。**代码层面**可以确定没有压缩路径，且 `dist` 里没有预压产物可下发。

**影响**：本地 `127.0.0.1` 无所谓；一旦通过隧道 / 远程桌面 / 内网另一台机器访问，
315 KB 的 entry + 100 KB 的 CSS 就是实打实的等待。另外 HTTP/1.1 每个来源只开约 6 条并发连接，
而落地页要取的是 16 个 JS 文件（entry 之后还有一串动态 chunk），在慢链路上它们会排队。

---

## P2 —— 清理项

### P2-1 `net.mjs` 的两个 `tasklist` 封装是死代码

**位置**：`server/lib/net.mjs:50-58`（`isProcessRunning`）、`:60-73`（`pidsOf`）

**现象**：全仓**没有任何调用点**。原来用它们的两个模块（看板纸片、第三方进程守护接入层）已随开源删除。

**依据（本次实测）**

```
$ grep -rn "isProcessRunning\|pidsOf" --include=*.mjs --include=*.ts --include=*.vue . | grep -v node_modules | grep -v "^./server/lib/net.mjs"
  → 无输出（0 个调用点）

# 单次 tasklist 的真实成本
$ powershell -NoProfile -Command "Measure-Command { tasklist /fi \"IMAGENAME eq explorer.exe\" /nh }"
  → tasklist = 441 ms
```

**影响**：不是性能问题（没人调就不花时间），是**维护陷阱** ——
函数名看起来通用、签名看起来无害，下一个接模块的人很可能接上去，
于是继承一次 441 ms 的固定税（原来 `/api/pguard/status` 就是这么变成 500 ms 的）。
**要么删掉，要么在注释里写明「单次 441 ms，别放进每请求路径」。**

### P2-2 `chunkSizeWarningLimit: 1600` 让体积劣化静默

**位置**：`vite.config.ts:57`

```ts
build: {
  outDir: 'dist',
  chunkSizeWarningLimit: 1600,
},
```

**现象**：阈值被抬到 1600 KB 之后，315 KB 的 entry 与任何正常规模的 chunk 都不会再触发构建告警。
当前 entry 是 315,047 B（约 308 KB），离阈值还差 5 倍。

**影响**：构建不再替你看体积。上面 P1-1 / P1-2 这类「资源悄悄全量进包」的问题，
在 CI 里没有任何信号。

---

## ⚪ 已消失 —— 原盘点里这几条不用再修

写在这里是为了**别有人照着老笔记去找这些文件**。它们的目标模块在开源时整块删掉了。

| 原问题 | 原数字 | 现状 |
|---|---|---|
| 看板冷读 `/api/papertodo/notes` 慢 | 1.452 / 1.636 / 1.333 / 1.397 s，同一次冷读里 `isAppRunning()` 被调了两遍 | `server/lib/papertodo.mjs` 已删（依赖校方接口 + 本机 PaperTodo 桌面程序 + 微信 openId） |
| `/api/pguard/status` 每 12 s 一次 500 ms | 0.532 / 0.515 / 0.476 s，body 32,142 B | 那个 500 ms 来自**第三方接入层**的 `pidsOf(EXE_NAME)`（第三方进程守护模块，已删）。现在 `server/index.mjs:665` 走自研 `pguard.status()` —— **本次实测 4 ms / 4,917 B**。前端的 12 s 轮询（`GuardView.vue:342`）只打这个接口，`loadProcs()` 只在切标签时调一次（`:168`） |
| `/api/campus/status` 2.19 s 却只缓存 3 s | 首次 2.186850 s；`campus.mjs:89` 的 TTL 是 3000 ms；`index.mjs:214` 用 `force:true` 绕过 | `server/lib/campus.mjs` 已删。`/api/overview` 的 **SWR + 磁盘缓存仍在**（`server/index.mjs:215-237`，`OVERVIEW_TTL = 20000`），但 `buildOverview()` 现在只取本机数据与模型端点，不再强制外呼校方服务 |
| 常驻出网轮询 | 签到每 60 s 打无缓存外部接口；校园网每 25 s 串行探最多 3 个 URL（单次 4 s 超时、失败再重试，最坏 24 s） | 签到与校园网两个模块都已删，随模块消失 |
| `tasklist` 税被两处模块反复付 | 单次 466 ms，6 个调用点 | 调用点已删；只剩死代码（见 P2-1） |

---

## ✅ 已核对「不是问题」的（写在这里，免得下个迭代误判）

这几条原盘点已确认为正常，**本次在 workstation-oss 上重新复核过，结论不变**：

- **路由全部懒加载**。`src/features/*/module.ts` 里 16 处 `component: () => import(...)`；
  `src/features/wiki/module.ts:16` 的 `const WORKSPACE = () => import('./WikiWorkspace.vue')`，
  `:30-39` 六条路由共用它 —— 也是箭头函数，一样懒。**0 个静态组件引用**。
- **没有重复依赖**。删掉夸克模块后 hls.js / art-video-player 已**整体离开仓库**
  （`ls dist/assets | grep -iE "hls|art-video"` 无结果）；KaTeX 只出现在
  `WikiMarkdown-UGEDScev.js` / `WikiMarkdown-Bafn6KIf.css` 这一对里。
- **静态服务是流式的**。`server/index.mjs:1180`：`fs.createReadStream(file).pipe(res)` ——
  不把文件读进内存。
- **服务端模块加载不是瓶颈**。本次实测：把 `server/lib/` 下**全部 32 个 `.mjs`** 依次 `import` 完，
  总共 **46 ms**（调用前后 `server/data/` 无变化）。
- **Chrome 里首屏 CSS 只有一份**。`dist/index.html` 只引 `index-Ddag27zR.css`；
  各懒加载 chunk 的 CSS 由 Vite 的 mapDeps 机制在运行时按需插入，不在首屏。
- **知识库当前规模没有性能问题**（原盘点：66 页时 `/api/wiki/pages` 冷读 14.6 ms / 50,647 B、
  `/api/wiki/graph` 29.0 ms）。**本次未复测** —— 要起边车才能量，本次没起。

---

## 改进计划（按「收益 ÷ 风险」从高到低）

风险栏说的是**改错的代价**，不是难度。前三条建议一起做，因为它们都在同一个页面。

1. **删掉 `processTable` 里那次多余的快照**：让 `gateContext()` 复用 `after` 快照
   （`server/lib/pguard.mjs:1372-1376` 已经在传 `after`，只是 `:1017` 又自己拍了一次）
   —— 预计省 511 ms，零行为变化。
2. **给 `foregroundPid()` 与 `visibleWindowPids()` 的结果做进程内短 TTL 缓存（1–2 s）** ——
   两次 `Add-Type` 编译各约 500 ms，合计约 1 s；缓存窗口远小于「前台是谁」的变化速度，语义安全。
   （`foregroundPid` 在 `server/lib/procs.mjs:149`，`visibleWindowPids` 在 `server/lib/pguard.mjs:1081`；
   注意 `foregroundPid` 也被引擎 tick 用，缓存要放在调用方还是函数里，改前先确认。）
3. **把 `pguard.mjs:1366` 那个硬编码的 `setTimeout(700)` 变成「按需等待」**：
   它只是为了两次快照之间有足够时间差算 CPU 增量 —— 改成「距上次快照不足 700 ms 才补等差额」，
   在已经有过 tick 快照的场景下可以省掉整段。**改前必须确认 CPU 增量语义不变**（这条风险最高，放最后做）。
   → 这三条合起来目标：`/api/pguard/processes` 从 5.0 s 进到 **2 s 内**。
4. **把 `import 'katex/dist/katex.min.css'` 从 `src/main.ts:30` 挪进 `src/features/wiki/WikiMarkdown.vue`**
   —— 主 CSS 立刻少 26,252 B，而且和它已经懒加载的 JS 待在一起。
5. **把 `import '@/styles/wiki.css'` 从 `src/main.ts:27` 挪给知识库的入口组件**
   —— 再少约 15.8 KB。这两条一起做，主 CSS 从 102,731 B 降到约 60 KB。
6. **KaTeX 只留一套字体**：删掉 20 个 `.ttf` + 20 个 `.woff`（`dist` 少 816,780 B），
   或在 `vite.config.ts` 里把字体解析指向 `src/assets/katex-fonts/` 那 5 个 woff2。
   —— 注意 `WikiMarkdown.vue` 里已自写了 5 条 `@font-face`，先确认两套声明不冲突再删。
7. **给 `serveStatic` 加压缩**：在 `server/index.mjs:1135-1181` 里按 `Accept-Encoding` 走 gzip/br
   （或构建后生成 `.gz` 优先下发，那样连 CPU 都省了）。首屏 402 KB JS + 103 KB CSS 可压到约 1/3。
8. **把 `vite.config.ts:57` 的 `chunkSizeWarningLimit` 从 1600 调回 600**，
   让 315 KB 的 entry 重新在构建里报出来 —— 这条几乎零风险，建议先做，它能替你看住 4/5/6 的成果。
9. **清理死代码**：`server/lib/net.mjs:50-73` 的两个函数，要么删，要么在注释里写明「单次 441 ms，禁止放进每请求路径」。
10. **（可选，收益待量）让 `processTable` 接受 `{ limit }` 之外的「只要 CPU 前 N 个」的轻量模式** ——
    只拍两次快照、不调 `gateContext`，给「我就想看看谁最吃 CPU」的场景用。
    **先别做**：本次没有实测过它的收益，「进程」标签的用途也可能确实包含受保护判定。

---

## 复测方法

改完照这个顺序量，数字对得上才算修好。**都在仓库根目录跑。**

```bash
# ① 进程守护：调用前后比对 server/data 清单，确认这一步是只读的
node --input-type=module -e "
import fs from 'node:fs'
const tree = (d) => { const o = []; (function w(x) { for (const e of fs.readdirSync(x, { withFileTypes: true })) { const p = x + '/' + e.name; o.push(p); if (e.isDirectory()) w(p) } })('server/data'); return o.sort() }
const before = tree('server/data')
const pg = await import('./server/lib/pguard.mjs')
let t = Date.now(); await pg.status();        console.log('status      ', Date.now() - t, 'ms')
t = Date.now(); const r = await pg.processTable({ limit: 60 }); console.log('processTable', Date.now() - t, 'ms  行数', r.rows.length)
console.log('server/data 变化:', JSON.stringify(before) === JSON.stringify(tree('server/data')) ? '无（只读）' : '有变化!!')
"

# ② 单项外部命令成本
powershell -NoProfile -Command "\$t = Measure-Command { tasklist /fi \"IMAGENAME eq explorer.exe\" /nh | Out-Null }; Write-Output ('tasklist ' + [math]::Round(\$t.TotalMilliseconds) + ' ms')"

# ③ 首屏体积与 CSS 分界（改完 CSS 那条要重跑 npm run build 再看）
node -e "
const fs = require('fs'), path = require('path'); const A = 'dist/assets'
const main = fs.readdirSync(A).find(f => /^index-.*\.css$/.test(f))
const b = fs.readFileSync(path.join(A, main)); const s = b.toString('utf8')
console.log('主 CSS', main, b.length, 'B   .katex@', s.indexOf('.katex'), '  wk-@', s.indexOf('wk-'))
const kf = fs.readdirSync(A).filter(f => f.startsWith('KaTeX_'))
console.log('KaTeX 字体', kf.length, '个', kf.reduce((n, f) => n + fs.statSync(path.join(A, f)).size, 0), 'B')
console.log('预压缩产物', fs.readdirSync(A).filter(f => /\.(gz|br)$/.test(f)).length)
"

# ④ entry 的静态 import 闭包（不含路由动态 import 的页面 chunk —— 那部分见上面 P1-3 的 ①/② 说明）
node -e "
const fs = require('fs'); const A = 'dist/assets'
const entry = /src=\"\/assets\/([^\"]+\.js)\"/.exec(fs.readFileSync('dist/index.html', 'utf8'))[1]
const seen = new Set(), js = new Set(), stack = [entry]
const deps = (f) => { const s = fs.readFileSync(A + '/' + f, 'utf8'); const o = new Set()
  for (const m of s.matchAll(/(?:^|[;}\n])import[\s\S]{0,500}?from\"\.\/([A-Za-z0-9_.\$-]+\.(?:js|css))\"/g)) o.add(m[1])
  for (const m of s.matchAll(/import\"\.\/([A-Za-z0-9_.\$-]+\.css)\"/g)) o.add(m[1]); return o }
while (stack.length) { const f = stack.pop(); if (seen.has(f)) continue; seen.add(f); if (f.endsWith('.css')) continue; js.add(f); for (const d of deps(f)) stack.push(d) }
console.log('首屏静态 JS', js.size, '个', [...js].reduce((n, f) => n + fs.statSync(A + '/' + f).size, 0), 'B')
"
```

**改完 `pguard.mjs` 的判定逻辑，还必须跑**（见 [verifying.md](verifying.md)）：

```bash
npm run test:pguard     # 只读 + 演练模式，不改配置、不动手
```

---

## 一条纪律

**别在每请求路径上 `exec` 一条外部命令。** 这个仓库踩过的每一次「莫名几百毫秒」都是同一个形状：

| 踩过的 | 代价 |
|---|---|
| `tasklist` 判进程是否在跑，放在每次读纸片的路径上 | 466 ms × 每次请求 |
| `tasklist` 判进程是否在跑，被同一个冷读调了两遍 | 930 ms |
| `Add-Type` 现场编译 C# 问「前台窗口是谁」 | 约 500 ms |
| `Get-CimInstance Win32_Process` 查父子关系 | 463 ms |
| `netstat -ano -p tcp` 查端口 | 53 ms（这个还行） |

要用的地方**一律加进程内缓存**，或者在注释里写明这笔钱花在哪、多久花一次。
