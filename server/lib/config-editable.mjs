/**
 * `PATCH /api/config` 的白名单 —— 「页面上能改哪些配置项」的**唯一事实源**。
 *
 * 为什么单独一个文件（而不是留在 `server/index.mjs` 里）：
 *   - 它是一份**契约**，不是实现。放在入口文件里没人能一眼看全，也没法被测试 import
 *     （import `server/index.mjs` 会直接起边车、还会过单实例闸把别人的实例收掉）；
 *   - `scripts/tests/config-whitelist.test.mjs` 要拿它和 `DEFAULTS`、`config.example.json`
 *     对账，找出「加了配置项却忘了进白名单」这类漏项。
 *
 * 两张表的区别只有一个判据：**这一项在 `config.json` 里是什么形状**。
 *
 *   - `CONFIG_EDITABLE`         分节：值是**对象**，逐子字段放行。
 *                               例：`{ llm: { model: 'x' } }`、`{ network: { proxy: {...} } }`
 *   - `CONFIG_EDITABLE_SCALARS` 标量：值是**字符串 / 数字 / 布尔**，整项放行。
 *                               例：`{ outputLanguage: 'English' }`、`{ startupDir: 'C:/…' }`
 *
 * 为什么必须分两张：分发处的分节循环用 `typeof v !== 'object'` 判形状，
 * 标量项一律被当成「无效分节」扔进 `rejected`。`outputLanguage` 曾经就是漏在这儿的 ——
 * 页面「设置与数据」发 `{"outputLanguage":"English"}`，服务端回
 * `{ ok:false, error:'没有可改的字段（被拒绝：outputLanguage）' }`，
 * 而页面把 HTTP 200 当成功，于是「保存必然失败且不告诉你为什么」。
 *
 * 加一个新配置项的完整清单见 `docs/EXTENDING.md` §3.4（四步：DEFAULTS →
 * 这里（分节还是标量）→ `server/config.example.json` → 需要的话再加 `SECRET_PATHS`），
 * 页面上能改什么的说明见 `docs/CONFIG.md` §4。
 *
 * 漏项的表现：
 *   ① 只加进 `DEFAULTS` 没加进来 → 页面上改不动，`rejected` 里点名；
 *   ② 标量项误放进 `CONFIG_EDITABLE`（或写成空数组）→ 同上，且更难看出原因。
 * 两种都会被 `scripts/tests/config-whitelist.test.mjs` 拦下来。
 */

/** 分节白名单：`{ 分节名: [放行的子字段…] }`。值必须是**非空数组** */
export const CONFIG_EDITABLE = {
  // ↓ 新分节加在这里（值是**对象**的那些；值是字符串/数字/布尔的加到下面的 CONFIG_EDITABLE_SCALARS）
  newapi: ['baseUrl'],
  // 没有 maxTokens：预算归 lib/llm.mjs 按输入字数算，不是可配项
  ai: ['model', 'models', 'temperature', 'persona', 'personaPrivate'],
  workstation: ['autostartEntry', 'autostartLog'],
  // 工作台自己的进程守护引擎：这里只放「开不开、数据放哪」，规则阈值在 lib/pguard.mjs 的白名单里。
  pguard: ['enabled', 'dataDir'],
  // 全站能力（模型 / 嵌入 / 检索 / 文档解析 / 网络 / 输出）：在「设置与数据」页改
  llm: ['activePresetId', 'configs', 'keys', 'customPresets', 'taskRouting', 'reasoning', 'maxContextSize'],
  embedding: ['enabled', 'endpoint', 'model', 'apiKey', 'batchSize', 'concurrency', 'chunkChars', 'chunkOverlap', 'maxPages', 'outputDimensionality', 'extraHeaders'],
  search: ['provider', 'apiKey', 'serpApiEngine', 'searXngUrl', 'searXngCategories', 'ollamaUrl', 'providerConfigs', 'defaultSource', 'maxResults', 'anyTxt'],
  docparse: ['mineru'],
  network: ['proxy'],
  // 转写后端（语音随记）：设置页与随记配置页都能改；apiKey 按 SECRET_PATHS 落 credentials.json
  asr: ['provider', 'baseUrl', 'model', 'language', 'timeoutSec', 'apiKey'],
  // 资讯（采集器目录 / 抓评论的代理 / 「与我相关」关键词）
  collector: ['dir', 'proxy'],
  news: ['focusKeywords'],
  // 做题本：题库池的三条路径
  zuotiben: ['pool'],
  // 号池（第三方网关 WorkBuddy2API 的客户端）：网关目录/地址、启停脚本、解释器、自启项、多台主机
  workbuddy: ['dir', 'baseUrl', 'label', 'autoStart', 'startCmd', 'stopCmd', 'python', 'autostartVbs', 'hosts'],
  // 知识库自己的（强业务）：库目录、监听、队列上限
  wiki: [
    'dir',
    'model',
    'maxChars',
    'chatMaxTokens',
    'embedding',
    'mineru',
    // 模型预设 / 检索 / 输出 / 网络 / 定时导入：结构走 config.json，密钥自动落到 credentials.json
    'llm',
    'search',
    'output',
    'network',
    'scheduledImport',
    'watchEnabled',
    'watchAutoIngest',
    'watchIntervalMin',
    'watchMaxFileSizeMb',
    'watchDirs',
    'watchExcludeDirs',
  ],
}

/**
 * 标量白名单：顶层键名集合，整项放行（值按字符串存）。
 *
 * 目前只有两项，都是「单值下拉 / 单个路径」型：`startupDir` 是启动文件夹路径，
 * `outputLanguage` 是编译与问答的输出语言（`Chinese` / `English` / `auto`）。
 */
export const CONFIG_EDITABLE_SCALARS = new Set(['startupDir', 'outputLanguage'])
