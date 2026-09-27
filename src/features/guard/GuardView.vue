<script setup lang="ts">
/**
 * 进程守护（`#/process-guard`）—— 这一页就是**引擎的面板本体**。
 *
 * 引擎是工作台自带的（`server/lib/pguard.mjs`，自研实现，规则语义见该模块头部说明）。
 * 这一页上每个数字都来自我们自己的引擎。
 *
 * 五页：概览 / 进程 / 参数 / 名单 / 日志（另有端口 / 智能体两页，走 lib/procscan.mjs）。
 * 三条边界（页面上也写着，别当缺陷补）：
 *  1. **没有「结束任意进程」的手动入口**：手动结束会绕过演练开关与动作预算，这是设计里划掉的。
 *     能动手的只有规则自己；页面上给的「释放内存」是可逆动作。
 *  2. **周期动作里不做「清系统待机列表」**：那要提权，边车是普通用户跑的，所以它降级成按钮
 *     （点一次弹一次 UAC）。
 *  3. **提权进程动不了**：释放内存 / 结束进程只能碰你本人、非提权的进程（实测提权的报 err5）。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import SidecarOffline from '@/components/SidecarOffline.vue'
import { api, ensureSidecar } from '@/core/sidecar'
import PortsPanel from './PortsPanel.vue'
import AgentsPanel from './AgentsPanel.vue'

const ready = ref(false)
const loading = ref(false)
const busy = ref('')
const error = ref('')
const tab = ref('overview')
const st = ref<any>(null)
const procs = ref<any>(null)
const rows = ref<any[]>([])
const logTail = ref<string[]>([])
const onlyActed = ref(false)
let timer: ReturnType<typeof setInterval> | null = null

const conf = computed(() => st.value?.config ?? null)
const dryRun = computed(() => st.value?.dryRun !== false)
const running = computed(() => !!st.value?.running)
const paused = computed(() => !!st.value?.paused)
const j = computed(() => st.value?.journal ?? null)
const notes = computed<string[]>(() => st.value?.lastTick?.notes ?? [])
const decisions = computed<any[]>(() => st.value?.lastTick?.decisions ?? [])

/* 参数表单（保存即写引擎配置，下一拍生效） */
const form = ref<Record<string, any>>({})
let formReady = false
function syncForm() {
  const c = conf.value
  if (!c || formReady) return
  form.value = {
    cpuEnabled: c.cpuGuard.enabled,
    triggerPercent: c.cpuGuard.triggerPercent,
    triggerSustainSeconds: c.cpuGuard.triggerSustainSeconds,
    releasePercent: c.cpuGuard.releasePercent,
    processThresholdPercent: c.cpuGuard.processThresholdPercent,
    processSustainSeconds: c.cpuGuard.processSustainSeconds,
    minProcessAgeSeconds: c.cpuGuard.minProcessAgeSeconds,
    skipVisible: c.cpuGuard.skipProcessesWithVisibleWindow,
    maxActionsPerCycle: c.cpuGuard.maxActionsPerCycle,
    maxActionsPerHour: c.cpuGuard.maxActionsPerHour,
    processCooldownSeconds: c.cpuGuard.processCooldownSeconds,
    devEnabled: c.devReclaim.enabled,
    idleSeconds: c.devReclaim.idleSeconds,
    killAfterIdleSeconds: c.devReclaim.killAfterIdleSeconds,
    devMinWorkingSetMb: c.devReclaim.minWorkingSetMb,
    memEnabled: c.memory.enabled,
    memIntervalSeconds: c.memory.intervalSeconds,
    memMinWorkingSetMb: c.memory.minWorkingSetMb,
    memTriggerFreePercent: c.memory.triggerWhenFreeMemoryBelowPercent,
    memSkipVisible: c.memory.skipVisibleWindowProcesses,
  }
  formReady = true
}

/* 名单新条目 */
const newWhite = ref({ match: 'imageName', value: '', note: '' })
const newBlack = ref({ match: 'imageName', value: '', action: 'kill', exemptProtection: false, note: '' })

function pct(n: number | null | undefined, d = 1) {
  return n === null || n === undefined ? '—' : `${Number(n).toFixed(d)}%`
}
function fmtTime(ts?: number | null) {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
function fmtBytes(n?: number | null, digits = 1) {
  if (!n) return '—'
  const gb = n / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(digits)} GB`
  const mb = n / 1024 ** 2
  if (mb >= 10) return `${mb.toFixed(0)} MB`
  if (mb >= 1) return `${mb.toFixed(1)} MB`
  return `${Math.max(0, Math.round(n / 1024))} KB`
}
function outcomeType(o: string) {
  if (['killed', 'closed', 'failed'].includes(o)) return 'danger'
  if (o === 'trimmed') return 'success'
  if (o === 'blocked') return 'warning'
  if (o === 'simulated') return 'info'
  return 'info'
}
function cpuTone(v: number | null | undefined) {
  const th = conf.value?.cpuGuard?.triggerPercent ?? 80
  if (v === null || v === undefined) return 'var(--ws-text-3)'
  if (v >= th) return 'var(--ws-danger)'
  if (v >= th * 0.75) return 'var(--ws-warn)'
  return 'var(--ws-success)'
}
function memTone(v: number | null | undefined) {
  if (v === null || v === undefined) return 'var(--ws-text-3)'
  if (v <= 5) return 'var(--ws-danger)'
  if (v <= (conf.value?.memory?.triggerWhenFreeMemoryBelowPercent ?? 25)) return 'var(--ws-warn)'
  return 'var(--ws-success)'
}

async function load(showLoading = false) {
  if (showLoading) loading.value = true
  try {
    const ok = await ensureSidecar()
    ready.value = ok
    if (!ok) return
    const r = await api.pguardStatus()
    const d = r.data as any
    if (d?.ok !== false) {
      st.value = d
      syncForm()
      error.value = ''
    } else error.value = d?.error ?? r.error ?? '读不到引擎状态'
  } finally {
    if (showLoading) loading.value = false
  }
}

async function loadProcs() {
  busy.value = 'procs'
  try {
    const r = await api.pguardProcesses(60)
    const d = (r.data as any) ?? null
    procs.value = d
    rows.value = d?.rows ?? []
  } finally {
    busy.value = ''
  }
}
async function loadLog() {
  const r = await api.pguardLog(40)
  logTail.value = ((r.data as any)?.tail ?? []) as string[]
}

async function onTab(name: any) {
  tab.value = String(name)
  if (tab.value === 'processes' && !procs.value) await loadProcs()
  if (tab.value === 'log') await loadLog()
}

async function doTick() {
  busy.value = 'tick'
  try {
    const r = await api.pguardTick()
    const d = r.data as any
    if (d?.ok) {
      ElMessage.success(d.decisions?.length ? `这一拍有 ${d.decisions.length} 项判定` : `这一拍没有要动手的东西${d.notes?.length ? `（${d.notes[0]}）` : ''}`)
    } else ElMessage.error(d?.error ?? r.error ?? '判定失败')
    await load()
  } finally {
    busy.value = ''
  }
}

async function toggleEngine(on: boolean) {
  busy.value = 'engine'
  try {
    const r = await api.pguardEngine(on)
    const d = r.data as any
    if (d?.ok) ElMessage.success(on ? '引擎已启动' : '引擎已停止（不再判定；已经在跑的进程不受影响）')
    else ElMessage.error(d?.error ?? r.error ?? '操作失败')
    await load()
  } finally {
    busy.value = ''
  }
}

async function togglePause() {
  busy.value = 'pause'
  try {
    const r = await api.pguardPause(!paused.value)
    const d = r.data as any
    if (d?.ok) ElMessage.success(paused.value ? '判定已暂停' : '判定已恢复')
    else ElMessage.error(d?.error ?? r.error ?? '操作失败')
    await load()
  } finally {
    busy.value = ''
  }
}

async function toggleDryRun(on: boolean) {
  if (!on) {
    try {
      await ElMessageBox.confirm(
        '关掉之后规则会真的释放内存、结束进程（CPU 越阈值时的失控进程、空闲超时的开发工具进程）。\n\n' +
          '建议先去「日志」页翻一遍演练期间的命中记录，确认命中的都是你不在意的进程，再关。',
        '确认关掉演练模式？',
        { confirmButtonText: '关掉（真实执行）', cancelButtonText: '先继续演练', type: 'warning' },
      )
    } catch {
      return
    }
  }
  busy.value = 'dry'
  try {
    const r = await api.pguardSetDryRun(on)
    const d = r.data as any
    if (d?.ok) ElMessage.success(d.hint ?? '已切换')
    else ElMessage.error(d?.error ?? r.error ?? '切换失败')
    await load()
  } finally {
    busy.value = ''
  }
}

async function save() {
  busy.value = 'save'
  try {
    const f = form.value
    const r = await api.pguardSettings({
      'cpuGuard.enabled': f.cpuEnabled,
      'cpuGuard.triggerPercent': f.triggerPercent,
      'cpuGuard.triggerSustainSeconds': f.triggerSustainSeconds,
      'cpuGuard.releasePercent': f.releasePercent,
      'cpuGuard.processThresholdPercent': f.processThresholdPercent,
      'cpuGuard.processSustainSeconds': f.processSustainSeconds,
      'cpuGuard.minProcessAgeSeconds': f.minProcessAgeSeconds,
      'cpuGuard.skipProcessesWithVisibleWindow': f.skipVisible,
      'cpuGuard.maxActionsPerCycle': f.maxActionsPerCycle,
      'cpuGuard.maxActionsPerHour': f.maxActionsPerHour,
      'cpuGuard.processCooldownSeconds': f.processCooldownSeconds,
      'devReclaim.enabled': f.devEnabled,
      'devReclaim.idleSeconds': f.idleSeconds,
      'devReclaim.killAfterIdleSeconds': f.killAfterIdleSeconds,
      'devReclaim.minWorkingSetMb': f.devMinWorkingSetMb,
      'memory.enabled': f.memEnabled,
      'memory.intervalSeconds': f.memIntervalSeconds,
      'memory.minWorkingSetMb': f.memMinWorkingSetMb,
      'memory.triggerWhenFreeMemoryBelowPercent': f.memTriggerFreePercent,
      'memory.skipVisibleWindowProcesses': f.memSkipVisible,
    })
    const d = r.data as any
    if (d?.ok) {
      ElMessage.success('已保存（下一拍生效）')
      formReady = false
      await load()
    } else ElMessage.error(d?.error ?? r.error ?? '保存失败')
  } finally {
    busy.value = ''
  }
}

async function trim(pid: number) {
  busy.value = `trim-${pid}`
  try {
    const r = await api.pguardTrim(pid)
    const d = r.data as any
    if (d?.ok) ElMessage.success(`已释放 ${fmtBytes(d.released)}`)
    else ElMessage.error(d?.error ?? r.error ?? '释放失败')
    await loadProcs()
    await load()
  } finally {
    busy.value = ''
  }
}

async function purgeStandby() {
  try {
    await ElMessageBox.confirm(
      '清理系统待机列表需要管理员权限，会弹一次 UAC。\n\n' +
        '它是无损动作（把那部分缓存还给可用内存），但周期动作里不做它 —— 边车是普通用户跑的，' +
        '无人值守时没人点 UAC。所以这一项只有这个按钮。',
      '清理系统待机列表？',
      { confirmButtonText: '点（会弹 UAC）', cancelButtonText: '算了', type: 'warning' },
    )
  } catch {
    return
  }
  busy.value = 'purge'
  try {
    const r = await api.pguardPurgeStandby()
    const d = r.data as any
    if (d?.ok) {
      ElMessage.success('已清理系统待机列表')
      await load()
    } else ElMessage.error(d?.error ?? r.error ?? '清理失败')
  } finally {
    busy.value = ''
  }
}

async function copyPath(p?: string) {
  if (!p) return
  try {
    await navigator.clipboard.writeText(String(p))
    ElMessage.success(`路径已复制：${p}`)
  } catch {
    ElMessage.info(String(p))
  }
}

async function addEntry(list: 'whitelist' | 'blacklist') {
  const e = list === 'whitelist' ? newWhite.value : newBlack.value
  if (!e.value) return ElMessage.warning('先填名字')
  const r = await api.pguardLists({ list, action: 'add', entry: e })
  const d = r.data as any
  if (d?.ok) {
    ElMessage.success('已加入')
    if (list === 'whitelist') newWhite.value = { match: 'imageName', value: '', note: '' }
    else newBlack.value = { match: 'imageName', value: '', action: 'kill', exemptProtection: false, note: '' }
    formReady = false
    await load()
  } else ElMessage.error(d?.error ?? r.error ?? '加不进去')
}

async function removeEntry(list: 'whitelist' | 'blacklist', index: number) {
  const r = await api.pguardLists({ list, action: 'remove', index })
  const d = r.data as any
  if (d?.ok) {
    formReady = false
    await load()
  } else ElMessage.error(d?.error ?? r.error ?? '删不掉')
}

async function toggleEntry(list: 'whitelist' | 'blacklist', index: number) {
  const r = await api.pguardLists({ list, action: 'toggle', index })
  const d = r.data as any
  if (d?.ok) {
    formReady = false
    await load()
  } else ElMessage.error(d?.error ?? r.error ?? '改不了')
}

onMounted(async () => {
  await load(true)
  timer = setInterval(() => load(), 12000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div class="ws-page ws-page--wide pg">
    <PageHeader
      title="进程守护"
      subtitle="工作台自己的守护引擎：CPU 越阈值时释放开发工具内存、结束失控进程，并定时回收内存。出厂演练模式，规则照常评估、写审计，但什么都不做。"
      icon="Timer"
    >
      <template #actions>
        <el-button :loading="loading" @click="load(true)"><el-icon><Refresh /></el-icon>&nbsp;刷新</el-button>
        <el-button :loading="busy === 'tick'" :disabled="!running" @click="doTick">
          <el-icon><Aim /></el-icon>&nbsp;立即检查
        </el-button>
        <el-button :loading="busy === 'pause'" :disabled="!running" @click="togglePause">
          <el-icon><VideoPause v-if="!paused" /><VideoPlay v-else /></el-icon>&nbsp;{{ paused ? '恢复判定' : '暂停判定' }}
        </el-button>
        <el-button v-if="running" type="danger" plain :loading="busy === 'engine'" @click="toggleEngine(false)">
          <el-icon><SwitchButton /></el-icon>&nbsp;停引擎
        </el-button>
        <el-button v-else type="primary" :loading="busy === 'engine'" @click="toggleEngine(true)">
          <el-icon><VideoPlay /></el-icon>&nbsp;启动引擎
        </el-button>
      </template>
    </PageHeader>

    <SidecarOffline v-if="!loading && !ready" what="进程守护" @ready="load(true)" />
    <el-skeleton v-else-if="loading && !st" :rows="8" animated />
    <p v-else-if="error" class="ws-muted">{{ error }}</p>

    <template v-else-if="st">
      <el-tabs :model-value="tab" @tab-change="onTab">
        <!-- ------------------------------------------------ 概览 -->
        <el-tab-pane label="概览" name="overview">
          <div class="stats4">
            <div class="stat">
              <div class="stat__k">整机 CPU</div>
              <div class="stat__v" :style="{ color: cpuTone(st.cpuPercent) }">{{ pct(st.cpuPercent) }}</div>
              <div class="bar">
                <div class="bar__fill" :style="{ width: Math.min(100, st.cpuPercent ?? 0) + '%', background: cpuTone(st.cpuPercent) }" />
                <div
                  v-if="conf?.cpuGuard?.triggerPercent"
                  class="bar__mark"
                  :style="{ left: conf.cpuGuard.triggerPercent + '%' }"
                  :title="`判定线 ${conf.cpuGuard.triggerPercent}%`"
                />
              </div>
              <div class="stat__d">
                {{ st.armed ? '已上膛：正在盯单进程' : `未上膛：≥${conf?.cpuGuard?.triggerPercent}% 持续 ${conf?.cpuGuard?.triggerSustainSeconds}s 才细看` }}
              </div>
            </div>

            <div class="stat">
              <div class="stat__k">可用内存</div>
              <div class="stat__v" :style="{ color: memTone(st.memFreePercent) }">{{ pct(st.memFreePercent) }}</div>
              <div class="bar">
                <div
                  class="bar__fill"
                  :style="{
                    width: Math.min(100, 100 - (st.memFreePercent ?? 0)) + '%',
                    background: (st.memFreePercent ?? 100) <= 5 ? 'var(--ws-danger)' : (st.memFreePercent ?? 100) <= (conf?.memory?.triggerWhenFreeMemoryBelowPercent ?? 25) ? 'var(--ws-warn)' : 'var(--ws-success)',
                  }"
                />
              </div>
              <div class="stat__d">
                可用 {{ fmtBytes(st.memFreeBytes) }} / {{ fmtBytes(st.memTotalBytes) }} ·
                低于 {{ conf?.memory?.triggerWhenFreeMemoryBelowPercent }}% 才做定时回收
              </div>
            </div>

            <div class="stat">
              <div class="stat__k">进程 / 逻辑核</div>
              <div class="stat__v">{{ st.procCount ?? '—' }} <span class="stat__sub">/ {{ st.cpuCount ?? '—' }}</span></div>
              <div class="stat__d" style="margin-top: 10px">
                引擎自己占 <b>{{ fmtBytes(st.selfWorkingSetBytes) }}</b>
                <span class="ws-dim">（引擎内嵌在边车里，没有另装一个常驻客户端的开销）</span>
              </div>
            </div>

            <div class="stat">
              <div class="stat__k">今天动手</div>
              <div class="stat__v">{{ j?.todayActed ?? 0 }}</div>
              <div class="stat__d" style="margin-top: 10px">
                释放内存 <b>{{ j?.todayReleasedBytes ? fmtBytes(j.todayReleasedBytes) : '0 B' }}</b> ·
                审计 <b>{{ j?.todayCount ?? 0 }}</b> 条
                <span v-if="j?.todayByOutcome?.blocked"> · 阻止 {{ j.todayByOutcome.blocked }}</span>
              </div>
              <div class="stat__d">
                本次会话：判定 {{ st.ticks }} 次，释放 {{ st.session?.released ?? 0 }} · 结束 {{ st.session?.ended ?? 0 }}
              </div>
            </div>
          </div>

          <!-- 引擎状态 + 演练开关 -->
          <div class="ws-card pad" style="margin-top: 16px">
            <div class="params">
              <div class="params__main">
                <div class="h" style="margin-bottom: 8px">
                  引擎
                  <el-tag :type="running ? (paused ? 'warning' : 'success') : 'info'" size="small" effect="plain" style="margin-left: 6px">
                    {{ running ? (paused ? '在跑（判定已暂停）' : '在跑') : '没在跑' }}
                  </el-tag>
                </div>
                <p class="params__sentence">{{ st.params?.sentence }}</p>
                <div class="params__facts">
                  <span>上次采样 <b>{{ fmtTime(st.lastSampleAt) }}</b></span>
                  <span>上次判定 <b>{{ fmtTime(st.lastTickAt) }}</b></span>
                  <span>判定 {{ st.ticks }} 轮</span>
                  <span v-if="st.lastError" style="color: var(--ws-danger)">上次出错：{{ st.lastError }}</span>
                </div>
                <div class="notes" style="margin-top: 10px">
                  <div v-for="(n, i) in notes" :key="i" class="note">
                    <el-icon><InfoFilled /></el-icon><span>{{ n }}</span>
                  </div>
                </div>
              </div>
              <div class="params__side">
                <div class="dryrow">
                  <span class="ws-dim">演练模式</span>
                  <span class="ws-row" style="gap: 8px">
                    <el-switch
                      :model-value="dryRun"
                      :loading="busy === 'dry'"
                      size="small"
                      @change="(v: any) => toggleDryRun(!!v)"
                    />
                    <b :style="{ color: dryRun ? 'var(--ws-text-2)' : 'var(--ws-danger)' }">{{ dryRun ? '演练中' : '真实执行' }}</b>
                  </span>
                </div>
                <el-button size="small" :loading="busy === 'purge'" @click="purgeStandby">
                  <el-icon><Delete /></el-icon>&nbsp;清理系统待机列表（UAC）
                </el-button>
                <el-button size="small" @click="copyPath(st.paths?.journal)">
                  <el-icon><CopyDocument /></el-icon>&nbsp;复制数据目录路径
                </el-button>
              </div>
            </div>

            <p class="ws-dim" style="margin: 12px 0 0; font-size: 12.5px">
              口径说明：整机 CPU 要有迟滞（过线持续 {{ conf?.cpuGuard?.triggerSustainSeconds }} 秒才上膛、回到低水位才撤膛），
              单进程要持续超线才算失控，动作前统一过「白名单 → 受保护 → （黑名单能越过这两层，出厂空）」三道闸，
              同一进程有冷却、每轮与每小时都有动作上限。待机列表清理是唯一的例外：它要提权，所以不挂在周期里。
            </p>
          </div>

          <!-- 这一拍的判定 -->
          <div v-if="decisions.length" class="ws-card pad" style="margin-top: 16px">
            <div class="h">这一拍的判定（{{ decisions.length }} 项）</div>
            <el-table :data="decisions" size="small" max-height="260">
              <el-table-column label="规则" width="110">
                <template #default="{ row }">{{ row.rule }}</template>
              </el-table-column>
              <el-table-column label="进程" min-width="150">
                <template #default="{ row }">{{ row.name }} <span class="ws-dim">({{ row.pid }})</span></template>
              </el-table-column>
              <el-table-column label="结论" width="220">
                <template #default="{ row }">{{ row.verdict }}</template>
              </el-table-column>
              <el-table-column label="依据" min-width="240">
                <template #default="{ row }"><span class="ws-dim" style="font-size: 12px">{{ row.detail }}</span></template>
              </el-table-column>
            </el-table>
          </div>

          <!-- 最近审计 -->
          <div class="ws-card pad" style="margin-top: 16px">
            <div class="row-between">
              <div class="h" style="margin: 0">
                最近审计
                <span class="ws-dim" style="font-weight: 400; font-size: 12px">（actions.jsonl，字段跟它原来那份一样）</span>
              </div>
              <el-button size="small" @click="onTab('log')">看全部</el-button>
            </div>
            <el-table v-if="j?.recent?.length" :data="j.recent.slice(0, 8)" size="small" style="margin-top: 10px">
              <el-table-column label="时间" width="146">
                <template #default="{ row }">{{ fmtTime(row.at) }}</template>
              </el-table-column>
              <el-table-column label="结果" width="100">
                <template #default="{ row }"><el-tag :type="outcomeType(row.outcome)" size="small" effect="plain">{{ row.outcomeText }}</el-tag></template>
              </el-table-column>
              <el-table-column label="规则" width="110">
                <template #default="{ row }">{{ row.rule }}</template>
              </el-table-column>
              <el-table-column label="进程" min-width="140">
                <template #default="{ row }">{{ row.name || '—' }} <span class="ws-dim">({{ row.pid }})</span></template>
              </el-table-column>
              <el-table-column label="依据" min-width="200">
                <template #default="{ row }"><span class="ws-dim" style="font-size: 12px">{{ row.detail }}</span></template>
              </el-table-column>
            </el-table>
            <div v-else class="ws-empty" style="padding: 22px 0">
              审计还是空的。它的规则命中才会写 —— 现在{{ dryRun ? '演练模式，命中会记一条「演练」' : '真实执行，命中会照实记' }}。
            </div>
          </div>

          <!-- 边界 -->
          <div class="ws-card pad" style="margin-top: 16px">
            <div class="h">这一页不做什么（有意为之）</div>
            <ul class="rules">
              <li><b>没有「结束进程」的入口</b>：手动结束会绕过演练开关与动作预算，只该由规则自己动手。页面上给的是「释放内存」——那是可逆的。</li>
              <li><b>周期里不清系统待机列表</b>：那要提权，边车是普通用户跑的，所以它降级成概览页上的按钮（点一次弹一次 UAC）。</li>
              <li><b>动不了提权进程</b>：释放内存 / 结束进程只能碰你本人、非提权的进程；提权的会记一条「失败（权限不够）」。想让它连提权进程一起管，得给边车装一个提权的小服务（另开正题）。</li>
              <li><b>受保护名单只读</b>：那是安全网，改它得直接编辑 <span class="ws-mono">server/data/pguard/config.json</span>。</li>
            </ul>
          </div>
        </el-tab-pane>

        <!-- ------------------------------------------------ 进程 -->
        <el-tab-pane label="进程" name="processes">
          <div class="ws-card pad">
            <div class="row-between">
              <div class="h" style="margin: 0">
                此刻最吃 CPU 的进程
                <span class="ws-dim" style="font-weight: 400; font-size: 12px">
                  （工作台按自己的采样窗口算，与判定用的不是同一份采样）
                </span>
              </div>
              <el-button size="small" :loading="busy === 'procs'" @click="loadProcs"><el-icon><Refresh /></el-icon>&nbsp;重采</el-button>
            </div>
            <p class="ws-dim" style="margin: 8px 0 0; font-size: 12.5px">
              「释放内存」= EmptyWorkingSet，把它的工作集还给系统（可逆，进程照跑）。没有「结束」，见概览页的边界说明。
            </p>
            <el-table v-if="rows.length" :data="rows" size="small" max-height="560" style="margin-top: 12px">
              <el-table-column label="进程" min-width="150">
                <template #default="{ row }">{{ row.name }} <span class="ws-dim">({{ row.pid }})</span></template>
              </el-table-column>
              <el-table-column label="CPU" width="80" align="right">
                <template #default="{ row }">
                  <span :style="{ color: row.cpu >= (conf?.cpuGuard?.processThresholdPercent ?? 20) ? 'var(--ws-danger)' : 'var(--ws-text)' }">
                    {{ Number(row.cpu).toFixed(1) }}%
                  </span>
                </template>
              </el-table-column>
              <el-table-column label="内存" width="96" align="right">
                <template #default="{ row }">{{ fmtBytes(row.ws) }}</template>
              </el-table-column>
              <el-table-column label="开发工具" width="90" align="center">
                <template #default="{ row }">
                  <el-tag v-if="row.devTool" size="small" effect="plain">是</el-tag>
                  <span v-else class="ws-dim">—</span>
                </template>
              </el-table-column>
              <el-table-column label="空闲" width="90" align="right">
                <template #default="{ row }">
                  <span v-if="row.idleSeconds !== null" class="ws-dim">{{ Math.round(row.idleSeconds / 60) }} 分</span>
                  <span v-else class="ws-dim">在忙</span>
                </template>
              </el-table-column>
              <el-table-column label="白名单 / 保护层" min-width="230">
                <template #default="{ row }">
                  <template v-if="row.whitelisted">
                    <el-tag size="small" type="success" effect="plain">白名单</el-tag>
                    <span class="ws-dim" style="margin-left: 6px; font-size: 12px">{{ row.whitelisted }}</span>
                  </template>
                  <span v-else-if="row.protected" style="color: var(--ws-warn); font-size: 12px">{{ row.protected }}</span>
                  <span v-else class="ws-dim">—</span>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="110" align="right">
                <template #default="{ row }">
                  <el-button
                    size="small"
                    :disabled="!!row.protected || !!row.whitelisted"
                    :loading="busy === `trim-${row.pid}`"
                    @click="trim(row.pid)"
                  >
                    释放内存
                  </el-button>
                </template>
              </el-table-column>
            </el-table>
            <div v-else class="ws-empty" style="padding: 26px 0">
              {{ busy === 'procs' ? '正在采两份样本…' : '还没采到样本，点右上「重采」（要两份样本做差，约 2 秒）。' }}
            </div>
          </div>
        </el-tab-pane>

        <!-- ------------------------------------------------ 参数 -->
        <el-tab-pane label="参数" name="params">
          <div class="ws-card pad">
            <div class="h">CPU 守卫</div>
            <p class="ws-dim" style="margin: 0 0 12px; font-size: 12.5px">
              整机 CPU 过线要持续够久才上膛（迟滞），单进程要持续超线才算失控；动作之前还要过名单与保护层。
            </p>
            <div class="form--grid">
              <label>启用 <el-switch v-model="form.cpuEnabled" /></label>
              <label>整机 CPU 触发（%）<el-input-number v-model="form.triggerPercent" :min="10" :max="100" size="small" /></label>
              <label>需持续（秒）<el-input-number v-model="form.triggerSustainSeconds" :min="1" :max="600" size="small" /></label>
              <label>解除线（%）<el-input-number v-model="form.releasePercent" :min="1" :max="100" size="small" /></label>
              <label>单进程门槛（%）<el-input-number v-model="form.processThresholdPercent" :min="1" :max="100" size="small" /></label>
              <label>单进程需持续（秒）<el-input-number v-model="form.processSustainSeconds" :min="1" :max="600" size="small" /></label>
              <label>进程最短年龄（秒）<el-input-number v-model="form.minProcessAgeSeconds" :min="0" :max="600" size="small" /></label>
              <label>有可见窗口就跳过 <el-switch v-model="form.skipVisible" /></label>
              <label>每轮上限（个）<el-input-number v-model="form.maxActionsPerCycle" :min="1" :max="20" size="small" /></label>
              <label>每小时上限（个）<el-input-number v-model="form.maxActionsPerHour" :min="1" :max="200" size="small" /></label>
              <label>同进程冷却（秒）<el-input-number v-model="form.processCooldownSeconds" :min="10" :max="3600" size="small" /></label>
            </div>
          </div>

          <div class="ws-card pad" style="margin-top: 16px">
            <div class="h">开发工具回收</div>
            <p class="ws-dim" style="margin: 0 0 12px; font-size: 12.5px">
              空闲够久先释放内存（可逆），再久才考虑结束 —— 结束动作按你配置里的 <span class="ws-mono">devReclaim.action</span>
              （当前：{{ conf?.devReclaim?.action }}）。子进程还在忙的那一支会跳过。
            </p>
            <div class="form--grid">
              <label>启用 <el-switch v-model="form.devEnabled" /></label>
              <label>空闲多久释放（秒）<el-input-number v-model="form.idleSeconds" :min="30" :max="86400" :step="30" size="small" /></label>
              <label>空闲多久结束（秒）<el-input-number v-model="form.killAfterIdleSeconds" :min="60" :max="86400" :step="60" size="small" /></label>
              <label>释放门槛（MB）<el-input-number v-model="form.devMinWorkingSetMb" :min="10" :max="4096" :step="10" size="small" /></label>
            </div>
          </div>

          <div class="ws-card pad" style="margin-top: 16px">
            <div class="h">定时内存回收</div>
            <p class="ws-dim" style="margin: 0 0 12px; font-size: 12.5px">
              每 {{ form.memIntervalSeconds }} 秒一轮，只在可用内存低于触发线时动手；目标是「内存名单 ∪ 开发工具」里
              够大的进程。清系统待机列表不在这里（要提权，见概览页的按钮）。
            </p>
            <div class="form--grid">
              <label>启用 <el-switch v-model="form.memEnabled" /></label>
              <label>周期（秒）<el-input-number v-model="form.memIntervalSeconds" :min="30" :max="86400" :step="30" size="small" /></label>
              <label>释放门槛（MB）<el-input-number v-model="form.memMinWorkingSetMb" :min="10" :max="4096" :step="10" size="small" /></label>
              <label>可用内存低于（%）<el-input-number v-model="form.memTriggerFreePercent" :min="0" :max="100" size="small" /></label>
              <label>有可见窗口就跳过 <el-switch v-model="form.memSkipVisible" /></label>
            </div>
          </div>

          <div class="ws-row" style="margin-top: 16px">
            <el-button type="primary" :loading="busy === 'save'" @click="save">保存</el-button>
            <span class="ws-dim">
              保存写 <span class="ws-mono">{{ st.paths?.config }}</span>，下一拍生效（引擎每拍都重读配置）。
              开发工具名单（{{ conf?.devReclaim?.processNames?.length ?? 0 }} 个）与内存名单在文件里改。
            </span>
          </div>
        </el-tab-pane>

        <!-- ------------------------------------------------ 名单 -->
        <el-tab-pane label="名单" name="lists">
          <div class="ws-card pad">
            <div class="h">白名单（{{ conf?.whitelist?.length ?? 0 }} 条）</div>
            <p class="ws-dim" style="margin: 0 0 12px; font-size: 12.5px">
              命中白名单的进程永远不动手（CPU 守卫会记一条「已阻止」）。imageName 支持通配（如 <span class="ws-mono">python3.*</span>）。
            </p>
            <el-table :data="conf?.whitelist ?? []" size="small" max-height="320">
              <el-table-column label="匹配" width="110">
                <template #default="{ row }">{{ row.match }}</template>
              </el-table-column>
              <el-table-column label="值" min-width="200">
                <template #default="{ row }"><span class="ws-mono">{{ row.value }}</span></template>
              </el-table-column>
              <el-table-column label="备注" min-width="140">
                <template #default="{ row }"><span class="ws-dim">{{ row.note }}</span></template>
              </el-table-column>
              <el-table-column label="启用" width="80" align="center">
                <template #default="{ row, $index }">
                  <el-switch :model-value="row.enabled !== false" size="small" @change="toggleEntry('whitelist', $index)" />
                </template>
              </el-table-column>
              <el-table-column label="操作" width="80" align="right">
                <template #default="{ $index }">
                  <el-button size="small" text type="danger" @click="removeEntry('whitelist', $index)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
            <div class="ws-row" style="margin-top: 12px; gap: 8px">
              <el-select v-model="newWhite.match" size="small" style="width: 172px">
                <el-option label="imageName" value="imageName" />
                <el-option label="path" value="path" />
                <el-option label="commandLineContains" value="commandLineContains" />
                <el-option label="pid" value="pid" />
              </el-select>
              <el-input v-model="newWhite.value" size="small" placeholder="Code.exe / python3.* / run_service.py" style="max-width: 300px" />
              <el-input v-model="newWhite.note" size="small" placeholder="备注（可空）" style="max-width: 180px" />
              <el-button size="small" @click="addEntry('whitelist')"><el-icon><Plus /></el-icon>&nbsp;加入白名单</el-button>
            </div>
          </div>

          <div class="ws-card pad" style="margin-top: 16px">
            <div class="h">黑名单（{{ conf?.blacklist?.entries?.length ?? 0 }} 条）</div>
            <p class="ws-dim" style="margin: 0 0 12px; font-size: 12.5px">
              它是唯一能越过白名单与保护层的东西（所以出厂一条都不配）。越不过「不可逾越」的那几层：
              引擎自身、pid ≤ 4、内核关键进程、打不开的进程。
            </p>
            <el-table v-if="conf?.blacklist?.entries?.length" :data="conf.blacklist.entries" size="small">
              <el-table-column label="匹配" width="110">
                <template #default="{ row }">{{ row.match }}</template>
              </el-table-column>
              <el-table-column label="值" min-width="200">
                <template #default="{ row }"><span class="ws-mono">{{ row.value }}</span></template>
              </el-table-column>
              <el-table-column label="动作" width="90">
                <template #default="{ row }">{{ row.action === 'trim' ? '释放内存' : '结束' }}</template>
              </el-table-column>
              <el-table-column label="豁免保护" width="100" align="center">
                <template #default="{ row }">
                  <el-tag v-if="row.exemptProtection" type="danger" size="small" effect="plain">已豁免</el-tag>
                  <span v-else class="ws-dim">否</span>
                </template>
              </el-table-column>
              <el-table-column label="启用" width="80" align="center">
                <template #default="{ row, $index }">
                  <el-switch :model-value="row.enabled !== false" size="small" @change="toggleEntry('blacklist', $index)" />
                </template>
              </el-table-column>
              <el-table-column label="操作" width="80" align="right">
                <template #default="{ $index }">
                  <el-button size="small" text type="danger" @click="removeEntry('blacklist', $index)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
            <div v-else class="ws-empty" style="padding: 20px 0">黑名单是空的 —— 这是出厂状态，也是最安全的状态。</div>
            <div class="ws-row" style="margin-top: 12px; gap: 8px; flex-wrap: wrap">
              <el-select v-model="newBlack.match" size="small" style="width: 130px">
                <el-option label="imageName" value="imageName" />
                <el-option label="path" value="path" />
                <el-option label="pid" value="pid" />
              </el-select>
              <el-input v-model="newBlack.value" size="small" placeholder="要盯住的名字" style="max-width: 240px" />
              <el-select v-model="newBlack.action" size="small" style="width: 120px">
                <el-option label="结束" value="kill" />
                <el-option label="释放内存" value="trim" />
              </el-select>
              <el-checkbox v-model="newBlack.exemptProtection" size="small">豁免保护层</el-checkbox>
              <el-button size="small" type="danger" plain @click="addEntry('blacklist')"><el-icon><Plus /></el-icon>&nbsp;加入黑名单</el-button>
            </div>
          </div>

          <div class="ws-card pad" style="margin-top: 16px">
            <div class="h">受保护名单（只读，{{ conf?.protection?.immutableProcessNames?.length ?? 0 }} 个）</div>
            <p class="ws-dim" style="margin: 0 0 10px; font-size: 12.5px">
              命中的进程任何规则都不动它。另外这几道开关也在护着：自身进程与父进程链、会话 0 服务、系统目录下的可执行文件、
              当前前台窗口的进程（{{ conf?.protection?.protectForegroundWindowOwner ? '开' : '关' }}）、提权进程。
            </p>
            <div class="names">
              <span v-for="n in conf?.protection?.immutableProcessNames ?? []" :key="n" class="name ws-mono">{{ n }}</span>
            </div>
          </div>
        </el-tab-pane>

        <!-- ------------------------------------------------ 日志 -->
        <el-tab-pane label="日志" name="log">
          <div class="ws-card pad">
            <div class="row-between">
              <div class="h" style="margin: 0">
                审计记录
                <span class="ws-dim" style="font-weight: 400; font-size: 12px">
                  {{ st.journal?.path }}（{{ fmtBytes(st.journal?.sizeBytes) }}）
                </span>
              </div>
              <div class="ws-row">
                <el-switch v-model="onlyActed" size="small" active-text="只看真动手" />
                <el-button size="small" @click="load()"><el-icon><Refresh /></el-icon>&nbsp;刷新</el-button>
              </div>
            </div>
            <el-table :data="(st.journal?.recent ?? []).filter((r: any) => !onlyActed || ['killed', 'trimmed', 'closed'].includes(r.outcome))" size="small" max-height="460" style="margin-top: 10px">
              <el-table-column label="时间" width="146">
                <template #default="{ row }">{{ fmtTime(row.at) }}</template>
              </el-table-column>
              <el-table-column label="结果" width="100">
                <template #default="{ row }"><el-tag :type="outcomeType(row.outcome)" size="small" effect="plain">{{ row.outcomeText }}</el-tag></template>
              </el-table-column>
              <el-table-column label="规则" width="110">
                <template #default="{ row }">{{ row.rule }}</template>
              </el-table-column>
              <el-table-column label="进程" min-width="150">
                <template #default="{ row }">{{ row.name || '—' }} <span class="ws-dim">({{ row.pid }})</span></template>
              </el-table-column>
              <el-table-column label="CPU" width="70" align="right">
                <template #default="{ row }"><span class="ws-dim">{{ row.cpuPercent ? `${Number(row.cpuPercent).toFixed(1)}%` : '—' }}</span></template>
              </el-table-column>
              <el-table-column label="依据" min-width="240">
                <template #default="{ row }"><span class="ws-dim" style="font-size: 12px">{{ row.detail }}</span></template>
              </el-table-column>
            </el-table>
          </div>

          <div class="ws-card pad" style="margin-top: 16px">
            <div class="row-between">
              <div class="h" style="margin: 0">
                引擎运行日志
                <span class="ws-dim" style="font-weight: 400; font-size: 12px">{{ st.log?.path }}</span>
              </div>
              <el-button size="small" @click="loadLog"><el-icon><Refresh /></el-icon>&nbsp;刷新</el-button>
            </div>
            <pre v-if="logTail.length" class="code code--log" style="margin-top: 10px">{{ logTail.join('\n') }}</pre>
            <div v-else class="ws-empty" style="padding: 20px 0">还没有日志</div>
          </div>
        </el-tab-pane>

        <!-- ---------------------------------------------- 端口 / 智能体 -->
        <!-- 端口与智能体：pguard 的规则引擎覆盖不到这两块，由 lib/procscan.mjs 提供 -->
        <el-tab-pane label="端口" name="ports" lazy>
          <PortsPanel />
        </el-tab-pane>

        <el-tab-pane label="智能体" name="agents" lazy>
          <AgentsPanel />
        </el-tab-pane>
      </el-tabs>

      <!-- 底部状态条 -->
      <div class="statusbar">
        <span>引擎 <b>{{ running ? (paused ? '暂停' : '在跑') : '停' }}</b></span>
        <span>规则 <b :style="{ color: dryRun ? 'var(--ws-text)' : 'var(--ws-danger)' }">{{ dryRun ? '演练中' : '真实执行' }}</b></span>
        <span>CPU <b :style="{ color: cpuTone(st.cpuPercent) }">{{ pct(st.cpuPercent) }}</b></span>
        <span>可用内存 <b :style="{ color: memTone(st.memFreePercent) }">{{ pct(st.memFreePercent) }}</b></span>
        <span>进程 <b>{{ st.procCount ?? '—' }}</b></span>
        <span v-if="j?.recent?.[0]">
          最近动作 <b>[{{ j.recent[0].outcomeText }}] {{ j.recent[0].name || '—' }}</b>
          <span class="ws-dim">· {{ String(j.recent[0].detail ?? '').slice(0, 40) }}</span>
        </span>
        <span class="ws-spacer" />
        <span class="ws-mono ws-dim" style="font-size: 11.5px">{{ st.paths?.config }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.pad { padding: 20px 22px; }
.h { font-size: 14.5px; font-weight: 650; margin-bottom: 12px; }
.row-between { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
.stats4 { display: grid; grid-template-columns: repeat(4, minmax(180px, 1fr)); gap: 14px; }
.stat { border: 1px solid var(--ws-border); border-radius: var(--ws-radius-lg); padding: 16px 18px; background: var(--ws-panel); box-shadow: var(--ws-shadow-1); }
.stat__k { font-size: 12.5px; color: var(--ws-text-2); }
.stat__v { font-size: 30px; font-weight: 700; letter-spacing: -0.03em; line-height: 1.15; margin: 6px 0 8px; }
.stat__sub { font-size: 15px; font-weight: 600; color: var(--ws-text-2); }
.stat__d { font-size: 11.8px; color: var(--ws-text-3); margin-top: 4px; line-height: 1.5; }
.bar { position: relative; height: 6px; border-radius: 99px; background: var(--ws-panel-2); overflow: hidden; margin-bottom: 8px; }
.bar__fill { height: 100%; border-radius: 99px; transition: width .4s ease; }
.bar__mark { position: absolute; top: -2px; width: 2px; height: 10px; background: var(--ws-text-3); opacity: .65; }
.params { display: flex; gap: 20px; align-items: flex-start; }
.params__main { flex: 1; min-width: 0; }
.params__sentence { margin: 0 0 10px; font-size: 13.5px; line-height: 1.75; }
.params__facts { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 12.6px; color: var(--ws-text-2); }
.params__facts b { color: var(--ws-text); }
.params__side { display: flex; flex-direction: column; gap: 8px; align-items: stretch; min-width: 200px; }
.dryrow { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12.8px; padding-bottom: 6px; border-bottom: 1px dashed var(--ws-border); margin-bottom: 2px; }
.notes { display: flex; flex-direction: column; gap: 6px; }
.note { display: flex; gap: 8px; align-items: flex-start; font-size: 12.8px; color: var(--ws-text-2); background: var(--ws-accent-soft); border-radius: var(--ws-radius); padding: 8px 10px; }
.form--grid { display: grid; grid-template-columns: repeat(3, minmax(200px, 1fr)); gap: 14px 18px; align-items: center; }
.form--grid label { display: flex; flex-direction: column; gap: 6px; font-size: 12.8px; color: var(--ws-text-2); }
.code { margin: 0; padding: 12px 14px; border-radius: var(--ws-radius); background: var(--ws-panel-2); border: 1px solid var(--ws-border); font-family: var(--ws-mono); font-size: 12.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-all; color: var(--ws-text); }
.code--log { max-height: 240px; overflow: auto; }
.rules { margin: 0; padding-left: 18px; line-height: 1.9; font-size: 13px; }
.names { display: flex; flex-wrap: wrap; gap: 6px; }
.name { font-size: 11.8px; padding: 2px 8px; border-radius: 99px; background: var(--ws-panel-2); color: var(--ws-text-2); }
.statusbar {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px;
  margin-top: 14px; padding: 8px 14px; font-size: 12.2px; color: var(--ws-text-2);
  border: 1px solid var(--ws-border); border-radius: var(--ws-radius); background: var(--ws-panel-2);
}
.statusbar b { color: var(--ws-text); }
@media (max-width: 1100px) {
  .stats4 { grid-template-columns: repeat(2, 1fr); }
  .params { flex-direction: column; }
  .params__side { min-width: 0; flex-direction: row; flex-wrap: wrap; }
  .form--grid { grid-template-columns: repeat(2, minmax(180px, 1fr)); }
}
</style>
