/**
 * WorkBuddy 活动管理 —— 六类排程任务的开关、手动执行与「逐账号执行明细」日志。
 *
 * 与 workbuddy-ops.mjs 的分工：那边是账号池 / 登录 / 配置 / 测聊；
 * 这里只做「活动」这件事：任务表、跑一次、把结果记成可读的日志。
 *
 * ## 为什么要一份日志，而不只是「本次运行的任务」
 * 原来那一版只有进程内的任务列表：边车一重启就清空，而且只有「成功 10 · 失败 2」的汇总，
 * 看不出「哪个号领了多少分、做成了哪几档」。网关自己的排程（9/21 点签到、10 点活跃、
 * 12 点开学季、01 点夜猫子、22 点保活）更是完全看不见 —— 它只往 stderr 打日志。
 * 于是本模块把两路合流：
 *   ① 本页手动跑的任务（CLI 输出 → 解析 → 逐账号条目）；
 *   ② 网关自己的排程（读 data/server.err.log 的逐账号行 → 条目）。
 * 按事件 id 去重后落盘（server/data/workbuddy-activity.json），边车重启也不丢。
 *
 * ## 逐账号明细哪里来、哪里没有
 * - 本页跑的任务：CLI 的 stdout/stderr 全在我们手里（signin 的表格、activity/travel/keepalive
 *   的逐账号日志行、两个 Python 脚本的逐账号行），跑前跑后再各查一次积分，增量就能对出来。
 * - 网关排程：签到只打汇总行（`checkin done: total=…`），开学季/夜猫子只打一行 `school: ok`
 *   —— 脚本 stdout 被 Go 的 exec 丢弃了，逐账号明细**不在日志里**。这时如实记一条汇总条目
 *   并标注「网关排程」，不编账号名。
 *
 * ## 积分增量怎么来的
 * credit.exe 是只读查询（不写任何文件），跑前跑后各查一次就得到每个号 remain 的变化。
 * 中间若有对话在消耗积分，增量会偏小 —— 所以条目里同时给 before → after，
 * 让人一眼看出这是「余额变化」而不是官方口径的「本次奖励」。
 *
 * 同一笔增量会写成三层：逐账号一行、该任务的「全体账号」汇总、一键完成再把六步汇总加总。
 * 页眉合计只加逐账号那一层（account !== '全体账号'），否则一笔签到会被算进三次。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { loadConfig } from '../config.mjs'
import { runHidden } from './net.mjs'
import * as wb from './workbuddy.mjs'

/* ========================================================== 任务登记表 === */

/**
 * 六类排程任务 —— 与网关 config.json 的 schedule.* 一一对应。
 * `hint` 照网关启动时自己打的那句括号注释写，不另编。
 */
export const TASKS = [
  {
    id: 'checkin',
    label: '每日签到',
    hint: '定时签到 + 余额解冻',
    enabledKey: 'checkin_enabled',
    hoursKey: 'checkin_hours',
    credits: true, // 会发积分 → 跑前后各查一次积分算增量
  },
  {
    id: 'activity',
    label: '活跃上报',
    hint: '点亮连登 + 连登奖励',
    enabledKey: 'activity_enabled',
    hoursKey: 'activity_hours',
    credits: true,
  },
  {
    id: 'travel',
    label: '猫猫旅行',
    hint: '领养 / 派出 / 到站领奖',
    enabledKey: 'travel_enabled',
    hoursKey: 'travel_hours',
    credits: true,
  },
  {
    id: 'keepalive',
    label: 'Token 保活',
    hint: '定时刷新凭证防过期',
    enabledKey: 'keepalive_enabled',
    hoursKey: 'keepalive_hours',
    logItems: 'summary', // 刷新成功不打日志，逐账号行没东西可看
    countAccounts: true, // 汇总里给「成功 N」：全量尝试 - 失败条数
  },
  {
    id: 'school',
    label: '开学季任务',
    hint: 'Python 脚本任务',
    enabledKey: 'school_enabled',
    hoursKey: 'school_hours',
    credits: true,
  },
  {
    id: 'cat',
    label: '夜猫子任务',
    hint: 'Python 脚本 · 23:00-08:00',
    enabledKey: 'cat_enabled',
    hoursKey: 'cat_hours',
    credits: true,
  },
]

/** 不属于排程的一次性动作（领 trial 加油包 / 只查积分） */
export const EXTRA_ACTIONS = [
  {
    id: 'trial',
    label: '领 trial 加油包',
    hint: '只对国际版账号；国内版回 N/A，不算失败',
  },
  {
    id: 'credits',
    label: '查询积分',
    hint: '只读：全量查积分包，不写任何文件',
    logItems: 'summary',
  },
]

const TASK_BY_ID = new Map([...TASKS, ...EXTRA_ACTIONS].map((t) => [t.id, t]))

/** 任务元信息（未知 id 返回 null） */
export function taskMeta(id) {
  return TASK_BY_ID.get(id) ?? null
}

/* ============================================================== 路径 === */

function gatewayDir() {
  return wb.gatewayDir()
}

/** 网关目录没配时的统一提示（空串 = 配了） */
function needsDir() {
  return gatewayDir()
    ? ''
    : '还没配网关目录：到「网关配置」页填 config.workbuddy.dir（网关是你自己装的那一份，不随本仓库分发）'
}

function authsDir() {
  return path.join(gatewayDir(), 'auths')
}

function exe(name) {
  return path.join(gatewayDir(), name).replace(/\//g, '\\')
}

/** 命令行里的路径要带引号：网关目录可能带空格甚至非 ASCII 字符 */
function q(s) {
  return `"${String(s).replace(/"/g, '""')}"`
}

/** Python 解释器：config.workbuddy.python → 环境变量 WB2A_PYTHON → python */
function pythonBin() {
  return loadConfig().workbuddy?.python || process.env.WB2A_PYTHON || 'python'
}

function dataFile() {
  const dir = process.env.WS_DATA_DIR || loadConfig().dataDir
  return path.join(dir, 'workbuddy-activity.json')
}

/* ======================================================== 活动日志存储 === */

const MAX_ENTRIES = 3000
const MAX_LOG_TAIL = 240 // 每次运行保留的原始输出行数（给「原始输出」抽屉看）

let store = null
let persistTimer = null

function loadStore() {
  if (store) return store
  store = { version: 1, entries: [], seen: new Set(), runSeq: 0, chain: {} }
  try {
    const raw = JSON.parse(fs.readFileSync(dataFile(), 'utf8'))
    if (raw && Array.isArray(raw.entries)) {
      store.entries = raw.entries
      store.seen = new Set(raw.entries.map((e) => e.id))
      store.runSeq = Number(raw.runSeq) || 0
      // 一键完成的冷却/间隔也要落盘 —— 漏了它，边车一重启守卫就失忆（实测踩过：
      // 重启后立刻又能开跑，等于「限流保护」在重启后形同不存在）
      store.chain = raw.chain && typeof raw.chain === 'object' ? raw.chain : {}
    }
  } catch {
    /* 首次运行或文件损坏：从空开始，不抛 */
  }
  // 历史条目里可能留着旧版本写进去的半截报文/替换字符、以及旧版的英文状态词：
  // 载入时清一遍并落盘（幂等，改过才写）
  let cleaned = 0
  for (const e of store.entries) {
    const before = e.text
    if (!before) continue
    e.text = legacyStatus(sanitizeText(before))
    if (e.text !== before) cleaned++
  }
  if (cleaned) {
    console.log(`[wb-activity] 已清洗 ${cleaned} 条历史日志正文（半截报文/乱码）`)
    persistSoon()
  }
  return store
}

/** 落盘（合并连续追加：一秒内的多次写入只落一次） */
function persistSoon() {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    persist()
  }, 800)
  persistTimer.unref?.()
}

function persist() {
  if (!store) return
  store.chain = store.chain ?? {}
  try {
    const file = dataFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const doc = {
      version: 1,
      updatedAt: Date.now(),
      runSeq: store.runSeq,
      chain: store.chain ?? {},
      entries: store.entries,
    }
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(doc), 'utf8')
    fs.renameSync(tmp, file)
  } catch (err) {
    console.warn('[wb-activity] 活动日志落盘失败:', err.message)
  }
}

/** 追加条目（按 id 去重；超上限丢最旧的） */
function pushEntry(e) {
  const s = loadStore()
  if (!e?.id || s.seen.has(e.id)) return false
  if (e.text) e.text = sanitizeText(e.text)
  s.seen.add(e.id)
  s.entries.push(e)
  if (s.entries.length > MAX_ENTRIES) {
    for (const d of s.entries.splice(0, s.entries.length - MAX_ENTRIES)) s.seen.delete(d.id)
  }
  persistSoon()
  return true
}

function entryId(parts) {
  return parts.filter((x) => x !== undefined && x !== null && x !== '').join(':')
}

/** 账号显示名：优先昵称，其次 uid 前缀（与网关日志的 (uid8) 同口径） */
function accountLabel({ nickname, uid8, uid } = {}) {
  const nick = String(nickname ?? '').trim()
  if (nick && nick !== '-') return nick
  if (uid8) return String(uid8)
  if (uid) return String(uid).slice(0, 8)
  return '—'
}

/**
 * 旧版（2026-09-21 之前）的签到行只写了表格里的英文状态词，如 `ALREADY，余额 …`。
 * 只认「行首状态词 + 分隔符」这一种形状 —— 正文里出现 ALREADY 不会被动。
 */
function legacyStatus(text) {
  return String(text ?? '')
    .replace(/^ALREADY(?=[，,·\s]|$)\s*[，,·]?\s*/, '今天已签到（幂等，重复跑正常），')
    .replace(/^N\/A(?=[，,·\s]|$)\s*[，,·]?\s*/, '不适用，')
    .replace(/^FAIL(?=[，,·\s]|$)\s*[，,·]?\s*/, '失败，')
    .replace(/[，,]\s*$/, '')
}

/**
 * 清洗一条日志正文 —— 两道都是踩过的坑：
 *  1. **半截 JSON**：网关把上游返回体整段塞进 error 串，`signin_bin` 的输出又是**定宽表格**，
 *     detail 列被截断成 `upstream client (http 400): {"code":10001,"msg":"今天已` 这种半截报文，
 *     显示出来既没信息又有乱码。整段丢弃，原文留在「本次运行 → 原始输出」里。
 *  2. **替换字符**：截断正好切在多字节 UTF-8 中间时会解出 U+FFFD（`�`），一并去掉。
 */
function sanitizeText(text) {
  let s = String(text ?? '')
  // 半截/完整的上游报文尾巴（`· upstream client (http 400): {...` 到下一个 `，余额 ` 或行尾）
  s = s.replace(/(?:\s*[，,·]\s*|^)upstream client \(http \d+\):\s*(?:\{[\s\S]*?)?(?=，余额 |$)/g, '')
  s = s.replace(/\{"?code"?\s*:[\s\S]*?(?=，余额 |$)/g, '')
  s = s.replace(/upstream client \(http \d+\):\s*/g, '')
  s = s.replace(/�+/g, '')
  return s.replace(/[，,]\s*$/, '').trim()
}

/* ========================================================= 网关日志解析 === */

/** 网关 stderr 日志（Go log 默认写 stderr，由 start 脚本重定向到这里） */
function gatewayErrLog() {
  return path.join(gatewayDir(), 'data', 'server.err.log').replace(/\//g, '\\')
}

const GATEWAY_TS_RE = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})\s+(.*)$/
/** `任务 昵称(uid8): 正文` —— 网关逐账号行的固定形状 */
const GATEWAY_TASK_RE = /^([a-z_]+) ([^(]+)\(([0-9a-f]{8})\):(.*)$/
/** 只认这几类任务的逐账号行；其余（[upstream]/[pool]/[watch]/请求日志）不进活动日志 */
const GATEWAY_TASKS = new Set(['activity', 'travel', 'keepalive', 'checkin'])

/** 把 ms 拼成网关日志的时间戳前缀，让手动输出走同一个解析器 */
function stampPrefix(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} `
}

/** 读日志尾部（超过 4MB 只读最后 4MB：日志是覆盖写的，更早的内容已不在文件里） */
function readTail(file, maxBytes = 4 * 1024 * 1024) {
  const st = fs.statSync(file)
  const start = Math.max(0, st.size - maxBytes)
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(st.size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    return buf.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * 一行网关日志 → 事件（不认识的返回 null）。
 *
 * 有意把「上报 5 连发」折叠掉：`activity x(uid8): report 3/5 ok` 每号五行，
 * 12 个号就是 60 行噪音，真信息在紧随其后的 `streak days=N` 上 —— 折叠靠返回值里的
 * `{fold:true}` 标记，由 ingestGatewayLog 计数并并进那一行。
 */
function parseGatewayLine(line) {
  const m = GATEWAY_TS_RE.exec(line)
  if (!m) return null
  const at = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()
  let body = m[7]
  let level = 'info'
  if (body.startsWith('WARN: ')) {
    level = 'warn'
    body = body.slice(6)
  } else if (body.startsWith('ERR: ')) {
    level = 'fail'
    body = body.slice(5)
  }

  // 脚本类排程：`school: ok (路径)` / `WARN: school (路径): exit status 9009`
  const script = /^(school|cat)\b(.*)$/.exec(body)
  if (script) {
    const id = script[1]
    const rest = script[2].trim()
    if (rest.startsWith(': ok')) {
      return {
        at,
        task: id,
        source: 'gateway',
        account: '全体账号',
        text: '脚本执行完成（网关排程；逐账号明细只有手动跑才有）',
        tone: 'ok',
      }
    }
    if (rest.startsWith('(')) {
      const msg = /\):\s*(.*)$/.exec(rest)?.[1] ?? rest
      return { at, task: id, source: 'gateway', account: '全体账号', text: `脚本执行失败：${msg}`, tone: 'fail' }
    }
    return null
  }

  // 签到汇总：`checkin done: total=12 ok=11 already=1 fail=0 skipped=0`
  const done = /^checkin done: (.*)$/.exec(body)
  if (done) {
    const g = (k) => Number(new RegExp(`${k}=(\\d+)`).exec(done[1])?.[1] ?? 0)
    const fail = g('fail')
    const parts = [`共 ${g('total')}`, `成功 ${g('ok')}`]
    if (g('already')) parts.push(`已签 ${g('already')}`)
    if (fail) parts.push(`失败 ${fail}`)
    if (g('skipped')) parts.push(`跳过 ${g('skipped')}`)
    return {
      at,
      task: 'checkin',
      source: 'gateway',
      account: '全体账号',
      text: `签到完成：${parts.join(' · ')}（网关排程只记汇总）`,
      tone: fail ? 'warn' : 'ok',
    }
  }
  const busy = /^scheduled checkin skipped: (.*)$/.exec(body)
  if (busy) {
    return { at, task: 'checkin', source: 'gateway', account: '全体账号', text: `排程签到跳过：${busy[1]}`, tone: 'warn' }
  }

  const tm = GATEWAY_TASK_RE.exec(body)
  if (!tm) return null
  const [, task, nick, uid8, rawMsg] = tm
  if (!GATEWAY_TASKS.has(task)) return null
  const msg = rawMsg.trim()
  const base = { at, task, source: 'gateway', uid8, nickname: nick.trim(), level }
  const account = accountLabel(base)

  if (task === 'activity') {
    if (/^report \d+\/\d+ ok$/.test(msg)) return { fold: true, at, task, uid8, key: `report:${uid8}` }
    const rep = /^report (\d+)\/(\d+): (.*)$/.exec(msg)
    if (rep) return { ...base, account, text: `上报 ${rep[1]}/${rep[2]} 失败：${rep[3]}`, tone: 'fail' }
    const streak = /^streak days=(\d+)$/.exec(msg)
    if (streak) return { ...base, account, text: `连登 ${streak[1]} 天`, tone: 'ok' }
    const redeem = /^redeem tier=(\S+) ok \(\+(\d+) credit, \+(\d+) energy, \+(\d+) chances\)$/.exec(msg)
    if (redeem) {
      const extra = Number(redeem[4]) ? ` · +${redeem[4]} 抽奖次数` : ''
      return { ...base, account, delta: Number(redeem[2]), text: `连登奖励 ${redeem[1]} 档：+${redeem[2]} 积分${extra}`, tone: 'ok' }
    }
    if (/^redeem tier=\S+ skip/.test(msg)) return null // 未达标/已领：正常态，不刷日志
    const drawn = /^lottery drawn prize=(.+) \(([^)]+)\)$/.exec(msg)
    if (drawn) return { ...base, account, text: `抽奖：${drawn[1]}（${drawn[2]}）`, tone: 'ok' }
    if (/^lottery skip/.test(msg)) return null // 无次数：正常态
    const gift = /^gift ok \(\+(\d+) credit\)$/.exec(msg)
    if (gift) return { ...base, account, delta: Number(gift[1]), text: `新手礼包 +${gift[1]} 积分`, tone: 'ok' }
    const comp = /^compensation ok \(\+(\d+) credit\)$/.exec(msg)
    if (comp) return { ...base, account, delta: Number(comp[1]), text: `活动补偿 +${comp[1]} 积分`, tone: 'ok' }
    const makeup = /^makeup ok (\S+)/.exec(msg)
    if (makeup) return { ...base, account, text: `补签 ${makeup[1]}，连登已保住`, tone: 'ok' }
    if (/^streak check failed|silent drop|reward-state|lottery-chances/.test(msg)) {
      return { ...base, account, text: msg, tone: 'warn' }
    }
    return { ...base, account, text: msg, tone: level === 'info' ? 'warn' : 'fail' }
  }

  if (task === 'travel') {
    const depart = /^depart ok location=(\d+)$/.exec(msg)
    if (depart) return { ...base, account, text: `已派出（地点 ${depart[1]}）`, tone: 'ok' }
    const claim = /^claim ok record=(\d+) reward=(\d+)$/.exec(msg)
    if (claim) return { ...base, account, delta: Number(claim[2]), text: `到站领奖 +${claim[2]}`, tone: 'ok' }
    const adopt = /^adopt ok \(\+(\d+) credits\)$/.exec(msg)
    if (adopt) return { ...base, account, delta: Number(adopt[1]), text: `领养成功 +${adopt[1]} 积分`, tone: 'ok' }
    if (/^adopt skipped/.test(msg)) return { ...base, account, text: '领养未达对话量门槛，明天再试', tone: 'muted' }
    const skip = /^skip \((.*)\)$/.exec(msg)
    if (skip) {
      const why = skip[1]
      const text = why.startsWith('traveling')
        ? '旅途中，等到站再领'
        : why.startsWith('daily limit')
          ? '今日已派出过（自然日 00:00 重置）'
          : `跳过：${why}`
      return { ...base, account, text, tone: 'muted' }
    }
    return { ...base, account, text: msg, tone: 'fail' }
  }

  if (task === 'keepalive') {
    return { ...base, account, text: `保活失败：${msg}`, tone: 'fail' }
  }
  // checkin 的逐账号行只在失败/跳过时打
  return { ...base, account, text: `签到异常：${msg}`, tone: 'fail' }
}

/**
 * 把网关日志里的新行并进活动日志。
 *
 * 去重靠事件 id（时间戳 + 正文哈希）：文件被启动脚本覆盖、边车重启、同一行被读到两次，
 * 都不会重复记账。折叠位（report 中间行）只累加计数，并进同账号的下一行。
 */
function ingestGatewayLog() {
  const file = gatewayErrLog()
  let text
  try {
    text = readTail(file)
  } catch {
    return { ok: false, error: '读不到网关 stderr 日志（网关没跑过？）', added: 0, file }
  }
  const folds = new Map()
  let added = 0
  for (const line of text.split(/\r?\n/)) {
    const ev = parseGatewayLine(line)
    if (!ev) continue
    if (ev.fold) {
      folds.set(ev.key, (folds.get(ev.key) ?? 0) + 1)
      continue
    }
    const id = entryId(['gw', ev.at, crypto.createHash('sha1').update(line.trim()).digest('hex').slice(0, 12)])
    const reports = folds.get(`report:${ev.uid8}`) ?? 0
    if (reports) folds.delete(`report:${ev.uid8}`)
    if (
      pushEntry({
        id,
        at: ev.at,
        task: ev.task,
        source: 'gateway',
        account: ev.account,
        uid8: ev.uid8 ?? '',
        nickname: ev.nickname ?? '',
        runId: entryId(['gwr', ev.task, ev.at, ev.account]),
        delta: ev.delta ?? null,
        before: null,
        after: null,
        text: reports ? `上报 ${reports} 条 · ${ev.text}` : ev.text,
        tone: ev.tone ?? 'ok',
      })
    ) {
      added++
    }
  }
  return { ok: true, added, file }
}

/* ==================================================== 手动运行的输出解析 === */

/** 去掉 Go log 的 `2026/09/21 15:28:35 ` 前缀 */
function stripLogPrefix(line) {
  return line.replace(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\s*/, '')
}

/**
 * 清理 CLI 表格里 detail 一列的内容。
 *
 * 两个坑：
 *  1. 网关把上游返回体整段塞进 error 串，直接显示就是一大坨带转义的 JSON —— 拿得到 msg 就用 msg。
 *  2. signin_bin 的输出是**定宽表格**，detail 列会被截断（实测 `…{"code":10001,"msg":"今天已�`）。
 *     半截 JSON 什么也说明不了，不如不显示 —— 完整原文在「本次运行 → 原始输出」里能看。
 */
function cleanDetail(detail) {
  const text = String(detail ?? '').trim()
  if (!text) return ''
  const msg = /"msg"\s*:\s*"([^"]*)"/.exec(text)
  if (msg) return msg[1]
  if (/upstream client|"code"\s*:|\bcode":\d/.test(text)) return ''
  return text
}

/** 状态词 → 人话（表格里的 status 列是给脚本看的，页面要能直接读） */
function statusLabel(status) {
  const map = {
    OK: '签到成功',
    ALREADY: '今天已签到（幂等，重复跑正常）',
    'N/A': '不适用',
    LOAD_ERR: '凭证文件读不了',
    AUTH_INVALID: '凭证无效',
    FAIL: '失败',
  }
  return map[status] ?? status
}

/** signin_bin / trial_bin 的表格：uid | nick | status | remain | detail（末尾一行 total=…） */
function parseTable(stdout, { withRemain = true } = {}) {
  const items = []
  let summary = null
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    if (!line.includes('|')) {
      const m = /total=(\d+)\s+ok=(\d+)(?:\s+already=(\d+))?(?:\s+na=(\d+))?\s+fail=(\d+)/.exec(line)
      if (m) {
        summary = {
          total: Number(m[1]),
          ok: Number(m[2]),
          already: m[3] == null ? 0 : Number(m[3]),
          na: m[4] == null ? 0 : Number(m[4]),
          fail: Number(m[5]),
        }
      }
      continue
    }
    const cols = line.split('|').map((x) => x.trim())
    if (cols.length < 3) continue
    const [uid, nick, status, fourth, ...rest] = cols
    if (/^-+$/.test(uid) || uid.toLowerCase() === 'uid') continue
    if (/^(loaded|total|mode)\b/i.test(uid)) continue
    const remain = withRemain && fourth && fourth !== '' && fourth !== '-' ? Number(fourth) : null
    const detail = cleanDetail((withRemain ? rest.join(' | ') : [fourth, ...rest].join(' | ')).trim())
    const okStatus = ['OK', 'ALREADY', 'N/A'].includes(status)
    const label = statusLabel(status)
    items.push({
      uid,
      nickname: nick,
      account: accountLabel({ nickname: nick, uid }),
      after: Number.isFinite(remain) ? remain : null,
      text: detail ? `${label} · ${detail}` : label,
      tone: okStatus ? (status === 'OK' ? 'ok' : 'muted') : 'fail',
      ok: okStatus,
    })
  }
  return { items, summary }
}

/**
 * Go 侧任务的逐账号行（activity / travel / keepalive）：
 * 输出就是 log 行，明细即行本身。渲染走与网关排程同一个解析器（parseGatewayLine），
 * 口径不会分叉。
 */
function parseGoTaskOutput(raw, meta) {
  const items = []
  const accounts = new Set()
  const failed = new Set()
  const folds = new Map() // uid8 → 上报条数（与网关排程同一个折叠口径）
  let total = null
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const stripped = stripLogPrefix(line).trim()
    if (!stripped) continue
    if (/^(activity|travel|keepalive) run complete$/.test(stripped)) continue
    const loaded = /^loaded (\d+) account\(s\)/.exec(stripped)
    if (loaded) {
      total = Number(loaded[1])
      continue
    }
    const ev = parseGatewayLine(`${stampPrefix(Date.now())}${stripped}`)
    if (ev?.fold) {
      // `activity x(uid8): report 3/5 ok` 每号五行 —— 折叠成计数，并进同账号的下一行
      folds.set(ev.key, (folds.get(ev.key) ?? 0) + 1)
      continue
    }
    if (!ev || !ev.account) {
      // 认不出的行（含 [watch]/[pool] 噪音）不当条目，只在「原始输出」里留痕
      if (/error|fatal|WARN/i.test(stripped)) {
        items.push({ account: '', text: stripped, tone: 'warn', ok: false })
      }
      continue
    }
    if (ev.uid8) accounts.add(ev.uid8)
    if (ev.tone === 'fail' && ev.uid8) failed.add(ev.uid8)
    const reports = folds.get(`report:${ev.uid8}`) ?? 0
    if (reports) folds.delete(`report:${ev.uid8}`)
    items.push({
      uid8: ev.uid8 ?? '',
      nickname: ev.nickname ?? '',
      account: ev.account,
      delta: ev.delta ?? null,
      text: reports ? `上报 ${reports} 条 · ${ev.text}` : ev.text,
      tone: ev.tone ?? 'ok',
      ok: ev.tone !== 'fail',
    })
  }
  const summary = { total: total ?? accounts.size }
  if (meta?.countAccounts) {
    summary.ok = Math.max(0, (total ?? accounts.size) - failed.size)
    summary.fail = failed.size
  }
  return { items, summary }
}

/**
 * 开学季脚本（school_open_day_2026.py）的 stdout → 逐账号条目。
 *
 * 脚本自己打了 `== uid8 (昵称) ==` 分节头，逐行前缀 `[school2026] uid8 …`。
 * 按账号聚合：点亮几项、领了几次奖、抽奖抽到多少分 —— 脚本的 `lottery 汇总` 行是
 * 唯一给出脚本口径积分增量的地方（脚本**不**打印 claim 的奖励面额），所以增量主要靠
 * 余额前后对照，脚本口径只作旁证。
 */
function parseSchoolOutput(stdout) {
  const byUid = new Map()
  const order = []
  const get = (uid8) => {
    if (!byUid.has(uid8)) {
      byUid.set(uid8, { uid8, nickname: '', lit: 0, claimed: 0, lottery: '', notes: [], fail: false })
      order.push(uid8)
    }
    return byUid.get(uid8)
  }
  let summary = null
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    const head = /^==\s*([0-9a-f]{8})\s*\(([^)]*)\)\s*==$/.exec(s)
    if (head) {
      const rec = get(head[1])
      if (head[2] && head[2] !== '-') rec.nickname = head[2]
      continue
    }
    const body = /^\[school2026\]\s*([0-9a-f]{8})\s+(.*)$/.exec(s)
    if (!body) {
      const done = /^school2026 done: (.*)$/.exec(s)
      if (done) {
        const g = (k) => Number(new RegExp(`${k}=(\\d+)`).exec(done[1])?.[1] ?? 0)
        summary = {
          accounts: g('accounts'),
          ok: g('ok'),
          already: g('already'),
          skip: g('skip'),
          pending: g('pending'),
          fail: g('fail'),
        }
      }
      const err = /^ERR:\s*\[school2026\]\s*([0-9a-f]{8})?\s*(.*)$/.exec(s)
      if (err) {
        const rec = get(err[1] ?? 'unknown')
        rec.fail = true
        rec.notes.push(err[2])
      }
      continue
    }
    const [, uid8, msg] = body
    const rec = get(uid8)
    if (/（点亮）$/.test(msg)) rec.lit++
    else if (/:\s*claim\s+200\b/.test(msg)) rec.claimed++
    else if (/^lottery 汇总:/.test(msg)) rec.lottery = msg.replace(/^lottery 汇总:\s*/, '')
    else if (/活动非进行期/.test(msg)) rec.notes.push('活动已下线，本段跳过')
    else if (/claim 失败|处理失败|回读任务失败|触发 #\d+ 失败/.test(msg)) {
      rec.fail = true
      rec.notes.push(msg)
    }
  }
  const items = order.map((uid8) => {
    const r = byUid.get(uid8)
    const bits = []
    if (r.lit) bits.push(`点亮 ${r.lit} 项`)
    if (r.claimed) bits.push(`领奖 ${r.claimed} 次`)
    if (r.lottery) bits.push(`抽奖 ${r.lottery}`)
    if (r.notes.length) bits.push(r.notes[0])
    return {
      uid8,
      nickname: r.nickname,
      account: accountLabel({ nickname: r.nickname, uid8 }),
      text: bits.join('，') || '无可领取的任务（已领完或活动未开启）',
      tone: r.fail ? 'fail' : 'ok',
      ok: !r.fail,
    }
  })
  return { items, summary }
}

/**
 * 夜猫子脚本（task_runner.py --only black_cat）的 stdout → 逐账号条目。
 * 关键行：`report 1/3 200 code=0` 点亮、`claim 200 ok(credit=+N energy=+N)` 入账、
 * 以及窗口外 / 已领的 skip 行（如实写出来，免得以为脚本没跑）。
 */
function parseCatOutput(stdout) {
  const byUid = new Map()
  const order = []
  const get = (uid8) => {
    if (!byUid.has(uid8)) {
      byUid.set(uid8, { uid8, nickname: '', reports: 0, credit: 0, energy: 0, notes: [], fail: false })
      order.push(uid8)
    }
    return byUid.get(uid8)
  }
  let summary = null
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    const head = /^==\s*([0-9a-f]{8})\s*\(([^)]*)\)\s*==$/.exec(s)
    if (head) {
      const rec = get(head[1])
      if (head[2] && head[2] !== '-') rec.nickname = head[2]
      continue
    }
    const done = /^task_runner done: (.*)$/.exec(s)
    if (done) {
      const g = (k) => Number(new RegExp(`${k}=(-?\\d+)`).exec(done[1])?.[1] ?? 0)
      summary = {
        accounts: g('accounts'),
        ok: g('ok'),
        already: g('already'),
        skip: g('skip'),
        pending: g('pending'),
        fail: g('fail'),
        credit: g('credit'),
      }
      continue
    }
    const err = /^ERR:\s*\[task_runner\]\s*([0-9a-f]{8})?\s*(.*)$/.exec(s)
    if (err) {
      const rec = get(err[1] ?? 'unknown')
      rec.fail = true
      rec.notes.push(err[2])
      continue
    }
    const body = /^\[task_runner\]\s*([0-9a-f]{8})\s+(.*)$/.exec(s)
    if (!body) continue
    const [, uid8, msg] = body
    const rec = get(uid8)
    if (/: report \d+\/\d+ 200\b/.test(msg)) rec.reports++
    const claim = /: claim\s*200\s*(?:ok|already_claimed)\(credit=\+(-?\d+) energy=\+(-?\d+)\)/.exec(msg)
    if (claim) {
      rec.credit += Number(claim[1])
      rec.energy += Number(claim[2])
    }
    if (/^black_cat: query .*非夜猫窗口/.test(msg)) rec.notes.push('不在夜猫窗口（23:00–08:00）')
    else if (/^black_cat: query claimed/.test(msg)) rec.notes.push('今日已领')
    else if (/report 未达 target/.test(msg)) rec.notes.push('上报未达门槛，留下次')
    else if (/claim.*-> ERR|claim 失败/.test(msg)) {
      rec.fail = true
      rec.notes.push(msg)
    }
  }
  const items = order.map((uid8) => {
    const r = byUid.get(uid8)
    const bits = []
    if (r.reports) bits.push(`上报 ${r.reports} 条`)
    if (r.credit) bits.push(`领奖 +${r.credit} 积分`)
    if (r.energy) bits.push(`+${r.energy} 能量`)
    if (r.notes.length) bits.push(r.notes[0])
    return {
      uid8,
      nickname: r.nickname,
      account: accountLabel({ nickname: r.nickname, uid8 }),
      text: bits.join('，') || '本趟无动作',
      tone: r.fail ? 'fail' : 'ok',
      ok: !r.fail,
    }
  })
  return { items, summary }
}

/** credit.exe -json 的输出 → 条目（只读查询，没有增量概念） */
function parseCreditOutput(stdout) {
  let doc = null
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    try {
      doc = JSON.parse(s)
    } catch {
      /* 非 JSON 行跳过 */
    }
  }
  if (!doc) return { items: [], summary: null, error: '积分查询输出解析失败（没找到 JSON 行）' }
  const rows = doc.accounts ?? []
  return {
    items: rows.map((a) => ({
      uid: a.uid,
      nickname: a.nickname ?? '',
      account: accountLabel({ nickname: a.nickname, uid: a.uid }),
      after: a.remain == null ? null : Number(a.remain),
      text: a.ok ? `剩余 ${a.remain ?? 0} · ${a.packages ?? 0} 个套餐` : a.error ?? '查询失败',
      tone: a.ok ? 'ok' : 'fail',
      ok: !!a.ok,
    })),
    summary: {
      total: doc.total?.accounts ?? rows.length,
      ok: doc.total?.ok ?? 0,
      already: 0,
      na: 0,
      fail: doc.total?.failed ?? 0,
    },
  }
}

/* ============================================================ 运行任务 === */

const runs = []
const MAX_RUNS = 50
let runSeq = 0
let running = '' // 同一时刻只跑一个：CLI 之间会抢上游接口与共享 state.json

/**
 * 运行编号：从落盘里接着数，别从头开始。
 *
 * 为什么必须接着数 —— 事件 id 里带 run.id，边车重启后从 1 重数会让新运行的 id
 * 与历史条目撞名，pushEntry 的去重会把新结果整批丢掉（实测踩过：重启后跑的签到
 * 一条日志都没进）。除了这里续号，条目 id 里还额外带了 startedAt 兜底。
 */
function nextRunSeq() {
  const s = loadStore()
  runSeq = Math.max(runSeq, Number(s.runSeq) || 0) + 1
  s.runSeq = runSeq
  return runSeq
}

/**
 * 跑前/跑后各查一次积分（只读），用来算逐账号增量。
 * 顺手带一份 uid8 → 昵称的对照：开学季脚本的 run 模式只打 uid8（不打 `== uid8 (昵称) ==`
 * 那种分节头），日志里得靠这份对照把账号名补成人看得懂的。
 */
async function creditSnapshot() {
  const r = await wb.credits()
  if (!r.ok) return null
  const byUid = {}
  const names = {}
  for (const a of r.accounts ?? []) {
    if (!a.ok) continue
    byUid[a.uid] = Number(a.remain ?? 0)
    if (a.nickname) names[String(a.uid).slice(0, 8)] = a.nickname
  }
  return { at: Date.now(), byUid, names }
}

/** 两类命令行：网关自带的 exe，或网关排程跑的那两个 Python 脚本 */
function runnerFor(id, uidPrefix) {
  const scriptPath = (name) => q(path.join(gatewayDir(), 'scripts', name).replace(/\//g, '\\'))
  const runners = {
    checkin: {
      title: '每日签到',
      file: 'signin_bin.exe',
      args: () => [q(authsDir())],
      parse: (out) => parseTable(out),
    },
    activity: {
      title: '活跃上报',
      file: 'activity_bin.exe',
      args: () => (uidPrefix ? [uidPrefix] : []),
      parse: (out) => parseGoTaskOutput(out, { countAccounts: true }),
    },
    travel: {
      title: '猫猫旅行',
      file: 'travel_bin.exe',
      args: () => (uidPrefix ? [uidPrefix] : []),
      parse: (out) => parseGoTaskOutput(out, { countAccounts: true }),
    },
    keepalive: {
      title: 'Token 保活',
      file: 'keepalive_bin.exe',
      args: () => (uidPrefix ? [uidPrefix] : []),
      parse: (out) => parseGoTaskOutput(out, { countAccounts: true }),
    },
    school: {
      title: '开学季任务',
      python: [pythonBin(), scriptPath('school_open_day_2026.py'), 'ALL', '--run', '--yes'],
      parse: parseSchoolOutput,
      timeout: 900000,
    },
    cat: {
      title: '夜猫子任务',
      python: [pythonBin(), scriptPath('task_runner.py'), 'ALL', '--yes', '--only', 'black_cat'],
      parse: parseCatOutput,
      timeout: 900000,
    },
    trial: {
      title: '领取 trial 加油包',
      file: 'trial_bin.exe',
      args: () => [q(authsDir())],
      parse: (out) => parseTable(out, { withRemain: false }),
    },
    credits: { title: '查询积分', file: 'credit.exe', args: () => ['-json'], parse: parseCreditOutput },
  }
  return runners[id] ?? null
}

/* ---------------------------------------------------------- 一键完成 --- */

/**
 * 「一键完成」= 六类任务**串行**跑一遍，中途不并发。
 *
 * 顺序照网关自己的排程逻辑排，不图快：
 *   签到（先解冻冷却账号的余额）→ 活跃（补满领猫要的对话量）→ 猫猫旅行（对话量够了才领得到猫）
 *   → 开学季（独立任务中心）→ 夜猫子（窗口外脚本自己 skip）→ 保活（刷凭证，最便宜放最后）。
 *
 * 为什么顺序不是随便排的：领养的对话量门槛由活跃上报补满，网关自己也是 10 点活跃之后
 * 靠 travelAdoptForce 才领到猫 —— 旅行排在活跃后面是有因果的。
 */
const CHAIN = {
  id: 'all',
  label: '一键完成',
  order: ['checkin', 'activity', 'travel', 'school', 'cat', 'keepalive'],
}

/** 限流保护参数（环境变量可覆盖；默认值按「宁可慢，别把账号打进风控」取） */
function envSec(name, def) {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v >= 0 ? v : def
}
/** 两步之间的等待：给上游留出冷却窗口，也让自己的请求不连成一串 */
const CHAIN_GAP_MS = envSec('WB_CHAIN_GAP_SEC', 20) * 1000
/** 两次「一键完成」的最小间隔：奖励是按天发的，多跑不会多拿，只会多出风控面 */
const CHAIN_MIN_MS = envSec('WB_CHAIN_MIN_SEC', 600) * 1000
/** 一旦命中限流信号，冷却这么久再允许跑（人工可 force 覆盖） */
const CHAIN_COOL_MS = envSec('WB_CHAIN_COOL_SEC', 900) * 1000

/**
 * 限流信号。命中即**立即停**剩下的步骤 —— 这是「不被限流」的关键：
 * 真被限过一次之后接着打下一个任务，只会让退避更狠（网关侧有 6004 模型级限流、
 * 12153 session dead 计数、连续失败熔断，都是越打越糟）。
 *
 * 匹配刻意保守：只在真出现这些码/词时才停（正常输出里的 `http 400` + `code:10001`
 * 是「今天已签到」的幂等码，不在名单里）。
 */
const THROTTLE_RE =
  /(?:^|\D)(429|6004|12153)(?:\D|$)|too many requests|rate ?limit|频率|限流|风控|session dead|使用量已超出/i

function detectThrottle(run) {
  const text = [
    run.error ?? '',
    ...(run.items ?? []).map((i) => i.text ?? ''),
    ...(run.items ?? []).map((i) => i.detail ?? ''),
    ...(run.raw ?? []),
  ].join('\n')
  const m = THROTTLE_RE.exec(text)
  return m ? String(m[0]).trim() || 'rate limit' : ''
}

/** 一键完成的冷却/间隔状态（落盘，边车重启也认） */
function chainState() {
  const s = loadStore()
  const c = s.chain ?? {}
  const now = Date.now()
  const coolLeft = Math.max(0, (Number(c.cooldownUntil) || 0) - now)
  const waitLeft = c.lastAt ? Math.max(0, Number(c.lastAt) + CHAIN_MIN_MS - now) : 0
  return {
    id: CHAIN.id,
    label: CHAIN.label,
    order: CHAIN.order,
    gapSec: Math.round(CHAIN_GAP_MS / 1000),
    minIntervalMin: Math.round(CHAIN_MIN_MS / 60000),
    cooldownMin: Math.round(CHAIN_COOL_MS / 60000),
    lastAt: Number(c.lastAt) || 0,
    cooldownUntil: Number(c.cooldownUntil) || 0,
    cooldownReason: coolLeft > 0 ? c.cooldownReason ?? '' : '',
    lastFinishedAt: Number(c.lastAt) || 0,
    cooling: coolLeft > 0,
    waitLeftMs: waitLeft,
    canStart: !running && coolLeft <= 0 && waitLeft <= 0,
    blockReason: running
      ? `已有任务在跑（${running}）`
      : coolLeft > 0
        ? `限流冷却中，约 ${Math.ceil(coolLeft / 60000)} 分钟后可再跑（上次命中「${c.cooldownReason ?? ''}」）`
        : waitLeft > 0
          ? `距上次一键完成跑完不到 ${Math.round(CHAIN_MIN_MS / 60000)} 分钟，还差约 ${Math.ceil(waitLeft / 60000)} 分钟`
          : '',
  }
}

/** 冷却中要不要挡下这次运行（只读任务不挡；force 可覆盖，给 MCP / 命令行留口子） */
function cooldownBlock(kind, force) {
  if (force || kind === 'credits') return ''
  const st = chainState()
  if (!st.cooling) return ''
  const left = Math.ceil((st.cooldownUntil - Date.now()) / 60000)
  return `限流冷却中（约 ${left} 分钟）：上次命中「${st.cooldownReason}」。可等到期，或用 force 强制跑`
}

function markChainRun(at = Date.now()) {
  const s = loadStore()
  s.chain = { ...(s.chain ?? {}), lastAt: at }
  persistSoon()
}

function markThrottled(reason) {
  const s = loadStore()
  s.chain = { ...(s.chain ?? {}), cooldownUntil: Date.now() + CHAIN_COOL_MS, cooldownReason: reason }
  persistSoon()
}

/** 新建一个运行对象（进度容器；真正的执行在 execute 里） */
function createRun(kind, title, uidPrefix = '') {
  const run = {
    id: `${kind}-${nextRunSeq()}`,
    task: kind,
    title,
    uidPrefix,
    running: true,
    error: '',
    startedAt: Date.now(),
    finishedAt: 0,
    items: [],
    summary: null,
    raw: [],
    creditsDelta: null,
  }
  runs.push(run)
  if (runs.length > MAX_RUNS) runs.splice(0, runs.length - MAX_RUNS)
  return run
}

/** 命令行拼装 + 存在性检查（exe 不在或 Python 找不到都要在开跑前说清） */
function buildCmd(spec) {
  if (spec.python) return { cmd: spec.python.join(' ') }
  const bin = exe(spec.file)
  if (!fs.existsSync(bin)) return { error: `找不到 ${spec.file}（网关目录：${gatewayDir()}）` }
  return { cmd: [q(bin), ...spec.args()].join(' ') }
}

/**
 * 真正跑一个任务：跑前积分快照 → 跑 → 解析 → 跑后积分快照。
 *
 * 返回这次的「跑后快照」，供一键完成把它当成下一步的「跑前」——
 * 串行链路里相邻两步之间只隔十几秒，复用一份快照能少一半只读查询，
 * 代价是这一步的增量把「等待间隔里的对话消耗」也算进来了（条目里照旧给 before → after）。
 */
async function execute(run, spec, meta, { beforeSnapshot = null } = {}) {
  const { cmd, error } = buildCmd(spec)
  if (error) {
    run.error = error
    return null
  }
  const timeout = spec.timeout ?? (run.task === 'credits' ? 120000 : 600000)
  try {
    // ① 跑前积分快照（只有会发积分的任务需要；只读，不写文件）
    const before = meta.credits ? beforeSnapshot ?? (await creditSnapshot()) : null
    run.names = before?.names ?? null
    // ② 跑
    const r = await runHidden(cmd, { cwd: gatewayDir(), timeout })
    const raw = `${r.stdout ?? ''}${r.stderr ? `\n${r.stderr}` : ''}`
    run.raw = raw.split(/\r?\n/).filter(Boolean).slice(-MAX_LOG_TAIL)
    // ③ 解析
    try {
      const parsed = spec.parse(raw)
      run.items = parsed.items ?? []
      run.summary = parsed.summary ?? null
      if (parsed.error) run.error = parsed.error
    } catch (err) {
      run.error = `输出解析失败：${err.message}`
    }
    if (r.code !== 0 && !run.error && !run.items.length) run.error = `退出码 ${r.code}`
    // ④ 跑后积分快照，并顺手刷额度页的积分缓存（一次查询两用）
    if (!meta.credits) return null
    const fresh = await wb.refreshCredit({ force: true, wait: true }).catch(() => null)
    const after = fresh?.ok
      ? {
          at: Date.now(),
          byUid: Object.fromEntries((fresh.accounts ?? []).filter((a) => a.ok).map((a) => [a.uid, Number(a.remain ?? 0)])),
        }
      : await creditSnapshot()
    run.creditsDelta = diffCredits(before, after)
    if (run.creditsDelta) run.creditAt = after?.at ?? Date.now()
    return after
  } catch (err) {
    run.error = err.message
    return null
  }
}

/** 收尾：置完成态 → 写活动日志（逐账号 + 汇总）。running 归零由调用方决定（链路要占着它） */
function finalize(run, { log = true, clearRunning = true } = {}) {
  run.running = false
  run.finishedAt = Date.now()
  if (clearRunning && running === run.id) running = ''
  if (log) {
    try {
      logRun(run)
    } catch (err) {
      console.warn('[wb-activity] 运行结果记账失败:', err.message)
    }
  }
}

/**
 * 「一键完成」：串行跑六类任务，中间按 CHAIN_GAP_MS 等一等，命中限流信号立即停。
 * 立即返回链路对象（含 steps 进度），页面轮询看进度。
 */
function startChain({ uidPrefix = '', force = false } = {}) {
  const miss = needsDir()
  if (miss) return { ok: false, error: miss }
  if (running) return { ok: false, error: `已有任务在跑（${running}），等它跑完再点` }
  const st = chainState()
  if (!force && st.cooling) {
    return { ok: false, error: `限流冷却中：还有约 ${Math.ceil((st.cooldownUntil - Date.now()) / 60000)} 分钟（上次命中「${st.cooldownReason}」）` }
  }
  if (!force && st.waitLeftMs > 0) {
    return {
      ok: false,
      error:
        `距上次一键完成跑完不到 ${st.minIntervalMin} 分钟（还差约 ${Math.ceil(st.waitLeftMs / 60000)} 分钟）。` +
        '奖励按自然日发，多跑不会多拿，只会多出风控面',
    }
  }

  const chain = {
    id: `${CHAIN.id}-${nextRunSeq()}`,
    task: CHAIN.id,
    title: `${CHAIN.label}（全部任务）`,
    uidPrefix,
    running: true,
    error: '',
    startedAt: Date.now(),
    finishedAt: 0,
    step: '',
    stepIndex: 0,
    total: CHAIN.order.length,
    waitUntil: 0,
    throttled: '',
    deltaTotal: 0,
    steps: CHAIN.order.map((k) => ({ task: k, label: taskMeta(k)?.label ?? k, state: 'pending', delta: null, text: '', runId: '' })),
  }
  runs.push(chain)
  if (runs.length > MAX_RUNS) runs.splice(0, runs.length - MAX_RUNS)
  running = chain.id

  ;(async () => {
    let carry = null // 上一步的「跑后快照」，给下一步当「跑前」用
    for (let i = 0; i < CHAIN.order.length; i++) {
      const kind = CHAIN.order[i]
      const step = chain.steps[i]
      const meta = taskMeta(kind)
      const spec = runnerFor(kind, uidPrefix)
      chain.stepIndex = i + 1
      chain.step = kind
      if (!meta || !spec) {
        step.state = 'skip'
        step.text = '任务未登记'
        continue
      }
      const run = createRun(kind, spec.title, uidPrefix)
      step.runId = run.id
      step.state = 'running'
      carry = await execute(run, spec, meta, { beforeSnapshot: carry })
      finalize(run, { clearRunning: false }) // running 由链路占着
      step.state = run.error ? 'fail' : 'done'
      step.delta = runDelta(run) || null
      step.text = summarizeRun(run)
      chain.deltaTotal += step.delta ?? 0

      const why = detectThrottle(run)
      if (why) {
        chain.throttled = why
        step.state = 'throttled'
        step.text = `${step.text}；命中限流信号「${why}」，已停止后续步骤`
        markThrottled(why)
        break
      }
      if (i < CHAIN.order.length - 1) {
        // 步间等待：给上游留冷却窗口（顺序不并发，等待也顺带让后面的任务不撞前面的退避）
        const wait = CHAIN_GAP_MS + Math.floor(Math.random() * 5000)
        chain.waitUntil = Date.now() + wait
        await new Promise((r) => setTimeout(r, wait))
        chain.waitUntil = 0
      }
    }
    chain.step = ''
  })()
    .catch((err) => {
      chain.error = err.message
    })
    .finally(() => {
      chain.waitUntil = 0
      chain.running = false
      chain.finishedAt = Date.now()
      if (running === chain.id) running = ''
      // 记「结束时刻」而不是开始时刻：链路本身要跑五六分钟，按开始算等于只隔了三四分钟
      markChainRun()
      try {
        logChain(chain)
      } catch (err) {
        console.warn('[wb-activity] 一键完成记账失败:', err.message)
      }
    })

  return { ok: true, run: publicRun(chain) }
}

/** 一次运行的一句话结果（汇总行与链路 step 共用同一个口径） */
function summarizeRun(run) {
  const s = run.summary
  const parts = []
  if (s) {
    if (s.total != null) parts.push(`共 ${s.total}`)
    if (s.accounts != null) parts.push(`账号 ${s.accounts}`)
    if (s.ok != null) parts.push(`成功 ${s.ok}`)
    if (s.already) parts.push(`已做 ${s.already}`)
    if (s.na) parts.push(`不适用 ${s.na}`)
    if (s.pending) parts.push(`待续 ${s.pending}`)
    if (s.skip) parts.push(`跳过 ${s.skip}`)
    if (s.fail) parts.push(`失败 ${s.fail}`)
    if (s.credit) parts.push(`脚本口径 +${s.credit} 积分`)
  }
  if (run.error) return `失败：${run.error}`
  return parts.length ? parts.join(' · ') : '执行完成'
}

/** 一键完成的汇总条目：六步各自的汇总行之外，再记一条「总账」 */
function logChain(chain) {
  const done = chain.steps.filter((s) => s.state === 'done').length
  const failed = chain.steps.filter((s) => s.state === 'fail').length
  const took = chain.finishedAt ? `${((chain.finishedAt - chain.startedAt) / 1000).toFixed(1)} 秒` : ''
  const bits = [`六步（${chain.steps.map((s) => s.label).join(' / ')}）跑完 ${done} 步`]
  if (failed) bits.push(`失败 ${failed} 步`)
  if (chain.deltaTotal) bits.push(`合计 ${chain.deltaTotal > 0 ? '+' : ''}${chain.deltaTotal} 积分（余额口径）`)
  if (chain.throttled) bits.push(`命中限流信号「${chain.throttled}」，已停下并进入 ${Math.round(CHAIN_COOL_MS / 60000)} 分钟冷却`)
  bits.push(`耗时 ${took}`)
  pushEntry({
    task: CHAIN.id,
    source: 'panel',
    runId: chain.id,
    at: chain.finishedAt || Date.now(),
    id: entryId(['run', chain.id, chain.startedAt, 'all']),
    account: '全体账号',
    uid8: '',
    nickname: '',
    delta: chain.deltaTotal || null,
    before: null,
    after: null,
    text: chain.error ? `一键完成失败：${chain.error}` : `一键完成：${bits.join('，')}`,
    tone: chain.error || failed || chain.throttled ? (chain.throttled ? 'warn' : 'fail') : 'ok',
  })
}

/**
 * 立即执行一个任务（后台跑，立刻返回运行对象）；`all` = 一键完成全部。
 *
 * 不重写上游调用：签到用 signin_bin、活跃/旅行/保活用网关自带的同类 CLI、
 * 开学季与夜猫子直接用网关排程跑的那两个 Python 脚本。这里只做四件事：
 * 拼命令行、解析输出、写活动日志、按限流信号踩刹车。
 */
export function startRun(id, { uidPrefix = '', force = false } = {}) {
  const miss = needsDir()
  if (miss) return { ok: false, error: miss }
  if (id === CHAIN.id) return startChain({ uidPrefix, force })
  const meta = taskMeta(id)
  if (!meta) return { ok: false, error: `未知任务：${id}` }
  if (running) return { ok: false, error: `已有任务在跑（${running}），等它跑完再点` }
  const blocked = cooldownBlock(id, force)
  if (blocked) return { ok: false, error: blocked }
  const spec = runnerFor(id, uidPrefix)
  if (!spec) return { ok: false, error: `未知任务：${id}` }
  const pre = buildCmd(spec)
  if (pre.error) return { ok: false, error: pre.error }

  const run = createRun(id, spec.title, uidPrefix)
  running = run.id
  ;(async () => {
    await execute(run, spec, meta)
  })()
    .catch((err) => {
      run.error = err.message
    })
    .finally(() => finalize(run))

  return { ok: true, run: publicRun(run) }
}

/** 两次积分快照的差：{uid: {before, after, delta}} */
function diffCredits(before, after) {
  if (!before?.byUid || !after?.byUid) return null
  const out = {}
  for (const [uid, afterVal] of Object.entries(after.byUid)) {
    const beforeVal = before.byUid[uid]
    if (beforeVal == null) continue
    out[uid] = { before: beforeVal, after: afterVal, delta: afterVal - beforeVal }
  }
  return out
}

/** 把一次运行写成活动日志条目（逐账号若干行 + 一条汇总行，与网关排程同一形状） */
function logRun(run) {
  const meta = taskMeta(run.task) ?? { id: run.task, label: run.task }
  const base = { task: run.task, source: 'panel', runId: run.id, at: run.finishedAt || Date.now() }
  const deltaMap = run.creditsDelta ?? null

  if (meta.logItems !== 'summary') {
    const names = run.names ?? {}
    for (const it of run.items ?? []) {
      const key = it.uid || it.uid8 || it.account
      if (!key) continue
      const d = deltaMap && it.uid ? deltaMap[it.uid] : null
      // 脚本只给 uid8 时，用积分快照里的昵称把账号名补上（没有就保持 uid8）
      const nickname = it.nickname || names[it.uid8] || ''
      const bits = [it.text].filter(Boolean)
      if (d) bits.push(`余额 ${d.before} → ${d.after}（${d.delta >= 0 ? '+' : ''}${d.delta}）`)
      pushEntry({
        ...base,
        id: entryId(['run', run.id, run.startedAt, key]),
        account: nickname || it.account || accountLabel(it),
        uid8: it.uid8 || String(it.uid ?? '').slice(0, 8),
        nickname,
        delta: d ? d.delta : (it.delta ?? null),
        before: d?.before ?? null,
        after: d?.after ?? it.after ?? null,
        text: bits.join('，'),
        tone: it.tone ?? (it.ok === false ? 'fail' : 'ok'),
      })
    }
  }

  const took = run.finishedAt ? `${((run.finishedAt - run.startedAt) / 1000).toFixed(1)} 秒` : ''
  const totalDelta = runDelta(run)
  const head = run.error ? `执行失败：${run.error}` : `${summarizeRun(run)}（手动执行）`
  pushEntry({
    ...base,
    id: entryId(['run', run.id, run.startedAt, 'all']),
    account: '全体账号',
    uid8: '',
    nickname: '',
    delta: totalDelta || null,
    before: null,
    after: null,
    text: `${head}${took ? `，耗时 ${took}` : ''}`,
    tone: run.error ? 'fail' : 'ok',
  })
}

/** 对外暴露的运行对象：去掉大字段（items / raw / 昵称表要按需取） */
function publicRun(t) {
  return { ...t, items: undefined, raw: undefined, creditsDelta: undefined, names: undefined, deltaTotal: runDelta(t) }
}

/** 一次运行的积分合计（有余额对照用余额口径，否则用脚本/CLI 自己报的） */
function runDelta(t) {
  if (t.creditsDelta) {
    return Object.values(t.creditsDelta).reduce((a, x) => a + x.delta, 0)
  }
  return (t.items ?? []).reduce((a, x) => a + (Number(x.delta) || 0), 0)
}

export function runsList({ limit = 20 } = {}) {
  return { ok: true, running, runs: runs.slice(-Math.max(1, limit)).reverse().map(publicRun) }
}

export function runGet(id) {
  const t = runs.find((x) => x.id === id)
  if (!t) return { ok: false, error: '运行记录不存在或已被挤出（只保留边车本次运行的前 50 条）' }
  return { ok: true, run: t }
}

/* ========================================================== 排程开关 === */

/** 下一次整点触发（与 Go scheduler 的 nextFire 同口径：本地时区） */
function nextFire(hours, now = new Date()) {
  let best = null
  for (const h of hours ?? []) {
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, 0, 0, 0)
    const at = t > now ? t : new Date(t.getTime() + 86400000)
    if (!best || at < best) best = at
  }
  return best ? best.getTime() : null
}

/** 读网关 config.json（只读；写走 saveSchedule） */
function configDoc() {
  const file = path.join(gatewayDir(), 'config.json')
  try {
    const raw = fs.readFileSync(file, 'utf8')
    return { path: file, exists: true, raw, doc: JSON.parse(raw) }
  } catch (err) {
    return { path: file, exists: false, raw: '', doc: null, error: err.message }
  }
}

/**
 * 「最近一次」怎么算：网关排程的活跃/旅行**没有汇总行**（Go 侧只在签到结束打一行
 * `checkin done`），只有一串逐账号行。所以按时间聚批：以最后一条为界往前 15 分钟内
 * 的同任务条目算作同一次，再数账号数与失败数。
 *
 * 优先用真实存在的汇总行（一次运行的落款，网关的 `checkin done` 与手动跑的都写了），
 * 没有才用聚批结果 —— 不把聚批数字冒充成官方汇总。
 */
function lastRunOf(entries, taskId) {
  const list = entries.filter((e) => e.task === taskId)
  if (!list.length) return null
  const last = list[list.length - 1]
  const batch = list.filter((e) => e.at >= last.at - 15 * 60 * 1000)
  const aggregate = [...batch].reverse().find((e) => e.account === '全体账号')
  if (aggregate) {
    return { at: aggregate.at, text: aggregate.text, tone: aggregate.tone, source: aggregate.source }
  }
  const accounts = new Set(batch.filter((e) => e.account && e.account !== '全体账号').map((e) => e.account))
  const failN = batch.filter((e) => e.tone === 'fail').length
  const bits = [`${accounts.size} 个账号有记录`]
  if (failN) bits.push(`失败 ${failN} 条`)
  else bits.push('无失败')
  return { at: last.at, text: `${bits.join(' · ')}（按日志聚批）`, tone: failN ? 'warn' : 'ok', source: last.source }
}

/** 任务表 + 当前开关 + 下次触发 + 最近一次结果（「活动管理」那一块的数据） */
export function schedule() {
  const miss = needsDir()
  if (miss) return { ok: false, error: miss, tasks: [], extra: EXTRA_ACTIONS, chain: chainState() }
  const cfg = configDoc()
  const sched = cfg.doc?.schedule ?? {}
  const entries = loadStore().entries
  const tasks = TASKS.map((t) => {
    const enabled = sched[t.enabledKey] !== false
    const hours = Array.isArray(sched[t.hoursKey]) ? sched[t.hoursKey] : []
    const nowRunning = runs.find((r) => r.task === t.id && r.running)
    const last = lastRunOf(entries, t.id)
    return {
      id: t.id,
      label: t.label,
      hint: t.hint,
      enabled,
      enabledKey: t.enabledKey,
      hoursKey: t.hoursKey,
      hours,
      nextAt: enabled ? nextFire(hours) : null,
      last: nowRunning
        ? { at: nowRunning.startedAt, text: '正在跑…', tone: 'info', source: 'panel', running: true }
        : last,
    }
  })
  return {
    ok: true,
    tasks,
    extra: EXTRA_ACTIONS,
    chain: chainState(),
    configPath: cfg.path,
    configExists: cfg.exists,
    configError: cfg.doc ? '' : cfg.error ?? '',
    python: pythonBin(),
  }
}

/** 允许改的键（白名单：只动 schedule 段的这几个键，其余一律不碰） */
const WRITABLE = new Set(
  [...TASKS.flatMap((t) => [t.enabledKey, t.hoursKey]), 'activity_report_count'],
)

/**
 * 保存任务开关（写网关 config.json 的 schedule 段），可选顺手重启网关。
 *
 * 为什么必须重启：网关只在**启动时**读一次 schedule 来构建调度器，改文件不重启不生效
 * （与「加账号要重启」同一条约束 —— 账号有 5s 目录监听，schedule 没有）。所以页面上
 * 那个按钮叫「保存并应用」。
 */
export async function saveSchedule(patch, { restart = true } = {}) {
  const miss = needsDir()
  if (miss) return { ok: false, error: miss }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'patch 必须是对象' }
  }
  const unknown = Object.keys(patch).filter((k) => !WRITABLE.has(k))
  if (unknown.length) return { ok: false, error: `不支持改这些键：${unknown.join(', ')}` }
  if (!Object.keys(patch).length) return { ok: false, error: '没有要改的项' }

  const cfg = configDoc()
  if (!cfg.exists) return { ok: false, error: `读不到网关配置：${cfg.path}` }
  if (!cfg.doc) return { ok: false, error: `网关配置不是合法 JSON：${cfg.error ?? ''}` }

  const doc = { ...cfg.doc, schedule: { ...(cfg.doc.schedule ?? {}) } }
  for (const [k, v] of Object.entries(patch)) {
    if (k.endsWith('_hours')) {
      const hours = String(v ?? '')
        .split(/[,\s]+/)
        .filter(Boolean)
        .map(Number)
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= 23)
      doc.schedule[k] = [...new Set(hours)].sort((a, b) => a - b)
    } else if (k === 'activity_report_count') {
      doc.schedule[k] = Math.max(1, Math.min(20, Number(v) || 1))
    } else {
      doc.schedule[k] = v === true || v === 'true'
    }
  }

  // 与 workbuddy-ops.configSave 同一条规矩：第一次保存前留一份 .ws.bak
  const backup = `${cfg.path}.ws.bak`
  try {
    if (!fs.existsSync(backup)) fs.copyFileSync(cfg.path, backup)
  } catch (e) {
    return { ok: false, error: `备份失败，已中止保存：${e.message}` }
  }
  try {
    const tmp = `${cfg.path}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, cfg.path)
  } catch (e) {
    return { ok: false, error: `写入失败：${e.message}` }
  }

  if (!restart) return { ok: true, saved: true, needsRestart: true }

  // 与 workbuddy-ops.restartGateway 逐字同序：先停（确认端口释放），再起
  const stop = await wb.stopService()
  if (!stop.ok) return { ok: false, saved: true, error: `配置已保存，但停止网关失败：${stop.error}` }
  const start = await wb.startService()
  if (!start.ok) return { ok: false, saved: true, error: `配置已保存，网关已停止但启动失败：${start.error}` }
  return { ok: true, saved: true, restarted: true, waitedMs: start.waitedMs ?? 0 }
}

/* ============================================================ 日志查询 === */

/**
 * 活动日志：先把网关日志里的新行并进来，再按条件过滤。
 * 默认按时间倒序（最新在前），最多 limit 条。
 */
export function activityLog({ limit = 100, task = '', onlyCredit = false, day = '' } = {}) {
  const ingest = ingestGatewayLog()
  const s = loadStore()
  let items = s.entries
  if (task) items = items.filter((e) => e.task === task)
  if (onlyCredit) items = items.filter((e) => Number.isFinite(e.delta) && e.delta !== 0)
  if (day) {
    const start = new Date(`${day}T00:00:00`).getTime()
    if (Number.isFinite(start)) items = items.filter((e) => e.at >= start && e.at < start + 86400000)
  }
  const counts = {}
  for (const e of s.entries) counts[e.task] = (counts[e.task] ?? 0) + 1
  return {
    ok: true,
    items: items.slice(-Math.max(1, limit)).reverse(),
    total: items.length,
    stored: s.entries.length,
    // 全体账号 / 一键完成是上面逐账号行的加总，再加一次就重复计账
    totalDelta: items.reduce(
      (a, e) => a + (e.account !== '全体账号' && Number.isFinite(e.delta) ? e.delta : 0),
      0,
    ),
    counts,
    ingested: ingest.added ?? 0,
    gatewayLog: ingest.file ?? gatewayErrLog(),
    gatewayLogError: ingest.ok ? '' : ingest.error ?? '',
    file: dataFile(),
  }
}
