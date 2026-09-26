/**
 * 把 raw/*.pdf 批量送 MinerU 云端 OCR，markdown 落到 parsed/。
 * 这是句库管线的第一步，第二步是 scripts/english-daily-build.mjs（parsed/*.md → sentences.json）。
 *
 *   node scripts/english-daily-parse.mjs   # 新增/缺失的 PDF 才会上传（parsed/ 里有缓存就跳过）
 *   node scripts/english-daily-build.mjs   # 重新编译句库
 *
 * 说明：
 *   - 走的是边车的 MinerU 配置（server/config.json 的 docparse.mineru + credentials.json 的令牌），
 *     **文件会上传 mineru.net**；PDF 无文本层，必须 is_ocr。
 *   - parsed/ 里的 .md 是缓存：不要手工改，重跑 build 别重跑 parse 就不会重复花云端额度。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFile } from '../server/lib/wiki-cloud.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIR = path.join(ROOT, 'server', 'data', 'english', 'daily-sentence')
const RAW = path.join(DIR, 'raw')
const OUT = path.join(DIR, 'parsed')

fs.mkdirSync(OUT, { recursive: true })
const files = fs.readdirSync(RAW).filter((f) => f.toLowerCase().endsWith('.pdf')).sort()
console.log('queue:', files.length)
let done = 0
let failed = 0
for (const f of files) {
  const cache = path.join(OUT, f.replace(/\.pdf$/i, '.md'))
  if (fs.existsSync(cache) && fs.statSync(cache).size > 1000) {
    console.log('SKIP', f)
    continue
  }
  console.log('=== parse', f, new Date().toISOString())
  const r = await parseFile(path.join(RAW, f), { isOcr: true, language: 'ch' })
  if (!r.ok) {
    console.log('FAILED', f, r.error)
    failed += 1
    continue
  }
  fs.writeFileSync(cache, r.markdown)
  done += 1
  console.log('OK', f, 'bytes', r.markdown.length)
}
console.log(`ALL DONE ok=${done} failed=${failed}`)
if (failed) process.exit(1)
