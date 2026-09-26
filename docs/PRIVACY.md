# 脱敏说明

写给**二次修改这个仓库的人**：开源前做过哪些脱敏、哪些东西被移除或被参数化、以及**你自己怎么再扫一遍**。

第 7 节的检查都是可以直接复制粘贴运行的 —— 请照着跑，不要靠眼睛看。

> 判据只有一条：**这份文件里出现的东西，能不能被一个陌生人用来指到某个人、某台机器、某个账号？**
> 能，它就不该进版本库。

---

## 0. 六类，先记住

| 类别 | 判据 | 做法 | 现在靠什么保证 |
|---|---|---|---|
| **身份** | 谁在用这台机器 | 参数化；整块移除依赖身份的模块 | 出厂默认是中性文案；身份信息只允许出现在本机 `credentials.json` |
| **校方** | 哪个学校、哪套教务 | 整块移除；只留算法与格式 | 种子数据清空；示例校历写「示例大学」 |
| **凭据** | 能登录的东西 | 全部收进 `credentials.json`；**删掉旁路取密钥的代码** | `SECRET_PATHS` 拆分 + `.gitignore` + 首次运行随机生成 |
| **路径** | 别人机器上的绝对路径 | 参数化为空串，运行时推导 | 目录类配置项出厂全是 `""`；`os.homedir()` 代替硬编码 |
| **私人服务** | 只有作者能连的端点 | 移除；只留架构说明 | 端点默认空串；云端那半层不附实现 |
| **私人数据** | 作者自己的内容 | 删除 + 整目录忽略 | `server/data/*` 只放行 7 个示例文件 |

---

## 1. 身份

**被参数化的**

- `server/lib/ai.mjs:105-113` —— 系统提示词里的身份抽成了配置项：

  ```js
  const base = String(cfg.ai?.persona ?? '').trim() || '服务对象是一名在校大学生'
  const extra = String(cfg.ai?.personaPrivate ?? '').trim()
  ```

  想写具体身份（学校 / 专业），写进 `credentials.json` 的 `ai.personaPrivate` ——
  它在 `SECRET_PATHS`（`server/config.mjs:44`）里，**不会落到会被人拷来拷去的 `config.json`**。

- `src/features/vocab/builtin.ts` —— 内置词单换成 **30 个通用高频词**，释义与例句都是自己写的，
  id 也从 `builtin-2026-09-12` 改成稳定的 `builtin-sample`（`builtin.ts:12`）。
  不带日期是有意的：日期进 id 会让「换一份示例词」变成换一个 id，老进度就找不着了。
- `src/features/vocab/store.ts:39-42` —— 目标画像出厂全空，个人描述移进页面上的首次使用引导：

  ```ts
  const DEFAULT_PLAN: VocabPlanState = {
    profile: { grade: '', exams: [], listenHabit: 'daily', note: '' },
    diagnosis: null,
  }
  ```

**被整块移除的**（这些不是「没做完」，是依赖个人身份的取舍）

| 移除了什么 | 为什么 |
|---|---|
| 教务查询、自动签到 | 要学号密码、要定位、要微信 `openId`；替本人完成考勤既是隐私问题也是合规问题 |
| 看板纸片（PaperTodo） | 依赖本机桌面程序的 MCP 与插件快照 |
| 校园网认证保活 | 钉死一所学校的门户地址与认证参数；里面的结论只对那台机器成立 |
| 第三方进程守护接入层 | 依赖一份不随仓库分发的第三方工具与其 `%APPDATA%` 配置 |

README 的 [「不含什么」](../README.md#不含什么以及为什么) 一节对外解释了这些取舍，
**不要**为了「功能更全」把它们加回来。

---

## 2. 校方

**种子数据清空**

`server/lib/school-calendar.mjs:36`：

```js
const SEED = { version: 1, school: '', note: '', semesters: [], holidays: [], workdays: [] }
```

**算法一行没删** —— 教学周现算、假期不排课、调休、事件优先级（`EVENT_RANK`）都还在。
这个模块值钱的是算法，不是某一所学校的数据。

**示例数据与格式文档**

- `server/data/school-calendar.json` 的 `school` 写的是 `"示例大学（示例数据 —— 换成你学校的校历）"`；
- [校历格式.md](校历格式.md) 说明字段语义与「换学年改哪个文件」。

**商业教材数据删除**

`server/data/english/daily-sentence/` 原来装着一整套备考课程的《每日一句》
（`sentences.json` 418 KB，`raw/*.pdf` 共 12 份）—— 那是**考点原文加解析**，不是能随代码分发的东西。
现在仓库里：

- **删**：全部句库与 PDF；
- **留**：`scripts/english-daily-parse.mjs`（MinerU 结果 → 句库的纯转换脚本）、
  `server/lib/english-daily.mjs`（数据结构与进度指针）、[每日一句导入.md](每日一句导入.md)
  （说明「自己买课后按这个格式放 `raw/` 再跑解析」）。

模块描述里的教材名也一并去掉了。

**外部工具的报错文案要点名缺哪个**（`server/lib/wiki-parse.mjs:28-35` 的 `TOOL_HINTS`）：

```js
soffice: '装 LibreOffice，或把 soffice.com 的路径填进设置页的 docparse.tools.soffice（注意要 .com 不是 .exe）'
```

「抽不出文字」这种报错对使用者没有信息量，也不该让人猜。

---

## 3. 凭据

**哪些字段算敏感**：`server/config.mjs:38-56` 的 `SECRET_PATHS`，共 10 条 ——
`newapi.token`、`asr.apiKey`、`ai.personaPrivate`、`llm.keys`、`search.apiKey`、`embedding.apiKey`、
`docparse.mineru.token`、`wiki.mineru.token`，以及两条给迁移期用的旧路径。
读写一律走 `loadConfig()` / `saveConfig()`，写盘时自动拆到 `credentials.json`。

**令牌首次运行随机生成**（`server/config.mjs:420`）：

```js
return randomBytes(24).toString('hex')
```

所以**仓库里没有任何一个可用令牌**，也不需要人手工造。

**`.gitignore` 里的相关规则**（共 73 行，节选）：

```gitignore
server/config.json
server/credentials.json
server/.server.log
**/*secret*.json          # 兜底：任何名字带 secret 的 json 都别提交
.env
.env.*
!.env.example
*.session
*.pem
*.key
cookies.txt
cookies.json
*.cookies
```

`**/*secret*.json` 这条是**故意写宽的**：比逐个列文件名更不容易漏。

**被删掉的「旁路取密钥」代码** —— 这一类最值得记住，因为它比明文更隐蔽：

| 原来干了什么 | 为什么必须删 | 现在怎么办 |
|---|---|---|
| 从作者本机某个 AI 客户端的配置文件里挖出 `sk-` 与 `baseUrl`（那个私有路径已从本文件移除，不复述） | 密钥应该只有一个正规去处，多一条通道就多一个泄漏面 | 删掉通道；密钥只在 `credentials.json` 的 `llm.keys`，`baseUrl` 走设置页（默认 `""`） |
| 从已退役的桌面端状态文件（`%APPDATA%/<app id>/app-state.json`）迁 MinerU 令牌 | 跨应用读别人的私有配置 | 删掉；只认 `docparse.mineru.token`。真要迁移就写个一次性 CLI，默认不跑 |
| 从教务的 `.env` 里读专有请求头中的管理员 Key、学号密码 | 别人的密钥不该进这个仓库 | 整个教务客户端已删 |

---

## 4. 路径

**出厂配置项全是空串** —— 这是能自动验的，看 `server/config.example.json`：
`wiki.dir`（:131）、`pguard.dataDir`（:52）、`docparse.tools.*`（:114-117）、
`asr.baseUrl`（:40）、`newapi.baseUrl`（:18）全是 `""`。

对应的内核约定是 [ARCHITECTURE.md](ARCHITECTURE.md) 里那条
**「没配 = 不显示」**：模块的 `visible()` 读配置，没配好就从侧边栏消失，
而不是点进去看一页报错。现有两个模块在用它（`src/features/wiki/module.ts:23`、
`src/features/memo/module.ts:23`）。

**主目录不硬编码**（`server/config.mjs:58`）：

```js
/** 当前用户主目录 —— 自启位这类「跟着用户走」的路径从它派生，不硬编码任何用户名 */
const HOME = os.homedir()
```

**Python 脚本不再写死 node 路径**（原来三处写死一个随 WorkBuddy 升级就会变的绝对路径）：

```python
# scripts/restart-sidecar.py:44   —— 先环境变量，再 PATH，最后常见安装位
found = shutil.which("node")
# scripts/restart-sidecar.py:59   —— 启动文件夹从 %APPDATA% 推
os.path.join(os.environ.get("APPDATA", ""), "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
# scripts/restart-sidecar.py:64   —— wt.exe 取不到就不用它
return shutil.which("wt") or ""
```

`scripts/sidecar-keepalive.py` 同样处理。

**运行时的自启脚本不进版本库**：`工作站管家.vbs` 由 `server/lib/panel.mjs` 在运行时生成
（用 `process.execPath` 取 node 路径，这是对的），`.gitignore` 里有一条专门忽略它。

**占位符改成中性示例** —— 占位符是给人抄的，用作者本机路径当示例等于误导：

```
src/views/SettingsView.vue:461        placeholder="C:\资料\我的知识库"
src/features/wiki/WikiIngestView.vue:201   placeholder="C:\资料\xxx.pdf"
src/features/settings/SearchSection.vue:191 placeholder="如 C:\资料（留空 = 不限目录）"
```

**⚠ 这一类最容易漏的是转义写法**（同一条路径的双反斜杠 / 正斜杠形态）—— 第 8 节记了本轮抓到并清掉的那几处。

---

## 5. 私人服务

| 被移除的端点 | 那是什么 |
|---|---|
| `<自建面板域名>` | 作者自建的面板 | 
| `127.0.0.1:<教务接口端口>` | 本机教务接口服务 |
| `127.0.0.1:<网关端口>` | 本机 WorkBuddy 转 OpenAI 网关 |
| `<上游教务服务器 IP>:<端口>` | **同学那台**上游教务服务器 |
| `<uniCloud 实例 IP>` / `<uniCloud spaceId>` | 自己部署的 uniCloud 实例 |

**云端那半层不在本仓库里** —— 原来的 `cloud-sync.mjs` / `gateway.mjs` 是「本机网关 + 云网关」两层结构，
而**云网关不在仓库里**。陌生人拿到手只能看到一半架构，所以整块删掉，
只把分层本身写进 [ARCHITECTURE.md](ARCHITECTURE.md)。

`newapi.baseUrl` 走设置页、默认空串；填任何 OpenAI 兼容端点都能用。

**非官方镜像也删了**：知识库抓链接原来走 fxtwitter / vxtwitter / X syndication 三个第三方镜像取正文，
可用性与合规性都不稳定 —— 这种风险不该由下游使用者继承。
现在只留「抓链接 → `raw/sources/*.md`」的通用管道（`server/lib/wiki-fetch.mjs`），
改接官方 RSS / sitemap / 公开可读页面。

---

## 6. 私人数据

**`server/data/` 整目录忽略，只放行 7 个示例文件**：

```
server/data/*
!server/data/.gitkeep
!server/data/README.md
!server/data/dashboard.json          # 空结构
!server/data/plan.json               # 空结构
!server/data/school-calendar.json    # school 写的是「示例大学」
!server/data/vocab/
server/data/vocab/*
!server/data/vocab/lists.json        # 空结构
!server/data/vocab/progress.json     # 空结构
```

> 注意 `.gitignore` 的写法：**不能**直接写 `server/data/`，
> 否则下面的 `!` 规则全部失效（git 不允许重新包含一个父目录已被排除的文件）。

`server/data/README.md` 对外解释了这个目录：**你现在看到的是示例，不是谁的数据**；
想看填满的界面跑 `npm run demo:seed`（日期按「今天」推算，不会过期），`npm run demo:reset` 清回空结构。

**被删除的私人数据**（这些都是「随仓库分发就等于泄漏」的东西）：

| 原来是什么 | 体积 | 为什么危险 |
|---|---|---|
| 备考教材句库 `english/daily-sentence/` | 418 KB | 商业课程材料（见第 2 节） |
| 个人画像 `<个人画像文件>.json` | 55 KB | 三年主线、理论透镜、时间线 |
| 个人词单 `vocab/lists.json` | 32 KB | 私人学习内容 |
| 考研院校数据 `<院校数据文件>-*` | 335 KB | 第三方整理，**来源授权不明** |
| 录音 `memo/` 与转写日志 `asr/` | — | 私人录音 |
| 网盘浏览器 profile `<网盘浏览器 profile 目录>/` | 一个完整 Chrome profile | **可能含网盘 cookie** |
| 选课任务库 `data/course_selection_tasks.db` | 49 KB | 个人操作痕迹 |
| 个人词单文本 `<个人词单文本>.txt` | 1.7 KB | 私人内容 |
| 运行日志与截图 `logs/` | 25 MB / 168 个文件 | 其中 161 个不是 `.log`：97 张界面截图里**看得到学号、课表、成绩、余额** |
| AI 助手工作目录 `.workbuddy/` | — | 会话记忆、校方接口探测脚本、20+ 张含学号与成绩的截图 |
| 网盘 CLI 登录标记 `.quarkclouddrive/` | — | 登录探测残留 |

对应的忽略规则（`.gitignore` 末节）：

```gitignore
单词导入-*.txt
/data/
.quarkclouddrive/
.workbuddy/
logs/
```

**`logs/` 整目录忽略**，而不是只忽略 `*.log` —— 这是踩过的坑：
`*.log` 挡不住 97 张 `.png`。

---

## 7. 复查方法

### 7.1 字面量扫描（有名单，最准）

把下面这个存成 `scripts/privacy-scan.mjs`，**先把 `PATTERNS` 里每条占位符换成你自己要扫的值**，
然后 `node scripts/privacy-scan.mjs`。退出码 0 = 干净、1 = 有命中，可以直接挂 pre-commit / CI。

> 为什么名单要自己填：这份文档本身要进版本库 —— 如果它带着**真实值**，它就是新的泄漏点。
> 所以下面给的是「类别 + 填空模板」：值从哪来，看第 1–6 节列的那些类别（身份 / 校方 / 凭据 / 路径 / 私人服务 / 私人数据）。

```js
/**
 * 脱敏复查：扫一遍仓库，看还有没有下线的字面量。
 *   node scripts/privacy-scan.mjs            # 扫当前目录
 *   node scripts/privacy-scan.mjs ../某分支   # 扫别的目录
 *
 * 两个设计决定，别改成别的样子：
 *
 * 1. **凭据只留前缀**（如 `sk-Ab12Cd…`），不留整串。
 *    这个文件是要进版本库的 —— 如果它自己写着可用的 API Key，那它就变成了新的泄漏点。
 *    前缀要够长（一般 8 位以上）才够定位到是哪一条，也才够让 indexOf 命中。
 *
 * 2. **每份文件扫两遍**（原文 + 反斜杠统一成斜杠之后）。
 *    同一条路径在代码里可能是 `C:/work/myapp`、`C:\\work\\myapp`（字符串里的双反斜杠）、
 *    或模板串里的 `C:\work\myapp`。只按原文比对会漏掉转义变体 —— 这不是假想：
 *    `scripts/tests/singleton.test.mjs` 里那几条断言就是双反斜杠写法，
 *    斜杠化之后才会命中（第 8 节记的就是它们）。
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * 下线的字面量 —— **这是一个填空模板，不是能直接跑的名单**。
 *
 * 开源前，这个数组里写着作者本人的学号、姓名、学校、域名、IP、MAC、凭据前缀与
 * 本机绝对路径；那些值**已全部从本文件移除**，换成了下面这些占位符。
 * 用之前先把每条 `<…>` 换成**你自己**要扫的值（值从哪来：见第 1–6 节列的那些类别）。
 *
 * 路径一律用斜杠写，反斜杠变体交给第二遍。
 */
const PATTERNS = [
  // ── 身份 ─────────────────────────────────────────────
  '<你的学号>', '<同学/家人的学号>', '<你的姓名>', '<你的昵称或花名>',
  '<你的学校全名>', '<学校附属机构全名>',
  '<你的常用账号名>', '<同学的账号名>', '<同学的口令>',

  // ── 校方（域名 / 内网地址 / 认证门户参数 / 设备 MAC）──
  '<教务域名>', '<资源站域名>', '<认证域名>',
  '<教务系统的路径标识>', '<认证门户的设备标识>', '<认证参数>', '<认证签名密钥>',
  '<内网网关地址>', '<你所在网段的本机地址>', '<另一条出口的本机地址>',
  '<教务对外地址 1>', '<教务对外地址 2>', '<教务对外地址 3>',
  '<微信签到的 openId>', '<打卡计划任务名>',
  '<网卡 MAC 1>', '<网卡 MAC 2>', '<网卡 MAC 3>', '<网卡 MAC 4>',

  // ── 凭据（只留前缀，理由见文件头注释 1）──────────────
  '<面板/教务密钥的前 8 位>',
  '<sk- 密钥①的前 8 位>', '<sk- 密钥②的前 8 位>', '<sk- 密钥③的前 8 位>',
  '<短令牌①的前 8 位>', '<短令牌②的前 8 位>', '<短令牌③的前 8 位>',
  '<短令牌④的前 8 位>', '<短令牌⑤的前 8 位>',

  // ── 路径 ─────────────────────────────────────────────
  '<你的日常目录>', '<你的项目目录>', '<你的课程目录>',
  '<你的 Windows 用户目录>', '<本机 node 安装位>',
  '<私人软件安装目录 1>', '<私人软件安装目录 2>', '<私人工具安装目录>',
  '<私人 AI 客户端的配置路径>', '<已退役桌面端的 app id>', '<便携运行库名>',

  // ── 私人服务 / 私有项目 ──────────────────────────────
  '<自建面板域名>', '<自建云实例地址>', '<上游服务器地址>', '<云服务 spaceId>',
  '127.0.0.1:<私有服务端口>', '127.0.0.1:<另一个私有端口>', '<你的模型 provider 名>',
  '<密钥文件名>', '<课表快照文件名>',
  '<教务接口目录>', '<知识库目录 1>', '<知识库目录 2>',
  '<早报目录>', '<网关项目名>', '<ASR 工具目录>', '<进程守护工具目录>',
  '<插件目录>', '<你的产品项目名>',
  // 关于裸词：如果你把「知识库」这种通用名词也单列一条，命中时先看上下文 ——
  // 当普通名词讲「一个知识库」是可以的，当成某个具体库的目录名就不行。
]

/**
 * 已知良性命中：文件名 + 字面量，形如 `['相对路径', '字面量']`。
 * 用来豁免「文档里刻意写给读者看的排错提示」这一类 —— 比如 README 里那句
 * 「密钥文件叫 `credentials.json`，**不是** 另一个名字」，那是教学语句，不是泄漏。
 * 除这种明确的教学语句以外，任何命中都要当真，别往这里加。
 */
const BENIGN = [
  // 留空的写法：只有「刻意写给读者看的排错提示」才允许豁免，条目形状是
  //   ['README.md', '<你在 PATTERNS 里也列过的那个词>']
  // README 里就有一条这样的提示（「密钥文件叫 `credentials.json`，不是另一个名字」）——
  // 你把自己的词填进 PATTERNS 之后，如果它恰好命中那句话，照上面的形状加一条即可。
  // 除这种教学语句以外，任何命中都要当真，别往这里加。
]

/**
 * 含「下线名单」的文件必须整份跳过 —— 否则它扫自己会永远报错。
 * 本文的正文里就嵌着下面这份 PATTERNS，所以它带着这个标记；本文件也带着。
 * 想确认这份豁免有没有被滥用，直接看哪几个文件带标记：
 *   grep -rl "oss-privacy-scan:skip-file" --exclude-dir=node_modules .
 */
const SELF_MARK = 'oss-privacy-scan:skip-file'

const ROOT = process.argv[2] ?? '.'
const SKIP_DIR = new Set(['node_modules', 'dist', '.git', '.vite', '.idea'])
const SKIP_EXT = /\.(png|jpe?g|webp|gif|ico|woff2?|ttf|otf|zip|pdf|mp3|wav|mp4|webm)$/i

let files = 0
let hits = 0

;(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      walk(p)
      continue
    }
    if (SKIP_EXT.test(e.name)) continue

    const raw = fs.readFileSync(p, 'utf8')
    if (raw.includes(SELF_MARK)) continue // 含下线名单的文件，跳过（见 SELF_MARK 注释）
    files++
    const lines = raw.split('\n')
    const seen = new Set()

    for (const [label, text] of [
      ['原文', raw],
      ['斜杠化', raw.replace(/\\+/g, '/')],
    ]) {
      for (const pat of PATTERNS) {
        if (BENIGN.some(([f, q]) => p.endsWith(f) && q === pat)) continue
        let i = text.indexOf(pat)
        while (i >= 0) {
          const line = text.slice(0, i).split('\n').length
          const key = `${line}|${pat}`
          if (!seen.has(key)) {
            seen.add(key)
            hits++
            console.log(`${p}:${line}  [${label}] 命中「${pat}」`)
            console.log(`      ${(lines[line - 1] ?? '').trim().slice(0, 100)}`)
          }
          i = text.indexOf(pat, i + 1)
        }
      }
    }
  }
})(ROOT)

console.log(
  hits
    ? `\n✗ ${hits} 处命中（扫了 ${files} 个文件，${PATTERNS.length} 条字面量）`
    : `\n✓ ${PATTERNS.length} 条字面量一处都没命中（扫了 ${files} 个文件）`,
)
process.exit(hits ? 1 : 0)
```

**跑完怎么看**：

```
<某文件>:<行号>  [斜杠化] 命中「<你填进去的某条字面量>」
      那一行的原文（截前 100 字）

✓ <N> 条字面量一处都没命中（扫了 <M> 个文件）
```

每处命中打印「文件:行号 [第几遍] 命中哪条字面量」+ 那一行原文；末尾给汇总数字，
**退出码 0 = 干净、1 = 有命中**，可以直接挂 pre-commit / CI。

真正值得记的经验是**第二遍（斜杠化）**抓到的那些：它们在原文里是 `\\` 双反斜杠写法，
只按原文比对一条都看不见 —— 第 8 节记的就是这种转义变体。
名单之外的形状类泄漏（手机号 / 邮箱 / 私网地址 / 公网 IP / 私钥头）由 7.2 的模式扫描兜住。

> **关于「跳过自己」这件事，说清楚免得被当成后门**：本文的正文里嵌着上面那份下线名单，
> 所以本文带着 `oss-privacy-scan:skip-file` 标记，字面量扫描会整份跳过它
> （否则它扫自己会永远报错，而报的都是自己列出来的名单）。
> 这不是免检：**7.2 的模式扫描不认识这个标记，照样会扫本文**，§8 那几处也是靠 ⑦⑧ 抓到的。
> 想随时查「哪几个文件被豁免了」：
>
> ```bash
> grep -rl "oss-privacy-scan:skip-file" --exclude-dir=node_modules --exclude-dir=dist .
> #    实测（本文写就时）只有一份：docs/PRIVACY.md
> #    把上面的脚本存成 scripts/privacy-scan.mjs 之后应当是两份（脚本里也带标记，理由同上）
> ```
>
> 除了「正文里含下线名单」这一个理由，不要给别的文件加这个标记 —— 它会让那份文件脱离自动化检查。

### 7.2 模式扫描（没有名单，用来找**名单之外**的新泄漏）

字面量扫描有个天生的盲点：**名单是穷举的，新的泄漏不在名单上**。
所以每次提交前再跑一遍「形状」扫描 —— 它不知道自己在找谁，只按形状可疑来报。

```bash
# ① 用户名类路径（最危险的一类：盘符后跟 Users 目录）
grep -rnIE '[A-Za-z]:[\\/]{1,2}Users[\\/]' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git .
#    本轮结果：0 命中 → 用户名从没出现在仓库里
#    （注意：别把「盘符 + Users + 斜杠」这种**字样**写进注释里，否则这条命令会命中注释本身）

# ② 家目录形态（mac / linux 的写法，将来换平台也别漏）
grep -rnIE '/(Users|home)/[A-Za-z0-9._-]+' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git .
#    本轮结果：0 命中

# ③ 内网地址（10./192.168./172.16-31.）
grep -rnIE '\b(10\.[0-9]{1,3}|192\.168|172\.(1[6-9]|2[0-9]|3[01]))(\.[0-9]{1,3}){2}\b' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git --exclude=package-lock.json .
#    本轮结果：0 命中

# ④ 任何公网 IP（排除回环）
grep -rnIE '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git --exclude=package-lock.json . \
  | grep -vE '127\.0\.0\.1|0\.0\.0\.0'
#    本轮结果：0 命中

# ⑤ 令牌形状：sk- 前缀 / 长十六进制 / 长随机串
grep -rnIE '(sk-[A-Za-z0-9_-]{16,})|([0-9a-f]{32,})|([A-Za-z0-9_][A-Za-z0-9_-]{39,})' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git --exclude=package-lock.json .
#    本轮结果：2 条，都是预期内的 ——
#      server/config.json:3   运行时的本地令牌（文件本身已被 .gitignore 忽略，正是要靠这条规则兜住）
#      src/features/vocab/speak.ts:15  一个 base64 的 wav data URI（良性）

# ⑥ 私钥
grep -rnI "BEGIN [A-Z ]*PRIVATE KEY" \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git .
#    本轮结果：0 命中

# ⑦ 邮箱 / 手机号 / 18 位身份证
grep -rnIE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(com|cn|net|org)|1[3-9][0-9]{9}|[0-9]{17}[0-9Xx]' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git --exclude=package-lock.json .
#    本轮结果：0 命中

# ⑧ 盘符路径。分两步看，别写成一条 —— 一条会返回 140+ 行，噪音把真问题淹掉。
#   而且注意：grep 的 ERE **不支持 \u4e00 这种写法**，写 `[A-Za-z0-9_\u4e00-\u9fa5]`
#   实际被当成 `[A-Za-z0-9_u4e0-9fa5]`，中文一个都匹配不到。中文要用 `[^ -~]`。

# 8a) 盘符后面跟中文目录名 —— 这个项目最容易出现的形态，十几行，逐条看
grep -rnIE '[A-Za-z]:[\\/]{1,2}[^ -~]' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git --exclude=package-lock.json .
#    本轮结果：十几行，全是中性占位符（`C:\资料\…`、`C:\项目目录\…`）、URL 占位符被顺带命中的行，
#    以及「文档在讨论这个问题」的引用（含《PRIVACY.md》自己）。
#    已无带个人痕迹的盘符路径 —— 第 8 节那几处本轮清掉了。

# 8b) 盘符后面跟「像个人目录」的英文名 —— 家目录 / 盘根下自建的开发目录
grep -rnIE '[A-Za-z]:[\\/]{1,2}(Users|Documents|Desktop|Downloads|AppData|nvm|software|projects|repos|code|dev|00)' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git --exclude=package-lock.json .
#    本轮结果：0 命中（清掉第 8 节那几处之后就干净了）。
#    这条是 8a 的「英文目录名」版本：8a 只抓得到中文目录名，英语名（家目录 / 盘根下自建的开发目录）要靠 8b。
```

> ⑧ 怎么判断：`C:\Program Files`、`C:\Windows`、`C:\资料`（占位符）是**中性**的，
> 可以留；`C:\<装 node 的目录>\…`、`D:\<你自己的项目根>\…`、`E:\<私人软件目录>\…`
> 这种**带个人痕迹**的必须清掉。第 8 节那几处就是靠这条抓出来的。

**注意这些都不扫 `dist/` 与 `node_modules/`** —— 那是构建产物与第三方代码，不是你的源码。
真要确认构建产物干净，改完源码 `npm run build` 之后再对 `dist/` 单独扫一次
（把它从 `--exclude-dir` 里去掉即可）。

### 7.3 提交前 checklist

改完代码，逐条打勾再提交：

- [ ] `node scripts/privacy-scan.mjs` 退出码 0（先把 `PATTERNS` 换成你自己的值；本仓库本轮已清零，见第 8 节）；
- [ ] 7.2 的 ①②③④⑥⑦ 全部 0 命中；⑤ 只有已知的两条；⑧ 逐条看过；
- [ ] `git status --short` 里**没有** `server/config.json`、`server/credentials.json`、`server/data/` 下的非示例文件；
- [ ] `cd server/data && git status --short .` 只出现放行的那 7 个文件；
- [ ] 新加的配置项在 `server/config.example.json` 里有对应条目，且**默认值是空串**（不是某个路径）；
- [ ] 新加的密钥类字段加进了 `server/config.mjs` 的 `SECRET_PATHS`；
- [ ] 新写的报错 / 日志文案里没有本机路径（**日志是最容易漏的地方** —— 它天天在跑，写进去一次就一直在）；
- [ ] 新加的注释 / 文档里的示例路径是中性的（`C:\资料\…`、`/path/to/…`），不是你自己机器上的；
- [ ] 没有用 `git add -f` 强行加过任何被忽略的文件。

### 7.4 历史与体积（**要在真的 git 仓库里跑**）

上面 7.1–7.3 扫的是**当前工作区**，扫不出**历史提交**里的东西。这一节必须单独做：

```bash
# ① 有没有大文件进过历史（阈值 1 MB）
git rev-list --objects --all \
  | git cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)' \
  | awk '$1 == "blob" && $3 > 1048576 { printf "%8.2f MB  %s\n", $3/1048576, $4 }' \
  | sort -rn | head -30
#    预期：只该看到 package-lock.json 与几个 woff2；如果冒出 data/、logs/、*.db、
#    *.pdf、*.png，说明它们**进过历史** —— 那必须 rewrite 历史或换一个干净仓库重建

# ② 仓库总大小
du -sh .git

# ③ 逐个点名：这些文件**任何历史版本里都不该存在**
git log --all --oneline -- server/config.json
git log --all --oneline -- server/credentials.json
git log --all --diff-filter=A -- 'server/data/**'
git log --all --oneline -- logs/

# ④ 谁把密钥加进来过（扫全部历史里的 diff）
git log --all -p -S 'sk-' -- .
git log --all -p -S 'dataDir' -- server/config.example.json
```

> **本次没跑 7.4** —— 这份副本现在**不是 git 仓库**（没有 `.git/`），
> 是在文件系统上直接准备的一份目录。上面命令请在你初始化 / 克隆出来的真仓库里跑一遍。
> 特别是 ① 与 ③：`server/data/` 曾经有 421 MB，`logs/` 有 25 MB ——
> **它们在 `.gitignore` 里，但这只挡未来，不挡过去**。

---

## 8. 已知残留：本轮清掉的 3 处（扫出来的原样记录）

不要以为这份仓库已经零泄漏。这一节留着，是因为下面这 3 处**真的被扫出来过**，
而且**全都是第二遍（斜杠化）才现形的**。开源准备时已按「改法」清掉：

| 位置 | 原来是什么 | 改法（已执行） |
|---|---|---|
| `server/config.example.json` 的 `dataDir` 一项 | 一条**作者的绝对数据目录路径**（`D:\<作者的工作区>\…\server\data`） | **删掉这一项**（只留它上面那条 `"// dataDir"` 说明键）。注意**不能填 `""`**：`dataDir()` 返回空串之后，相对路径会落到进程 cwd —— 这条语义见 [../README.md](../README.md) 里的提醒 |
| `scripts/tests/singleton.test.mjs:21` | 断言里用了**作者本机的 node 安装位**（形如 `C:\<装 node 的目录>\nodejs\node.exe`） | 换成中性假路径 `C:\\node\\node.exe`。这条断言测的是「路径里含本项目 `server/index.mjs` 才算自己人」，路径取什么值不影响语义 |
| `scripts/tests/singleton.test.mjs:36` | 同一组断言里还有**作者 node 安装位 + 一个私有软件目录**拼出来的假命令行 | 换成 `C:\\node\\node.exe C:\\elsewhere\\dist\\index.js` —— 两条都是中性的假路径 |

第 2、3 处顺带说明**为什么需要「斜杠化」第二遍**：这两条在原文里都是 `\\` 双反斜杠的转义写法，
只按原文比对一条都抓不到。

**给复查的人**：把上面三条当**格式样本**用 —— 要抓的就是「绝对路径 / 私人目录名出现在断言、
配置默认值、注释示例里」这一类。具体值请换成你自己机器上的，别照抄本文：本文里的值已经全部换成占位符。

---

## 9. 这份文档的边界（**没做的事**）

写清楚，免得被当成「已经全查过了」：

1. **没有跑构建、没有起边车。** 盘点与清残留只做了文件读写与只读命令：没有 `npm install`、
   没有 `npm run build`（会覆盖 `dist/`）、没有启动边车（5278 被本机真实工作站占用，且会写出 `config.json`）。
   所以「清完之后还能不能构建、能不能启动」**没有被验证**。
2. **没有扫历史。** 7.4 的四条命令一条都没跑（这里不是 git 仓库）。
3. **没有验证 `dist/` 产物。** 现有的 `dist/` 是 2026-09-27 构建的，本次只读它做体积统计，
   没有检查它里面是否含个人内容 —— 反过来说，**`dist/` 已在 `.gitignore` 里，不该提交**。
4. **本文的 `PATTERNS` 现在是「填空模板」，不再是能直接跑的名单** —— 开源前把作者的真实值
   全部换成了占位符，条目按类别归并。原盘点的字面量清单头部写「条目数=87」，实际列出来的是 73 条。
   **如果你手上有完整的 87 条版本，请以那份为准补进来。**
5. **`server/lib/asr.mjs` 只剩 OpenAI 兼容一个 provider**，逆向本机客户端那条链路已删 ——
   这条是设计决定，不是脱敏遗漏，写在这里免得有人把它当 bug 加回来。

---

## 相关文档

- [ARCHITECTURE.md](ARCHITECTURE.md) —— 内核 / 边车 / 注册表三分法，以及「没配 = 不显示」这条内核约定
- [verifying.md](verifying.md) —— 改完代码怎么在命令行验收（含 `.gitignore` 的确认步骤）
- [../server/data/README.md](../server/data/README.md) —— 数据目录里哪些是示例、哪些是运行时生成的
- [../README.md](../README.md) —— 「不含什么（以及为什么）」一节：所有移除项对外的解释口径
