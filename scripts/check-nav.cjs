#!/usr/bin/env node
/**
 * 侧边栏门禁：把「左栏那棵树」的几条不变量变成可复跑的断言。
 *
 * 为什么单开一条：这个菜单**同一类错犯过三回**，每回都得靠肉眼或截图才发现 ——
 *   1. 有展开箭头的入口行右边多出一颗图钉（子页面与首页不在同一个 path 前缀下时踩过）；
 *   2. 反方向：单页功能（规划台 / 做题本 / 知识库…）该有图钉却没有
 *      —— 它们被「按路由 path 前缀判叶子」那套写法全排除了；
 *   3. 图标漏进 `src/main.ts` 的白名单，那一处**静默空白**（加「智能体 / 工具」分组时又踩一次）。
 * 前两条是同一处判断写错（现在只有 `src/core/leaf-pages.ts` 一份），第三条靠 `main.ts` 的自检告警兜 ——
 * 这个脚本把三件事都断言掉。
 *
 * 断言（都跑在**桌面展开态**的侧边栏上）：
 *   A. 每一行「有箭头」与「有图钉」严格互补：有箭头的行不许有图钉，没箭头的行必须有图钉。
 *   B. 每一行、每个分组标题的图标都真的渲染出来了（svg 或非空文本；emoji 也算）。
 *   C. 注册表里的功能一个不少、也不重复地出现在左栏（拿 `#/apps` 的功能卡片做对照表，
 *      两边都由注册表派生，所以不会随改名漂移）。
 *   D. 控制台里没有 `[icons]` / `[registry]` 告警（图标漏白名单、功能漏 category）。
 *
 * 用法
 *   node scripts/check-nav.cjs                    # 默认打 http://127.0.0.1:5278（边车在跑就行）
 *   WS_BASE=http://127.0.0.1:5278 node scripts/check-nav.cjs
 *   node scripts/check-nav.cjs --shots            # 顺便存一张左栏截图到 logs/nav-shots/
 *
 * 退出码：0 = 全过；1 = 有不变量被破。改侧边栏、加功能、动 `leaf-pages.ts` / `MODULE_GROUPS` 之后跑一下。
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const ROOT = path.resolve(__dirname, '..')
const BASE = process.env.WS_BASE || 'http://127.0.0.1:5278'
const PORT = Number(process.env.WS_CDP_PORT || 9335)
const VIEWPORT = { width: 1360, height: 900 }
const NAV_TIMEOUT_MS = 25000
const SHOT_DIR = path.join(ROOT, 'logs', 'nav-shots')
const wantShots = process.argv.includes('--shots')

/* --------------------------------------------------------------- Chrome -- */
function findChrome() {
  const cands = [
    process.env.WS_CHROME,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
  ].filter(Boolean)
  for (const c of cands) if (fs.existsSync(c)) return c
  throw new Error('找不到 Chrome/Edge —— 用 WS_CHROME=/path/to/chrome 指定')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForCdp(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (r.ok) return
    } catch {
      /* 还没起来 */
    }
    await sleep(200)
  }
  throw new Error(`Chrome 调试口 ${PORT} 没就绪`)
}

/** 极简 CDP 客户端（与 check-mobile.cjs 同一套写法：只用到 send / 收事件，不值得引依赖） */
class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    /** 持续监听：method -> Set(fn)，用于收集控制台告警与页面异常 */
    this.subs = new Map()
    /** 一次性等待：method -> [resolve]，用于等 Page.loadEventFired */
    this.waits = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
        return
      }
      if (!msg.method) return
      for (const fn of this.subs.get(msg.method) ?? []) fn(msg.params)
      const waits = this.waits.get(msg.method)
      if (waits && waits.length) {
        this.waits.set(msg.method, [])
        for (const fn of waits) fn(msg.params)
      }
    })
  }

  static async open(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true })
    })
    return new Cdp(ws)
  }

  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  once(method) {
    return new Promise((resolve) => {
      const arr = this.waits.get(method) ?? []
      arr.push(resolve)
      this.waits.set(method, arr)
    })
  }

  on(method, fn) {
    const set = this.subs.get(method) ?? new Set()
    set.add(fn)
    this.subs.set(method, set)
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------ 页面里跑的 -- */
/** 左栏那棵树 + 每行的「箭头 / 图钉 / 图标」 */
const NAV_PROBE = `(() => {
  const nav = document.querySelector('.nav');
  if (!nav) return JSON.stringify({ error: '左栏没有渲染出来（.nav 不存在）' });
  const rows = [];
  // 「置顶」那几行是**页面**的快捷入口（名字可能是二级页），不算功能行 —— 拿它跟注册表对不上，
  // 所以要单独标出来：置顶块从「置顶」这个分组标题开始，到下一个分组标题结束。
  let inPinned = false;
  for (const el of nav.children) {
    const cls = el.className || '';
    const text = (el.innerText || '').replace(/\\s+/g, ' ').trim();
    if (cls.includes('nav__group')) {
      inPinned = text.startsWith('置顶');
      rows.push({ kind: 'group', text, pinnedBlock: true, icon: !!el.querySelector('.nav__group-icon svg') });
    } else if (cls.includes('nav__item')) {
      const iconEl = el.querySelector('.nav__icon');
      rows.push({
        kind: 'item',
        text,
        pinned: inPinned,
        caret: !!el.querySelector('.nav__caret'),
        pin: !!el.querySelector('.nav__pin'),
        icon: !!iconEl && (!!iconEl.querySelector('svg') || (iconEl.textContent || '').trim().length > 0),
      });
    } else if (cls.includes('nav__sub')) {
      rows.push({ kind: 'sub', text, pin: !!el.querySelector('.nav__pin') });
    }
  }
  return JSON.stringify({ rows });
})()`

/** `#/apps` 的功能卡片名（= 注册表里的功能），置顶区与「添加新功能」不算 */
const APPS_PROBE = `(() => {
  const names = [];
  for (const g of document.querySelectorAll('.group')) {
    const title = (g.querySelector('.group__title')?.innerText || '').replace(/\\s+/g, ' ').trim();
    if (title.startsWith('置顶')) continue;
    for (const n of g.querySelectorAll('.app-card__name')) {
      const t = (n.innerText || '').trim();
      if (t && t !== '添加新功能') names.push(t);
    }
  }
  return JSON.stringify({ names });
})()`

/* ------------------------------------------------------------------ 主流程 -- */
async function main() {
  const chrome = findChrome()
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-nav-'))
  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      // 本机代理（FlClash）会把 127.0.0.1 的请求也揽过去，直连更稳
      '--no-proxy-server',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  const problems = []
  const notes = []

  try {
    await waitForCdp()

    /** 开一页、等渲染、跑一段探针 */
    async function openAndEval(url, expression, waitMs = 1500) {
      let target
      try {
        target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json()
      } catch {
        target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`)).json()
      }
      const cdp = await Cdp.open(target.webSocketDebuggerUrl)
      const warnings = []
      const pageErrors = []
      cdp.on('Runtime.exceptionThrown', (p) => {
        const d = p?.exceptionDetails
        pageErrors.push(String(d?.exception?.description || d?.text || '未知异常').split('\n')[0].slice(0, 160))
      })
      cdp.on('Runtime.consoleAPICalled', (p) => {
        const text = (p?.args || []).map((a) => a.value ?? a.description ?? '').join(' ')
        if (!text) return
        if (p?.type === 'warning') warnings.push(text.slice(0, 200))
        if (p?.type === 'error') pageErrors.push('console.error: ' + text.slice(0, 160))
      })
      await cdp.send('Page.enable')
      await cdp.send('Runtime.enable')
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: VIEWPORT.width,
        height: VIEWPORT.height,
        deviceScaleFactor: 1,
        mobile: false,
      })
      const loaded = cdp.once('Page.loadEventFired')
      await cdp.send('Page.navigate', { url })
      await Promise.race([loaded, sleep(NAV_TIMEOUT_MS)])
      await sleep(waitMs)
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true })
      return { cdp, value: JSON.parse(r.result.value), warnings, pageErrors }
    }

    // ---- 对照表：注册表里的功能（从 #/apps 的卡片名取） ----
    const apps = await openAndEval(`${BASE}/#/apps`, APPS_PROBE, 2000)
    const moduleNames = apps.value.names
    if (apps.pageErrors.length) problems.push(`/apps 页面报错：${apps.pageErrors[0]}`)
    if (!moduleNames.length) problems.push('#/apps 一个功能卡片都没有，对照表拿不到（先确认边车在跑、dist 是新的）')

    // ---- 左栏 ----
    const nav = await openAndEval(`${BASE}/`, NAV_PROBE, 2000)
    if (nav.value.error) problems.push(nav.value.error)
    if (nav.pageErrors.length) problems.push(`首页报错：${nav.pageErrors[0]}`)
    const banner = nav.warnings.filter((w) => w.includes('[icons]') || w.includes('[registry]'))
    if (banner.length) problems.push(`启动告警：${banner.join(' / ')}`)

    const rows = nav.value.rows || []
    /** 功能行 = 分组里的那些行；置顶区的行是页面快捷方式，不参与对表 */
    const items = rows.filter((r) => r.kind === 'item' && !r.pinned)
    const pinnedRows = rows.filter((r) => r.kind === 'item' && r.pinned)
    const groups = rows.filter((r) => r.kind === 'group')

    // A. 有箭头 ⟺ 有图钉
    for (const r of items) {
      if (r.caret && r.pin) problems.push(`「${r.text}」有展开箭头却还有图钉（入口行不该能置顶）`)
      if (!r.caret && !r.pin) problems.push(`「${r.text}」没有展开箭头却没有图钉（单页功能该能置顶）`)
    }

    // B. 图标渲染（置顶区那几行也要查：收起侧栏时它只剩图标）
    for (const r of rows) {
      if (r.kind === 'sub') continue // 三级项本来就不给图标（层级靠缩进 + 导轨表达）
      if (!r.icon) problems.push(`${r.kind === 'group' ? '分组' : '功能'}「${r.text}」的图标是空白（多半没进 src/main.ts 白名单）`)
    }

    // C. 功能一个不少、不重复
    const rowNames = items.map((r) => r.text)
    for (const name of moduleNames) {
      const hit = rowNames.filter((t) => t === name).length
      if (hit === 0) problems.push(`功能「${name}」在左栏里找不到（category 没填？导航只渲染分组内的功能）`)
      if (hit > 1) problems.push(`功能「${name}」在左栏出现 ${hit} 次`)
    }
    for (const name of rowNames) {
      if (!moduleNames.includes(name)) problems.push(`左栏有个「${name}」不在注册表里（改名后两边不一致？）`)
    }

    notes.push(`左栏 ${groups.length} 个分组标题 / ${items.length} 行功能 / 置顶 ${pinnedRows.length} 行；注册表 ${moduleNames.length} 个功能`)
    notes.push(`可置顶的行：${items.filter((r) => r.pin).map((r) => r.text).join('、') || '（无）'}`)
    notes.push(`置顶区：${pinnedRows.map((r) => r.text).join('、') || '（空）'}`)

    if (wantShots) {
      fs.mkdirSync(SHOT_DIR, { recursive: true })
      const shot = await nav.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
      const out = path.join(SHOT_DIR, 'sidebar.png')
      fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
      notes.push(`截图：${path.relative(ROOT, out)}`)
    }

    apps.cdp.close()
    nav.cdp.close()
  } finally {
    child.kill()
    await sleep(300)
    try {
      fs.rmSync(profile, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }

  for (const n of notes) console.log('  ·  ' + n)
  if (problems.length) {
    console.log(`\n侧边栏不变量被破 ${problems.length} 条：`)
    for (const p of problems) console.log('  ✗  ' + p)
    process.exit(1)
  }
  console.log('\n侧边栏全过：箭头/图钉互补、图标都渲染、功能与注册表一一对应')
}

main().catch((e) => {
  console.error('检查失败：' + (e?.message ?? e))
  process.exit(1)
})
