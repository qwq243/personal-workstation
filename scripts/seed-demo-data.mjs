#!/usr/bin/env node
/**
 * 写入一份**示例数据**，让刚 clone 下来的仓库「有东西可看」。
 *
 *   node scripts/seed-demo-data.mjs            写入示例（日期按「今天」推算，不会过期）
 *   node scripts/seed-demo-data.mjs --reset    清回空结构
 *   node scripts/seed-demo-data.mjs --force    非空时也覆盖（默认拒绝，怕冲掉你自己的数据）
 *
 * 只碰两个文件：dashboard.json（每日看板）与 plan.json（规划台）。
 * 走的是**真实模块**（server/lib/dashboard.mjs / plan.mjs）而不是自己拼 JSON ——
 * 这样示例数据的结构与程序写出来的一模一样，也不会绕过原子写 / .bak / 每日快照那套保护。
 *
 * 换真实数据：直接在页面上写就行；想清空就 `--reset`，或者把这两个文件删掉
 * （程序发现文件不存在会用空结构）。
 */
import fs from 'node:fs'
import path from 'node:path'

// dataDir() 是数据目录的**唯一入口**：它认 WS_DATA_DIR（测试用），再回落到 config.json。
// 别自己读 loadConfig().dataDir —— 那样「打印出来的路径」与「真正写进去的路径」在设了
// WS_DATA_DIR 时会不一致（这个脚本第一版就是这么错的，所以这里留一条注释）。
import { dataDir } from '../server/config.mjs'
import * as dashboard from '../server/lib/dashboard.mjs'
import * as plan from '../server/lib/plan.mjs'

const argv = new Set(process.argv.slice(2))
const FORCE = argv.has('--force')
const RESET = argv.has('--reset')

const DIR = dataDir()
const dashFile = path.join(DIR, 'dashboard.json')
const planFile = path.join(DIR, 'plan.json')

/* ------------------------------------------------------------ 小工具 --- */

/** 本地日历日（不用 toISOString —— 那按 UTC 切，晚上会算成第二天） */
function dayStr(offset = 0) {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function fileHasContent(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (Array.isArray(j)) return j.length > 0
    if (Array.isArray(j.days)) return j.days.length > 0
    if (j.days && typeof j.days === 'object') return Object.keys(j.days).length > 0
    for (const k of ['exams', 'projects', 'prep']) if (Array.isArray(j[k]) && j[k].length) return true
    return false
  } catch {
    return false
  }
}

if (!RESET) {
  const busy = [dashFile, planFile].filter((f) => fs.existsSync(f) && fileHasContent(f))
  if (busy.length && !FORCE) {
    console.error(
      '这两个文件里已经有数据，拒绝覆盖（怕冲掉你自己的记录）：\n' +
        busy.map((f) => `  · ${f}`).join('\n') +
        '\n\n要覆盖加 --force；想清空用 --reset。',
    )
    process.exit(1)
  }
}

/* ---------------------------------------------------------------- 看板 --- */

if (RESET) {
  dashboard.writeDashboard({ version: 2, days: {}, updatedAt: 0 })
  console.log('看板已清回空结构')
} else {
  // 近 7 天：几条计划（有的已勾）、一点随手记、一天写了复盘与心情
  const demo = [
    { off: -6, plans: [['把项目 README 写完', true]], notes: ['先把「能跑起来」这一步写清楚，别一上来讲架构。'] },
    { off: -5, plans: [['整理上周的笔记', true], ['列本周待办', true]], notes: [] },
    { off: -3, plans: [['读一章书', true], ['背 30 个词', false]], notes: ['背词还是得做题，光看没用。'], mood: 3, moodNote: '有点累' },
    {
      off: -1,
      plans: [['把看板的卡片排版调一调', true], ['跑步 30 分钟', true]],
      notes: ['今天效率还行，主要时间花在收尾。'],
      mood: 4,
      done: '今天把看板收了个尾：卡片排版调好，顺手把示例数据也补上了。\n明天先把词单那部分过一遍。',
      tomorrow: '过一遍词单页；把示例校历换成自己学校的。',
    },
    { off: 0, plans: [['过一遍词单页', false], ['改 docs 里的错别字', false]], notes: ['示例数据可以在「设置与数据」里清掉。'] },
  ]

  for (const d of demo) {
    const date = dayStr(d.off)
    const plans = (d.plans ?? []).map(([text, done]) => ({ text, done }))
    const notes = (d.notes ?? []).map((text) => ({ text }))
    dashboard.patchDay(date, {
      plans: [],
      notes: [],
    })
    for (const p of plans) dashboard.addPlan(date, p.text, { source: 'demo', done: p.done })
    for (const n of notes) dashboard.addNote(date, n.text, { source: 'demo' })
    dashboard.patchDay(date, {
      ...(typeof d.mood === 'number' ? { mood: d.mood } : {}),
      ...(d.moodNote ? { moodNote: d.moodNote } : {}),
      ...(d.done ? { done: d.done } : {}),
      ...(d.tomorrow ? { tomorrow: d.tomorrow } : {}),
    })
  }
  console.log(`看板示例已写入（近 7 天里的 5 天，含 1 条复盘）；连续记录天数：${dashboard.streak()} 天`)
}

/* -------------------------------------------------------------- 规划台 --- */

if (RESET) {
  plan.save({ exams: [], projects: [], prep: [] }, { source: 'demo-reset' })
  console.log('规划台已清回空结构')
} else {
  const r = plan.save(
    {
      exams: [
        {
          id: 'demo-exam',
          name: '示例考试（请改成你自己的）',
          date: dayStr(45),
          time: '09:00',
          kind: 'exam',
          pinned: true,
          official: true,
          prepId: 'demo-prep',
          note: '这条是示例数据：45 天后的一个考试。改成你自己的日期与名称即可。',
          source: 'scripts/seed-demo-data.mjs',
        },
        {
          id: 'demo-deadline',
          name: '示例报名截止',
          date: dayStr(7),
          time: '17:00',
          kind: 'deadline',
          official: false,
          note: '一周后的截止日 —— 让它出现在「临近」里，好看出倒计时的效果。',
          source: 'scripts/seed-demo-data.mjs',
        },
      ],
      projects: [
        {
          id: 'demo-proj-1',
          name: '示例项目：把工作站跑起来',
          priority: 'P1',
          status: 'active',
          deadline: dayStr(14),
          progress: 60,
          stage: '联调',
          note: '示例数据。这条项目的「下一步」里有已勾和未勾的，用来演示进度条。',
          source: 'scripts/seed-demo-data.mjs',
          next: [
            { id: 's1', text: 'clone 下来，npm install', done: true },
            { id: 's2', text: 'npm run build && npm run server', done: true },
            { id: 's3', text: '在「设置与数据」里填模型端点与密钥', done: false },
            { id: 's4', text: '把示例校历换成自己学校的（docs/校历格式.md）', done: false },
          ],
        },
        {
          id: 'demo-proj-2',
          name: '示例项目：接自己的数据源',
          priority: 'P2',
          status: 'planning',
          deadline: '',
          progress: 0,
          stage: '想清楚要接什么',
          note: '看板只是容器：后端往 /api/overview 加一节，前端加一张卡。见 docs/architecture.md。',
          source: 'scripts/seed-demo-data.mjs',
          next: [
            { id: 's1', text: '列一下自己每天真正会看的数据', done: false },
            { id: 's2', text: '照 DevGuideView 的三步加一个模块', done: false },
          ],
        },
      ],
      prep: [
        {
          id: 'demo-prep',
          name: '示例备考（英语）',
          examId: 'demo-exam',
          stage: '打基础',
          note: '示例数据。备考清单可以挂到上面那条考试上，规划台里会一起显示进度。',
          source: 'scripts/seed-demo-data.mjs',
          items: [
            { id: 's1', text: '每天 30 个新词', done: true },
            { id: 's2', text: '每天一篇阅读', done: true },
            { id: 's3', text: '每周末写一篇作文', done: false },
            { id: 's4', text: '考前两周开始模考', done: false },
          ],
        },
      ],
    },
    { source: 'demo' },
  )
  const prep = r.prep?.[0]
  console.log(
    `规划台示例已写入：${r.exams.length} 个关键日期 · ${r.projects.length} 个项目 · ` +
      `${r.prep.length} 份备考清单（清单进度 ${prep ? `${prep.done}/${prep.total}` : '—'}）`,
  )
}

console.log('\n数据目录：' + DIR)
console.log('清空示例：node scripts/seed-demo-data.mjs --reset')
