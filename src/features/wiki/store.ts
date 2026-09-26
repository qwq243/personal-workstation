/**
 * 知识库的共享状态（跨子页复用）。
 *
 * 为什么不用 pinia：这层状态是「当前库 + 页面清单 + 统计」，跟着页面走，
 * 没有跨模块共享的需求，也没有 devtools/持久化的需求。用模块级 ref 做单例，
 * 子页之间切换时不必重新拉一遍（边车那边本来也有 5 秒缓存）。
 * 任何写操作之后都调 refresh()，保证列表与统计不过期。
 */
import { computed, ref } from 'vue'
import { api } from '@/core/sidecar'

export const status = ref<any>(null)
export const pages = ref<any[]>([])
export const projects = ref<any>(null)
export const embedStatus = ref<any>(null)
export const queue = ref<any>(null)
export const loading = ref(false)
export const error = ref('')

export const TYPE_META: { id: string; label: string; hint: string; color: string }[] = [
  { id: 'concept', label: '概念', hint: '想法、方法、现象、框架', color: '#4f46e5' },
  { id: 'entity', label: '实体', hint: '人、机构、作品、工具、数据集', color: '#16a34a' },
  { id: 'source', label: '来源', hint: '文章、论文、书、演讲', color: '#0ea5e9' },
  { id: 'query', label: '问题', hint: '正在追的开放问题', color: '#d97706' },
  { id: 'comparison', label: '比较', hint: '并排对照', color: '#7c3aed' },
  { id: 'synthesis', label: '综述', hint: '跨页结论', color: '#be185d' },
]

export function typeLabel(t: string) {
  return TYPE_META.find((x) => x.id === t)?.label ?? (t === 'overview' ? '总览' : t === 'meta' ? '索引' : t === 'raw' ? '原始资料' : t)
}

export function typeColor(t: string) {
  return TYPE_META.find((x) => x.id === t)?.color ?? 'var(--ws-text-3)'
}

/** 有内容的页面（排除 index/log 两个结构文件） */
export const contentPages = computed(() => pages.value.filter((p) => p.type !== 'meta'))

export const counts = computed(() => {
  const by = status.value?.pages?.byType ?? {}
  return TYPE_META.map((t) => ({ ...t, n: by[t.id] ?? 0 }))
})

/** 还没编译的料：raw/sources 里没有被任何 source 页认领的 */
export const pendingRaw = computed(() => {
  const claimed = new Set(pages.value.map((p: any) => p.sourceFile).filter(Boolean))
  return (status.value?.rawFiles ?? []).filter((r: any) => !claimed.has(r.path))
})

/** 拉全量：统计 + 页面 + 库列表 + 向量索引状态。写操作之后调它（或 refresh） */
export async function refresh() {
  loading.value = true
  const [st, pg, em] = await Promise.all([api.wikiStatus(), api.wikiPages(), api.wikiEmbed()])
  loading.value = false
  if (!st.ok) {
    error.value = st.error ?? '读不到知识库状态'
    status.value = null
    return false
  }
  error.value = ''
  status.value = st.data
  pages.value = pg.data?.pages ?? []
  embedStatus.value = em.data ?? null
  return true
}

/** 库列表单独拉：切库、登记、初始化之后用 */
export async function loadProjects() {
  const pr = await api.wikiProjects()
  if (pr.ok) projects.value = pr.data ?? null
  return projects.value
}

/** 只刷队列（入库页轮询用，别每次都拉全量） */
export async function refreshQueue() {
  const r = await api.wikiQueue(60)
  queue.value = r.ok ? r.data : null
  return queue.value
}

export function findPage(slug: string) {
  const s = String(slug ?? '').toLowerCase()
  return pages.value.find((p: any) => p.slug.toLowerCase() === s) ?? pages.value.find((p: any) => String(p.title).toLowerCase() === s) ?? null
}
