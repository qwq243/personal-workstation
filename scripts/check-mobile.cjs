#!/usr/bin/env node
/**
 * 手机布局门禁：用本机 Chrome 以手机视口逐个打开路由，断言「没有横向溢出」。
 *
 * 为什么要有它：手机适配涉及 48 个视图、几百条样式，靠肉眼在手机上一个个滑是查不完的，
 * 而且「这次改好了、下次改动又顶出来」没人拦得住。这个脚本把「适配完」变成一条可执行、
 * 可复跑的断言 —— 和 `npm run check:pages` 是同一个思路（那边管页面宽度，这边管手机）。
 *
 * 用法
 *   node scripts/check-mobile.cjs                 # 全部路由，只报告
 *   node scripts/check-mobile.cjs vocab news       # 只跑路径里含这些片段的路由
 *   node scripts/check-mobile.cjs --shots          # 顺便每页存一张整页截图
 *   WS_BASE=http://127.0.0.1:5278 node scripts/check-mobile.cjs
 *
 * 退出码：0 = 全过；1 = 有页面横向溢出（可直接进 CI / pre-push）。
 *
 * 原理：Chrome 起一个 headless 实例开调试口，用 CDP 的
 * `Emulation.setDeviceMetricsOverride` 把视口定死成手机宽，再 `Runtime.evaluate`
 * 在页面里量一遍。Node 22 自带 WebSocket 全局对象，所以不需要任何依赖。
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const ROOT = path.resolve(__dirname, '..')
const BASE = process.env.WS_BASE || 'http://127.0.0.1:5278'
const VIEWPORT = { width: 390, height: 844, dsf: 3 } // 约等于 Redmi K70 Ultra 的 CSS 视口
const SHOT_DIR = path.join(ROOT, 'logs', 'mobile-shots')
const PORT = Number(process.env.WS_CDP_PORT || 9333)
const NAV_TIMEOUT_MS = 25000

/* ------------------------------------------------------------- 路由清单 -- */
/**
 * 从源码取，不写死 —— 写死的清单一定会漂移。
 * 功能路由在 `src/features/<模块>/*module*.ts` 里以 `path: '...'` 声明
 * （有的模块一份 module.ts 里放好几个路由，也有的按域拆成 usage.module.ts / calendar.module.ts
 *  —— 后者原先漏扫，office 那两页因此从来没被测过，见 2026-09-29）；
 * 内核路由在 `src/router/index.ts`。带参数的（/wiki/p/:slug）跳过：没有真实 slug 打不开。
 *
 * `_` 开头的目录是脚手架/草稿（`src/features/_template/` 那份可照抄的模块模板，
 * 见它自己的 README「它为什么不会被自动注册」）—— 它**没有**在 features/index.ts 注册，
 * 页面上根本没有这条路由，扫进来只会测到一个空壳页（2026-09-30 实测报「正文几乎为空」）。
 */
function collectRoutes() {
  const out = new Set(['/', '/apps', '/settings', '/dev-guide'])
  const featDir = path.join(ROOT, 'src', 'features')
  for (const mod of fs.readdirSync(featDir)) {
    const dir = path.join(featDir, mod)
    if (!fs.statSync(dir).isDirectory()) continue
    if (mod.startsWith('_')) continue // 模板/草稿：未注册，没有真实路由
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && f.includes('module'))
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8')
      for (const m of src.matchAll(/path:\s*'([^']+)'/g)) {
        const p = m[1]
        if (p.includes(':')) continue // 参数路由，跳过
        out.add(p)
      }
    }
  }
  return [...out].sort()
}

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

/** 极简 CDP 客户端：只用得到 send / 等事件，不值得引依赖 */
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

  /** 持续监听（不是 once）：用来收集页面的异常与控制台报错 */
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

/* ------------------------------------------------------------- 度量脚本 -- */
/**
 * 在页面里跑的断言。返回：
 *   overflow  整页或内容区是否横向溢出（最硬的那条）
 *   bad       右边界越出视口的元素
 *   hscroll   页面上**嵌套的**横向滚动容器（信息用；目标是把它们清到最少）
 *
 * 两个关键判断，写错任何一个这脚本都会变成「永远通过」的空壳：
 *
 *  1. **`.content` 算视口边界，不算合法的横向滚动容器。**
 *     AppShell 的 `.content` 只写了 `overflow-y: auto`，按 CSS 规范 `overflow-x`
 *     会计算成 `auto` —— 于是任何超宽内容都被它自己吞掉，
 *     `document.documentElement.scrollWidth` 永远等于视口宽。只看 documentElement
 *     的话，一个要左右拖的页面会被判成「没问题」。所以显式查 `.content` 自身有没有滚，
 *     并且向上找祖先时**在 `.content` 处停住**。
 *  2. 只有嵌套的滚动容器（el-table 的 body wrapper、markdown 代码块）才算设计允许的，
 *     里面的元素不计入越界。
 *  3. SVG 内部元素一律跳过：KaTeX 的伸缩箭头在 <path> 里带的坐标能大到几千 px，
 *     但渲染出来被 <svg> 的视口裁着，量它只会得到稳定的误报（最外层 <svg> 仍会检查）。
 */
const MEASURE = `(() => {
  const vw = document.documentElement.clientWidth;
  const content = document.querySelector('.content');
  const name = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = (el.className && typeof el.className === 'string')
      ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.') : '';
    return el.tagName.toLowerCase() + id + cls;
  };
  // 到达 .content 就停：它是视口边界，不是「允许横滚」的容器
  const inHScroll = (el) => {
    let p = el.parentElement;
    while (p && p !== document.body && p !== content) {
      const ox = getComputedStyle(p).overflowX;
      if ((ox === 'auto' || ox === 'scroll') && p.scrollWidth > p.clientWidth + 1) return true;
      p = p.parentElement;
    }
    return false;
  };
  // 「视觉隐藏」容器里的东西不算：典型的无障碍写法是父级 1px + overflow:hidden + clip，
  // 子元素自身的几何盒仍是自然尺寸。KaTeX 给读屏用的 .katex-mathml 就是这种
  // （1px 盒子装着完整的 MathML），不排掉的话每道公式都会稳定误报。
  const inHiddenBox = (el) => {
    let p = el.parentElement;
    while (p && p !== document.body) {
      const cs = getComputedStyle(p);
      if (cs.display === 'none' || cs.visibility === 'hidden') return true;
      if (cs.overflow === 'hidden' && p.clientWidth <= 2 && p.clientHeight <= 2) return true;
      p = p.parentElement;
    }
    return false;
  };
  // 只给类名往往认不出是页面上哪一块（比如「一个 42px 的按钮」），
  // 附上三层祖级路径，改的时候不用猜。
  const near = (el) => {
    const chain = [];
    let p = el.parentElement;
    let n = 0;
    while (p && p !== document.body && n < 3) {
      chain.unshift(name(p));
      p = p.parentElement;
      n++;
    }
    return chain.join(' > ');
  };
  const bad = [];
  const hscroll = [];
  const contentScrolls = !!content && content.scrollWidth > content.clientWidth + 1;
  if (contentScrolls) hscroll.push({ sel: '.content（视口本身）', by: content.scrollWidth - content.clientWidth });

  // el-table 单独判：EP 的表头是**故意**超出容器、再靠 JS 跟表体滚动同步的
  // （header-wrapper 与 body-wrapper 是兄弟节点），逐个报它内部的行列只会得到一堆噪声。
  // 真正该问的是「这张表要不要左右拖」—— 量表体那个滚动容器。
  const inTable = (el) => !!el.closest('.el-table');
  for (const t of document.querySelectorAll('.el-table')) {
    const wrap = t.querySelector('.el-table__body-wrapper .el-scrollbar__wrap') || t.querySelector('.el-scrollbar__wrap');
    if (wrap && wrap.scrollWidth > wrap.clientWidth + 1) {
      bad.push({
        sel: 'el-table（整张表）需横向滚',
        right: wrap.scrollWidth,
        w: wrap.clientWidth,
        near: near(t),
      });
    }
  }

  for (const el of document.querySelectorAll('body *')) {
    // 跳过 SVG 内部元素：KaTeX 的伸缩箭头在 path 里带的坐标可以大到几千 px，
    // 但渲染出来被 svg 的视口裁着，量它只会得到稳定的误报。
    // 最外层 svg 自身 ownerSVGElement 为 null，仍会被检查，所以不会漏真问题。
    if (el.ownerSVGElement) continue;
    // el-table 内部交给上面那段单独判
    if (inTable(el)) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed' || cs.display === 'none') continue;
    if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1) {
      if (el !== content && hscroll.length < 5) hscroll.push({ sel: name(el), by: el.scrollWidth - el.clientWidth });
    }
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > vw + 1 && !inHScroll(el) && !inHiddenBox(el) && bad.length < 12) {
      bad.push({ sel: name(el), right: Math.round(r.right), w: Math.round(r.width), near: near(el) });
    }
  }
  // 点击可达性探针：**布局不溢出 ≠ 能操作**。
  // 这个探针是因为一个真实事故补的：抽屉的遮罩被写成「手机档常驻」，
  // 于是 fixed + inset:0 + z-index:50 一层灰永久盖在内容上，点什么都被它吃掉 ——
  // 而它在宽度上完全干净，只看溢出的断言一条都不会报。
  // 做法是问浏览器「视口中央最上面那个元素是谁」，不是内容区的后代就说明被挡住了。
  const vh = document.documentElement.clientHeight;
  const probeAt = (y) => {
    const el = document.elementFromPoint(Math.round(vw / 2), Math.round(y));
    if (!el) return null;
    // 正常：点到的确实是内容区里的东西
    if (el.closest('.content')) return null;
    // 加载态（v-loading / 骨架）是暂时的，不算
    if (el.closest('.el-loading-mask, .el-loading-spinner, .el-skeleton')) return null;
    return { sel: name(el), near: near(el) };
  };
  const blockers = [probeAt(vh * 0.35), probeAt(vh * 0.7)].filter(Boolean);

  // ---- 观感问题（比「溢没溢出」更主观，但可量化）----------------------------
  // 起因：手机上虽然不横向溢出，但「本周」被挤成竖排、课程名截断、每日一句被卡片裁掉、
  // 小字只有 9px —— 这些旧的断言一条都不报。这里把「丑」拆成四类可量化的信号。
  const ownText = (el) =>
    Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent)
      .join('')
      .trim();
  const smells = { squeezed: [], clipped: [], tiny: [], smallTap: [] };
  // 离屏的东西不算观感问题：手机抽屉侧栏是 translateX(-100%) 挪走的，
  // 不排掉的话每一页都会稳定报 12 个「20x20 小按钮」（纯噪声，2026-09-28 实测）。
  const offCanvas = (el) => {
    const r = el.getBoundingClientRect();
    if (r.right < 2 || r.left > vw - 2) return true;
    const sb = el.closest('.sidebar, .el-drawer');
    if (sb && sb.getBoundingClientRect().left < -2) return true;
    return false;
  };
  for (const el of document.querySelectorAll('body *')) {
    if (el.ownerSVGElement || inHiddenBox(el) || inTable(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) continue;
    if (cs.position === 'fixed') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (offCanvas(el)) continue;
    const fs = parseFloat(cs.fontSize) || 14;
    const t = ownText(el);
    const allText = (el.innerText || '').trim();

    // ① 竖排/挤压：一行只放得下两三个字，却排了好几行（CJK 里 font-size 约等于字宽）
    // nowrap 的元素**不可能**换行，它的盒子再窄也只是被拉伸（实测规划台「2/8」被
    // flex 的 align-items:stretch 拉成 18×58，看着像竖排其实是一行）—— 直接跳过。
    if (t.length >= 2 && r.width < 64 && !cs.whiteSpace.includes('nowrap')) {
      const lh = parseFloat(cs.lineHeight) || fs * 1.4;
      const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      const lines = Math.max(1, Math.round((r.height - pad) / lh));
      const perLine = r.width / fs;
      if (lines >= 2 && perLine <= 2.3 && smells.squeezed.length < 12) {
        smells.squeezed.push({ sel: name(el), w: Math.round(r.width), lines, text: t.slice(0, 14), near: near(el) });
      }
    }

    // ② 被裁掉：自己写了 overflow:hidden，内容比盒子高（每日一句那种「读一半没了」）
    if ((cs.overflowY === 'hidden' || cs.overflowY === 'clip') && el.clientHeight > 8) {
      // 带省略号的多行截断（-webkit-line-clamp / text-overflow:ellipsis）是**故意的**，
      // 不算「被裁坏」——2026-09-28 实测：句子库那种 2 行省略号卡片会被误报 12 次。
      const onPurpose =
        cs.textOverflow === 'ellipsis' ||
        (cs.webkitLineClamp && cs.webkitLineClamp !== 'none') ||
        // 横向滚动条（页签条、卡片横滑区）：为了能横滑，纵向必然被裁一点，
        // 这是结构性取舍不是 bug（实测每次都报 /paper/console、/process-guard 的 el-tabs__nav-wrap）。
        cs.overflowX === 'auto' ||
        cs.overflowX === 'scroll'
      if (!onPurpose && allText.length >= 8 && el.scrollHeight > el.clientHeight + 3 && smells.clipped.length < 12) {
        smells.clipped.push({
          sel: name(el),
          h: el.clientHeight,
          need: el.scrollHeight,
          text: allText.replace(/\s+/g, ' ').slice(0, 40),
          near: near(el),
        });
      }
    }

    // ③ 字号过小（手机上 <10.5px 基本读不了）
    if (t.length >= 4 && fs < 10.5 && smells.tiny.length < 12) {
      smells.tiny.push({ sel: name(el), fs: Math.round(fs * 10) / 10, text: t.slice(0, 20), near: near(el) });
    }
  }
  // ④ 点按目标过小：真控件（按钮/开关/单选）不该小于 26px
  for (const el of document.querySelectorAll('button, .el-button, [role=button], .el-radio, .el-checkbox, .el-switch')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (offCanvas(el)) continue;
    // EP 自带的两类微型控件**列为已知项**（不是漏检）：
    //   ① el-input-number 的上下箭头（32×15 / 24×11）—— 要修得把输入框加高到 52px，不划算；
    //   ② el-tag 的关闭叉（12~18px）—— EP 的既定尺寸，tag 本体又只有 24px 高。
    // 不排除的话每轮上百条全是它们，真问题被淹没（2026-09-29 定）。
    if (el.closest('.el-input-number') || el.closest('.el-tag__close')) continue;
    if ((r.height < 26 || r.width < 26) && smells.smallTap.length < 12) {
      smells.smallTap.push({
        sel: name(el),
        tag: el.tagName,
        w: Math.round(r.width),
        h: Math.round(r.height),
        // 计算值一起带上：判「规则到底有没有生效」就差这两个数（2026-09-29）
        minw: getComputedStyle(el).minWidth,
        minh: getComputedStyle(el).minHeight,
        text: (el.innerText || '').trim().slice(0, 14),
        near: near(el),
      });
    }
  }

  return JSON.stringify({
    vw,
    docScrollW: document.documentElement.scrollWidth,
    contentScrollW: content ? content.scrollWidth : 0,
    contentScrolls,
    // 页面到底有没有渲染出东西。一个渲染期抛错、整页空白的页面在「有没有横向溢出」上
    // 是完全干净的 —— 这个字段就是为了不让那种页面蒙混过关（真实踩到过一次：
    // 模板里引用了没定义的 ui，整页空白，门禁却报 ok）。
    textLen: content ? (content.innerText || '').replace(/\s+/g, ' ').trim().length : 0,
    overflow: document.documentElement.scrollWidth > vw + 1 || contentScrolls,
    bad,
    hscroll,
    blockers,
    smells,
  });
})()`

/* ------------------------------------------------------------------ 主流程 */
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-mobile-'))
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

  let failed = 0
  const results = []

  try {
    await waitForCdp()
    if (wantShots) fs.mkdirSync(SHOT_DIR, { recursive: true })

    for (const route of routes) {
      const url = `${BASE}/#${route}`
      let target
      try {
        target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json()
      } catch {
        // 老版本 Chrome 只认 GET
        target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`)).json()
      }
      const cdp = await Cdp.open(target.webSocketDebuggerUrl)

      // 页面的未捕获异常：模板引用了没定义的变量这类错误，会让整页空白，
      // 而空白的页面在宽度与点击两项上全是干净的 —— 只有听异常才抓得到。
      const pageErrors = []
      cdp.on('Runtime.exceptionThrown', (p) => {
        const d = p?.exceptionDetails
        const text = d?.exception?.description || d?.text || '未知异常'
        pageErrors.push(String(text).split('\n')[0].slice(0, 160))
      })
      cdp.on('Runtime.consoleAPICalled', (p) => {
        if (p?.type !== 'error') return
        const text = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ')
        if (text) pageErrors.push('console.error: ' + text.slice(0, 160))
      })

      try {
        await cdp.send('Page.enable')
        await cdp.send('Runtime.enable')
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: VIEWPORT.width,
          height: VIEWPORT.height,
          deviceScaleFactor: VIEWPORT.dsf,
          mobile: true,
        })
        // 重新加载让设备参数对首屏生效（挂上来的时候首屏已经按桌面渲染过一次了）
        const loaded = cdp.once('Page.loadEventFired')
        await cdp.send('Page.navigate', { url })
        await Promise.race([loaded, sleep(NAV_TIMEOUT_MS)])

        // 等数据落地与骨架收起：各页都是异步拉边车，立刻量会量到骨架屏。
        // 固定 1.2s 不够稳（2026-09-28 实测：同一份代码两次跑，两个页面偶尔
        // 会报「正文为空/被挡住」——其实是那次导航还没渲染完）。改成轮询到有正文为止。
        let lastLen = -1
        let stable = 0
        for (let i = 0; i < 30; i++) {
          const len = Number(
            (await cdp.send('Runtime.evaluate', {
              expression: `((document.querySelector('.content')||document.body).innerText||'').replace(/\s+/g,'').length`,
              returnByValue: true,
            })).result.value || 0,
          )
          // 「稳定」= 有正文 且 连续两次一样。只判一次 ≥40 不够：句子库那种页面
          // 表头就有 70 多字，看着达标其实列表还没来（2026-09-28 实测）。
          if (len >= 40 && len === lastLen) {
            if (++stable >= 2) break
          } else {
            stable = 0
          }
          lastLen = len
          await sleep(500)
        }

        const r = await cdp.send('Runtime.evaluate', { expression: MEASURE, returnByValue: true })
        let m = JSON.parse(r.result.value)
        // 遮挡探针会误报：手机侧栏是带过渡的抽屉，采样正好落在动画中途就会点到 .nav__item。
        // 等 900ms 再确认一次，两次都挡住才算（2026-09-28 复跑两次全干净、全量跑却报 3 条，就是这么来的）。
        if ((m.blockers || []).length) {
          await sleep(900)
          const r2 = await cdp.send('Runtime.evaluate', { expression: MEASURE, returnByValue: true })
          const m2 = JSON.parse(r2.result.value)
          if ((m2.blockers || []).length === 0) m = m2
        }

        /**
         * 再把每个 el-tabs 页签点开各量一遍。
         * 默认只量到当前可见的那一个页签 —— 而多页签页面（进程守护 6 个、设置与数据 5 个）
         * 的坏表大多在**别的**页签里，不点开就等于没测。
         */
        const tabCount = Number(
          (await cdp.send('Runtime.evaluate', {
            expression: `document.querySelectorAll('.el-tabs__item').length`,
            returnByValue: true,
          })).result.value || 0,
        )
        const badTabs = []
        for (let i = 0; i < Math.min(tabCount, 12); i++) {
          const label = String(
            (await cdp.send('Runtime.evaluate', {
              expression: `(document.querySelectorAll('.el-tabs__item')[${i}]?.textContent || '').trim().replace(/\\s+/g,' ').slice(0, 24)`,
              returnByValue: true,
            })).result.value || `页签${i}`,
          )
          await cdp.send('Runtime.evaluate', {
            expression: `document.querySelectorAll('.el-tabs__item')[${i}]?.click()`,
            returnByValue: true,
          })
          await sleep(800)
          const tm = JSON.parse(
            (await cdp.send('Runtime.evaluate', { expression: MEASURE, returnByValue: true })).result.value,
          )
          if (tm.overflow || tm.bad.length || (tm.blockers || []).length) badTabs.push({ label, ...tm })
        }

        const blocked = (m.blockers || []).length > 0
        // 40 个字符是保守下限：真渲染出来的页面正文远不止这个数，
        // 而渲染崩掉/空白的页面基本是 0。宁可阈值低一点也不要误报正常页面。
        const empty = (m.textLen || 0) < 40
        const errs = pageErrors.slice(0, 3)
        const ok =
          !m.overflow && m.bad.length === 0 && !blocked && !empty && errs.length === 0 && badTabs.length === 0
        if (!ok) failed++
        results.push({ route, ...m, ok, errors: errs, badTabs })
        console.log(
          `${ok ? '  ok  ' : ' FAIL '} ${route.padEnd(28)} 内容区 ${String(m.contentScrollW).padStart(4)}/${m.vw}` +
            `  正文 ${String(m.textLen || 0).padStart(4)} 字` +
            (tabCount ? `  页签 ${tabCount}` : '') +
            (m.bad.length ? `  越界元素 ${m.bad.length}` : '') +
            (m.hscroll.length ? `  横滚容器 ${m.hscroll.length}` : '') +
            (blocked ? `  ⚠ 内容被挡住 ${m.blockers.length} 处` : '') +
            (empty ? '  ⚠ 正文几乎为空（像是渲染崩了）' : '') +
            (errs.length ? `  ⚠ 页面报错 ${pageErrors.length} 条` : '') +
            (badTabs.length ? `  ⚠ 有问题的页签 ${badTabs.length}/${tabCount}` : ''),
        )
        if (!ok) {
          for (const b of m.bad.slice(0, 6)) {
            console.log(`          · ${b.sel}  右边界 ${b.right}（宽 ${b.w}）`)
            if (b.near) console.log(`            在: ${b.near}`)
          }
          for (const b of m.blockers) {
            console.log(`          ⚠ 视口中央点到的是 ${b.sel} —— 内容被它挡住，用户点不动`)
            if (b.near) console.log(`            在: ${b.near}`)
          }
          for (const e of errs) console.log(`          ⚠ ${e}`)
          for (const t of badTabs) {
            console.log(
              `          ⚠ 页签「${t.label}」内容区 ${t.contentScrollW}/${t.vw}` +
                (t.bad.length ? `，越界元素 ${t.bad.length}` : '') +
                (t.blockers?.length ? `，被挡住 ${t.blockers.length} 处` : ''),
            )
            for (const b of t.bad.slice(0, 3)) console.log(`              · ${b.sel}  右边界 ${b.right}（宽 ${b.w}）`)
          }
        }
        const sm = m.smells || {}
        const smCount = (sm.squeezed?.length || 0) + (sm.clipped?.length || 0) + (sm.tiny?.length || 0) + (sm.smallTap?.length || 0)
        if (smCount) {
          console.log(
            '          ~ 观感: 竖排挤压 ' + (sm.squeezed?.length || 0) + ' · 被裁文本 ' + (sm.clipped?.length || 0) +
              ' · 过小字号 ' + (sm.tiny?.length || 0) + ' · 过小点按 ' + (sm.smallTap?.length || 0),
          )
          for (const x of (sm.squeezed || []).slice(0, 3)) console.log('            ↕ 竖排: 「' + x.text + '」宽 ' + x.w + 'px 排了 ' + x.lines + ' 行  @ ' + x.near)
          for (const x of (sm.clipped || []).slice(0, 3)) console.log('            ✂ 被裁: 「' + x.text + '」 需要 ' + x.need + 'px 只有 ' + x.h + 'px  @ ' + x.near)
          for (const x of (sm.tiny || []).slice(0, 3)) console.log('            ᵃ 过小字号 ' + x.fs + 'px: 「' + x.text + '」 @ ' + x.near)
          for (const x of (sm.smallTap || []).slice(0, 3))
            console.log(
              '            ☐ 过小点按 ' + x.w + '×' + x.h + '（' + (x.tag || '') + ' min ' + x.minw + '/' + x.minh + '）: 「' + x.text + '」 @ ' + x.near,
            )
        }

        // 嵌套的横向滚动容器**不算失败**（正文里的代码块这类确实该能滚），
        // 但它意味着「手机上仍要左右拖」，所以无条件列出来，方便一个个清掉。
        for (const h of m.hscroll) console.log(`          ~ 可横向滚动: ${h.sel}（多出 ${h.by}px）`)

        if (wantShots) {
          try {
            const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
            const file = path.join(SHOT_DIR, route.replace(/[^\w]+/g, '_').replace(/^_|_$/g, '') || 'root') + '.png'
            fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
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
      /* Windows 上偶发占用，留着也无妨 */
    }
  }

  const smellTotal = results.reduce((n, r) => {
    const s2 = r.smells || {}
    return n + (s2.squeezed?.length || 0) + (s2.clipped?.length || 0) + (s2.tiny?.length || 0) + (s2.smallTap?.length || 0)
  }, 0)
  console.log(`\n共 ${results.length} 条路由，横向溢出 ${failed} 条 · 观感问题 ${smellTotal} 处`)
  if (wantShots) console.log(`整页截图：${path.relative(ROOT, SHOT_DIR)}`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('check-mobile 失败：', e.message)
  process.exit(2)
})
