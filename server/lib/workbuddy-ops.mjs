/**
 * WorkBuddy 运维面 —— 账号池明细、网页登录、网关配置、测聊。
 *
 * 与 workbuddy.mjs 的分工：
 *   workbuddy.mjs 只负责「读」：额度、统计、日志、模型清单，页面打开就能看；
 *   本模块只负责「动」：会改文件、会出网、会重启网关的动作，全部要用户显式点。
 *   活动类动作（六类排程任务的手动执行与逐账号明细）在 workbuddy-activity.mjs。
 *
 * 为什么几乎都复用网关自带的 CLI（login / acct，以及 activity 那边的 signin_bin /
 * activity_bin / travel_bin / keepalive_bin / trial_bin / credit），
 * 而不是在 Node 里把上游调用重写一遍：
 *   realm 路由（国内版 / 国际版）、刷新时机、签到幂等码、积分包聚合口径，
 *   在网关本体（Go）里都有单一实现。重写一份只会多出一处不同步 ——
 *   这也是本仓库对 credit.exe 的既有立场（见 workbuddy.mjs 头注）。
 *
 * 网关目录由 `config.workbuddy.dir` 指定，**留空 = 没配**：那时下面每个动作都给同一句提示，
 * 不去别处瞎读，也不假装账号池是空的。
 *
 * 本模块所有「写」都遵守两条：
 *   1. 只动网关自己规定的两个位置：auths/ 与 config.json；
 *   2. 破坏性动作要显式确认串（删账号要 confirm=uid，配置覆盖前先留一份 .ws.bak）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { request, runHidden } from './net.mjs'
import * as wb from './workbuddy.mjs'

/** 网关目录下的可执行文件（Windows 路径） */
function exe(name) {
  return path.join(wb.gatewayDir(), name).replace(/\//g, '\\')
}

function authsDir() {
  return path.join(wb.gatewayDir(), 'auths')
}

function configPath() {
  return path.join(wb.gatewayDir(), 'config.json')
}

/** 网关目录没配时的统一提示（空串 = 配了） */
function needsDir() {
  return wb.gatewayDir()
    ? ''
    : '还没配网关目录：到「网关配置」页填 config.workbuddy.dir（网关是你自己装的那一份，不随本仓库分发）'
}

/** 命令行里的路径要带引号：网关目录可能带空格甚至非 ASCII 字符 */
function q(s) {
  return `"${String(s).replace(/"/g, '""')}"`
}

/* ============================================================ 账号池 === */

/**
 * 读 auths/ 目录（不落盘、不出网）。
 *
 * 兼容两种历史格式：嵌套 {"account":{},"auth":{}}（现在写的）与扁平 {accessToken,...}
 * （早期版本写的）。解析失败的文件不抛异常，而是进 issues —— 一个坏文件不该让整页打不开，
 * 但也不能假装它不存在（网关会因为同样的原因少加载一个号）。
 */
export function readAuthFiles() {
  const dir = authsDir()
  const items = []
  const issues = []
  let names
  try {
    names = fs.readdirSync(dir)
  } catch (err) {
    return { items, issues: [`读不到凭证目录 ${dir}：${err.message}`], dir }
  }
  for (const name of names) {
    if (!/^workbuddy.*\.json$/i.test(name)) continue
    const full = path.join(dir, name)
    try {
      const raw = fs.readFileSync(full, 'utf8')
      if (!raw.trim()) throw new Error('空凭证文件')
      const doc = JSON.parse(raw)
      const acct = doc.account ?? doc
      const auth = doc.auth ?? doc
      if (!auth.accessToken) throw new Error('缺少 accessToken')
      const expiresAt = Number(auth.expiresAt) || 0
      const stat = fs.statSync(full)
      items.push({
        file: name,
        uid: String(acct.uid ?? ''),
        nickname: String(acct.nickname ?? ''),
        enterpriseId: String(acct.enterpriseId ?? ''),
        realm: String(auth.realm ?? ''),
        domain: String(auth.domain ?? ''),
        expiresAt,
        // expiresAt<=0 表示「查不到有效期」，不能当成已过期 —— 与网关 NeedsRefresh 同口径
        expired: expiresAt > 0 && Date.now() >= expiresAt * 1000,
        needsRefresh: expiresAt <= 0 || Date.now() >= (expiresAt - 600) * 1000,
        mtime: stat.mtimeMs,
        bytes: stat.size,
      })
    } catch (err) {
      issues.push(`${name}：${err.message}`)
    }
  }
  items.sort((a, b) => a.uid.localeCompare(b.uid))
  return { items, issues, dir }
}

/** 网关 config.json 是否开了 admin 端点（账号停用/启用/复活要用它，默认关闭） */
export function adminEnabled() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'))?.admin?.enabled === true
  } catch {
    return false
  }
}

/**
 * 账号池合并视图：网关内存状态（谁在冷却、谁被停用）× 凭证文件（谁的有效期到什么时候）×
 * 积分缓存（还剩多少）。
 *
 * 三个来源必须分开标出来源，因为「不在池里」有三种完全不同的原因：
 * 文件坏了 / 网关还没重扫 auths（要重启）/ 账号被停用。混成一句「异常」等于没信息。
 */
export async function accounts() {
  const miss = needsDir()
  if (miss) return { ok: false, error: miss, rows: [], issues: [], summary: null }
  const [st, quick] = await Promise.all([wb.status(), wb.quick().catch(() => ({ ok: false }))])
  const files = readAuthFiles()
  const creditRows = quick?.ok ? quick.accounts ?? [] : []
  const creditByUid = new Map(creditRows.map((c) => [c.uid, c]))

  const byUid = new Map(files.items.map((f) => [f.uid, f]))
  const rows = []
  const push = (uid, pool, file) => {
    const c = creditByUid.get(uid)
    rows.push({
      uid,
      nickname: pool?.nickname || file?.nickname || (uid ? uid.slice(0, 8) : '未命名'),
      realm: file?.realm || pool?.realm || '',
      domain: file?.domain || '',
      // 池里 = 网关已加载并在参与轮转；有文件但不在池里 = 需要重启网关
      inPool: !!pool,
      hasFile: !!file,
      credits: pool?.credits ?? null,
      manualDisabled: !!pool?.manualDisabled,
      disabled: !!pool?.disabled,
      cooling: !!pool?.cooling,
      coolingUntil: pool?.coolingUntil ?? '',
      inFlight: pool?.inFlight ?? 0,
      consecutiveFails: pool?.consecutiveFails ?? 0,
      breakerFails: pool?.breakerFails ?? 0,
      lastSuccess: pool?.lastSuccess ?? '',
      lastErr: pool?.lastErr ?? '',
      // 积分包（上游口径）：查失败时保持 null，不要拿 0 冒充「已用尽」
      remain: c && !c.error ? (c.remain ?? 0) : null,
      size: c && !c.error ? (c.size ?? 0) : null,
      used: c && !c.error ? (c.used ?? null) : null,
      packages: c?.packages ?? 0,
      creditError: c?.error ?? null,
      expiresAt: file?.expiresAt ?? 0,
      expired: !!file?.expired,
      needsRefresh: !!file?.needsRefresh,
      file: file?.file ?? '',
      fileBytes: file?.bytes ?? 0,
    })
  }
  for (const a of st.accounts ?? []) {
    const f = byUid.get(a.uid)
    byUid.delete(a.uid)
    push(a.uid, a, f)
  }
  // 有凭证文件但网关没加载：几乎总是「加号之后没重启网关」
  for (const f of byUid.values()) push(f.uid, null, f)

  rows.sort((a, b) => {
    const rank = (r) => (r.disabled || r.manualDisabled ? 2 : r.cooling ? 1 : 0)
    return rank(a) - rank(b) || a.nickname.localeCompare(b.nickname)
  })

  const expiringSoon = rows.filter((r) => r.hasFile && r.expiresAt > 0 && !r.expired && r.needsRefresh)
  return {
    ok: true,
    rows,
    issues: files.issues,
    dir: files.dir,
    adminEnabled: adminEnabled(),
    summary: {
      total: rows.length,
      inPool: rows.filter((r) => r.inPool).length,
      notLoaded: rows.filter((r) => !r.inPool).length,
      cooling: rows.filter((r) => r.cooling).length,
      disabled: rows.filter((r) => r.disabled || r.manualDisabled).length,
      expired: rows.filter((r) => r.expired).length,
      expiringSoon: expiringSoon.length,
      brokenFiles: files.issues.length,
    },
    creditStale: quick?.creditStale ?? true,
    creditAt: quick?.creditAt ?? 0,
  }
}

/* ======================================================== 单账号动作 === */

/**
 * 账号停用 / 启用 / 复活 —— 走网关自己的运维端点（/admin/accounts/{uid}/{op}）。
 *
 * 为什么不直接改 state.json：手动停用是**运行中进程的内存状态**，由池的定时 flush 落盘，
 * 外部改文件会在下一次 flush 被覆盖（网关 cmd/acct 的注释里写明了这条）。
 * admin.enabled=false 时这些端点一律 404 —— 那时如实告诉用户开关在哪，不假装成功。
 */
export async function accountAdmin(uid, op) {
  const ops = { disable: 'disable', enable: 'enable', revive: 'revive' }
  if (!ops[op]) return { ok: false, error: `未知动作：${op}` }
  if (!adminEnabled()) {
    return {
      ok: false,
      error: '网关没开运维端点（config.json 的 admin.enabled 目前不是 true）',
      hint: '到「网关配置」页把 admin.enabled 打开并重启网关，再用这个按钮',
    }
  }
  const cred = wb.credential({ reveal: true })
  if (!cred.ok) return { ok: false, error: cred.error }
  const res = await request(`${wb.gatewayBase()}/admin/accounts/${encodeURIComponent(uid)}/${op}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cred.key}`, 'Content-Type': 'application/json' },
    body: {},
    timeout: 10000,
  })
  if (!res.ok) {
    return { ok: false, error: res.json?.error?.message ?? res.error ?? `HTTP ${res.status}` }
  }
  return { ok: true, data: res.json }
}

/* ============================================================ 批量任务 ===
   签到 / 活跃 / 旅行 / 保活 / 开学季 / 夜猫子与两个一次性动作，已经搬到
   workbuddy-activity.mjs —— 那里除了「跑一次」还负责逐账号明细的解析与活动日志落盘。
   这一页的接口在 index.mjs 里改指向 wbActivity，本文件不再保留任务登记表。 */

/* ========================================================= 网页登录 === */

/**
 * OAuth 设备码登录，分两步（与网关 login.sh 同一个流程、同一个 login.exe）：
 *   start → 拿授权 URL 给用户点，state 由 login.exe 落在系统临时目录；
 *   poll  → 每次调一次上游查登录是否完成，成功则打印 token+账号 JSON。
 *
 * 落盘格式与网关逐字一致（{"account":{...},"auth":{...}}，1 空格缩进），
 * 否则网关下次启动读不回来。写完**必须重启网关**才会加载新账号 —— 网关只在启动时扫 auths/。
 */
export async function loginStart(realm = 'cn') {
  const miss = needsDir()
  if (miss) return { ok: false, error: miss }
  const bin = exe('login.exe')
  if (!fs.existsSync(bin)) {
    return { ok: false, error: '找不到 login.exe（网关目录里没有这个文件，或还没 build）' }
  }
  const r = await runHidden(`${q(bin)} --realm=${realm} url`, { cwd: wb.gatewayDir(), timeout: 40000 })
  const url = (String(r.stdout ?? '').match(/https?:\/\/[^\s"'<>]+/) ?? [])[0]
  if (!url) {
    const msg = stripLogPrefix(String(r.stderr ?? r.stdout ?? '').trim().split(/\r?\n/).pop() ?? '')
    return { ok: false, error: msg || '拿不到授权链接（上游可能不可达）' }
  }
  return { ok: true, url, realm, note: '在浏览器打开这个链接完成登录，然后回到本页点「查询登录结果」' }
}

export async function loginPoll(realm = 'cn') {
  const miss = needsDir()
  if (miss) return { ok: false, error: miss }
  const bin = exe('login.exe')
  if (!fs.existsSync(bin)) return { ok: false, error: '找不到 login.exe' }
  const r = await runHidden(`${q(bin)} --realm=${realm} poll`, { cwd: wb.gatewayDir(), timeout: 40000 })
  const text = String(r.stdout ?? '').trim()
  // login.exe poll 未完成时以非 0 退出、stdout 无 JSON —— 那是「还没登录」，不是错误
  let doc = null
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    try {
      doc = JSON.parse(s)
    } catch {
      /* 非 JSON 行忽略 */
    }
  }
  if (!doc) {
    const msg = stripLogPrefix(
      String(r.stderr ?? '').trim().split(/\r?\n/).filter(Boolean).pop() ?? '',
    )
    // login.exe 的等待提示是写给命令行的（末尾那句「再按 y」在这里没有对应动作），
    // 换成页面上的下一步，其余原文照转
    const friendly = /按\s*y/i.test(msg)
      ? '登录还没完成：浏览器那边走完流程后再回来查（本页也会自动轮询）'
      : msg || '登录还没完成（浏览器那边走完流程后再查）'
    return { ok: true, pending: true, message: friendly }
  }
  const saved = saveAuthFile({
    uid: doc.uid,
    nickname: doc.nickname,
    enterpriseId: doc.enterprise_id,
    accessToken: doc.access_token,
    refreshToken: doc.refresh_token,
    expiresAt: doc.expires_in ? Math.floor(Date.now() / 1000) + Number(doc.expires_in) : 0,
    domain: doc.domain,
    realm: doc.realm || realm,
  })
  if (!saved.ok) return saved
  return { ok: true, uid: doc.uid, nickname: doc.nickname, file: saved.file, needsRestart: true }
}

/* =================================================== 凭证导入 / 删除 === */

const UID_RE = /^[A-Za-z0-9._-]{6,128}$/

/** 统一的 uid 校验（防目录穿越：与网关同一条正则 + 禁 ..） */
function badUid(uid) {
  const s = String(uid ?? '')
  if (!UID_RE.test(s) || s.includes('..')) return `非法 uid：${s || '(空)'}`
  return ''
}

/**
 * 写一个凭证文件（登录 / 手动导入共用）。
 * 只写 auths/workbuddy-<uid>.json，别处一律不碰。
 */
export function saveAuthFile(rec) {
  const uid = String(rec.uid ?? '').trim()
  const err = badUid(uid)
  if (err) return { ok: false, error: err }
  if (!rec.accessToken) return { ok: false, error: '拒绝写入：accessToken 为空' }
  const dir = authsDir()
  const file = path.join(dir, `workbuddy-${uid}.json`)
  const doc = {
    account: { uid, enterpriseId: rec.enterpriseId ?? '', nickname: rec.nickname ?? '' },
    auth: {
      accessToken: rec.accessToken,
      refreshToken: rec.refreshToken ?? '',
      expiresAt: Number(rec.expiresAt) || 0,
      domain: rec.domain ?? '',
      realm: rec.realm ?? 'cn',
    },
  }
  try {
    fs.mkdirSync(dir, { recursive: true })
    // 先写临时文件再 rename：中途失败不会留下半个 JSON 把网关的 LoadDir 弄崩
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 1), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, file)
    return { ok: true, file: path.basename(file) }
  } catch (e) {
    return { ok: false, error: `写入失败：${e.message}` }
  }
}

/**
 * 手动导入：接受三种形态 ——
 *   1. 本仓库写出的嵌套式 {"account":{...},"auth":{...}}；
 *   2. 扁平式 {accessToken, refreshToken, expiresAt, domain, uid, nickname}；
 *   3. login.exe poll 的输出（access_token / refresh_token / expires_in）。
 * 理由：用户手上可能任何一种（旧版网关文件、别处的导出、命令行输出），
 * 让他在粘贴前先自己转换格式只会制造错误。
 */
export function importAccount(text) {
  let doc
  try {
    doc = JSON.parse(String(text ?? '').trim())
  } catch (e) {
    return { ok: false, error: `不是合法 JSON：${e.message}` }
  }
  const acct = doc.account ?? doc
  const auth = doc.auth ?? doc
  const accessToken = auth.accessToken ?? auth.access_token
  if (!accessToken) return { ok: false, error: '缺少 accessToken / access_token' }
  let expiresAt = Number(auth.expiresAt) || 0
  if (!expiresAt && auth.expires_in) expiresAt = Math.floor(Date.now() / 1000) + Number(auth.expires_in)
  const saved = saveAuthFile({
    uid: acct.uid,
    nickname: acct.nickname,
    enterpriseId: acct.enterpriseId ?? doc.enterprise_id,
    accessToken,
    refreshToken: auth.refreshToken ?? auth.refresh_token,
    expiresAt,
    domain: auth.domain,
    realm: auth.realm,
  })
  return saved.ok ? { ...saved, needsRestart: true } : saved
}

/** 删账号：删掉凭证文件本身（网关重启后就真的不在池里了）。要 confirm=uid 才动手。 */
export function deleteAccount(uid, confirm) {
  if (confirm !== uid) return { ok: false, error: '缺少确认参数（confirm 必须等于 uid）' }
  const err = badUid(uid)
  if (err) return { ok: false, error: err }
  const file = path.join(authsDir(), `workbuddy-${uid}.json`)
  if (!fs.existsSync(file)) return { ok: false, error: '该账号没有本地凭证文件' }
  try {
    fs.unlinkSync(file)
    return { ok: true, file: path.basename(file), needsRestart: true }
  } catch (e) {
    return { ok: false, error: `删除失败：${e.message}` }
  }
}

/* ======================================================= 网关配置编辑 === */

const BACKUP_SUFFIX = '.ws.bak'

/**
 * 读网关 config.json（原文 + 解析结果 + 文件元信息）。
 * 原文一起给出去：页面要能切「表单 / 原文」两种编辑方式，而表单没覆盖到的键
 * （当前 config 里还有 school_hours、cat_hours 这些）必须能通过原文原样保留。
 */
export function configGet() {
  const miss = needsDir()
  if (miss) return { ok: false, error: miss, path: '', exists: false, raw: '', doc: null }
  const file = configPath()
  let raw = ''
  let exists = false
  let stat = null
  try {
    raw = fs.readFileSync(file, 'utf8')
    exists = true
    stat = fs.statSync(file)
  } catch {
    /* 文件不在：返回 exists=false，让页面提示去网关目录查，而不是报异常 */
  }
  let doc = null
  let parseError = ''
  if (exists) {
    try {
      doc = JSON.parse(raw)
    } catch (e) {
      parseError = e.message
    }
  }
  const backup = `${file}${BACKUP_SUFFIX}`
  let backupAt = 0
  let backupMadeAt = 0
  try {
    const st = fs.statSync(backup)
    // Windows 的 CopyFile 会**连文件时间一起复制**，所以备份的 mtime 是「内容对应的时刻」
    // （源文件最后改动的时间），不是「备份什么时候建的」。两个都取出来给页面说清楚，
    // 否则会显示成「备份于 8 小时前」，让人以为备份是旧的。
    backupAt = st.mtimeMs
    backupMadeAt = st.birthtimeMs || st.ctimeMs || st.mtimeMs
  } catch {
    /* 还没备份过 */
  }
  return {
    ok: true,
    path: file,
    exists,
    raw,
    doc,
    parseError,
    size: stat?.size ?? 0,
    mtime: stat?.mtimeMs ?? 0,
    backupPath: backup,
    backupAt,
    backupMadeAt,
    adminEnabled: adminEnabled(),
    restartNote: '改完要重启网关才会生效（本页有重启按钮）。',
  }
}

/**
 * 保存配置：**第一次保存前**留一份 .ws.bak（只留一次，之后不再覆盖），
 * 这样「上次能用」的版本永远在，而不会被连续几次试错冲掉。
 */
export function configSave(doc) {
  const miss = needsDir()
  if (miss) return { ok: false, error: miss }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, error: '配置必须是一个 JSON 对象' }
  }
  const file = configPath()
  const backup = `${file}${BACKUP_SUFFIX}`
  let backedUp = false
  try {
    if (fs.existsSync(file) && !fs.existsSync(backup)) {
      fs.copyFileSync(file, backup)
      backedUp = true
    }
  } catch (e) {
    return { ok: false, error: `备份失败，已中止保存：${e.message}` }
  }
  try {
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, file)
    return { ok: true, backedUp, path: file, needsRestart: true }
  } catch (e) {
    return { ok: false, error: `写入失败：${e.message}` }
  }
}

/** 从备份恢复（备份是「保存前的样子」，恢复后同样要重启网关） */
export function configRestore() {
  const file = configPath()
  const backup = `${file}${BACKUP_SUFFIX}`
  if (!fs.existsSync(backup)) {
    return { ok: false, error: '还没有备份（保存过一次配置之后才会生成）' }
  }
  try {
    const raw = fs.readFileSync(backup, 'utf8')
    JSON.parse(raw) // 备份本身合法才恢复，否则会把配置文件弄坏
    fs.copyFileSync(backup, file)
    // Windows 复制会连时间一起带过来，config.json 会显示成「几小时前改的」。
    // 这里把时间戳刷成现在 —— mtime 是给人看的「这份文件什么时候写的」。
    const now = new Date()
    fs.utimesSync(file, now, now)
    return { ok: true, needsRestart: true, size: raw.length }
  } catch (e) {
    return { ok: false, error: `恢复失败：${e.message}` }
  }
}

/* ============================================================ 重启网关 === */

/**
 * 重启网关。改配置、加账号、删账号之后都必须来一下：网关只在启动时扫 auths/ 与 config.json。
 * 先停后起 —— 7863 端口被占着时 start 脚本自己也会拒绝重复启动，硬起只会更乱。
 */
export async function restartGateway() {
  const stop = await wb.stopService()
  if (!stop.ok) return { ok: false, error: `停止失败：${stop.error}` }
  const start = await wb.startService()
  if (!start.ok) return { ok: false, error: `已停止但启动失败：${start.error}` }
  return { ok: true, waitedMs: start.waitedMs ?? 0 }
}

/* ============================================================== 测聊 === */

/**
 * 测聊：把浏览器发来的对话转到网关的 /v1/chat/completions。
 *
 * 走边车而不是让浏览器直连 7863 的理由与全站一致：CORS + 密钥不进前端。
 * 另外这里做了一件额度页做不到的事 —— 把上游的报错原样带回来。
 * 例：`cn:hunyuan-image-alpha-edit` 在目录里但上游回 “Backend [hunyuan-stream] is not
 * supported”，这种「看起来能生图的模型其实不可用」只有真发一次请求才知道。
 */
export function chatHeaders() {
  const cred = wb.credential({ reveal: true })
  if (!cred.ok) return null
  return { Authorization: `Bearer ${cred.key}`, 'Content-Type': 'application/json' }
}

/**
 * 解包网关的错误串。
 *
 * 网关把上游的 JSON 原样塞进 error.message 里（是**字符串套 JSON**），
 * 直接显示就是一大坨带转义的 JSON —— 人眼找不到哪句才是原因。这里剥一层：
 * 拿到 msg（或 displayMsg.zh）当正文，原始串留在 raw 里备查。
 */
export function unwrapGatewayError(raw) {
  const text = String(raw ?? '')
  let inner = null
  const start = text.indexOf('{')
  if (start >= 0) {
    try {
      inner = JSON.parse(text.slice(start))
    } catch {
      inner = null
    }
  }
  if (!inner || typeof inner !== 'object') {
    return { error: text || '未知错误', upstreamCode: '', raw: text }
  }
  const zh = inner.displayMsg?.zh
  const msg = zh || inner.msg || inner.message || text
  const code = inner.code ?? ''
  return {
    error: code ? `${msg}（上游码 ${code}）` : msg,
    upstreamCode: String(code),
    requestId: inner.requestId ?? '',
    raw: text,
  }
}

export function chatBody({ model, messages, temperature, maxTokens, system, stream = false }) {
  const msgs = []
  if (system) msgs.push({ role: 'system', content: String(system) })
  for (const m of messages ?? []) msgs.push({ role: m.role, content: m.content })
  const body = { model, messages: msgs, stream: !!stream }
  if (temperature != null && temperature !== '') body.temperature = Number(temperature)
  if (maxTokens) body.max_tokens = Number(maxTokens)
  return body
}

/** 非流式：一次性拿完整回复（含 usage） */
export async function chat(opts) {
  const headers = chatHeaders()
  if (!headers) return { ok: false, error: '读不到网关 api_key（见网关目录 config.json）' }
  const started = Date.now()
  const res = await request(`${wb.gatewayBase()}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: chatBody({ ...opts, stream: false }),
    timeout: 180000,
  })
  const elapsedMs = Date.now() - started
  const choice = res.json?.choices?.[0]
  if (!res.ok || !choice) {
    const e = res.json?.error
    return {
      ok: false,
      ...unwrapGatewayError(e?.message ?? res.error ?? `HTTP ${res.status}`),
      code: e?.code ?? '',
      elapsedMs,
      raw: res.text?.slice(0, 2000) ?? '',
    }
  }
  return {
    ok: true,
    elapsedMs,
    model: res.json?.model ?? opts.model,
    usage: res.json?.usage ?? null,
    content: choice.message?.content ?? '',
    reasoning: choice.message?.reasoning_content ?? '',
    finishReason: choice.finish_reason ?? '',
  }
}

/**
 * 流式：边车把网关的 SSE 逐帧转发给页面，并补两个页面真正要看的指标 ——
 * 首字延迟（TTFB）与总耗时。帧格式（逐行 data: <json>）：
 *   {"delta":"…"} · {"reasoning":"…"} · {"usage":{…}} · {"error":{…}}
 *   {"done":true,"ttfbMs":N,"elapsedMs":N,"finishReason":"…"}
 * 上游报错也走同一根管子（error 帧），不能既写 HTTP 200 又指望前端去猜。
 */
export async function chatStream(opts, res) {
  const headers = chatHeaders()
  const write = (obj) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`)
    } catch {
      /* 客户端断了：下面 finally 会收尾 */
    }
  }
  if (!headers) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' })
    write({ error: '读不到网关 api_key（见网关目录 config.json）' })
    write({ done: true })
    res.end()
    return 'handled'
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  const ctl = new AbortController()
  // 页面关掉连接就掐上游：不然流会一直挂着占一个 in-flight 名额
  res.on('close', () => ctl.abort())

  const started = Date.now()
  let ttfbMs = 0
  let finishReason = ''
  let usage = null
  try {
    const upstream = await fetch(`${wb.gatewayBase()}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(chatBody({ ...opts, stream: true })),
      signal: ctl.signal,
    })
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '')
      let parsed = null
      try {
        parsed = JSON.parse(text)
      } catch {
        /* 非 JSON 错误体：原文带回去 */
      }
      write({
        ...unwrapGatewayError(parsed?.error?.message ?? (text.slice(0, 800) || `HTTP ${upstream.status}`)),
        gatewayHint: parsed?.error?.gateway_hint ?? '',
        httpStatus: upstream.status,
      })
      return 'handled'
    }

    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const s = line.trim()
        if (!s.startsWith('data:')) continue
        const payload = s.slice(5).trim()
        if (payload === '[DONE]') continue
        let chunk
        try {
          chunk = JSON.parse(payload)
        } catch {
          continue
        }
        if (chunk.error) {
          write({
            ...unwrapGatewayError(chunk.error.message ?? '上游返回错误'),
            gatewayHint: chunk.error.gateway_hint ?? '',
          })
          continue
        }
        const delta = chunk.choices?.[0]?.delta ?? {}
        const content = delta.content ?? ''
        const reasoning = delta.reasoning_content ?? delta.reasoning ?? ''
        // TTFB 只认「有正文」的第一帧：只出推理内容的帧不算首字
        if (content && !ttfbMs) ttfbMs = Date.now() - started
        if (content) write({ delta: content })
        if (reasoning) write({ reasoning })
        if (chunk.usage) usage = chunk.usage
        if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') write({ error: err.message })
  } finally {
    write({ done: true, ttfbMs, elapsedMs: Date.now() - started, finishReason, usage })
    try {
      res.end()
    } catch {
      /* 已经结束 */
    }
  }
  return 'handled'
}
