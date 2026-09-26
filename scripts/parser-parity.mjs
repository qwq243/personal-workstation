/**
 * 解析器对拍：前端 src/features/vocab/parser.ts  vs  服务端 server/lib/vocab.mjs
 *
 * 为什么需要这个脚本：词条解析有两份实现（前端跑在浏览器、边车跑在 Node，项目不共享构建产物），
 * 两边一旦不一致，就会出现「网页粘贴能认、智能体录入认不出」这类莫名其妙的差异。
 * 改任何一份解析器之后，跑一遍这个脚本再提交。
 *
 * 用法（Node 22 起支持直接类型剥离运行 TS）：
 *   node --experimental-strip-types scripts/parser-parity.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fe = await import(pathToFileURL(path.join(ROOT, 'src/features/vocab/parser.ts')).href)
const be = await import(pathToFileURL(path.join(ROOT, 'server/lib/vocab.mjs')).href)

/** 仓库根目录下的真实词单文件（单词导入-*.txt），有就拿来做真实数据用例 */
function realWordFiles() {
  try {
    return readdirSync(ROOT)
      .filter((f) => /^单词导入-.*\.txt$/.test(f))
      .map((f) => [f, readFileSync(path.join(ROOT, f), 'utf8')])
  } catch {
    return []
  }
}

const cases = [
  ...realWordFiles(),
  ['注释行', '# 今天新增\n// 这条也跳过\nconceal 隐藏'],
  ['markdown 列表符号', '- brandnew 全新的\n* spare 腾出；备用\n• aviator 飞行员'],
  ['编号与括号', '1. conceal 隐藏\n2) motto 座右铭\n(3) vary 变化'],
  ['无中文的短语（关键）', 'appeal to sb\ndo away with sth'],
  ['无中文 + 显式分隔符', 'conceal - 隐藏\ndrag — 拖，拽\nmotto:: 座右铭'],
  ['管道分隔', 'conceal | 隐藏 | She could not conceal her disappointment.'],
  ['Tab 分隔', 'conceal\t隐藏，隐瞒\tShe concealed it.'],
  ['音标 + 词性', '1. conceal /kənˈsiːl/ v. 隐藏，隐瞒'],
  ['一行多词性', 'fair adj. 公平的 n. 集市；博览会'],
  ['词尾词性（不带点）', 'distinguished adj'],
  ['释义尾巴带例句', 'conceal 隐藏 She could not conceal her disappointment.'],
  ['空行与重复', 'conceal 隐藏\n\n\nconceal 隐藏（重复应跳过）\nadore 热爱'],
]

const norm = (list) =>
  list.map((w) => ({
    term: w.term,
    phonetic: w.phonetic ?? '',
    pos: w.pos ?? '',
    meaning: w.meaning,
    example: w.example ?? '',
  }))

let pass = 0
let fail = 0
for (const [name, text] of cases) {
  const A = norm(fe.parseWordText(text).words)
  const B = norm(be.parseWordText(text).words)
  if (JSON.stringify(A) === JSON.stringify(B)) {
    pass += 1
    console.log(`[一致] ${name}（${A.length} 条）${A.length ? ` 例：${JSON.stringify(A[0])}` : ''}`)
  } else {
    fail += 1
    console.log(`[不一致] ${name}`)
    console.log('   前端  :', JSON.stringify(A))
    console.log('   服务端:', JSON.stringify(B))
  }
}

console.log(`\n解析器对拍：一致 ${pass} / 不一致 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
