/**
 * 启动文件夹自启位（VBS）—— 通用管理：给工作站自己以及任何「需要一个开机自启项」的伙伴用。
 *
 * 通用版：按文件名给状态、开关，并能写出 VBS 内容。
 *
 * ⚠️ VBS 编码是整个功能最容易踩的坑，实测结论（2026-09-20，本机 cscript 验证）：
 *
 *   | 文件编码            | wscript 解析中文路径 | 结果 |
 *   |---------------------|----------------------|------|
 *   | UTF-8 无 BOM        | 按 ANSI(GBK) 解码 → 乱码 | ✗ 路径找不到 |
 *   | UTF-8 带 BOM        | 直接报「无效字符」    | ✗ 语法错误 |
 *   | UTF-16LE 带 BOM     | 正确                 | ✓ |
 *   | GBK (ANSI/936)      | 正确                 | ✓ |
 *
 * 所以**必须写 UTF-16LE + BOM**。曾经启动文件夹里那一条
 * 是 UTF-8 无 BOM，里面的中文路径（`C:\项目目录\...`）被解码成乱码，
 * `CurrentDirectory` 指向一个不存在的目录 —— 那个自启位其实一直没生效。
 * Node 直接 fs.writeFileSync 默认就是 UTF-8，正是这个坑的来源。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig } from '../config.mjs'
import { runHidden } from './net.mjs'

/** 启动文件夹目录 */
export function startupDir() {
  const cfg = loadConfig()
  return cfg.startupDir ?? ''
}

/** 自启位状态：active（启用）/ disabled（改名为 .disabled）/ 都不存在 */
export function state(name) {
  const dir = startupDir()
  const file = path.join(dir, name)
  const disabledFile = path.join(dir, `${name}.disabled`)
  let active = false
  let disabled = false
  try {
    active = fs.existsSync(file)
  } catch {
    /* 目录不可读 → 视为未启用 */
  }
  try {
    disabled = fs.existsSync(disabledFile)
  } catch {
    /* 同上 */
  }
  return { dir, name, file, disabledFile, active, disabled, present: active || disabled }
}

/** 开关：切换文件名后缀 .disabled，不需要管理员权限 */
export function setEnabled(name, enabled) {
  const st = state(name)
  try {
    if (enabled) {
      if (!st.active && st.disabled) fs.renameSync(st.disabledFile, st.file)
    } else if (st.active) {
      if (st.disabled) fs.rmSync(st.disabledFile, { force: true })
      fs.renameSync(st.file, st.disabledFile)
    }
  } catch (err) {
    return { ok: false, error: err.message, ...state(name) }
  }
  return { ok: true, ...state(name) }
}

/**
 * 把 VBS 内容写成 UTF-16LE + BOM。
 * 不用 fs.writeFileSync(name, text, 'utf8') —— 那正是上面那个坑。
 */
export function writeVbs(name, content) {
  return writeVbsAt(state(name).dir, name, content)
}

/**
 * 同上，但写到指定目录。
 *
 * 用途：本机安全策略禁止在**启动文件夹**新建 .vbs / .cmd（见 writeShortcut 的注释），
 * 所以自启脚本本体落到仓库 scripts/ 下，启动文件夹里只放一个 .lnk 指过来。
 */
export function writeVbsAt(dir, name, content) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, name)
    const lf = content.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(lf, 'utf16le')]))
    // 生成即启用：旧的 .disabled 残留会让人以为「关着」
    const disabledFile = path.join(dir, `${name}.disabled`)
    if (fs.existsSync(disabledFile)) fs.rmSync(disabledFile, { force: true })
    return { ok: true, file }
  } catch (err) {
    return { ok: false, error: err.message, file: path.join(dir, name) }
  }
}

/** PowerShell 单引号字符串转义（路径里出现单引号时把 ' 写成 ''） */
function psStr(s) {
  return `'${String(s).replace(/'/g, "''")}'`
}

/**
 * 在启动文件夹里建/修一条 .lnk 快捷方式，返回 { ok, file, ... }。
 *
 * 为什么是 .lnk 而不是直接把 .vbs 放进启动文件夹（2026-09-23 实测，别再改回去）：
 *
 *   本机安全策略**禁止在启动文件夹新建 .vbs / .cmd** —— Python 的 open、
 *   PowerShell 的 Copy-Item、以及「先建 .txt 再改名成 .vbs」全部报「拒绝访问」；
 *   .txt 与 .lnk 则放行。覆盖一个**已存在**的 .vbs 是允许的，所以老写法看着一直能用，
 *   一旦那条 .vbs 被删或改名成 .disabled，就再也装不回去了（自启静默丢失）。
 *   .lnk 的改名（.lnk → .lnk.disabled）是放行的，所以「关闭自启」照样能用。
 *
 * PowerShell 脚本必须先落成 **UTF-8 + BOM 的 .ps1** 再 -File 执行：
 * 命令行里直接传中文路径会被 cmd 的代码页糟蹋（与 net.mjs 的 spawnVisible 同一个坑）。
 */
export async function writeShortcut(name, { target, args = '', workdir = '', description = '' } = {}) {
  const st = state(name)
  const psFile = path.join(os.tmpdir(), `ws-shortcut-${process.pid}.ps1`)
  const script =
    '$ErrorActionPreference = "Stop"\n' +
    `$ws = New-Object -ComObject WScript.Shell\n` +
    `$s = $ws.CreateShortcut(${psStr(st.file)})\n` +
    `$s.TargetPath = ${psStr(target)}\n` +
    `$s.Arguments = ${psStr(args)}\n` +
    (workdir ? `$s.WorkingDirectory = ${psStr(workdir)}\n` : '') +
    `$s.WindowStyle = 7\n` + // 7 = 最小化；真正的「不显示窗口」由 wscript 里的 shell.Run(…, 0) 保证
    (description ? `$s.Description = ${psStr(description)}\n` : '') +
    '$s.Save()\n'
  try {
    fs.writeFileSync(psFile, `\uFEFF${script}`, 'utf8')
    const r = await runHidden(
      `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`,
      { timeout: 20000 },
    )
    if (r.code !== 0 || !fs.existsSync(st.file)) {
      return { ok: false, error: (r.stderr || '').trim().slice(0, 300) || `退出码 ${r.code}`, ...state(name) }
    }
    // 建好即启用：残留的 .disabled 会让人以为「关着」
    if (fs.existsSync(st.disabledFile)) fs.rmSync(st.disabledFile, { force: true })
    return { ok: true, ...state(name) }
  } catch (err) {
    return { ok: false, error: err.message, ...state(name) }
  }
}

/** 删除自启位（启用位与禁用位都删） */
export function remove(name) {
  const st = state(name)
  try {
    for (const f of [st.file, st.disabledFile]) {
      if (fs.existsSync(f)) fs.rmSync(f, { force: true })
    }
    return { ok: true, ...state(name) }
  } catch (err) {
    return { ok: false, error: err.message, ...state(name) }
  }
}

/** VBS 字符串字面量转义：VBS 里双引号要写成两个 */
function vbsStr(s) {
  return `"${String(s).replace(/"/g, '""')}"`
}

/**
 * 生成「登录后静默启动一条命令」的 VBS。
 *
 * windowStyle=0 隐藏窗口；bWaitOnReturn=False 不阻塞登录。
 *
 * ⚠️ 两个必须这么写的地方（都是实测踩出来的，见 2026-09-20 的探针）：
 *
 * 1) **整条命令外面再包一对引号**：`cmd.exe /c "…"`。
 *    cmd.exe 对 `/c` 后面的字符串有条特殊规则：如果以引号开头，它会剥掉首尾各一个引号。
 *    于是 `cmd.exe /c "C:\node.exe" "a.mjs"` 被剥成 `C:\node.exe" "a.mjs`，命令直接废掉，
 *    而且**不报错、静默什么都不做**（退出码 0）。包一层外层引号可绕开该规则。
 * 2) **cwd 统一成反斜杠**：WSH 的 CurrentDirectory 按 Windows 路径理解，
 *    配置里通常是正斜杠（C:/…），不转的话在某些 cscript 版本上会被判为无效路径。
 *
 * 日志重定向也必须写在**外层引号之内**，否则 `>>` 会落到 cmd 的解析范围之外。
 */
export function buildSilentVbs({ title, cwd, command, logFile }) {
  const lines = [
    `' ${String(title ?? 'autostart').replace(/[\r\n]/g, ' ')}`,
    "' 由工作站边车生成；编码必须是 UTF-16LE + BOM，否则中文路径会乱码（见 autostart.mjs 注释）",
    'Dim shell, cmd',
    'Set shell = CreateObject("WScript.Shell")',
  ]
  if (cwd) {
    // Windows 路径用反斜杠；配置里写的是正斜杠
    lines.push(`shell.CurrentDirectory = ${vbsStr(String(cwd).replace(/\//g, '\\'))}`)
  }
  let inner = command
  if (logFile) {
    // 日志用追加，避免每次开机把上次的排错线索冲掉
    inner = `${command} >> ${vbsStr(logFile)} 2>&1`
  }
  const run = `cmd.exe /c ${vbsStr(inner)}`
  lines.push(`cmd = ${vbsStr(run)}`)
  lines.push('shell.Run cmd, 0, False') // 0 = 隐藏窗口
  return lines.join('\r\n') + '\r\n'
}

export { vbsStr }
