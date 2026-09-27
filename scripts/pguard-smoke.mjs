/**
 * 进程守护引擎的真机验证（演练模式，不改任何配置）。
 *
 * 为什么需要它：引擎的「判定」是安全关键逻辑 —— 它的三条闸门（白名单/受保护/名单）、
 * 预算与冷却、以及「什么时候不动手」都必须能一眼看到结论。这类逻辑单元测试证明不了
 * 真机上 700 个进程里到底选了谁，所以只能真机跑一遍看判定。
 *
 * 用法（边车在跑或不在跑都行，本脚本直接调库，不经过 HTTP）：
 *   node scripts/pguard-smoke.mjs            # 迁移状态 + 起引擎 + 跑两拍 + 打印判定
 *   node scripts/pguard-smoke.mjs --no-start # 只看现状，不启动引擎
 *
 * 它只读并且只在**演练模式**下跑；脚本结束会把引擎停掉。
 * 注意：它是**直接调库**的，所以「现状 / 起引擎」看的是**它自己这个进程里**的引擎；边车那个引擎
 * 在这脚本眼里永远是「没在跑」—— 要看边车那个，去面板或打 /api/pguard/status。
 * 真要看它动手，去面板上关演练（会拦一次确认）。
 */
import {
  configPath,
  engineConfig,
  journal,
  processTable,
  start,
  status,
  stop,
} from '../server/lib/pguard.mjs'

const noStart = process.argv.includes('--no-start')

const s0 = await status()
console.log('=== 现状 ===')
console.log(`引擎：${s0.running ? (s0.paused ? '在跑（判定暂停）' : '在跑') : '没在跑'} · ${s0.dryRun ? '演练模式' : '⚠ 真实执行'}`)
const cfg = engineConfig({ force: true })
console.log(
  `阈值：整机 CPU ≥${cfg.cpuGuard.triggerPercent}% 持续 ${cfg.cpuGuard.triggerSustainSeconds}s；` +
    `单进程 ≥${cfg.cpuGuard.processThresholdPercent}% 持续 ${cfg.cpuGuard.processSustainSeconds}s；` +
    `动作 ${cfg.cpuGuard.action}（演练=${cfg.dryRun ? '是' : '否'}）`,
)
console.log(
  `名单：白名单 ${cfg.whitelist.length} · 黑名单 ${cfg.blacklist.entries.length} · ` +
    `受保护 ${cfg.protection.immutableProcessNames.length} · 开发工具 ${cfg.devReclaim.processNames.length}`,
)

if (!noStart) {
  console.log('\n=== 起引擎（演练，跑两拍）===')
  console.log(JSON.stringify(start()))
  await new Promise((r) => setTimeout(r, 5000))
  const t = await status()
  console.log(`采样：CPU ${t.cpuPercent ?? '—'}% · 可用内存 ${t.memFreePercent ?? '—'}% · 进程 ${t.procCount ?? '—'}`)
  console.log(`上膛：${t.armed ? '是' : '否'}`)
  for (const n of t.lastTick?.notes ?? []) console.log(`  上一拍：${n}`)
  for (const d of (t.lastTick?.decisions ?? []).slice(0, 10)) {
    console.log(`  [${d.rule}] ${d.name} (${d.pid}) → ${d.verdict}${d.detail ? ` · ${d.detail}` : ''}`)
  }
  stop({ reason: '冒烟脚本结束' })
}

console.log('\n=== 审计（最近 8 条）===')
const j = journal({ limit: 8 })
if (!j.items.length) console.log('  （空 —— 规则没命中过，或都在演练里没写）')
for (const r of j.items) {
  console.log(`  ${new Date(r.at).toLocaleString('zh-CN')} [${r.outcomeText}] ${r.rule} ${r.name || '—'} (${r.pid}) ${r.detail}`)
}

console.log('\n=== 进程表（前 10，含保护判定）===')
const pt = await processTable({ limit: 10 })
if (!pt.ok) console.log(`  采样失败：${pt.error}`)
else {
  console.log(`  采样 ${pt.processes} 个进程；内存已用 ${pt.memUsedPercent}%`)
  for (const r of pt.rows ?? []) {
    console.log(
      `  ${r.name} (${r.pid}) cpu ${r.cpu}% ws ${Math.round(r.ws / 1024 / 1024)}MB ` +
        `dev=${r.devTool ? 'Y' : '-'} ${r.protected ? `保护：${r.protected}` : ''}`,
    )
  }
}
