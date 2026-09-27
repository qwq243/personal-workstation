#!/usr/bin/env node
/**
 * 开机自启位的命令行开关 —— `#/service` 那一页的无界面版本。
 *
 *   node scripts/panel-autostart.mjs enable|disable|remove|open-startup|status
 *
 * 为什么要有它：页面入口（`#/service`）对「人多看一眼」够用，但这三件事用命令行更顺——
 *   · 装完机器想一步开好自启（写进装机脚本）；
 *   · 远程 / 无界面场景（只有 SSH 或计划任务）；
 *   · 想用 `npm run autostart:on` / `autostart:off` 这两个短命令（见 package.json）。
 *
 * 它**不做别的**：不重启边车、不改配置、不写启动文件夹以外的地方。
 * 真正的动作全在 `server/lib/panel.mjs` 里，这里只是 HTTP 客户端 ——
 * 所以它要求边车已经在跑（`npm run server` 或双击 `启动工作站.cmd`）。
 *
 * 零依赖：只用 `node:` 内置（借 `server/lib/net.mjs` 的 request 包一层超时与错误），
 * 端口与令牌都从 `server/config.mjs` 的 `loadConfig()` 读 —— 和边车自己读的是同一份。
 *
 * 平台：**Windows 专有**。自启位是启动文件夹里的一条 `.lnk` + 一个 `.vbs`；
 * 换 Linux / macOS 要另做实现（见 docs/ARCHITECTURE.md §6.2），脚本在这里会明确告诉你。
 */
import { loadConfig } from '../server/config.mjs'
import { request } from '../server/lib/net.mjs'

const ACTIONS = ['enable', 'disable', 'remove', 'open-startup', 'status']
const HELP = {
  enable: '开启（或重建）自启位：重写仓库里的 .vbs，并在启动文件夹放一条指过去的 .lnk',
  disable: '关闭自启位：把那条 .lnk 改名成 .disabled（文件留着，随时能再开）',
  remove: '删除自启位（要重新用就得再 enable）',
  'open-startup': '用资源管理器打开启动文件夹，自己核对里面有什么',
  status: '只体检，不动手：看自启位在不在、引用是否有效、用的哪个 node',
}

function usage(code = 0) {
  console.log(
    [
      '用法：node scripts/panel-autostart.mjs <动作>',
      '',
      ...ACTIONS.map((a) => `  ${a.padEnd(14)}${HELP[a]}`),
      '',
      '也可以走 npm：npm run autostart:on / npm run autostart:off',
      '（等价于 enable / disable。前提：边车已经在跑，这个脚本不负责启停边车。）',
    ].join('\n'),
  )
  process.exit(code)
}

const action = process.argv[2]
if (!action || action === '-h' || action === '--help') usage(action ? 0 : 2)
if (!ACTIONS.includes(action)) {
  console.error(`未知动作：${action}`)
  usage(2)
}

if (process.platform !== 'win32') {
  console.error(
    '这个功能是 Windows 专有的（启动文件夹 + .lnk + wscript）：当前平台是 ' +
      `${process.platform}。跨平台要另做实现，见 docs/ARCHITECTURE.md §6.2。`,
  )
  process.exit(1)
}

const cfg = loadConfig()
/** 端口优先级与边车一致：WS_PORT 环境变量 > config.json 的 port > 5278（见 server/index.mjs） */
const port = Number(process.env.WS_PORT || cfg.port || 5278)
const token = cfg.auth?.enabled === false ? '' : cfg.auth?.token || ''
const base = `http://127.0.0.1:${port}`
const headers = token ? { 'X-WS-Token': token } : {}

/** 先探一下边车在不在：不在的话给出的原因是「没启动」，而不是一个 fetch 异常 */
const health = await request(`${base}/api/health`, { timeout: 4000 })
if (!health.ok) {
  console.error(
    `连不上边车（${base}）。这个脚本只负责调接口，不管启停 ——` +
      '先在另一个窗口跑 `npm run server`，或双击 `启动工作站.cmd`。',
  )
  if (health.error) console.error(`  （${health.error}）`)
  process.exit(1)
}

/**
 * `status` 走的是只读的 `GET /api/panel/status`，其余动作走
 * `POST /api/panel/autostart`（服务端那两个动作名在 server/lib/panel.mjs 里）。
 * 别把 status 也 POST 过去 —— 那个 handler 只认 enable / disable / remove / open-startup。
 */
const r =
  action === 'status'
    ? await request(`${base}/api/panel/status`, { headers, timeout: 20000 })
    : await request(`${base}/api/panel/autostart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: { action },
        timeout: 30000,
      })

if (!r.json) {
  console.error(`边车返回了没法解析的响应（HTTP ${r.status}）：${String(r.text).slice(0, 200)}`)
  process.exit(1)
}
if (r.json.ok === false) {
  console.error(`失败：${r.json.error ?? `HTTP ${r.status}`}`)
  process.exit(1)
}

const st = r.json
console.log(action === 'status' ? '自启位体检：' : `${action} 完成。当前自启位：`)
console.log(`  自启项      ${st.entryName ?? '—'}${st.active ? '（启用中）' : st.disabled ? '（已关闭）' : '（不存在）'}`)
console.log(`  启动文件夹  ${st.dir ?? '—'}`)
console.log(`  脚本本体    ${st.scriptFile ?? '—'}${st.scriptExists ? '' : '（不在）'}`)
console.log(`  入口        ${st.entry ?? '—'}`)
console.log(`  用的 node   ${st.nodePath ?? '—'}（${st.nodeVersion ?? '?'}）`)
console.log(`  自启日志    ${st.logFile ?? '—'}`)
if (st.healthy === true) console.log('  体检        通过')
for (const p of st.problems ?? []) console.log(`  ✗ ${p}`)
for (const w of st.warnings ?? []) console.log(`  ! ${w}`)
if (st.healthy !== true) {
  console.log('\n体检没过时点一次「重建」通常就好：node scripts/panel-autostart.mjs enable')
}
