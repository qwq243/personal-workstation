<script setup lang="ts">
/**
 * WorkBuddy 账号池 —— 号本身的事：谁能用、还剩多少、凭证什么时候过期、要不要动它。
 *
 * 数据来源 /api/workbuddy/accounts：边车把三个来源合并后下发
 *   网关 /status（内存里的池状态：冷却 / 停用 / 在途 / 连续失败）
 *   auths/workbuddy-*.json（文件里的凭证：realm、过期时间、文件大小）
 *   积分缓存（上游回来的真实积分包）
 * 三个来源分开标，因为「看着不正常」有三种完全不同的原因，处理方式也不同：
 *   文件坏了 → 重新登录；不在池里 → 重启网关；被停用/冷却 → 等或手动放行。
 *
 * 页面上的每个按钮都会真的改东西（改文件 / 重启进程 / 出网），所以全部由点击触发；
 * 页面自己只做读和 30s 轮询。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import SidecarOffline from '@/components/SidecarOffline.vue'
import EmptyState from '@/components/EmptyState.vue'
import { api, ensureSidecar } from '@/core/sidecar'
import { agoOf, copyText, daysLeft, num, pct, realmLabel, stateOf, timeOf, timeOfSec, tone } from './wb-shared'

const ready = ref(false)
const loading = ref(false)
const err = ref('')
const data = ref<any>(null)
const busyUid = ref('')
let timer: ReturnType<typeof setInterval> | null = null

const rows = computed<any[]>(() => data.value?.rows ?? [])
const summary = computed(() => data.value?.summary ?? null)

function pctOf(a: any) {
  return pct(a.remain, a.size)
}

/** 有效期那一列：过期最要紧，其次是快过期，正常就只显示日期 */
function expiryTag(a: any) {
  const d = daysLeft(a.expiresAt)
  if (!a.hasFile) return { text: '无凭证文件', tone: 'danger' }
  if (a.expiresAt <= 0) return { text: '未记录有效期', tone: 'muted' }
  if (d == null) return { text: '—', tone: 'muted' }
  if (d < 0) return { text: `已过期 ${-d} 天`, tone: 'danger' }
  if (d < 3) return { text: `剩 ${d} 天`, tone: 'warn' }
  return { text: `剩 ${d} 天`, tone: 'ok' }
}

/* --------------------------------------------------------------- 加载 --- */

async function load() {
  const online = await ensureSidecar()
  if (!online) {
    ready.value = true
    return
  }
  loading.value = true
  const r = await api.workbuddyAccounts()
  loading.value = false
  ready.value = true
  if (!r.ok) {
    err.value = r.error ?? '读取失败'
    data.value = null
    return
  }
  err.value = ''
  data.value = r.data
}

onMounted(() => {
  load()
  timer = setInterval(load, 30000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

/* ----------------------------------------------------------- 单账号动作 --- */

/** 单号活跃上报：网关 CLI 支持 uid 前缀，所以单号能跑 */
async function travelOne(a: any) {
  busyUid.value = a.uid
  const r = await api.workbuddyStartTask('activity', a.uid.slice(0, 8))
  busyUid.value = ''
  if (!r.ok) return ElMessage.error(r.error ?? '启动失败')
  ElMessage.success(`已开始上报「${a.nickname}」的活跃，逐账号结果到「活动管理」页看`)
}

/** 停用 / 启用 / 复活：走网关的 /admin 端点（config 的 admin.enabled 关着时边车会说明） */
async function admin(a: any, op: 'disable' | 'enable' | 'revive') {
  const label = { disable: '临时停用', enable: '解除停用', revive: '复活（解除系统禁用）' }[op]
  busyUid.value = a.uid
  const r = await api.workbuddyAccountAdmin(a.uid, op)
  busyUid.value = ''
  if (!r.ok || r.data?.ok === false) {
    const hint = r.data?.hint ? `（${r.data.hint}）` : ''
    return ElMessage.error(`${label}失败：${r.error ?? r.data?.error ?? '未知原因'}${hint}`)
  }
  ElMessage.success(`${a.nickname || a.uid.slice(0, 8)} 已${label}`)
  load()
}

/** 删账号 = 删本地凭证文件。要用户把 uid 打出来才动手（和参考实现同一道闸） */
async function remove(a: any) {
  try {
    await ElMessageBox.confirm(
      `删除「${a.nickname || a.uid.slice(0, 8)}」的本地凭证文件（${a.file || '无文件'}）。` +
        '删掉之后网关重启就不会再加载这个号；上游那边的账号本身不受影响，重新登录即可恢复。',
      '删除账号凭证',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  busyUid.value = a.uid
  const r = await api.workbuddyDeleteAccount(a.uid)
  busyUid.value = ''
  if (!r.ok || r.data?.ok === false) {
    return ElMessage.error(r.error ?? r.data?.error ?? '删除失败')
  }
  ElMessage.success('凭证文件已删除，重启网关后这个号就彻底不在池里了')
  load()
}

/* --------------------------------------------------------------- 导入 --- */

const importOpen = ref(false)
const importText = ref('')
const importBusy = ref(false)

/** 提示文本放常量里：三种可接受的形态要写清楚，直接写在模板属性里会被引号咬坏 */
const IMPORT_PLACEHOLDER = [
  '把凭据 JSON 粘到这里，支持三种形态：',
  '1) {"account":{...},"auth":{...}}  —— 本仓库与网关写出的格式',
  '2) {"accessToken":"...","refreshToken":"...","expiresAt":1794657646,"uid":"...","domain":"登录域"}  —— 扁平式',
  '3) login.exe poll 的输出（access_token / refresh_token / expires_in）',
].join('\n')

async function doImport() {
  if (!importText.value.trim()) return ElMessage.warning('先把凭据 JSON 粘进来')
  importBusy.value = true
  const r = await api.workbuddyImportAccount(importText.value)
  importBusy.value = false
  if (!r.ok || r.data?.ok === false) {
    return ElMessage.error(r.error ?? r.data?.error ?? '导入失败')
  }
  importOpen.value = false
  importText.value = ''
  ElMessage.success(`已写入 ${r.data.file}，重启网关后生效`)
  load()
}

/* ----------------------------------------------------------- 网页登录 --- */

const loginOpen = ref(false)
const realm = ref<'cn' | 'global'>('cn')
const loginUrl = ref('')
const loginBusy = ref(false)
const loginMsg = ref('')
const loginDone = ref<any>(null)
let pollTimer: ReturnType<typeof setInterval> | null = null
let pollCount = 0

function stopPoll() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  pollCount = 0
}

async function loginStart() {
  loginBusy.value = true
  loginDone.value = null
  loginMsg.value = ''
  stopPoll()
  const r = await api.workbuddyLoginStart(realm.value)
  loginBusy.value = false
  if (!r.ok || r.data?.ok === false) {
    loginUrl.value = ''
    return (loginMsg.value = r.error ?? r.data?.error ?? '拿授权链接失败')
  }
  loginUrl.value = r.data.url
  loginMsg.value = '在浏览器里打开下面这个链接完成登录，本页会自动轮询结果（也可以手动点「查询登录结果」）。'
  // 自动轮询：登录在浏览器那边完成，这边只能不停问；10 分钟没结果就停手
  pollTimer = setInterval(async () => {
    pollCount += 1
    if (pollCount > 200) {
      stopPoll()
      loginMsg.value = '没等到登录结果（已轮询 10 分钟），链接可能已失效，重新点「重新获取链接」'
      return
    }
    const p = await api.workbuddyLoginPoll(realm.value)
    const d = p.data ?? {}
    if (p.ok && d.ok && !d.pending) {
      stopPoll()
      loginDone.value = d
      loginUrl.value = ''
      loginMsg.value = ''
      ElMessage.success(`登录成功：${d.nickname || d.uid}`)
      load()
    }
  }, 3000)
}

async function loginPollOnce() {
  if (!loginUrl.value) return
  loginBusy.value = true
  const p = await api.workbuddyLoginPoll(realm.value)
  loginBusy.value = false
  const d = p.data ?? {}
  if (p.ok && d.ok && !d.pending) {
    stopPoll()
    loginDone.value = d
    loginUrl.value = ''
    ElMessage.success(`登录成功：${d.nickname || d.uid}`)
    load()
    return
  }
  loginMsg.value = d.message ?? p.error ?? '还没完成'
}

function closeLogin() {
  stopPoll()
  loginOpen.value = false
  loginUrl.value = ''
  loginMsg.value = ''
  loginDone.value = null
}

/** 模板里拿不到 window，包一层 */
function openUrl(url: string) {
  if (url) window.open(url, '_blank')
}

/* --------------------------------------------------------------- 重启 --- */

const restartBusy = ref(false)

async function restart() {
  try {
    await ElMessageBox.confirm(
      '重启 WorkBuddy2API 网关：正在跑的对话请求会断开，几秒后自动恢复。' +
        '改了配置、加了账号、删了账号之后必须重启才会生效。',
      '重启网关',
      { type: 'warning', confirmButtonText: '重启', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  restartBusy.value = true
  const r = await api.workbuddyRestart()
  restartBusy.value = false
  if (!r.ok || r.data?.ok === false) {
    return ElMessage.error(r.error ?? r.data?.error ?? '重启失败')
  }
  ElMessage.success('网关已重启')
  load()
}
</script>

<template>
  <div class="ws-page">
    <PageHeader
      title="WorkBuddy 账号池"
      subtitle="每个上游账号的积分、状态与凭证有效期；加号、停用、删号都在这一页"
      icon="User"
    >
      <template #actions>
        <span v-if="data?.creditAt" class="ws-dim" style="font-size: 11.5px">
          积分 {{ agoOf(data.creditAt) }}更新
        </span>
        <el-button size="small" :loading="loading" @click="load">
          <el-icon><Refresh /></el-icon>&nbsp;刷新
        </el-button>
        <el-button size="small" :loading="restartBusy" @click="restart">
          <el-icon><SwitchButton /></el-icon>&nbsp;重启网关
        </el-button>
        <el-button size="small" type="primary" @click="loginOpen = true">
          <el-icon><Plus /></el-icon>&nbsp;加账号
        </el-button>
      </template>
    </PageHeader>

    <SidecarOffline v-if="ready && !data" />

    <template v-else-if="data">
      <div v-if="err" class="ws-card wbo-block" style="margin-bottom: 16px">
        <span class="wb-error-note">{{ err }}</span>
      </div>

      <!-- --------------------------------------------------------- KPI -->
      <div class="wbo-kpi">
        <div class="ws-card wbo-kpi__card">
          <div class="wbo-kpi__label">账号数</div>
          <div class="wbo-kpi__value">{{ summary?.total ?? 0 }}</div>
          <div class="wbo-kpi__foot">凭证文件 {{ summary?.total ?? 0 }} 个</div>
        </div>
        <div class="ws-card wbo-kpi__card">
          <div class="wbo-kpi__label">在池参与轮转</div>
          <div class="wbo-kpi__value">
            {{ summary?.inPool ?? 0 }}<i>/ {{ summary?.total ?? 0 }}</i>
          </div>
          <div class="wbo-kpi__foot">
            <span v-if="summary?.notLoaded" class="wbo-tag is-warn">
              {{ summary.notLoaded }} 个没加载（要重启网关）
            </span>
            <span v-else>全部已加载</span>
          </div>
        </div>
        <div class="ws-card wbo-kpi__card">
          <div class="wbo-kpi__label">冷却 / 停用</div>
          <div class="wbo-kpi__value">{{ summary?.cooling ?? 0 }}</div>
          <div class="wbo-kpi__foot">停用 {{ summary?.disabled ?? 0 }} 个</div>
        </div>
        <div class="ws-card wbo-kpi__card">
          <div class="wbo-kpi__label">凭证有效期</div>
          <div class="wbo-kpi__value">
            <template v-if="summary?.expired">{{ summary.expired }}</template>
            <template v-else>正常</template>
            <i v-if="summary?.expired">个已过期</i>
          </div>
          <div class="wbo-kpi__foot">
            {{ summary?.expiringSoon ? `${summary.expiringSoon} 个 10 分钟内该刷新` : '都不急着刷新' }}
          </div>
        </div>
      </div>

      <!-- ------------------------------------------------------- 账号表 -->
      <div class="ws-card wbo-block">
        <div class="wbo-block__head">
          <span class="wbo-block__title"><el-icon><User /></el-icon>账号明细</span>
          <span class="ws-dim" style="font-size: 11.5px">
            积分少的号会被网关优先轮空；停用只影响本机网关的流量分配
          </span>
        </div>

        <EmptyState
          v-if="!rows.length"
          title="还没有账号"
          description="点右上角「加账号」走网页登录（等价于到网关目录跑它自己的登录脚本）"
        />

        <div v-else style="overflow-x: auto">
          <table class="wbo-table">
            <thead>
              <tr>
                <th style="min-width: 190px">账号</th>
                <th style="width: 90px">域</th>
                <th style="width: 130px">剩余 / 总量</th>
                <th style="width: 150px">状态</th>
                <th style="width: 120px">凭证有效期</th>
                <th style="width: 110px">最近成功</th>
                <th style="width: 210px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="a in rows" :key="a.uid">
                <td>
                  <div class="wbo-items__name">{{ a.nickname }}</div>
                  <div
                    class="wbo-table__sub ws-mono"
                    :title="a.file ? `凭证文件：${a.file}` : '网关池里有这个号，但 auths/ 里找不到对应文件'"
                  >
                    {{ a.uid.slice(0, 8) }}
                  </div>
                  <div v-if="!a.hasFile" class="wbo-table__sub">网关池里有，但找不到凭证文件</div>
                </td>
                <td>
                  <span class="wbo-tag" :class="a.realm === 'global' ? 'is-info' : ''">
                    {{ realmLabel(a.realm) }}
                  </span>
                </td>
                <td class="ws-mono">
                  <template v-if="a.remain != null">
                    <b :class="`is-${tone(pctOf(a))}`">{{ num(a.remain) }}</b>
                    <span class="ws-dim"> / {{ a.size ? num(a.size) : '—' }}</span>
                    <div class="wbo-bar wbo-bar--sm" style="margin-top: 6px">
                      <div
                        class="wbo-bar__fill"
                        :class="`is-${tone(pctOf(a))}`"
                        :style="{ width: Math.min(100, Math.max(0, pctOf(a) || 0)) + '%' }"
                      />
                    </div>
                    <div class="wbo-table__sub">
                      <template v-if="pctOf(a) != null">
                        {{ pctOf(a) }}%<template v-if="a.remain === 0"> · 已用尽</template>
                      </template>
                      <template v-else>积分未知</template>
                    </div>
                  </template>
                  <span v-else class="ws-dim" title="还没查过积分，点「活动管理」页的查积分">—</span>
                </td>
                <td>
                  <span class="wbo-tag" :class="`is-${stateOf(a).tone}`">{{ stateOf(a).text }}</span>
                  <span v-if="a.manualDisabled" class="wbo-tag is-muted">已停用</span>
                  <div v-if="a.cooling" class="wbo-table__sub">
                    冷却至 {{ timeOf(a.coolingUntil) || '未知' }}
                  </div>
                  <div v-if="a.creditError" class="wbo-table__sub" :title="a.creditError">积分查询失败</div>
                </td>
                <td>
                  <span class="wbo-tag" :class="`is-${expiryTag(a).tone}`">{{ expiryTag(a).text }}</span>
                  <div v-if="a.expiresAt > 0" class="wbo-table__sub ws-mono">
                    {{ timeOfSec(a.expiresAt) }}
                  </div>
                </td>
                <td class="ws-dim" style="font-size: 12px">
                  {{ timeOf(a.lastSuccess) || '—' }}
                  <div v-if="a.consecutiveFails" class="wbo-table__sub">
                    连续失败 {{ a.consecutiveFails }} 次
                  </div>
                </td>
                <td>
                  <div class="wbo-toolbar">
                    <el-button size="small" text type="primary" :loading="busyUid === a.uid" @click="travelOne(a)">
                      活跃
                    </el-button>
                    <el-button
                      v-if="!a.manualDisabled"
                      size="small"
                      text
                      :loading="busyUid === a.uid"
                      @click="admin(a, 'disable')"
                    >
                      停用
                    </el-button>
                    <el-button
                      v-else
                      size="small"
                      text
                      :loading="busyUid === a.uid"
                      @click="admin(a, 'enable')"
                    >
                      解除
                    </el-button>
                    <el-button
                      v-if="a.disabled"
                      size="small"
                      text
                      type="primary"
                      :loading="busyUid === a.uid"
                      @click="admin(a, 'revive')"
                    >
                      复活
                    </el-button>
                    <el-button size="small" text type="danger" @click="remove(a)">删除</el-button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="data.issues?.length" class="wbo-note" style="margin-top: 12px">
          有 {{ data.issues.length }} 个凭证文件读不出来（网关同样会跳过它们）：
          <div v-for="(i, idx) in data.issues" :key="idx" class="ws-mono" style="font-size: 11.5px">
            · {{ i }}
          </div>
        </div>

        <div v-if="!data.adminEnabled" class="wbo-note" style="margin-top: 12px">
          网关没开运维端点：config.json 里 <code class="ws-mono">admin.enabled</code> 不是 true，
          所以「停用 / 解除 / 复活」会被网关拒绝（404）。这三件事要在网关侧生效 ——
          到「网关配置」页打开它再重启网关。
        </div>

        <div class="wbo-note" style="margin-top: 10px">
          凭证目录：<code class="ws-mono">{{ data.dir }}</code> ·
          <a
            href="#/office/workbuddy/config"
            style="color: var(--ws-accent)"
            @click.prevent="copyText(data.dir, '凭证目录已复制')"
          >
            复制路径
          </a>
          。同一个号重复登录会覆盖同一个文件（文件名就是 uid）。
        </div>
      </div>

      <p class="wbo-note" style="margin-top: 14px">
        网关只在<b>启动时</b>扫一遍 auths/ 目录：加号、导入、删除之后都要点「重启网关」才会生效 ——
        在这之前新号不会出现在池里。
      </p>
    </template>

    <!-- ------------------------------------------------------- 导入弹窗 -->
    <el-dialog v-model="importOpen" title="导入凭证（粘贴 JSON）" width="560px">
      <textarea
        v-model="importText"
        class="wbo-code"
        style="min-height: 220px"
        :placeholder="IMPORT_PLACEHOLDER"
      />
      <p class="wbo-note" style="margin-top: 8px">
        写入位置 <code class="ws-mono">auths/workbuddy-&lt;uid&gt;.json</code>，文件名由 uid 决定；
        同 uid 会覆盖。导入后要重启网关才会加载。
      </p>
      <template #footer>
        <el-button @click="importOpen = false">取消</el-button>
        <el-button type="primary" :loading="importBusy" @click="doImport">导入</el-button>
      </template>
    </el-dialog>

    <!-- ----------------------------------------------------- 登录向导 -->
    <el-dialog v-model="loginOpen" title="加账号（网页 OAuth 登录）" width="620px" @close="closeLogin">
      <div class="wbo-form__row">
        <div class="wbo-form__label">版本</div>
        <div>
          <el-radio-group v-model="realm" size="small" :disabled="!!loginUrl || !!loginDone">
            <el-radio-button value="cn">国内版</el-radio-button>
            <el-radio-button value="global">国际版</el-radio-button>
          </el-radio-group>
          <div class="wbo-form__hint">
            两边的账号与积分是独立的；选错域会在签到/查积分时报参数错误。
          </div>
        </div>
      </div>

      <div style="margin: 12px 0">
        <el-button type="primary" :loading="loginBusy" @click="loginStart">
          {{ loginUrl ? '重新获取链接' : '获取授权链接' }}
        </el-button>
        <el-button v-if="loginUrl" :loading="loginBusy" @click="loginPollOnce">查询登录结果</el-button>
      </div>

      <div v-if="loginUrl" class="ws-card" style="padding: 10px 12px; margin-bottom: 10px">
        <div class="ws-mono" style="font-size: 12px; word-break: break-all">{{ loginUrl }}</div>
        <div class="wbo-toolbar" style="margin-top: 8px">
          <el-button size="small" @click="copyText(loginUrl, '授权链接已复制')">复制链接</el-button>
          <el-button size="small" @click="openUrl(loginUrl)"> 在新标签打开 </el-button>
        </div>
      </div>

      <div v-if="loginDone" class="ws-card" style="padding: 12px">
        <div>
          <span class="wbo-tag is-ok">登录成功</span>
          <b style="margin-left: 8px">{{ loginDone.nickname || loginDone.uid }}</b>
        </div>
        <p class="wbo-note" style="margin-top: 6px">
          凭证已写入 <code class="ws-mono">{{ loginDone.file }}</code>。点下面「重启网关」加载这个号。
        </p>
        <el-button size="small" type="primary" style="margin-top: 8px" :loading="restartBusy" @click="restart">
          重启网关
        </el-button>
      </div>

      <p v-if="loginMsg" class="wbo-note">{{ loginMsg }}</p>
      <p class="wbo-note">
        流程和网关自己那个登录脚本完全一样（同一个 login.exe）：
        这里只把「打开链接 → 轮询结果 → 写 auths/ 文件」搬到了页面上。
      </p>
    </el-dialog>
  </div>
</template>

<style scoped>
.wb-error-note {
  color: var(--ws-danger);
  font-size: 12.5px;
}
.is-ok {
  color: var(--ws-success);
}
.is-warn {
  color: var(--ws-warn);
}
.is-danger {
  color: var(--ws-danger);
}
.is-muted {
  color: var(--ws-text-3);
}
</style>
