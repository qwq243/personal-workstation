/**
 * 主题功能的完整功能测试（真鼠标事件 + 真重载）。
 *
 * 三条踩过的坑，都写在这里免得下次再犯：
 *  1. **`element.click()` 测不出 tooltip 吃点击的问题** —— 合成 click 绕过 mousedown/mouseup，
 *     而 el-tooltip 的 popper 触发层正是在那一步拦截的。必须用 `Input.dispatchMouseEvent`。
 *  2. **导航到只差 hash 的同一 URL 不会重载页面** —— store 只在创建时读一次 localStorage，
 *     所以不重载的话上一轮点出来的模式还留在内存里，会得出「auto 算错了」这种假结论。
 *     这里用 about:blank 中转强制真重载。
 *  3. **断言要朝「相反的那一项」点** —— 点一个和当前相同的模式，当然看不出变化。
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const PORT = Number(process.env.PROBE_PORT || 9338)
const BASE = process.env.WS_BASE || 'http://127.0.0.1:5278'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function findChrome() {
  for (const c of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ]) if (fs.existsSync(c)) return c
  throw new Error('no chrome')
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map()
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id)
        m.error ? reject(new Error(m.error.message)) : resolve(m.result)
      } else if (m.method) {
        const f = this.listeners.get(m.method) || []; this.listeners.delete(m.method); f.forEach((x) => x(m.params))
      }
    })
  }
  static async open(url) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', () => rej(new Error('ws fail')), { once: true })
    })
    return new Cdp(ws)
  }
  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej }))
  }
  once(method) { return new Promise((res) => { const a = this.listeners.get(method) || []; a.push(res); this.listeners.set(method, a) }) }
  async js(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.result.value }
  async click(x, y) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
    }
  }
  async centerOf(selector, textIncludes) {
    const raw = await this.js(`(() => {
      const list = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const el = ${textIncludes ? `list.find(x => (x.textContent||'').includes(${JSON.stringify(textIncludes)}))` : 'list[0]'};
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
    })()`)
    return raw ? JSON.parse(raw) : null
  }
  close() { try { this.ws.close() } catch {} }
}

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}  ${detail ?? ''}`) }
}

async function freshLoad(cdp, theme) {
  await cdp.js(`localStorage.setItem('workstation.ui.theme', ${JSON.stringify(JSON.stringify(theme))})`)
  // 先离开再回来：同 URL（只差 hash）不会重载，store 会留着上一轮的内存状态
  await cdp.send('Page.navigate', { url: 'about:blank' })
  await sleep(250)
  const loaded = cdp.once('Page.loadEventFired')
  await cdp.send('Page.navigate', { url: BASE + '/#/dashboard' })
  await Promise.race([loaded, sleep(20000)])
  await sleep(1600)
}

async function runAt(cdp, width, height, label) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 760 })
  console.log(`\n=== ${label} ===`)
  const nowH = new Date().getHours()
  const shouldAutoBeDark = nowH >= 19 || nowH < 7
  console.log(`  （当前 ${nowH} 点，按时间自动应为${shouldAutoBeDark ? '暗' : '亮'}）`)

  // 1) auto 的判定对不对
  await freshLoad(cdp, 'auto')
  const autoTheme = await cdp.js(`document.documentElement.dataset.theme`)
  check('auto 模式下主题与时间窗口一致', autoTheme === (shouldAutoBeDark ? 'dark' : 'light'), `实际=${autoTheme}`)

  // 2) 菜单能点开（真鼠标事件）
  const btn = await cdp.centerOf('.topbar .icon-btn')
  // 找 aria-label 以「主题」开头的那一颗
  const btnBox = await cdp.js(`(() => {
    const b = [...document.querySelectorAll('.topbar .icon-btn')].find(x => (x.getAttribute('aria-label')||'').startsWith('主题'));
    if (!b) return null; const r = b.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
  })()`)
  check('找得到主题按钮', !!btnBox)
  if (!btnBox) return
  const b = JSON.parse(btnBox)
  await cdp.click(b.x, b.y)
  await sleep(700)
  const menuOpen = await cdp.js(`[...document.querySelectorAll('.el-dropdown-menu')].filter(m => m.offsetParent !== null).length`)
  const tooltipShown = await cdp.js(`[...document.querySelectorAll('.el-popper')].filter(p => (p.textContent||'').includes('主题：') && p.offsetParent !== null).length`)
  check('点一下能打开菜单', menuOpen > 0, `可见菜单=${menuOpen}`)
  check('弹的是菜单不是 tooltip（tooltip 吃点击的坑）', tooltipShown === 0, `tooltip=${tooltipShown}`)
  if (menuOpen === 0) return

  // 3) 切到「与当前相反」的模式，断言主题真的变了
  const want = autoTheme === 'dark' ? '亮色' : '暗色'
  const wantTheme = autoTheme === 'dark' ? 'light' : 'dark'
  const item = await cdp.centerOf('.el-dropdown-menu__item', want)
  check(`菜单里有「${want}」项`, !!item)
  if (item) {
    await cdp.click(item.x, item.y)
    await sleep(900)
    const after = await cdp.js(`document.documentElement.dataset.theme`)
    const saved = await cdp.js(`localStorage.getItem('workstation.ui.theme')`)
    check(`点「${want}」后主题变成 ${wantTheme}`, after === wantTheme, `实际=${after}`)
    check('选择被持久化', (saved || '').includes(wantTheme), `存的=${saved}`)
  }

  // 4) 切回「按时间自动」，断言回到 auto 的判定
  await cdp.click(b.x, b.y)
  await sleep(600)
  const autoItem = await cdp.centerOf('.el-dropdown-menu__item', '按时间自动')
  if (autoItem) {
    await cdp.click(autoItem.x, autoItem.y)
    await sleep(900)
    const back = await cdp.js(`document.documentElement.dataset.theme`)
    const saved = await cdp.js(`localStorage.getItem('workstation.ui.theme')`)
    check('能切回「按时间自动」', (saved || '').includes('auto'), `存的=${saved}`)
    check('切回自动后与时间窗口一致', back === (shouldAutoBeDark ? 'dark' : 'light'), `实际=${back}`)
  } else {
    check('菜单里有「按时间自动」项（能回到自动的路）', false)
  }
}

async function main() {
  const chrome = findChrome()
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-probe-'))
  const child = spawn(chrome, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-proxy-server', 'about:blank'], { stdio: 'ignore' })
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break } catch {} await sleep(250) }
    const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json()
    const cdp = await Cdp.open(t.webSocketDebuggerUrl)
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
    console.log('主题功能测试（真鼠标事件 + 真重载）')
    await runAt(cdp, 1440, 900, '桌面 1440')
    await runAt(cdp, 390, 844, '手机 390')
    cdp.close()
    try { await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`) } catch {}
  } finally {
    child.kill(); await sleep(300)
    try { fs.rmSync(profile, { recursive: true, force: true }) } catch {}
  }
  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error('探针失败：', e.message); process.exit(2) })
