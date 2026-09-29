# AI 界面收口规约

**所有 AI 对话界面一律走 `src/ai/` 这套。** 别在页面里再手写气泡、输入框、工具链、推理折叠。

2026-09-27 定的。定之前是几个页面各写各的：知识库问答的工具链是一排灰胶囊、
语音随记的分段进度是自己画的一列 `is-done/is-running`、看板 AI 是另写的一套气泡 —— 
三份实现还都不太一样，改一处要改三遍。

## 用什么

底层是 **`vue-element-plus-x`**（MIT，基于 Element Plus 的 AI 组件库）。
选它的三个理由：

1. **主题零适配**：它的样式内部是 `--elx-*: var(--el-color-primary)` 这样从 EP 令牌映射出来的，
   而 `tokens.css` 已经把工作站的设计令牌挂到了 `--el-*`（含深色），所以它进来就是工作站的配色。
2. **它自带我们原来缺的三样**：`BubbleList` 的 `autoScroll`（贴底才跟随、用户上滑就中断）、
   `virtual`（虚拟滚动）、`backButton`（滚上去之后「回到最新」带未读数）。
3. **输入法守卫**：`XSender` 底层 `x-sender` 处理了 `compositionstart/end` + `isComposing` + keyCode 229，
   而我们原来三处 `@keydown.enter.exact.prevent` 都没挡输入法组合态。

> ⚠️ 别装错包：npm 上有两个名字像的 —— `vue-element-plus-x`（这个，v2.x，AI 组件）和
> `element-plus-x`（v1.x，2025-09 停更，拖着 tiptap + formily）。**装后者等于白装。**

## 套件有什么

| 文件 | 管什么 |
|---|---|
| `src/ai/model.ts` | 统一消息模型 `AiMessage` + 内部事件 `AiStreamEvent` |
| `src/ai/adapt.ts` | 两个事件适配器（知识库 / 随记）+ 共享 reducer `applyEvent` |
| `src/ai/AiChat.vue` | 对话外壳：BubbleList + Bubble + Welcome/Prompts + XSender |
| `src/ai/AiThoughts.vue` | 工具链（`ThoughtChain`）+ 推理（`Thinking`） |

`adapt.ts` 把两套线上帧归一成同一组内部事件，页面**不要再自己 switch 事件类型**。
它刻意保留了三处不能抹平的差异（中断语义、各自的收尾动作、随记独有的 `start` 与 `learned`），
那些留在页面里。

## AiChat 的插槽

| 插槽 | 填什么 | 谁在用 |
|---|---|---|
| `#welcome-extra` | 空态下面额外的说明 | — |
| `#sender-header` | 输入框上方的工具条（模型选择、检索开关、技能） | 知识库问答 |
| `#sender-extra` | 输入框内部的头部（参数面板之类的紧凑控件） | — |
| `#message-meta` | 气泡头部（模型、耗时、ttfb、finishReason、用量） | 知识库、看板 |
| `#message-content` | **正文渲染器** | 知识库传 `WikiMarkdown`；看板传 `MdLite`；不传则纯文本 |

| `#message-refs` | 依据列表 | 知识库 |
| `#message-actions` | 每条消息的动作（复制 / 重试） | 知识库 |
| `#footer` | 输入框下方的状态行 | 四个页面 |

**两个必须遵守的点：**

1. **正文一律走 `#message-content`，不要给 `Bubble` 传 `content` prop** ——
   库在给了 `#content` 插槽时就不渲染 `content`，而我们的正文要自己排（KaTeX、表格、`[[双链]]`、
   `[N]` 上标）。另外 `Bubble` **没有 `typing` 这个 prop**（核对过 2.0.3 的类型定义），
   流式光标在 `AiChat` 里自己留了一个。
2. **知识库的依据不能用 `Attachments` / `FilesCard` 替** —— 依据的序号 `[N]` 与正文上标
   是一一对应的契约（点正文上标要跳到对应依据），换成通用组件会丢这个映射。

## 规矩，以及它怎么被执行

```bash
npm run check:ai-ui     # 套件之外不许再有手写对话骨架
```

两条断言：
1. `.vue` 里调了 `wikiChatStream` / `memoSummarizeStream`，就必须 import 了 `@/ai/`；
2. 套件之外不许再定义 `bubble` / `reason(ing)` / `think(ing)` / `thought` / `typing` 这些类名。

第 2 条只在**真正的类名语境**里匹配（`class="…"`、`:class`、样式选择器行），不匹配普通标识符 ——
否则 `last.reason`（数据字段）、`'thinking'`（事件枚举值）会被误报，而误报会让人很快无视这道门禁。

确实该保留的：在那一行附近注 `ai-ui-allow: 为什么`。

## 服务端配套

工具事件带了结构化字段（2026-09-27 起，知识库问答与语音随记共用）：`{ id, name, detail, status: 'running'|'ok'|'fail'|'skip', ms, count }`。

- **`status` 是必须的**：原来只有拼在 `detail` 里的中文前缀（「失败：」「跳过：」），
  前端判断成败只能匹配字符串 —— 服务端改一句话就静默全变成「成功」。
- **`id` 是心跳这类反复下发步骤的必需品**：前端按 id 原地更新同一行，否则每 2 秒长出一行。
- 知识库问答有**心跳**（每 2s 一条 `id='wait'` 的 running 事件）：开了「补检索」时那一步的
  模型调用最长 60s，原来期间一条事件都不发，用户盯着空屏等一分钟。语音随记早就有 2 秒 tick。

`ThoughtChain` 只认 `loading / error / success` 三种状态，所以映射是**降级**的：
`skip`（按配置跳过）映射成 `success` + 标题里写「跳过」——别为了图标好看把它塞进 `error`，
那会把「按配置跳过」误报成失败。

## 还没做的

- **看板 AI 仍是非流式**（`/api/ai/ask` 一次性返回）→ 所以它没有推理与工具链可显示。
  换成流式要服务端另开 SSE 端点。
- **模型选择器没统一**：知识库是字符串数组、看板只读 overview，抽共享控件要先在服务端加一个归一化清单接口。
- **单个请求级的「思考档」覆盖**没做：现在只能在设置里改预设，请求体里没有这个字段。
