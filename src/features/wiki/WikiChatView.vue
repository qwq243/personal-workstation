<script setup lang="ts">
/**
 * 知识库 · 问答（会话式流式）。
 *
 * 对应桌面端 Chat：多会话、逐字输出、依据列表、可中途停止；另外把「检索了什么」也显示出来 ——
 * 回答不可信时先看它翻了哪几页，比盯着答案猜有用。技能读库里的 .llm-wiki/skills/*.md。
 *
 * **模型可选**（2026-09-26 补）：接口一直支持 `model`，只是页面没给入口 —— 而「用哪个模型
 * 问这一句」是这页最常用的一档设置（便宜的够用就别上贵的）。清单取自工作台的 ai.models
 * （与每日看板的 AI 助手同一个来源），选「默认」= 不传 model，走「设置 → 模型」里 chat 预设。
 *
 * 2026-09-27 收口：对话骨架换成 `src/ai/AiChat.vue`（气泡 / 空态 / 输入框 / 工具链 / 推理
 * 全部走 vue-element-plus-x），本文件只保留知识库独有的东西 —— 会话列表、技能勾选、
 * 检索设置、依据列表（`[N]` 上标 ↔ 正文锚点的契约必须留着）。
 *
 * 顺带拿到的三样：
 *   · **贴底才跟随的自动滚动**（原来每个 delta 都 `scrollTop = scrollHeight`，用户上翻看上文
 *     会被每帧拽回底部）；
 *   · **输入法守卫**（原来的 `@keydown.enter.exact.prevent` 没挡组合态）；
 *   · **离开页面时中断**（原来 onUnmounted 里没有 abort，跑着的流不会被掐断）。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api, wikiChatStream } from '@/core/sidecar'
import { copyText } from '@/core/clipboard'
import AiChat from '@/ai/AiChat.vue'
import { adaptWikiEvent, applyEvent, markAborted } from '@/ai/adapt'
import { makeMessage, type AiMessage } from '@/ai/model'
import { refresh, typeLabel } from './store'
import WikiShell from './WikiShell.vue'
import WikiMarkdown from './WikiMarkdown.vue'

const router = useRouter()
const sessions = ref<any[]>([])
const currentId = ref('')
const messages = ref<AiMessage[]>([])
const streaming = ref(false)
const skills = ref<any[]>([])
const pickedSkills = ref<string[]>([])
const deep = ref(true)
/** 检索来源开关（对照桌面端 chat 的 tools 参数）：库内永远开；网络 / 本机文件按需开 */
const toolsOn = ref({ web: false, anytxt: false })
const topK = ref(6)
const showAdv = ref(false)
/** 检索模式：auto=有索引就混合 / lexical=只词法 / semantic=只语义（服务端的 searchHybrid mode） */
const retMode = ref<'auto' | 'lexical' | 'semantic'>('auto')
/** 上下文预算与回答上限：留空 = 用边车 config 的 wiki.maxChars / wiki.chatMaxTokens */
const maxChars = ref<number | undefined>(undefined)
const chatMaxTokens = ref<number | undefined>(undefined)

let abort: AbortController | null = null

/* ------------------------------------------------------------- 模型 --- */
const models = ref<string[]>([])
/** 这一档 chat 路由的默认模型（选「默认」时用的就是它） */
const defaultModel = ref('')
/** 路由名（跟随工作台配置的模型路由），显示在提示里 —— 模型名必须与它匹配 */
const modelRoute = ref('')
/** '' = 不覆盖，用任务路由里 chat 预设的模型 */
const model = ref('')

/**
 * 模型清单取自**这一档 chat 路由**（不是工作台 provider）。
 * 路由指到别的网关时选项名可能与本地不同；拿本地的模型名去问网关只会 404。
 */
async function loadModels() {
  const r = await api.wikiLlmModels('chat')
  if (!r.ok) return
  models.value = r.data?.models ?? []
  defaultModel.value = r.data?.default ?? ''
  modelRoute.value = r.data?.provider ?? ''
  // 挑过的模型如果不在这一档路由的清单里（路由换过、或名字带不带 cn: 前缀），退回默认 ——
  // 拿错名字去问只会换来一句上游报错，不如这里就说清楚
  if (model.value && models.value.length && !models.value.includes(model.value)) {
    const bad = model.value
    model.value = ''
    ElMessage.warning(`「${bad}」不在当前路由（${modelRoute.value || '默认'}）的模型清单里，已改回默认`)
  }
}

/** 空态给的几个例子：都要是「这份库里答得出来」的问题，别写成万能句式 */
const SUGGESTIONS = [
  '这份库里收录了哪些内容？',
  '基础解系和通解是什么关系？',
  '等价无穷小替换什么时候会失效？',
  '行列式和矩阵的运算有什么本质区别？',
]

/* --------------------------------------------------------- 检索状态 --- */
/** 语义检索到底启没启用、索引全不全 —— 直接摆出来，省得猜「那个模型是不是没生效」 */
const embed = ref<any>(null)
const embedLine = computed(() => {
  const e = embed.value
  if (!e) return '语义检索：状态未知（边车没答上来）'
  if (!e.enabled) return '语义检索：未启用（设置 → 语义检索）——现在只用词法'
  if (e.modelStale) return `语义检索：索引是用「${e.indexModel}」建的，与当前模型「${e.model}」不一致 —— 要重建索引（设置 → 语义检索）`
  if (!e.pages) return '语义检索：库里还没有可索引的页面'
  if (e.pending > 0) return `语义检索：${e.model} · ${e.dim} 维 · 索引 ${e.indexed}/${e.pages} 页（还有 ${e.pending} 页没建，检索只能捞到已建的那些）`
  return `语义检索：${e.model} · ${e.dim} 维 · ${e.indexed}/${e.pages} 页已索引`
})
async function loadEmbed() {
  const r = await api.wikiEmbed()
  if (r.ok) embed.value = r.data
}
/** 展开时顺手刷一次索引状态：刚建过索引的人希望立刻看到它变绿 */
function toggleAdv() {
  showAdv.value = !showAdv.value
  if (showAdv.value) void loadEmbed()
}

/** 首次进入按「设置 → 网络搜索」里的默认来源初始化开关 */
async function initTools() {
  const r = await api.wikiSearchConfig()
  if (!r.ok) return
  const d = String(r.data?.defaultSource ?? 'wiki')
  toolsOn.value = { web: d === 'web' || d === 'all', anytxt: d === 'anytxt' || d === 'all' }
}

const currentTitle = computed(() => sessions.value.find((s) => s.id === currentId.value)?.title ?? '新会话')
/** 页脚与每条回复上显示的模型名 */
const modelLabel = computed(() => model.value || defaultModel.value || '跟随设置')

async function loadSessions() {
  const [s, k] = await Promise.all([api.wikiSessions(60), api.wikiSkills()])
  sessions.value = s.ok ? (s.data.sessions ?? []) : []
  skills.value = k.ok ? (k.data.skills ?? []) : []
}

async function openSession(id: string) {
  const r = await api.wikiSession(id)
  if (!r.ok) return ElMessage.warning(r.error ?? '读不到会话')
  currentId.value = id
  messages.value = (r.data.session.messages ?? []).map((m: any) =>
    makeMessage({
      role: m.role,
      content: m.content,
      references: m.references,
      model: m.model,
      partial: m.partial,
      status: 'done',
    }),
  )
}

async function newSession() {
  const r = await api.wikiNewSession()
  if (!r.ok) return ElMessage.error(r.error ?? '新建失败')
  currentId.value = r.data.session.id
  messages.value = []
  await loadSessions()
}

async function removeSession(id: string) {
  await api.wikiDeleteSession(id)
  if (currentId.value === id) {
    currentId.value = ''
    messages.value = []
  }
  await loadSessions()
}

/** 这次问答要带的那一票参数（发送与重试共用；重试时把 regen 打开） */
function chatBody(extra: Record<string, unknown>) {
  return {
    sessionId: currentId.value || undefined,
    model: model.value || undefined,
    skills: pickedSkills.value,
    deep: deep.value,
    topK: topK.value,
    tools: { web: toolsOn.value.web, anytxt: toolsOn.value.anytxt },
    retrieval: {
      webTopK: 5,
      anyTxtTopK: 5,
      mode: retMode.value,
      maxChars: maxChars.value || undefined,
      chatMaxTokens: chatMaxTokens.value || undefined,
    },
    ...extra,
  }
}

/**
 * 把一次流式问答渲染进消息（send 与 retry 共用）。
 *
 * 事件处理收口成两步：`adaptWikiEvent` 把线上帧归一成内部事件、`applyEvent` 应用到消息上。
 * 这里只保留本页独有的收尾：新建会话时回填 sessionId、结束后刷新会话列表。
 * 滚动**不在这里** —— 交给 BubbleList 的 autoScroll（贴底才跟随）。
 */
async function streamInto(msg: AiMessage, body: Record<string, unknown>) {
  streaming.value = true
  abort = new AbortController()
  await wikiChatStream(
    body as any,
    (e) => {
      for (const ev of adaptWikiEvent(e)) {
        applyEvent(msg, ev)
        // 服务端 done 帧里带的新会话 id：首次问答时把它认下来，后续才有会话可续
        if (ev.kind === 'done' && ev.sessionId && !currentId.value) currentId.value = ev.sessionId
      }
      // 浏览器那句 'network error' = 流被掐断（边车重启/网络断），跟「模型不会答」是两回事；
      // 换成一句能指向下一步的中文，原文仍在 errorDetail 里可查
      if (e.type === 'error' && /network error|fetch failed|Failed to fetch/i.test(String(e.error ?? ''))) {
        msg.error = '连接中断（边车可能被重启了，重发一次通常就好）'
        ElMessage.error(msg.error)
      } else if (e.type === 'error' && msg.error) {
        ElMessage.error(msg.error)
      }
    },
    abort.signal,
  )
  if (msg.status === 'streaming') msg.status = 'done'
  streaming.value = false
  abort = null
  await loadSessions()
}

async function send(text: string) {
  const q = text.trim()
  if (!q || streaming.value) return
  messages.value.push(makeMessage({ role: 'user', content: q }))
  const msg = makeMessage({ role: 'assistant', model: modelLabel.value })
  messages.value.push(msg)
  await streamInto(msg, chatBody({ message: q }))
}

/**
 * 重试某条回答：本地把这条清空重新流式填，服务端用 `regen` 把会话里那条旧回复**替换掉**
 * （不新增一轮，所以刷新后不会出现「同一问两份答案」）。
 * 顺带一个用法：先在工具条换个模型再点重试 = 拿同一个问题换模型问一遍。
 */
async function retryMsg(msg: AiMessage) {
  if (streaming.value || msg.role !== 'assistant') return
  msg.content = ''
  msg.reasoning = ''
  msg.tools = []
  msg.references = []
  msg.elapsedMs = undefined
  msg.partial = undefined
  msg.error = undefined
  msg.errorDetail = undefined
  msg.status = 'streaming'
  msg.model = modelLabel.value
  await streamInto(msg, chatBody({ regen: true }))
}

/** 复制一条回答的 markdown 原文 */
async function copyMsg(m: AiMessage) {
  const text = m.content ?? ''
  if (!text.trim()) return ElMessage.warning('这条没有正文可复制')
  await copyText(text, '已复制回答（markdown 原文）')
}

function stop() {
  abort?.abort()
  // 标成「已停止（保留了半截）」：原来只是把 streaming 置 false，界面上看不出这是半截
  const last = messages.value[messages.value.length - 1]
  if (last) markAborted(last)
  streaming.value = false
}

function goPage(path: string) {
  if (path) router.push(`/wiki/browse?path=${encodeURIComponent(path)}`)
}
/** 点正文里的 [N] 上标 = 点下方第 N 条依据（外部链接开新页，库内页跳浏览器） */
function goCite(m: AiMessage, index: number) {
  const r = m.references?.[index]
  if (!r) return
  if (r.kind === 'wiki' || !r.kind) goPage(r.path)
  else window.open(r.path, '_blank', 'noreferrer')
}
function goSlug(slug: string) {
  router.push(`/wiki/browse?slug=${encodeURIComponent(slug)}`)
}

onMounted(async () => {
  await refresh()
  await Promise.all([loadSessions(), initTools(), loadModels(), loadEmbed()])
  if (sessions.value.length && !currentId.value) await openSession(sessions.value[0].id)
})

// 离开页面把正在跑的流掐掉 —— 原来没有这一步，回答会在后台继续跑完
onUnmounted(() => {
  abort?.abort()
})
</script>

<template>
  <WikiShell title="问答" subtitle="只依据库内页面回答、末尾标依据；检索轮次也会显示出来，方便核对它翻了哪几页" icon="ChatDotRound">
    <div class="ch__layout">
      <!-- 左栏：会话列表 + 技能勾选 -->
      <aside class="wk-stack">
        <section class="wk-card wk-card--flush">
          <div class="wk-card__head">
            <h3 class="wk-card__title"><el-icon><ChatDotRound /></el-icon> 会话</h3>
            <el-button size="small" @click="newSession">新会话</el-button>
          </div>
          <div class="wk-list ch__sesslist">
            <div
              v-for="s in sessions"
              :key="s.id"
              class="wk-list__row ch__sess"
              :class="{ 'is-active': s.id === currentId }"
              @click="openSession(s.id)"
            >
              <span class="wk-list__main">
                <span class="wk-list__title">{{ s.title || '未命名' }}</span>
                <span class="wk-list__meta">{{ s.messages?.length ?? 0 }} 条</span>
              </span>
              <button class="ch__del" title="删掉这个会话" @click.stop="removeSession(s.id)">×</button>
            </div>
            <div v-if="!sessions.length" class="wk-empty">还没有会话</div>
          </div>
        </section>

        <section class="wk-card">
          <h3 class="wk-card__title"><el-icon><MagicStick /></el-icon> 技能</h3>
          <p class="wk-hint" style="margin: 6px 0 8px">
            库里的 <code>.llm-wiki/skills/*.md</code>，勾上会拼进这次问答的系统提示。
          </p>
          <el-checkbox-group v-if="skills.length" v-model="pickedSkills" class="ch__skills">
            <el-checkbox v-for="sk in skills" :key="sk.id" :value="sk.id" size="small">{{ sk.name }}</el-checkbox>
          </el-checkbox-group>
          <p v-else class="wk-hint">库里还没有技能文件</p>
        </section>
      </aside>

      <!-- 右栏：对话 -->
      <section class="wk-card ch__main">
        <!-- 检索设置（默认收起） -->
        <div v-if="showAdv" class="ch__adv">
          <span class="ch__adv-item">库内取 <el-input-number v-model="topK" :min="1" :max="20" size="small" style="width: 96px" /></span>
          <span class="ch__adv-item">
            检索
            <el-select v-model="retMode" size="small" style="width: 128px">
              <el-option label="词法+语义" value="auto" />
              <el-option label="只词法" value="lexical" />
              <el-option label="只语义" value="semantic" />
            </el-select>
          </span>
          <span class="ch__adv-item">上下文预算 <el-input-number v-model="maxChars" :min="2000" :max="120000" :step="2000" size="small" style="width: 128px" /></span>
          <span class="ch__adv-item">回答上限 <el-input-number v-model="chatMaxTokens" :min="500" :max="64000" :step="500" size="small" style="width: 128px" /></span>
          <p class="wk-hint">{{ embedLine }}</p>
        </div>

        <!--
          对话本体：气泡 / 空态 / 输入框 / 工具链 / 推理全在 AiChat 里。
          本页只填三处插槽 —— 工具条（模型 + 检索开关）、正文（WikiMarkdown）、依据。
        -->
        <div class="ch__body">
          <AiChat
            :messages="messages"
            :streaming="streaming"
            :suggestions="SUGGESTIONS"
            suggestion-mode="send"
            placeholder="问这份库里的事…（Enter 发送，Shift+Enter 换行）"
            welcome-title="问这份库里的事"
            welcome-desc="它只依据库内页面回答，末尾标出依据；检索了几轮、翻了哪几页都会显示在上面。库里没有的就直说没有，不会拿常识补。"
            @send="send"
            @stop="stop"
          >
            <!-- 输入框上方的工具条 -->
            <template #sender-header>
              <span class="ch__bar-label">模型</span>
              <el-select
                v-model="model"
                size="small"
                class="ch__model"
                :placeholder="`默认（${defaultModel || '跟随设置'}）`"
                :title="modelRoute ? `这一档路由：${modelRoute}（选项来自它上报的模型）` : ''"
              >
                <el-option value="" :label="`默认（${defaultModel || '跟随设置'}）`" />
                <el-option v-for="m in models" :key="m" :value="m" :label="m" />
              </el-select>
              <span v-if="modelRoute" class="ch__bar-route ws-dim">{{ modelRoute }}</span>
              <span class="ws-spacer" />
              <el-checkbox v-model="toolsOn.web" size="small">网络</el-checkbox>
              <el-checkbox v-model="toolsOn.anytxt" size="small">本机文件</el-checkbox>
              <el-checkbox v-model="deep" size="small">补检索</el-checkbox>
              <el-button size="small" @click="toggleAdv">检索设置</el-button>
            </template>

            <template #message-meta="{ msg }">
              <span class="ch__tag">AI</span>
              <span>{{ msg.model || modelLabel }}</span>
            </template>

            <!-- 正文：必须走 WikiMarkdown —— KaTeX 公式、表格、代码块、[[双链]]、[N] 上标都在它里面 -->
            <template #message-content="{ msg }">
              <WikiMarkdown
                v-if="msg.content"
                :text="msg.content"
                :refs="msg.references"
                @wiki-link="goSlug"
                @cite="(ci) => goCite(msg, ci)"
              />
            </template>

            <!-- 依据：序号 [N] 与正文上标一一对应，这个契约不能丢（所以不能用 Attachments 替） -->
            <template #message-refs="{ msg }">
              <div v-if="msg.references?.length" class="ch__refs">
                <span class="ws-dim">依据</span>
                <template v-for="(r, ri) in msg.references" :key="r.path + (r.kind ?? '')">
                  <button v-if="r.kind === 'wiki' || !r.kind" class="wk-chip" @click="goPage(r.path)">
                    <em class="ch__refnum">[{{ ri + 1 }}]</em>{{ r.title }}<em v-if="r.type">{{ typeLabel(r.type) }}</em>
                  </button>
                  <a v-else class="wk-chip" :href="r.path" target="_blank" rel="noreferrer" :title="r.path">
                    <span class="ch__kind">{{ r.kind === 'anytxt' ? '本机' : '网络' }}</span>{{ r.title }}
                  </a>
                </template>
              </div>
            </template>

            <!-- 每条回答的动作：复制原文、重试（换模型再点重试 = 同一个问题换模型问一遍） -->
            <template #message-actions="{ msg }">
              <a title="复制回答（markdown 原文）" @click="copyMsg(msg)">复制</a>
              <a
                :class="{ 'is-off': streaming }"
                title="用当前选中的模型把这个问题重跑一遍（这条回复被替换，不会多出一轮）"
                @click="retryMsg(msg)"
                >重试</a
              >
            </template>

            <template #footer>
              <span>模型：{{ modelLabel }}</span>
              <span>· 库内检索：{{ retMode === 'auto' ? '词法+语义' : retMode === 'lexical' ? '只词法' : '只语义' }}（取 {{ topK }} 页）</span>
              <span v-if="toolsOn.web">· 网络搜索开</span>
              <span v-if="toolsOn.anytxt">· 本机文件开</span>
            </template>
          </AiChat>
        </div>
      </section>
    </div>
  </WikiShell>
</template>

<style scoped>
/* 只留知识库独有的版式。气泡 / 空态 / 输入框 / 工具链 / 推理的样式都在库组件里，
   本文件不再手画那些（规矩见 docs/ai-ui.md，由 npm run check:ai-ui 兜底）。 */
.ch__layout {
  display: grid;
  grid-template-columns: minmax(190px, 250px) minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}

@media (max-width: 980px) {
  .ch__layout {
    grid-template-columns: 1fr;
  }
}

/* 会话列表：矮屏上别把整页撑长 */
.ch__sesslist {
  max-height: 42vh;
  overflow: auto;
}
.ch__sess {
  position: relative;
  cursor: pointer;
}
.ch__del {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  border: none;
  background: transparent;
  color: var(--ws-text-3);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
}
.ch__del:hover {
  color: var(--ws-danger);
}

.ch__skills {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: flex-start;
}

.ch__main {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

/* 对话区要有确定高度，AiChat 的列表才能正确滚动（它内部是 flex + overflow） */
.ch__body {
  height: calc(100vh - 340px);
  height: calc(100dvh - 340px);
  min-height: 380px;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.ch__adv {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  align-items: center;
  padding: 10px 12px;
  border-radius: var(--ws-radius-sm);
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
}
.ch__adv-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--ws-fs-sm);
  color: var(--ws-text-2);
}
.ch__adv .wk-hint {
  flex: 1 1 100%;
  margin: 0;
}

.ch__bar-label {
  font-size: var(--ws-fs-sm);
  color: var(--ws-text-2);
}
.ch__model {
  width: 230px;
}
.ch__bar-route {
  font-size: var(--ws-fs-xs);
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ch__tag {
  padding: 1px 6px;
  border-radius: var(--ws-radius-sm);
  background: var(--ws-accent-soft);
  color: var(--ws-accent);
  font-size: var(--ws-fs-xs);
  font-weight: 600;
}

.ch__refs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: var(--ws-fs-xs);
  min-width: 0;
}
/* 依据胶囊里的标题可能很长（「第3章 第2题」这种一页标题就是一句话）。
   不放开的话一个胶囊就能把气泡顶出容器 —— 实测 390px 下气泡列表横向溢出 126px。 */
/* 长标题要能换行（否则顶破气泡），但也不能被压到 2 个字符宽 —— 实测「[3]」「概念」
   在 390px 下被挤成 14/22px 宽、竖排 2~3 行。给个下限，长标题照旧换行。 */
.ch__refs .wk-chip {
  max-width: 100%;
  min-width: 3.2em;
  white-space: normal;
  overflow-wrap: anywhere;
  text-align: left;
}
.ch__refnum {
  font-style: normal;
  color: var(--ws-accent);
  font-weight: 600;
  margin-right: 3px;
  flex: none;
  white-space: nowrap;
}
.ch__kind {
  margin-right: 4px;
  color: var(--ws-text-3);
}

.ch__acts {
  display: flex;
  gap: 12px;
  font-size: var(--ws-fs-xs);
}
.ch__acts :deep(a) {
  cursor: pointer;
}
.ch__acts :deep(a.is-off) {
  opacity: 0.45;
  pointer-events: none;
}
</style>
