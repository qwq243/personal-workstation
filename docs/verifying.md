# 改完怎么验

这个仓库的验收不靠人肉点页面：能在命令行跑完的都在命令行跑。改完代码按下面的顺序过一遍。

## 0. 一条命令的基线

```bash
npm test          # node --test "scripts/tests/*.test.mjs"
```

覆盖的是**纯逻辑**：校历的判定与优先级、抓取用的 slug / feed 识别。
不连网、不读你的数据目录、不碰你的文件 —— 所以它随时可以跑，也应该进 CI。

## 1. 前端能构建

```bash
npm run build
```

这一步会连带发现：删了模块忘了清 import、改了 `module.ts` 的导出名、模板语法错误。
（`npm run typecheck` 是更严的 `vue-tsc`，日常改完建议加跑一次。）

## 2. 边车能起来

```bash
npm run server      # 或双击「启动工作站.cmd」
```

启动日志里应该看到：端口、访问控制是否开启、知识库监听状态、进程守护引擎状态。
**两条容易被忽略的**：
- 首次运行会生成 `server/config.json`（含随机令牌）与 `server/credentials.json`；
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
| 前端路由 / 注册表 | 侧边栏条目数对不对；「没配 = 不显示」的模块确实不在（`visible()`） |
| 边车路由 | 每个新接口都该有：`ok:false` + 可读的 `error`，而不是 500 |

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
