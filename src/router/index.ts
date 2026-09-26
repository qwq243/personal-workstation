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

  router.afterEach((to) => {
    const title = (to.meta.title as string | undefined) ?? '工作站'
    document.title = to.path === '/' ? '工作站' : `${title} · 工作站`
  })

  return router
}
