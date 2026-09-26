/**
 * 加固型 JSON 存储工厂。
 *
 * 把 dashboard.mjs 里已经跑通的那套做法抽出来复用，给「要长期保存、且会被智能体写入」的
 * 数据用（背单词词单、学情就是第一个使用者）：
 *
 *   1. 原子写：先写 .tmp 再 rename —— 读到的要么是旧的完整内容、要么是新的完整内容；
 *   2. 回退链：解析失败时在「.bak / 每日快照」里按 updatedAt 取最新一份，而不是当空数据；
 *   3. 留证：坏文件另存 .corrupt-<时间>，不覆盖，方便人工抢救；
 *   4. 每日快照：backups/<name>-YYYY-MM-DD.json，保留最近 N 份；
 *   5. 版本号 + migrate()：改结构时老文件能升上来，而不是被默默丢掉；
 *   6. rev 乐观并发：写入可带 baseRev，与磁盘 rev 不一致说明别处（另一个智能体 / 另一个窗口）
 *      也改过 —— 把对方那一版另存 .conflict-<时间> 再写。后写仍然覆盖（本机单用户，
 *      不让写入失败更省心），但对方的内容有据可查，不会静默消失。
 *
 * 边界说明（别把风险想错）：
 *   写入是同步的（writeFileSync + renameSync），Node 事件循环不会在一段同步代码中间切走，
 *   所以同一进程内「Web 与 MCP 同时写」天然串行，不需要锁。真正的风险是进程被杀 / 磁盘满
 *   导致文件停在写了一半的状态 —— 那正是第 1、2、3 条要解决的。
 */
import fs from 'node:fs'
import path from 'node:path'
import { readJSON } from './net.mjs'

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** 本地日期 YYYY-MM-DD */
export function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 原子写：同盘 rename 是原子的，读者看不到半截内容 */
export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 创建一个加固型 JSON 存储。
 *
 * @param {object} opts
 * @param {string} opts.name       用于备份/快照文件名的前缀，如 'vocab-lists'
 * @param {() => string} opts.file 数据文件绝对路径（函数形式，便于懒算配置）
 * @param {number} opts.version    当前结构版本
 * @param {() => object} opts.empty 空数据结构（含 version/rev/updatedAt）
 * @param {(raw: object) => object} opts.migrate 结构迁移 + 归一化
 * @param {() => string} opts.backupDir 快照与冲突副本目录
 * @param {number} [opts.backupKeep=30] 每日快照保留份数
 * @param {number} [opts.conflictKeep=20] 冲突副本保留份数
 * @param {number} [opts.snapshotRefreshMs] 同一天快照的重写间隔
 */
export function createJsonStore({
  name,
  file,
  version = 1,
  empty,
  migrate,
  backupDir,
  backupKeep = 30,
  conflictKeep = 20,
  snapshotRefreshMs = 60 * 60 * 1000,
}) {
  const snapRe = new RegExp(`^${escapeRe(name)}-\\d{4}-\\d{2}-\\d{2}\\.json$`)
  const conflictPrefix = `${path.basename(name)}-conflict-`

  /** 内存里最后一份「确认可解析」的数据；写前用它判断是否需要留 .bak */
  let lastGood = null
  /** 今天是否已经写过快照 */
  let snapshotDay = null

  function dir() {
    return backupDir()
  }

  /** 保留最近 N 份快照；冲突副本与坏文件留证放在数据文件旁边，也要清理 */
  function prune() {
    const d = dir()
    try {
      const files = fs.readdirSync(d)
      const snaps = files.filter((f) => snapRe.test(f)).sort()
      for (const f of snaps.slice(0, Math.max(0, snaps.length - backupKeep))) {
        fs.unlinkSync(path.join(d, f))
      }
      const conflicts = files.filter((f) => f.startsWith(conflictPrefix)).sort()
      for (const f of conflicts.slice(0, Math.max(0, conflicts.length - conflictKeep))) {
        fs.unlinkSync(path.join(d, f))
      }
    } catch {
      /* 清理失败不影响主流程 */
    }
    // 数据文件同目录下的 .conflict / .corrupt 副本（preserve() 写在那里，方便就近排查）
    try {
      const dataDir = path.dirname(file())
      const base = path.basename(file())
      const side = fs.readdirSync(dataDir).filter((f) => f.startsWith(`${base}.conflict-`)).sort()
      for (const f of side.slice(0, Math.max(0, side.length - conflictKeep))) {
        fs.unlinkSync(path.join(dataDir, f))
      }
    } catch {
      /* 同上 */
    }
  }

  /** 最近一份可用快照 */
  function latestSnapshot() {
    try {
      const d = dir()
      const files = fs.readdirSync(d).filter((f) => snapRe.test(f)).sort()
      for (let i = files.length - 1; i >= 0; i -= 1) {
        const f = path.join(d, files[i])
        const data = readJSON(f, null)
        if (isPlainObject(data)) return { file: f, data }
      }
    } catch {
      /* 没有快照目录就当没有 */
    }
    return null
  }

  /** 每天留一份快照；同一天超过刷新间隔才重写，兼顾历史留存与够新 */
  function snapshotDaily(data) {
    const day = todayStr()
    try {
      const d = dir()
      fs.mkdirSync(d, { recursive: true })
      const f = path.join(d, `${name}-${day}.json`)
      const fresh = fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < snapshotRefreshMs
      if (snapshotDay === day && fresh) return
      writeAtomic(f, JSON.stringify(data, null, 2))
      snapshotDay = day
      prune()
    } catch (err) {
      console.warn(`[${name}] 快照写入失败：${err.message}`)
    }
  }

  /** 把当前磁盘文件另存一份带后缀的副本（.corrupt / .conflict），失败不抛 */
  function preserve(kind) {
    const f = file()
    try {
      if (!fs.existsSync(f)) return null
      const dest = `${f}.${kind}-${Date.now()}`
      fs.copyFileSync(f, dest)
      return dest
    } catch {
      return null
    }
  }

  /** 读：永远返回一份结构合法的数据，并尽量不丢东西 */
  function read() {
    const f = file()
    const raw = readJSON(f, null)
    if (isPlainObject(raw)) {
      lastGood = migrate(raw)
      return lastGood
    }
    if (!fs.existsSync(f)) {
      lastGood = migrate(empty())
      return lastGood
    }

    // 文件在、但解析不出来 —— 坏了。绝不能静默当空数据处理（那样下一次写入就把它盖掉了）。
    console.error(`[${name}] ${f} 解析失败：文件可能被写坏（进程中断 / 磁盘满）`)
    const keep = preserve('corrupt')
    if (keep) console.error(`[${name}] 坏文件已另存为 ${path.basename(keep)}`)

    const candidates = []
    const bak = readJSON(`${f}.bak`, null)
    if (isPlainObject(bak)) candidates.push({ from: `${path.basename(f)}.bak`, data: bak })
    const snap = latestSnapshot()
    if (snap) candidates.push({ from: `每日快照 ${path.basename(snap.file)}`, data: snap.data })

    if (candidates.length) {
      candidates.sort((a, b) => (Number(b.data.updatedAt) || 0) - (Number(a.data.updatedAt) || 0))
      const best = candidates[0]
      console.error(`[${name}] 已回退到${best.from}（${candidates.length} 份候选中取最新）`)
      lastGood = migrate(best.data)
      try {
        writeAtomic(f, JSON.stringify(lastGood, null, 2))
        console.error(`[${name}] 主文件已按回退数据修复`)
      } catch (err) {
        console.error(`[${name}] 主文件修复失败：${err.message}`)
      }
      return lastGood
    }

    console.error(`[${name}] 没有任何可回退的副本，本次按空数据处理（坏文件已保留，请人工检查）`)
    lastGood = migrate(empty())
    return lastGood
  }

  /**
   * 写：带上 rev 与写入者标记。
   * @param {object} next 新的业务数据（rev/version/updatedAt 由本函数维护，传进来会被覆盖）
   * @param {{ baseRev?: number, source?: string }} [opts] baseRev=写入方读到的版本号
   * @returns {{ data: object, conflict: null | { expected: number, given: number, copy: string|null }, prevRev: number }}
   */
  function write(next, { baseRev, source = 'unknown' } = {}) {
    const cur = read()
    const prevRev = Number(cur.rev) || 0
    let conflict = null

    if (baseRev !== undefined && baseRev !== null && Number(baseRev) !== prevRev) {
      const copy = preserve('conflict')
      conflict = { expected: prevRev, given: Number(baseRev), copy: copy ? path.basename(copy) : null }
      console.warn(
        `[${name}] rev 不一致（磁盘 ${prevRev}，写入方认为 ${baseRev}）：对方版本已另存 ${conflict.copy ?? '(留证失败)'}，本次按其内容覆盖`,
      )
    }

    const data = { ...next, version, rev: prevRev + 1, updatedAt: Date.now(), savedBy: source }
    const f = file()
    // 写前把「当前磁盘上那份」留作回退副本（它已被 read() 验证过可解析）
    if (lastGood && fs.existsSync(f)) {
      try {
        fs.copyFileSync(f, `${f}.bak`)
      } catch {
        /* 备份失败不阻断写入 */
      }
    }
    writeAtomic(f, JSON.stringify(data, null, 2))
    lastGood = data
    snapshotDaily(data)
    return { data, conflict, prevRev }
  }

  /** 存储自检信息（给 /api/vocab/snapshot 与排查用） */
  function summary() {
    const f = file()
    let exists = false
    let bytes = 0
    let modifiedAt = 0
    try {
      const st = fs.statSync(f)
      exists = true
      bytes = st.size
      modifiedAt = st.mtimeMs
    } catch {
      /* 文件还不存在 */
    }
    const data = read()
    return {
      file: f,
      exists,
      bytes,
      modifiedAt,
      rev: Number(data.rev) || 0,
      updatedAt: Number(data.updatedAt) || 0,
      savedBy: data.savedBy ?? null,
    }
  }

  return { name, version, path: file, backupDir, read, write, summary }
}
