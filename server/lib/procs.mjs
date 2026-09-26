/**
 * 进程与内存的「手和眼」：采样，以及真要动手的那几个 Win32 调用。
 *
 * 为什么单独一个文件：现在有两处用它 —— 进程守护引擎的判定与
 * 新的 pguard 引擎（真的自己判定、自己动手）。采样口径必须只有一份，否则两个页面
 * 会显示两套数。
 *
 * 成本纪律（这台机器内存紧张，采样不能大手大脚，2026-09-23 实测）：
 *   · 整机 CPU：两次 `os.cpus()` 做差 —— 白拿，不 spawn 任何进程。
 *   · 全进程表：一次 PowerShell `Get-Process`（约 0.6 秒）。**只在需要时才采**：
 *     平时靠整机 CPU 判「要不要细看」，每 30 秒才采一次给开发工具的空闲判定用。
 *     早先的写法把两个 WMI 查询也塞进脚本（Win32_OperatingSystem 1.5s、
 *     PerfFormattedData 0.7s）再加 0.8 秒睡眠，一次要 10 秒 —— 页面根本不敢这么轮询。
 *   · 动作（释放内存 / 关窗口 / 结束进程）：每次都 spawn 一次 PowerShell（Add-Type 编译
 *     P/Invoke，约 0.5–1.5 秒）。动作是低频的，可以接受；**批量做**，一次调用处理一批 pid。
 *
 * 权限边界（普通用户跑边车时，这是硬墙，不是 bug）：
 *   · 释放内存 / 结束进程：只能碰**你自己、且非提权**的进程（OpenProcess 对更高完整性
 *     的目标会被 UIPI 拒掉，报 err 5）。提权的进程（管理员终端、UAC 启动的东西）动不了。
 *   · 清理系统待机列表：需要 SeProfileSingleProcessPrivilege，必然提权 —— 所以它只能
 *     由一个「人点一下 → 弹一次 UAC」的动作触发，不能挂在无人值守的周期里。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { killPid, runHidden, sleep } from './net.mjs'
import { runElevated } from './elevate.mjs'

/* ------------------------------------------------------------- 采样 --- */

let cpuBaseline = null

/** 整机 CPU 占用（%）：两次 `os.cpus()` 快照的差值，窗口 = 距上次调用 */
export function machineCpuPercent() {
  const cpus = os.cpus()
  const snap = { at: Date.now(), busy: 0, total: 0 }
  for (const c of cpus) {
    const t = c.times
    snap.busy += t.user + t.nice + t.sys + t.irq
    snap.total += t.user + t.nice + t.sys + t.irq + t.idle
  }
  const prev = cpuBaseline
  cpuBaseline = snap
  if (!prev) return null
  const dt = snap.at - prev.at
  const dTotal = snap.total - prev.total
  const dBusy = snap.busy - prev.busy
  if (dt < 500 || dTotal <= 0) return null
  return Math.round(Math.max(0, Math.min(100, (dBusy / dTotal) * 100)) * 10) / 10
}

function snapshotScript(pidList, withThreads) {
  // 线程数是可选的重活：对 700+ 个进程逐个读 $p.Threads.Count 会让一次采样从 0.4 秒涨到 0.7 秒
  // （2026-09-23 实测）。引擎不需要它，所以默认不算。
  return `$ErrorActionPreference = 'SilentlyContinue'
# stdout 必须是 UTF-8：默认按控制台代码页（本机 936）输出，命令行里的中文路径到 Node 那头
# 就成乱码 —— 而 cmd 要拿来做白名单匹配，中文匹配值（如「图书馆比赛」）会静默失效（2026-09-23 实测）。
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$procs = @(Get-Process)
$rows = New-Object System.Collections.ArrayList
foreach ($p in $procs) {
  try {
    [void]$rows.Add([pscustomobject]@{ pid = [int]$p.Id; name = $p.ProcessName; cpuMs = [math]::Round($p.TotalProcessorTime.TotalMilliseconds); ws = [int64]$p.WorkingSet64 })
  } catch {}
}
$threads = $null
if ($${withThreads ? 'true' : 'false'}) {
  $threads = 0
  foreach ($p in $procs) { try { $threads += $p.Threads.Count } catch {} }
}
$extra = New-Object System.Collections.ArrayList
$ids = @(${pidList.join(',')})
$cmds = @{}
if ($ids.Count -gt 0) {
  $filter = ($ids | ForEach-Object { "ProcessId=$_" }) -join ' OR '
  foreach ($c in Get-CimInstance Win32_Process -Filter $filter) { $cmds[[int]$c.ProcessId] = [string]$c.CommandLine }
}
foreach ($id in $ids) {
  $p = Get-Process -Id $id
  if ($p) {
    [void]$extra.Add([pscustomobject]@{ pid = [int]$p.Id; startTime = $p.StartTime.ToString('o'); ws = [int64]$p.WorkingSet64; path = $p.Path; cmd = [string]$cmds[[int]$p.Id] })
  }
}
[pscustomobject]@{ processes = $procs.Count; threads = $threads; procs = $rows; extra = $extra } | ConvertTo-Json -Depth 4 -Compress
`
}

/** 跑一次 PowerShell 拿全进程快照（失败返回 null，绝不抛） */
export async function snapshot({ pids = [], withThreads = false, timeout = 20000 } = {}) {
  const psFile = path.join(os.tmpdir(), `procs-snap-${process.pid}.ps1`)
  try {
    fs.writeFileSync(psFile, `\uFEFF${snapshotScript(pids, withThreads)}`, 'utf8')
    const r = await runHidden(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`, { timeout })
    const text = String(r.stdout ?? '').trim()
    if (!text) return null
    const d = JSON.parse(text)
    const byPid = new Map()
    for (const p of d.procs ?? []) byPid.set(p.pid, p)
    const detail = new Map()
    for (const x of d.extra ?? []) detail.set(x.pid, x)
    return {
      at: Date.now(),
      processes: d.processes ?? (d.procs ?? []).length,
      threads: d.threads ?? null,
      procs: d.procs ?? [],
      byPid,
      detail,
      cores: Math.max(1, os.cpus().length),
      memTotalBytes: os.totalmem(),
      memFreeBytes: os.freemem(),
    }
  } catch {
    return null
  } finally {
    try {
      fs.rmSync(psFile, { force: true })
    } catch {
      /* ignore */
    }
  }
}

/** 两次快照之间，按 CPU 增量排出的“最吃 CPU 的进程”（窗口 = 两次快照的间隔） */
export function topByCpu(prev, cur, limit = 15) {
  if (!prev || !cur) return []
  const dt = cur.at - prev.at
  if (dt < 400) return []
  const out = []
  for (const p of cur.procs ?? []) {
    const before = prev.byPid?.get(p.pid)
    if (!before) continue
    const used = (p.cpuMs ?? 0) - (before.cpuMs ?? 0)
    if (used <= 0) continue
    out.push({
      pid: p.pid,
      name: p.name,
      ws: p.ws,
      cpuMs: p.cpuMs ?? 0,
      usedMs: used,
      cpu: Math.round((used / (dt * cur.cores)) * 1000) / 10,
    })
  }
  out.sort((a, b) => b.cpu - a.cpu)
  return out.slice(0, limit)
}

/** 当前前台窗口属于哪个进程（用于「别动你正在看的那个东西」这道闸）。失败返回 0。 */
export async function foregroundPid() {
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PgFg {
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  public static int Pid() { IntPtr h = GetForegroundWindow(); if (h == IntPtr.Zero) return 0; int p; GetWindowThreadProcessId(h, out p); return p; }
}
'@
Write-Output ("##PG##" + [PgFg]::Pid())
`
  const r = await psRun(script, 15000)
  const m = String(r.stdout ?? '').match(/##PG##(\d+)/)
  return m ? Number(m[1]) : 0
}

/* ----------------------------------------------------------- 动作 --- */

/** 跑一段 PowerShell（脚本落成 UTF-8 BOM 的临时 .ps1 再走 -File：命令行里传中文会被代码页糟蹋） */
async function psRun(script, timeout = 30000) {
  const psFile = path.join(os.tmpdir(), `procs-act-${process.pid}.ps1`)
  try {
    fs.writeFileSync(psFile, `\uFEFF${script}`, 'utf8')
    return await runHidden(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`, { timeout })
  } finally {
    try {
      fs.rmSync(psFile, { force: true })
    } catch {
      /* ignore */
    }
  }
}

/** 一次调用里要干的活：trim=释放工作集；close=先发 WM_CLOSE 再等；两者都能批量 */
function actionScript({ mode, pids = [], graceMs = 3000 }) {
  return `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class PgAct
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] private static extern int GetWindowThreadProcessId(IntPtr hWnd, out int pid);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
    [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr hWnd, int index);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
    [DllImport("psapi.dll")] private static extern bool EmptyWorkingSet(IntPtr hProcess);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr h);

    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const uint PROCESS_SET_QUOTA = 0x0100;
    private const uint GW_OWNER = 4;
    private const int GWL_EXSTYLE = -20;
    private const int WS_EX_TOOLWINDOW = 0x00000080;
    private const uint WM_CLOSE = 0x0010;

    public static string Trim(int pid)
    {
        IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_QUOTA, false, pid);
        if (h == IntPtr.Zero) return "err" + Marshal.GetLastWin32Error();
        bool ok = EmptyWorkingSet(h);
        int err = ok ? 0 : Marshal.GetLastWin32Error();
        CloseHandle(h);
        return ok ? "ok" : ("err" + err);
    }

    public static int CloseWindows(int pid)
    {
        int n = 0;
        EnumWindowsProc cb = delegate(IntPtr h, IntPtr l)
        {
            int p;
            GetWindowThreadProcessId(h, out p);
            if (p != pid) return true;
            if (GetWindow(h, GW_OWNER) != IntPtr.Zero) return true;
            if ((GetWindowLong(h, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0) return true;
            if (!IsWindowVisible(h)) return true;
            if (PostMessage(h, WM_CLOSE, IntPtr.Zero, IntPtr.Zero)) n++;
            return true;
        };
        EnumWindows(cb, IntPtr.Zero);
        return n;
    }

    public static bool Alive(int pid)
    {
        IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (h == IntPtr.Zero) return false;
        CloseHandle(h);
        return true;
    }
}
'@

$mode = '${mode}'
$pids = @(${pids.join(',')})
$result = @{}
if ($mode -eq 'trim') {
  foreach ($p in $pids) { $result["$p"] = [PgAct]::Trim($p) }
} elseif ($mode -eq 'close') {
  $closed = @{}
  foreach ($p in $pids) { $closed["$p"] = [PgAct]::CloseWindows($p) }
  Start-Sleep -Milliseconds ${Math.max(0, Math.round(graceMs))}
  $alive = @()
  foreach ($p in $pids) { if ([PgAct]::Alive($p)) { $alive += $p } }
  $result['closed'] = $closed
  $result['alive'] = $alive
}
$result | ConvertTo-Json -Depth 3 -Compress | ForEach-Object { Write-Output ("##PG##" + $_) }
`
}

/**
 * 释放一批进程的工作集（EmptyWorkingSet）。
 * 返回 { ok: boolean, results: {pid: 'ok'|'err5'|...}, blocked: number } —— err5 = 权限不够（提权进程）。
 */
export async function trimProcesses(pids = [], { timeout = 30000 } = {}) {
  const list = [...new Set(pids.map(Number).filter((n) => n > 0))]
  if (!list.length) return { ok: true, results: {}, blocked: 0, released: 0 }
  const r = await psRun(actionScript({ mode: 'trim', pids: list }), timeout)
  const out = parseMarker(r.stdout)
  if (!out) return { ok: false, error: psErr(r), results: {}, blocked: 0, released: 0 }
  let blocked = 0
  let okCount = 0
  for (const v of Object.values(out)) {
    if (String(v) === 'ok') okCount += 1
    else blocked += 1
  }
  return { ok: okCount > 0 || !list.length, results: out, blocked, released: okCount }
}

/**
 * 先礼后兵：给这些进程的可见窗口发 WM_CLOSE，等 graceMs，还活着的交给调用方决定要不要结束。
 * 返回 { ok, alive: number[], closed: {pid: 关了几个窗口} }。
 */
export async function closeWindows(pids = [], { graceMs = 3000, timeout = 30000 } = {}) {
  const list = [...new Set(pids.map(Number).filter((n) => n > 0))]
  if (!list.length) return { ok: true, alive: [], closed: {} }
  const r = await psRun(actionScript({ mode: 'close', pids: list, graceMs }), timeout + graceMs)
  const out = parseMarker(r.stdout)
  if (!out) return { ok: false, error: psErr(r), alive: list, closed: {} }
  return { ok: true, alive: (out.alive ?? []).map(Number), closed: out.closed ?? {} }
}

/** 结束进程（连同子进程）。taskkill /T /F —— 提权进程同样会被拒。 */
export async function killProcess(pid) {
  const ok = await killPid(Number(pid))
  return { ok }
}

/**
 * 清理系统待机列表（MemoryPurgeStandbyList）。
 * 需要 SeProfileSingleProcessPrivilege = 必须提权，所以走 runElevated（**会弹一次 UAC**）。
 * 这是「人点一下」的动作，不挂在周期里 —— 无人值守时 UAC 没人点。
 */
export async function purgeStandbyList({ timeout = 90000 } = {}) {
  const script = `
  $__extra = @{}
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PgStandby {
  [StructLayout(LayoutKind.Sequential)] public struct LUID { public uint LowPart; public int HighPart; }
  [StructLayout(LayoutKind.Sequential)] public struct TOKEN_PRIVILEGES { public uint Count; public LUID Luid; public uint Attributes; }
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr p, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool LookupPrivilegeValue(string system, string name, out LUID luid);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool disable, ref TOKEN_PRIVILEGES state, uint size, IntPtr prev, IntPtr ret);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("ntdll.dll")] static extern int NtSetSystemInformation(int cls, ref int info, int size);
  public static int Purge() {
    IntPtr token;
    if (!OpenProcessToken(GetCurrentProcess(), 0x0020 | 0x0008, out token)) return -1;
    LUID luid;
    if (!LookupPrivilegeValue(null, "SeProfileSingleProcessPrivilege", out luid)) return -2;
    TOKEN_PRIVILEGES tp = new TOKEN_PRIVILEGES();
    tp.Count = 1; tp.Luid = luid; tp.Attributes = 0x00000002;
    if (!AdjustTokenPrivileges(token, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero)) return -3;
    int command = 4; // MemoryPurgeStandbyList
    return NtSetSystemInformation(80, ref command, 4); // SystemMemoryListInformation
  }
}
'@
  $__extra.rc = [PgStandby]::Purge()
`
  const r = await runElevated(script, { timeout })
  if (!r.ok) return { ok: false, error: r.error, needsUac: /取消|未返回结果/.test(r.error ?? '') }
  const rc = Number(r.extra?.rc ?? 0)
  if (rc === 0) return { ok: true }
  const hint =
    rc === -1 ? '拿不到进程令牌' : rc === -2 ? '查不到 SeProfileSingleProcessPrivilege' : rc === -3 ? '提权失败（不是管理员？）' : `NtSetSystemInformation 返回 0x${(rc >>> 0).toString(16)}`
  return { ok: false, error: `清理待机列表失败：${hint}` }
}

function parseMarker(stdout) {
  const line = String(stdout ?? '')
    .split(/\r?\n/)
    .filter((l) => l.includes('##PG##'))
    .pop()
  if (!line) return null
  try {
    return JSON.parse(line.slice(line.indexOf('##PG##') + 6))
  } catch {
    return null
  }
}

function psErr(r) {
  const t = `${r.stderr ?? ''}${r.stdout ?? ''}`.trim().replace(/\s+/g, ' ')
  return t ? t.slice(0, 200) : 'PowerShell 没有输出（被安全软件拦了？）'
}
