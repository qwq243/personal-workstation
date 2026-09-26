/**
 * 模型用量缓存 + 两级定时同步：
 * 它本地两级刷新（轻 8s / 全量 45s）+ localStorage 缓存，打开永远先画缓存不等待。
 * 工作站这边是服务端版：内存 + 落盘缓存、后台定时同步，页面打开时 0 个 NewAPI 请求。
 *
 * 解决的问题：用量页此前每次打开都现拉 NewAPI（余额 1 + 令牌 1 + 按密钥 stat N + 日志 2），
 * 公网往返慢，「卡一会才展示」就是这么来的。现在打开页面直接回缓存（启动还会预热），
 * 手动刷新或定时器才真正出网。
 *
 * 两级频率（环境变量可调，学习插件 8s/45s 但取保守值 —— 这里一份缓存多个页面共用）：
 *  - live（USAGE_LIVE_SEC，默认 60s）：余额 / 当日总额 / 消费·失败计数 / 两类日志，约 6 个请求
 *  - full（USAGE_FULL_SEC，默认 300s）：另加密钥列表 / 按密钥花费 / 官方聚合看板，约 3+N 个请求
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../config.mjs'
import * as newapi from './newapi.mjs'

function dataDir() {
  return process.env.WS_DATA_DIR || loadConfig().dataDir
}
const FILE = () => path.join(dataDir(), 'newapi-cache.json')

export const LIVE_SEC = Math.max(15, Number(process.env.USAGE_LIVE_SEC) || 60)
export const FULL_SEC = Math.max(LIVE_SEC, Number(process.env.USAGE_FULL_SEC) || 300)

let mem = null
let liveBusy = false
let fullBusy = false

const emptySlot = () => ({ updatedAt: 0, data: null })

function saveDisk() {
  if (!mem) return
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true })
    const tmp = `${FILE()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(mem))
    fs.renameSync(tmp, FILE())
  } catch {
    /* 缓存落盘失败不影响服务，下次启动重新拉 */
  }
}

function loadDisk() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'))
    if (raw && raw.version === 1) mem = raw
  } catch {
    mem = null
  }
}

/** 把 /api/data/self 的行聚合出：24 小时花费、按模型分布、缓存命中总量。
 *  quota 整数累加最后再换算成元，避免浮点连加的尾差。 */
function aggregateSeries(rows) {
  const hourly = Array.from({ length: 24 }, (_, h) => ({ h, quota: 0, count: 0 }))
  const models = new Map()
  let promptAll = 0
  let cacheAll = 0
  for (const row of rows ?? []) {
    const quota = Number(row?.quota) || 0
    const count = Number(row?.count) || 0
    const prompt = Number(row?.prompt_tokens) || 0
    const cache = Number(row?.cache_tokens) || 0
    const h = new Date((Number(row?.created_at) || 0) * 1000).getHours()
    if (hourly[h]) {
      hourly[h].quota += quota
      hourly[h].count += count
    }
    const name = row?.model_name || '未知模型'
    const cur = models.get(name) ?? { model: name, quota: 0, count: 0, prompt: 0, cache: 0 }
    cur.quota += quota
    cur.count += count
    cur.prompt += prompt
    cur.cache += cache
    models.set(name, cur)
    promptAll += prompt
    cacheAll += cache
  }
  return {
    ok: true,
    hourly: hourly.map((b) => ({ h: b.h, yuan: newapi.quotaToYuan(b.quota), count: b.count })),
    byModel: [...models.values()]
      .map((m) => ({ ...m, yuan: newapi.quotaToYuan(m.quota) }))
      .sort((a, b) => b.quota - a.quota),
    cacheTotal: {
      prompt: promptAll,
      cache: cacheAll,
      pct: promptAll > 0 ? Math.round((cacheAll / promptAll) * 1000) / 10 : null,
    },
  }
}

/** 轻同步：余额 / 当日总额 / 消费·失败计数 / 两类日志（约 6 个请求，全部并发） */
export async function refreshLive() {
  if (liveBusy) return
  liveBusy = true
  try {
    const [balance, todayStat, consumeCount, failCount, logs] = await Promise.all([
      newapi.balance(),
      newapi.todayStat(),
      newapi.logCount(2),
      newapi.logCount(5),
      newapi.recentLogsTyped({ pageSize: 50 }),
    ])
    mem = mem ?? { version: 1, live: emptySlot(), full: emptySlot() }
    mem.live = { updatedAt: Date.now(), data: { balance, todayStat, consumeCount, failCount, logs } }
    saveDisk()
  } finally {
    liveBusy = false
  }
}

/** 全量同步：另加密钥列表 / 按密钥今日花费 / 官方聚合看板（约 3+N 个请求，N=密钥数） */
export async function refreshFull() {
  if (fullBusy) return
  fullBusy = true
  try {
    const [tokens, byToken, series] = await Promise.all([
      newapi.tokens(),
      newapi.todaySpendByToken(),
      newapi.usageSeries(),
    ])
    mem = mem ?? { version: 1, live: emptySlot(), full: emptySlot() }
    mem.full = {
      updatedAt: Date.now(),
      data: {
        tokens,
        byToken: byToken.ok ? byToken : { ok: false, error: byToken.error },
        series: series.ok ? aggregateSeries(series.rows) : { ok: false, error: series.error },
      },
    }
    saveDisk()
  } finally {
    fullBusy = false
  }
}

/**
 * 页面取数入口：永远立即回缓存；refresh=true（手动刷新）时同步等一轮轻同步，
 * full 缺失时补一轮全量 —— 页面再慢也就是几秒，且日常打开是 0 等待。
 */
export async function snapshot({ refresh = false } = {}) {
  if (refresh || !mem) {
    try {
      await refreshLive()
    } catch {}
    if (refresh || !mem?.full?.data) {
      try {
        await refreshFull()
      } catch {}
    }
  }
  const l = mem?.live ?? emptySlot()
  const f = mem?.full ?? emptySlot()
  return {
    ok: !!(l.data || f.data),
    liveSec: LIVE_SEC,
    fullSec: FULL_SEC,
    liveAt: l.updatedAt,
    fullAt: f.updatedAt,
    live: l.data,
    full: f.data,
  }
}

/** 启动时调用：读落盘缓存（页面立即可渲染）→ 起两级定时器 → 立即补一轮同步 */
export function startSync() {
  loadDisk()
  let tick = 0
  const every = Math.max(1, Math.round(FULL_SEC / LIVE_SEC))
  const timer = setInterval(() => {
    tick += 1
    const run = tick % every === 0 ? refreshFull() : refreshLive()
    run.catch((e) => console.log(`[usage] 同步失败(${tick % every === 0 ? 'full' : 'live'}):`, e?.message || e))
  }, LIVE_SEC * 1000)
  timer.unref?.()
  refreshLive().catch((e) => console.log('[usage] 启动轻同步失败:', e?.message || e))
  if (!mem?.full?.data) refreshFull().catch((e) => console.log('[usage] 启动全量同步失败:', e?.message || e))
}
