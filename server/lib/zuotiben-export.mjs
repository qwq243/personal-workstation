/**
 * 做题本导出 PDF —— 服务端**真出文件**。两本册子共用这一套：
 *   数学「每日一题」（`#/zuotiben/print`，一本按日期）
 *   英语「每日一句」（`#/zuotiben/sentence-print`，一本按 Day 区间）
 *
 * 为什么要有这个：原来页面上那个「打印 / 存 PDF」只是 `window.open` 打开打印版页面，
 * 用户还得自己按 Ctrl+P 再选「另存为 PDF」——那不叫导出（2026-09-27 用户反馈：
 * 「导出不了，点击一下会跳转」）。现在点一下直接把 PDF 落到下载里。
 *
 * 实现：调本机 Chrome/Edge 的 `--headless=new --print-to-pdf`。
 * 不引 puppeteer —— 边车与浏览器跑在同一台机器上，为「打印成 PDF」加一个上百 MB
 * 的依赖不划算。页面版式里 `@page { size: A4 landscape/portrait }` 由**打印页自己按查询参数**下发，
 * Chrome 会照它切纸张方向。
 *
 * 三个参数就是用户在「导出」对话框里选的：格式（三种）、方向（横向/纵向）、含不含备注（每日一句是含不含词汇）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { dataDir } from './plan.mjs'
import { findBrowser } from './browser.mjs'
import { getDay } from './zuotiben.mjs'
import * as englishDaily from './english-daily.mjs'

/** 导出文件放这儿；只留最近几十个，不然会越堆越多 */
export const EXPORT_DIR = () => path.join(dataDir(), 'exports')
const KEEP = 40
/** 浏览器启动 + 页面渲染 + 打印，实测十几秒；给足但不至于挂死 */
const TIMEOUT_MS = 90000

/**
 * 两本册子的差异只有三处：文件名前缀、打印页路由、三种格式的中文名。
 * 别的（起浏览器、排队、清理旧文件、回字节）完全一样，所以都走这一个函数。
 */
const BOOKS = {
  problem: {
    tag: '做题本',
    printPath: 'zuotiben/print',
    modes: { blank: '纯题目', inline: '答案在题里', appendix: '答案在后' },
  },
  sentence: {
    tag: '每日一句',
    printPath: 'zuotiben/sentence-print',
    // 没有 inline：那三块（参考译文/结构划分/语法重点）横放 A4 一页装不下，硬出就是「一句两页」。
    // 传了 inline 会被下面那道 mode 校验落回 blank（见 printPath 对应的打印页注释）。
    modes: { blank: '纯句子', appendix: '答案在后' },
  },
}
const ORIENTS = { landscape: '横向', portrait: '纵向' }

/** 同一时刻只允许一个导出：共用 profile 目录，两个实例会互相顶掉 */
let queue = Promise.resolve()

function safeName(s) {
  return String(s ?? '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
}

function prune() {
  try {
    const dir = EXPORT_DIR()
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.pdf'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const { f } of files.slice(KEEP)) fs.unlinkSync(path.join(dir, f))
  } catch {
    /* 清理失败不影响导出 */
  }
}

/**
 * 出一次 PDF。
 *
 * @param {object} o
 * @param {string} o.baseUrl  边车自己的地址（`http://127.0.0.1:5278`），打印页从它加载
 * @param {'problem'|'sentence'} o.book 哪本册子（默认题目本）
 * @param {string} o.date     YYYY-MM-DD（题目本）
 * @param {string|number} o.from/o.to  Day 区间（每日一句）
 * @param {string} o.mode     blank | inline | appendix
 * @param {string} o.orient   landscape | portrait
 * @param {boolean} o.withNote 题目本：是否把备注一起印上
 * @param {boolean} o.withVocab 每日一句：是否把词汇一起印上
 * @param {string} o.ansLayout flow（答案连着排）| page（每条详解独占一页）
 */
export async function exportPdf({
  baseUrl,
  book = 'problem',
  date,
  from,
  to,
  mode = 'blank',
  orient = 'landscape',
  withNote = false,
  withVocab = false,
  ansLayout = 'flow',
} = {}) {
  const B = BOOKS[book] ?? BOOKS.problem
  const m = B.modes[mode] ? mode : 'blank'
  const o = ORIENTS[orient] ? orient : 'landscape'

  // 先把数据取出来：没东西可导就别去起浏览器（那一步要十几秒）
  let range = ''
  let q = null
  if (book === 'sentence') {
    const sh = englishDaily.sheet({ from, to })
    if (!sh.ok) return { ok: false, error: sh.error }
    if (!sh.items.length) return { ok: false, error: '这一段还没有句子，没什么可导的' }
    range = `Day${sh.from}-${sh.to}`
    q = new URLSearchParams({
      from: String(sh.from),
      to: String(sh.to),
      mode: m,
      orient: o,
      ...(withVocab ? { vocab: '1' } : {}),
      ...(ansLayout === 'page' ? { anslayout: 'page' } : {}),
    })
  } else {
    const day = getDay(date)
    if (!day.problems.length) return { ok: false, error: `${date} 还没有题，没什么可导的` }
    range = day.date
    q = new URLSearchParams({
      date: day.date,
      mode: m,
      orient: o,
      note: withNote ? '1' : '0',
      ...(ansLayout === 'page' ? { anslayout: 'page' } : {}),
    })
  }

  const browser = findBrowser()
  if (!browser) return { ok: false, error: '本机没找到 Chrome / Edge，装一个再试' }

  const dir = EXPORT_DIR()
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '')
  const base = `${B.tag}_${range}_${B.modes[m]}_${ORIENTS[o]}_${stamp}`
  const outFile = path.join(dir, `${safeName(base)}.pdf`)
  const url = `${String(baseUrl).replace(/\/$/, '')}/#/${B.printPath}?${q.toString()}`

  const run = () =>
    new Promise((resolve) => {
      const args = [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        // 独立 profile：不碰用户自己开的浏览器窗口。复用同一个目录，第二次起得快些。
        `--user-data-dir=${path.join(dataDir(), 'export-profile')}`,
        // SPA 要等数据 + KaTeX 排完版，虚拟时间预算给够
        '--virtual-time-budget=20000',
        '--no-pdf-header-footer',
        `--print-to-pdf=${outFile}`,
        url,
      ]
      const child = spawn(browser, args, { stdio: 'ignore', windowsHide: true })
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* 已经退出了 */
        }
        resolve({ ok: false, error: '导出超时（90 秒），浏览器没把 PDF 写出来' })
      }, TIMEOUT_MS)
      child.on('error', (e) => {
        clearTimeout(timer)
        resolve({ ok: false, error: `起不来浏览器：${e.message}` })
      })
      child.on('exit', () => {
        clearTimeout(timer)
        try {
          const st = fs.statSync(outFile)
          if (st.size > 1000) resolve({ ok: true, file: outFile, name: `${safeName(base)}.pdf`, bytes: st.size })
          else resolve({ ok: false, error: '浏览器退出但没写出文件（页面可能没加载起来）' })
        } catch {
          resolve({ ok: false, error: '浏览器退出但找不到输出文件' })
        }
      })
    })

  // 串行执行：见 queue 的说明
  const p = queue.then(run, run)
  queue = p.then(
    () => undefined,
    () => undefined,
  )
  const r = await p
  if (r.ok) prune()
  return r
}

export function info() {
  const dir = EXPORT_DIR()
  let files = []
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.pdf'))
      .map((f) => ({ name: f, bytes: fs.statSync(path.join(dir, f)).size }))
  } catch {
    /* 还没有导出过 */
  }
  return { ok: true, dir, count: files.length, files: files.slice(-10) }
}
