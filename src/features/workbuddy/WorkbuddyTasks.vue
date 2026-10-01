<script setup lang="ts">
/**
 * WorkBuddy 活动管理 —— 六类排程任务的开关与手动执行，外加一份「谁在什么时候做了什么、
 * 拿了多少分」的活动日志。
 *
 * 数据是两路合流的（合成在边车 lib/workbuddy-activity.mjs）：
 *   ① 本页手动跑的：CLI / 脚本的 stdout+stderr 逐账号解析；
 *   ② 网关自己排程跑的：读 data/server.err.log 的逐账号行（9/21 点签到、10 点活跃、
 *      12 点开学季、01 点夜猫子、22 点保活），按事件去重后落盘 —— 边车重启也不丢。
 * 所以这一页看到的是「网关 + 手动」的完整流水，而不是只有刚才点的那一下。
 *
 * 积分增量的口径：会发积分的任务，跑前跑后各查一次 credit（只读），得到每个号
 * remain 的变化；条目里同时写「before → after」，因为中途若有对话在消耗积分，
 * 差值是「余额变化」而不是官方奖励面额。
 * 页眉合计只加逐账号行。「全体账号」和「一键完成」是这些行的加总，再加一次会把同一笔算进三次。
 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import SidecarOffline from '@/components/SidecarOffline.vue'
import EmptyState from '@/components/EmptyState.vue'
import { api, ensureSidecar } from '@/core/sidecar'
import { agoOf, timeOfMs } from './wb-shared'

const ready = ref(false)
const err = ref('')
const schedule = ref<any>(null)
const log = ref<any>({ items: [], total: 0, counts: {} })
const runs = ref<any[]>([])
const draft = reactive<Record<string, boolean>>({})
const runningId = ref('')
const busy = ref('')
const refreshing = ref(false)
const openId = ref('')
const filter = reactive({ task: '', onlyCredit: false })
const saving = ref(false)
let timer: ReturnType<typeof setInterval> | null = null

/** 任务 id → 中文名（日志标签 / 筛选下拉共用一个来源，避免两处漂） */
const LABELS = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {}
  for (const t of schedule.value?.tasks ?? []) out[t.id] = t.label
  for (const t of schedule.value?.extra ?? []) out[t.id] = t.label
  if (schedule.value?.chain) out[schedule.value.chain.id] = schedule.value.chain.label
  return out
})

/** 一键完成的限流保护状态（间隔 / 冷却 / 能否开跑，全部由边车算好） */
const chain = computed<any>(() => schedule.value?.chain ?? null)

/** 正在跑的那次一键完成（用它渲染进度：第几步、等多久、每步结果） */
const chainRun = computed<any>(() => runs.value.find((r) => r.task === 'all' && r.running) ?? null)

/** 等待倒计时（步间等待是防限流的一部分，明码显示让人知道不是在卡） */
const waitLeft = ref(0)
let waitTimer: ReturnType<typeof setInterval> | null = null
function startWaitTick() {
  if (waitTimer) clearInterval(waitTimer)
  waitTimer = setInterval(() => {
    const until = chainRun.value?.waitUntil ?? 0
    waitLeft.value = until ? Math.max(0, Math.round((until - Date.now()) / 1000)) : 0
  }, 500)
}
onUnmounted(() => {
  if (waitTimer) clearInterval(waitTimer)
})

const tasks = computed<any[]>(() => schedule.value?.tasks ?? [])
const extras = computed<any[]>(() => schedule.value?.extra ?? [])
const anyRunning = computed(() => runs.value.some((r) => r.running))

/** 有没有改过开关：只有改过才让「保存并应用」可点（键名由后端给，前端不拼字符串） */
const changes = computed(() => {
  const out: { key: string; label: string; value: boolean }[] = []
  for (const t of tasks.value) {
    const want = draft[t.id]
    if (want === undefined || want === t.enabled || !t.enabledKey) continue
    out.push({ key: t.enabledKey, label: t.label, value: want })
  }
  return out
})

const disabledRows = computed(() => tasks.value.filter((t) => !t.enabled))

/* --------------------------------------------------------------- 加载 --- */

/** 手动刷新：页面上唯一会显示转圈的入口（自动轮询不打扰） */
async function refresh() {
  refreshing.value = true
  await load()
  tick()
  refreshing.value = false
}

/* ---------------- 账号池主机（与「额度」页共用同一个选择：选中一处，另一处也跟着切） ---------------- */
const hosts = ref<any[]>([])
const hostId = ref<string>(localStorage.getItem('workbuddy.host') || 'local')
const isLocal = computed(() => hostId.value === 'local')
const hostName = computed(() => hosts.value.find((h) => h.id === hostId.value)?.name ?? '本机')

async function loadHosts() {
  const r = await api.workbuddyHosts()
  if (r.ok) hosts.value = r.data?.items ?? []
}
function switchHost(id: string) {
  if (id === hostId.value) return
  hostId.value = id
  localStorage.setItem('workbuddy.host', id)
  schedule.value = null
  runs.value = []
  log.value = null
  for (const k of Object.keys(draft)) delete (draft as any)[k]
  load()
}

async function load() {
  const online = await ensureSidecar()
  if (!online) {
    ready.value = true
    return
  }
  // 远端：排程与运行记录都从那边取；活动日志读的是本机网关的 server.err.log，远端不适用
  const [s, l, r] = await Promise.all([
    api.workbuddySchedule(hostId.value),
    isLocal.value
      ? api.workbuddyActivity({ limit: 150, task: filter.task, onlyCredit: filter.onlyCredit ? 1 : 0 })
      : Promise.resolve({ ok: true, data: null }),
    api.workbuddyRuns(20, hostId.value),
  ])
  ready.value = true
  if (!s.ok) {
    err.value = s.error ?? '读取任务表失败'
    return
  }
  err.value = ''
  schedule.value = s.data
  // 首次进来把草稿对齐到网关的实际开关；已经改过的项不覆盖（否则刷新会吞掉未保存的改动）
  for (const t of s.data.tasks ?? []) {
    if (draft[t.id] === undefined) draft[t.id] = t.enabled
  }
  if (l.ok) log.value = l.data
  if (r.ok) runs.value = r.data.runs ?? []
  // 一键完成的等待倒计时：只要链路在跑就跟着走（不能只在「点了按钮的那个页面」里才动）
  if (chainRun.value) startWaitTick()
  else if (waitTimer) {
    clearInterval(waitTimer)
    waitTimer = null
    waitLeft.value = 0
  }
}

/** 有任务在跑就 4 秒一刷（等它的逐账号结果），否则 20 秒（只为刷出网关排程干的事） */
function tick() {
  const ms = anyRunning.value ? 4000 : 20000
  if (timer) clearInterval(timer)
  timer = setInterval(load, ms)
}

onMounted(async () => {
  await loadHosts()
  await load()
  tick()
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

/* ------------------------------------------------------------- 动作 --- */

/**
 * 一键完成：六类任务串行跑一遍。
 *
 * 「不能被限流」这件事由边车保证（这里只是入口）：串行不并发、步间等 gapSec 秒、
 * 命中 429/6004/风控/频率字样立刻停并把剩余步骤作废、链路有最小间隔与冷却。
 * 所以点之前先说清楚它要跑几分钟、以及为什么有间隔。
 */
async function runAll() {
  const c = chain.value
  if (!c) return
  try {
    await ElMessageBox.confirm(
      [
        `串行跑六类任务：${c.order.map((k: string) => LABELS.value[k] ?? k).join(' → ')}`,
        `· 一步跑完等约 ${c.gapSec} 秒再跑下一步（给上游冷却窗口，全程不并发）`,
        `· 命中限流信号（429 / 6004 / 频率 / 风控）立即停止剩余步骤，并冷却 ${c.cooldownMin} 分钟`,
        `· 两次一键完成之间至少隔 ${c.minIntervalMin} 分钟（奖励按天发，多跑不会多拿）`,
        `· 全程约 ${c.order.length * 1} - ${c.order.length * 2} 分钟，中途可以关页面，结果会进活动日志`,
      ].join('<br>'),
      '一键完成',
      { confirmButtonText: '开始', cancelButtonText: '取消', type: 'info', dangerouslyUseHTMLString: true },
    )
  } catch {
    return
  }
  runningId.value = 'all'
  const r = await api.workbuddyStartTask('all', '', hostId.value)
  runningId.value = ''
  if (!r.ok || r.data?.ok === false) {
    return ElMessage.error(r.error ?? r.data?.error ?? '启动失败')
  }
  ElMessage.success('已开始，逐账号结果会一路写进下面的活动日志')
  await load()
  tick()
  startWaitTick()
}

async function run(id: string) {
  runningId.value = id
  const r = await api.workbuddyStartTask(id as any, '', hostId.value)
  runningId.value = ''
  if (!r.ok || r.data?.ok === false) {
    return ElMessage.error(r.error ?? r.data?.error ?? '启动失败')
  }
  ElMessage.success(`已开始跑「${LABELS.value[id] ?? id}」，跑完这一页会自动出现逐账号结果`)
  await load()
  tick()
}

/**
 * 保存并应用：写网关 config.json 的 schedule 段，然后重启网关。
 * 为什么必须重启 —— 网关只在启动时读一次 schedule 来构建调度器（账号有 5s 目录监听，
 * schedule 没有）。重启几秒，在跑的对话会断，所以先跟用户确认一次。
 */
async function save() {
  const ch = changes.value
  if (!ch.length) return
  const lines = ch.map((c) => `${c.label}：${c.value ? '开' : '关'}`)
  try {
    await ElMessageBox.confirm(
      `将写入网关 config.json 并重启网关（几秒，期间对话会断）：\n\n${lines.join('\n')}`,
      '保存并应用',
      { confirmButtonText: '保存并重启', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }
  saving.value = true
  const patch: Record<string, boolean> = {}
  for (const c of ch) patch[c.key] = c.value
  const r = await api.workbuddyScheduleSave(patch, true)
  saving.value = false
  if (!r.ok || r.data?.ok === false) {
    return ElMessage.error(r.error ?? r.data?.error ?? '保存失败')
  }
  ElMessage.success('已保存并重启网关')
  for (const t of tasks.value) draft[t.id] = t.enabled // 清掉草稿，重新对齐
  await load()
}

/** 放弃还没保存的改动 */
function reset() {
  for (const t of tasks.value) draft[t.id] = t.enabled
}

async function toggleRun(id: string) {
  if (openId.value === id) {
    openId.value = ''
    return
  }
  openId.value = id
  busy.value = id
  const r = await api.workbuddyRunGet(id, hostId.value)
  busy.value = ''
  if (r.ok && r.data?.ok !== false) {
    const idx = runs.value.findIndex((x) => x.id === id)
    if (idx >= 0) runs.value[idx] = { ...runs.value[idx], ...r.data.run }
  }
}

/* ------------------------------------------------------------- 展示 --- */

/** 任务标签配色：签到/活跃/旅行/保活/开学季/夜猫子各一色（同一任务在日志里颜色固定） */
const TONE: Record<string, string> = {
  checkin: '#0ea5e9',
  activity: '#7c3aed',
  travel: '#f59e0b',
  keepalive: '#64748b',
  school: '#10b981',
  cat: '#6366f1',
  trial: '#ec4899',
  credits: '#0f766e',
}

function toneOf(task: string) {
  return TONE[task] ?? '#8b90a5'
}

function toneTag(tone: string) {
  const map: Record<string, string> = { ok: 'is-ok', warn: 'is-warn', fail: 'is-danger', danger: 'is-danger', muted: 'is-info', info: 'is-info' }
  return map[tone] ?? 'is-info'
}

function deltaText(d?: number | null) {
  if (!Number.isFinite(d as number)) return ''
  const v = Number(d)
  if (v === 0) return '±0'
  return `${v > 0 ? '+' : ''}${v}`
}

function hourText(hours?: number[]) {
  const list = (hours ?? []).slice().sort((a, b) => a - b)
  if (!list.length) return '未设时间'
  return `${list.map((h) => String(h).padStart(2, '0')).join(' / ')} 点`
}

/** 任务行右侧那句话：关了就直说关了，开着就给下次触发时刻 */
function whenText(t: any) {
  if (!t.enabled) return '已关闭'
  if (!t.nextAt) return '未设时间'
  return `下次 ${timeOfMs(t.nextAt)}`
}
</script>

<template>
  <div class="ws-page">
    <PageHeader
      title="WorkBuddy 活动管理"
      subtitle="六类任务的开关与手动执行，以及逐账号的执行明细（网关排程 + 手动跑的合流）"
      icon="AlarmClock"
    >
      <template #actions>
        <el-button size="small" :loading="refreshing" @click="refresh">
          <el-icon><Refresh /></el-icon>&nbsp;刷新
        </el-button>
      </template>
    </PageHeader>

    <!-- 账号池主机：与「额度」页共用选择；远端是本机经 SSH 触发那边机器上的同名任务 -->
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
        <i v-if="h.kind === 'remote'" class="wb-hosts__tag">{{ h.keyConfigured === false ? '未配密钥' : '远端' }}</i>
      </button>
      <span v-if="!isLocal" class="wb-hosts__note">
        远端：任务由本机经 SSH 在 {{ hostName }} 上执行；下次触发时间由那台机器的网关决定（这里不猜）
      </span>
    </div>

    <SidecarOffline v-if="ready && err" />

    <template v-else-if="ready">
      <!-- ----------------------------------------------------- 活动管理 -->
      <div class="ws-card wbo-block" style="margin-bottom: 16px">
        <div class="wbo-block__head">
          <span class="wbo-block__title"><el-icon><SwitchButton /></el-icon>任务开关与手动执行</span>
          <span class="wbo-toolbar">
            <el-button
              type="primary"
              size="small"
              :loading="runningId === 'all'"
              :disabled="anyRunning || (isLocal && !chain?.canStart)"
              :title="chain?.blockReason || ''"
              @click="runAll"
            >
              <el-icon><MagicStick /></el-icon>&nbsp;一键完成
            </el-button>
            <el-button v-if="isLocal && changes.length" size="small" @click="reset">撤销改动</el-button>
            <el-button v-if="isLocal" type="primary" size="small" :disabled="!changes.length" :loading="saving" @click="save">
              保存并应用{{ changes.length ? `（${changes.length}）` : '' }}
            </el-button>
          </span>
        </div>

        <!-- 一键完成的实时进度：第几步、等多久、每步结果 -->
        <div v-if="chainRun" class="wba-chain">
          <span class="wba-chain__now">
            <el-icon class="wba-spin"><Refresh /></el-icon>
            进行中：第 {{ chainRun.stepIndex }}/{{ chainRun.total }} 步 · {{ LABELS[chainRun.step] ?? chainRun.step }}
          </span>
          <span v-if="waitLeft" class="ws-dim">步间等待 {{ waitLeft }} 秒（防限流，不并发）</span>
          <span v-if="chainRun.throttled" style="color: var(--ws-warn)">
            命中限流信号「{{ chainRun.throttled }}」，已停止后续步骤
          </span>
          <span class="wba-chain__steps">
            <span v-for="s in chainRun.steps" :key="s.task" class="wba-tag" :class="`is-${s.state}`">
              {{ s.label }}
            </span>
          </span>
        </div>

        <div v-for="t in tasks" :key="t.id" class="wba-row">
          <el-switch :disabled="!isLocal"
            v-model="draft[t.id]" size="small" />
          <span class="wba-row__name">{{ t.label }}</span>
          <span class="wba-row__hint">{{ t.hint }}</span>
          <span class="ws-dim wba-row__when">
            {{ hourText(t.hours) }} · {{ whenText(t) }}
          </span>
          <span class="wba-row__last" :title="t.last ? `${timeOfMs(t.last.at)} · ${t.last.text}` : ''">
            <template v-if="t.last">
              <span class="wbo-tag" :class="toneTag(t.last.tone)">
                {{ t.last.source === 'panel' ? '手动' : '网关' }}
              </span>
              <span class="ws-dim">{{ timeOfMs(t.last.at) }} · {{ t.last.text }}</span>
            </template>
            <span v-else class="ws-dim">还没跑过</span>
          </span>
          <el-button
            size="small"
            type="primary"
            plain
            :loading="runningId === t.id"
            :disabled="!!runningId || anyRunning"
            @click="run(t.id)"
          >
            立即执行
          </el-button>
        </div>

        <div class="wbo-toolbar" style="margin-top: 12px; gap: 14px">
          <span class="ws-dim" style="font-size: 12px">其他动作：</span>
          <el-button
            v-for="e in extras"
            :key="e.id"
            size="small"
            :loading="runningId === e.id"
            :disabled="!!runningId || anyRunning"
            @click="run(e.id)"
          >
            {{ e.label }}
          </el-button>
          <span class="ws-dim" style="font-size: 11.5px">{{ extras.map((e: any) => e.hint).join('；') }}</span>
        </div>

        <p
          v-if="chain && !chain.canStart && chain.blockReason && !chainRun"
          class="wbo-note"
          :style="{ color: chain.cooling ? 'var(--ws-danger)' : 'var(--ws-warn)' }"
        >
          <el-icon><WarningFilled /></el-icon> 一键完成暂不可用：{{ chain.blockReason }}
          <template v-if="chain.cooling">
            （期间单个任务仍可手动跑，但上游既然已经提示限流，建议等到冷却结束）
          </template>
        </p>
        <p class="wbo-note" style="margin-top: 12px">
          <el-icon><InfoFilled /></el-icon>
          开关写进网关 <span class="ws-mono">{{ schedule?.configPath }}</span>
          的 <span class="ws-mono">schedule</span> 段；网关只在启动时读一次排程表，所以「保存并应用」会顺手重启网关
          （几秒，期间对话会断）。改几点跑仍去<a href="#/office/workbuddy/config">网关配置</a>。
        </p>
        <p v-if="disabledRows.length" class="wbo-note">
          已关闭：{{ disabledRows.map((t: any) => t.label).join('、') }} —— 手动「立即执行」不受开关影响。
        </p>
        <p v-if="schedule?.configError" class="wbo-note" style="color: var(--ws-danger)">
          读配置出错：{{ schedule.configError }}
        </p>
      </div>

      <!-- ----------------------------------------------------- 活动日志（本机专属：读的是本机网关的日志文件） -->
      <div v-if="isLocal" class="ws-card wbo-block" style="margin-bottom: 16px">
        <div class="wbo-block__head">
          <span class="wbo-block__title"><el-icon><List /></el-icon>活动日志</span>
          <span class="wbo-toolbar">
            <el-select v-model="filter.task" size="small" style="width: 132px" placeholder="全部任务" clearable>
              <el-option label="全部任务" value="" />
              <el-option v-for="t in tasks" :key="t.id" :label="t.label" :value="t.id" />
              <el-option v-for="e in extras" :key="e.id" :label="e.label" :value="e.id" />
            </el-select>
            <el-checkbox v-model="filter.onlyCredit" size="small">只看有积分变动</el-checkbox>
            <span class="ws-dim" style="font-size: 11.5px">
              显示 {{ log.items?.length ?? 0 }} / {{ log.total ?? 0 }} 条
              <template v-if="log.totalDelta">· 账号合计 {{ deltaText(log.totalDelta) }}</template>
            </span>
          </span>
        </div>

        <EmptyState
          v-if="!log.items?.length"
          title="还没有活动记录"
          description="上面任意点一个「立即执行」，或者等网关自己的排程跑（9/21 点签到、10 点活跃、12 点开学季、01 点夜猫子、22 点保活）"
        />

        <div v-else class="wba-log">
          <div v-for="e in log.items" :key="e.id" class="wba-log__row" :class="e.tone === 'fail' ? 'is-bad' : ''">
            <span class="ws-mono ws-dim">{{ timeOfMs(e.at) }}</span>
            <span class="wba-tag" :style="{ color: toneOf(e.task), borderColor: toneOf(e.task) }">
              {{ LABELS[e.task] ?? e.task }}
            </span>
            <span class="wba-log__acct" :title="e.uid8 || ''">{{ e.account }}</span>
            <span class="wba-log__delta" :class="Number(e.delta) > 0 ? 'is-plus' : Number(e.delta) < 0 ? 'is-minus' : ''">
              {{ deltaText(e.delta) }}
            </span>
            <span class="wba-log__text">{{ e.text }}</span>
          </div>
        </div>

        <p class="wbo-note" style="margin-top: 10px">
          网关排程的部分从 <span class="ws-mono">{{ log.gatewayLog }}</span> 解析而来（按事件去重后落盘
          <span class="ws-mono">{{ log.file }}</span>，最多留 3000 条）。
          签到/开学季/夜猫子的网关排程<b>只打汇总行</b>（脚本 stdout 被网关丢弃），逐账号明细要手动跑一次才有；
          活跃上报与猫猫旅行是逐账号行的，直接可见。积分增量 = remain 前后变化，中途对话消耗会让它偏小。
        </p>
        <p v-if="log.gatewayLogError" class="wbo-note" style="color: var(--ws-warn)">
          网关日志：{{ log.gatewayLogError }}
        </p>
      </div>

      <!-- ----------------------------------------------------- 运行记录 -->
      <div class="ws-card wbo-block">
        <div class="wbo-block__head">
          <span class="wbo-block__title"><el-icon><Files /></el-icon>本次运行（含原始输出）</span>
          <span class="ws-dim" style="font-size: 11.5px">
            进程内保留最近 50 次；逐账号明细已进上面的活动日志，这里留着排错用的原文（一键完成的每步也在这里）
          </span>
        </div>

        <EmptyState v-if="!runs.length" title="还没跑过" description="上面点一个「立即执行」" />

        <div v-for="r in runs" :key="r.id" class="wba-run">
          <div class="wba-run__row" @click="toggleRun(r.id)">
            <span class="wba-run__title">{{ r.title }}<span v-if="r.uidPrefix" class="ws-dim">（单号 {{ r.uidPrefix }}）</span></span>
            <span v-if="r.running" class="wbo-tag is-info">运行中</span>
            <span v-else-if="r.error" class="wbo-tag is-danger">失败</span>
            <span v-else class="wbo-tag is-ok">完成</span>
            <span class="ws-dim" style="font-size: 12px">{{ deltaText(r.deltaTotal) }}</span>
            <span class="ws-spacer" />
            <span class="ws-dim" style="font-size: 11.5px">
              <template v-if="r.running">{{ agoOf(r.startedAt) }}开始</template>
              <template v-else>
                {{ ((r.finishedAt - r.startedAt) / 1000).toFixed(1) }} 秒 · {{ agoOf(r.finishedAt) }}
              </template>
            </span>
            <el-icon class="ws-dim"><component :is="openId === r.id ? 'ArrowDown' : 'Right'" /></el-icon>
          </div>

          <div v-if="openId === r.id" class="wba-run__detail">
            <p v-if="r.error" style="color: var(--ws-danger); font-size: 12.5px; margin-bottom: 8px">{{ r.error }}</p>
            <p v-if="busy === r.id" class="wbo-note">读取明细…</p>
            <template v-else>
              <div v-if="r.steps?.length" class="wba-steps">
                <div v-for="s in r.steps" :key="s.task" class="wba-steps__row">
                  <span class="wba-tag" :class="`is-${s.state}`">
                    {{
                      { done: '完成', fail: '失败', throttled: '限流停', running: '进行中', skip: '跳过' }[s.state as string] ?? '待跑'
                    }}
                  </span>
                  <span class="wba-steps__label">{{ s.label }}</span>
                  <span class="wba-log__delta" :class="Number(s.delta) > 0 ? 'is-plus' : Number(s.delta) < 0 ? 'is-minus' : ''">
                    {{ deltaText(s.delta) }}
                  </span>
                  <span class="wba-steps__text">{{ s.text }}</span>
                </div>
              </div>
              <div v-if="r.items?.length" class="wbo-items" style="margin-bottom: 8px">
                <div
                  v-for="(it, idx) in r.items.slice(0, 60)"
                  :key="idx"
                  class="wbo-items__row"
                  :class="it.tone === 'fail' ? 'is-bad' : ''"
                >
                  <span>
                    <el-icon v-if="it.tone === 'fail'" style="color: var(--ws-danger)"><Close /></el-icon>
                    <el-icon v-else-if="it.tone === 'muted'" class="ws-dim"><Minus /></el-icon>
                    <el-icon v-else style="color: var(--ws-success)"><Checked /></el-icon>
                  </span>
                  <span class="wbo-items__name">{{ it.account || it.uid8 || '—' }}</span>
                  <span class="wbo-items__msg">
                    <b v-if="Number.isFinite(it.delta)" class="ws-mono" :style="{ color: it.delta >= 0 ? 'var(--ws-success)' : 'var(--ws-danger)' }">
                      {{ deltaText(it.delta) }}
                    </b>
                    {{ it.text }}
                  </span>
                </div>
                <p v-if="r.items.length > 60" class="wbo-note" style="padding: 8px 10px">
                  只显示前 60 条（共 {{ r.items.length }} 条）
                </p>
              </div>
              <pre v-if="r.raw?.length" class="wba-raw">{{ r.raw.join('\n') }}</pre>
            </template>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* 任务行：开关 | 名称 | 说明 | 何时跑 | 最近一次 | 执行 */
.wba-row {
  display: grid;
  grid-template-columns: 40px 96px minmax(140px, 1fr) 168px minmax(180px, 1.4fr) 88px;
  align-items: center;
  gap: 10px;
  padding: 9px 4px;
  border-bottom: 1px solid var(--ws-border);
}

/* ================================================ 手机档（≤760px） ----
   这一页原来一条断点都没有，是全项目唯一「零断点」的视图：
   下面三个网格的固定列加最小列最小合计 762px / 234px / 322px，
   在 362px 的可用宽里只能横向溢出（门禁实测 799px）。
   三个都是**数据行**（不是操作对象），所以不做卡片，改成竖排重排：
   短元素（开关/标签/时间）留在一行，长文本（说明、正文、结果）各行独占一行。 */

@media (max-width: 760px) {
  /* 任务行：开关 | 任务名 |（说明）| 何时跑 · 最近一次 | 执行 */
  .wba-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 10px;
    padding: 12px 4px;
  }
  .wba-row > :first-child {
    flex: 0 0 auto; /* 开关 */
  }
  .wba-row__name {
    flex: 1 1 auto;
    min-width: 0;
  }
  .wba-row__hint {
    flex: 1 1 100%; /* 说明整条，独占一行 */
  }
  .wba-row__when {
    flex: 0 0 auto;
  }
  .wba-row__last {
    flex: 1 1 auto;
    min-width: 0; /* 「最近一次」里面是标签 + 时间 + 文本，必须能收缩并换行 */
  }
  .wba-row > :last-child {
    flex: 0 0 auto; /* 执行按钮 */
  }

  /* 活动日志行：时间 | 任务 | 账号 | 增减 | 正文 */
  .wba-log__row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 8px;
    padding: 9px 10px;
  }
  .wba-log__text {
    flex: 1 1 100%; /* 正文整条，独占一行 */
  }

  /* 执行步骤行：状态 | 名称 | 增减 | 结果 */
  .wba-steps__row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 8px;
    padding: 8px 10px;
  }
  .wba-steps__text {
    flex: 1 1 100%;
  }
}
.wba-row:last-of-type {
  border-bottom: none;
}
.wba-row__name {
  font-weight: 600;
  font-size: 13.5px;
}
.wba-row__hint {
  color: var(--ws-text-3);
  font-size: 12px;
}
.wba-row__when {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.wba-row__last {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  min-width: 0;
}
.wba-row__last .ws-dim {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 一键完成：进度条 + 每步状态 */
.wba-chain {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 9px 12px;
  margin-bottom: 10px;
  border: 1px solid var(--ws-accent-200);
  background: var(--ws-accent-soft);
  border-radius: var(--ws-radius);
  font-size: 12.5px;
}
.wba-chain__now {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 650;
  color: var(--ws-accent-deep);
}
.wba-chain__steps {
  display: inline-flex;
  gap: 6px;
  flex-wrap: wrap;
}
.wba-spin {
  animation: wba-rotate 1.1s linear infinite;
}
@keyframes wba-rotate {
  to {
    transform: rotate(360deg);
  }
}
.wba-steps {
  border: 1px solid var(--ws-border);
  border-radius: var(--ws-radius);
  margin-bottom: 8px;
}
.wba-steps__row {
  display: grid;
  grid-template-columns: 62px 92px 56px minmax(0, 1fr);
  gap: 8px;
  align-items: baseline;
  padding: 7px 10px;
  font-size: 12.5px;
  border-bottom: 1px solid var(--ws-border);
}
.wba-steps__row:last-child {
  border-bottom: none;
}
.wba-steps__label {
  font-weight: 600;
}
.wba-steps__text {
  color: var(--ws-text-2);
  word-break: break-word;
}

/* 活动日志 */
.wba-tag.is-running {
  animation: wba-pulse 1.6s ease-in-out infinite;
}
@keyframes wba-pulse {
  50% {
    opacity: 0.45;
  }
}
.wba-log {
  border: 1px solid var(--ws-border);
  border-radius: var(--ws-radius);
  max-height: 460px;
  overflow: auto;
}
.wba-log__row {
  display: grid;
  grid-template-columns: 92px 74px minmax(80px, 130px) 56px minmax(0, 1fr);
  gap: 8px;
  align-items: baseline;
  padding: 7px 10px;
  font-size: 12.5px;
  border-bottom: 1px solid var(--ws-border);
}
.wba-log__row:last-child {
  border-bottom: none;
}
.wba-log__row.is-bad {
  background: var(--ws-danger-soft);
}
.wba-log__row:hover {
  background: var(--ws-panel-2);
}
.wba-log__acct {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wba-log__delta {
  font-variant-numeric: tabular-nums;
  font-weight: 650;
  color: var(--ws-text-3);
  text-align: right;
}
.wba-log__delta.is-plus {
  color: var(--ws-success);
}
.wba-log__delta.is-minus {
  color: var(--ws-danger);
}
.wba-log__text {
  color: var(--ws-text-2);
  word-break: break-word;
}
.wba-tag.is-done {
  color: var(--ws-success);
  border-color: var(--ws-success);
}
.wba-tag.is-fail,
.wba-tag.is-throttled {
  color: var(--ws-danger);
  border-color: var(--ws-danger);
}
.wba-tag.is-running {
  color: var(--ws-accent);
  border-color: var(--ws-accent);
}
.wba-tag.is-pending,
.wba-tag.is-skip {
  color: var(--ws-text-3);
  border-color: var(--ws-border-strong);
}
.wba-tag {
  display: inline-block;
  padding: 0 6px;
  border: 1px solid currentColor;
  border-radius: var(--ws-radius-pill);
  font-size: 11px;
  line-height: 17px;
  text-align: center;
  opacity: 0.92;
}

/* 运行记录 */
.wba-run {
  border: 1px solid var(--ws-border);
  border-radius: var(--ws-radius);
  margin-bottom: 8px;
  overflow: hidden;
}
.wba-run__row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  cursor: pointer;
  flex-wrap: wrap;
}
.wba-run__row:hover {
  background: var(--ws-panel-2);
}
.wba-run__title {
  font-weight: 600;
  font-size: 13px;
}
.wba-run__detail {
  padding: 0 12px 12px;
}
.wba-raw {
  max-height: 260px;
  overflow: auto;
  margin: 0;
  padding: 10px;
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
  border-radius: var(--ws-radius-sm);
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--ws-text-2);
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
