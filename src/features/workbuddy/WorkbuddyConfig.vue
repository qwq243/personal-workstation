<script setup lang="ts">
/**
 * WorkBuddy 网关配置 —— 在线改 gateway 的 config.json，改完一键重启。
 *
 * 为什么要有这一页：这些键原来只能自己去网关目录改文件（schedule 的签到小时、
 * cooldown 的冷却上限、pool 的并发与熔断阈值），改完还得记得回来重启。
 * 页面做的事情就是「表单 + 原文双编辑 + 备份 + 重启」这四步。
 *
 * 三点保持诚实：
 *   1. 表单只覆盖常用的键，其余键（school_hours、cat_hours、upstash……）通过**原样保留**
 *      不丢 —— 保存时写回的整份 doc，而不是只写表单里那几个；
 *   2. 首次保存前留一份 config.json.ws.bak，且之后不再覆盖（留出「上次能用」的那一版）；
 *   3. 保存**不会**自动重启网关（重启会断开正在跑的对话请求，这种事得用户自己点）。
 */
import { computed, onMounted, ref } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import SidecarOffline from '@/components/SidecarOffline.vue'
import { api, ensureSidecar } from '@/core/sidecar'
import { agoOf, timeOfMs } from './wb-shared'

const ready = ref(false)
const err = ref('')
const meta = ref<any>(null)
const doc = ref<any>(null)
const rawText = ref('')
const mode = ref<'form' | 'raw'>('form')
const busy = ref(false)
const restartBusy = ref(false)
const dirty = ref(false)

/** 表单覆盖的键。type=hours 是「用逗号/空格分隔的小时数组」 */
const GROUPS: { name: string; fields: { path: string; label: string; type: string; hint?: string }[] }[] = [
  {
    name: '定时调度（整点触发，本地时间）',
    fields: [
      { path: 'schedule.checkin_enabled', label: '自动签到', type: 'bool', hint: '关掉后只剩手动「批量签到」' },
      { path: 'schedule.checkin_hours', label: '签到时间', type: 'hours', hint: '如 9, 21 —— 逗号分隔的小时' },
      { path: 'schedule.activity_enabled', label: '活跃上报', type: 'bool' },
      { path: 'schedule.activity_hours', label: '活跃时间', type: 'hours', hint: '一天几次就写几个小时' },
      { path: 'schedule.travel_enabled', label: '猫猫旅行', type: 'bool' },
      { path: 'schedule.travel_hours', label: '旅行时间', type: 'hours' },
      { path: 'schedule.keepalive_enabled', label: '保活', type: 'bool' },
      { path: 'schedule.keepalive_hours', label: '保活时间', type: 'hours' },
    ],
  },
  {
    name: '并发与熔断',
    fields: [
      { path: 'pool.max_in_flight', label: '每号在途请求上限', type: 'number' },
      { path: 'pool.max_in_flight_global', label: '全局在途请求上限', type: 'number' },
      { path: 'pool.breaker_threshold', label: '熔断阈值（连续失败几次）', type: 'number' },
      { path: 'pool.breaker_cooldown', label: '熔断冷却', type: 'text', hint: '如 30m / 2h' },
      { path: 'pool.degrade_threshold', label: '降级阈值', type: 'number' },
      { path: 'pool.idle_weight_per_hour', label: '空闲权重/小时', type: 'number' },
    ],
  },
  {
    name: '冷却（软限流）',
    fields: [
      { path: 'cooldown.soft_rate', label: '软限流冷却', type: 'text', hint: '撞到上游限流后冷却多久' },
      { path: 'cooldown.soft_rate_max', label: '软限流冷却上限', type: 'text' },
    ],
  },
  {
    name: '上游超时',
    fields: [
      { path: 'upstream.timeout_seconds', label: '总超时（秒）', type: 'number' },
      { path: 'upstream.header_timeout_seconds', label: '响应头超时（秒）', type: 'number' },
      { path: 'upstream.idle_timeout_seconds', label: '空闲超时（秒）', type: 'number' },
    ],
  },
  {
    name: '会话保持与其它',
    fields: [
      { path: 'session_sticky.enabled', label: '粘性会话', type: 'bool', hint: '同一会话尽量落同一个号' },
      { path: 'session_sticky.ttl', label: '粘性 TTL', type: 'text' },
      { path: 'features.sanitize_blacklist_fingerprints', label: '脱敏黑名单指纹', type: 'bool' },
      { path: 'global.enabled', label: '全局模式', type: 'bool' },
      { path: 'admin.enabled', label: '运维端点（停用/启用账号）', type: 'bool', hint: '账号池页的「停用 / 复活」按钮需要它' },
      { path: 'listen', label: '监听地址', type: 'text', hint: '默认 127.0.0.1:7863（只本机可访问）' },
      { path: 'auth_dir', label: '凭证目录', type: 'text' },
      { path: 'state_file', label: '状态文件', type: 'text' },
    ],
  },
]

/* ------------------------------------------------------ 点路径读写 --- */

function getPath(obj: any, p: string) {
  return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}
function setPath(obj: any, p: string, v: unknown) {
  const parts = p.split('.')
  const last = parts.pop() as string
  let cur = obj
  for (const k of parts) {
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {}
    cur = cur[k]
  }
  cur[last] = v
}

/** 数组 ↔ 文本：逗号/空格/全角逗号都当分隔符（用户手打不可能守一种） */
function hoursText(p: string) {
  const v = getPath(doc.value, p)
  return Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v)
}
function setHours(p: string, text: string) {
  const nums = String(text ?? '')
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 23)
  setPath(doc.value, p, nums)
  dirty.value = true
}

function fieldValue(p: string) {
  return getPath(doc.value, p)
}
function onField(p: string, v: unknown) {
  setPath(doc.value, p, v)
  dirty.value = true
}

/* --------------------------------------------------------------- 加载 --- */

async function load() {
  const online = await ensureSidecar()
  ready.value = true
  if (!online) return
  const r = await api.workbuddyConfig()
  if (!r.ok || r.data?.ok === false) {
    err.value = r.error ?? r.data?.error ?? '读取失败'
    return
  }
  err.value = ''
  meta.value = r.data
  if (r.data.parseError) {
    ElMessage.error(`config.json 解析失败：${r.data.parseError}（先修好文件再用本页）`)
    doc.value = null
    return
  }
  doc.value = r.data.doc ?? {}
  rawText.value = r.data.raw ?? ''
  dirty.value = false
}

/* --------------------------------------------------------- 切换编辑模式 --- */

function toRaw() {
  rawText.value = JSON.stringify(doc.value ?? {}, null, 2)
  mode.value = 'raw'
}

function toForm() {
  try {
    const parsed = JSON.parse(rawText.value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return ElMessage.error('配置必须是一个 JSON 对象')
    }
    doc.value = parsed
    mode.value = 'form'
    dirty.value = true
  } catch (e: any) {
    ElMessage.error(`JSON 不合法：${e.message}`)
  }
}

/** 切模式时同步内容：去原文 = 格式化当前 doc；回表单 = 解析原文（不合法就不切） */
function onModeChange(v: string | number | boolean | undefined) {
  if (v === 'raw') toRaw()
  else toForm()
}

onMounted(load)

/* --------------------------------------------------------------- 保存 --- */

async function save() {
  let payload = doc.value
  if (mode.value === 'raw') {
    try {
      payload = JSON.parse(rawText.value)
    } catch (e: any) {
      return ElMessage.error(`JSON 不合法：${e.message}`)
    }
  }
  busy.value = true
  const r = await api.workbuddyConfigSave(payload)
  busy.value = false
  if (!r.ok || r.data?.ok === false) {
    return ElMessage.error(r.error ?? r.data?.error ?? '保存失败')
  }
  ElMessage.success(
    r.data.backedUp ? '已保存（第一次保存，原文件已备份为 .ws.bak），重启网关后生效' : '已保存，重启网关后生效',
  )
  dirty.value = false
  load()
}

async function restore() {
  try {
    await ElMessageBox.confirm(
      '把 config.json 恢复成上次保存前的样子（.ws.bak）。当前文件会被覆盖，改完同样要重启网关。',
      '从备份恢复',
      { type: 'warning', confirmButtonText: '恢复', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  const r = await api.workbuddyConfigRestore()
  if (!r.ok || r.data?.ok === false) {
    return ElMessage.error(r.error ?? r.data?.error ?? '恢复失败')
  }
  ElMessage.success('已从备份恢复，重启网关后生效')
  load()
}

async function restart() {
  restartBusy.value = true
  const r = await api.workbuddyRestart()
  restartBusy.value = false
  if (!r.ok || r.data?.ok === false) {
    return ElMessage.error(r.error ?? r.data?.error ?? '重启失败')
  }
  ElMessage.success('网关已重启')
}

const backupText = computed(() => {
  const m = meta.value
  if (!m?.backupAt) return '还没有备份（保存过一次之后才会生成 .ws.bak）'
  // 两个时间都说：备份文件的 mtime 是「内容是哪个时刻的版本」（Windows 复制连时间一起带），
  // 建立时间才是「什么时候做的备份」。只说一个会让人误判备份的新旧。
  const made = m.backupMadeAt ? `于 ${agoOf(m.backupMadeAt)}建立，` : ''
  return `备份：${made}内容是 ${timeOfMs(m.backupAt)} 那一版`
})
</script>

<template>
  <div class="ws-page">
    <PageHeader
      title="WorkBuddy 网关配置"
      subtitle="在线改 gateway 的 config.json：定时调度、并发与熔断、超时、粘性会话、运维端点"
      icon="Setting"
    >
      <template #actions>
        <el-button size="small" @click="load">
          <el-icon><RefreshRight /></el-icon>&nbsp;重新读取
        </el-button>
        <el-button size="small" type="primary" :loading="busy" :disabled="mode === 'form' && !doc" @click="save">
          保存
        </el-button>
        <el-button size="small" :loading="restartBusy" @click="restart">
          <el-icon><SwitchButton /></el-icon>&nbsp;重启网关
        </el-button>
      </template>
    </PageHeader>

    <!-- 读不到配置：多半是还没配网关目录（网关不随本仓库分发，目录在 config.workbuddy.dir） -->
    <div v-if="ready && err" class="ws-card wbo-block">
      <div class="wbo-block__head">
        <span class="wbo-block__title"><el-icon><WarningFilled /></el-icon>读不到网关配置</span>
      </div>
      <p class="wbo-note" style="margin: 0">{{ err }}</p>
      <p class="wbo-note" style="margin: 8px 0 0">
        这一页是给「你自己装的那份」WorkBuddy2API 网关用的 —— 它不随本仓库分发。
        把网关目录填进边车配置的 <code class="ws-mono">workbuddy.dir</code>，本页读的就是那份 config.json。
      </p>
      <el-button size="small" style="margin-top: 12px" @click="load">重新读取</el-button>
    </div>

    <!-- 边车没连上（err 为空）：那是另一件事，给启动指引 -->
    <SidecarOffline v-else-if="ready && !meta" />

    <template v-else-if="ready && meta">
      <div class="ws-card wbo-block" style="margin-bottom: 16px">
        <div class="wbo-block__head">
          <span class="wbo-block__title"><el-icon><Document /></el-icon>配置文件</span>
          <div class="wbo-toolbar">
            <el-radio-group v-model="mode" size="small" @change="onModeChange">
              <el-radio-button value="form">表单</el-radio-button>
              <el-radio-button value="raw">JSON 原文</el-radio-button>
            </el-radio-group>
            <el-button size="small" :loading="busy" @click="restore">从备份恢复</el-button>
          </div>
        </div>
        <div class="wbo-note">
          <code class="ws-mono">{{ meta.path }}</code>
          <template v-if="meta.exists"> · {{ meta.size }} 字节</template>
          · {{ backupText }}
        </div>
        <div class="wbo-note" style="margin-top: 6px">
          {{ meta.restartNote }}
          <span v-if="dirty" style="color: var(--ws-warn)">当前有未保存的修改。</span>
        </div>
      </div>

      <!-- ------------------------------------------------------- 表单 -->
      <template v-if="mode === 'form' && doc">
        <div v-for="g in GROUPS" :key="g.name" class="ws-card wbo-block" style="margin-bottom: 16px">
          <div class="wbo-block__head">
            <span class="wbo-block__title">{{ g.name }}</span>
          </div>
          <div class="wbo-form__row" v-for="f in g.fields" :key="f.path">
            <div>
              <div class="wbo-form__label ws-mono" style="font-size: 12px">{{ f.path }}</div>
              <div class="wbo-form__hint">{{ f.label }}<template v-if="f.hint"> · {{ f.hint }}</template></div>
            </div>
            <div>
              <el-switch
                v-if="f.type === 'bool'"
                :model-value="!!fieldValue(f.path)"
                @update:model-value="(v) => onField(f.path, v)"
              />
              <el-input
                v-else-if="f.type === 'hours'"
                size="small"
                :model-value="hoursText(f.path)"
                placeholder="9, 21"
                @update:model-value="(v) => setHours(f.path, v)"
              />
              <el-input
                v-else-if="f.type === 'number'"
                size="small"
                type="number"
                :model-value="fieldValue(f.path)"
                @update:model-value="(v) => onField(f.path, v === '' ? null : Number(v))"
              />
              <el-input
                v-else
                size="small"
                :model-value="fieldValue(f.path)"
                @update:model-value="(v) => onField(f.path, v)"
              />
            </div>
          </div>
        </div>

        <p class="wbo-note">
          表单只覆盖上面这些键；其余键（school_hours、cat_hours、upstash 等）保存时原样保留，
          想改它们切到「JSON 原文」。
        </p>
      </template>

      <!-- --------------------------------------------------- JSON 原文 -->
      <div v-else class="ws-card wbo-block">
        <textarea v-model="rawText" class="wbo-code" spellcheck="false" />
        <p class="wbo-note" style="margin-top: 10px">
          这里就是文件原文，怎么写就怎么存。保存前只在第一次留一份 .ws.bak，之后不再覆盖 ——
          所以「上次能用」的那一版一直在，可以从备份恢复。
        </p>
      </div>
    </template>
  </div>
</template>
