/**
 * 本机浏览器（Chrome / Edge）的定位 —— 给需要 `--headless` 打印的模块用（做题本导出 PDF）。
 *
 * 为什么不用 puppeteer：这件事只需要「起浏览器 + 打印成 PDF」，
 * 为它引一个上百 MB 的依赖不划算。
 *
 * 只列了 Windows 上的默认安装位置（本项目的启动脚本也是 Windows 的）；
 * 别的系统往 BROWSERS 里加一条即可。
 */
import fs from 'node:fs'

/** Chrome 优先（多数人平时用它），Edge 兜底 */
export const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]

/** 找到就用，找不到回空串（调用方自己报错，别在这里抛） */
export function findBrowser() {
  return BROWSERS.find((p) => fs.existsSync(p)) ?? ''
}
