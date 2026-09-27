<script setup lang="ts">
/**
 * 运行与自启（`#/service`）—— 边车自身状态 + 开机自启位的体检与开关。
 *
 * 数据来源就两条接口，都在 `server/lib/panel.mjs` 里：
 *   GET  /api/panel/sidecar   当前进程：端口 / PID / node / 入口 / 数据目录
 *   GET  /api/panel/status    自启位：启动文件夹里那条 .lnk + 仓库里那个 .vbs 的体检
 *   POST /api/panel/autostart 动作：enable（生成 / 修复）· disable · remove · open-startup
 *
 * 三个动作都会**真的动系统**（写启动文件夹 / 改文件名 / 删文件），所以都过一遍确认框 ——
 * 这一页的手滑代价是「下次开机工作台不起来了」，不值得图快。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import SidecarOffline from '@/components/SidecarOffline.vue'
import { api, ensureSidecar } from '@/core/sidecar'

const ready = ref(false)
const loading = ref(false)
const busy = ref('')
/** GET /api/panel/sidecar：当前进程（端口 / PID / node / 入口 / 数据目录） */
const sc = ref<any>(null)
/** GET /api/panel/status：自启位 + 体检 */
const st = ref<any>(null)

const healthy = computed(() => st.value?.healthy === true)
const active = computed(() => st.value?.active === true)
const problems = computed<string[]>(() => st.value?.problems ?? [])
const warnings = computed<string[]>(() => st.value?.warnings ?? [])

async function load() {
  loading.value = true
  ready.value = await ensureSidecar()
  if (ready.value) {
    const [a, b] = await Promise.all([api.panelSidecar(), api.panelStatus()])
    if (a.ok) sc.value = a.data
    if (b.ok) st.value = b.data
    else ElMessage.error(b.error ?? '读取自启位状态失败')
  }
  loading.value = false
}

async function act(action: 'enable' | 'disable' | 'remove') {
  const label = { enable: '开启（或重建）', disable: '关闭', remove: '删除' }[action]
  const detail = {
    enable: '会在仓库 scripts/ 下生成脚本本体，并在启动文件夹里放一条指向它的快捷方式（不需要管理员权限）。',
    disable: '会把启动文件夹里那条快捷方式改名为 .disabled（文件留着，随时可以再开回来）。',
    remove: '会把那条快捷方式删掉；下次要用得重新「开启」。仓库里的脚本本体也一并清掉。',
  }[action]
  try {
    await ElMessageBox.confirm(`${label}开机自启？${detail}`, `${label}自启位`, {
      type: action === 'remove' ? 'warning' : 'info',
      confirmButtonText: label,
      cancelButtonText: '取消',
    })
  } catch {
    return // 用户点了取消
  }
  busy.value = action
  const r = await api.panelAutostart(action)
  busy.value = ''
  if (!r.ok) return ElMessage.error(r.error ?? `${label}失败`)
  // 接口把体检结果一起返回了（panel.mjs 里每个动作都 return { ...结果, ...status() }）
  if (r.data?.entryName) st.value = r.data
  else await load()
  ElMessage.success(`${label}完成`)
}

async function openStartup() {
  busy.value = 'open-startup'
  const r = await api.panelAutostart('open-startup')
  busy.value = ''
  if (!r.ok) ElMessage.error(r.error ?? '打不开启动文件夹')
}

onMounted(load)
</script>

<template>
  <div class="ws-page">
    <PageHeader
      title="运行与自启"
      subtitle="边车自己的状态，以及开机自启位（启动文件夹里的快捷方式）的体检与开关"
      icon="Monitor"
    >
      <template #actions>
        <el-button :loading="loading" @click="load"><el-icon><Refresh /></el-icon>&nbsp;重新检测</el-button>
      </template>
    </PageHeader>

    <SidecarOffline v-if="!loading && !ready" what="运行与自启" @ready="load" />

    <el-skeleton v-else-if="loading" :rows="6" animated />

    <template v-else-if="st">
      <!-- ① 当前边车进程 -->
      <div class="ws-card blk">
        <div class="blk__title">
          <el-icon><Connection /></el-icon>
          当前边车进程
          <el-tag size="small" type="success" effect="plain">运行中</el-tag>
        </div>
        <el-descriptions :column="2" size="small" border>
          <el-descriptions-item label="端口">{{ sc?.port ?? '—' }}</el-descriptions-item>
          <el-descriptions-item label="PID">{{ sc?.pid ?? '—' }}</el-descriptions-item>
          <el-descriptions-item label="node">{{ sc?.nodeVersion ?? '—' }}</el-descriptions-item>
          <el-descriptions-item label="node 路径">
            <span class="ws-mono ws-dim">{{ sc?.nodePath ?? '—' }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="项目根" :span="2">
            <span class="ws-mono ws-dim">{{ sc?.rootDir ?? '—' }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="配置文件" :span="2">
            <span class="ws-mono ws-dim">{{ sc?.configPath ?? '—' }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="自启日志" :span="2">
            <span class="ws-mono ws-dim">{{ st.logFile ?? '—' }}</span>
          </el-descriptions-item>
        </el-descriptions>
        <p class="ws-dim tip">
          边车不会重启自己（先杀自己就没人接请求了）。换了端口 / 目录要重启，跑
          <code class="ws-mono">npm run server</code> 或 <code class="ws-mono">scripts/restart-sidecar.py</code>。
        </p>
      </div>

      <!-- ② 自启位体检 -->
      <div class="ws-card blk">
        <div class="blk__title">
          <el-icon><SwitchButton /></el-icon>
          开机自启位
          <el-tag v-if="!active" size="small" type="info" effect="plain">
            {{ st.disabled ? '已关闭' : '还没创建' }}
          </el-tag>
          <el-tag v-else-if="healthy" size="small" type="success" effect="plain">体检通过</el-tag>
          <el-tag v-else size="small" type="danger" effect="plain">体检不通过</el-tag>
        </div>

        <el-descriptions :column="2" size="small" border>
          <el-descriptions-item label="启动文件夹" :span="2">
            <span class="ws-mono ws-dim">{{ st.dir ?? '—' }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="自启项">{{ st.entryName ?? '—' }}</el-descriptions-item>
          <el-descriptions-item label="编码">{{ st.encoding ?? '—' }}</el-descriptions-item>
          <el-descriptions-item label="脚本本体" :span="2">
            <span class="ws-mono ws-dim">{{ st.scriptFile ?? '—' }}</span>
            <span v-if="st.scriptExists" class="ws-dim">（在）</span>
            <span v-else class="ws-dim">（不在）</span>
          </el-descriptions-item>
        </el-descriptions>

        <el-alert
          v-for="(p, i) in problems"
          :key="`p${i}`"
          :title="p"
          type="error"
          :closable="false"
          show-icon
          style="margin-top: 10px"
        />
        <el-alert
          v-for="(w, i) in warnings"
          :key="`w${i}`"
          :title="w"
          type="warning"
          :closable="false"
          show-icon
          style="margin-top: 10px"
        />

        <p class="ws-dim tip">
          自启链条是「启动文件夹里的 <code class="ws-mono">.lnk</code> → 仓库
          <code class="ws-mono">scripts/Workstation.vbs</code> → 当前这个 node + 这份边车入口」。
          脚本本体是<b>运行时生成</b>的、不进版本库，所以仓库里翻不到它是正常的。
          三点自检：引用的 exe 在不在、入口是不是当前这份、用的 node 是不是当前这个 ——
          前两项任一不过就是「开机起不来」，第三项只是「现在能用但脆弱」。
        </p>

        <div class="ws-row act">
          <el-button type="primary" :loading="busy === 'enable'" @click="act('enable')">
            {{ active ? '重建自启位' : '开启自启' }}
          </el-button>
          <el-button :disabled="!active" :loading="busy === 'disable'" @click="act('disable')">关闭（不删文件）</el-button>
          <el-button
            :disabled="!st.present"
            type="danger"
            plain
            :loading="busy === 'remove'"
            @click="act('remove')"
          >删除</el-button>
          <span class="ws-spacer" />
          <el-button text :loading="busy === 'open-startup'" @click="openStartup">打开启动文件夹</el-button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.blk {
  padding: 16px 18px;
  margin-bottom: 14px;
}
.blk__title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  margin-bottom: 12px;
}
.tip {
  font-size: 12.5px;
  line-height: 1.7;
  margin: 12px 0 0;
}
.act {
  margin-top: 14px;
  flex-wrap: wrap;
}
</style>
