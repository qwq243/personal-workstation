/**
 * 路由由「功能注册表」自动派生：内核只声明首页 / 设置 / 404，
 * 各功能把自己的路由通过 registerModule 交上来。
 *
 * 用 hash 模式，纯静态部署（甚至本地双击打开打包产物配合静态服务器）都不需要额外重写规则。
 */
import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'
import { collectRoutes } from '@/core/registry'

const coreRoutes: RouteRecordRaw[] = [
  {
    // 进入工作站先看每日看板：根路径直接重定向，不再单独做一页功能卡片
    path: '/',
    redirect: '/dashboard',
  },
  {
    // 原来的功能卡片页挪到这里，按大模块分组显示
    path: '/apps',
    name: 'apps',
    component: () => import('@/views/HomeView.vue'),
    meta: { title: '全部应用' },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@/views/SettingsView.vue'),
    meta: { title: '设置与数据' },
  },
  {
    path: '/dev-guide',
    name: 'dev-guide',
    component: () => import('@/views/DevGuideView.vue'),
    meta: { title: '扩展开发' },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/NotFoundView.vue'),
    meta: { title: '页面不存在', hideInNav: true },
  },
]

const RESUME_KEY = 'ws.resumePath'
const RELOAD_KEY = 'ws.lastChunkReloadAt'

/**
 * 动态 import 失败的几种字面：浏览器各自措辞不同
 * （Chromium「Failed to fetch dynamically imported module」、Safari「Importing a module script failed」、
 *  拿到 HTML 时的「Expected a JavaScript module script but the server responded with a MIME type of "text/html"」）。
 */
const CHUNK_ERROR_RE =
  /dynamically imported module|Importing a module script failed|Loading chunk \d+ failed|MIME type of "text\/html"/i

function isChunkLoadError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? '')
  return CHUNK_ERROR_RE.test(text)
}

/**
 * 页面开着的时候重新 `npm run build` 过，dist 里的 chunk 名全换了，
 * 这个页面手里还攥着旧文件名 —— 点侧边栏时 import 拿到的是边车回落的 index.html（或 404），
 * Vue Router 只会把导航静默地失败掉：表现就是「点了没反应，刷新一下才恢复正常」。
 *
 * 这类失败没法在页内补救（缺的模块就是不在了），只能重载拿新的 index.html。
 * 记住用户想去哪一页，重载后接上；10 秒内只重载一次，避免构建真坏了时无限刷新。
 */
function recoverFromStaleBuild(target?: string) {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
    if (Date.now() - last < 10_000) return
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
    if (target) sessionStorage.setItem(RESUME_KEY, target)
  } catch {
    /* 隐私模式等 sessionStorage 不可用：放弃自愈，保持现状比乱跳页好 */
  }
  location.reload()
}

/* -------------------------------------------- 换版自愈（静态资源） --- */

/**
 * 入口 chunk 的文件名 —— 构建后的 index.html 里写着
 * `<script type="module" src="/assets/index-XXXX.js">`，它就是这一页「出生时」的构建号。
 * 开发态是 `/src/main.ts`，匹配不到就返回空：那时不做自愈（前端本来就在重建）。
 */
const ASSET_ENTRY_RE = /\/assets\/(index-[A-Za-z0-9_-]+\.js)/

function pageBuildEntry(): string {
  const el = document.querySelector('script[type="module"][src]')
  return ASSET_ENTRY_RE.exec(el?.getAttribute('src') ?? '')?.[1] ?? ''
}

/** 边车**现在**发的那个入口名。现拉 index.html、不吃缓存 —— 要的就是「和手里这份不一样」 */
async function servedBuildEntry(): Promise<string> {
  const res = await fetch('/', { cache: 'no-store' })
  if (!res.ok) return ''
  return ASSET_ENTRY_RE.exec(await res.text())?.[1] ?? ''
}

/**
 * `<img>` / `<link>` / `<script>` 加载失败的那一半自愈。
 *
 * chunk 那条走 `router.onError`；但这些是浏览器自己发的请求，404 不经过路由，
 * 只会给页面留一个破图 —— 静默的，不刷新一直在。页面开着的时候重新 build，
 * 旧页面手里的 `/assets/banner-…-<旧哈希>.webp` 就全 404，
 * 症状就是「图片没加载出来」（2026-09-29 手机端报的那条走的就是这条路：
 * 今天 dist 重建过好几次，手机上的页面常年开着，最容易攥着旧哈希）。
 *
 * 判据从严：**只有「页面手里的入口名」≠「服务端现在发的入口名」才重载**。
 * 单个资源真缺了、或网络抖一下，只当没发生 —— 不会把好好的页面刷掉，也不会来回刷。
 * 重载走 `recoverFromStaleBuild`：那里面有 10 秒一次的限制，两个自愈共用同一道闸。
 */
async function recoverIfBuildChanged() {
  try {
    const mine = pageBuildEntry()
    if (!mine) return
    const now = await servedBuildEntry()
    if (now && now !== mine) recoverFromStaleBuild()
  } catch {
    /* 问不到服务端就不动：不动顶多是一张破图，乱刷会把用户手里的东西刷没 */
  }
}

/** 资源失败的 error 事件**不冒泡**，只能在捕获阶段接；只认本站 `/assets/` 里的资源 */
function installStaleAssetGuard() {
  window.addEventListener(
    'error',
    (e) => {
      const el = e.target as (HTMLElement & { src?: string; href?: string }) | null
      // 脚本自己的运行时报错也走 error，但 target 是 window —— 那种与本条无关
      if (!el || typeof el !== 'object') return
      const url = el.src || el.href || ''
      if (!url.startsWith(location.origin) || !url.includes('/assets/')) return
      // 留一行线索：破图是静默的，没这行事后只能猜（手机上报不上来的时候更得靠它）
      console.warn(`[stale] /assets/ 资源加载失败：${url}（页面构建 ${pageBuildEntry() || '未知'}）`)
      void recoverIfBuildChanged()
    },
    true,
  )
}

/** 上一次自愈重载前想去的那一页（读过即清，只补一次） */
export function takeResumePath(): string | null {
  try {
    const p = sessionStorage.getItem(RESUME_KEY)
    sessionStorage.removeItem(RESUME_KEY)
    return p
  } catch {
    return null
  }
}

export function createAppRouter() {
  const router = createRouter({
    history: createWebHashHistory(),
    routes: [...coreRoutes, ...collectRoutes()],
    scrollBehavior: () => ({ top: 0 }),
  })

  router.onError((error, to) => {
    if (isChunkLoadError(error)) recoverFromStaleBuild(to?.fullPath)
  })

  // 资源（图/样式/字体）那一半：挂在 window 上，和路由无关，但同属「换版自愈」一件事
  installStaleAssetGuard()

  router.afterEach((to) => {
    const title = (to.meta.title as string | undefined) ?? '工作站'
    document.title = to.path === '/' ? '工作站' : `${title} · 工作站`
  })

  return router
}
