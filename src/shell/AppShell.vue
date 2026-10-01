<script setup lang="ts">
/**
 * 全局布局壳：左侧功能导航 + 顶部面包屑 / 主题切换 + 内容区。
 * 侧边栏完全由功能注册表派生 —— 新增功能无需改这里。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { getGroupedModules, getModules } from '@/core/registry'
import { leafMap, pinnedEntries, subRows, hasSubRows } from '@/core/leaf-pages'
import { useUiStore, type ThemeMode } from '@/core/ui'
import brandLogo from '@/assets/brand/ws-logo.webp'

const route = useRoute()
const router = useRouter()
const ui = useUiStore()

const modules = computed(() => getModules())
/** 按大模块分组（本机 / 日常 / 学习 / 智能体 / 工具）—— 见 core/types.ts 的 MODULE_GROUPS */
const groups = computed(() => getGroupedModules())

/** 当前激活的功能模块：按各模块路由做最长前缀匹配。
 *  不能只看路径第一段 —— 同一前缀下的几条路由可能分属不同模块（做题本与它的打印页
 *  就在一个大前缀下，知识库的会话页也不跟着首页走）。 */
const activeModuleId = computed(() => {
  const p = route.path
  let best = ''
  let bestLen = -1
  for (const m of modules.value) {
    for (const r of m.routes) {
      const rp = r.path as string
      if (typeof rp !== 'string') continue
      if ((p === rp || p.startsWith(rp + '/')) && rp.length > bestLen) {
        best = m.id
        bestLen = rp.length
      }
    }
  }
  if (best) return best
  return p.split('/').filter(Boolean)[0] ?? ''
})

/** 当前功能下的二级导航（来自该功能路由里带 meta.title 的项）。
 *  二级项**不取 meta.icon** —— 层级靠「缩进 + 导轨 + 小一号字」表达，
 *  一排图标反而会和一级项抢注意力（2026-09-20 用户确认）。
 *  判断与侧边栏行完全同源（`core/leaf-pages.ts` 的 `subRows`），图钉与置顶也读那一份。 */

/**
 * 点模块这一行：**跳进去 + 顺手展开它的子页面**。
 * 用户明确要求「点击也可以展开，不要非得点到那个箭头」——箭头只是给「只想展开不想跳」留的路。
 */
function openModule(mod: any) {
  if (hasSubRows(mod)) ui.openSubnav(mod.id)
  go(mod.homePath)
}

/* --------------------------------------------------- 置顶（只有叶子页面） --- */

/**
 * 「置顶」里**只放用户手动点图钉的页面**（顺序 = 点进来的顺序）。
 *
 * 以前那套「没分类的功能自动进置顶」已经取消 —— 本机那几个工具归到 `local`（本机）
 * 分组，置顶留给手动挑选。带子页面的入口行不给图钉，
 * 理由见 `core/leaf-pages.ts`。
 */
const myPinned = computed(() => pinnedEntries(ui.pinnedPages))
const leafPaths = computed(() => new Set(leafMap().keys()))

/** 这一页是不是叶子（决定给不给那颗图钉） */
function isLeaf(path: string) {
  return leafPaths.value.has(path)
}

const currentModule = computed(() => modules.value.find((m) => m.id === activeModuleId.value))

function go(path: string) {
  if (route.path !== path) router.push(path)
}

/** 以大写字母开头视为 Element Plus 图标组件名，其余（如 emoji）按纯文本渲染 */
function isComponentIcon(icon: string): boolean {
  return /^[A-Z]/.test(icon)
}

/**
 * 主题菜单的按钮提示。把「哪种模式 + 现在实际是亮是暗」都说清楚 ——
 * 盲切那颗按钮的毛病之一就是说不清这两件事。
 */
const themeMenuLabel = computed(() => {
  const now = ui.resolvedTheme === 'dark' ? '暗色' : '亮色'
  const mode =
    ui.theme === 'auto'
      ? `按时间自动（${ui.themeWindow.darkFrom}–${ui.themeWindow.darkTo}）`
      : ui.theme === 'system'
        ? '跟随系统'
        : ui.theme === 'dark'
          ? '暗色'
          : '亮色'
  return `主题：${mode} · 当前${now}`
})

/* --------------------------------------------------------- 全屏（平板用） ---
 * 主要给平板浏览器（iPad Safari 这类壳）看板用的：整页进全屏后浏览器的地址栏、
 * 标签栏都收掉，面板就是一整块屏。点击进、再点退，Esc 退出时状态也要跟上来。
 *
 * 兼容性按运行时探测来，不按设备猜：Safari 系（含 iOS 各壳）的全屏 API 有 webkit 前缀
 * 的一代，标准 API 又只在较新的内核才有 —— 两个都没有的（老 iPhone 上的 WKWebView
 * 这类）按钮直接不渲染，不留一颗点了没反应的死按钮。进了全屏必须由用户手势触发，
 * 这里本来就挂在点击上；被内核拒绝（极少见）就出一句提示。
 */
const fsActive = ref(false)
const fsSupported = (() => {
  if (typeof document === 'undefined') return false
  const el = document.documentElement as any
  return typeof el.requestFullscreen === 'function' || typeof el.webkitRequestFullscreen === 'function'
})()

function fsElement(): Element | null {
  return document.fullscreenElement ?? (document as any).webkitFullscreenElement ?? null
}
function syncFs() {
  fsActive.value = !!fsElement()
}
function toggleFullscreen() {
  const el = document.documentElement as any
  if (fsElement()) {
    ;(document.exitFullscreen ?? (document as any).webkitExitFullscreen)?.call(document)
    return
  }
  const req = el.requestFullscreen ?? el.webkitRequestFullscreen
  try {
    const p = req?.call(el)
    if (p && typeof p.catch === 'function') p.catch(() => ElMessage.warning('这个浏览器不允许网页进入全屏'))
  } catch {
    ElMessage.warning('这个浏览器不允许网页进入全屏')
  }
}
if (fsSupported) {
  onMounted(() => {
    document.addEventListener('fullscreenchange', syncFs)
    document.addEventListener('webkitfullscreenchange', syncFs)
  })
  onUnmounted(() => {
    document.removeEventListener('fullscreenchange', syncFs)
    document.removeEventListener('webkitfullscreenchange', syncFs)
  })
}

/* ------------------------------------------------- 手机档：抽屉式导航 --- */

/**
 * 侧栏是否处于「只剩图标」的收起形态。
 *
 * **不能直接用 `ui.sidebarCollapsed`** —— 那个值会持久化到 localStorage：在桌面收过侧栏，
 * 到手机上侧栏也会只剩图标，而手机档的侧栏是抽屉、抽屉里**必须**有文字和二级三级项
 * （手机上本来就没有别的地方能进「语音随记」这种带好几个子页的功能）。
 * 所以手机档一律按展开形态渲染，桌面的收起偏好仍然照旧生效。
 */
const railCollapsed = computed(() => ui.sidebarCollapsed && !ui.isMobile)

/** 顶栏那颗按钮：手机档开合抽屉，桌面档收展侧栏 —— 两种形态共用同一颗 */
function onMenuClick() {
  if (ui.isMobile) ui.toggleNav()
  else ui.toggleSidebar()
}

/** 按钮的提示语与 aria 也要跟着形态变，否则手机上会念「收起侧栏」 */
const menuLabel = computed(() => {
  if (ui.isMobile) return ui.navOpen ? '收起菜单' : '打开菜单'
  return ui.sidebarCollapsed ? '展开侧栏' : '收起侧栏'
})

// 抽屉里选了东西就走，不关的话内容一直被盖着
watch(() => route.path, () => ui.closeNav())

// 抽屉开着时 Esc 关掉（键盘设备用；手机靠遮罩）。
// 与项目里「回车只在 window 上处理」同一条规矩：键盘事件挂在 window，不散在元素上。
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && ui.navOpen) ui.closeNav()
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="shell" :class="{ 'shell--collapsed': railCollapsed, 'shell--nav-open': ui.navOpen }">
    <!-- ---------------------------------------------------------- 侧边栏 -->
    <aside class="sidebar">
      <div class="brand" @click="go('/dashboard')">
        <img class="brand__logo" :src="brandLogo" alt="工作站" draggable="false" />
        <div v-show="!railCollapsed" class="brand__text">
          <div class="brand__name">工作站</div>
          <div class="brand__sub">Workstation</div>
        </div>
      </div>

      <nav class="nav">
        <!-- 置顶：用户点星标选出来的页面（没点过星标时是推荐默认那几页，见 core/leaf-pages.ts）。
             一页都没有时整块隐藏；下面的大分组照旧 -->
        <div
          v-if="!railCollapsed && myPinned.length"
          class="nav__group nav__group--btn"
          :style="{ '--nav-group-color': 'var(--ws-accent)' }"
          @click="ui.togglePinned()"
        >
          <el-icon class="nav__group-icon nav__group-icon--own"><Star /></el-icon>
          <span class="nav__group-name">置顶</span>
          <!-- 一级箭头：实心三角（分组/区块的收展）；二级那个是细箭头，形状与颜色都不一样 -->
          <el-icon class="nav__caret nav__caret--group"><CaretBottom v-if="!ui.pinnedClosed" /><CaretRight v-else /></el-icon>
        </div>
        <div
          v-for="e in ui.pinnedClosed ? [] : myPinned"
          :key="'pin-' + e.path"
          class="nav__item"
          :class="{ 'is-active': route.path === e.path }"
          @click="go(e.path)"
        >
          <el-icon v-if="isComponentIcon(e.icon)" class="nav__icon"><component :is="e.icon" /></el-icon>
          <span v-else class="nav__icon">{{ e.icon }}</span>
          <span v-show="!railCollapsed" class="nav__text">{{ e.title }}</span>
          <button
            v-if="!railCollapsed"
            class="nav__pin is-on"
            title="取消置顶"
            @click.stop="ui.togglePagePin(e.path)"
          >
            <el-icon><StarFilled /></el-icon>
          </button>
        </div>

        <!-- 置顶块与下面第一组之间补一道线（第一组不会自己画）—— 置顶页与分组页是两码事 -->
        <div v-if="myPinned.length" class="nav__divider" />

        <!-- 大模块：本机 / 日常 / 学习 / 智能体 / 工具 -->
        <template v-for="(g, gi) in groups" :key="g.group.id">
          <!-- 归组边界（同属 vs 非同属）：**组与组之间才画线**，同一组里的几行之间没有线。
               收起侧栏时也按这条规则（第一组上面不画，上面本来没东西）。 -->
          <div v-if="gi > 0" class="nav__divider" />

          <!-- 只有一个功能的分组不再套两层（否则分组名会在功能行旁边重复一遍、图标也重一遍）：
               直接把它当一级项显示，名字与图标都用功能自己的 —— 那些分组的图标就靠
               下面那个 `v-if="isComponentIcon(mod.icon)"` 出，别再加「空位」分支
               （2026-09-27 修：留空位会让收起侧栏时那一行变成点不到的空行）。
               没有组名就靠上面那道分隔线说清「这是另一块」—— 否则单模块组那一行会看着像
               上一组的最后一行（单模块组挨着上一组的最后一行时一眼就看出来了）。 -->
          <div
            v-if="!railCollapsed && g.modules.length > 1"
            class="nav__group nav__group--btn"
            :style="{ '--nav-group-color': `var(--ws-group-${g.group.id})` }"
            @click="ui.toggleGroup(g.group.id)"
          >
            <el-icon class="nav__group-icon nav__group-icon--own"><component :is="g.group.icon" /></el-icon>
            <span class="nav__group-name">{{ g.group.name }}</span>
            <!-- 一级箭头＝实心三角＋分组自己的颜色；二级（功能行）是细箭头＋中性灰。
                 形状、颜色、大小三样都不同，扫一眼就知道这个三角管的是整组、那个细箭头管的是
                 这一行下面的子页。 -->
            <el-icon class="nav__caret nav__caret--group">
              <CaretBottom v-if="!ui.isGroupClosed(g.group.id)" /><CaretRight v-else />
            </el-icon>
          </div>

          <template v-for="mod in (g.modules.length > 1 && ui.isGroupClosed(g.group.id) ? [] : g.modules)" :key="mod.id">
            <div
              class="nav__item"
              :class="{ 'is-active': activeModuleId === mod.id, 'is-expanded': !railCollapsed && ui.isSubnavOpen(mod.id) }"
              :style="{ '--nav-group-color': `var(--ws-group-${g.group.id})` }"
              @click="openModule(mod)"
            >
              <!-- 图标规矩：一级、二级一律带自己的图标；三级（子页面 `.nav__sub`）没有。
                   分组标题只在「一组多个功能」时出现，所以它的图标不会与功能图标重复。 -->
              <el-icon v-if="isComponentIcon(mod.icon)" class="nav__icon">
                <component :is="mod.icon" />
              </el-icon>
              <span v-else class="nav__icon">{{ mod.icon }}</span>
              <span v-show="!railCollapsed" class="nav__text">{{ mod.name }}</span>
              <!-- 二级菜单开关：默认收起，点它才展开（状态记在 localStorage） -->
              <button
                v-if="!railCollapsed && hasSubRows(mod)"
                class="nav__caret"
                :class="{ 'is-open': ui.isSubnavOpen(mod.id), 'is-hint': activeModuleId === mod.id && !ui.isSubnavOpen(mod.id) }"
                :title="ui.isSubnavOpen(mod.id) ? '收起子页面' : '展开子页面'"
                @click.stop="ui.toggleSubnav(mod.id)"
              >
                <el-icon><ArrowDown v-if="ui.isSubnavOpen(mod.id)" /><ArrowRight v-else /></el-icon>
              </button>
              <span
                v-else-if="!railCollapsed && mod.badge && mod.badge()"
                class="nav__badge"
                >{{ mod.badge() }}</span
              >
              <!-- 图钉：**没有展开箭头的行才给**（带子页面的那一行是入口，点它还要连带展开）。
                   判断只看「这一行有没有子页面」，不按路由 path 的前缀 —— 前者翻过两次车，
                   见 core/leaf-pages.ts 开头的注释。 -->
              <button
                v-if="!railCollapsed && !hasSubRows(mod)"
                class="nav__pin"
                :class="{ 'is-on': ui.isPagePinned(mod.homePath) }"
                :title="ui.isPagePinned(mod.homePath) ? '取消置顶' : '置顶这一页'"
                @click.stop="ui.togglePagePin(mod.homePath)"
              >
                <el-icon><StarFilled v-if="ui.isPagePinned(mod.homePath)" /><Star v-else /></el-icon>
              </button>
            </div>

            <!-- 二级导航：点开箭头才显示 -->
            <template v-if="!railCollapsed && ui.isSubnavOpen(mod.id)">
              <div
                v-for="(sub, si) in subRows(mod)"
                :key="sub.path"
                class="nav__sub"
                :class="{ 'is-active': route.path === sub.path, 'is-first': si === 0 }"
                :style="{ '--nav-group-color': `var(--ws-group-${g.group.id})` }"
                @click="go(sub.path)"
              >
                <span>{{ sub.title }}</span>
                <!-- 二级页基本就是叶子，最下面那一层；图钉给能做叶子判断的那些 -->
                <button
                  v-if="isLeaf(sub.path)"
                  class="nav__pin"
                  :class="{ 'is-on': ui.isPagePinned(sub.path) }"
                  :title="ui.isPagePinned(sub.path) ? '取消置顶' : '置顶这一页'"
                  @click.stop="ui.togglePagePin(sub.path)"
                >
                  <el-icon><StarFilled v-if="ui.isPagePinned(sub.path)" /><Star v-else /></el-icon>
                </button>
              </div>
            </template>
          </template>
        </template>
      </nav>

      <div class="sidebar__foot">
        <div
          class="nav__item nav__item--minor"
          :class="{ 'is-active': route.path === '/apps' }"
          @click="go('/apps')"
        >
          <el-icon class="nav__icon"><List /></el-icon>
          <span v-show="!railCollapsed">全部应用</span>
        </div>
        <div
          class="nav__item nav__item--minor"
          :class="{ 'is-active': route.path === '/dev-guide' }"
          @click="go('/dev-guide')"
        >
          <el-icon class="nav__icon"><MagicStick /></el-icon>
          <span v-show="!railCollapsed">扩展开发</span>
        </div>
        <div
          class="nav__item nav__item--minor"
          :class="{ 'is-active': route.path === '/settings' }"
          @click="go('/settings')"
        >
          <el-icon class="nav__icon"><Setting /></el-icon>
          <span v-show="!railCollapsed">设置与数据</span>
        </div>
      </div>
    </aside>

    <!-- 手机抽屉的遮罩：点它关闭。桌面档不渲染（用 v-if 而不是 CSS 隐藏，少一个常驻节点） -->
    <div v-if="ui.isMobile" class="nav-mask" @click="ui.closeNav()" />

    <!-- ----------------------------------------------------------- 主区域 -->
    <div class="main">
      <header class="topbar">
        <el-tooltip :content="menuLabel" placement="bottom">
          <button
            class="icon-btn"
            type="button"
            :aria-label="menuLabel"
            :aria-expanded="ui.isMobile ? ui.navOpen : !railCollapsed"
            @click="onMenuClick()"
          >
            <!-- 手机档一律用汉堡：抽屉是盖在内容之上的，Fold/Expand 那套「收展」语义不适用 -->
            <el-icon v-if="ui.isMobile"><Menu /></el-icon>
            <el-icon v-else><Fold v-if="!railCollapsed" /><Expand v-else /></el-icon>
          </button>
        </el-tooltip>

        <div class="crumbs">
          <span class="crumbs__root" @click="go('/')">工作站</span>
          <template v-if="currentModule">
            <span class="crumbs__sep">/</span>
            <span class="crumbs__mod" @click="go(currentModule.homePath)">{{
              currentModule.name
            }}</span>
          </template>
          <template v-if="route.meta.title && route.path !== '/'">
            <span class="crumbs__sep">/</span>
            <span class="crumbs__cur">{{ route.meta.title }}</span>
          </template>
        </div>

        <div class="ws-spacer" />

        <!--
          主题选择。原来是一颗「亮↔暗」盲切按钮 —— 那样有两个毛病：
            1. 点过一次就**再也回不到自动**了（切换只会落在 light/dark 上，没有回去的路）；
            2. 看不出当前是哪种模式（按时间自动 / 跟随系统 / 人工指定，图标都一样）。
          改成菜单：四种模式都在，当前那个带勾；「按时间自动」是默认值。

          ⚠️ **触发元素外面不能再套 `el-tooltip`。** 套了会这样：点一下弹出的是 tooltip，
          菜单根本不打开 —— 因为 el-tooltip 默认 `trigger="hover"`，它的 popper 触发层
          把 mousedown/mouseup 吃掉了，dropdown 的点击永远收不到。
          这个坑 2026-09-27 用户报「切换亮暗的按钮没反应」时实测复现（桌面与手机都中），
          所以这里改用原生 `title`，不再用 el-tooltip。
          注意：`element.click()` 这种合成点击**测不出**这个 bug（它绕过鼠标事件），
          要验就用 `Input.dispatchMouseEvent` 真点 —— check-dark.cjs 里有一条这个断言。
        -->
        <!-- 全屏：主要给平板浏览器（iPad Safari 这类壳）看板用；进/退同一个按钮，
             Esc 或系统的「完成」退出时图标也跟着换（fullscreenchange 同步）。不支持全屏
             API 的内核不渲染这颗（别留点了没反应的死按钮）。 -->
        <button
          v-if="fsSupported"
          class="icon-btn"
          type="button"
          :aria-label="fsActive ? '退出全屏' : '全屏'"
          :title="fsActive ? '退出全屏' : '全屏'"
          @click="toggleFullscreen"
        >
          <el-icon><ScaleToOriginal v-if="fsActive" /><FullScreen v-else /></el-icon>
        </button>
        <el-dropdown trigger="click" @command="(v: string) => ui.setTheme(v as ThemeMode)">
          <button class="icon-btn" type="button" :aria-label="themeMenuLabel" :title="themeMenuLabel">
            <el-icon><Moon v-if="ui.resolvedTheme === 'dark'" /><Sunny v-else /></el-icon>
          </button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="auto" :class="{ 'is-active': ui.theme === 'auto' }">
                <el-icon><Timer /></el-icon>&nbsp;按时间自动
                <span class="ws-dim theme-menu__hint">{{ ui.themeWindow.darkFrom }}–{{ ui.themeWindow.darkTo }}</span>
              </el-dropdown-item>
              <el-dropdown-item command="light" :class="{ 'is-active': ui.theme === 'light' }">
                <el-icon><Sunny /></el-icon>&nbsp;亮色
              </el-dropdown-item>
              <el-dropdown-item command="dark" :class="{ 'is-active': ui.theme === 'dark' }">
                <el-icon><Moon /></el-icon>&nbsp;暗色
              </el-dropdown-item>
              <el-dropdown-item command="system" :class="{ 'is-active': ui.theme === 'system' }" divided>
                <el-icon><Monitor /></el-icon>&nbsp;跟随系统
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-tooltip content="设置与数据" placement="bottom">
          <button class="icon-btn" type="button" aria-label="设置与数据" @click="go('/settings')">
            <el-icon><Setting /></el-icon>
          </button>
        </el-tooltip>
      </header>

      <main class="content">
        <slot />
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  height: 100%;
  min-height: 100vh;
  min-height: 100dvh;
  background-color: var(--ws-bg);
  background-image: radial-gradient(var(--ws-bg-grid) 1px, transparent 1px);
  background-size: 22px 22px;
}

/* ------------------------------------------------------------- 侧边栏 --- */
.sidebar {
  width: var(--ws-sidebar-w);
  flex: 0 0 var(--ws-sidebar-w);
  display: flex;
  flex-direction: column;
  background: var(--ws-sidebar);
  border-right: 1px solid var(--ws-border);
  transition: width 0.2s ease, flex-basis 0.2s ease;
  overflow: hidden;
}
.shell--collapsed .sidebar {
  width: 64px;
  flex-basis: 64px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 11px;
  height: var(--ws-header-h);
  padding: 0 18px;
  cursor: pointer;
  flex: 0 0 auto;
  user-select: none;
}
.shell--collapsed .brand {
  padding: 0 0;
  justify-content: center;
}
/* 品牌主图标：程序生成的玻璃质感 WS 方块（透明底，深浅主题通用） */
.brand__logo {
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  display: block;
  object-fit: contain;
  filter: drop-shadow(0 4px 10px var(--ws-accent-ring));
  user-select: none;
  -webkit-user-drag: none;
}
.brand__name {
  font-size: var(--ws-fs-md);
  font-weight: 650;
  letter-spacing: -0.01em;
  line-height: 1.2;
}
.brand__sub {
  font-size: 11px;
  color: var(--ws-text-3);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.nav {
  flex: 1;
  overflow-y: auto;
  padding: 6px 10px 16px;
}
.nav__group {
  /* 分组自己的颜色（调用处按 `MODULE_GROUPS` 的 color 覆盖；置顶那块用主色）。
     它只用在标题的图标与一级箭头上 —— 让「这一组」和「下一组」一眼分得开。 */
  --nav-group-color: var(--ws-text-3);
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 18px 10px 7px;
  font-size: var(--ws-fs-sm);
  font-weight: 700;
  letter-spacing: 0.01em;
  color: var(--ws-text);
}
.nav__group-icon {
  font-size: 14px;
  color: var(--nav-group-color);
}
.nav__group-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 组与组之间的那道线：同属的行之间不画，跨组才画（2026-09-28 用户要「同属 / 非同属」分开看）。
   颜色比默认边框再淡一档，别把左栏切成一块块硬格子。 */
.nav__divider {
  height: 1px;
  margin: 12px 8px 8px;
  background: var(--ws-border);
}
.nav__item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 38px;
  padding: 0 10px;
  border-radius: var(--ws-radius-sm);
  color: var(--ws-text-2);
  cursor: pointer;
  font-size: var(--ws-fs-sm);
  font-weight: 500;
  transition: background 0.14s ease, color 0.14s ease;
  user-select: none;
}
.shell--collapsed .nav__item {
  justify-content: center;
  padding: 0;
}
.nav__item:hover {
  background: var(--ws-accent-soft);
  color: var(--ws-accent);
}
.nav__item.is-active {
  background: var(--ws-accent-soft);
  color: var(--ws-accent);
  font-weight: 600;
}
/* 展开了子页的那一行：垫一层**所属分组色**的极淡底，让「这一行 + 底下那串子页」读起来是一块，
   同时把「这一块属于哪个分组」也说清楚了。当前页本来就是主色软底（上面那条），别把它盖掉。 */
.nav__item.is-expanded:not(.is-active) {
  background: color-mix(in srgb, var(--nav-group-color, var(--ws-accent)) 9%, transparent);
  color: var(--ws-text);
}
.nav__icon {
  font-size: 16px;
  flex: 0 0 16px;
  display: grid;
  place-items: center;
}
.nav__text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 二级菜单开关：一个小箭头。收起时是淡灰；当前就在这个功能里、又没展开时点成主色，
   提示「这里面还有子页面」 */
/* 分组标题同时是「收起这一组」的按钮：一行高、整行可点 */
.nav__group--btn {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  border-radius: var(--ws-radius-sm);
}
/* 一级/二级都带自己的图标；三级（子页面）不给图标 */
.nav__group-icon--own {
  font-size: 14px;
  color: var(--nav-group-color);
}
/* 一级箭头（分组 / 置顶块）：实心三角 + **分组自己的颜色**，比二级那颗稍大。
   二级箭头（功能行，见下面 .nav__caret）：细箭头 + 中性灰，打开或当前页才转主色。
   两级用形状区分的理由：颜色在收起侧栏、暗色、无彩色主题下都可能被压平，形状不会。 */
.nav__caret--group {
  margin-left: auto;
  font-size: 13px;
  color: var(--nav-group-color);
  opacity: 0.72;
}
.nav__group--btn:hover {
  background: var(--ws-panel-2);
}
.nav__group--btn:hover .nav__group-name {
  color: var(--ws-text);
}
.nav__group--btn:hover .nav__caret--group {
  opacity: 1;
}
.nav__caret {
  margin-left: auto;
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border: none;  border-radius: 4px;
  background: transparent;
  color: var(--ws-text-3);
  /* 二级箭头：比一级那颗小一号，一眼分得开 */
  font-size: 11px;
  cursor: pointer;
}
.nav__caret:hover {
  background: var(--ws-panel-2);
  color: var(--ws-text);
}
.nav__caret.is-open,
.nav__caret.is-hint {
  color: var(--ws-accent);
}
.nav__badge {
  margin-left: auto;
  font-size: 11px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: var(--ws-radius-pill);
  color: var(--ws-accent);
  background: var(--ws-panel);
  border: 1px solid var(--ws-border);
}
/* 二级项：**不配图标**，改用「缩进 + 竖向导轨 + 小一号字」把层级说明白。
   一级项 = 16px 图标 + 38px 行高 + 正常文字色 + 14px 字；
   二级项 = 无图标、挂在这条导轨上、30px 行高 + 12px 淡色。
   导轨左边距 17px 正对一级图标的中轴（10px 内边距 + 16px 图标），
   文字落在 36px，与一级项图标后的文字完全对齐 —— 三者一眼分得开。
   相邻二级项的导轨首尾相接，连成一整列，子树不会看着散。 */
/* 图钉（我的置顶）：只有叶子页面才有这颗按钮。默认隐形、行 hover 才浮现；
   已置顶的**一直显示**，否则没法取消置顶 */
.nav__pin {
  margin-left: auto;
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border: none;
  background: transparent;
  padding: 0;
  color: var(--ws-text-3);
  cursor: pointer;
  opacity: 0;
  transition: opacity 120ms ease-out, color 120ms ease-out;
}
.nav__item:hover .nav__pin,
.nav__sub:hover .nav__pin {
  opacity: 1;
}
/* 行里已经有展开箭头时，别再抢一份 auto 边距（两个 auto 会把中间撑开） */
.nav__caret + .nav__pin {
  margin-left: 0;
}
.nav__pin:hover {
  color: var(--ws-accent);
}
.nav__pin.is-on {
  opacity: 1;
  color: var(--ws-accent);
}

.nav__sub {
  display: flex;
  align-items: center;
  height: 30px;
  margin-left: 17px;
  padding: 0 8px 0 17px;
  /* 导轨用**所属分组**的颜色（与底色混一档，别抢眼）：同一功能下的子页连成一根，
     不同功能的子页块之间靠 `is-first` 那点空隙断开 —— 同属 / 非同属在三级这层也看得见。 */
  border-left: 2px solid color-mix(in srgb, var(--nav-group-color, var(--ws-border)) 46%, var(--ws-border));
  border-radius: 0 var(--ws-radius-sm) var(--ws-radius-sm) 0;
  color: var(--ws-text-3);
  font-size: var(--ws-fs-xs);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease;
}
/* 换了一个功能：子页块之间留一道呼吸，免得两串子页连成一片分不清谁跟谁 */
.nav__sub.is-first {
  margin-top: 3px;
}
.nav__sub:hover {
  color: var(--ws-text);
  background: var(--ws-panel-2);
}
.nav__sub.is-active {
  color: var(--ws-accent);
  font-weight: 600;
  background: var(--ws-accent-soft);
  border-left-color: var(--ws-accent);
}
.sidebar__foot {
  flex: 0 0 auto;
  padding: 8px 10px 12px;
  border-top: 1px solid var(--ws-border);
}
.nav__item--minor {
  height: 34px;
  font-size: var(--ws-fs-sm);
}

/* -------------------------------------------------------------- 主区域 -- */
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  /* 100vh 是「手机地址栏收起时」的高度 —— 用它会让底部内容被推到屏幕外、或多出一截空白。
     100dvh 跟着实际可视区变。前一行是给不认 dvh 的浏览器兜底（同属性，后者优先）。 */
  height: 100vh;
  height: 100dvh;
}
.topbar {
  height: var(--ws-header-h);
  flex: 0 0 var(--ws-header-h);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px;
  border-bottom: 1px solid var(--ws-border);
  background: color-mix(in srgb, var(--ws-panel) 85%, transparent);
  backdrop-filter: blur(8px);
  position: sticky;
  top: 0;
  z-index: 20;
}
.icon-btn {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: var(--ws-radius-sm);
  background: transparent;
  color: var(--ws-text-2);
  cursor: pointer;
  font-size: 16px;
  transition: background 0.14s ease, color 0.14s ease;
}
.icon-btn:hover {
  background: var(--ws-accent-soft);
  color: var(--ws-accent);
}
.crumbs {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: var(--ws-fs-sm);
  margin-left: 4px;
  min-width: 0;
}
.crumbs__root,
.crumbs__mod {
  color: var(--ws-text-2);
  cursor: pointer;
}
.crumbs__root:hover,
.crumbs__mod:hover {
  color: var(--ws-accent);
}
.crumbs__sep {
  color: var(--ws-text-3);
}
.crumbs__cur {
  font-weight: 600;
}

.content {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

/* ==================================================== 手机档（≤760px） ----   侧栏从「64px 图标条」改成「抽屉」：默认移出屏幕，点顶栏汉堡滑入并盖住内容。
   换掉图标条有两个理由，第二个是硬伤：

     1. 图标条永远占 64px，390px 屏上内容只剩 262px（再扣掉页面两侧留白不到 250）；
        抽屉不占位，内容区拿回整屏宽。
     2. 图标条只放得下图标，于是二级/三级项只能 display:none ——
        「语音随记」那种带好几个子页的功能在手机上**根本没有入口**。
        抽屉里是完整导航，这个洞顺手就补上了。

   数字 760 与 src/core/ui.ts 的 MOBILE_MAX 必须一致（那边管行为：抽屉开合、
   isMobile 结构分支；这边管样式）。桌面（≥761px）完全不受影响 —— 全在媒体查询里。 */
@media (max-width: 760px) {
  .sidebar {
    position: fixed;
    top: 0;
    bottom: 0;
    left: 0;
    z-index: 60;
    width: 268px;
    max-width: 86vw;
    /* fixed 之后它不再是 flex item，`.main` 自动占满整宽 —— 这正是抽屉的意义 */
    flex-basis: auto;
    transform: translateX(-100%);
    transition: transform 0.2s ease;
    /* 横屏/刘海机左侧避开圆角与传感器区 */
    padding-left: env(safe-area-inset-left);
  }

  .shell--nav-open .sidebar {
    transform: none;
    box-shadow: var(--ws-shadow-3);
  }

  /* 遮罩：**只在抽屉打开时可见**。
     上一版漏了这条 —— 遮罩在手机档一直存在（fixed + inset:0 + z-index:50），
     于是整个屏幕蒙着一层灰、点什么都被它吃掉，用户只能看到"操作不了"。
     `pointer-events` 必须一起关：`opacity: 0` 的元素**仍然会接收点击**，
     只改透明度是挡不住点击的。 */
  .nav-mask {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: rgba(15, 23, 42, 0.42);
    /* 手指滑到遮罩上时别把背后的内容一起拖着滚 */
    overscroll-behavior: contain;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s ease;
  }

  .shell--nav-open .nav-mask {
    opacity: 1;
    pointer-events: auto;
  }

  /* 抽屉里**不隐藏任何文字**：旧版那条 display:none !important 正是
     「手机上三级页打不开」的原因，别再把它加回来。 */

  .topbar {
    padding-left: max(16px, env(safe-area-inset-left));
    padding-right: max(16px, env(safe-area-inset-right));
  }

  /* 32px 的图标按钮在手机上偏小，撑到 40px（只有手机档；桌面保持紧凑） */
  .icon-btn {
    width: 40px;
    height: 40px;
  }

  .sidebar__foot {
    padding-bottom: max(12px, env(safe-area-inset-bottom));
  }

  /* 面包屑去掉「工作站」那一层（它是回首页，抽屉里也能到），保留「模块 / 当前页」。
     窄到放不下时由 .crumbs 截断，而不是把顶栏撑宽。 */
  .crumbs {
    overflow: hidden;
  }
  .crumbs__root,
  .crumbs__root + .crumbs__sep {
    display: none;
  }
  .crumbs__cur {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
</style>
