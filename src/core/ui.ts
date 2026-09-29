/**
 * 界面偏好：主题、侧边栏状态、手机档判定。
 * 主题同时驱动 Element Plus 的暗色变量（html.dark）和本站自己的变量（html[data-theme]）。
 */
import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref, watch } from 'vue'
import { loadJSON, saveJSON } from '@/core/storage'
import { RECOMMENDED_PINS } from '@/core/leaf-pages'

/**
 * 主题模式。
 * `auto` 是**按时间**自动（默认）；`system` 是跟随操作系统的深浅色偏好。
 * 两者分开是因为它们回答的是不同的问题：「现在算不算晚上」vs「系统觉得该不该暗」。
 */
export type ThemeMode = 'auto' | 'light' | 'dark' | 'system'

/** 「按时间自动」的窗口。日期一律用 `HH:MM`（24 小时制），跨零点也支持 */
export interface AutoThemeWindow {
  /** 从这个点开始用暗色 */
  darkFrom: string
  /** 到这个点切回亮色 */
  darkTo: string
}

/** 默认 19:00 → 07:00（贴合作息，而不是跟系统的偏好） */
export const DEFAULT_THEME_WINDOW: AutoThemeWindow = { darkFrom: '19:00', darkTo: '07:00' }

/** `HH:MM` → 当天的分钟数。写坏了返回 null，调用方走兜底 */
function minutesOf(hhmm: string): number | null {
  const m = /^\s*(\d{1,2})\s*:\s*(\d{1,2})\s*$/.exec(String(hhmm ?? ''))
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return h * 60 + mi
}

/**
 * 此刻是否落在暗色窗口内。
 *
 * 跨零点要单独处理：`19:00 → 07:00` 不是一个 `[from, to)` 区间，
 * 而是 `[from, 24:00) ∪ [0, to)`。写成单个比较会让整夜都不生效 —— 这是这类功能最常见的错。
 * 窗口写坏了就当「不是暗色」，绝不把界面卡在暗色里出不来。
 */
export function inDarkWindow(w: AutoThemeWindow, now: Date = new Date()): boolean {
  const from = minutesOf(w?.darkFrom ?? '')
  const to = minutesOf(w?.darkTo ?? '')
  if (from === null || to === null) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  return from <= to ? cur >= from && cur < to : cur >= from || cur < to
}

/**
 * 手机档断点（px）。**必须与 AppShell.vue 里 `@media (max-width: 760px)` 一致** ——
 * CSS 那边负责样式，这边负责行为（抽屉开合、表格换卡片），两处不同步就会出现
 * 「样式已经是手机版、逻辑还当桌面」的错位。
 */
export const MOBILE_MAX = 760

const mql = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null
const mqMobile = typeof window !== 'undefined' ? window.matchMedia(`(max-width: ${MOBILE_MAX}px)`) : null

export const useUiStore = defineStore('ui', () => {
  /**
   * 默认 `auto` = **按时间**自动（19:00 转暗 / 07:00 转亮）。
   * 2026-09-27 从 `'light'` 改成 `'auto'`：用户要的是「到点自己变」，
   * 而不是每次开机先亮一下再自己去点那颗按钮。
   */
  const theme = ref<ThemeMode>(loadJSON<ThemeMode>('ui.theme', 'auto'))
  const sidebarCollapsed = ref<boolean>(loadJSON<boolean>('ui.sidebarCollapsed', false))
  /**
   * 哪些功能的二级菜单是展开的（**默认全收**）。
   * 收起来是为了侧边栏短：语音随记 3 个二级页、娱乐 7 个，全摊开就看不到下面的大分组了。
   * 什么时候开由用户点左侧的小箭头决定，这里只记住他的选择。
   */
  const subnavOpen = ref<Record<string, boolean>>(loadJSON<Record<string, boolean>>('ui.subnavOpen', {}))
  /** 哪些大分组（办公 / 学习 / …）被收起来了；默认全展开，点分组名收 */
  const groupsClosed = ref<Record<string, boolean>>(loadJSON<Record<string, boolean>>('ui.groupsClosed', {}))
  /** 置顶那几项（服务与自启…）也能收 */
  const pinnedClosed = ref<boolean>(loadJSON<boolean>('ui.pinnedClosed', false))
  /**
   * 我的置顶：**叶子页面**的路由 path（侧边栏里没有展开箭头的那些行），按置顶顺序。
   *
   * 为什么只允许叶子（2026-09-28 用户定的规矩）：带子页面的那一行是「入口」，
   * 点它还要连带展开子页；把入口也置顶，顶部就会变成和下面分组一样的一堆父级，
   * 反而更难找。所以那种行**不给图钉**（判断在 `core/leaf-pages.ts`，别在这儿另写一套）。
   *
   * 从没点过置顶时给一份**推荐默认**（备考每天要开的那几页）；只要用户自己点过星标，
   * 就一律只认他存下来的那份 —— 默认值不会再回头覆盖他的选择。
   */
  const pinnedPages = ref<string[]>(loadJSON<string[]>('ui.pinnedPages', RECOMMENDED_PINS.slice()))
  const systemDark = ref<boolean>(mql?.matches ?? false)
  /** 手机档（≤760px）。48 个视图用它决定「表格 vs 卡片」这类结构分支，别各自 matchMedia */
  const isMobile = ref<boolean>(mqMobile?.matches ?? false)
  /**
   * 手机抽屉是否打开。**刻意不持久化** —— 每次进来都该是关的，
   * 否则下次打开页面先被一个盖住半屏的抽屉挡着，看着像坏了。
   */
  const navOpen = ref(false)

  function onSystemChange(e: MediaQueryListEvent) {
    systemDark.value = e.matches
  }
  if (mql) {
    mql.addEventListener('change', onSystemChange)
    onScopeDispose(() => mql.removeEventListener('change', onSystemChange))
  }

  /** 窗口跨过 760px 时同步；回到桌面档要顺手把抽屉关掉，不然它会留在 DOM 里挡着 */
  function onMobileChange(e: MediaQueryListEvent) {
    isMobile.value = e.matches
    if (!e.matches) navOpen.value = false
  }
  if (mqMobile) {
    mqMobile.addEventListener('change', onMobileChange)
    onScopeDispose(() => mqMobile.removeEventListener('change', onMobileChange))
  }

  /**
   * 「按时间自动」用的窗口（24 小时制 HH:MM）。
   * 默认 19:00 转暗、07:00 转亮 —— 与上课/自习的作息对上，而不是跟操作系统的偏好。
   * 支持跨零点（darkFrom > darkTo 时区间是「当天 from 起 + 次日 to 前」）。
   */
  const themeWindow = ref<AutoThemeWindow>(loadJSON<AutoThemeWindow>('ui.themeWindow', DEFAULT_THEME_WINDOW))
  /** 「此刻是否落在暗色窗口内」。每分钟对一次表，到点自动翻，不必刷新页面 */
  const timeDark = ref<boolean>(inDarkWindow(themeWindow.value))
  if (typeof window !== 'undefined') {
    const timer = window.setInterval(() => {
      timeDark.value = inDarkWindow(themeWindow.value)
    }, 60_000)
    onScopeDispose(() => window.clearInterval(timer))
  }
  watch(themeWindow, (w) => {
    saveJSON('ui.themeWindow', w)
    timeDark.value = inDarkWindow(w)
  })

  /**
   * 最终生效的主题。
   *
   * 四种模式的分工（2026-09-27 改）：
   *   light / dark —— 人工指定，一直用它
   *   auto         —— **按时间**（默认）。这是本次新加的：原来 auto 跟的是操作系统偏好，
   *                   而 `prefers-color-scheme` 在 Windows 上要用户自己去系统设置里配时段，
   *                   等于把「什么时候算晚上」外包给了系统
   *   system       —— 保留原来的行为（跟随操作系统），想用的人仍然能用
   */
  const resolvedTheme = computed<'light' | 'dark'>(() => {
    switch (theme.value) {
      case 'light':
        return 'light'
      case 'dark':
        return 'dark'
      case 'system':
        return systemDark.value ? 'dark' : 'light'
      default:
        return timeDark.value ? 'dark' : 'light'
    }
  })

  function applyTheme() {
    const root = document.documentElement
    root.dataset.theme = resolvedTheme.value
    root.classList.toggle('dark', resolvedTheme.value === 'dark')
  }

  watch(resolvedTheme, applyTheme, { immediate: true })
  watch(theme, (v) => saveJSON('ui.theme', v))
  watch(sidebarCollapsed, (v) => saveJSON('ui.sidebarCollapsed', v))
  watch(subnavOpen, (v) => saveJSON('ui.subnavOpen', v), { deep: true })
  watch(groupsClosed, (v) => saveJSON('ui.groupsClosed', v), { deep: true })
  watch(pinnedClosed, (v) => saveJSON('ui.pinnedClosed', v))
  watch(pinnedPages, (v) => saveJSON('ui.pinnedPages', v), { deep: true })
  function setTheme(v: ThemeMode) {
    theme.value = v
  }

  /** 改「按时间自动」的窗口。传一半也行（另一个保持原样） */
  function setThemeWindow(patch: Partial<AutoThemeWindow>) {
    themeWindow.value = { ...themeWindow.value, ...patch }
  }

  /** 把窗口恢复默认。设置页提供这个按钮，免得写坏了不知道怎么回 */
  function resetThemeWindow() {
    themeWindow.value = { ...DEFAULT_THEME_WINDOW }
  }

  function toggleSidebar() {
    sidebarCollapsed.value = !sidebarCollapsed.value
  }

  /**
   * 顶栏那颗按钮：手机档开合抽屉、桌面档收展侧栏。
   * 判断留给 AppShell（它知道 isMobile），这里两个动作都提供。
   */
  function toggleNav() {
    navOpen.value = !navOpen.value
  }

  function closeNav() {
    navOpen.value = false
  }

  function isSubnavOpen(id: string) {
    return subnavOpen.value[id] === true
  }

  function isGroupClosed(id: string) {
    return groupsClosed.value[id] === true
  }

  function toggleGroup(id: string) {
    groupsClosed.value = { ...groupsClosed.value, [id]: !isGroupClosed(id) }
  }

  function togglePinned() {
    pinnedClosed.value = !pinnedClosed.value
  }

  /** 这个叶子页面置顶了吗 */
  function isPagePinned(path: string) {
    return pinnedPages.value.includes(path)
  }

  /** 左侧菜单里点那颗图钉：置顶 / 取消置顶（保持置顶顺序 = 先后点进来的顺序） */
  function togglePagePin(path: string) {
    const i = pinnedPages.value.indexOf(path)
    if (i >= 0) pinnedPages.value.splice(i, 1)
    else pinnedPages.value.push(path)
  }

  /** 设置页用：把置顶换成推荐的那几页 */
  function applyRecommendedPins() {
    pinnedPages.value = RECOMMENDED_PINS.slice()
  }

  /** 设置页用：清空置顶（侧边栏那块「置顶」会整块收起来） */
  function clearPins() {
    pinnedPages.value = []
  }

  function toggleSubnav(id: string) {
    subnavOpen.value = { ...subnavOpen.value, [id]: !isSubnavOpen(id) }
  }

  /** 点功能行时用：展开（不切换），别把它已经收起来的又翻回去 */
  function openSubnav(id: string) {
    if (isSubnavOpen(id)) return
    subnavOpen.value = { ...subnavOpen.value, [id]: true }
  }

  return {
    theme,
    resolvedTheme,
    /** 「此刻是否落在暗色窗口内」——设置页要显示「现在按时间算是暗的」 */
    timeDark,
    themeWindow,
    /** 系统偏好（`system` 模式用；设置页也显示出来） */
    systemDark,
    setTheme,
    setThemeWindow,
    resetThemeWindow,
    sidebarCollapsed,
    isMobile,
    navOpen,
    subnavOpen,
    groupsClosed,
    pinnedClosed,
    /** 置顶的叶子页面（path 列表，用户手动点进来的顺序）与读写它的几个方法 */
    pinnedPages,
    isPagePinned,
    togglePagePin,
    applyRecommendedPins,
    clearPins,
    toggleSidebar,
    toggleNav,
    closeNav,
    isSubnavOpen,
    toggleSubnav,
    openSubnav,
    isGroupClosed,
    toggleGroup,
    togglePinned,
    applyTheme,
  }
})
