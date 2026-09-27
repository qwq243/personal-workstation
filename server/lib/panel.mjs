/**
 * 「工作站自己」的服务面：开机自启位。
 *
 * 为什么单独一个模块：工作站的启停不该由工作站自己实现（进程都退了没法响应），
 * 所以开机自启靠启动文件夹里的一个 VBS —— 这条 VBS 由这里生成与开关，
 * 面板里能看状态、能一键开关，不用再去翻启动文件夹。
 *
 * 关键：**VBS 里的 node 路径一律取 process.execPath**（就是当前跑边车的那个 node），
 * 不写死 —— 发现它指向别的 node，体检里就提示重建那条自启项。
 *
 * 另一个坑见 autostart.mjs 顶部：VBS 必须 UTF-16LE + BOM，否则中文路径乱码。
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, ROOT_DIR } from '../config.mjs'
import * as autostart from './autostart.mjs'
import { isPortOpen, pidOnPort } from './net.mjs'

/** 启动文件夹里那条自启项（.lnk）的文件名 —— 任务管理器「启动应用」显示的就是它 */
function entryName() {
  return loadConfig().workstation?.autostartEntry ?? 'Workstation.lnk'
}

/** 自启脚本本体的文件名：与自启项同名，但放仓库 scripts/ 下、后缀 .vbs */
function scriptName() {
  return `${path.basename(entryName()).replace(/\.lnk$/i, '')}.vbs`
}

/**
 * 自启脚本本体的绝对路径。
 *
 * 为什么不放启动文件夹：Windows 的安全策略禁止在启动文件夹新建 .vbs / .cmd，只放行 .lnk
 * （详见 autostart.writeShortcut 的注释）。所以启动文件夹放快捷方式，脚本本体在仓库里。
 */
function scriptPath() {
  return path.join(ROOT_DIR, 'scripts', scriptName())
}

/** 边车入口脚本（相对仓库根） */
function entryScript() {
  return path.join(ROOT_DIR, 'server', 'index.mjs')
}

function logPath() {
  const rel = loadConfig().workstation?.autostartLog ?? 'logs/sidecar-autostart.log'
  return path.join(ROOT_DIR, rel)
}

/**
 * 解码成「wscript 实际会看到的文本」。
 *
 * wscript 的规则：有 UTF-16LE BOM 就按 UTF-16 读，否则按系统 ANSI（中文 Windows 常见 936/GBK）读。
 * 所以判断「这条 VBS 能不能用」必须按这个口径解码后再看路径，而不是看文件是不是 UTF-8
 * —— 按 ANSI（GBK）存是能正常工作的。
 * （UTF-8 无 BOM 才是真坏的：会被当 GBK 解开、中文全乱，见 autostart.mjs 的编码表。）
 */
function decodeAsWscript(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.slice(2).toString('utf16le'), encoding: 'utf16le' }
  }
  try {
    return { text: new TextDecoder('gbk').decode(buf), encoding: 'gbk' }
  } catch {
    return { text: buf.toString('latin1'), encoding: 'unknown' }
  }
}

/**
 * 自启位现状 + 体检。
 *
 * 体检分两级：
 *   - problems（真会导致开机起不来）：引用的程序不在、没指向当前边车入口
 *   - warnings（现在能用但脆弱）：用的是别的 node（某个工具自带的那个，
 *     随它升级就会消失）
 * 判据是**按 wscript 的解码口径读出路径后实际去 existsSync**，不是猜编码。
 */
export function status() {
  const name = entryName()
  const st = autostart.state(name)
  const sp = scriptPath()
  const info = {
    ...st,
    entryName: name,
    scriptFile: sp,
    scriptExists: false,
    running: true,
    pid: process.pid,
    nodePath: process.execPath,
    nodeVersion: process.version,
    entry: entryScript(),
    logFile: logPath(),
  }
  if (!st.active) {
    return {
      ok: true,
      ...info,
      healthy: false,
      encoding: null,
      problems: [st.disabled ? '自启位已关闭（快捷方式被改名为 .disabled）' : '还没有创建自启位'],
      warnings: [],
    }
  }

  // 体检的是**脚本本体**（仓库 scripts/ 下那个 .vbs），不是启动文件夹里的 .lnk ——
  // .lnk 是二进制，按文本读出来只会得到一堆噪声
  let buf
  try {
    buf = fs.readFileSync(sp)
    info.scriptExists = true
  } catch (err) {
    return {
      ok: true,
      ...info,
      healthy: false,
      encoding: null,
      problems: [
        `自启项在，但脚本本体读不到：${sp}（${err.message}）。点「重建」会重写脚本与这条快捷方式`,
      ],
      warnings: [],
    }
  }
  const { text, encoding } = decodeAsWscript(buf)

  const problems = []
  const warnings = []

  // 引用的可执行文件必须存在
  const exes = [...text.matchAll(/"([^"]*\.exe)"/gi)].map((m) => m[1])
  const missing = exes.filter((p) => {
    try {
      return !fs.existsSync(p)
    } catch {
      return true
    }
  })
  if (missing.length) problems.push(`VBS 里的程序不存在：${missing.join('、')}`)

  // 必须指向当前这份边车入口
  const expectedEntry = entryScript()
  if (!text.includes(expectedEntry)) {
    const m = text.match(/"([^"]*index\.mjs)"/i)
    problems.push(
      m
        ? `VBS 指向的入口不是当前这份：${m[1]}（当前：${expectedEntry}）`
        : `VBS 里找不到边车入口（当前应为：${expectedEntry}）`,
    )
  }

  // 用的 node 不是当前这个 → 现在能跑但脆弱
  const expectedNode = process.execPath
  if (exes.length && !exes.some((p) => p.toLowerCase() === expectedNode.toLowerCase())) {
    const other = exes.find((p) => /node\.exe$/i.test(p))
    if (other) {
      warnings.push(
        `用的是别的 node：${other}。建议重建这条自启项（当前这份边车用的是 ${expectedNode}）；` +
          `别的 node 路径随它的安装方式变化可能消失，届时开机就起不来了`,
      )
    }
  }

  return {
    ok: true,
    ...info,
    encoding,
    exes,
    healthy: problems.length === 0,
    problems,
    warnings,
    content: text,
  }
}

/**
 * 生成（或修复）自启位：重写脚本本体 + 重建启动文件夹里的快捷方式。
 *
 * 两步都是必要的 —— 快捷方式指向脚本本体，只修一个都可能仍然起不来。
 * 这里同时把编码问题一起解决：内容一律按 UTF-16LE + BOM 写。
 */
export async function enable() {
  const log = logPath()
  try {
    fs.mkdirSync(path.dirname(log), { recursive: true })
  } catch {
    /* 日志目录建不出来不阻断自启 */
  }
  const content = autostart.buildSilentVbs({
    title: 'Workstation 静默自启',
    cwd: ROOT_DIR,
    command: `"${process.execPath}" "${entryScript()}"`,
    logFile: log,
  })
  // 1) 脚本本体放仓库 scripts/（启动文件夹不让新建 .vbs，见 autostart.writeShortcut 注释）
  const script = autostart.writeVbsAt(path.dirname(scriptPath()), scriptName(), content)
  if (!script.ok) return { ...script, ...status() }
  // 2) 启动文件夹里放一条指过去的快捷方式（名字就是任务管理器里看到的那个）
  const link = await autostart.writeShortcut(entryName(), {
    target: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe'),
    args: `"${scriptPath()}"`,
    workdir: ROOT_DIR,
    description: 'Workstation',
  })
  return { ...link, ...status() }
}

/** 关闭自启位（快捷方式改成 .disabled，文件留着便于随时开回来） */
export function disable() {
  return autostart.setEnabled(entryName(), false)
}

/** 删除自启位 */
export function remove() {
  return autostart.remove(entryName())
}

/** 边车自身状态（端口/PID）—— 和其它状态卡片同一口径 */
export async function sidecarStatus() {
  const cfg = loadConfig()
  const port = Number(cfg.port || 5278)
  return {
    ok: true,
    port,
    pid: process.pid,
    running: await isPortOpen(port),
    listeningPid: await pidOnPort(port),
    nodePath: process.execPath,
    nodeVersion: process.version,
    rootDir: ROOT_DIR,
    configPath: path.join(ROOT_DIR, 'server', 'config.json'),
  }
}
