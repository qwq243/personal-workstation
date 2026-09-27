/**
 * 提权执行（会弹一次 UAC）。
 *
 * 谁在用：需要管理员权限的那几个动作（清系统待机列表等）——
 * 两个都是「程序清单里要求管理员权限，非提权进程连创建它都做不到（WinError 740）」，
 * 所以都得走这条道：起一个提权的 PowerShell 跑一句命令，跑完自己退。
 *
 * 做法：把要跑的脚本包一层（结果 JSON 落到临时文件再读回），
 * 经 `Start-Process -Verb RunAs -Wait` 拉起一个提权 PowerShell 执行它 ——
 * 提权进程的 stdout 是拿不到的，只能靠文件回传。
 *
 * 编码坑（务必按此写法）：Windows 中文环境下 PowerShell 读 .ps1 时，若文件是
 * UTF-8 **不带 BOM**，会按 ANSI/GBK 解码，脚本里的中文会变成乱码甚至导致语法错误。
 * 所以这里：① 统一加 UTF-8 BOM；② 生成脚本内的提示语只用 ASCII（双保险）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../config.mjs'
import { runHidden, sleep } from './net.mjs'

const POWERSHELL = 'powershell -NoProfile -ExecutionPolicy Bypass'

/**
 * 以管理员身份跑一段 PowerShell（会弹一次 UAC）。
 *
 * @param {string} script 要执行的 PowerShell 片段；里面可以通过给 `$__extra` 赋值来附带返回值
 * @param {{timeout?: number, tmpDir?: string}} [opts]
 * @returns {Promise<{ok: boolean, error?: string, [k: string]: any}>}
 *          `ok:false` 且 error 是「提权操作未返回结果」时，多半是用户把 UAC 取消了
 */
export async function runElevated(script, { timeout = 60000, tmpDir } = {}) {
  const dir = tmpDir ?? path.join(loadConfig().dataDir, 'tmp')
  fs.mkdirSync(dir, { recursive: true })
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const psFile = path.join(dir, `elev-${stamp}.ps1`)
  const outFile = path.join(dir, `elev-${stamp}.json`)

  // 把要执行的脚本包一层：结果 JSON 落到 outFile
  const wrapped = `
$ErrorActionPreference = 'Continue'
$__out = ${JSON.stringify(outFile)}
try {
${script}
  $__result = @{ ok = $true } + $__extra
} catch {
  $__result = @{ ok = $false; error = $_.Exception.Message }
  if ($__extra) { $__result += $__extra }
}
$__result | ConvertTo-Json -Depth 6 -Compress | Set-Content -LiteralPath $__out -Encoding UTF8
`
  // UTF-8 with BOM：见上面注释，别去掉 '\uFEFF'
  fs.writeFileSync(psFile, `\uFEFF${wrapped}`, 'utf8')

  const launcher = path.join(dir, `elev-${stamp}.launcher.ps1`)
  fs.writeFileSync(
    launcher,
    `\uFEFFStart-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -WindowStyle Hidden ` +
      `-ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',${JSON.stringify(psFile)})\n`,
    'utf8',
  )

  await runHidden(`${POWERSHELL} -File "${launcher}"`, { timeout })

  // 等结果文件出现
  const deadline = Date.now() + Math.min(timeout, 30000)
  while (Date.now() < deadline && !fs.existsSync(outFile)) await sleep(250)

  let result = { ok: false, error: '提权操作未返回结果（可能取消了 UAC）' }
  if (fs.existsSync(outFile)) {
    try {
      result = JSON.parse(fs.readFileSync(outFile, 'utf8').replace(/^\uFEFF/, ''))
    } catch (err) {
      result = { ok: false, error: `解析提权结果失败: ${err.message}` }
    }
  }
  for (const f of [psFile, launcher, outFile]) {
    try {
      fs.rmSync(f, { force: true })
    } catch {
      /* ignore */
    }
  }
  return result
}

export { POWERSHELL }
