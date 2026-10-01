<script setup lang="ts">
/**
 * WorkBuddy 额度 —— 上游账号池的积分 / 花费 / 调用情况。
 *
 * 数据来源：边车 /api/workbuddy/snapshot（网关内存状态 + 后台定时缓存的积分）。
 * 打开页面 **0 个上游请求**：积分查询要出网约 1.6s，由边车后台每 5 分钟刷一次并落盘，
 * 页面永远先画缓存；只有点「刷新」才同步等一轮。这一点与「模型用量」页同款做法。
 *
 * 三块信息：
 *   1. 积分总览 —— 还剩多少 / 一共多少 / 用了多少（真实积分包，来自上游）
 *   2. 账号明细 —— 每个号各自的积分；有积分已用光的号要一眼看出来（它会优先被轮空）
 *   3. 网关自身 —— 请求数 / token / 缓存命中 / 积分消耗，以及被冷却、被停用的号
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import SidecarOffline from '@/components/SidecarOffline.vue'
import EmptyState from '@/components/EmptyState.vue'
import { api, ensureSidecar } from '@/core/sidecar'
import { copyText } from '@/core/clipboard'

const ready = ref(false)
const loading = ref(false) // 仅手动刷新时转圈
const err = ref('')
const snap = ref<any>(null)
let autoTimer: ReturnType<typeof setInterval> | null = null

/* ------------------------------------------------------------- 取值 --- */

const status = computed(() => snap.value?.status ?? null)
/**
 * 调用统计按天存（网关 data/metrics.json），不跟快照走。
 * 快照里那份永远是今天，只在还没单独取过时垫底；选了别的日期就换成那一天。
 */
const statsView = ref<any>(null)
const stats = computed(() => statsView.value ?? snap.value?.stats ?? null)
const credit = computed(() => (isLocal.value ? snap.value?.credit ?? null : remoteCredit.value))
/** 上次成功取到积分的时刻（两边的来源不同：本机来自快照缓存，远端来自按主机的缓存） */
const creditAt = computed(() => (isLocal.value ? snap.value?.creditAt ?? 0 : remoteCredit.value?.at ?? 0))
const creditStale = computed(() => (isLocal.value ? !!snap.value?.creditStale : !!remoteCredit.value?.stale))
const creditOk = computed(() => !!credit.value?.ok)
const total = computed(() => credit.value?.total ?? null)

/** 账号池状态与积分包按 uid 对齐：网关知道谁被冷却，上游知道谁还剩多少 */
const accounts = computed(() => {
  const pool = status.value?.accounts ?? []
  const credits = credit.value?.accounts ?? []
  const byUid = new Map(credits.map((c: any) => [c.uid, c]))
  return pool.map((a: any) => {
    const c: any = byUid.get(a.uid)
    // 三方来源优先级：上游积分包 → 网关内存 credits（签到会写）→ 未知。
    // 「未知」必须与「0 积分」区分开：新登录的号还没查过积分，显示 0 会让人以为用光了。
    let remain: number | null = null
    let size: number | null = null
    if (c && !c.error) {
      remain = c.remain ?? 0
      size = c.size ?? 0
    } else if (a.credits > 0) {
      remain = a.credits
      size = null
    }
    return {
      uid: a.uid,
      nickname: a.nickname || a.uid?.slice(0, 8) || '未命名',
      remain,
      size,
      used: c?.used ?? null,
      packages: c?.packages ?? 0,
      creditError: c?.error ?? null,
      cooling: a.cooling,
      disabled: a.disabled,
      manualDisabled: a.manualDisabled,
      inFlight: a.inFlight,
      consecutiveFails: a.consecutiveFails,
      lastSuccess: a.lastSuccess,
      limits: Array.isArray(a.limits) ? a.limits : [],
    }
  })
})

/** 剩余百分比（0~100）。总量为 0 时给 null —— 显示「—」而不是假的 0% */
function pct(remain?: number, size?: number) {
  if (!size) return null
  return Math.round((Number(remain) / Number(size)) * 100)
}

const totalPct = computed(() => pct(total.value?.remain, total.value?.size))

/** 按剩余百分比给色调：<20% 危险、<50% 警示、其余正常 */
function tone(p: number | null) {
  if (p == null) return 'muted'
  if (p < 20) return 'danger'
  if (p < 50) return 'warn'
  return 'ok'
}

/** 账号状态一句话：手动停用 / 系统禁用 / 冷却中 / 正常 */
function stateOf(a: any) {
  if (a.manualDisabled) return { text: '手动停用', tone: 'muted' }
  if (a.disabled) return { text: '已禁用', tone: 'danger' }
  if (a.cooling) return { text: '冷却中', tone: 'warn' }
  return { text: '可用', tone: 'ok' }
}

/* ------------------------------------------------------------- 格式化 --- */

function num(n?: number | null) {
  if (n == null) return '—'
  return Number(n).toLocaleString('zh-CN')
}
/** 大数字缩写：12345 → 1.2万（KPI 卡里省地方） */
function compact(n?: number | null) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '—'
  if (Math.abs(v) >= 10000) return `${(v / 10000).toFixed(1)}万`
  return v.toLocaleString('zh-CN')
}
function percent(n?: number | null, digits = 1) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '—'
  return `${(v * 100).toFixed(digits)}%`
}
function dur(sec?: number | null) {
  const v = Number(sec)
  if (!Number.isFinite(v) || v <= 0) return '—'
  if (v < 60) return `${Math.round(v)} 秒`
  if (v < 3600) return `${Math.floor(v / 60)} 分钟`
  if (v < 86400) return `${(v / 3600).toFixed(1)} 小时`
  return `${(v / 86400).toFixed(1)} 天`
}
/** 延迟专用：按秒给一位小数（80.8 秒比「1 分钟」有信息量），超过 60 秒才换成分钟 */
function latency(ms?: number | null) {
  const v = Number(ms)
  if (!Number.isFinite(v) || v <= 0) return '—'
  const sec = v / 1000
  if (sec < 60) return `${sec.toFixed(1)} 秒`
  return `${(sec / 60).toFixed(1)} 分钟`
}
function agoOf(ms?: number) {
  if (!ms) return ''
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  return `${Math.floor(s / 3600)} 小时前`
}
function timeOf(iso?: string) {
  if (!iso || iso.startsWith('0001-')) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 模型行的排序口径：默认按积分耗费 —— 次数多不等于花得多（缓存命中、免费模型都计次不花积分） */
const modelSort = ref<'credit' | 'requests'>('credit')

/* ------------------------------------------------------- 统计日期 ---
   网关按本地日（UTC+8）把调用统计落盘，重启不丢。这里选哪一天就看哪一天；
   可选范围来自网关返回的 days，没有记录的日期不给选。 */
const statsDay = ref('')
const statsDays = ref<string[]>([])
const statsBusy = ref(false)

/** 今天，本地时区。和网关的 UTC+8 切日一致（本机就在这个时区）。 */
function todayStr() {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const statsDayLabel = computed(() => {
  const day = stats.value?.day || statsDay.value
  if (!day) return ''
  return day === todayStr() ? `${day} · 今天` : day
})

/** 下拉的候选项：网关有记录的日期，今天即使还没有记录也放在最前 */
const statsDayOptions = computed(() => {
  const days = new Set(statsDays.value)
  days.add(todayStr())
  return [...days].sort().reverse()
})

async function loadStats(day = statsDay.value) {
  statsBusy.value = true
  const r = await api.workbuddyStats(day, hostId.value)
  statsBusy.value = false
  if (!r.ok || r.data?.ok === false) return
  statsView.value = r.data
  if (Array.isArray(r.data.days)) statsDays.value = r.data.days
  if (!statsDay.value && r.data.day) statsDay.value = r.data.day
}

/** 网关调用统计里的模型行（按当前口径降序，另一个口径做次序，最多列 8 个） */
const modelRows = computed(() => {
  const key = modelSort.value
  const alt = key === 'credit' ? 'requests' : 'credit'
  const of = (m: any, k: string) => Number(m?.[k]) || 0
  return [...(stats.value?.models ?? [])]
    .sort((a: any, b: any) => of(b, key) - of(a, key) || of(b, alt) - of(a, alt))
    .slice(0, 8)
})
/** 横条比例基准：跟着当前排序口径走，条长和名次才对得上 */
const maxModelValue = computed(() =>
  Math.max(
    1,
    ...modelRows.value.map((m: any) => Number(m?.[modelSort.value]) || 0),
  ),
)
/** 行首数值（与横条同口径）；行尾补另一个口径 + tokens，两项都不丢 */
function headValue(m: any) {
  return modelSort.value === 'credit' ? `${num(m.credit)} 积分` : `${num(m.requests)} 次`
}
function tailValue(m: any) {
  const other = modelSort.value === 'credit' ? `${num(m.requests)} 次` : `${num(m.credit)} 积分`
  return `${other} · ${compact(m.totalTokens)} tokens`
}
/** 最短 3% 保证 0 积分/0 次的模型也看得见 */
function barWidth(m: any) {
  return Math.max(3, ((Number(m?.[modelSort.value]) || 0) / maxModelValue.value) * 100)
}

/* --------------------------------------------------------- 模型清单 ---
   网关支持的模型（含倍率 / 上下文 / 能力）。来自 snapshot 的 models 字段
   （边车侧内存 + 落盘缓存，默认 10 分钟，不跟着页面刷新去问网关）。 */
const modelFilter = ref('')

/** 支持的模型；服务端已按倍率升序排好，免费的在最前 */
const models = computed<any[]>(() => snap.value?.models ?? [])

/** 过滤后的清单（匹配模型名 / 显示名 / 描述），40+ 个里好找 */
const filteredModels = computed(() => {
  const q = modelFilter.value.trim().toLowerCase()
  if (!q) return models.value
  return models.value.filter(
    (m: any) =>
      m.model.toLowerCase().includes(q) ||
      (m.name ?? '').toLowerCase().includes(q) ||
      (m.description ?? '').toLowerCase().includes(q),
  )
})

/** 免费的单独标出来 —— 日常杂活优先用这些，不花积分 */
const freeCount = computed(() => models.value.filter((m: any) => m.multiplier === 0).length)

/**
 * 每个模型今天的账号可用情况。
 *
 * 能精确到的程度：哪个账号、哪个模型、上游说几点恢复。做不到的是「每天多少次」——
 * 上游不给配额数字，只在用满时返回 6004（这个模型今天到点了）或 14018（这个号的
 * 额度用尽，全部模型一起停）。所以这里显示的是「现在还有几个号能用」，不是剩余次数。
 *
 * 匹配按模型名：网关模型 id 可能带 realm 前缀（cn:deepseek-v4.1-flash），限额记的是裸名。
 */
const modelQuota = computed(() => {
  const pool = accounts.value
  const total = pool.length
  const byModel = new Map<string, any[]>()
  const allBlocked: any[] = []
  for (const a of pool) {
    for (const lim of a.limits ?? []) {
      // 恢复时刻优先用上游给的重置墙钟。until 是被网关截断后的冷却截止，
      // 可能更早，不能拿来当「额度真正恢复」的时间。
      const iso = lim.resetAt || lim.until || ''
      const row = {
        name: a.nickname,
        uid: a.uid,
        iso,
        when: timeOf(iso),
        ms: iso ? new Date(iso).getTime() : 0,
        reason: lim.reason || '',
        all: lim.model === '全部模型',
      }
      if (row.all) allBlocked.push(row)
      else {
        const list = byModel.get(lim.model) ?? []
        list.push(row)
        byModel.set(lim.model, list)
      }
    }
  }
  return { total, byModel, allBlocked }
})

/**
 * 一张模型卡的可用情况。
 * blocked 是到限额的号，按恢复时刻从早到晚排；earliest / latest 是这批号的
 * 恢复时间两端，卡片上只放这两个。usable 是今天还能用这个模型的号。
 */
function quotaOf(m: any) {
  const q = modelQuota.value
  const blocked = [...(q.byModel.get(m.model) ?? []), ...q.allBlocked]
    .sort((a, b) => (a.ms || Infinity) - (b.ms || Infinity))
  const dated = blocked.filter((b) => b.ms)
  return {
    total: q.total,
    usable: Math.max(0, q.total - blocked.length),
    blocked,
    earliest: dated[0]?.when ?? '',
    latest: dated.length > 1 ? dated[dated.length - 1].when : '',
  }
}

/** 点模型卡打开的明细。null = 没开。 */
const quotaDialog = ref<any>(null)

function openQuota(m: any) {
  quotaDialog.value = { model: m.model, name: m.name && m.name !== m.model ? m.name : '', ...quotaOf(m) }
}

/** 弹窗里「还能用」的号：账号池减去到限额的那些 */
function usableOf(q: any) {
  const blocked = new Set((q?.blocked ?? []).map((b: any) => b.uid))
  return accounts.value.filter((a: any) => !blocked.has(a.uid))
}

/** 上游原因翻成一句话。原文仍在 title 上，表格里不放英文错误码。 */
function reasonText(reason: string) {
  if (!reason) return '—'
  if (reason.includes('6004')) return '这个模型今天的额度用满了'
  if (reason.includes('14018') || reason.includes('额度')) return '账号额度用尽，等签到恢复'
  return reason
}

/** 倍率徽标：0 = 免费（绿）、<0.2 = 便宜（蓝）、其余灰 */
function multTag(m: any) {
  if (m.multiplier == null) return { text: '—', tone: 'muted' }
  if (m.multiplier === 0) return { text: '免费', tone: 'ok' }
  if (m.multiplier < 0.2) return { text: `x${m.multiplier}`, tone: 'info' }
  return { text: `x${m.multiplier}`, tone: 'muted' }
}

/** 上下文长度缩写：1000000 → 1M，192000 → 192K */
function ctxShort(n?: number | null) {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return ''
  if (v >= 1000000) return `${Math.round(v / 100000) / 10}M`
  return `${Math.round(v / 1000)}K`
}

function copyModelNames() {
  const names = filteredModels.value.map((m: any) => m.model)
  if (!names.length) return
  copyText(
    names.join('\n'),
    modelFilter.value ? `已复制 ${names.length} 个（当前筛选结果）` : `已复制全部 ${names.length} 个模型`,
  )
}

/* --------------------------------------------------------- 请求日志 ---
   日志来自网关自己的 server.out.log（边车逐行解析成结构化字段）。
   它被启动脚本每次启动覆盖，所以只覆盖「网关本次运行」—— 界面上如实标注。
   注意：日志刷新是单独的按钮/筛选，不跟着 30s 轮询走（文件可能很大，没必要反复读）。 */
const logs = ref<any[]>([])
const logTotal = ref(0)
const logFailed = ref(0)
const logKeyword = ref('')
const logOnlyFail = ref(false)
const logBusy = ref(false)
const logsError = ref('')
/** 只取最新 100 条（多了没意义，日志区是可滚动的固定高度） */
const logLimit = 100

async function loadLogs(limit = logLimit) {
  logBusy.value = true
  const r = await api.workbuddyLogs({
    limit,
    keyword: logKeyword.value.trim(),
    onlyFail: logOnlyFail.value,
  })
  logBusy.value = false
  if (!r.ok || r.data?.ok === false) {
    logsError.value = r.error ?? r.data?.error ?? '读取失败'
    logs.value = []
    return
  }
  logsError.value = ''
  logs.value = r.data.items ?? []
  logTotal.value = r.data.total ?? 0
  logFailed.value = r.data.failed ?? 0
}

/* --------------------------------------------------------- 连接凭据 ---
   Base URL 与 API key。明文**默认不取**：页面加载只拿掩码，点「显示」或「复制」
   时才发现一次 —— 这样 key 不会在打开页面时白白进前端内存。
   缓存在 revealKey 里，隐藏时不清（再点「显示」不必再请求）。 */
const cred = ref<any>(null)
const revealed = ref(false)
const revealKey = ref('')

/**
 * 网关的 OpenAI 兼容入口（「复制 Base URL」用）。
 * 地址取快照里的 baseUrl —— 端口与主机可能被 config.workbuddy.baseUrl 改过，所以不写死；
 * 快照还没到时先拿网关的默认监听地址垫着。
 */
const baseV1 = computed(() => `${snap.value?.baseUrl ?? 'http://127.0.0.1:7863'}/v1`)

const credText = computed(() => {
  if (!cred.value) return '加载中…'
  if (!cred.value.ok) return '未配置'
  return revealed.value ? revealKey.value : cred.value.masked
})

/** 取明文（已取过就直接用缓存） */
async function ensureKey(): Promise<string> {
  if (revealKey.value) return revealKey.value
  const r = await api.workbuddyCredential(true, hostId.value)
  if (!r.ok || !r.data?.ok || !r.data.key) {
    ElMessage.error(r.error ?? r.data?.error ?? '取不到 API Key')
    return ''
  }
  revealKey.value = r.data.key
  return revealKey.value
}

async function toggleReveal() {
  if (!revealed.value) {
    if (!(await ensureKey())) return
    revealed.value = true
    return
  }
  revealed.value = false
}

async function copyKey() {
  const key = await ensureKey()
  if (key) copyText(key, 'API Key 已复制')
}

/** 连接凭据（掩码）：只拿掩码；明文要点「显示」才请求 */
async function loadCredential() {
  const r = await api.workbuddyCredential(false, hostId.value)
  cred.value = r.ok ? r.data : { ok: false, error: r.error ?? '取不到凭据' }
}

/* --------------------------------------------------------- 账号池主机 --- */

/**
 * 本页可以看多台账号池：本机（默认）+ config.workbuddy.hosts[] 里的远端主机。
 *
 * 远端是**只读**的：账号运维 / 配置 / 日志都属于「那台机器上的事」，各自在各自机器上做
 * （真实积分包要跑那边的 credit.exe，配了 hosts[].creditScript 才取得到）。
 * 这里只做一件跨机的事：把两个池的号摊开，标出**同一个号同时在两个池里**的情形。
 */
const hosts = ref<any[]>([])
const hostId = ref<string>(localStorage.getItem('workbuddy.host') || 'local')
const isLocal = computed(() => hostId.value === 'local')
const hostName = computed(() => hosts.value.find((h) => h.id === hostId.value)?.name ?? '本机')
/** 跨池重复的账号：同一个号被两处使用会招风控 / 两边的 token 保活互相顶掉 */
const dupes = ref<any[]>([])

/** 远端池的真实积分包：走边车经 SSH 在那台机器上跑它自己的 credit.exe（本机那份走原有缓存） */
const remoteCredit = ref<any>(null)
const remoteCreditBusy = ref(false)
/** 远端池拿不到上游积分包时，用各号 credits 求和兜底，并如实标出口径 */
const poolRemain = computed(() =>
  (status.value?.accounts ?? []).reduce((n: number, a: any) => n + (Number(a.credits) || 0), 0),
)

async function loadRemoteCredit(force = false) {
  remoteCreditBusy.value = true
  const r = await api.workbuddyCredits(force, hostId.value)
  remoteCreditBusy.value = false
  remoteCredit.value = r.ok ? r.data : { ok: false, error: r.error ?? '取不到积分' }
}

async function loadHosts() {
  const r = await api.workbuddyHosts()
  if (r.ok) hosts.value = r.data?.items ?? []
}
async function loadMatrix() {
  const r = await api.workbuddyMatrix()
  if (r.ok) dupes.value = r.data?.duplicates ?? []
}
function switchHost(id: string) {
  if (id === hostId.value) return
  hostId.value = id
  localStorage.setItem('workbuddy.host', id)
  snap.value = null
  statsView.value = null
  logs.value = []
  cred.value = null
  load()
  if (id === 'local') {
    loadStats()
    loadLogs()
    loadCredential()
  } else {
    remoteCredit.value = null
    loadRemoteCredit()
  }
}

/* --------------------------------------------------------------- 加载 --- */

async function load(refresh = false) {
  if (refresh && !isLocal.value) loadRemoteCredit(true)
  const online = await ensureSidecar()
  if (!online) {
    ready.value = true
    return
  }
  loading.value = true
  err.value = ''
  const r = await api.workbuddySnapshot(refresh, hostId.value)
  loading.value = false
  ready.value = true
  if (!r.ok) {
    // 网关没起来时 api 返回 ok:false —— 页面显示启动指引，而不是空白
    err.value = r.error ?? '读取失败'
    return
  }
  snap.value = r.data
  // 快照里的统计永远是今天。正在看别的日期时不能被它盖掉。
  if (!statsDay.value || statsDay.value === todayStr()) {
    if (r.data?.stats) statsView.value = r.data.stats
    if (Array.isArray(r.data?.stats?.days)) statsDays.value = r.data.stats.days
    if (!statsDay.value && r.data?.stats?.day) statsDay.value = r.data.stats.day
  }
}

onMounted(() => {
  loadHosts().then(() => {
    load()
    loadMatrix()
    if (isLocal.value) {
      loadStats()
      loadLogs()
      loadCredential()
    } else {
      loadRemoteCredit()
    }
  })
  // 30s 轮询：账号池状态是网关内存数据，便宜；积分跟着边车自己的 5 分钟节奏走
  autoTimer = setInterval(() => load(), 30000)
})
onUnmounted(() => {
  if (autoTimer) clearInterval(autoTimer)
})
</script>

<template>
  <div class="ws-page">
    <PageHeader
      title="WorkBuddy 额度"
      :subtitle="
        isLocal
          ? '上游账号池：积分、花费与调用情况（经本机 WorkBuddy2API 网关）'
          : `上游账号池：积分、花费与调用情况（远端账号池 ${hostName}）`
      "
      icon="Wallet"
    >
      <template #actions>
        <!-- 两边都显示「上次取到积分是什么时候」：远端要走 SSH，慢，先给上次的数 -->
        <span v-if="creditAt" class="ws-dim" style="font-size: 11.5px">
          积分 {{ agoOf(creditAt) }}更新<template v-if="creditStale">（后台刷新中）</template>
        </span>
        <span v-else-if="remoteCreditBusy" class="ws-dim" style="font-size: 11.5px">
          正在向 {{ hostName }} 查积分…
        </span>
        <el-button size="small" :loading="loading" @click="load(true)">
          <el-icon><Refresh /></el-icon>&nbsp;刷新
        </el-button>
      </template>
    </PageHeader>

    <!-- 账号池主机切换：本机 + 各远端主机。选哪个看哪个，远端只读。 -->
    <div class="ws-card wb-hosts">
      <span class="wb-hosts__label">账号池</span>
      <button
        v-for="h in hosts.length ? hosts : [{ id: 'local', name: '本机', kind: 'local' }]"
        :key="h.id"
        class="wb-hosts__btn"
        :class="{ 'is-active': h.id === hostId }"
        :title="h.note || h.baseUrl"
        @click="switchHost(h.id)"
      >
        {{ h.name }}
        <i v-if="h.kind === 'remote'" class="wb-hosts__tag" :class="{ 'is-bad': h.keyConfigured === false }">
          {{ h.keyConfigured === false ? '未配密钥' : '远端' }}
        </i>
      </button>
      <span v-if="!isLocal" class="wb-hosts__note">
        远端只读 · 账号运维／配置／日志都在那台机器上做（加号也在那边）
      </span>
    </div>

    <!-- 跨池重复：同一个号别放两个池（风控 + 22:00 保活互相顶 token） -->
    <div v-if="dupes.length" class="ws-card wb-dupe">
      <el-icon class="wb-dupe__icon"><WarningFilled /></el-icon>
      <div>
        <b>{{ dupes.length }} 个账号同时在多个账号池里</b>
        <p class="wb-dupe__body">
          同一个号被两处使用：上游可能按异常登录风控；两边的 token 保活还会各刷一次，
          轮换式的登录态会互相顶掉。建议一个号只留在一个池里 —— 在那台机器的 auths/ 目录里
          删掉 <code class="ws-mono">workbuddy-&lt;uid&gt;.json</code> 即可（本机那份不动）。
        </p>
        <p class="wb-dupe__who">{{ dupes.map((d: any) => d.nickname).join('、') }}</p>
      </div>
    </div>

    <SidecarOffline v-if="ready && !snap" />

    <template v-else-if="snap">
      <!-- 网关没在跑：给启动指引，不显示一堆 0 -->
      <div v-if="!snap.ok" class="ws-card wb-offline">
        <el-icon class="wb-offline__icon"><WarningFilled /></el-icon>
        <div>
          <div class="wb-offline__title">WorkBuddy2API 网关没在运行</div>
          <p class="ws-dim" style="margin: 6px 0 0">{{ snap.error }}</p>
          <p class="ws-dim" style="margin: 4px 0 0; font-size: 12px">
            启动后本页会自动恢复。网关是你自己装的那一份（不随本仓库分发），目录在
            <code class="ws-mono">config.workbuddy.dir</code>；「网关配置」页能看它现在的路径并启停它。
          </p>
        </div>
      </div>

      <template v-else>
        <!-- ---------------------------------------------------- KPI 行 -->
        <div class="wb-kpi">
          <!-- 远端池：优先显示「向那台机器要来的真实积分包」，取不到才退回池内求和 -->
          <template v-if="!isLocal">
            <div v-if="total" class="ws-card wb-kpi__card wb-kpi__card--hero" :class="`is-${tone(totalPct)}`">
              <div class="wb-kpi__label">剩余积分</div>
              <div class="wb-kpi__value">
                <b>{{ num(total?.remain) }}</b>
                <i v-if="total?.size">/ {{ num(total.size) }}</i>
              </div>
              <div class="wb-bar" v-if="totalPct != null">
                <div class="wb-bar__fill" :style="{ width: Math.min(100, Math.max(0, totalPct)) + '%' }" />
              </div>
              <div class="wb-kpi__foot">
                <span v-if="totalPct != null">{{ totalPct }}% 剩余</span>
                <span v-else>上游未返回总容量</span>
              </div>
            </div>
            <div v-else class="ws-card wb-kpi__card wb-kpi__card--hero">
              <div class="wb-kpi__label">积分</div>
              <div class="wb-kpi__value"><b>{{ num(poolRemain) }}</b></div>
              <div class="wb-kpi__foot">
                {{
                  remoteCreditBusy
                    ? '正在向那台机器查积分…'
                    : `上游积分包没取到（${credit?.error ?? '未知原因'}）；这里是池内各号积分之和`
                }}
              </div>
            </div>
            <div v-if="total" class="ws-card wb-kpi__card">
              <div class="wb-kpi__label">已用积分</div>
              <div class="wb-kpi__value"><b>{{ num(total?.used) }}</b></div>
              <div class="wb-kpi__foot">累计消耗（上游口径，在那台机器上查的）</div>
            </div>
          </template>
          <template v-else>
            <div class="ws-card wb-kpi__card wb-kpi__card--hero" :class="`is-${tone(totalPct)}`">
              <div class="wb-kpi__label">剩余积分</div>
              <div class="wb-kpi__value">
                <b>{{ num(total?.remain) }}</b>
                <i v-if="total?.size">/ {{ num(total.size) }}</i>
              </div>
              <div class="wb-bar" v-if="totalPct != null">
                <div class="wb-bar__fill" :style="{ width: Math.min(100, Math.max(0, totalPct)) + '%' }" />
              </div>
              <div class="wb-kpi__foot">
                <span v-if="totalPct != null">{{ totalPct }}% 剩余</span>
                <span v-else>上游未返回总容量</span>
              </div>
            </div>

            <div class="ws-card wb-kpi__card">
              <div class="wb-kpi__label">已用积分</div>
              <div class="wb-kpi__value"><b>{{ num(total?.used) }}</b></div>
              <div class="wb-kpi__foot">累计消耗（上游口径）</div>
            </div>
          </template>

          <div class="ws-card wb-kpi__card">
            <div class="wb-kpi__label">可用账号</div>
            <div class="wb-kpi__value">
              <b>{{ status?.healthy ?? 0 }}</b><i>/ {{ status?.total ?? 0 }}</i>
            </div>
            <div class="wb-kpi__foot">
              <span v-if="status?.cooling" class="wb-tag is-warn">{{ status.cooling }} 个冷却中</span>
              <span v-else-if="status?.disabled" class="wb-tag is-danger">{{ status.disabled }} 个禁用</span>
              <span v-else>全部可用</span>
            </div>
          </div>

          <div class="ws-card wb-kpi__card">
            <div class="wb-kpi__label">网关已服务</div>
            <div class="wb-kpi__value"><b>{{ compact(stats?.requests) }}</b><i>次</i></div>
            <div class="wb-kpi__foot">
              失败 {{ num(stats?.failed) }} · {{ statsDayLabel || '今天' }}
            </div>
          </div>
        </div>

        <div class="wb-grid">
          <!-- ------------------------------------------------ 账号明细 -->
          <div class="ws-card wb-block">
            <div class="wb-block__head">
              <span class="wb-block__title"><el-icon><User /></el-icon>账号明细</span>
              <span class="ws-dim" style="font-size: 11.5px">
                积分少的号会被优先轮空
              </span>
            </div>

            <EmptyState
              v-if="!accounts.length"
              title="还没有账号"
              description="到「账号池」页点「加账号」走网页登录（等价于在网关目录跑它自己的登录脚本）"
            />

            <table v-else class="wb-table">
              <thead>
                <tr>
                  <th>账号</th>
                  <th style="width: 110px">剩余 / 总量</th>
                  <th style="width: 130px">进度</th>
                  <th style="width: 76px">套餐</th>
                  <th style="width: 86px">状态</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="a in accounts" :key="a.uid">
                  <td>
                    <div class="wb-acc">
                      <span class="wb-acc__name">{{ a.nickname }}</span>
                      <span class="wb-acc__meta ws-mono">
                        {{ a.uid.slice(0, 8) }}
                        <template v-if="a.lastSuccess && !a.lastSuccess.startsWith('0001')">
                          · 最近成功 {{ timeOf(a.lastSuccess) }}
                        </template>
                      </span>
                    </div>
                  </td>
                  <td class="ws-mono">
                    <template v-if="a.remain != null">
                      <b :class="`is-${tone(pct(a.remain, a.size))}`">{{ num(a.remain) }}</b>
                      <span class="ws-dim"> / {{ a.size ? num(a.size) : '—' }}</span>
                    </template>
                    <span v-else class="ws-dim" title="这个号还没查过积分，下一次刷新会带上">—</span>
                  </td>
                  <td>
                    <div v-if="pct(a.remain, a.size) != null" class="wb-bar wb-bar--sm">
                      <div
                        class="wb-bar__fill"
                        :class="`is-${tone(pct(a.remain, a.size))}`"
                        :style="{ width: Math.min(100, Math.max(0, pct(a.remain, a.size) || 0)) + '%' }"
                      />
                    </div>
                    <div class="ws-dim" style="font-size: 11px">
                      <template v-if="pct(a.remain, a.size) != null">
                        {{ pct(a.remain, a.size) }}%
                        <template v-if="a.remain === 0">· 已用尽</template>
                      </template>
                      <template v-else>积分未知</template>
                    </div>
                  </td>
                  <td class="ws-dim">{{ a.packages || '—' }}</td>
                  <td>
                    <span class="wb-tag" :class="`is-${stateOf(a).tone}`">{{ stateOf(a).text }}</span>
                    <div v-if="a.creditError" class="ws-dim" style="font-size: 11px" :title="a.creditError">
                      积分查询失败
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>

            <p v-if="credit?.total?.failed" class="ws-dim" style="margin: 10px 0 0; font-size: 12px">
              有 {{ credit.total.failed }} 个账号的积分没查到（可能是 token 过期，重新登录即可）。
            </p>
          </div>

          <!-- -------------------------------------------- 右侧：统计 -->
          <div class="wb-side">
            <!-- 网关自记账 -->
            <div class="ws-card wb-block">
              <div class="wb-block__head">
                <span class="wb-block__title"><el-icon><DataLine /></el-icon>网关调用统计</span>
                <span class="wb-block__ctl">
                <el-select
                  v-model="statsDay"
                  size="small"
                  style="width: 158px"
                  :loading="statsBusy"
                  @change="loadStats($event)"
                >
                  <el-option
                    v-for="d in statsDayOptions"
                    :key="d"
                    :label="d === todayStr() ? `${d} 今天` : d"
                    :value="d"
                  />
                </el-select>
                  <!-- 模型榜与上面同一天、同一份账，只是换个口径排（积分 / 次数） -->
                  <el-radio-group v-if="modelRows.length" v-model="modelSort" size="small">
                    <el-radio-button value="credit">按积分</el-radio-button>
                    <el-radio-button value="requests">按次数</el-radio-button>
                  </el-radio-group>
                </span>
              </div>
              <div class="wb-mini">
                <div class="wb-mini__item">
                  <span class="wb-mini__label">请求</span>
                  <span class="wb-mini__value">{{ num(stats?.requests) }}</span>
                </div>
                <div class="wb-mini__item">
                  <span class="wb-mini__label">成功</span>
                  <span class="wb-mini__value is-ok">{{ num(stats?.success) }}</span>
                </div>
                <div class="wb-mini__item">
                  <span class="wb-mini__label">失败</span>
                  <span class="wb-mini__value" :class="stats?.failed ? 'is-danger' : ''">
                    {{ num(stats?.failed) }}
                  </span>
                </div>
                <div class="wb-mini__item">
                  <span class="wb-mini__label">消耗积分</span>
                  <span class="wb-mini__value">{{ num(stats?.credit) }}</span>
                </div>
                <div class="wb-mini__item">
                  <span class="wb-mini__label">Token</span>
                  <span class="wb-mini__value">{{ compact(stats?.totalTokens) }}</span>
                </div>
                <div class="wb-mini__item">
                  <span class="wb-mini__label">缓存命中</span>
                  <span class="wb-mini__value">{{ percent(stats?.cacheHitRate) }}</span>
                </div>
              </div>
              <div class="wb-hint">
                延迟 {{ latency(stats?.avgLatencyMs) }} ·
                首字 {{ latency(stats?.avgTtfbMs) }} ·
                每次 {{ num(stats?.creditPerReq) }} 积分
              </div>
              <p class="ws-dim" style="margin: 8px 0 0; font-size: 11.5px">
                {{ statsDayLabel || '今天' }} · 按天保存在网关，重启不丢；「消耗积分」按上游返回的 usage 记账。
              </p>

              <template v-if="modelRows.length">
                <div class="wb-block__split"><span>按模型</span></div>
                <div class="wb-dist">
                  <div v-for="m in modelRows" :key="m.model" class="wb-dist__row">
                    <div class="wb-dist__top">
                      <span class="wb-dist__name ws-mono" :title="m.model">{{ m.model }}</span>
                      <span class="wb-dist__val ws-mono">{{ headValue(m) }}</span>
                    </div>
                    <div class="wb-dist__track">
                      <i :style="{ width: barWidth(m) + '%' }" />
                    </div>
                    <div class="wb-dist__meta ws-dim">{{ tailValue(m) }}</div>
                  </div>
                </div>
                <p class="ws-dim" style="margin: 8px 0 0; font-size: 11.5px">
                  {{ statsDayLabel || '今天' }} · 前 {{ modelRows.length }} 名，与上面同一天的账，换个口径排。
                </p>
              </template>
            </div>

            <!-- 冷却/停用 -->
            <div
              v-if="status?.cooling || status?.disabled || status?.stickySessions"
              class="ws-card wb-block"
            >
              <div class="wb-block__head">
                <span class="wb-block__title"><el-icon><InfoFilled /></el-icon>当前状态</span>
              </div>
              <div class="wb-hint">
                <div v-if="status.cooling">· {{ status.cooling }} 个账号在冷却（限流或余额耗尽，会自动恢复）</div>
                <div v-if="status.disabled">· {{ status.disabled }} 个账号被禁用（连续失败，需重新登录）</div>
                <div v-if="status.inFlightFull">· {{ status.inFlightFull }} 个账号在途请求已满</div>
                <div v-if="status.stickySessions">· {{ status.stickySessions }} 个会话粘性绑定中</div>
                <div v-if="status.redisMode && status.redisMode !== 'noop'">· 状态镜像：{{ status.redisMode }}</div>
              </div>
            </div>

            <!-- 积分包口径 -->
            <div class="ws-card wb-block">
              <div class="wb-block__head">
                <span class="wb-block__title"><el-icon><Coin /></el-icon>积分说明</span>
              </div>
              <p class="wb-hint" style="margin: 0">
                上游积分由签到、活动发放，不花钱但会过期，和「模型用量」里
                NewAPI 的余额是两条独立账。网关按「积分多、快过期的先用」在三因子权重里轮转。
              </p>
              <p v-if="snap.creditStale" class="ws-dim" style="margin: 8px 0 0; font-size: 11.5px">
                积分数据是上次查询的缓存（{{ agoOf(snap.creditAt) }}），点刷新可立即重查。
              </p>
              <p v-if="isLocal && snap.lastError" class="ws-dim" style="margin: 6px 0 0; font-size: 11.5px">
                上次查询出错：{{ snap.lastError }}
              </p>
              <p
                v-if="!isLocal && remoteCredit?.lastError"
                class="ws-dim"
                style="margin: 6px 0 0; font-size: 11.5px"
              >
                上次向那台机器查积分出错：{{ remoteCredit.lastError }}（下面显示的是上一次成功的数据）
              </p>
            </div>

            <!-- 怎么用：这页只显示「有多少额度」，不说「怎么花掉」，所以补一张接法卡。
                 API key 不在这里显示，也不经边车下发到浏览器 —— 只说去哪找。 -->
            <div v-if="isLocal" class="ws-card wb-block">
              <div class="wb-block__head">
                <span class="wb-block__title"><el-icon><Connection /></el-icon>怎么用这些模型</span>
              </div>

              <table class="wb-how__table">
                <tr>
                  <td>Base URL</td>
                  <td>
                    <div class="wb-cred">
                      <code class="ws-mono">{{ baseV1 }}</code>
                      <el-button
                        size="small"
                        text
                        type="primary"
                        @click="copyText(baseV1, 'Base URL 已复制')"
                      >
                        复制
                      </el-button>
                    </div>
                  </td>
                </tr>
                <tr>
                  <td>API Key</td>
                  <td>
                    <div class="wb-cred">
                      <code class="ws-mono wb-cred__key">{{ credText }}</code>
                      <el-button size="small" text type="primary" @click="toggleReveal">
                        {{ revealed ? '隐藏' : '显示' }}
                      </el-button>
                      <el-button size="small" text type="primary" @click="copyKey">复制</el-button>
                    </div>
                  </td>
                </tr>
              </table>

              <p v-if="cred && !cred.ok" class="ws-dim" style="margin: 8px 0 0; font-size: 11.5px">
                {{ cred.error }}
              </p>
              <p class="ws-dim" style="margin: 8px 0 0; font-size: 11.5px">
                网关是独立进程、手动启停；没开时这里读不到数据。
              </p>
            </div>
          </div>
        </div>

        <!-- ================================================== 请求日志 -->
        <!-- 读的是网关自己写的 data/server.out.log。该文件被启动脚本每次启动覆盖，
             所以它只覆盖网关「本次运行」—— 标题里如实写出来，别让人当成历史全量。 -->
        <div v-if="isLocal" class="ws-card wb-block wb-logs">
          <div class="wb-block__head">
            <span class="wb-block__title">
              <el-icon><Document /></el-icon>
              请求日志
              <span class="ws-dim" style="font-weight: 400; font-size: 12px">
                （本次运行 {{ logTotal }} 条<template v-if="logFailed">，失败 {{ logFailed }}</template>）
              </span>
            </span>
            <div class="ws-row">
              <el-input
                v-model="logKeyword"
                size="small"
                placeholder="筛选模型 / 账号…"
                clearable
                style="width: 170px"
                @keyup.enter="loadLogs()"
                @clear="loadLogs()"
              />
              <el-checkbox v-model="logOnlyFail" size="small" @change="loadLogs()">只看失败</el-checkbox>
              <el-button size="small" text type="primary" :loading="logBusy" @click="loadLogs()">
                刷新
              </el-button>
            </div>
          </div>

          <EmptyState
            v-if="!logs.length"
            :title="logsError ? '读不到网关日志' : '还没有请求记录'"
            :description="logsError || '用上面的 Base URL 调一次，这里就会出现记录（日志按网关进程计，重启后重新开始）'"
            icon="Document"
          />
          <div v-else>
            <div class="wb-loglist">
              <div class="wb-loghead">
                <span>时间</span><span>模型</span><span>账号</span>
                <span class="wb-loghead__r">TTFB</span><span class="wb-loghead__r">tokens</span>
                <span class="wb-loghead__r">耗时</span><span class="wb-loghead__r">状态</span>
              </div>
              <div
                v-for="l in logs"
                :key="l.seq"
                class="wb-logrow"
                :class="{ 'is-fail': !l.ok }"
              >
                <span class="ws-mono wb-logrow__time">{{ l.time }}</span>
                <span class="ws-mono wb-logrow__model" :title="l.model">{{ l.model }}</span>
                <span class="wb-logrow__acct" :title="l.uid8">{{ l.account }}</span>
                <span class="ws-mono wb-logrow__r">{{ l.ttfbMs == null ? '—' : l.ttfbMs + 'ms' }}</span>
                <span class="ws-mono wb-logrow__r">
                  {{ l.tokens == null ? '—' : num(l.tokens) }}
                  <i v-if="l.tokensPerSec" class="wb-logrow__rate">{{ l.tokensPerSec }}t/s</i>
                </span>
                <span class="ws-mono wb-logrow__r">{{ l.totalSec == null ? '—' : l.totalSec + 's' }}</span>
                <span class="wb-logrow__r">
                  <span class="wb-tag" :class="l.ok ? 'is-ok' : 'is-danger'">{{ l.status ?? '—' }}</span>
                  <i v-if="l.stream" class="wb-logrow__mode">流</i>
                </span>
              </div>
            </div>
            <!-- 计数提示放在滚动区**外面**：滚到中间也能看到「这是最近 N 条 / 共多少」 -->
            <p class="wb-lognote">
              显示最近 {{ logs.length }} 条<template v-if="logTotal > logs.length">（本次运行共 {{ logTotal }} 条）</template>
              <template v-else>（本次运行全部）</template>
            </p>
          </div>
        </div>

        <!-- ============================================== 支持的模型清单 -->
        <!-- 单独占一行通栏：40+ 行挤在右列会矮得没法看。
             服务端已按倍率升序排列，免费的在最前 —— 日常杂活优先用这些。 -->
        <div v-if="models.length" class="ws-card wb-block wb-models">
          <div class="wb-block__head">
            <span class="wb-block__title">
              <el-icon><Grid /></el-icon>
              支持的模型
              <span class="ws-dim" style="font-weight: 400; font-size: 12px">
                （{{ models.length }} 个<template v-if="freeCount">，其中 {{ freeCount }} 个免费</template>）
              </span>
            </span>
            <div class="ws-row">
              <span v-if="snap.modelsAt" class="ws-dim" style="font-size: 11.5px">
                {{ agoOf(snap.modelsAt) }}更新
              </span>
              <el-input
                v-model="modelFilter"
                size="small"
                placeholder="筛选模型…"
                clearable
                style="width: 160px"
              />
              <el-button size="small" text type="primary" @click="copyModelNames">
                复制模型名
              </el-button>
            </div>
          </div>

          <div class="wb-mgrid">
            <div
              v-for="m in filteredModels"
              :key="m.id"
              class="wb-mcard"
              :class="{
                'is-free': m.multiplier === 0 && quotaOf(m).usable > 0,
                'is-exhausted': quotaOf(m).total > 0 && quotaOf(m).usable === 0,
                'is-tight': quotaOf(m).total > 0 && quotaOf(m).usable > 0 && quotaOf(m).usable <= Math.ceil(quotaOf(m).total / 4),
              }"
              title="点开看每个号的限额明细"
              @click="openQuota(m)"
            >
              <div class="wb-mcard__top">
                <code
                  class="ws-mono wb-mcard__id"
                  title="点一下复制这个模型名"
                  @click.stop="copyText(m.model, `已复制 ${m.model}`)"
                >{{ m.model }}</code>
                <span class="wb-tag" :class="`is-${multTag(m).tone}`">{{ multTag(m).text }}</span>
              </div>
              <div v-if="m.name && m.name !== m.model" class="wb-mcard__title">{{ m.name }}</div>
              <div class="wb-mcard__meta">
                <span v-if="m.context" :title="`上下文 ${m.context} tokens`">
                  {{ ctxShort(m.context) }} 上下文
                </span>
                <span v-if="m.images">· 支持图片</span>
                <span v-if="m.reasoning">· 推理</span>
              </div>
              <!-- 今日限额：卡片上只给两端。可用号数，加上到限额的号里最早和
                   最晚的恢复时间。每个号的明细点开弹窗看。 -->
              <div v-if="quotaOf(m).total" class="wb-mcard__quota">
                <span
                  class="wb-tag"
                  :class="quotaOf(m).usable === 0 ? 'is-danger' : quotaOf(m).blocked.length ? 'is-warn' : 'is-ok'"
                >
                  {{ quotaOf(m).usable }}/{{ quotaOf(m).total }} 个号可用
                </span>
                <span v-if="quotaOf(m).earliest" class="wb-mcard__span ws-dim">
                  {{ quotaOf(m).earliest.slice(6) }}
                  <template v-if="quotaOf(m).latest"> ~ {{ quotaOf(m).latest.slice(6) }}</template>
                  恢复
                </span>
              </div>
            </div>
          </div>

          <p class="ws-dim" style="margin: 10px 0 0; font-size: 11.5px">
            点模型看每个号的限额明细。卡片上只标今天还有几个号能用，以及到限额的号里最早和最晚的恢复时间。上游不给剩余次数，只在用满时报几点恢复。
          </p>

          <!-- 模型限额明细：一张卡点开一份。可用的号和到限额的号分开列，
               到限额的按恢复时刻从早到晚排。 -->
          <el-dialog
            :model-value="!!quotaDialog"
            :title="quotaDialog?.model ?? ''"
            width="520px"
            modal-class="wb-qdialog"
            @close="quotaDialog = null"
          >
            <template v-if="quotaDialog">
              <p class="ws-dim" style="margin: 0 0 12px; font-size: 12.5px">
                {{ quotaDialog.name ? quotaDialog.name + ' · ' : '' }}
                今天 {{ quotaDialog.usable }}/{{ quotaDialog.total }} 个号可用
                <template v-if="quotaDialog.earliest">
                  · 最早 {{ quotaDialog.earliest }} 恢复
                  <template v-if="quotaDialog.latest">，最晚 {{ quotaDialog.latest }}</template>
                </template>
              </p>

              <div class="wb-block__head" style="margin-bottom: 6px">
                <span class="wb-block__title" style="font-size: 13px">还能用（{{ quotaDialog.usable }}）</span>
              </div>
              <div v-if="usableOf(quotaDialog).length" class="wb-qlist">
                <span v-for="a in usableOf(quotaDialog)" :key="a.uid" class="wb-tag is-ok" :title="a.uid">
                  {{ a.nickname }}
                </span>
              </div>
              <p v-else class="ws-dim" style="margin: 0; font-size: 12px">今天没有号能用这个模型。</p>

              <div class="wb-block__head" style="margin: 14px 0 6px">
                <span class="wb-block__title" style="font-size: 13px">已到限额（{{ quotaDialog.blocked.length }}）</span>
              </div>
              <table v-if="quotaDialog.blocked.length" class="wb-table">
                <thead>
                  <tr>
                    <th>账号</th>
                    <th style="width: 130px">恢复时间</th>
                    <th>原因</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="b in quotaDialog.blocked" :key="b.uid + b.reason">
                    <td :title="b.uid">
                      {{ b.name }}
                      <span v-if="b.all" class="ws-dim"> · 全部模型</span>
                    </td>
                    <td class="ws-mono">{{ b.when || '—' }}</td>
                    <td class="ws-dim">{{ reasonText(b.reason) }}</td>
                  </tr>
                </tbody>
              </table>
              <p v-else class="ws-dim" style="margin: 0; font-size: 12px">今天还没有号到这个模型的限额。</p>
            </template>
          </el-dialog>

          <EmptyState
            v-if="!filteredModels.length"
            title="没有匹配的模型"
            :description="`「${modelFilter}」没有匹配项，清空筛选看全部 ${models.length} 个`"
          />

          <p class="ws-dim" style="margin: 10px 0 0; font-size: 11.5px">
            点模型名即可复制单个；「复制模型名」按当前筛选结果复制（每行一个）。
            填客户端时用左边这串裸名；也可加 <code class="ws-mono">cn:</code> 前缀显式指定国内版。
            倍率是官方积分倍率（相对基准），免费档不扣积分。
          </p>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
/* --------------------------------------------------------------- KPI --- */
.wb-kpi {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--ws-space-4);
  margin-bottom: var(--ws-space-4);
}
.wb-kpi__card {
  padding: var(--ws-space-4) var(--ws-space-5);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
/* 剩余积分卡：主色描边强调，是这一页的主角 */
.wb-kpi__card--hero {
  border-color: var(--ws-accent);
  box-shadow: var(--ws-shadow-2);
}
.wb-kpi__label {
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-3);
  letter-spacing: 0.02em;
}
.wb-kpi__value {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: var(--ws-fs-xl);
  font-weight: 600;
  color: var(--ws-text);
  line-height: 1.15;
}
.wb-kpi__value i {
  font-style: normal;
  font-size: var(--ws-fs-base);
  font-weight: 500;
  color: var(--ws-text-3);
}
.wb-kpi__foot {
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-3);
  display: flex;
  align-items: center;
  gap: 6px;
}

/* --------------------------------------------------------------- 进度条 -- */
.wb-bar {
  height: 6px;
  border-radius: var(--ws-radius-pill);
  background: var(--ws-border);
  overflow: hidden;
}
.wb-bar--sm {
  height: 5px;
}
.wb-bar__fill {
  height: 100%;
  border-radius: inherit;
  background: var(--ws-accent);
  transition: width 0.3s ease;
}
.wb-bar__fill.is-ok {
  background: var(--ws-success);
}
.wb-bar__fill.is-warn {
  background: var(--ws-warn);
}
.wb-bar__fill.is-danger {
  background: var(--ws-danger);
}
.wb-bar__fill.is-muted {
  background: var(--ws-text-3);
}

/* ------------------------------------------------------------- 布局 --- */
.wb-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(280px, 0.9fr);
  gap: var(--ws-space-4);
  align-items: start;
}
@media (max-width: 1100px) {
  .wb-grid {
    grid-template-columns: 1fr;
  }
}
.wb-side {
  display: flex;
  flex-direction: column;
  gap: var(--ws-space-4);
}
.wb-block {
  padding: var(--ws-space-4) var(--ws-space-5);
}
.wb-block__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ws-space-3);
  margin-bottom: var(--ws-space-3);
  flex-wrap: wrap;
}
.wb-block__ctl {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-left: auto;
}
.wb-block__split {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0 9px;
  font-size: 11.5px;
  color: var(--ws-text-3);
}
.wb-block__split::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--ws-border);
}
.wb-block__title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--ws-fs-md);
  font-weight: 600;
  color: var(--ws-text);
}

/* ------------------------------------------------------------- 表格 --- */
.wb-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--ws-fs-sm);
}
.wb-table th {
  text-align: left;
  font-weight: 500;
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-3);
  padding: 0 8px 8px 0;
  border-bottom: 1px solid var(--ws-border);
  white-space: nowrap;
}
.wb-table td {
  padding: 10px 8px 10px 0;
  border-bottom: 1px solid var(--ws-border);
  vertical-align: middle;
}
.wb-table tr:last-child td {
  border-bottom: none;
}
.wb-acc__name {
  display: block;
  color: var(--ws-text);
  font-weight: 500;
}
.wb-acc__meta {
  display: block;
  font-size: 11px;
  color: var(--ws-text-3);
  margin-top: 2px;
}
/* 今日限额：一个模型一行。模型名可能很长，超了省略，完整名字在 title 上 */
.wb-limit {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 11.5px;
  line-height: 1.6;
}
.wb-limit__model {
  max-width: 118px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ws-text);
}
/* 数字着色：与进度条同一套阈值语义 */
.wb-table b.is-ok {
  color: var(--ws-success);
}
.wb-table b.is-warn {
  color: var(--ws-warn);
}
.wb-table b.is-danger {
  color: var(--ws-danger);
}
.wb-table b.is-muted {
  color: var(--ws-text-3);
}

/* --------------------------------------------------------------- 标签 -- */
.wb-tag {
  display: inline-block;
  padding: 1px 8px;
  border-radius: var(--ws-radius-pill);
  font-size: 11px;
  line-height: 18px;
  white-space: nowrap;
}
.wb-tag.is-ok {
  background: var(--ws-success-soft);
  color: var(--ws-success);
}
.wb-tag.is-warn {
  background: var(--ws-warn-soft);
  color: var(--ws-warn);
}
.wb-tag.is-danger {
  background: var(--ws-danger-soft);
  color: var(--ws-danger);
}
.wb-tag.is-muted {
  background: var(--ws-panel-2);
  color: var(--ws-text-3);
}

/* --------------------------------------------------------- 迷你统计 --- */
.wb-mini {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 16px;
}
.wb-mini__item {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.wb-mini__label {
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-3);
}
.wb-mini__value {
  font-size: var(--ws-fs-base);
  font-weight: 600;
  color: var(--ws-text);
  font-variant-numeric: tabular-nums;
}
.wb-mini__value.is-ok {
  color: var(--ws-success);
}
.wb-mini__value.is-danger {
  color: var(--ws-danger);
}
.wb-hint {
  margin-top: 10px;
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-3);
  line-height: 1.7;
}

/* --------------------------------------------------------- 请求日志 --- */
.wb-logs {
  margin-top: var(--ws-space-4);
}
.wb-loglist {
  font-size: var(--ws-fs-sm);
  /* 固定高度 + 内部滚动（与「模型用量」日志区同为 460px）：
     100 条铺开会把页面拉得很长，滚起来才看得完 */
  max-height: 460px;
  overflow-y: auto;
}
/* 定宽列：时间 / 模型(伸缩) / 账号 / 三个右对齐数字 / 状态 */
.wb-loghead,
.wb-logrow {
  display: grid;
  grid-template-columns: 62px minmax(0, 1fr) 96px 62px 128px 56px 62px;
  gap: 8px;
  align-items: center;
}
.wb-loghead {
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-3);
  padding: 0 0 6px;
  border-bottom: 1px solid var(--ws-border);
  /* 粘住表头：滚到下面也知道每列是什么（背景必须不透明，否则行会透出来） */
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--ws-panel);
}
.wb-loghead__r {
  text-align: right;
}
.wb-logrow {
  padding: 6px 0;
  border-bottom: 1px solid var(--ws-border);
  font-size: 12.5px;
}
.wb-logrow:last-child {
  border-bottom: none;
}
.wb-logrow.is-fail {
  background: var(--ws-danger-soft);
}
.wb-logrow__time {
  color: var(--ws-text-3);
  font-size: 11.5px;
}
.wb-logrow__model {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ws-text);
}
.wb-logrow__acct {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ws-text-2);
  font-size: 11.5px;
}
.wb-logrow__r {
  text-align: right;
  color: var(--ws-text-2);
  font-size: 11.5px;
  white-space: nowrap;
}
/* token 速率与「流」标记：附在主数值后面的次要信息 */
.wb-logrow__rate,
.wb-logrow__mode {
  font-style: normal;
  color: var(--ws-text-3);
  font-size: 10.5px;
  margin-left: 3px;
}
/* 计数提示（在滚动区外，始终可见） */
.wb-lognote {
  margin: 10px 0 0;
  font-size: 11.5px;
  color: var(--ws-text-3);
}
/* 窄屏：账号与 TTFB 先让位，避免挤成一团 */
@media (max-width: 1180px) {
  .wb-loghead,
  .wb-logrow {
    grid-template-columns: 58px minmax(0, 1fr) 62px 118px 52px 58px;
  }
  .wb-logrow__acct,
  .wb-loghead > span:nth-child(3) {
    display: none;
  }
}

/* --------------------------------------------------------- 怎么用 --- */
.wb-how__table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--ws-fs-xs);
}
/* 值 + 按钮同排；key 长，必须能换行不撑破卡片 */
.wb-cred {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.wb-cred__key {
  flex: 1;
  min-width: 0;
  word-break: break-all;
}
.wb-how__table td {
  padding: 4px 0;
  vertical-align: top;
  color: var(--ws-text-2);
  line-height: 1.6;
}
.wb-how__table td:first-child {
  width: 68px;
  color: var(--ws-text-3);
  white-space: nowrap;
}
.wb-how__table code {
  background: var(--ws-panel-2);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 11px;
  word-break: break-all;
}

/* --------------------------------------------------------- 模型分布 --- */
.wb-dist {
  display: flex;
  flex-direction: column;
  gap: 11px;
}
.wb-dist__top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}
.wb-dist__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ws-text);
}
.wb-dist__val {
  flex: 0 0 auto;
  font-size: 12px;
  font-weight: 600;
  color: var(--ws-text);
}
.wb-dist__track {
  height: 6px;
  margin: 5px 0 3px;
  border-radius: var(--ws-radius-pill);
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
  overflow: hidden;
}
.wb-dist__track i {
  display: block;
  height: 100%;
  border-radius: var(--ws-radius-pill);
  background: linear-gradient(to right, var(--ws-accent), var(--ws-accent-grad-end));
}
.wb-dist__meta {
  font-size: 11px;
}

/* --------------------------------------------------------- 模型清单 --- */
.wb-models {
  margin-top: var(--ws-space-4);
}
/* 自适应列数：宽屏 4 列，窄了自动降到 1 列，不用写媒体查询 */
.wb-mgrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(212px, 1fr));
  gap: 8px;
}
.wb-mcard {
  border: 1px solid var(--ws-border);
  border-radius: var(--ws-radius-sm);
  padding: 8px 10px;
  background: var(--ws-panel-2);
  min-width: 0;
  cursor: pointer;
}
.wb-mcard:hover {
  border-color: var(--ws-accent);
}
/* 免费档描边提亮：这是最该被优先用的一档 */
.wb-mcard.is-free {
  border-color: var(--ws-success);
  background: var(--ws-success-soft);
}
/* 今天一个号都用不了：盖过免费绿边，避免「免费但实际打不通」看起来还能用 */
.wb-mcard.is-exhausted {
  border-color: var(--ws-danger);
  background: var(--ws-danger-soft);
}
/* 还剩不到四分之一的号：黄边提醒，别和「全部可用」的白卡混在一起 */
.wb-mcard.is-tight {
  border-color: var(--ws-warn);
  background: var(--ws-warn-soft);
}
.wb-mcard__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.wb-mcard__id {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
  color: var(--ws-text);
  cursor: pointer;
  background: none;
  padding: 0;
}
.wb-mcard__id:hover {
  color: var(--ws-accent);
}
.wb-mcard__title {
  font-size: 11px;
  color: var(--ws-text-3);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wb-mcard__meta {
  font-size: 10.5px;
  color: var(--ws-text-3);
  margin-top: 4px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
/* 今日限额：可用号数 + 恢复时间的两端（最早 ~ 最晚）。明细在弹窗里。 */
.wb-mcard__quota {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 6px;
  margin-top: 6px;
}
.wb-mcard__span {
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}
/* 弹窗里「还能用」的号：标签换行排，不挤成一行。 */
.wb-qlist {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
/* 倍率的 info 档（便宜但不免费）用蓝，区别于免费绿与普通灰 */
.wb-tag.is-info {
  background: var(--ws-info-soft);
  color: var(--ws-info);
}

/* --------------------------------------------------------- 网关离线 --- */
.wb-offline {
  display: flex;
  align-items: flex-start;
  gap: var(--ws-space-4);
  padding: var(--ws-space-5);
  border-color: var(--ws-warn);
}
.wb-offline__icon {
  font-size: 22px;
  color: var(--ws-warn);
  flex-shrink: 0;
}
.wb-offline__title {
  font-size: var(--ws-fs-md);
  font-weight: 600;
  color: var(--ws-text);
}
</style>
