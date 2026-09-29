#!/usr/bin/env node
/**
 * 暗色门禁：逐个路由在**暗色主题**下加载，扫描每个可见元素的**计算后颜色**，
 * 把「浅色底 + 有文字」这类暗色破绽列出来。
 *
 * 为什么不是「读 CSS 找硬编码色值」：那个办法我试过，**会得出与事实相反的结论** ——
 * 某些页面在 CSS 里有 30 处 `#fff`/`#f3f4f6`/`#e5e7eb`，但截图看它其实是好的
 * （那些规则要么被更具体的 token 规则盖住、要么落在当前没渲染的元素上）。
 * 静态读文本只能猜，量计算样式才是事实。
 *
 * 判定：元素自身的背景不透明且亮度 > 0.75，**并且它自己或后代有可见文字**，就是一块亮斑。
 * 纯装饰的浅色小块（分隔线、图标、进度条）不算 —— 它们在暗色下本来就该是浅色的。
 *
 * 用法
 *   node scripts/check-dark.cjs                  # 全部路由
 *   node scripts/check-dark.cjs zuotiben vocab   # 只跑路径含这些片段的路由
 *   WS_BASE=http://127.0.0.1:5278 node scripts/check-dark.cjs
 *
 * 退出码：0 = 全过；1 = 有暗色破绽。
 *
 * 与 check-mobile.cjs 是姊妹脚本（那边的 CDP 管道这里再写了一遍 —— 两个脚本各自独立、
 * 互不影响，比抽公共模块更稳；真要抽的时候一起抽，别只抽一个）。
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const ROOT = path.resolve(__dirname, '..')
const BASE = process.env.WS_BASE || 'http://127.0.0.1:5278'
const PORT = Number(process.env.WS_CDP_PORT || 9334)
const NAV_TIMEOUT_MS = 25000
const SHOT_DIR = path.join(ROOT, 'logs', 'dark-shots')

/**
 * 按设计就是白底的页面：打印视图（纸就是白的，暗色主题不该影响它）。
 * 明确列出来，而不是靠「发现它报错就加白名单」——后者会把真问题也放过。
 */
const WHITE_BY_DESIGN = ['/zuotiben/print', '/zuotiben/sentence-print']

function collectRoutes() {
  const out = new Set(['/', '/apps', '/settings', '/dev-guide'])
  const featDir = path.join(ROOT, 'src', 'features')
  for (const mod of fs.readdirSync(featDir)) {
    const dir = path.join(featDir, mod)
    if (!fs.statSync(dir).isDirectory()) continue
    // 有的模块一份 module.ts 放好几个路由，有的按域拆成 usage.module.ts / calendar.module.ts
    // —— 只认 module.ts 会漏掉后者（office 那两页因此从没测过，2026-09-29 补齐）
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.ts') && n.includes('module'))) {
      for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/path:\s*'([^']+)'/g)) {
        if (!m[1].includes(':')) out.add(m[1])
      }
    }
  }
  return [...out].sort()
}

function findChrome() {
  const cands = [
    process.env.WS_CHROME,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean)
  for (const c of cands) if (fs.existsSync(c)) return c
  throw new Error('找不到 Chrome/Edge —— 用 WS_CHROME=/path/to/chrome 指定')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForCdp(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) return
    } catch {
      /* 还没起来 */
    }
    await sleep(200)
  }
  throw new Error(`Chrome 调试口 ${PORT} 没就绪`)
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.listeners = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      } else if (msg.method) {
        const fns = this.listeners.get(msg.method) || []
        this.listeners.delete(msg.method)
        fns.forEach((f) => f(msg.params))
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
      const arr = this.listeners.get(method) || []
      arr.push(resolve)
      this.listeners.set(method, arr)
    })
  }
  on(method, fn) {
    const arr = this.listeners.get(method) || []
    arr.push(fn)
    this.listeners.set(method, arr)
  }
  close() {
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}

/**
 * 在页面里跑的测量。
 * 亮度阈值 0.75：暗色的面板多在 0.05~0.15，浅色面板在 0.9 以上，中间地带是彩色标签，
 * 阈值放这里不会把「浅绿标签」误判成白底。
 */
const MEASURE = `(() => {
  const lum = (css) => {
    const m = /rgba?\\(\\s*(\\d+)[,\\s]+(\\d+)[,\\s]+(\\d+)(?:[,\\s/]+([\\d.]+))?/.exec(css || '');
    if (!m) return null;
    const a = m[4] === undefined ? 1 : Number(m[4]);
    if (a < 0.5) return null; // 半透明的算不上「一块亮斑」
    return (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255;
  };
  const name = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = (el.className && typeof el.className === 'string')
      ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.') : '';
    return el.tagName.toLowerCase() + id + cls;
  };
  const ownText = (el) => {
    let n = 0;
    for (const c of el.childNodes) if (c.nodeType === 3) n += (c.textContent || '').trim().length;
    return n;
  };
  const bad = [];
  const glare = [];
  const seen = new Set();
  /**
   * 主色的解析值。**背景等于主色的元素从「亮块」里放行** ——
   * 那是走令牌的主题色（自己发的气泡、主按钮），亮色主题下会浅、暗色下会深，
   * 是跟着主题走的、有意为之。而课表那种写死的饱和色板不走令牌，才是真问题。
   * 用「比对令牌解析值」而不是维护一张选择器白名单：白名单会在重组 UI 时悄悄失效。
   */
  const accentRgb = (() => {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--ws-accent').trim();
    const d = document.createElement('div');
    d.style.color = v;
    document.body.appendChild(d);
    const c = getComputedStyle(d).color;
    d.remove();
    return c;
  })();
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('.memo-error, .el-loading-mask, .el-skeleton')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const L = lum(cs.backgroundColor);
    if (L === null) continue;
    const r = el.getBoundingClientRect();

    // 断言二：**大面积亮色块**（暗色下刺眼）。
    // 这条是看到课表才补的：课程块用一套写死的高饱和调色板，两套主题共用 ——
    // 白字在饱和色上照样可读，所以「浅底浅字」那条完全看不见它，
    // 但一整屏的霓虹块在深色底上就是最刺眼的问题。
    // 面积阈值 ~95×95：按钮（90×38）和标签（62×21）都不会被误报。
    if (L > 0.35 && r.width * r.height >= 9000 && cs.backgroundColor !== accentRgb) {
      const gk = name(el) + '|glare';
      if (!seen.has(gk)) {
        seen.add(gk);
        if (glare.length < 10) glare.push({ sel: name(el), bg: cs.backgroundColor, L: L.toFixed(2), area: Math.round(r.width) + 'x' + Math.round(r.height) });
      }
    }

    if (L < 0.75) continue;
    if (r.width < 24 || r.height < 12) continue;   // 分隔线/图标这类小块不算
    // 有没有文字：自己直接带、或后代带（且后代不是另一个更小的浅色块）
    let text = ownText(el);
    if (!text) for (const d of el.querySelectorAll('*')) { text += ownText(d); if (text > 0) break }
    if (!text) continue;
    const key = name(el) + '|' + Math.round(r.width) + 'x' + Math.round(r.height);
    if (seen.has(key)) continue;
    seen.add(key);
    if (bad.length < 10) {
      bad.push({ sel: name(el), bg: cs.backgroundColor, fg: cs.color, area: Math.round(r.width) + 'x' + Math.round(r.height), text: text });
    }
  }
  const root = document.documentElement;
  return JSON.stringify({
    theme: root.dataset.theme,
    hasDarkClass: root.classList.contains('dark'),
    bodyBg: getComputedStyle(document.body).backgroundColor,
    panelBg: (() => { const c = document.querySelector('.ws-card'); return c ? getComputedStyle(c).backgroundColor : null })(),
    bad,
    glare,
  });
})()`

async function main() {
  const args = process.argv.slice(2)
  const wantShots = args.includes('--shots')
  const filters = args.filter((a) => !a.startsWith('--'))
  let routes = collectRoutes()
  if (filters.length) routes = routes.filter((r) => filters.some((f) => r.includes(f)))
  if (!routes.length) {
    console.log('没有匹配的路由')
    process.exit(0)
  }

  const chrome = findChrome()
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-dark-'))
  const child = spawn(
    chrome,
    ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
     '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--no-proxy-server', 'about:blank'],
    { stdio: 'ignore' },
  )

  let failed = 0
  try {
    await waitForCdp()
    if (wantShots) fs.mkdirSync(SHOT_DIR, { recursive: true })

    for (const route of routes) {
      if (WHITE_BY_DESIGN.some((p) => route.startsWith(p))) {
        console.log(`  skip  ${route.padEnd(28)} 按设计就是白底（打印视图），暗色不该改它`)
        continue
      }
      // 注意两件事（2026-09-28 查出来的空转原因）：
      //   ① 标签页必须先开在 about:blank —— 如果建标签时就带目标 URL，文档会在注入脚本之前
      //      就加载完，再导航到同一个 URL 等于没导航，注入的「写主题」脚本永远不执行；
      //   ② 目标 URL 里带一个会变的东西，避免 hash-only 导航不重载文档。
      const url = `${BASE}/?darkprobe=${Date.now()}#${route}`
      let target
      try {
        target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json()
      } catch {
        target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`)).json()
      }
      const cdp = await Cdp.open(target.webSocketDebuggerUrl)
      try {
        await cdp.send('Page.enable')
        await cdp.send('Runtime.enable')
        // 先把主题写成 dark，再导航 —— 这样首屏就是暗的，不会闪一下亮色
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
          source: `try{localStorage.setItem('workstation.ui.theme','"dark"')}catch(e){}`,
        })
        const loaded = cdp.once('Page.loadEventFired')
        await cdp.send('Page.navigate', { url })
        await Promise.race([loaded, sleep(NAV_TIMEOUT_MS)])
        await sleep(1400)

        const r = await cdp.send('Runtime.evaluate', { expression: MEASURE, returnByValue: true })
        const m = JSON.parse(r.result.value)
        const glare = m.glare || []
        const ok = m.bad.length === 0 && glare.length === 0 && (m.theme === 'dark' || m.hasDarkClass)
        if (!ok) failed++
        console.log(
          `${ok ? '  ok  ' : ' FAIL '} ${route.padEnd(28)} 主题=${m.theme}${m.hasDarkClass ? '+.dark' : ''}` +
            `  面板底 ${m.panelBg ?? '-'}` +
            (m.bad.length ? `  ⚠ 浅底带字 ${m.bad.length} 处` : '') +
            (glare.length ? `  ⚠ 大面积亮块 ${glare.length} 处` : ''),
        )
        if (!ok) {
          for (const b of m.bad) {
            console.log(`          · ${b.sel}  bg=${b.bg} fg=${b.fg} ${b.area} 文字${b.text}字`)
          }
          for (const b of glare) {
            console.log(`          · 亮块 ${b.sel}  bg=${b.bg} 亮度${b.L} ${b.area}`)
          }
        }
        if (wantShots) {
          try {
            const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
            const f = path.join(SHOT_DIR, (route.replace(/[^\w]+/g, '_').replace(/^_|_$/g, '') || 'root') + '.png')
            fs.writeFileSync(f, Buffer.from(shot.data, 'base64'))
          } catch {
            /* 截图失败不影响判定 */
          }
        }
      } finally {
        cdp.close()
        try {
          await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`)
        } catch {
          /* ignore */
        }
      }
    }
  } finally {
    child.kill()
    await sleep(300)
    try {
      fs.rmSync(profile, { recursive: true, force: true })
    } catch {
      /* Windows 偶发占用 */
    }
  }

  console.log(`\n暗色破绽 ${failed} 条`)
  if (wantShots) console.log(`截图：${path.relative(ROOT, SHOT_DIR)}`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('check-dark 失败：', e.message)
  process.exit(2)
})
