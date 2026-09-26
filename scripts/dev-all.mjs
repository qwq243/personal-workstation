/**
 * 一键启动：先起边车（后台），再起 Vite 开发服务器（前台）。
 * 用法：npm run dev:all
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPortOpen } from '../server/lib/net.mjs'
import { loadConfig } from '../server/config.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cfg = loadConfig()

const children = []

function launch(name, cmd, args, { color }) {
  const child = spawn(cmd, args, {
    cwd: root,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  const tag = `\x1b[${color}m[${name}]\x1b[0m `
  const pipe = (stream) => {
    let buf = ''
    stream.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (line.trim()) console.log(tag + line)
      }
    })
  }
  pipe(child.stdout)
  pipe(child.stderr)
  child.on('exit', (code) => {
    console.log(tag + `退出（code=${code}）`)
    shutdown()
  })
  return child
}

function shutdown() {
  for (const c of children) {
    try {
      c.kill()
    } catch {
      /* ignore */
    }
  }
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

console.log('启动工作站…\n')

// 边车
if (await isPortOpen(cfg.port)) {
  console.log(`\x1b[33m[边车]\x1b[0m 端口 ${cfg.port} 已在监听，跳过启动（可能已在运行）`)
} else {
  launch('边车', process.execPath, ['server/index.mjs'], { color: '36' })
}

// Vite
launch('前端', 'npx', ['vite'], { color: '35' })

console.log(`\n边车: http://127.0.0.1:${cfg.port}   前端: 见下方 Vite 输出\n`)
