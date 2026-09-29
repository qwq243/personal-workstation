# 改完怎么验

这个仓库的验收不靠人肉点页面：能在命令行跑完的都在命令行跑。改完代码按下面的顺序过一遍。

## 0. 一条命令的基线

```bash
npm test          # node --test "scripts/tests/*.test.mjs"
```

5 个文件、46 个用例，覆盖的是**纯逻辑**：校历的判定与优先级、抓取用的 slug / feed 识别、
单实例闸的匹配、配置白名单的三方对账、注册表契约、转写热词纠错。
不连网、不读你的数据目录、不碰你的文件 —— 所以它随时可以跑，也应该进 CI。

## 1. 前端能构建

```bash
npm run build
```

这一步会**先跑 `check:pages`**（页面宽度门禁：新页面自己写了个 `max-width` 就会被拦下），
再 `vite build`；顺带发现：删了模块忘了清 import、改了 `module.ts` 的导出名、模板语法错误。
（`npm run typecheck` 是更严的 `vue-tsc`，日常改完建议加跑一次。）

## 2. 边车能起来

```bash
npm run server      # 或双击「启动工作站.cmd」
```

启动日志里应该看到：端口、访问控制是否开启、知识库监听状态、进程守护引擎状态。
**两条容易被忽略的**：
- 首次运行会生成 `server/config.json`（含随机令牌）；
  `server/credentials.json` **不在这时候生成** —— 它是「第一次保存密钥」时才出现的
  （`saveConfig()` 收到敏感项，或启动时把老 `config.json` 里的明文密钥迁移过去）。
  **从来没配过密钥就一直不存在，这是正常状态，不是装坏了。**
- 没配的模块只打一行提示，不该让启动中断（历史上踩过「一步抛异常、后面整段被跳过」）。

健康检查：`http://127.0.0.1:5278/api/health`。

## 3. 依赖真机的两项（单独跑）

```bash
npm run test:parity    # 前后端两套词条解析器对拍（改了任一解析器就必须跑）
npm run test:pguard    # 进程守护引擎的判定（只读 + 演练模式，不改配置）
```

`test:pguard` 会打印：引擎状态、阈值、名单规模、这一拍的判定明细。
它**不启动引擎、不动手**（`--no-start`），只是让你一眼看到「700 个进程里它选了谁、为什么」。

## 4. 改到这几块时的额外检查

| 改了什么 | 还要看什么 |
|---|---|
| 进程守护的判定规则 | `npm run test:pguard`，重点看「未动手」的理由对不对 |
| 词条解析（前端 `parser.ts` / 服务端 `vocab.mjs`） | `npm run test:parity`，两份实现必须一致 |
| 校历算法 | `npm test` 里的校历那组；再拿一份真实校历手算两周核对 |
| 抓取（`wiki-fetch.mjs`） | 找一个公开博客页 + 一个 RSS 源各抓一次；确认同名文件不会被默默覆盖 |
| 看板存储（`dashboard.mjs` / `jsonstore.mjs`） | 手动把 `dashboard.json` 写坏一次，确认它能从 `.bak` / 每日快照回退并留证 |
| 前端路由 / 注册表 / `category` | 侧边栏条目数对不对；「没配 = 不显示」的模块确实不在（`visible()`）；分组里一个不少（`npm run check:nav`） |
| 页面宽度 / 版面 | `npm run check:pages`（`npm run build` 前自动跑）；再在真机上过一遍 `npm run check:mobile` |
| 暗色 / 主题 | `npm run check:dark`（亮斑）、`npm run check:theme`（四档切换的功能测试） |
| AI 对话界面 | `npm run check:ai-ui`：套件（`src/ai/`）之外不许再手写气泡 / 工具链 / 推理折叠 |
| 公式排版（`src/features/wiki/math-typeset.ts`） | `npm run test:math`：拿真实知识库内容跑不变式（不含 `$` 的内容不许出现 KaTeX 段） |
| 边车路由 | 每个新接口都该有：`ok:false` + 可读的 `error`，而不是 500 |

### 4.1 前端防回归门禁（六条，都要真机 + 浏览器）

2026-09-30 起仓库带了一组「前端不变量」门禁 —— 它们把原来靠肉眼看的观感变成可复跑的断言。
跑之前**先起边车**（`npm run server`），并且本机装了 Chrome 或 Edge（装在不常见的位置就用
`WS_CHROME` 指路径）；边车不在默认端口就 `WS_BASE=http://127.0.0.1:<端口>`。

```bash
npm run check:pages     # 页面宽度：≥640px 的 max-width 必须写理由（已在 build 前自动跑）
npm run check:nav       # 侧边栏：箭头与图钉互补、每行每组的图标都渲染、功能一个不少不重
npm run check:mobile    # 手机档（390×844）逐路由：不许横向溢出
npm run check:dark      # 暗色：逐路由量计算样式，列出「浅底 + 有文字」的亮斑
npm run check:theme     # 主题四档功能测试：真鼠标事件 + 真重载（点相反的那一档才算数）
npm run check:ai-ui     # AI 界面收口：套件之外不许再出现 bubble / reason / thinking / typing 类名
```

带 `--shots` 的变体会顺手存截图（`check:nav:shots` / `check:mobile:shots` / `check:dark:shots`），
产物在 `logs/` 下（整目录已忽略，不会进仓库）。

**为什么没进 CI**：这几条要「起边车 + 起本机浏览器 + 真鼠标事件」，CI 里没有这个环境；
唯一进了 CI 的是 `check:pages`（挂在 `npm run build` 之前，属于构建的一部分）。
CI 里跑的是另一组：`typecheck` / `npm test` / `parser-parity` / `build`。

## 5. 提交前顺手确认

- 没有把真实数据加进版本库。`.gitignore` 忽略了 `node_modules/`、`dist/`、`logs/`、
  `server/config.json`、`server/credentials.json`、`.env`、`*.session`、`cookies*`，
  以及 `server/data/*` 的全部内容 —— **只放行** `.gitkeep` / `README.md` /
  `dashboard.json` / `plan.json` / `school-calendar.json` / `vocab/{lists,progress}.json`
  这 7 个示例文件。改完 `server/data/` 之后建议验一遍：

  ```bash
  cd server/data && git status --short .    # 只该出现上面那几个，多出来的说明漏了忽略规则
  ```

  如果你用 `git add -f` 强行加过别的东西，先撤回来；
- 新加的配置项在 `server/config.example.json` 里也有一条（带说明）；
- 新的个人路径 / 密钥没有写进代码与文档。
