/**
 * 网络 / 进程 / 命令相关的底层工具。全部只用 Node 内置模块，不引第三方依赖。
 */
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, exec, spawn } from 'node:child_process'

/* --------------------------------------------------------------- 探测 --- */

/** 端口是否有人监听（本机） */
export function isPortOpen(port, host = '127.0.0.1', timeout = 800) {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      sock.destroy()
      resolve(v)
    }
    sock.setTimeout(timeout)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
    sock.connect(port, host)
  })
}

/** 在 netstat 输出里找监听指定端口的 PID */
export function pidOnPort(port) {
  return new Promise((resolve) => {
    exec('netstat -ano -p tcp', { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(null)
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.includes(`:${port} `)) continue
        const parts = line.trim().split(/\s+/)
        // 形如: TCP  127.0.0.1:5278  0.0.0.0:0  LISTENING  60244
        if (parts.length >= 5 && parts[3] === 'LISTENING') {
          const pid = Number(parts[4])
          if (Number.isFinite(pid)) return resolve(pid)
        }
      }
      resolve(null)
    })
  })
}

/** 进程名是否在跑（用 tasklist 精确匹配） */
export function isProcessRunning(name, timeout = 4000) {
  return new Promise((resolve) => {
    exec(`tasklist /fi "IMAGENAME eq ${name}" /nh`, { windowsHide: true, timeout }, (err, stdout) => {
      if (err || !stdout) return resolve(false)
      resolve(stdout.toLowerCase().includes(name.toLowerCase()))
    })
  })
}

/** 取指定镜像名的所有 PID */
export function pidsOf(name) {
  return new Promise((resolve) => {
    exec(`tasklist /fi "IMAGENAME eq ${name}" /nh /fo csv`, { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve([])
      const out = []
      for (const line of stdout.split(/\r?\n/)) {
        const m = line.match(/^"([^"]+)","(\d+)"/)
        if (m && m[1].toLowerCase() === name.toLowerCase()) out.push(Number(m[2]))
      }
      resolve(out)
    })
  })
}

/* --------------------------------------------------------------- 请求 --- */

/**
 * 带超时的 fetch，返回 { ok, status, headers, text, json }。
 * 不抛异常，方便上层统一处理失败。
 */
export async function request(url, { method = 'GET', headers = {}, body, timeout = 15000, raw = false } = {}) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeout)
  try {
    const res = await fetch(url, {
      method,
      headers,
      // FormData（文件上传）必须原样交给 fetch：它自己带 multipart boundary，
      // 手动 stringify 或手动设 Content-Type 都会把请求体弄坏。
      body:
        body === undefined
          ? undefined
          : typeof body === 'string'
            ? body
            : typeof FormData !== 'undefined' && body instanceof FormData
              ? body
              : JSON.stringify(body),
      signal: ctl.signal,
    })
    const text = await res.text()
    let json
    if (!raw) {
      try {
        json = JSON.parse(text)
      } catch {
        json = undefined
      }
    }
    return { ok: res.ok, status: res.status, headers: res.headers, text, json }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      headers: new Headers(),
      text: '',
      json: undefined,
      error: err.name === 'AbortError' ? `请求超时(${timeout}ms)` : err.message,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 拉二进制（发音 MP3 等）。与 request() 分开，避免把音频当文本读坏。
 */
export async function requestBytes(url, { method = 'GET', headers = {}, timeout = 15000 } = {}) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeout)
  try {
    const res = await fetch(url, { method, headers, signal: ctl.signal })
    const buffer = Buffer.from(await res.arrayBuffer())
    return { ok: res.ok, status: res.status, headers: res.headers, buffer }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      headers: new Headers(),
      buffer: Buffer.alloc(0),
      error: err.name === 'AbortError' ? `请求超时(${timeout}ms)` : err.message,
    }
  } finally {
    clearTimeout(timer)
  }
}

export function readJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

/** 解析 .env 文件成对象（忽略注释与空行） */
export function parseEnvFile(file) {
  const out = {}
  try {
    const text = fs.readFileSync(file, 'utf8')
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const idx = line.indexOf('=')
      if (idx <= 0) continue
      const key = line.slice(0, idx).trim()
      let val = line.slice(idx + 1).trim()
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1)
      }
      out[key] = val
    }
  } catch {
    /* ignore */
  }
  return out
}

/** 隐藏窗口执行命令（用于启停后台服务），返回 { code, stdout, stderr } */
export function runHidden(command, { cwd, timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ code: err?.code ?? 0, stdout: stdout ?? '', stderr: stderr ?? '' })
      },
    )
  })
}

/** 隐藏窗口启动（不等待结束）——启动常驻服务用 */
export function spawnHidden(command, { cwd } = {}) {
  const child = exec(command, { cwd, windowsHide: true, detached: true })
  child.unref()
  return child.pid ?? null
}

/**
 * 可见窗口启动（不等待结束）——「可见启动」排查模式用。
 *
 * 为什么绕 PowerShell 的 Start-Process，而不是 node 直接 spawn：
 *  libuv 没有暴露 CREATE_NEW_CONSOLE，spawn(detached) 在 Windows 上只是新建进程组，
 *  子进程仍复用边车自己的控制台 —— 边车那次控制台若是隐藏的，启动出来的东西就永远看不见。
 *  Start-Process 会创建**独立的新控制台窗口**（-WindowStyle Normal），不受父进程控制台
 *  状态影响 —— 这是「可见」二字的唯一保证，实测用 cmd 的 `start` 做不到稳定可见。
 *
 * 脚本落成 UTF-8 **带 BOM** 的 .ps1 再走 -File：命令行里直接传中文路径会被 cmd 的代码页
 * 糟蹋（与提权脚本同一个坑、同一个解法），落文件才稳。
 * 落点用系统 temp + 进程 PID 命名，同一进程复用，不删也无害。
 *
 * stdio 必须是 'ignore'（所以用 spawn 而不是 exec）：exec 强制 pipe，子进程会继承
 * 那根管道的写端 —— 边车若跑在别人的管道下（dev-all.mjs 那种），子进程活着就会让
 * 上游一直读不到 EOF，表现为「父命令永不结束」。实测踩过。
 */
export function spawnVisible(filePath, { cwd, timeout = 20000 } = {}) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`
  const arg = cwd ? ` -WorkingDirectory ${q(cwd)}` : ''
  const script = `Start-Process -FilePath ${q(filePath)}${arg} -WindowStyle Normal\n`
  const psFile = path.join(os.tmpdir(), `ws-visible-launch-${process.pid}.ps1`)
  fs.writeFileSync(psFile, `\uFEFF${script}`, 'utf8')
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile],
    { detached: true, stdio: 'ignore', windowsHide: true },
  )
  child.unref()
  // spawn 失败（powershell 被安全软件拦、路径异常）是异步事件；不监听就会静默失败，
  // 用户只看到「点了启动没反应」。这里至少留下一条边车日志线索。
  child.on('error', (err) => {
    console.error(`[net] 可见启动点火失败：${err.message}（脚本 ${psFile}）`)
  })
  if (timeout > 0 && child.pid) {
    // powershell 只负责点火（Start-Process 立即返回），理论上秒退；兜底清掉卡死的
    const t = setTimeout(() => {
      try {
        process.kill(child.pid, 'SIGKILL')
      } catch {
        /* 已经退了 */
      }
    }, timeout)
    t.unref?.()
  }
  return child.pid ?? null
}

/** 结束进程（按 PID），返回是否成功 */
export function killPid(pid) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/F', '/T'], { windowsHide: true }, (err) => {
      resolve(!err)
    })
  })
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
