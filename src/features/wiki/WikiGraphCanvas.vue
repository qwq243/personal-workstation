<script setup lang="ts">
/**
 * 双链图谱（手写力导布局，纯 SVG，无第三方依赖）。
 *
 * 图的画法：深色画布 + 按连接度定节点半径 + 二次曲线边 +
 * 类型配色（concept 蓝 / source 青 / entity 绿 / overview 黄 / meta 灰 / 缺页红虚线圈），
 * 标签只给「够格」的节点常显，其余悬停才出，满屏小字不糊成一团。
 *
 * 布局是**确定性**的（mulberry32 种子随机 + 固定迭代 300 轮、冷却降温），
 * 同一份数据每次画出来一样 —— 不会有 d3 那种每次刷新都换位置的抖动。
 */
import { computed, ref } from 'vue'

const props = defineProps<{
  nodes: { id: string; label: string; type: string; path?: string; missing?: boolean; links?: number }[]
  edges: { source: string; target: string; from?: string; to?: string; missing?: boolean }[]
  active?: string
}>()

const emit = defineEmits<{ (e: 'open', node: any): void }>()

/** 画布按节点数伸缩（viewBox 正方形，svg 本身跟随容器宽） */
const SIZE = computed(() => Math.min(1100, Math.max(700, 620 + (props.nodes?.length ?? 0) * 6)))

/** 类型配色（对照桌面端）：concept 蓝紫 / source 青 / entity 绿 / overview 黄 / meta 灰 */
const COLOR: Record<string, string> = {
  concept: '#5b5bd6',
  entity: '#3fb27f',
  source: '#29b6f6',
  overview: '#e6b450',
  synthesis: '#ab7bd8',
  query: '#d8a05e',
  comparison: '#d87a9e',
  meta: '#8a8f9e',
  other: '#8a8f9e',
  missing: '#e05563',
}

const TYPE_LABEL: Record<string, string> = {
  concept: '概念',
  entity: '实体',
  source: '来源',
  query: '问题',
  comparison: '比较',
  synthesis: '综述',
  overview: '总览',
  meta: '索引',
  other: '其它',
  missing: '缺页',
}

/** 种子随机（确定性布局的关键：初始位置不随机，模拟结果才稳定） */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type P = { id: string; x: number; y: number; vx: number; vy: number; r: number; node: any }

/** 力导模拟：斥力（n²）+ 连线弹簧 + 向心重力，300 轮冷却。节点数上百时耗时也就几十 ms */
function simulate(nodes: any[], edges: any[], size: number) {
  const rand = mulberry32(20260926)
  const pts: P[] = nodes.map((n) => ({
    id: n.id,
    x: size / 2 + (rand() - 0.5) * size * 0.6,
    y: size / 2 + (rand() - 0.5) * size * 0.6,
    vx: 0,
    vy: 0,
    r: n.missing ? 5.5 : Math.max(6, Math.min(26, 6 + (n.links ?? 0) * 1.9)),
    node: n,
  }))
  const at = new Map(pts.map((p) => [p.id, p]))
  const links = edges
    .map((e) => ({ a: at.get(e.source), b: at.get(e.target) }))
    .filter((l): l is { a: P; b: P } => !!l.a && !!l.b)

  const REPULSE = 5200
  const SPRING = 0.012
  const REST = 150 // 弹簧自然长度：长一点中心才散得开，标签才有地方放
  const GRAVITY = 0.008

  for (let iter = 0; iter < 300; iter++) {
    const cool = 1 - iter / 300
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]
      for (let j = i + 1; j < pts.length; j++) {
        const q = pts[j]
        let dx = p.x - q.x
        let dy = p.y - q.y
        let d2 = dx * dx + dy * dy
        if (d2 < 1) {
          dx = (rand() - 0.5) * 2
          dy = (rand() - 0.5) * 2
          d2 = dx * dx + dy * dy + 0.01
        }
        const d = Math.sqrt(d2)
        const f = (REPULSE / d2) * cool
        const fx = (dx / d) * f
        const fy = (dy / d) * f
        p.vx += fx
        p.vy += fy
        q.vx -= fx
        q.vy -= fy
      }
      p.vx += (size / 2 - p.x) * GRAVITY * cool
      p.vy += (size / 2 - p.y) * GRAVITY * cool
    }
    for (const { a, b } of links) {
      const dx = b.x - a.x
      const dy = b.y - a.y
      const d = Math.max(1, Math.hypot(dx, dy))
      const f = (d - REST - a.r - b.r) * SPRING * cool
      const fx = (dx / d) * f
      const fy = (dy / d) * f
      a.vx += fx
      a.vy += fy
      b.vx -= fx
      b.vy -= fy
    }
    for (const p of pts) {
      const sp = Math.hypot(p.vx, p.vy)
      const cap = 14 * cool + 0.5
      if (sp > cap) {
        p.vx = (p.vx / sp) * cap
        p.vy = (p.vy / sp) * cap
      }
      p.x += p.vx
      p.y += p.vy
      p.vx *= 0.6
      p.vy *= 0.6
      // 软边界：别被斥力轰出画布
      const m = p.r + 16
      p.x = Math.max(m, Math.min(size - m, p.x))
      p.y = Math.max(m, Math.min(size - m, p.y))
    }
  }
  return { pts, at }
}

const layout = computed(() => {
  const size = SIZE.value
  const nodes = props.nodes ?? []
  if (!nodes.length) return { points: [] as P[], edges: [] as any[] }
  const { pts, at } = simulate(nodes, props.edges ?? [], size)
  const edges = (props.edges ?? [])
    .map((e) => {
      const a = at.get(e.source)
      const b = at.get(e.target)
      if (!a || !b) return null
      // 二次曲线：中点沿法线偏 1/8 边长，平行边不叠成一条线
      const mx = (a.x + b.x) / 2
      const my = (a.y + b.y) / 2
      const dx = b.x - a.x
      const dy = b.y - a.y
      const d = Math.max(1, Math.hypot(dx, dy))
      const k = d / 8
      const cx = mx - (dy / d) * k
      const cy = my + (dx / d) * k
      return { d: `M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x} ${b.y}`, missing: e.missing }
    })
    .filter(Boolean) as { d: string; missing?: boolean }[]
  return { points: pts, edges }
})

/* ---------------------------------------------------------- 悬停高亮 --- */

const hoverId = ref('')
const focusId = computed(() => hoverId.value || props.active || '')
const neighbors = computed(() => {
  const id = focusId.value
  const set = new Set<string>()
  if (!id) return set
  for (const e of props.edges ?? []) {
    if (e.source === id) set.add(e.target)
    if (e.target === id) set.add(e.source)
  }
  return set
})

/* ---------------------------------------------------------- 缩放平移 ---
 * viewBox 变换：初始看整张图（0 0 SIZE SIZE），滚轮以指针为中心缩放（0.3x–4x），
 * 左键拖拽平移，双击复位。节点点击用 click（不是 mousedown），所以拖节点不会误开页面。 */
const vb = ref({ x: 0, y: 0, w: 0 })
const viewBox = computed(() => {
  const w = vb.value.w || SIZE.value
  return `${vb.value.x} ${vb.value.y} ${w} ${w}`
})
/** 缩放后 stroke 跟着反比缩（不然放大后线粗得糊）；字号在**屏幕像素上恒定** —
 *  无论缩到几档标签都是 ~12px 屏幕字，不随图一起放大（Obsidian/桌面端就是这么排的），
 *  放大时只让「露出的标签数量」变多（见 hubIds），不让字变大。 */
const kScale = computed(() => (vb.value.w || SIZE.value) / SIZE.value)

function resetView() {
  vb.value = { x: 0, y: 0, w: SIZE.value }
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  const el = e.currentTarget as SVGSVGElement
  const rect = el.getBoundingClientRect()
  // 指针在 viewBox 坐标系里的位置（缩放围绕它，不会「缩着缩着跑了」）
  const w0 = vb.value.w || SIZE.value
  const mx = vb.value.x + ((e.clientX - rect.left) / rect.width) * w0
  const my = vb.value.y + ((e.clientY - rect.top) / rect.height) * w0
  const factor = e.deltaY > 0 ? 1.18 : 1 / 1.18
  const w1 = Math.min(SIZE.value * 4, Math.max(SIZE.value * 0.25, w0 * factor))
  vb.value = { x: mx - ((e.clientX - rect.left) / rect.width) * w1, y: my - ((e.clientY - rect.top) / rect.height) * w1, w: w1 }
}

let drag: { sx: number; sy: number; x: number; y: number } | null = null
function onDown(e: PointerEvent) {
  if (e.button !== 0) return
  const el = e.currentTarget as SVGSVGElement
  drag = { sx: e.clientX, sy: e.clientY, x: vb.value.x, y: vb.value.y }
  el.setPointerCapture?.(e.pointerId)
}
function onMove(e: PointerEvent) {
  if (!drag) return
  const el = e.currentTarget as SVGSVGElement
  const rect = el.getBoundingClientRect()
  const w = vb.value.w || SIZE.value
  const kx = w / rect.width
  const ky = w / rect.height
  vb.value = { ...vb.value, x: drag.x - (e.clientX - drag.sx) * kx, y: drag.y - (e.clientY - drag.sy) * ky }
}
function onUp() {
  drag = null
}

/** 标签常显：默认只给连接度前 8 的 hub（参考图就是只有几张来源页和总页有字）；
 *  放大后按 zoom 多露（放大 2 倍露 16、4 倍露 32）—— 字号不变，多露的才读得出。
 *  悬停/聚焦的节点永远出字。 */
const hubIds = computed(() => {
  const zoom = SIZE.value / (vb.value.w || SIZE.value) // >1 是放大
  const top = (props.nodes ?? [])
    .filter((n) => !n.missing)
    .slice()
    .sort((a, b) => (b.links ?? 0) - (a.links ?? 0))
    .slice(0, Math.min(props.nodes?.length ?? 0, Math.ceil(8 * zoom)))
  return new Set(top.map((n) => n.id))
})
function showLabel(p: P) {
  if (p.node.missing) return false
  return hubIds.value.has(p.id) || focusId.value === p.id || neighbors.value.has(p.id)
}
const dim = (id: string) => !!focusId.value && id !== focusId.value && !neighbors.value.has(id)
/** 长标签截断：来源页名动辄 20+ 字，全放出来相邻标签必叠 */
function shortLabel(s: string) {
  const t = String(s ?? '')
  return t.length > 14 ? `${t.slice(0, 13)}…` : t
}
</script>

<template>
  <div class="wgraph">
    <svg
      :viewBox="viewBox"
      class="wgraph__svg"
      :class="{ 'is-drag': !!drag }"
      role="img"
      aria-label="知识库双链图谱"
      @wheel="onWheel"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointerleave="onUp"
      @dblclick="resetView"
    >
      <path
        v-for="(e, i) in layout.edges"
        :key="`e${i}`"
        :d="e.d"
        class="wgraph__edge"
        :class="{ 'is-missing': e.missing }"
        :style="{ strokeWidth: 0.9 / kScale }"
      />
      <g
        v-for="p in layout.points"
        :key="p.node.id"
        class="wgraph__node"
        :class="{ 'is-dim': dim(p.node.id), 'is-missing': p.node.missing }"
        @click="emit('open', p.node)"
        @mousedown.stop
        @mouseenter="hoverId = p.node.id"
        @mouseleave="hoverId = ''"
      >
        <circle :cx="p.x" :cy="p.y" :r="p.r" :fill="COLOR[p.node.type] ?? COLOR.other" :style="{ strokeWidth: 1.4 / kScale }" />
        <text
          v-if="showLabel(p)"
          :x="p.x + p.r + 5"
          :y="p.y + 4"
          text-anchor="start"
          :style="{ fontSize: 12 * kScale, strokeWidth: 3 * kScale }"
        >{{ shortLabel(p.node.label) }}</text>
        <title>{{ p.node.label }} · {{ TYPE_LABEL[p.node.type] ?? p.node.type }} · {{ p.node.links ?? 0 }} 条链接</title>
      </g>
    </svg>
    <div class="wgraph__legend">
      <span v-for="t in ['concept', 'entity', 'source', 'overview', 'meta', 'missing']" :key="t" class="wgraph__lg">
        <i :style="{ background: COLOR[t] }" :class="{ 'is-hollow': t === 'missing' }" />{{ TYPE_LABEL[t] }}
      </span>
      <span class="wgraph__hint">滚轮缩放 · 拖拽平移 · 双击复位 · 点节点开页面</span>
    </div>
  </div>
</template>

<style scoped>
.wgraph {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.wgraph__svg {
  width: 100%;
  max-height: 68vh;
  /* 桌面端那张图是浅色描边深色纸：这里用工作站的深面板色，边和标签都提亮一档 */
  background: #171a22;
  border: 1px solid var(--ws-border);
  border-radius: var(--ws-radius);
  cursor: grab;
  touch-action: none;
}
.wgraph__svg.is-drag {
  cursor: grabbing;
}
.wgraph__edge {
  fill: none;
  stroke: #8b93a7;
  stroke-width: 0.9;
  opacity: 0.4;
}
.wgraph__edge.is-missing {
  stroke: #e05563;
  stroke-dasharray: 4 4;
  opacity: 0.5;
}
.wgraph__node {
  cursor: pointer;
}
.wgraph__node circle {
  stroke: rgba(255, 255, 255, 0.85);
  stroke-width: 1.4;
  transition: opacity 120ms ease-out;
}
.wgraph__node.is-missing circle {
  fill: none;
  stroke: #e05563;
  stroke-dasharray: 3 2.5;
}
.wgraph__node.is-dim {
  opacity: 0.16;
}
.wgraph__node text {
  font-size: 12px;
  fill: #dfe3ee;
  paint-order: stroke;
  stroke: #171a22;
  stroke-width: 3px;
  pointer-events: none;
}
.wgraph__node.is-dim text {
  display: none;
}
.wgraph__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-3);
}
.wgraph__lg {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.wgraph__lg i {
  width: 9px;
  height: 9px;
  border-radius: 50%;
}
.wgraph__lg i.is-hollow {
  background: transparent !important;
  border: 1px dashed #e05563;
}
.wgraph__hint {
  margin-left: auto;
}
</style>
