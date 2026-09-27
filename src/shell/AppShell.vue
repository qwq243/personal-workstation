<script setup lang="ts">
/**
 * 全局布局壳：左侧功能导航 + 顶部面包屑 / 主题切换 + 内容区。
 * 侧边栏完全由功能注册表派生 —— 新增功能无需改这里。
 */
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getGroupedModules, getModules, getPinnedModules } from '@/core/registry'
import { useUiStore } from '@/core/ui'
import brandLogo from '@/assets/brand/ws-logo.webp'

const route = useRoute()
const router = useRouter()
const ui = useUiStore()

const modules = computed(() => getModules())
/** 置顶入口（`category` 留空的模块，当前是「进程守护」与「运行与自启」）：不参与分组，固定在导航最上方 */
const pinned = computed(() => getPinnedModules())
/** 按大模块分组（成长 / 办公 / 学习 / 待办 / 校内），空组不下发 —— 见 registry.ts 的 getGroupedModules() */
const groups = computed(() => getGroupedModules())

/** 当前激活的功能模块：按各模块路由做最长前缀匹配。
 *  不能只看路径第一段 —— 同一个一级路径下可能挂着不同模块的子页
 *  （现成例子：`/office/calendar` 与 `/office/usage` 分属 calendar 与 office-usage 两个模块，
 *   `/wiki` 下面还挂着 `/wiki/chat`、`/wiki/p/:slug` 这类深层路径）。 */
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
 *  一排图标反而会和一级项抢注意力。 */
const subNav = computed(() => {
  const mod = modules.value.find((m) => m.id === activeModuleId.value)
  if (!mod) return []
  const seen = new Set<string>()
  return mod.routes
    .filter((r) => !r.meta?.hideInNav && r.meta?.title && typeof r.path === 'string')
    .map((r) => ({
      path: r.path as string,
      title: r.meta!.title as string,
    }))
    .filter((item) => (seen.has(item.path) ? false : (seen.add(item.path), true)))
})

const currentModule = computed(() => modules.value.find((m) => m.id === activeModuleId.value))

function go(path: string) {
  if (route.path !== path) router.push(path)
}

/** 以大写字母开头视为 Element Plus 图标组件名，其余（如 emoji）按纯文本渲染 */
function isComponentIcon(icon: string): boolean {
  return /^[A-Z]/.test(icon)
}

function cycleTheme() {
  const next = ui.resolvedTheme === 'dark' ? 'light' : 'dark'
  ui.setTheme(next)
}
</script>

<template>
  <div class="shell" :class="{ 'shell--collapsed': ui.sidebarCollapsed }">
    <!-- ---------------------------------------------------------- 侧边栏 -->
    <aside class="sidebar">
      <div class="brand" @click="go('/dashboard')">
        <img class="brand__logo" :src="brandLogo" alt="工作站" draggable="false" />
        <div v-show="!ui.sidebarCollapsed" class="brand__text">
          <div class="brand__name">工作站</div>
          <div class="brand__sub">Workstation</div>
        </div>
      </div>

      <nav class="nav">
        <!-- 置顶入口：没有 category 的模块（进程守护 / 运行与自启），不参与大模块分组 -->
        <div
          v-for="mod in pinned"
          :key="mod.id"
          class="nav__item"
          :class="{ 'is-active': activeModuleId === mod.id }"
          @click="go(mod.homePath)"
        >
          <el-icon v-if="isComponentIcon(mod.icon)" class="nav__icon">
            <component :is="mod.icon" />
          </el-icon>
          <span v-else class="nav__icon">{{ mod.icon }}</span>
          <span v-show="!ui.sidebarCollapsed" class="nav__text">{{ mod.name }}</span>
        </div>

        <!-- 大模块：成长 / 办公 / 学习 / 待办 / 校内 -->
        <template v-for="g in groups" :key="g.group.id">
          <div v-if="!ui.sidebarCollapsed" class="nav__group">
            <el-icon class="nav__group-icon"><component :is="g.group.icon" /></el-icon>
            <span class="nav__group-name">{{ g.group.name }}</span>
          </div>
          <div v-else class="nav__divider" />

          <template v-for="mod in g.modules" :key="mod.id">
            <div
              class="nav__item"
              :class="{ 'is-active': activeModuleId === mod.id }"
              @click="go(mod.homePath)"
            >
              <el-icon v-if="isComponentIcon(mod.icon)" class="nav__icon">
                <component :is="mod.icon" />
              </el-icon>
              <span v-else class="nav__icon">{{ mod.icon }}</span>
              <span v-show="!ui.sidebarCollapsed" class="nav__text">{{ mod.name }}</span>
              <span
                v-if="!ui.sidebarCollapsed && mod.badge && mod.badge()"
                class="nav__badge"
                >{{ mod.badge() }}</span
              >
            </div>

            <!-- 二级导航：当前功能的子页面 -->
            <template v-if="!ui.sidebarCollapsed && activeModuleId === mod.id">
              <div
                v-for="sub in subNav"
                :key="sub.path"
                class="nav__sub"
                :class="{ 'is-active': route.path === sub.path }"
                @click="go(sub.path)"
              >
                <span>{{ sub.title }}</span>
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
          <span v-show="!ui.sidebarCollapsed">全部应用</span>
        </div>
        <div
          class="nav__item nav__item--minor"
          :class="{ 'is-active': route.path === '/dev-guide' }"
          @click="go('/dev-guide')"
        >
          <el-icon class="nav__icon"><MagicStick /></el-icon>
          <span v-show="!ui.sidebarCollapsed">扩展开发</span>
        </div>
        <div
          class="nav__item nav__item--minor"
          :class="{ 'is-active': route.path === '/settings' }"
          @click="go('/settings')"
        >
          <el-icon class="nav__icon"><Setting /></el-icon>
          <span v-show="!ui.sidebarCollapsed">设置与数据</span>
        </div>
      </div>
    </aside>

    <!-- ----------------------------------------------------------- 主区域 -->
    <div class="main">
      <header class="topbar">
        <el-tooltip :content="ui.sidebarCollapsed ? '展开侧栏' : '收起侧栏'" placement="bottom">
          <button
            class="icon-btn"
            type="button"
            :aria-label="ui.sidebarCollapsed ? '展开侧栏' : '收起侧栏'"
            :aria-expanded="!ui.sidebarCollapsed"
            @click="ui.toggleSidebar()"
          >
            <el-icon><Fold v-if="!ui.sidebarCollapsed" /><Expand v-else /></el-icon>
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

        <el-tooltip :content="ui.resolvedTheme === 'dark' ? '切换到浅色' : '切换到深色'" placement="bottom">
          <button
            class="icon-btn"
            type="button"
            :aria-label="ui.resolvedTheme === 'dark' ? '切换到浅色主题' : '切换到深色主题'"
            @click="cycleTheme()"
          >
            <el-icon><Moon v-if="ui.resolvedTheme === 'dark'" /><Sunny v-else /></el-icon>
          </button>
        </el-tooltip>
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
  color: var(--ws-accent);
}
.nav__group-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
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
.nav__sub {
  display: flex;
  align-items: center;
  height: 30px;
  margin-left: 17px;
  padding: 0 8px 0 17px;
  border-left: 2px solid var(--ws-border);
  border-radius: 0 var(--ws-radius-sm) var(--ws-radius-sm) 0;
  color: var(--ws-text-3);
  font-size: var(--ws-fs-xs);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease;
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
  height: 100vh;
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

@media (max-width: 760px) {
  .sidebar {
    width: 64px;
    flex-basis: 64px;
  }
  .nav__text,
  .nav__group,
  .brand__text,
  .sidebar__foot .nav__item span,
  .nav__badge {
    display: none !important;
  }
  .nav__item {
    justify-content: center;
  }
  .nav__sub {
    display: none;
  }
}
</style>
