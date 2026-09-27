# 工作站顶层设计

> 本仓库是从作者个人工作站剪枝而来的开源版本，功能清单见 [FEATURES.md](FEATURES.md)；本文中的路径与模块以本仓库实际内容为准。
>
> 用途：把「配置、能力、复用」三件事定下来，后续开发先查这里，再动手。
> 写法约定见 §6，性能基线见 §7。**本文只写结论与规矩，不写来历。**

## 1. 分层

```
浏览器（Vue 3 内核 + 功能模块）
  │  api.*  ← 唯一出口，带令牌；不直接 fetch
  ▼
边车 127.0.0.1:5278（零依赖 Node）
  ├ 路由层     index.mjs：只有「解析 + 鉴权 + 转调」，不写业务
  ├ 能力层     lib/*.mjs：每个文件一个能力，可被 REST 与 MCP 同时引用
  ├ 配置层     config.mjs + credentials.json（唯一读写口）
  ├ 数据层     jsonstore（唯一落盘口）
  └ 适配层     外部服务客户端（模型 / 云解析 / 检索）
  ▼
外部服务（模型 / 知识库云解析 / 检索）
```

规矩：
1. 路由层不写业务，业务在 `lib/`；同一个能力被 REST 和 MCP 调用时**只实现一次**。
2. 前端只有 `api.*` 一条出口；页面不自己 `fetch`、不自己拼令牌。
3. 能力之间不互相 import 页面级代码；跨能力复用走能力层。

## 2. 单一事实源

| 东西 | 唯一来源 | 谁派生它 | 禁止 |
|---|---|---|---|
| 非敏感配置 | `server/config.json`（DEFAULTS 在 `config.mjs`） | 设置页表单、`config.example.json` | 在模块里再定义一份默认值 |
| 可改字段清单 | `config-editable` 表（白名单 + 字段类型） | HTTP 校验、设置页表单、一致性测试 | 各处自己写 `if` 判断哪些键能改 |
| 敏感配置 | `server/credentials.json` | 各能力只读 | 写进 config.json / 代码 / 文档 |
| 模型 | `config.llm` 预设 + 任务路由 | 所有调用点经 `llm.chat()` 解析 | 各模块自带 model 字段与下拉 |
| 模型传输 | `server/lib/llm.mjs`（唯一出口） | 各 provider 适配器 | 新写第二套 baseURL/key/body 拼接 |
| 输出预算与思考守卫 | `llm.mjs` 的 `chatGuarded/chatStreamGuarded` | 所有调用点 | 调用点自己拍 `maxTokens` |
| 流式协议 | `{type:'…'}` 单一帧格式 + 一个共享读取器 | 服务端 `index.mjs` 的生产者 / 前端 `src/core/sidecar.ts` | 再写一份 `getReader()` 循环 |
| Markdown 渲染 | `WikiMarkdown`（全语法）+ `MdLite`（精简） | 页面按需选一个 | 再写第三个渲染器 |
| 公式 | `src/features/wiki/math-typeset.ts` | `WikiMarkdown` 接它 | 各页面自己引 katex |
| 图标 | `main.ts` 的 ICONS + 静态校验脚本 | 模块 `icon:` 字段、模板 `<el-icon>` | 用未登记的名字（静默不渲染） |
| MCP 工具 | 与 REST 同源的能力定义 | `mcp.mjs` | 工具描述与实现各写一份 |
| 落盘 | `createJsonStore`（原子写 + `.bak` + rev） | 所有长期状态 | 直接 `fs.writeFileSync` |
| 轮询 | 前端一份统一的定时封装（页面隐藏时暂停） | 所有需要定时的页面 | 裸 `setInterval` |

## 3. 复用声明机制（"先查表，再动手"）

三层，从轻到重：

1. **能力表** `server/lib/capabilities.mjs`（**本仓库还没有，待建**）：每个能力一行
   `{ id, kind, description, params, handler, http?: {...}, mcp?: {...} }`。
   REST 路由与 MCP 工具从它派生 → 消灭"能力清单写三遍"（现在 157 条 REST 路由 / MCP 工具 / 前端 `api.*` 各一份）。
2. **门禁脚本**（`npm test` 的一部分，缺哪个补哪个）：
   - 配置一致性：`DEFAULTS` ↔ 白名单 ↔ `config.example.json` ↔ 设置页表单，四者键集必须一致
     —— 已在 `scripts/tests/config-whitelist.test.mjs`；
   - 能力一致性：能力表里的 `http`/`mcp` 声明必须都注册得上，反向也成立（无孤儿路由/孤儿工具）
     —— 依赖第 1 条的能力表，待建；
   - 图标：模板 `<el-icon><X/>` 与 `icon:"X"` 的名字必须在 ICONS 里，且两处白名单一致
     —— 已在 `scripts/tests/module-contract.test.mjs`。
3. **约定**：新功能先查能力表；表里没有才新增；新增必须同时登记 + 进门禁。**发现重复先合并，不加第二份。**

## 4. 债务台账（本仓库实测）

| 类别 | 现状 | 位置 |
|---|---|---|
| 配置 | 6 处绕过白名单直调 `saveConfig` | `index.mjs`、`wiki-llm.mjs`、`wiki-queue.mjs`、`wiki-websearch.mjs` |
| 配置 | 端口 5278 硬编码 10 处；`dataDir` 51 处各自解析 | `index.mjs`、`scripts/*`、`src/core/sidecar.ts` |
| 模型 | 2 套自建传输绕过 `llm.mjs`；模型下拉分散在 3 个页面（大模型 / 嵌入 / 转写） | `newapi.mjs`、`wiki-llm.mjs`、`src/features/settings/*.vue` |
| 流式 | 服务端 2 个生产者各写一份 `text/event-stream` 响应头；前端 2 个逐行相同的 `getReader()` 循环 | `server/index.mjs`、`src/core/sidecar.ts` |
| 渲染 | 2 套 markdown（能力不同）；公式只有全语法那套接 | `MdLite.vue`、`WikiMarkdown.vue` |
| 长任务 | 没有公共层：各能力自己管任务状态与进度解析，状态多为纯内存（重启即丢） | `memo.mjs`、`english-daily.mjs`、`usage-cache.mjs` 等 |
| 存储 | `createJsonStore` 只覆盖 4 个模块；另有 15 个文件自己 `fs.writeFileSync`（原子写有现成的 `writeAtomic`） | `dashboard.mjs`、`english-daily.mjs`、`pguard.mjs` 等 |
| 文案 | 注释内汉字 ≈8.2 万（`server` + `src` 合计），长注释块见 §6 规约 | 全仓 |

## 5. 迁移路线

**批次 1（已完成）**
- KaTeX 样式移出全局入口（随知识库懒加载 chunk 加载，非 wiki 页不再付这份 CSS 与字体声明）；
- 补图标 `Aim`；模板里漏出来的 `**加粗**` 改 `<b>`。

**批次 2（配置与模型的收口）**
1. `config-editable` 表与配置一致性测试已经在了（`server/lib/config-editable.mjs`、`scripts/tests/config-whitelist.test.mjs`）；剩下把 6 处直调 `saveConfig` 收进「过白名单校验的统一写入口」；
2. `llm.mjs` 成为模型唯一入口：`newapi.mjs`、`wiki-llm.mjs` 两处自建传输改走它；三个模型下拉合并为一份清单接口；
3. 前端抽一份流式读取器，替换 `src/core/sidecar.ts` 里两个 `getReader()` 循环；把裸 `setInterval` 收进统一轮询封装。

**批次 3（能力化，按需）**
1. `capabilities.mjs` + 门禁（能力 / REST / MCP / 前端一致性）；
2. 长任务与渠道池两个公共层（本仓库还没有），各先接 2 个调用方；
3. 存储统一：把自造的非原子写入改成 `writeAtomic`；
4. 文案瘦身：按 §6 规约做。

## 6. 文案与注释规约

**写**
1. 文件头 ≤ 8 行：这是什么 · 谁在用 · 一条最反直觉的约束。
2. 「为什么」只在反直觉处留**一行**；不留过程、不留中间数据。
3. 出现「某年月 + 踩过/实测/原来」的叙述 → 历史留在提交说明里，代码只留结论行。
4. UI：副标题 ≤ 20 字，提示条 ≤ 40 字，空状态 ≤ 30 字；更长的进 tooltip 或文档。
5. 一句话只写一遍：模块 `description`（`module.ts`）是源；UI 副标题与 README 表格从它派生。
6. 加粗在 HTML 里写 `<b>`，不写 `**`（会原样显示）。

**不动**（删了会出事）
- 协议/密码学常量、硬件与网络事实（端口、外部接口的认证参数）；
- 外部系统怪癖（Windows 启动文件夹、PowerShell 5.1 的编码与 UTF-8 BOM、采样别塞 WMI）；
- 数据/审计契约（`actions.jsonl` 字段、frontmatter、`[[双链]]`）；
- 安全边界（Origin 白名单 + 令牌、密码不进页面与日志）；
- MCP 工具 `description`（可压措辞，不删信息）；
- `config.mjs` 的字段级 schema 注释。

**施工顺序**：① 纯迁移（`module.ts` 头注释、README 踩坑史）→ ② 文件头瘦身 → ③ 函数级历史块 → ④ UI 文案 → ⑤ 禁令汇总后再动。

## 7. 性能基线（本机实测，数字只作量级参考）

数字只作**量级参考**，换机器会变。

| 指标 | 数值 | 说明 |
|---|---|---|
| 冷加载传输 | dashboard 851K，其中 assets 776K | 只有冷加载贵 |
| 温加载 | 75K，FCP 56ms | 缓存命中后基本不花时间 |
| 主线程 | 忙 3.2-4.8%；JS 执行 61-76ms；**Layout 148-224ms** | 瓶颈是布局，不是 JS |
| 帧 | 4.2ms/帧；滚动 0.17ms/帧 | 不卡 |
| 边车常驻 | **0.39% 单核**（全部定时器合计） | 定时器不是问题 |
| 子进程成本 | `tasklist` 548ms / `powershell Get-CimInstance` 954ms | **"慢"的真凶**：接口里别顺手 spawn |

**已知会慢的接口**：`/api/self/instances` 每次调用都 spawn 一次 powershell 取 node 进程表（`server/lib/singleton.mjs`），轮询它等于持续起子进程；`/api/pguard/status` 只读内存状态与 `os`，不 spawn。

**不要优化**（看着慢、实测不慢）：主包 334K（JS 只跑 61-76ms）、`backdrop-filter`（A/B 无差异）、轮询重渲染（稳态 0 长任务）、1MB KaTeX 字体（非 wiki 页不加载）。
