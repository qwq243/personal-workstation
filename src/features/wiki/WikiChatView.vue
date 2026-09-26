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
 * 观感与每日看板 · AI 助手对齐：卡高按视口算、用户气泡是主色实底、等输出时有跳动点、
 * 空态给一句说明 + 几个可点的例子。控件收进卡内工具条，页头只留「新会话 / 刷新」。
 */
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api, wikiChatStream, type WikiChatEvent } from '@/core/sidecar'
import { refresh, typeLabel } from './store'
import WikiShell from './WikiShell.vue'
import WikiMarkdown from './WikiMarkdown.vue'

type Msg = {
  role: 'user' | 'assistant'
  content: string
  model?: string
  references?: { path: string; title: string; type?: string; kind?: string; snippet?: string }[]
  tools?: { name: string; detail: string }[]
  reasoning?: string
  streaming?: boolean
  elapsedMs?: number
  partial?: boolean
  error?: boolean
}

const router = useRouter()
const sessions = ref<any[]>([])
const currentId = ref('')
const messages = ref<Msg[]>([])
const question = ref('')
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

/* ------------------------------------------------------------- 模型 --- */
const models = ref<string[]>([])
/** 这一档 chat 路由的默认模型（选「默认」时用的就是它） */
const defaultModel = ref('')
/** 路由名（跟随工作台 / 别的预设…），显示在提示里 —— 模型名必须与它匹配 */
const modelRoute = ref('')
/** '' = 不覆盖，用任务路由里 chat 预设的模型 */
const model = ref('')

/**
 * 模型清单取自**这一档 chat 路由**（不是工作台 provider）。
 * 路由指到另一家预设时，选项必须是那家认的名字；拿「跟随工作台」那家的模型名去问它只会 404。
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

/** 空态建议词只在空会话里出现，点一下就直接问出去 */
function ask(text: string) {
  question.value = text
  void send()
}

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
  const d = r.data?.defaultSource
  toolsOn.value = { web: d === 'web' || d === 'all', anytxt: d === 'anytxt' || d === 'all' }
}
const scroller = ref<HTMLElement | null>(null)
const openReasoning = ref<number | null>(null)
let abort: AbortController | null = null

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
  messages.value = (r.data.session.messages ?? []).map((m: any) => ({
    role: m.role,
    content: m.content,
    references: m.references,
    model: m.model,
    partial: m.partial,
  }))
  await scrollDown()
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

async function scrollDown() {
  await nextTick()
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
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

/** 把一次流式问答渲染进 messages[idx]（send 与 retry 共用同一套事件处理） */
async function streamInto(idx: number, body: Record<string, unknown>) {
  streaming.value = true
  abort = new AbortController()
  await wikiChatStream(
    body as any,
    (e: WikiChatEvent) => {
      const m = messages.value[idx]
      if (!m) return
      if (e.type === 'delta') {
        m.content += e.text ?? ''
        void scrollDown()
      } else if (e.type === 'reasoning') {
        m.reasoning = (m.reasoning ?? '') + (e.text ?? '')
      } else if (e.type === 'tool') {
        m.tools = [...(m.tools ?? []), { name: e.name ?? '', detail: e.detail ?? '' }]
      } else if (e.type === 'done') {
        m.references = e.references ?? []
        m.elapsedMs = e.elapsedMs
        m.partial = e.partial
        if (e.sessionId && !currentId.value) currentId.value = e.sessionId
      } else if (e.type === 'error') {
        /* 浏览器的那句 'network error' = 流被掐断了（边车被重启、网络断了），
           跟「模型不会答」是两回事；服务端给了 detail（上游报错原文）就一并摊出来，
           不然页面上只剩一句没法排查的英文。 */
        const raw = e.error ?? '问答失败'
        const friendly = /network error|fetch failed|Failed to fetch/i.test(raw)
          ? '连接中断（边车可能被重启了，重发一次通常就好）'
          : raw
        m.content = m.content || `出错了：${friendly}${e.detail ? `\n\n\`\`\`\n${String(e.detail).slice(0, 300)}\n\`\`\`` : ''}`
        m.error = true
        ElMessage.error(friendly)
      } else if (e.type === 'end') {
        m.streaming = false
      }
    },
    abort.signal,
  )
  streaming.value = false
  if (messages.value[idx]) messages.value[idx].streaming = false
  abort = null
  await loadSessions()
}

async function send() {
  const text = question.value.trim()
  if (!text || streaming.value) return
  question.value = ''
  messages.value.push({ role: 'user', content: text })
  messages.value.push({ role: 'assistant', content: '', tools: [], reasoning: '', streaming: true, model: modelLabel.value })
  const idx = messages.value.length - 1
  await scrollDown()
  await streamInto(idx, chatBody({ message: text }))
}

/**
 * 重试某条回答：本地把这条清空重新流式填，服务端用 `regen` 把会话里那条旧回复**替换掉**
 * （不新增一轮，所以刷新后不会出现「同一问两份答案」）。
 * 顺带一个用法：先在工具条换个模型再点重试 = 拿同一个问题换模型问一遍。
 */
async function retry(i: number) {
  const m = messages.value[i]
  if (streaming.value || !m || m.role !== 'assistant') return
  m.content = ''
  m.reasoning = ''
  m.tools = []
  m.references = []
  m.elapsedMs = undefined
  m.partial = undefined
  m.error = false
  m.streaming = true
  m.model = modelLabel.value
  await scrollDown()
  await streamInto(i, chatBody({ regen: true }))
}

/** 复制一条回答的 markdown 原文 */
async function copyMsg(m: Msg) {
  const text = m.content ?? ''
  if (!text.trim()) return ElMessage.warning('这条没有正文可复制')
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success('已复制回答（markdown 原文）')
  } catch {
    // 剪贴板 API 不可用（非安全上下文/权限被拒）时的兜底
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
    ElMessage.success('已复制回答')
  }
}

function stop() {
  abort?.abort()
  streaming.value = false
}
function goPage(path: string) {
  if (path) router.push(`/wiki/browse?path=${encodeURIComponent(path)}`)
}
/** 点正文里的 [N] 上标 = 点下方第 N 条依据（外部链接开新页，库内页跳浏览器） */
function goCite(m: Msg, index: number) {
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
</script>

<template>
  <WikiShell title="问答" subtitle="只依据库内页面回答、末尾标依据；检索轮次也会显示出来，方便核对它翻了哪几页" icon="ChatDotRound">
    <div v-if="showAdv" class="wk-card ch__adv">
      <span class="ch__adv-item">检索条数 <el-input-number v-model="topK" :min="2" :max="20" size="small" controls-position="right" /></span>
      <span class="ch__adv-item">
        检索模式
        <el-select v-model="retMode" size="small" style="width: 128px">
          <el-option label="词法+语义" value="auto" />
          <el-option label="只词法" value="lexical" />
          <el-option label="只语义" value="semantic" />
        </el-select>
      </span>
      <span class="ch__adv-item">上下文预算 <el-input-number v-model="maxChars" :min="4000" :max="200000" :step="2000" size="small" controls-position="right" placeholder="24000" /></span>
      <span class="ch__adv-item">回答上限 <el-input-number v-model="chatMaxTokens" :min="200" :max="64000" :step="1000" size="small" controls-position="right" placeholder="16000" /></span>
      <p class="wk-hint">
        预算/上限留空 = 用边车配置（24000 字 / 16000 token）。<b>思考与正文共用「回答上限」</b> ——
        思考型模型会先把预算花在推演上，上限给小了会出现「只有思考、没有回答」。库内检索永远开；
        「网络 / 本机文件」要开了才有（网络在设置里配 provider，本机文件要装 AnyTXT）。
      </p>
      <p class="wk-hint" :class="embed && (!embed.enabled || embed.modelStale || embed.pending > 0) ? 'wk-hint--warn' : ''">{{ embedLine }}</p>
    </div>

    <div class="ch__layout">
      <aside class="wk-stack">
        <section class="wk-card wk-card--flush">
          <div class="wk-card__head">
            <h3 class="wk-card__title"><el-icon><ChatDotRound /></el-icon> 会话（{{ sessions.length }}）</h3>
            <el-button size="small" @click="newSession">
              <el-icon><Plus /></el-icon>&nbsp;新会话
            </el-button>
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
                <span class="wk-list__title">{{ s.title }}</span>
                <span class="wk-list__meta">{{ String(s.updatedAt).slice(5, 16).replace('T', ' ') }} · {{ s.messages }} 条</span>
              </span>
              <button class="ch__del" title="删除会话" @click.stop="removeSession(s.id)">×</button>
            </div>
            <div v-if="!sessions.length" class="wk-empty">还没有会话</div>
          </div>
        </section>
        <section v-if="skills.length" class="wk-card">
          <h3 class="wk-card__title" style="margin-bottom: 8px"><el-icon><MagicStick /></el-icon> 技能</h3>
          <el-checkbox-group v-model="pickedSkills" size="small" class="ch__skills">
            <el-checkbox v-for="k in skills" :key="k.id" :value="k.id" :title="k.preview">{{ k.name }}</el-checkbox>
          </el-checkbox-group>
          <p class="wk-hint">来自库内 .llm-wiki/skills/*.md，勾选后拼进系统提示。</p>
        </section>
      </aside>

      <section class="wk-card ch__main">
        <!-- 工具条：模型 + 检索开关。原先这些散在页头，一排复选框看着像工具栏；
             收进卡里跟「这次要问什么」放在一起，位置更贴上下文。 -->
        <div class="ch__bar">
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
          <span class="ch__bar-spacer" />
          <el-checkbox v-model="toolsOn.web" size="small">网络</el-checkbox>
          <el-checkbox v-model="toolsOn.anytxt" size="small">本机文件</el-checkbox>
          <el-checkbox v-model="deep" size="small">补检索</el-checkbox>
          <el-button size="small" @click="toggleAdv">检索设置</el-button>
        </div>

        <div ref="scroller" class="ch__scroll">
          <div v-if="!messages.length" class="ch__welcome">
            <div class="ch__welcome-title">问这份库里的事</div>
            <p class="ch__welcome-desc">
              它只依据库内页面回答，末尾标出依据；检索了几轮、翻了哪几页都会显示在上面。
              库里没有的就直说没有，不会拿常识补。
            </p>
            <div class="ch__chips">
              <button v-for="s in SUGGESTIONS" :key="s" class="ch__chip" @click="ask(s)">{{ s }}</button>
            </div>
          </div>

          <template v-for="(m, i) in messages" :key="i">
            <div v-if="m.role === 'user'" class="ch__msg ch__msg--user">
              <div class="ch__bubble">{{ m.content }}</div>
            </div>
            <div v-else class="ch__msg ch__msg--ai">
              <div class="ch__bubble" :class="{ 'is-error': m.error }">
                <div class="ch__meta">
                  <span class="ch__tag">AI</span>
                  <span class="ws-dim">{{ m.model || modelLabel }}</span>
                  <span v-if="!m.streaming && m.elapsedMs" class="ws-dim">· {{ (m.elapsedMs / 1000).toFixed(1) }}s</span>
                  <span v-if="m.partial" class="ws-dim">· 输出中断（已保留半截）</span>
                </div>
                <div v-if="m.tools?.length" class="ch__tools">
                  <span v-for="(t, j) in m.tools" :key="j" class="wk-chip is-static">{{ t.name }} · {{ t.detail }}</span>
                </div>
                <div v-if="m.reasoning" class="ch__reason">
                  <button class="ch__reason-toggle" @click="openReasoning = openReasoning === i ? null : i">
                    <el-icon><MagicStick /></el-icon>
                    思考过程（{{ m.reasoning.length }} 字）
                    {{ openReasoning === i ? '收起' : '展开' }}
                  </button>
                  <pre v-if="openReasoning === i" class="ch__reason-body">{{ m.reasoning }}</pre>
                </div>
                <WikiMarkdown
                  v-if="m.content"
                  :text="m.content"
                  :refs="m.references"
                  @wiki-link="goSlug"
                  @cite="(ci) => goCite(m, ci)"
                />
                <div v-if="m.streaming && !m.content" class="ch__dots"><span /><span /><span /></div>
                <span v-else-if="m.streaming" class="ch__caret">▌</span>
                <div v-if="m.references?.length" class="ch__refs">
                  <span class="ws-dim">依据</span>
                  <template v-for="(r, ri) in m.references" :key="r.path + (r.kind ?? '')">
                    <button v-if="r.kind === 'wiki' || !r.kind" class="wk-chip" @click="goPage(r.path)">
                      <em class="ch__refnum">[{{ ri + 1 }}]</em>{{ r.title }}<em v-if="r.type">{{ typeLabel(r.type) }}</em>
                    </button>
                    <a v-else class="wk-chip" :href="r.path" target="_blank" rel="noreferrer" :title="r.path">
                      <span class="ch__kind">{{ r.kind === 'anytxt' ? '本机' : '网络' }}</span>{{ r.title }}
                    </a>
                  </template>
                </div>
                <!-- 回答块的操作行：复制原文、重试（换模型再点重试 = 同一个问题换模型问一遍） -->
                <div v-if="!m.streaming" class="ch__acts">
                  <button class="ch__act" title="复制回答（markdown 原文）" @click="copyMsg(m)">
                    <el-icon><CopyDocument /></el-icon>&nbsp;复制
                  </button>
                  <button
                    class="ch__act"
                    :disabled="streaming"
                    title="用当前选中的模型把这个问题重跑一遍（这条回复被替换，不会多出一轮）"
                    @click="retry(i)"
                  >
                    <el-icon><RefreshRight /></el-icon>&nbsp;重试
                  </button>
                </div>
              </div>
            </div>
          </template>
        </div>

        <div class="ch__input">
          <el-input
            v-model="question"
            type="textarea"
            :rows="2"
            resize="none"
            placeholder="问这份库里的事…（Enter 发送，Shift+Enter 换行）"
            @keydown.enter.exact.prevent="send"
          />
          <el-button v-if="streaming" @click="stop">停止</el-button>
          <el-button v-else type="primary" :disabled="!question.trim()" @click="send">发送</el-button>
        </div>
        <div class="ch__foot ws-dim">
          <span>模型：{{ modelLabel }}</span>
          <span>· 库内检索：{{ retMode === 'auto' ? '词法+语义' : retMode === 'lexical' ? '只词法' : '只语义' }}（取 {{ topK }} 页）</span>
          <span v-if="toolsOn.web">· 网络搜索开</span>
          <span v-if="toolsOn.anytxt">· 本机文件开</span>
        </div>
      </section>
    </div>
  </WikiShell>
</template>

<style scoped>
.ch__layout {
  display: grid;
  grid-template-columns: minmax(190px, 250px) minmax(0, 1fr);
  gap: 18px;
  align-items: start;
}
@media (max-width: 980px) {
  .ch__layout {
    grid-template-columns: 1fr;
  }
}

.ch__adv {
  display: flex;
  gap: 16px;
  align-items: center;
  flex-wrap: wrap;
}
.ch__adv-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--ws-fs-sm);
  color: var(--ws-text-2);
}
.ch__adv .wk-hint {
  flex-basis: 100%;
}

/* ---------------------------------------------------------- 会话列表 --- */
.ch__sesslist {
  max-height: 42vh;
  overflow: auto;
  padding: 4px 12px 8px;
}
.ch__sess {
  position: relative;
  cursor: pointer;
  padding-right: 26px;
}
.ch__del {
  position: absolute;
  right: 2px;
  top: 50%;
  transform: translateY(-50%);
  border: none;
  background: none;
  color: var(--ws-text-3);
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
  padding: 2px 4px;
  border-radius: 4px;
}
.ch__del:hover {
  color: var(--ws-danger);
  background: var(--ws-danger-soft);
}
.ch__skills {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* ------------------------------------------------------------ 主区 --- */
/* 高度按视口算（与每日看板 · AI 助手同一套）：聊起来不跳、也不用给卡写死一个高度。
   上面多减一点是因为知识库这页还有库信息条与视图切换。 */
.ch__main {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 300px);
  min-height: 420px;
  padding: 0;
  overflow: hidden;
}
.ch__bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 16px;
  border-bottom: 1px solid var(--ws-border);
  background: var(--ws-panel-2);
}
.ch__bar-label {
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-3);
}
.ch__model {
  width: 230px;
}
/* 模型下拉旁边标出「这一档是谁」：模型名必须与路由匹配，写出来省得对不上时猜 */
.ch__bar-route {
  font-size: 11px;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ch__bar-spacer {
  flex: 1 1 auto;
}
.ch__scroll {
  flex: 1;
  overflow-y: auto;
  padding: 18px 20px;
}

/* ------------------------------------------------------------ 空态 --- */
.ch__welcome {
  max-width: 560px;
  margin: 36px auto;
  text-align: center;
}
.ch__welcome-title {
  font-size: 17px;
  font-weight: 650;
  color: var(--ws-text);
}
.ch__welcome-desc {
  margin-top: 8px;
  font-size: 13.2px;
  line-height: 1.8;
  color: var(--ws-text-2);
}
.ch__chips {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: center;
  margin-top: 18px;
}
.ch__chip {
  padding: 6px 13px;
  border-radius: var(--ws-radius-pill);
  border: 1px solid var(--ws-border-strong);
  background: var(--ws-panel);
  color: var(--ws-text-2);
  font: inherit;
  font-size: 12.8px;
  cursor: pointer;
  transition: color 0.14s ease, border-color 0.14s ease, background 0.14s ease;
}
.ch__chip:hover {
  border-color: var(--ws-accent);
  color: var(--ws-accent);
  background: var(--ws-accent-soft);
}

/* ------------------------------------------------------------ 消息 --- */
.ch__msg {
  display: flex;
  margin-bottom: 14px;
}
.ch__msg--user {
  justify-content: flex-end;
}
.ch__bubble {
  max-width: 84%;
  padding: 11px 14px;
  border-radius: var(--ws-radius);
  font-size: var(--ws-fs-sm);
  line-height: 1.8;
  word-break: break-word;
}
/* 用户：主色实底 + 白字（与看板 AI 助手一致）——一眼能分开谁说的 */
.ch__msg--user .ch__bubble {
  background: var(--ws-accent);
  color: var(--ws-on-accent);
  border-bottom-right-radius: 4px;
  white-space: pre-wrap;
}
.ch__msg--ai .ch__bubble {
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
  border-bottom-left-radius: 4px;
}
.ch__msg--ai .ch__bubble.is-error {
  background: var(--ws-danger-soft);
  border-color: var(--ws-danger);
  color: var(--ws-danger);
}
.ch__meta {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
  margin-bottom: 7px;
}
.ch__tag {
  font-size: 11px;
  font-weight: 650;
  line-height: 18px;
  padding: 0 7px;
  border-radius: var(--ws-radius-pill);
  color: var(--ws-accent);
  background: var(--ws-accent-soft);
}
.ch__tools {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.ch__reason {
  margin-bottom: 10px;
}
/* 折叠开关做成小胶囊：它是个次要动作，不该长得像正文链接 */
.ch__reason-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 9px;
  font: inherit;
  font-size: 11.5px;
  color: var(--ws-text-3);
  background: var(--ws-panel);
  border: 1px solid var(--ws-border);
  border-radius: var(--ws-radius-pill);
  cursor: pointer;
  transition: color 0.14s ease, border-color 0.14s ease;
}
.ch__reason-toggle:hover {
  color: var(--ws-accent);
  border-color: var(--ws-accent-ring);
}
.ch__reason-toggle .el-icon {
  font-size: 12px;
}
/* 思考正文：虚线框一块独立面板，给足高度（原先 170px 一行行挤着、还刚好截在句子中间）。
   等宽字 + 稍亮的颜色（text-2），是给人读的，不是给人看「这里有字」的。 */
.ch__reason-body {
  margin: 8px 0 0;
  padding: 10px 12px;
  max-height: 34vh;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--ws-mono);
  font-size: 11.5px;
  line-height: 1.75;
  color: var(--ws-text-2);
  background: var(--ws-panel);
  border: 1px dashed var(--ws-border-strong);
  border-radius: var(--ws-radius-sm);
}
.ch__caret {
  color: var(--ws-accent);
  animation: ch-blink 1s steps(2, start) infinite;
}
@keyframes ch-blink {
  to {
    visibility: hidden;
  }
}
/* 等第一个字的时候先跳三个点，别让气泡空着 */
.ch__dots {
  display: flex;
  gap: 4px;
  align-items: center;
  padding: 4px 0;
}
.ch__dots span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ws-text-3);
  animation: ch-bounce 1.2s infinite ease-in-out;
}
.ch__dots span:nth-child(2) {
  animation-delay: 0.18s;
}
.ch__dots span:nth-child(3) {
  animation-delay: 0.36s;
}
@keyframes ch-bounce {
  0%,
  60%,
  100% {
    opacity: 0.25;
  }
  30% {
    opacity: 1;
  }
}
.ch__refs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--ws-border);
}
.ch__refs em {
  font-style: normal;
  color: var(--ws-text-3);
  margin-left: 4px;
}
.ch__refs .ch__refnum {
  color: var(--ws-accent);
  font-weight: 600;
  margin-left: 0;
  margin-right: 4px;
}
/* 回答块底部的操作行：次要动作，平时低调、hover 才亮，别抢正文 */
.ch__acts {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--ws-border);
}
.ch__act {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  font: inherit;
  font-size: 11.5px;
  color: var(--ws-text-3);
  background: none;
  border: 1px solid transparent;
  border-radius: var(--ws-radius-pill);
  cursor: pointer;
  transition: color 0.14s ease, border-color 0.14s ease, background 0.14s ease;
}
.ch__act:hover:not(:disabled) {
  color: var(--ws-accent);
  border-color: var(--ws-accent-ring);
  background: var(--ws-panel);
}
.ch__act:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ch__act .el-icon {
  font-size: 12px;
}
.ch__kind {
  margin-right: 5px;
  color: var(--ws-info);
  font-size: 10px;
}

/* ------------------------------------------------------------ 输入 --- */
.ch__input {
  display: flex;
  gap: 10px;
  align-items: flex-end;
  padding: 12px 16px 8px;
  border-top: 1px solid var(--ws-border);
}
.ch__input :deep(.el-textarea) {
  flex: 1;
}
.ch__foot {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  padding: 0 16px 10px;
  font-size: 11.5px;
}
</style>
