<script setup lang="ts">
/**
 * 模型用量 —— NewAPI 余额 / 消费 / 请求日志。
 *
 * 数据来源：边车 /api/newapi/snapshot（usage-cache 两级定时同步的缓存快照）。
 * 打开页面 **0 个 NewAPI 请求**：服务端后台按「轻 liveSec / 全量 fullSec」自动同步
 * （间隔可用环境变量调），页面永远先画缓存，
 * 手动刷新才同步出网 —— 「卡一会才展示」就是这么治好的。
 *
 * 图形与口径（配色走工作站令牌）：
 *  - 小时花费 = 实心柱（零值灰矮柱、每小时标签），数据来自官方聚合 /api/data/self；
 *  - 「缓存命中」卡：总命中率 + 命中最高的模型（cache_tokens / prompt_tokens）；
 *  - 本页的口径：慢 = 耗时 ≥60s；失败 = type=5 或流式回包状态非 ok。
 * 密钥明文永远在边车里，前端只拿到名字与数字。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import SidecarOffline from '@/components/SidecarOffline.vue'
import EmptyState from '@/components/EmptyState.vue'
import { api, ensureSidecar } from '@/core/sidecar'

const ready = ref(false)
const loading = ref(false) // 仅手动刷新时转圈；自动同步静默
const err = ref('')

const snap = ref<any>(null)
const checkedAt = ref(0)
let autoTimer: ReturnType<typeof setInterval> | null = null

/* ------------------------------------------------------------- 金额 --- */

/** 金额自适应小数位：大额给 2 位，小额给 4 位（单次调用常常不到 1 分钱） */
function money(n?: number | null) {
  if (n == null || Number.isNaN(Number(n))) return '—'
  const v = Number(n)
  if (v === 0) return '¥0'
  if (Math.abs(v) < 0.01) return `¥${v.toFixed(4)}`
  if (Math.abs(v) < 1) return `¥${v.toFixed(3)}`
  return `¥${v.toFixed(2)}`
}
function timeOf(unix?: number) {
  if (!unix) return '—'
  const d = new Date(unix * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}
/** 请求耗时（秒），NewAPI 给的是浮点秒；没有值时按 0 显示 */
function secs(n?: number) {
  const v = Number(n)
  return Number.isFinite(v) ? v.toFixed(1) : '0.0'
}
function agoOf(ms?: number) {
  if (!ms) return ''
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  return `${Math.floor(s / 3600)} 小时前`
}
/** 命中率：0~1 → 一位小数百分比 */
function pctOf(cache: number, prompt: number) {
  if (!prompt) return null
  return Math.round((cache / prompt) * 1000) / 10
}

/* ------------------------------------------------------------- 取值 --- */

const live = computed(() => snap.value?.live ?? null)
const full = computed(() => snap.value?.full ?? null)
const balance = computed(() => live.value?.balance ?? null)
const todayStat = computed(() => live.value?.todayStat ?? null)
const balanceOk = computed(() => !!balance.value?.ok)

const consumeLogs = computed<any[]>(() => live.value?.logs?.consume?.items ?? [])
const failLogs = computed<any[]>(() => live.value?.logs?.fail?.items ?? [])

/** 当日总额：优先轻同步的 stat（一次接口），全量未到时用按密钥花费兜底 */
const todayTotal = computed<number | null>(() => {
  if (todayStat.value?.ok) return todayStat.value.yuan
  if (full.value?.byToken?.ok) return full.value.byToken.totalYuan
  return null
})
/** 当日调用次数：接口 total（精确，不受拉取条数限制），退化到日志条数 */
const todayCalls = computed<number | null>(() => {
  if (live.value?.consumeCount?.ok) return live.value.consumeCount.total
  if (live.value?.logs?.consume?.ok) return live.value.logs.consume.total
  return consumeLogs.value.length || null
})
/** 真失败数：type=5 的 total；接口没给时数失败日志条数 */
const failTotal = computed<number>(() => {
  if (live.value?.failCount?.ok) return live.value.failCount.total
  if (live.value?.logs?.fail?.ok) return live.value.logs.fail.total
  return failLogs.value.length
})
const SLOW_SEC = 60 // 「慢」阈值：耗时 ≥60s
const slowCount = computed(() => consumeLogs.value.filter((l) => (l.useTime || 0) >= SLOW_SEC).length)
const avgPerCall = computed(() => {
  const t = todayTotal.value
  if (t == null || !todayCalls.value) return null
  return t / todayCalls.value
})

/** 剩余额度占比：NewAPI 只给「剩余 quota」，总额 = 剩余 + 已用 */
const creditPct = computed<number | null>(() => {
  const b = balance.value
  if (!b?.ok) return null
  const total = Number(b.quota ?? 0) + Number(b.usedQuota ?? 0)
  if (!total) return null
  return Math.round((Number(b.quota) / total) * 1000) / 10
})

/* 小时花费：官方聚合（series），全量未同步时退化到消费日志自聚合 */
const hourly = computed<{ h: number; yuan: number; count: number }[]>(() => {
  if (full.value?.series?.ok) return full.value.series.hourly
  const arr = Array.from({ length: 24 }, (_, h) => ({ h, yuan: 0, count: 0 }))
  for (const l of consumeLogs.value) {
    const h = new Date((l.time ?? 0) * 1000).getHours()
    if (!arr[h]) continue
    arr[h].yuan += l.yuan || 0
    arr[h].count += 1
  }
  return arr
})
const hourMax = computed(() => Math.max(0.000001, ...hourly.value.map((b) => b.yuan)))
const hourActive = computed(() => hourly.value.filter((b) => b.count > 0))
const busiestHour = computed(() => hourActive.value.slice().sort((a, b) => b.yuan - a.yuan)[0] ?? null)
/** 柱高：有花费按比例（最小 4px 留轮廓），零值给 2px 灰矮柱 */
function barHeight(b: { yuan: number }) {
  return b.yuan > 0 ? Math.max(4, Math.round((b.yuan / hourMax.value) * 88)) : 2
}

/* 模型分布（按花费前 6） */
const modelRows = computed<any[]>(() => {
  if (full.value?.series?.ok) return full.value.series.byModel.slice(0, 6)
  const map = new Map<string, { model: string; count: number; yuan: number; tokens: number }>()
  for (const l of consumeLogs.value) {
    const name = l.model || '未知模型'
    const cur = map.get(name) ?? { model: name, count: 0, yuan: 0, tokens: 0 }
    cur.count += 1
    cur.yuan += l.yuan || 0
    cur.tokens += (l.promptTokens || 0) + (l.completionTokens || 0)
    map.set(name, cur)
  }
  return [...map.values()].sort((a, b) => b.yuan - a.yuan).slice(0, 6)
})
const maxModelYuan = computed(() => Math.max(0.000001, ...modelRows.value.map((m) => m.yuan || 0)))

/* 缓存命中：总命中率 + 命中最高的前 4 个模型（cache_tokens / prompt_tokens） */
const cacheTotal = computed(() => full.value?.series?.ok ? full.value.series.cacheTotal : null)
const cachePct = computed(() => cacheTotal.value?.pct ?? null)
const cacheRows = computed(() => {
  if (!full.value?.series?.ok) return []
  return full.value.series.byModel
    .filter((m: any) => (m.prompt || 0) > 0)
    .slice(0, 4)
    .map((m: any) => ({ model: m.model, hit: pctOf(m.cache, m.prompt), yuan: m.yuan }))
})

/* 密钥：今日消费与累计消费按名字对齐 */
const tokens = computed<any[]>(() => full.value?.tokens?.items ?? [])
const byTokenItems = computed<any[]>(() => full.value?.byToken?.items ?? [])
const maxKeyToday = computed(() => Math.max(0.000001, ...byTokenItems.value.map((k) => k.yuan || 0)))
const keys = computed(() => {
  const map = new Map<string, any>()
  for (const t of tokens.value) map.set(t.name, { ...t, todayYuan: 0, todayCount: 0 })
  for (const k of byTokenItems.value) {
    const cur = map.get(k.name) ?? { name: k.name, group: k.group, status: null, usedYuan: null, unlimited: false }
    cur.todayYuan = k.yuan
    cur.todayCount = k.count || 0
    map.set(k.name, cur)
  }
  return [...map.values()].sort((a, b) => (b.todayYuan || 0) - (a.todayYuan || 0) || (b.usedYuan || 0) - (a.usedYuan || 0))
})
/** 图标底色轮换：走令牌软色板（禁硬编码色），按密钥排序位置取色 */
const SOFT_PALETTE = [
  ['var(--ws-accent)', 'var(--ws-accent-soft)'],
  ['var(--ws-success)', 'var(--ws-success-soft)'],
  ['var(--ws-warn)', 'var(--ws-warn-soft)'],
  ['var(--ws-info)', 'var(--ws-info-soft)'],
  ['var(--ws-danger)', 'var(--ws-danger-soft)'],
]
function keyTone(i: number) {
  return SOFT_PALETTE[i % SOFT_PALETTE.length]
}

/* 日志：失败（真失败）置顶标红，消费日志标「慢」 */
const logRows = computed(() => {
  const fail = failLogs.value.map((l) => ({ ...l, isFail: true, slow: false }))
  const ok = consumeLogs.value
    .filter((l) => !l.fail)
    .map((l) => ({ ...l, isFail: false, slow: (l.useTime || 0) >= SLOW_SEC }))
  return [...fail, ...ok]
    .sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
    .slice(0, 60)
})

const syncHint = computed(() => {
  if (!snap.value) return ''
  return `自动同步 轻 ${snap.value.liveSec}s · 全量 ${Math.round(snap.value.fullSec / 60)}min`
})

/* ------------------------------------------------------------- 加载 --- */

async function load(refresh = false) {
  if (refresh) loading.value = true
  try {
    const r = await api.newapiSnapshot(refresh)
    if (r.ok) {
      snap.value = r.data
      err.value = ''
    } else {
      err.value = r.error ?? '取不到用量缓存'
    }
    checkedAt.value = Date.now()
    // 自动静默刷新：频率跟随服务端配置（首次拿到后启动一次即可）
    if (!autoTimer && snap.value?.liveSec) {
      autoTimer = setInterval(() => void load(false), snap.value.liveSec * 1000)
    }
  } finally {
    if (refresh) loading.value = false
  }
}

onMounted(async () => {
  const ok = await ensureSidecar()
  ready.value = ok
  if (!ok) return
  await load(false)
})
onUnmounted(() => {
  if (autoTimer) clearInterval(autoTimer)
  autoTimer = null
})
</script>

<template>
  <div class="ws-page ws-page--wide">
    <SidecarOffline v-if="ready === false" what="模型用量" @ready="load" />

    <template v-else>
      <PageHeader title="模型用量" subtitle="NewAPI 余额、今日消费、密钥用量与请求日志（服务端缓存同步，打开即显）" icon="Coin">
        <template #actions>
          <span class="ws-dim sync-hint">
            <template v-if="syncHint">{{ syncHint }} ·</template>
            更新于 {{ live?.balance ? agoOf(snap?.liveAt) : '—' }}
          </span>
          <el-button :loading="loading" @click="load(true)"><el-icon><Refresh /></el-icon>&nbsp;刷新</el-button>
        </template>
      </PageHeader>

      <div v-if="err" class="alert">
        <el-icon><WarningFilled /></el-icon>
        <span>{{ err }}</span>
        <span class="ws-dim">（有缓存时页面仍显示上次同步的数据）</span>
      </div>

      <!-- ======================================================== 余额 hero -->
      <div class="hero">
        <div class="hero__main">
          <div class="hero__label">账户余额</div>
          <div class="hero__value">
            <span class="hero__unit">¥</span>{{ balanceOk ? money(balance.quotaYuan).slice(1) : '—' }}
          </div>
          <div class="hero__sub">
            <template v-if="balanceOk">
              {{ balance.username }}<span v-if="balance.group"> · {{ balance.group }}</span>
              · 累计消费 {{ money(balance.usedYuan) }}
            </template>
            <template v-else>余额接口不可用</template>
          </div>
        </div>
        <div class="hero__side">
          <div class="hero__label">今日花费</div>
          <div class="hero__today">
            {{ todayTotal == null ? '—' : money(todayTotal) }}
          </div>
          <div class="hero__foot">
            <span><b>{{ todayCalls ?? '—' }}</b> 次调用</span>
            <span v-if="avgPerCall != null">均 <b>{{ money(avgPerCall) }}</b>/次</span>
          </div>
        </div>
        <div v-if="creditPct != null" class="hero__credit">
          <div class="hero__credit-bar"><i :style="{ width: `${Math.min(100, creditPct)}%` }" /></div>
          <div class="hero__credit-text">剩余额度 {{ creditPct }}%</div>
        </div>
      </div>

      <!-- ============================================================ KPI -->
      <div class="kpis">
        <div class="kpi">
          <div class="kpi__label">今日调用</div>
          <div class="kpi__value">{{ todayCalls ?? '—' }}<small>次</small></div>
          <div class="kpi__foot">{{ keys.filter((k) => k.todayCount).length }} 个密钥有调用</div>
        </div>
        <div class="kpi">
          <div class="kpi__label">平均单次</div>
          <div class="kpi__value">{{ avgPerCall == null ? '—' : money(avgPerCall) }}</div>
          <div class="kpi__foot">今日总额 / 调用次数</div>
        </div>
        <div class="kpi">
          <div class="kpi__label">失败请求</div>
          <div class="kpi__value" :class="{ 'is-danger': failTotal > 0 }">{{ failTotal }}</div>
          <div class="kpi__foot">真失败（接口给出，非猜测）</div>
        </div>
        <div class="kpi">
          <div class="kpi__label">缓存命中</div>
          <div class="kpi__value" :class="{ 'is-ok': cachePct != null }">
            <template v-if="cachePct != null">{{ cachePct }}<small>%</small></template>
            <template v-else>—</template>
          </div>
          <div class="kpi__foot">{{ busiestHour ? `最忙 ${busiestHour.h}:00` : '今天还没有请求' }}</div>
        </div>
      </div>

      <div class="cols">
        <!-- ====================================================== 左列 -->
        <div class="col">
          <!-- 小时花费（实心柱 + 灰零柱 + 每小时标签） -->
          <div class="ws-card block">
            <div class="block__head">
              <span class="block__title"><el-icon><Histogram /></el-icon> 今日小时花费</span>
              <span class="ws-dim">{{ money(todayTotal) }}<template v-if="busiestHour"> · 最忙 {{ busiestHour.h }}:00</template></span>
            </div>
            <div v-if="!hourActive.length" class="ws-dim" style="font-size: 12.5px; padding: 10px 0">
              今天还没有请求记录。
            </div>
            <div v-else class="hours">
              <div v-for="b in hourly" :key="b.h" class="hours__col">
                <el-tooltip :content="`${b.h}:00 · ${b.count} 次 · ${money(b.yuan)}`" placement="top">
                  <div class="hours__bar" :class="{ 'is-zero': !b.yuan }" :style="{ height: `${barHeight(b)}px` }" />
                </el-tooltip>
                <span class="hours__lbl">{{ b.h }}</span>
              </div>
            </div>
          </div>

          <!-- 密钥用量（色块图标 + 今日/累计两个数字） -->
          <div class="ws-card block">
            <div class="block__head">
              <span class="block__title"><el-icon><Key /></el-icon> 密钥用量</span>
              <span class="ws-dim">{{ keys.length }} 个</span>
            </div>
            <div v-if="!keys.length" class="ws-dim" style="font-size: 12.5px">没读到密钥列表（等待全量同步，或 NewAPI 令牌接口不可用）。</div>
            <div v-else class="keys">
              <div v-for="(k, i) in keys" :key="k.name" class="key">
                <div
                  class="key__ico"
                  :style="{ color: keyTone(i)[0], background: keyTone(i)[1] }"
                >{{ String(k.name ?? '?').slice(0, 2) }}</div>
                <div class="key__body">
                  <div class="key__top">
                    <span class="key__name">{{ k.name }}</span>
                    <span v-if="k.status != null" class="pill" :class="k.status === 1 ? 'pill--ok' : 'pill--off'">
                      {{ k.status === 1 ? '启用' : '停用' }}
                    </span>
                    <span v-if="k.unlimited" class="pill pill--info">不限量</span>
                  </div>
                  <div class="key__track">
                    <i class="key__fill" :style="{ width: `${Math.max(2, ((k.todayYuan || 0) / maxKeyToday) * 100)}%` }" />
                  </div>
                  <div class="key__nums">
                    <span class="key__today">今日 {{ money(k.todayYuan) }}<span v-if="k.todayCount" class="ws-dim"> · {{ k.todayCount }} 次</span></span>
                    <span class="ws-dim">累计 {{ k.usedYuan == null ? '—' : money(k.usedYuan) }}</span>
                  </div>
                </div>
              </div>
            </div>
            <div class="block__note">
              色块按用量排名轮换软色板；横条为今日消费占比（按最大的一条等比缩放）。
            </div>
          </div>
        </div>

        <!-- ====================================================== 右列 -->
        <div class="col">
          <!-- 缓存命中（总命中率 + 命中最高的模型横条） -->
          <div class="ws-card block">
            <div class="block__head">
              <span class="block__title"><el-icon><TrendCharts /></el-icon> 缓存命中</span>
              <span class="ws-dim">输入 tokens 复用率</span>
            </div>
            <EmptyState v-if="!cacheTotal" title="等待全量同步" icon="TrendCharts" />
            <template v-else>
              <div class="cache-top">
                <span class="cache-top__pct">{{ cachePct == null ? '—' : cachePct }}<small>%</small></span>
                <span class="ws-dim cache-top__meta">
                  命中 {{ (cacheTotal.cache ?? 0).toLocaleString() }} / 输入 {{ (cacheTotal.prompt ?? 0).toLocaleString() }} tokens
                </span>
              </div>
              <div v-for="c in cacheRows" :key="c.model" class="hbar">
                <span class="hbar__n" :title="c.model">{{ c.model }}</span>
                <span class="hbar__track"><i :style="{ width: `${Math.max(2, c.hit ?? 0)}%` }" /></span>
                <span class="hbar__v ws-mono">{{ c.hit == null ? '—' : `${c.hit}%` }}</span>
              </div>
            </template>
            <div class="block__note">
              上下文缓存命中的输入 token 占比 —— 命中越高，同样的对话越省钱（缓存部分按半价计）。
            </div>
          </div>

          <!-- 模型分布 -->
          <div class="ws-card block">
            <div class="block__head">
              <span class="block__title"><el-icon><Grid /></el-icon> 模型分布</span>
              <span class="ws-dim">今日 · 前 6</span>
            </div>
            <EmptyState v-if="!modelRows.length" title="今天还没有调用记录" icon="Histogram" />
            <div v-else class="models">
              <div v-for="m in modelRows" :key="m.model" class="model">
                <div class="model__top">
                  <span class="model__name">{{ m.model }}</span>
                  <span class="model__yuan ws-mono">{{ money(m.yuan) }}</span>
                </div>
                <div class="model__track"><i :style="{ width: `${Math.max(2, ((m.yuan || 0) / maxModelYuan) * 100)}%` }" /></div>
                <div class="model__meta ws-dim">
                  {{ m.count }} 次<template v-if="m.tokens"> · {{ m.tokens.toLocaleString() }} tokens</template>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ========================================================== 日志 -->
      <div class="ws-card block logs">
        <div class="block__head">
          <span class="block__title"><el-icon><Document /></el-icon> 请求日志</span>
          <span class="ws-dim">
            失败 {{ failTotal }} · 慢（≥{{ SLOW_SEC }}s）{{ slowCount }} · 展示最近 {{ logRows.length }} 条
          </span>
        </div>
        <div v-if="!logRows.length" class="ws-dim" style="font-size: 12.5px">今天还没有请求日志。</div>
        <div v-else class="loglist">
          <div v-for="l in logRows" :key="`${l.isFail ? 'f' : 'ok'}-${l.id}`" class="logrow" :class="{ 'is-fail': l.isFail, 'is-slow': !l.isFail && l.slow }">
            <span class="logrow__time ws-mono">{{ timeOf(l.time) }}</span>
            <span class="logrow__main">
              <span class="logrow__name">
                <span v-if="l.isFail" class="tag tag--fail">失败</span>
                <span v-else-if="l.slow" class="tag tag--slow">慢</span>
                {{ l.model || '未知模型' }}
              </span>
              <span class="logrow__meta">
                {{ l.tokenName || '未知密钥' }} · {{ l.promptTokens }}+{{ l.completionTokens }} tokens
                · {{ secs(l.useTime) }}s
                <template v-if="l.isStream"> · 流式</template>
                <template v-if="l.fail"> · {{ l.fail }}</template>
              </span>
            </span>
            <span class="logrow__cost ws-mono">{{ money(l.yuan) }}</span>
          </div>
        </div>
        <div class="block__note">
          「失败」是端点的真实失败日志（type=5，或流式回包状态非 ok）；
          「慢」= 耗时 ≥{{ SLOW_SEC }}s。数据来自边车缓存，同步频率见页头。
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.sync-hint {
  font-size: 11.5px;
}
.alert {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  padding: 9px 13px;
  border-radius: var(--ws-radius);
  border: 1px solid var(--ws-border);
  background: var(--ws-warn-soft);
  color: var(--ws-warn);
  font-size: var(--ws-fs-sm);
}
.alert .ws-dim {
  margin-left: auto;
  font-size: 11.5px;
}

/* --------------------------------------------------------------- hero --- */
.hero {
  position: relative;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 16px;
  align-items: center;
  padding: 20px 24px 34px;
  border-radius: var(--ws-radius-lg);
  color: var(--ws-on-accent);
  background: linear-gradient(135deg, var(--ws-accent) 0%, var(--ws-accent-grad-end) 100%);
  box-shadow: var(--ws-shadow-2);
  margin-bottom: 16px;
  overflow: hidden;
}
.hero__label {
  font-size: 11.5px;
  opacity: 0.82;
  letter-spacing: 0.03em;
}
.hero__value {
  font-size: 36px;
  font-weight: 750;
  letter-spacing: -0.02em;
  line-height: 1.15;
  margin-top: 2px;
  font-variant-numeric: tabular-nums;
}
.hero__unit {
  font-size: 18px;
  font-weight: 500;
  margin-right: 3px;
  opacity: 0.85;
}
.hero__sub {
  font-size: 12.5px;
  opacity: 0.9;
  margin-top: 3px;
}
.hero__side {
  text-align: right;
}
.hero__today {
  font-size: 24px;
  font-weight: 750;
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
}
.hero__foot {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  font-size: 11.5px;
  opacity: 0.9;
  margin-top: 3px;
}
.hero__foot b {
  font-weight: 700;
}
.hero__credit {
  position: absolute;
  left: 24px;
  right: 24px;
  bottom: 12px;
  display: flex;
  align-items: center;
  gap: 10px;
}
.hero__credit-bar {
  flex: 1;
  height: 5px;
  border-radius: 99px;
  background: rgba(255, 255, 255, 0.28);
  overflow: hidden;
}
.hero__credit-bar i {
  display: block;
  height: 100%;
  border-radius: 99px;
  background: var(--ws-on-accent);
}
.hero__credit-text {
  flex: 0 0 auto;
  font-size: 11px;
  opacity: 0.9;
}

/* ---------------------------------------------------------------- KPI --- */
.kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  margin-bottom: 18px;
}
.kpi {
  border: 1px solid var(--ws-border);
  border-radius: var(--ws-radius-lg);
  background: var(--ws-panel);
  padding: 14px 16px;
  box-shadow: var(--ws-shadow-1);
}
.kpi__label {
  font-size: 12px;
  color: var(--ws-text-2);
}
.kpi__value {
  font-size: 25px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--ws-accent);
  line-height: 1.25;
  margin-top: 3px;
}
.kpi__value.is-danger {
  color: var(--ws-danger);
}
.kpi__value.is-ok {
  color: var(--ws-success);
}
.kpi__value small {
  font-size: 13px;
  font-weight: 500;
  color: var(--ws-text-3);
  margin-left: 3px;
}
.kpi__foot {
  font-size: 11.5px;
  color: var(--ws-text-3);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* -------------------------------------------------------------- 布局 --- */
.cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
  align-items: start;
}
@media (max-width: 1020px) {
  .cols {
    grid-template-columns: 1fr;
  }
}
.col {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
}
.block {
  padding: 16px 18px;
}
.block__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
}
.block__title {
  font-size: 14px;
  font-weight: 650;
  display: flex;
  align-items: center;
  gap: 7px;
}
.block__note {
  font-size: 11.5px;
  color: var(--ws-text-3);
  line-height: 1.7;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed var(--ws-border);
}
.block__note code {
  color: var(--ws-accent);
}

/* ------------------------------------------------------------ 小时图 ---
   实心柱（零值灰矮柱），柱下每小时标签 */
.hours {
  display: flex;
  align-items: stretch;
  gap: 3px;
  height: 110px;
}
.hours__col {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
}
.hours__bar {
  width: 100%;
  max-width: 16px;
  border-radius: 3px 3px 1px 1px;
  background: var(--ws-accent);
  transition: height 0.2s ease;
  cursor: default;
}
.hours__bar.is-zero {
  background: var(--ws-border-strong);
  opacity: 0.55;
}
.hours__lbl {
  flex: 0 0 auto;
  margin-top: 4px;
  font-size: 9px;
  line-height: 1;
  color: var(--ws-text-3);
  font-family: var(--ws-mono);
}

/* -------------------------------------------------------------- 密钥 --- */
.keys {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.key {
  display: flex;
  align-items: flex-start;
  gap: 11px;
}
.key__ico {
  flex: 0 0 34px;
  height: 34px;
  border-radius: var(--ws-radius-sm);
  display: grid;
  place-items: center;
  font-size: 11.5px;
  font-weight: 700;
  border: 1px solid var(--ws-border);
  text-transform: uppercase;
}
.key__body {
  flex: 1;
  min-width: 0;
}
.key__top {
  display: flex;
  align-items: center;
  gap: 7px;
}
.key__name {
  font-size: 13px;
  font-weight: 650;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pill {
  font-size: 10px;
  line-height: 15px;
  padding: 0 6px;
  border-radius: 5px;
  font-weight: 600;
}
.pill--ok {
  color: var(--ws-success);
  background: var(--ws-success-soft);
}
.pill--off {
  color: var(--ws-danger);
  background: var(--ws-danger-soft);
}
.pill--info {
  color: var(--ws-info);
  background: var(--ws-info-soft);
}
.key__track {
  position: relative;
  height: 7px;
  margin: 5px 0 4px;
  border-radius: 99px;
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
  overflow: hidden;
}
.key__fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  border-radius: 99px;
  background: var(--ws-accent);
}
.key__nums {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: 11.5px;
}
.key__today {
  font-weight: 650;
  color: var(--ws-accent);
}

/* ------------------------------------------------------ 缓存命中/横条 --- */
.cache-top {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 10px;
}
.cache-top__pct {
  font-size: 30px;
  font-weight: 750;
  letter-spacing: -0.02em;
  color: var(--ws-success);
  font-variant-numeric: tabular-nums;
}
.cache-top__pct small {
  font-size: 14px;
  font-weight: 500;
  margin-left: 2px;
  color: var(--ws-text-3);
}
.cache-top__meta {
  font-size: 11.5px;
}
.hbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 7px 0;
  min-width: 0;
}
.hbar__n {
  flex: 0 0 96px;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hbar__track {
  flex: 1 1 auto;
  height: 9px;
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
  border-radius: 99px;
  overflow: hidden;
  min-width: 0;
}
.hbar__track i {
  display: block;
  height: 100%;
  border-radius: 99px;
  min-width: 2px;
  background: var(--ws-success);
}
.hbar__v {
  flex: 0 0 auto;
  min-width: 48px;
  text-align: right;
  font-size: 11px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* -------------------------------------------------------------- 模型 --- */
.models {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.model__top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}
.model__name {
  font-size: 12.8px;
  font-weight: 650;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.model__yuan {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--ws-accent);
  font-weight: 600;
}
.model__track {
  height: 6px;
  margin: 5px 0 3px;
  border-radius: 99px;
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
  overflow: hidden;
}
.model__track i {
  display: block;
  height: 100%;
  border-radius: 99px;
  background: linear-gradient(to right, var(--ws-accent), var(--ws-accent-grad-end));
}
.model__meta {
  font-size: 11px;
}

/* -------------------------------------------------------------- 日志 --- */
.logs {
  margin-top: 18px;
}
.loglist {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 460px;
  overflow-y: auto;
}
.logrow {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 7px 10px;
  border-radius: var(--ws-radius-sm);
  border: 1px solid var(--ws-border);
  border-left: 3px solid var(--ws-success);
  background: var(--ws-panel);
}
.logrow.is-slow {
  border-left-color: var(--ws-warn);
  background: var(--ws-warn-soft);
}
.logrow.is-fail {
  border-left-color: var(--ws-danger);
  background: var(--ws-danger-soft);
}
.logrow__time {
  flex: 0 0 42px;
  font-size: 11.5px;
  color: var(--ws-text-3);
}
.logrow__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.logrow__name {
  font-size: 12.8px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.logrow__meta {
  font-size: 11px;
  color: var(--ws-text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.logrow__cost {
  flex: 0 0 auto;
  font-size: 12px;
  font-weight: 650;
  color: var(--ws-accent);
}
.logrow.is-fail .logrow__cost {
  color: var(--ws-danger);
}
.tag {
  display: inline-block;
  font-size: 10px;
  line-height: 14px;
  padding: 0 5px;
  margin-right: 5px;
  border-radius: 4px;
  font-weight: 600;
  vertical-align: 1px;
}
.tag--slow {
  color: var(--ws-warn);
  background: var(--ws-warn-soft);
  border: 1px solid var(--ws-warn);
}
.tag--fail {
  color: var(--ws-danger);
  background: var(--ws-danger-soft);
  border: 1px solid var(--ws-danger);
}
</style>
