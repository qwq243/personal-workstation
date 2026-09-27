<script setup lang="ts">
/**
 * 「智能体」标签页的内容（嵌在进程守护页里）。
 *
 * 识别规则见 server/lib/procscan.mjs 的内置签名表，另加配置里的 procscan.agentExtras
 * （你自己常用的那个客户端若不在内置名单里，用 agentExtras 补一条，不补这页就是空的）。
 * 两个刻意的取舍：
 *   · 树**走到 shell 为止** —— 否则 GUI 型客户端一个会话会把「半天里跑过的所有进程」都算进去。
 *   · 「结束整个会话」逐个成员过保护层，被拒的成员写明原因；这个口子**不给智能体**（MCP 里没有）。
 */
import { onMounted, onUnmounted, ref } from 'vue'
import { api } from '@/core/sidecar'

const loading = ref(false)
const busy = ref('')
const err = ref('')
const data = ref<any>(null)
const log = ref<any>(null)
let timer: ReturnType<typeof setInterval> | null = null

async function load(showLoading = false) {
  if (showLoading) loading.value = true
  try {
    const [r, l] = await Promise.all([api.procAgents(), api.procActions(6)])
    const d = r.data as any
    if (r.ok && d?.ok !== false) {
      data.value = d
      err.value = ''
    } else err.value = d?.error ?? r.error ?? '读不到智能体'
    log.value = (l.data as any) ?? null
  } finally {
    if (showLoading) loading.value = false
  }
}

function mb(n: number) {
  return n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(0)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
}

async function endMember(m: any) {
  try {
    await ElMessageBox.confirm(`结束 ${m.name}（PID ${m.pid}）？`, '确认', {
      confirmButtonText: '结束',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }
  busy.value = String(m.pid)
  try {
    const r = await api.procEnd(m.pid, { force: true, tree: !!m.isRoot })
    const d = r.data as any
    if (d?.ok) ElMessage.success(`已结束 ${d.name}(${d.pid})`)
    else ElMessage.error(d?.error ?? r.error ?? '结束失败')
    await load()
  } finally {
    busy.value = ''
  }
}

async function endSession(s: any) {
  try {
    await ElMessageBox.confirm(
      `结束整个 ${s.agent} 会话？\n\n根进程 ${s.rootName}(${s.rootPid})，会处理它子树里的 ${s.count} 个进程；受保护的成员会跳过。`,
      '确认结束整个会话',
      { confirmButtonText: '结束整个会话', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }
  busy.value = 'session'
  try {
    const r = await api.procEndSession(s.rootPid)
    const d = r.data as any
    if (d?.ok) ElMessage.success(`已处理：成功 ${d.done}，跳过 ${d.blocked}，失败 ${d.failed}`)
    else ElMessage.error(d?.error ?? r.error ?? '结束会话失败')
    await load()
  } finally {
    busy.value = ''
  }
}

onMounted(() => {
  load(true)
  timer = setInterval(() => load(), 10000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div class="pane">
    <div class="toolbar">
      <span class="ws-dim">
        当前 <b>{{ data?.total ?? '—' }}</b> 个智能体会话（识别名单见下方说明；树走到 shell 为止）
      </span>
      <span class="ws-spacer" />
      <el-button size="small" :loading="loading" @click="load(true)"><el-icon><Refresh /></el-icon>&nbsp;刷新</el-button>
    </div>
    <p v-if="err" class="ws-muted">{{ err }}</p>
    <div v-else-if="!data?.total" class="ws-empty" style="padding: 28px 0">
      没有识别到在跑的智能体会话。<br />
      <span style="font-size: 12.5px">
        claude-code / codex / gemini-cli / cursor-agent / aider / opencode / crush / qwen-code / goose /
        droid / amp / cline / copilot-cli，外加配置里的 agentExtras 补的客户端
      </span>
    </div>

    <div v-for="s in data?.sessions ?? []" :key="s.id" class="sess">
      <div class="sess__head">
        <el-tag type="success" size="small" effect="dark">{{ s.agent }}</el-tag>
        <b>{{ s.rootName }} <span class="ws-dim">({{ s.rootPid }})</span></b>
        <span class="ws-dim">{{ s.count }} 个进程 · {{ mb(s.ws) }}</span>
        <span class="ws-spacer" />
        <el-button type="danger" plain size="small" :loading="busy === 'session'" @click="endSession(s)">
          结束整个会话
        </el-button>
      </div>
      <el-table :data="s.members" size="small" max-height="300">
        <el-table-column label="进程" min-width="200">
          <template #default="{ row }">
            <span :style="{ paddingLeft: row.depth * 16 + 'px' }">{{ row.name }} <span class="ws-dim">({{ row.pid }})</span></span>
          </template>
        </el-table-column>
        <el-table-column label="内存" width="96" align="right">
          <template #default="{ row }">{{ mb(row.ws) }}</template>
        </el-table-column>
        <el-table-column label="受保护" min-width="150">
          <template #default="{ row }">
            <span class="ws-dim" style="font-size: 12px">{{ row.blocked ? row.blockReason : '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100" align="right">
          <template #default="{ row }">
            <el-tooltip v-if="row.blocked" :content="'受保护：' + row.blockReason" placement="left">
              <el-button size="small" disabled>受保护</el-button>
            </el-tooltip>
            <el-button v-else size="small" type="danger" plain :loading="busy === String(row.pid)" @click="endMember(row)">结束</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div v-if="log?.items?.length" class="auditbox">
      <div class="ws-dim" style="margin-bottom: 4px">最近的结束动作（工作台的审计）</div>
      <ul class="audit">
        <li v-for="(x, i) in log.items" :key="i">
          <span class="ws-mono ws-dim" style="font-size: 12px">{{ new Date(x.at).toLocaleString('zh-CN') }}</span>
          <el-tag size="small" :type="x.result === 'done' ? 'success' : x.result === 'blocked' ? 'warning' : 'danger'" effect="plain">{{ x.result }}</el-tag>
          <span>{{ x.name }}({{ x.pid }}) · {{ x.action }}{{ x.tree ? ' · 连子树' : '' }}</span>
          <span v-if="x.reason" class="ws-dim">{{ x.reason }}</span>
        </li>
      </ul>
    </div>

    <p class="ws-dim" style="margin-top: 12px; font-size: 12.5px">
      界面上的「结束」是<b>人点的动作</b>，所以不看演练开关（和它自己的规矩一致），但必须过保护层，且每次都写审计。
      这个能力不开放给 MCP —— 智能体拿不到结束进程的口子。
    </p>
  </div>
</template>

<style scoped>
.pane { padding-top: 4px; }
.toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; font-size: 12.8px; }
.sess { border: 1px solid var(--ws-border); border-radius: var(--ws-radius); padding: 12px 14px; margin-bottom: 12px; }
.sess__head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.auditbox { margin-top: 14px; }
.audit { list-style: none; margin: 0; padding: 0; }
.audit li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; padding: 4px 0; border-bottom: 1px dashed var(--ws-border); font-size: 12.8px; }
</style>
