/**
 * 生产式启动：构建前端（可选）后只跑边车，由边车同时提供页面与 API。
 * 用法：npm run start          （用已有 dist）
 *       npm run start -- --build  （先构建再启动）
 */
import { spawnSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../server/config.mjs'
import { isPortOpen } from '../server/lib/net.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cfg = loadConfig()
const wantBuild = process.argv.includes('--build')

if (wantBuild || !fs.existsSync(path.join(root, 'dist', 'index.html'))) {
  console.log('构建前端…')
  const r = spawnSync('npx', ['vite', 'build'], { cwd: root, shell: true, stdio: 'inherit' })
  if (r.status !== 0) {
    console.error('构建失败，已中止。')
    process.exit(r.status ?? 1)
  }
}

if (await isPortOpen(cfg.port)) {
  const health = await fetch(`http://127.0.0.1:${cfg.port}/api/health`).then((r) => r.ok).catch(() => false)
  if (health) {
    console.log(`端口 ${cfg.port} 已在服务：http://127.0.0.1:${cfg.port}/`)
    process.exit(0)
  }
  console.log(`端口 ${cfg.port} 被占用但健康检查失败，仍尝试启动（若失败请先关掉旧进程）。`)
}

const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 0))
process.on('SIGINT', () => child.kill())

console.log(`\n工作站已启动： http://127.0.0.1:${cfg.port}/\n（关掉这个窗口即停止服务）\n`)
