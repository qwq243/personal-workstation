# 功能清单（Features）

这份文档回答三个问题：**内置了哪些功能、各自依赖什么、原来有而这里没有的东西怎么加回来。**

配置字段的含义见 [CONFIG.md](CONFIG.md)；分层与启动流程见 [ARCHITECTURE.md](ARCHITECTURE.md)。

---

## 1. 注册了的功能模块

「注册了」= 在 `src/features/index.ts:21-31` 里出现过。侧边栏、首页卡片、路由表都由注册表派生
（见 [ARCHITECTURE.md §2](ARCHITECTURE.md)）。

| 模块 | id | 入口路由 | 一句话 | 依赖的外部服务 | 需要配什么 | 数据落哪 |
|---|---|---|---|---|---|---|
| **每日看板** | `dashboard` | `#/dashboard` | 今天的计划 / 记录 / 心情 / 复盘 + 连续天数 + 模型花费，AI 给要点与建议（三张卡：今日 / 趋势与记录 / AI 助手） | 模型端点（**可选**：只影响 AI 卡；没有也能记计划） | `newapi.baseUrl` + `ai.model` + `llm.keys.workstation` | `data/dashboard.json`、`data/ai-summaries.json`、`data/cache/overview.json` |
| **日历日程** | `calendar` | `#/office/calendar` | 月/周两种视图，把「学校怎么安排」和「我留下了什么」叠在一张表上 | **无**（只读本机校历文件 + 看板数据） | 放一份校历到 `data/school-calendar.json`（出厂是示例数据） | 读 `data/school-calendar.json`、`data/dashboard.json`（写入也落看板） |
| **模型用量** | `office-usage` | `#/office/usage` | 余额、今日花费、小时分布、按模型/密钥的分布、请求日志 | NewAPI 兼容端点的**面板接口**（`/api/*`） | `newapi.baseUrl` + **`newapi.token`（面板系统令牌）** | `data/newapi-cache.json`（两级定时同步的落盘缓存） |
| **规划台** | `plan` | `#/plan` | 长期目标：关键日期倒计时 + 项目与下一步 + 备考清单 | **无** | 无（出厂空态，页面上自己加） | `data/plan.json`（`jsonstore` 加固写） |
| **英语学习** | `vocab` | `#/vocab` | 每日一句（写翻译→核对→自评打卡）+ 单词（词单/练习/错题本/训练计划，SRS） | 有道的**公开**发音音频（由边车代理，命中缓存不再出网）；每日一句要自备句库 | 转写/模型都不需要；每日一句要按 [每日一句导入.md](每日一句导入.md) 导入句库 | `data/vocab/{lists,progress}.json`、`data/vocab/audio/`、`data/english/daily-sentence/{sentences,progress}.json` |
| **知识库** | `wiki` | `#/wiki`（+ `/wiki/chat`·`/wiki/ingest`·`/wiki/settings`） | 抓链接 / 拖文件 → 队列 → 编译成互链页面；语义检索、双链图谱、会话问答、结构体检 | 模型端点（编译与问答，**必需**）；嵌入端点、MinerU、网络搜索、本机解析工具、AnyTXT（**都可选**，缺了各自降级） | `wiki.dir`（唯一必需项；**没配就从侧边栏隐藏**） | 知识库目录（`wiki/` + `raw/`，在你的盘上）+ `data/wiki-{projects,chats,vectors,review,queue,watch}.json` |
| **语音随记** | `memo` | `#/memo` | 传一段录音 → 转写 → 按口述/访谈骨架整理成稿；热词库负责转写纠错与标签，原始音频可回放 | OpenAI 兼容的 `/audio/transcriptions`（**必需**）+ 模型端点（写摘要） | `asr.baseUrl`（+ 可选 `asr.apiKey`、`llm.keys`）。**没配就从侧边栏隐藏** | `data/memo/{records.json, records/*.md, inbox/, hotwords.json, jobs.json, settings.json}` |
| **进程守护** | `guard` | `#/process-guard` | 按 CPU 阈值释放开发工具内存、结束失控进程、定时回收内存；另带端口与智能体两个视图 | **无**（只用 Windows 自带命令 + PowerShell） | 无（出厂**演练模式**：照常判定、写审计，不动手） | `data/pguard/{config.json,actions.jsonl,engine.log}`、`data/procscan-actions.jsonl` |

| **运行与自启** | `service` | `#/service` | 边车自身状态（端口 / PID / node / 入口）＋ 开机自启位体检与开启 / 关闭 / 删除 | **无**（操作的是启动文件夹，不联网；Windows 专有） | 无 | `scripts/Workstation.vbs`（运行时生成，不进版本库）、`logs/sidecar-autostart.log` |

关于「置顶区」：`guard` 与 `service` 都没有 `category`（`src/features/guard/module.ts` /
`src/features/service/module.ts`），所以它们是不分组的置顶入口。
其余模块分属 `office`（看板/日历/用量/规划台/随记）
与 `study`（英语学习/知识库）两组；`growth`、`todo`、`campus` 三组出厂为空
（`MODULE_GROUPS` 里留着，等你自己加模块时用 —— 尤其 `campus` 是给校内类留的位）。

### 1.1 几个模块的已知缺口（不是没做完，是没数据源）

| 模块 | 缺口 | 依据 |
|---|---|---|
| 日历日程 | **课表层恒为空**：它读 `overview.schedule.weekDays`（`CalendarView.vue:159`）与 `overview.semester.week`（`:283`），而这两个字段在开源版边车里**已经不存在**（`buildOverview()` 只返回 balance / spend / plan / streak / vocab / school / ai，`server/index.mjs:179-196`；全 `server/` 里 `schedule` 零命中）。于是每天都显示「这一天没有课」，「停课 N 节」与「满课」图例永不出现。教学周仍正常（走校历那条路）。模块描述里的「看课表」是超范围的 | 见 [ARCHITECTURE.md §6.5](ARCHITECTURE.md) |
| 每日看板 | 只带**骨架与存储**：计划 / 记录 / 心情 / 复盘 + AI 总结卡是完整可用的；但课表卡、待办卡、签到卡、早报卡**没有随仓库分发**（它们的来源因人而异） | `src/features/dashboard/module.ts:5-6`、`DashboardHome.vue:7` |
| 进程守护 | **没有「结束任意进程」的手动入口**（设计上划掉的：手动结束会绕过演练开关与动作预算）。页面只提供可逆的「释放内存」与需要一次 UAC 的「清系统待机列表」 | `GuardView.vue:10`、`server/index.mjs:659-664` |
| 自启 | **已收口（2026-09-27）**：`#/service`（`src/features/service/`）把 `/api/panel/{sidecar,status,autostart}` 三条接口接上了页面；此前这几个接口是活的但没有页面调用 | 见 [ARCHITECTURE.md §4.3](ARCHITECTURE.md) |

### 1.2 语音随记的「热词」是怎么起作用的

一个分类 = 一张词表，每条形如 `词（正确写法） + 常见错写别名 + 来源 + 命中次数`。它只做两件事：

1. **转写纠错**：别名先在本地做**确定性替换**（`hotwords.applyAliases()`：一趟扫完、长别名优先、先把正名挖成占位符，
   否则「订单」会把「订单中心」改坏），再把词表作为提示词块交给模型复核 —— 模型只负责拿不准的那些。
2. **打标签**：提示词要求标签优先从词表里挑；成稿后从「术语与专名」栏（`正名 ← 错写`）与标签里收新词，
   自动进这条记录的分类（没有分类就进「未分类」）。

出厂预设是**通用词**（常见同音错写 / 技术与工程 / AI 与模型 / 学术研究 / 教学与课程 / 医学与健康），
词库空时自动铺三个起步分类；把预设当模板换成自己的词就是。过滤偏严是有意的：模型会把
「本段未出现热词表内任何专名」这种整句当术语交上来，所以要求词形像词、**且词或别名在原文里真出现过**才收。

顺带一句边界：**热词不喂给转写后端**。OpenAI 兼容的 `/audio/transcriptions` 没有词表参数，
所以纠错只能发生在拿到文字之后 —— 这也是「本地替换 + 模型复核」这条路的原因。

---

## 2. 内核自带的页面（不是模块，但都是功能）

| 路由 | 页面 | 干什么 |
|---|---|---|
| `/` | → 重定向 `#/dashboard` | 根路径直接进每日看板 |
| `#/apps` | `src/views/HomeView.vue` | 「全部应用」：按大模块分组的功能卡片 |
| `#/settings` | `src/views/SettingsView.vue` | 外观偏好（主题）、服务与外部依赖（端点/目录，白名单式保存）、全站能力（文档解析 / 输出语言 / 代理）、本地数据（`workstation.*` 的导出 / 恢复 / 清空）、MCP 端点复制 |
| `#/dev-guide` | `src/views/DevGuideView.vue` | 三步加功能 + 「要自己接的几处」+ 内核能力清单 |
| 其它 | `src/views/NotFoundView.vue` | 404 |

设置页里三段通用表单是组件而非模块（无 `module.ts`）：
`src/features/settings/{LlmSection,EmbeddingSection,SearchSection}.vue`。

---

## 3. 边车能力清单（`server/lib/*.mjs`）

### 3.1 基础件（任何本地小工具都能直接抄）

| 文件 | 行数 | 干什么 | 为什么值得单独说 |
|---|---|---|---|
| `config.mjs` | 787 | 配置与凭据的分层读写 | 深合并 + 只写差异 + 敏感项自动拆分 + 脱敏 + 一次性迁移 |
| `jsonstore.mjs` | 264 | 加固 JSON 存储工厂 | 原子写 / `.bak` 回退 / `.corrupt` 留证 / 每日快照 / `rev` 乐观并发 |
| `net.mjs` | 265 | 端口探测、进程与 PID、隐藏与可见 spawn、HTTP request | 零依赖；`isProcessRunning` 走 `tasklist` |
| `auth.mjs` | 82 | Origin 白名单 + 本地令牌 | 直接解决「任意网页可 fetch 回环端口」这个洞 |
| `singleton.mjs` | 157 | 只认本项目入口的单实例闸 | 详见 [ARCHITECTURE.md §4.1](ARCHITECTURE.md) |
| `autostart.mjs` | 202 | 启动文件夹自启位通用管理（`.lnk` + `.vbs`） | UTF-16LE+BOM 那套实测结论在 `:6-19` |
| `panel.mjs` | 232 | 工作站自身的自启位生成 / 体检 / 开关 | node 路径取 `process.execPath`，不写死。页面在「运行与自启」`#/service` |
| `config-editable.mjs` | 78 | `PATCH /api/config` 的白名单（分节表 + 标量表） | 独立成文件才能被 `scripts/tests/config-whitelist.test.mjs` 与 `DEFAULTS` / `config.example.json` 对账 |
| `elevate.mjs` | 87 | 一次性 UAC 提权执行 | 结果经临时文件回传；脚本必须 UTF-8 **带 BOM** |
| `llm.mjs` | 97 | 大模型输出预算守卫 | 「思考 token 吃光正文」：预算按输入算、正文过短自动加倍重跑 |
| `procscan.mjs` | 495 | 进程 / 端口 / 智能体视图 + 结束进程的保护层与审计 | 保护层六条判据；结束动作必须过它 |
| `procs.mjs` | 365 | 全表快照、按 CPU 排序、内存回收、前台窗口 | 采样不用 WMI（能自己算的自己算） |
| `srs.mjs` | 198 | SuperMemo-2 的服务端实现 | 与前端 `src/features/vocab/srs.ts` **同一套规则** |
| `usage-cache.mjs` | 181 | 两级定时同步 + 落盘缓存 | 页面打开 **0 个外部请求**（思路可套到任何慢的外部 API） |
| `summaries.mjs` | 215 | AI 总结按天存档 | 三级降级读取 |

### 3.2 领域模块

| 文件 | 行数 | 对应页面 |
|---|---|---|
| `dashboard.mjs` | 341 | 每日看板（计划/记录/心情/复盘 + 连续天数） |
| `school-calendar.mjs` | 228 | 校历算法（教学周现算、假期不排课、调休） |
| `plan.mjs` | 382 | 规划台（含乱码拒写、倒计时口径） |
| `vocab.mjs` | 1110 | 词单 / 学情 / 到期队列 / 复习建议 / 发音代理 |
| `english-daily.mjs` | 258 | 每日一句的句库与进度指针 |
| `memo.mjs` | 1542 | 语音随记的任务状态机 + 记录 + 标签/分类/热词接线 |
| `hotwords.mjs` | 553 | 热词库：分类 → 词（词 + 常见错写别名）、本地确定性纠错、自学与命中记账 |
| `asr.mjs` | 133 | 转写后端（**只有一个实现**：OpenAI 兼容 `/audio/transcriptions`） |
| `pguard.mjs` | 1400 | 进程守护引擎（规则、迟滞、动作预算、保护层、审计） |
| `ai.mjs` | 243 | 看板用的 AI：总结 / 今日建议 / 复习草稿 / 问答 / 上下文汇总 |
| `newapi.mjs` | 451 | 模型端点客户端（面板类 + OpenAI 兼容对话） |
| `wiki.mjs` | 1378 | 知识库：页面读写、双链图谱、检索、lint、编译入库、多库 |
| `wiki-parse.mjs` | 480 | 多通道文档解析（pandoc → LibreOffice → Python → pdftotext → 云端） |
| `wiki-queue.mjs` | 406 | 入库队列 + 源目录监听 + 环境自检 |
| `wiki-llm.mjs` | 508 | 模型预设 / 任务路由 / 连通测试 |
| `wiki-embed.mjs` | 437 | 语义检索（**一份 JSON + 暴力点积**，不引向量库） |
| `wiki-chat.mjs` | 423 | 会话式问答（流式、工具轮次、会话存档） |
| `wiki-cloud.mjs` | 300 | MinerU 云端解析（提交 / 轮询 / 状态） |
| `wiki-websearch.mjs` | 364 | 网络搜索 + AnyTXT 本机文件检索 |
| `wiki-fetch.mjs` | 277 | 抓公开链接 → `raw/sources/*.md`（RSS/Atom + 普通网页正文提取） |
| `pguard` 三件套 | — | `pguard.mjs`（引擎）+ `procs.mjs`（采样）+ `procscan.mjs`（视图）|

### 3.3 一个刻意留空的目录

```
server/lib/transfer/README.md     ← 只有一个 README，没有任何 provider
```

文件传输**不带实现**，只留接口约定（`status` / `list` / `startUpload` / `startDownload` /
`jobStatus` / `link`）。详见 [文件传输.md](文件传输.md)。

---

## 4. MCP 工具（45 个）

边车在 `/mcp` 上挂 JSON-RPC 子集（`server/mcp.mjs`），`TOOLS` 与 `HANDLERS` **两边名字必须一致**
（45 对 45，已核对）。

| 分组 | 工具 |
|---|---|
| 看板（7） | `get_dashboard` `get_overview` `add_plan` `update_plan` `add_note` `set_day_review` `get_recent_days` |
| 模型端点（1） | `get_balance` |
| AI（2） | `ai_summary` `ai_review` |
| 单词（10） | `list_vocab_lists` `get_vocab_words` `add_vocab_words` `remove_vocab_words` `create_vocab_list` `get_vocab_progress` `get_vocab_review_advice` `get_vocab_due` `get_vocab_sessions` `dedupe_vocab` |
| 规划台（4） | `get_plan` `update_project` `update_prep` `set_goal_date` |
| 进程/端口（2，只读） | `get_ports` `get_agent_sessions` |
| 知识库（13） | `get_wiki_status` `search_wiki` `get_wiki_page` `write_wiki_page` `fetch_wiki_source` `ingest_wiki_source` `get_wiki_lint` `ask_wiki` `get_wiki_queue` `add_wiki_to_queue` `run_wiki_queue` `get_wiki_search` `get_wiki_projects` |
| 语音随记（6） | `start_memo` `get_memo_job` `list_memos` `read_memo` `memo_hotwords` `update_memo` |

行为约定：`/mcp` 与 `/api/*` 一样要带令牌（`X-WS-Token`）；`initialize` 的 `instructions`
（`mcp.mjs:1019-1030`）就是给智能体看的功能说明，改能力时记得同步它。
进程守护的开关与规则**没有**开放成 MCP 工具（只能页面上调）。

加一个工具：`server/mcp.mjs` 的 `TOOLS` 与 `HANDLERS` 各加一条（名字必须一致）。

---

## 5. 外部依赖清单（装哪几个才有完整功能）

`server/` 与 `src/` 都是零第三方框架依赖（前端 6 个运行时包见 `package.json`），
但**有些功能要靠本机装的外部程序**。缺了不会崩，只会在用到那一步报错：

| 功能 | 需要什么 | 不装会怎样 | 怎么配 |
|---|---|---|---|
| 前端构建 / 边车运行 | **Node 22+**（实测 `v22.20.0` 通过；`package.json` 里**没有** `engines` 强制） | 起不来 | — |
| docx / html / csv 抽文字 | **pandoc** | 这几类文件报「缺 pandoc + 装它的那一句」 | `docparse.tools.pandoc`，留空则按 PATH 找 |
| pptx / xlsx / 复杂 docx | **LibreOffice**（必须 `soffice.com`） | 回落失败时报缺工具 | `docparse.tools.soffice` |
| pptx / xlsx 兜底 | **Python 3** + `python-pptx` + `openpyxl` | 同上 | `docparse.tools.python` |
| PDF 文本层 | **pdftotext**（Xpdf / poppler） | 同上 | `docparse.tools.pdftotext` |
| 扫描版 PDF / 真表格 / 抽图 | **MinerU 云端令牌**（文档会上传第三方） | 只能拿到文本层，扫描件抽不出字 | `docparse.mineru.token`（页面「设置与数据」里填） |
| 本机文件全文检索 | **AnyTXT**（本地 HTTP 服务） | 那一项不可用，其余照常 | `search.anyTxt.*` |
| 语音随记 | 任一 **OpenAI 兼容 `/audio/transcriptions`**（本机 whisper 网关或云端） | 模块从侧边栏隐藏 | `asr.baseUrl` |
| 语义检索（可选） | 任一 **OpenAI 兼容 `/v1/embeddings`**（例如本机 ollama + `bge-m3`） | 检索自动退回词法，**不报错** | `embedding.endpoint` |
| 对话 / 编译 / 摘要 | 任一 **OpenAI 兼容端点** | AI 相关功能报「还没填地址」 | `newapi.baseUrl` + `llm.keys.workstation` |

边车对「缺工具」的态度是**点名**：`wiki-parse.mjs:31-36` 的 `TOOL_HINTS` 会告诉你
缺哪个、用哪句话装它。装了但不在 PATH 上，就把绝对路径填进 `docparse.tools.*`。

---

## 6. 命令一览

```bash
npm run dev          # 只起 Vite（5273）
npm run server       # 只起边车（5278）
npm run dev:all      # 两个一起（= 双击「开发模式.cmd」）
npm run build        # 构建前端到 dist/
npm run start        # 生产启动（没有 dist 就先构建）= 双击「启动工作站.cmd」
npm run typecheck    # vue-tsc --noEmit

npm test             # 纯逻辑回归（node:test，4 个文件 36 个用例）
npm run test:parity  # 前后端两套词条解析器对拍（需要真实词单）
npm run test:pguard  # 进程守护的判定（只读 + 演练模式，--no-start；Windows 真机）

npm run demo:seed    # 写示例看板/规划台数据（日期按「今天」推算）
npm run demo:reset   # 清回空结构

npm run autostart:on  # 开（或重建）开机自启位 = node scripts/panel-autostart.mjs enable
npm run autostart:off # 关自启位（不删文件）= …… disable
```

**两个「加东西」的入口**（不是 npm script，直接跑文件）：

```bash
node scripts/new-feature.mjs --help                     # 生成一个功能模块骨架（含注册与图标白名单）
node scripts/panel-autostart.mjs status                 # 自启位体检（只读）；另有 enable/disable/remove/open-startup
```

其它脚本（`scripts/`）：`english-daily-parse.mjs` / `english-daily-build.mjs`（MinerU 结果 → 句库）、
`seed-demo-data.mjs`（示例数据）、`restart-sidecar.py` / `sidecar-keepalive.py`（重启与保活，
node 路径从 `WS_NODE` 或 PATH 找）、`pguard-smoke.mjs`（判定基线）、
`new-feature.mjs` + `lib/feature-scan.mjs` + `_template` 的生成器那一套（见 §6.1）、
`panel-autostart.mjs`（`#/service` 那一页的命令行版）。

### 6.1 脚手架与护栏（`scripts/` 里那几个「给加功能的人用」的东西）

| 东西 | 干什么 | 谁在守它 |
|---|---|---|
| `src/features/_template/` | 一份可照抄的最小模块（也是生成器的输入）；README 里有「演示值 → 你的值」的完整替换表 | `scripts/tests/module-contract.test.mjs`（模板自己也得是合法形状） |
| `scripts/new-feature.mjs` | 一条命令建模块 + 注册 + 补图标白名单 + 按需的后端与配置；**先规划后落盘**，任何一处不成立就整体不动 | 它自己的前置检查（锚点 / id / 路由 / 图标名 / SFC 解析） |
| `scripts/lib/feature-scan.mjs` | 文本级扫描 `src/features/`：模块字段、路由、图标白名单、注册表 | —— 被上面两个共用，保证「生成器认为合法的」和「测试认为合法的」是同一套判据 |
| `scripts/tests/module-contract.test.mjs` | 注册表契约：模块必须被注册、图标必须在白名单且两处一致、路由唯一且懒加载、`visible()` 的配置项真实存在 | `npm test` / CI |
| `scripts/tests/config-whitelist.test.mjs` | 配置白名单三方对账：`DEFAULTS` ↔ 两张白名单 ↔ `config.example.json` | `npm test` / CI |
| `.github/workflows/ci.yml` | ubuntu + windows 双平台：`npm ci` → `typecheck` → `test` → `parity` → `build` | GitHub Actions |

验收细节见 [verifying.md](verifying.md)。

---

## 7. 开源版移除了什么、为什么、想加回来怎么做

前一版是**一个人的私人工作台**：里面有一多半东西只对那台机器、那所学校、那个人的账号成立。
开源版按三类处理 —— **保留**（谁拿走都能用）、**泛化**（把写死的个人值换成配置项）、
**移除**（整块不带）。下面把「移除 / 泛化」逐条列清楚，包括**为什么**与**怎么加回来**。

### 7.1 整块移除的功能

| 原来是什么 | 为什么不带 | 想加回来怎么做 |
|---|---|---|
| **校方系统（课表 / 成绩 / 签到 / 考勤）**：曾有一个校内系统模块（多个页面 + 校方接口客户端 + 自动签到），依赖某校的私有接口（要身份凭据与专有 Key）与第三方 H5 签到 | 隐私与合规取舍（别人的身份凭据不该进开源仓库；代替本人完成考勤涉及定位与身份冒用）—— 未随仓库分发 | 写一个 `server/lib/<你的校方客户端>.mjs` 当客户端 + 一组 `/api/*` 路由 + 一个前端模块（三步法）。`#/dev-guide` 的三步模板就是给这件事用的。**注意别提交任何凭据**（见 [CONFIG.md §8](CONFIG.md)） |
| **链路认证保活**：整套实现 + 硬编码的门户地址、加密密钥与认证参数模板，以及只对一台机器成立的网卡 / 出口拓扑结论 | 对一个陌生人不只是无用，是**误导**（照抄参数会指向一个不存在的门户） | 真正值得留的是方法论，不是实现：**「只补登不登出」**与**「判定只认门户只读接口、不信探测」**这两条已经写进 [ARCHITECTURE.md §7](ARCHITECTURE.md) 当设计教训。代码要自己重写（门户地址、加密参数都得你实测） |
| **账号池自动化**：一整套对某商业服务的多账号轮转刷分（六类排程任务、realm 路由绕过、防限流节流） | 它依赖一个未随项目分发的第三方网关，且把「商业服务的账号池运维」做成了产品 —— 开源等于把服务条款风险与凭据管理责任一起转给下游 | **不建议加回来。** 若只想要「用量看板」这个形态，现在的「模型用量」页（`src/features/office/usage.module.ts`）已经是那个形态、且只读、够用 |
| **云盘实现**：播放器 + 上传下载 + 目录别名 | 建在某个云盘的私有接口上 —— **不带任何依赖第三方客户端私有接口 / 逆向的能力**：换个版本就失效，还要把个人账号登录态交给工具 | 接口位已经留好：见 [文件传输.md](文件传输.md)。接 WebDAV / S3 / rclone，**上传下载都做成「起任务 + 轮询」**（照 `memo.mjs` 的任务模型），凭据放 `credentials.json` |
| **两层网关里的云那一层**：本机网关 + 云端那半层，两层共同构成一条链路；仓库里只有本机那一半，且配置里带着真实渠道密钥 | 陌生人拿到手只能看到一半架构 —— 那比不给更糟 | 要这个分层就自己搭两层；那类实现**没有带**。若只想接一个上游，直接用 `server/lib/net.mjs` 的 `request()` 写个薄客户端 |
| **个人画像**：一份可读写的个人档案页，装的是作者的三年主线、停止项与时间线 | 那是**私人人生规划的文本**，不是可复用的功能；抽掉数据后页面几乎是空壳（278 行） | 想要「一个可读写的档案页」，用「语音随记」的 records 或看板的记录做另一种视图即可；**数据侧不要任何种子** |
| **看板的四类数据卡**（课表 / 待办 / 签到 / 早报正文），以及解析某个私人定时任务目录的实现 | 数据源逐条都是上面那些被删模块；砍完只剩空壳 | **骨架与存储留着**（`dashboard.json` 的加固写入 + AI 总结卡 + `summaries.mjs` 的按天存档）。加自己的卡：后端在 `/api/overview` 的返回里加一节（或另开 `/api/*`），前端在 `DashboardHome.vue` 里加一个 `<div class="ws-card block">` —— 写法照现有卡片抄 |
| **对第三方客户端做逆向的本机转写链路** | 不带任何依赖第三方客户端私有接口 / 逆向的能力：依赖一个不随仓库分发的私有工具目录，换个版本就失效 | **任务模型留着**（`memo.mjs` 的 jobs 状态机是通用的：录音 → 起任务 → 轮询进度 → 落成记录）。转写后端换成了标准 provider 接口，出厂只带 OpenAI 兼容 `/whisper` 一个实现（`server/lib/asr.mjs`）—— 自己填端点就行 |
| **X（Twitter）正文抓取的三个非官方镜像 provider** | 靠第三方镜像取正文，可用性与合规性都不稳定；那段逻辑自己都注明「不抓图床、只保留链接」= 本来就是打折的通道 | **通用管道留着**：抓链接 → `raw/sources/*.md` + URL 去重 + 只增不覆盖（`wiki-fetch.mjs` 现在支持 RSS/Atom 与普通网页正文提取）。要接别的来源，按现有的两分支加一条 |
| **某个第三方进程守护工具的接入层**（调它的 exe、读它的配置与审计） | 那个工具没有无界面模式，已被自研引擎取代；**它的源码与回滚材料不随本仓库分发** | 不需要 —— 自研引擎（`pguard.mjs` + `procs.mjs` + `procscan.mjs`）已经是完整替代。若要接别的守护工具，照 `procscan.mjs` 的「快照 → 保护层 → 动作 + 审计」结构写 |
| **一批内部决策文档**（架构评估、需求确认、整合方案、校方接口管控、看板方案、重构调研等 8 篇，约 240 KB） | 全是作者的决策记录与自评：写满了本机绝对路径、被删功能的取舍；且多篇开头就挂着「已被现状推翻」。对外部读者是噪音 | 面向陌生人的三篇已重写：[ARCHITECTURE.md](ARCHITECTURE.md) / [CONFIG.md](CONFIG.md) / [FEATURES.md](FEATURES.md)，加原有的 [design-system.md](design-system.md) / [校历格式.md](校历格式.md) / [每日一句导入.md](每日一句导入.md) / [文件传输.md](文件传输.md) / [verifying.md](verifying.md) |
| **运行日志与验收产物**（`logs/`） | 截图里含个人身份与院校数据，故整目录忽略 | `.gitignore` 从 `*.log` 扩成整目录 `logs/`。要保留示例图就挑 2–3 张**脱敏后**放 `docs/screenshots/` |
| **AI 助手的工作目录残留**（会话记忆、探测脚本、含个人信息的截图、一个验收 skill） | 对项目本身零价值 | 整目录删除并已进 `.gitignore`。其中唯一有复用价值的是那份**验收清单**，已脱敏改写成 [verifying.md](verifying.md) |
| **个人操作残留与来源不明的第三方数据**（云盘 CLI 登录标记、本机选课任务 sqlite、个人词单文本、一份第三方整理的考研院校数据） | 前三个是个人残留；第四个**来源授权不明** —— 别人的整理成果不能随代码一起开源 | 全部删除，`.gitignore` 补上对应条目。考研院校数据若要保留，**先去确认授权**并单列 `LICENSE`/`DATA-LICENSE`，否则换成自采的少量示例 |
| **版权教材内容**（某考研英语课程 418 KB 的句库 + 解析出来的 markdown + 12 份原始 PDF） | 商业课程材料（考点原文 + 解析），**不是**可以随代码开源的内容 | 数据结构与进度逻辑留着（`english-daily.mjs`），转换器留着（`scripts/english-daily-parse.mjs` / `english-daily-build.mjs`）。**自己买课后**按 [每日一句导入.md](每日一句导入.md) 把原始文件放进 `raw/` 再跑解析 |
| **个人数据目录整体**（看板记录、词单与学情、向量索引、聊天记录、录音、转写、审计、每日快照…） | 全是个人数据；其中还包含一个完整的浏览器 profile 与私人录音 | 不进版本库（`.gitignore` 忽略 `server/data/*`，只放行 7 个示例文件）。`server/lib/jsonstore.mjs` 能处理「文件不存在」，所以首启就是空态 |
| **依附于已删模块的脚本**（注册每日签到的计划任务、截图验收、品牌图生成、随记导出测试、要真实词单的 API 测试） | 依附于被删的签到与截图工作流，或需要作者机器的 node 安装位与真实数据 | 随对应模块删除。留下的三个是有意义的基线：`parser-parity.mjs`（对拍）、`pguard-smoke.mjs`（判定）、`scripts/tests/*.test.mjs`（`node:test`） |

### 7.2 泛化过的（把个人值换成了配置项）

逐条对照，**都已落地**（`docs/*.md` 与代码为准）；「还有残留吗」一列是我这次核对的结果。

| 原来 | 现在 | 还有残留吗 |
|---|---|---|
| 主目录硬编码成某个用户名 | `os.homedir()`（`config.mjs:58`），并统一成正斜杠 | 无 |
| 5 处个人绝对路径当默认值（校方接口目录、简报目录、网关目录、守护目录、知识库目录） | 全部改空串；首启给 `server/config.example.json`；**「没配 = 不显示」**由 `visible()` 承担 | 无（`DEFAULTS` 里已无个人路径） |
| `dataDir` 写死绝对数据目录 | `path.join(SERVER_DIR,'data')`；`config.mjs` 导出 `dataDir()` 当唯一入口 | ⚠️ 部分模块没走 `dataDir()`，见 [ARCHITECTURE.md §6.4](ARCHITECTURE.md) |
| 系统提示词里写死过一段**身份类字面量**（学号、姓名、学校等） | 抽成 `ai.persona`（中性默认「服务对象是一名在校大学生」）+ 可选的 `ai.personaPrivate`（落 `credentials.json`）；提示词模板里不再有身份字面量 | 无 |
| 从作者机器的 AI 客户端配置里挖 `sk-` 与 baseURL | **删掉这条通道**。密钥走 `config.json` 的 `llm.keys`（值在 `credentials.json`），baseUrl 走 `newapi.baseUrl` | 无（`wiki-llm.mjs:126,258,348` 的注释曾写「从那个配置读」与实际不符 —— 本轮已改成实际来源） |
| 从另一个应用的配置里迁 MinerU 令牌 | 删掉跨应用读取，只认 `docparse.mineru.token` | 无 |
| LibreOffice / Python 的绝对路径 | `docparse.tools.{pandoc,soffice,python,pdftotext}`；留空先 `where`/`which` 扫 PATH，再回落常见安装位；缺工具时**点名**缺哪个、怎么装 | ⚠️ 这四个字段设置页能填但服务端白名单不放行（[CONFIG.md §3.8](CONFIG.md)） |
| 转写工具的目录写死（一处是常量、一处读配置，两处指向同一个私有工具目录） | 那整条逆向链路已整体移除；转写后端换成标准 provider —— 只需要 `asr.baseUrl`（`server/lib/asr.mjs`），为空时**模块从侧边栏隐藏**。当前代码里**没有** `asr.dir` 这个配置项 | 无 |
| 某个虚拟声卡设备名与 CLI 路径写死（两处不一致） | 两者连同整条本机采集链路一起移除；语音随记现在只接受**拖入 / 选择的音频文件**（`MemoView.vue:448`，页面不做浏览器内录音），因此不依赖特定声卡与特定 CLI。当前代码里没有任何 `captureDevice` / 某个声卡工具的 CLI 名 之类的字段 | 无 |
| 启动脚本里写死某个工具自带的 node 路径 | `sys.executable` / `shutil.which('node')` / `WS_NODE`（`restart-sidecar.py:33-53`） | 无 |
| 启动文件夹与 `wt.exe` 写死 | `os.environ['APPDATA']` + `shutil.which('wt')`，取不到就不用终端 | 无 |
| 运行时生成的 VBS 被误留在仓库里、内部写死 node 与项目绝对路径 | **从仓库删除**并进 `.gitignore`；它由 `panel.mjs:180-203` 在运行时按 `process.execPath` 生成 | 无 |
| 校历的内置 SEED 装着一所学校的校历 | SEED 清空成 `{version:1, school:'', semesters:[]}`；**算法全留**（教学周现算、假期不排课、调休）；示例数据换成「示例大学」并说明字段语义 | 无（示例数据是有意留的，`school` 字段写明是示例） |
| 规划台种子写死个人项目清单与考试日期、来源指向一份私人复盘文件 | `seed()` 改成空结构；`source` 变成通用的「这条是哪来的」自由文本字段，由使用者填 | 无 |
| 词单内置「某天复习的词」、id 带日期 | 换成 30 个**自写释义例句**的通用高频词（无版权顾虑）；`BUILTIN_ID = 'builtin-sample'` 不再带日期 | 无 |
| 单词训练计划默认写死「年级 / 目标考试 / 备注」 | 默认改成空 profile（`grade:''`、`exams:[]`、`note:''`） | 无 |
| 前端写死 `SIDECAR_URL = 'http://127.0.0.1:5278'` | 改成构建期 `VITE_SIDECAR_URL ?? ''`，空则同源相对路径；保留 `?sidecar=host:port` 与 `localStorage` 覆盖与 `/api/auth/token` 引导 | 无 |
| 设置页占位符用作者机器路径当示例 | 换成中性示例（`C:\资料\我的知识库`、`http://127.0.0.1:7890`、`https://your-endpoint.example.com`、`whisper-1`…） | 无 |
| 本机网关的目录回落 | 网关整块移除（含它的云同步那半） | 无（`grep` 无命中） |
| 非官方镜像抓 X 正文 | 三个 provider 摘掉，只留通用管道（RSS/Atom + 正文提取） | 无 |
| 边车顶部一堆指向私有服务的 `import` | 已清到只剩保留模块（`server/index.mjs:13-38`） | 无 |

### 7.3 保留下来的（拿走即用的内核与通用件）

- **内核**：`src/core/{registry,types,storage,ui,appconfig,sidecar}.ts`、
  `src/router/index.ts`（路由表由注册表派生 + chunk 失效自愈）、`src/shell/AppShell.vue`、
  `src/components/{PageHeader,EmptyState,MdLite,SidecarOffline}.vue`、
  `src/styles/{tokens.css,index.css}`、`src/main.ts`（图标白名单 + 摇树）、`index.html`、
  `vite.config.ts`（Element Plus 按需 + `dedupe` 防双份 pinia）、`tsconfig.json`。
- **启动器**：`启动工作站.cmd`、`开发模式.cmd`、`scripts/start.mjs`、`scripts/dev-all.mjs`
  —— 纯相对路径，无个人路径。
- **边车骨架**：`server/index.mjs` 的分发骨架（`route()`/`send()`/`applyCors()`/`readBody()`/`timed()`，
  `:62-171`）、异常兜底、单实例收口；以及 `auth.mjs` / `singleton.mjs` / `jsonstore.mjs` /
  `net.mjs` / `llm.mjs` / `elevate.mjs` / `autostart.mjs` / `panel.mjs` / `mcp.mjs` 的骨架。
- **通用功能**：知识库全套（`src/features/wiki/` 15 个文件 + 8 个 `wiki-*.mjs`）、
  单词（`engine.ts` 出题判分纯函数 / `parser.ts` 七种粘贴格式 / `srs.ts` / `speak.ts` +
  `SpeakButton.vue` / `store.ts` 的「服务端源 + 本地缓存 + 离线可用 + 防抖回写」同步模型）、
  每日一句、`srs.mjs`、`usage-cache.mjs`、进程守护、语音随记的交互与数据模型、
  设置页三段通用表单、`docs/design-system.md`。
- **可当回归基线的脚本**：`scripts/english-daily-parse.mjs`、`scripts/parser-parity.mjs`、
  `scripts/pguard-smoke.mjs`、`scripts/tests/*.test.mjs`。

### 7.4 想加回来：三条通用路径

1. **加一个功能模块**（不需要后端）：`src/features/<名字>/` 写页面 + `module.ts`
   → `src/features/index.ts` 加一行 `registerModule(...)`。侧边栏、首页卡片、路由表自动跟上。
   模板见 `#/dev-guide`、[ARCHITECTURE.md §2.3](ARCHITECTURE.md)，
   **逐步照抄版见 [EXTENDING.md](EXTENDING.md)**（每小节末尾都写了「怎么知道这一步成了」）。
2. **加一个要本机能力 / 要凭据的功能**：`server/lib/<名字>.mjs` 写能力（返回
   `{ ok, error?, ... }`，不要抛异常）→ `server/index.mjs` 加 `/api/*` 路由 →
   前端用 `@/core/sidecar` 的 `api.*` 调。**数据一律走 `server/lib/jsonstore.mjs`**
   （原子写 + `.bak` + 每日快照 + `rev` 并发）。
3. **接一个外部服务**：在 `server/config.mjs` 的 `DEFAULTS` 里加一节（目录 / 端点**默认留空**）、
   在 `SECRET_PATHS` 里登记密钥字段、在 `CONFIG_EDITABLE` 里放行要让用户在页面上改的字段、
   在模块的 `visible()` 里写「没配 = 不显示」。密钥只进 `credentials.json`。

三条纪律（前身踩过，别重复）：

- **长任务做成「起任务 + 轮询」**，不要在一个请求里等完（Node `requestTimeout` 默认 5 分钟）。
- **判定只认权威只读接口**，别用探测结果推断状态。
- **别把别人的凭据、路径、账号池写进代码**：能配置的就配置，只对本机成立的结论写进文档
  的「已知限制」，不要写进默认值。

### 7.5 仍然没有的（缺口清单）

前面几节能删的都删了；下面这些是**还没做**的，不是「删掉了」：

| 缺什么 | 为什么该有 | 成本 |
|---|---|---|
| ~~**LICENSE**~~ | **已补（2026-09-27）**：仓库根的 `LICENSE`（MIT）+ `THIRD-PARTY-NOTICES.md`（第三方来源与许可清单）。`CONTRIBUTING` 仍未单列 | 完成 |
| **`server/credentials.example.json`** | 字段清单其实在 `SECRET_PATHS`（`config.mjs:38-55`）里已经写全了，照它生成一份空值模板即可 | 极低 |
| ~~**`engines` / `.nvmrc`**~~ | **已补（2026-09-27）**：`package.json` 的 `engines.node` = `>=22.6`（`test:parity` 的 `--experimental-strip-types` 门槛）+ 仓库根 `.nvmrc`。注意 `engines` 只是建议，真正的门禁是 CI 锁 `node-version: '22'` | 完成 |
| ~~**CI**~~ | **已补（2026-09-27）**：`.github/workflows/ci.yml`，ubuntu + windows 双平台跑 `npm ci` → `typecheck` → `test` → `parity` → `build` | 完成 |
| **测试** | **现状（2026-09-27）：4 个文件、36 个用例** —— 校历 + 抓取纯函数（`core.test.mjs`）、单实例匹配（`singleton.test.mjs`）、配置白名单三方对账（`config-whitelist.test.mjs`）、注册表契约（`module-contract.test.mjs`）。接着最该补的四块：`jsonstore` 的原子写/回退链/`rev` 冲突、`vocab` 的七种粘贴格式、`srs` 的 SM-2、`wiki` 的检索与 lint —— 全是纯函数或纯文件逻辑，`node:test` 直接跑 | 中 |
| **首启空态逐个验证** | `server/data/` 现在 100% 是「示例 + 空结构」，但**每个模块在无数据时是「空态引导」还是「崩」，没有逐个确认过** | 中 |
| **面向陌生人的最小路径 README** | 现有 README 已经是这份口径（clone → `npm i` → 双击 → 看到哪些页、哪些是空的、怎么填），可继续补一份「外部工具装哪几个」的集中说明 | 低 |
| **MCP 客户端接入样例** | 只有一段 Codex 的配置片段。应补 2–3 份可直接粘贴的（Claude Desktop / VSCode / 通用 stdio），并说明令牌怎么给（`/api/auth/token` 与 `X-WS-Token`） | 低 |
| ~~**品牌与字体资源授权**~~ | **已写清（2026-09-27）**：见 `THIRD-PARTY-NOTICES.md` —— `src/assets/katex-fonts/*.woff2` 是 KaTeX 发行版自带的字体（上游 MIT，随包分发没问题），`src/assets/brand/ws-logo.webp` 为本项目自制、随本项目许可（MIT）分发 | 完成 |
| **示例截图** | 要在 README 里展示界面，就先挑 2–3 张**脱敏后**的图放 `docs/screenshots/` | 低 |

---

相关文档：[ARCHITECTURE.md](ARCHITECTURE.md)（分层 / 启动 / 已知限制）、
[CONFIG.md](CONFIG.md)（配置逐项 / 环境变量 / 不能提交什么）、
[EXTENDING.md](EXTENDING.md)（照着它加一个自己的模块）、
[PERFORMANCE.md](PERFORMANCE.md)（实测的慢点与体积）、
[design-system.md](design-system.md)（样式纪律）、[verifying.md](verifying.md)（改完怎么验）、
[校历格式.md](校历格式.md)、[每日一句导入.md](每日一句导入.md)、[文件传输.md](文件传输.md)。
