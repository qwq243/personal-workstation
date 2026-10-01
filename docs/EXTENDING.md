# 扩展指南 EXTENDING

这份文档写给**第一次给工作站加功能的人**。目标很具体：照着走一遍，你能自己加出一个页面模块与它需要的边车接口，并且不和现有代码打架。

三条立场先说清楚：

- **内核不用改**。加功能只碰三处：新模块目录、`src/features/index.ts` 一行、需要后端时加 `server/lib/*.mjs` 与 `server/index.mjs` 里的路由。
- **每一步都能验证**。每个小节末尾都写了「怎么知道这一步成了」。
- **不确定的事不要猜**。写文档时提到的每个文件名与命令都来自本仓库当前代码；你自己加东西时也照这个标准来（`npm test` 与 `npm run build` 是两条最便宜的护栏）。
  > 文档里**故意不写行号**：行号会被任何一次编辑弄漂，这个仓库已经因为「文档抄了行号」把读者带偏过一次（见 [ARCHITECTURE.md](ARCHITECTURE.md) §6.5）。要引用就引「文件 + 小节」或一段能 grep 到的原文。

> **想少走一遍手工步骤**：本文第 2 章的每一步，`scripts/new-feature.mjs` 都能自动做完
> （建文件、注册、图标白名单两处、按需的后端与配置），骨架取自 `src/features/_template/`。
> 建议**先照着本文抄一遍**（知道每处在干嘛），再用生成器加第二个功能：
>
> ```bash
> node scripts/new-feature.mjs reading --name 阅读笔记 --icon Reading --group study --api --config
> ```
>
> 两条护栏替你兜底：`scripts/tests/module-contract.test.mjs`（注册表 / 图标 / 路由三条约定，
> `npm test` 会跑到）与生成器自己的前置检查（锚点找不齐、id 或路由撞车、生成的页面 SFC 解析不过，都整体中止）。

如果你还没把项目跑起来，先看 [README](../README.md) 的「快速开始」；本文默认你已经能打开 `http://127.0.0.1:5278/`（生产态）或 `127.0.0.1:5273`（开发态）。

---

## 1. 内核概念

### 1.1 唯一扩展点：功能注册表

`src/core/registry.ts` 是全站唯一的扩展点。它有一张 `Map<string, WorkstationModule>`，导出这些函数：

| 函数 | 作用 | 谁在用 |
|---|---|---|
| `registerModule(mod)` | 登记一个模块。id 重复会 `console.warn` 并覆盖 | `src/features/index.ts` |
| `getModules()` | 取**可见**模块，按 `order ?? 100` 升序 | `AppShell` 侧栏、`SettingsView` |
| `getModule(id)` | 按 id 取单个 | 需要精确定位的场景 |
| `getPinnedModules()` | 没有 `category` 的模块（固定在最上方，不参与分组） | `AppShell` 侧栏顶部、`HomeView` |
| `getGroupedModules()` | 按 `MODULE_GROUPS` 归组，空组不返回 | `AppShell` 侧栏、`HomeView`（`#/apps` 的全部应用） |
| `collectRoutes()` | 把所有模块的 `routes` 拼起来交给 vue-router | `src/router/index.ts` |

模块接口在 `src/core/types.ts`：

```ts
export interface WorkstationModule {
  id: string                 // 唯一标识，同时是路由与本地存储的命名空间，定下就别改
  name: string               // 侧边栏 / 卡片上的中文名
  description: string        // 一句话说明（卡片上显示）
  icon: string               // Element Plus 图标名（'Reading'）或 emoji
  color?: string             // 卡片主色，hex
  category?: ModuleGroupId   // 'growth' | 'office' | 'study' | 'todo' | 'campus'；不填 = 置顶入口
  order?: number             // 越小越靠前，缺省 100
  homePath: string           // 点侧边栏/卡片去哪儿
  routes: RouteRecordRaw[]   // 自己的路由，path 写绝对路径
  visible?: () => boolean    // 返回 false 就从侧边栏与首页消失
  stats?: () => ModuleStat[] // 给首页贡献几个数字
  badge?: () => string | null// 侧栏条目右上角的胶囊文案
}
```

`MODULE_GROUPS`（同文件）定义了五个大模块与它们的顺序：成长(3) → 办公(5) → 学习(10) → 待办(20) → 校内(30)。**出厂只有办公组与学习组里有人**；你把模块放进空组，那一组就会自己出现在侧边栏（`getGroupedModules()` 会过滤掉空组）—— 这是「加一个模块就等于加一个分区」的现成路子，不必改 `types.ts`。

> 现有的 `visible()` 用法只有两处，但它是内核级约定：`src/features/wiki/module.ts` 看 `wiki.dir` 填没填，`src/features/memo/module.ts` 看 `asr.baseUrl` 填没填。配置快照在 `src/core/appconfig.ts`（`cfgGet` / `cfgFilled`）——**它必须是同步的**，所以 `src/main.ts` 先 `loadAppConfig()` 拉一次存内存，**等它落地之后**才建路由（`void loadAppConfig().finally(…)`；拉不到时所有 `visible()` 一律当可见，避免慢启动期间侧边栏闪一下又变）。

### 1.2 路由与导航是怎么派生的

- **路由表** = 内核固定的几条（`src/router/index.ts` 的 `coreRoutes`：`/` 重定向到 `/dashboard`、`/apps`、`/settings`、`/dev-guide`、404）**+** `collectRoutes()`。用 **hash 模式**（`createWebHashHistory`），静态部署不需要任何重写规则。
- **懒加载是硬要求**：`component: () => import('./Xxx.vue')`。现有 9 个模块共 **25 条路由**，组件**全部**是懒加载，没有一个是静态 import —— 静态 import 会把整个模块塞进首屏包。（wiki 的 9 条路由里有 6 条复用同一个 `const WORKSPACE = () => import('./WikiWorkspace.vue')`，先定义再引用，同样是懒加载。）
- **二级导航**：模块 `routes` 里带 `meta.title` 且没有 `meta.hideInNav` 的路由，会自动出现在侧边栏该模块下面（`src/shell/AppShell.vue` 的 `subNav`）。**子页面排序 = routes 数组顺序**（`src/features/vocab/module.ts` 就靠这个把「每日一句」排在单词页前面）。
- **单页模块**：只有一个页面的模块，惯例是给唯一那条路由加 `meta.hideInNav: true`，避免二级菜单里出现一个和一级同名的项（见 `plan` / `calendar` / `usage` / `guard` / `memo`）。
- **激活态**：`AppShell` 按「最长前缀匹配」决定高亮哪个模块（`AppShell.vue` 的 `activeModuleId`），不是取路径第一段 —— 所以子路由挂在 `/wiki/...`、`/wiki/p/:slug` 这种深层路径上也不会串。
- **标题**：`router.afterEach` 把 `meta.title` 写进 `document.title`（形如 `设置与数据 · 工作站`）。
- **chunk 失效自愈**：页面开着时重新 `npm run build`，旧 chunk 名会 404；`router.onError` 认出这类失败后重载一次并接回原页面（`recoverFromStaleBuild`，10 秒内最多一次）。你不需要为它做任何事，但**别把 `/assets/*` 的 404 改成回落 index.html** —— 边车在这里是故意回 404 的（`server/index.mjs` 的 `serveStatic`）。

### 1.3 边车的路由注册

`server/index.mjs` 里，路由就是往一个数组里 push：

```js
const routes = []
function route(method, pattern, handler) {
  routes.push({ method, pattern, handler })
}

route('GET', /^\/api\/health$/, async () => ({ ok: true, service: 'workstation', ... }))
```

请求进来后的顺序是（都在 `server/index.mjs` 的 `http.createServer` 回调里）：

1. **CORS 头**：`applyCors()` 按 Origin 白名单**逐请求**设置 `Access-Control-Allow-Origin`（不为 `*`）；
2. **第 1 道闸**：`origin` 存在且不在白名单 → `403`（别的网页连探测都做不到）；
3. `OPTIONS` → `204`；
4. **第 2 道闸**：`/api/*` 与 `/mcp` 要令牌（`X-WS-Token` / `Authorization: Bearer` / `?token=`）；`/api/health` 与 `/api/auth/token` 免；
5. `/mcp` → 交给 `server/mcp.mjs`；
6. **`/api/*` 按注册顺序逐条匹配**（第一条命中就停 —— 所以更具体的 pattern 要写在更宽的前面）；
7. 没有 `/api/*` 命中 → `404 {"ok":false,"error":"未知接口 …"}`；
8. 其余路径 → `serveStatic()` 发 `dist/`（文件不存在且**没有扩展名**时才回落 `index.html`）。

写 handler 要记住的四件事：

```js
route('POST', /^\/api\/reading\/note$/, async (req, { query, body, params, res }) => {
  // 1) 参数从第二参解构：query 是查询串对象、body 是请求体、params 是正则捕获组、res 是原始响应
  // 2) 返回值会被自动 send(res, 200, value)：返回对象就是 JSON，返回 undefined 就是 {"ok":true}
  // 3) 需要自己写响应（流式 / 二进制）时返回字符串 'handled'，分发处就不再动 res
  // 4) 出错返回 { ok:false, error:'人话' }，不要抛 —— 抛异常虽然会被兜底成 500，
  //    但页面看到的是没有上下文的错（分发处的 try/catch 见 server/index.mjs）
  const note = reading.add(body?.text)
  if (!note.ok) return { ok: false, error: note.error }
  return { ok: true, note }
})
```

- **请求体**：`POST/PUT/PATCH` 会被 `readBody()` 读成 JS 对象（JSON）；`Content-Type: application/octet-stream` 是唯一的例外分支，返回 `{ __bin: Buffer }`（拖文件上传走这条，别把二进制塞进 JSON）；不是合法 JSON 时给 `{ __raw: string }`。
- **慢接口**：用 `timed('名字', () => …)` 包一层，超过 2000ms 会在日志里打 `[slow] 名字 1234ms`。
- **响应头**：`send()` 统一带 `Cache-Control: no-store`；CORS 头由入口按白名单设置，**不要在 handler 里自己写 `Access-Control-Allow-Origin`**。
- **静态资源**：生产态边车会把 `dist/` 发出去（`/assets/*` 长缓存 immutable，其它 `no-cache`）。

### 1.4 页面模板与常用组件

页面骨架长这样（`<div class="ws-page">` 是宽度与留白的约定容器）：

```vue
<template>
  <div class="ws-page">            <!-- 或 ws-page--wide（宽表 / 日历用） -->
    <PageHeader title="阅读笔记" subtitle="记录与回顾读过的文章" icon="Reading">
      <template #actions>
        <el-button type="primary">新增</el-button>
      </template>
    </PageHeader>

    <div class="ws-card">…</div>   <!-- 卡片：背景 / 边框 / 圆角 / 阴影都来自令牌 -->
  </div>
</template>
```

可复用的东西（`src/components/`）：

| 组件 | 用途 | 关键 props |
|---|---|---|
| `PageHeader.vue` | 页面标题 + 副标题 + 右侧 `#actions` 插槽 | `title` / `subtitle` / `icon` |
| `EmptyState.vue` | 空状态占位（带默认插槽放按钮） | `title` / `description` / `icon`（默认 `Box`） |
| `MdLite.vue` | 极简 Markdown 渲染（零依赖，先转义再替换，防 XSS） | `text` / `dense` |
| `SidecarOffline.vue` | 边车没连上时的引导卡（自带「重新检测」，成功发 `ready` 事件） | `what` / `autoCheck` |
| `SentencePractice.vue` | 「每日一句」那套练习交互 | `more` |

样式工具类在 `src/styles/index.css`（`ws-page` / `ws-card` / `ws-muted` / `ws-dim` / `ws-mono` / `ws-row` / `ws-spacer` / `ws-empty`），颜色、字号、圆角、阴影**只允许**引用 `src/styles/tokens.css` 的 `--ws-*` 变量。规矩见 [design-system.md](design-system.md)：**新增硬编码颜色是不接受的**。

两个容易被按需引入机制坑到的点：

- **Element Plus 组件在模板里直接写标签**（`<el-button>`、`<el-table>`），由 `unplugin-vue-components` 在编译期按需注入组件与其 CSS。**别在 `.vue` 里 `import { ElButton } from 'element-plus'` 再手动注册** —— 那会绕开样式注入。
- `ElMessage` / `ElMessageBox` 是命令式调用、模板里没有标签，`main.ts` 为它们**全局引了一份样式**，所以下面这种写法是安全且常见的：
  ```ts
  import { ElMessage } from 'element-plus'   // OK：样式已在 main.ts 全局引入
  ```
- **图标**必须出现在 `src/main.ts` 的白名单里（`import` 与 `ICONS` 映射**两处都要加**，源码里有两个 `// ↓ 新图标加在这里` 锚点）。漏加的表现是「侧边栏 / 页面里那块空白」+ 一条 Vue 解析警告，而**构建照样过**。

  **这是全套约定里唯一一处「内核级例外」，值得知道为什么**：图标名在模板里是**字符串**（`<component :is="mod.icon">`、`<PageHeader icon="Setting">`），静态分析不出来，所以不能像组件那样交给 `unplugin-vue-components` 按需引入 —— 只能全局注册一份白名单。而白名单又**必须**这么写：命名导入 + 显式映射，**不能**改成 `import * as Icons` 再动态取键（`src/main.ts` 的注释写了原因：命名空间导入会让打包器无法摇树，294 个图标会全部进包，其中约 80% 用不到）。

  三道网兜着这一步：源码锚点（两处必须一致）、`scripts/tests/module-contract.test.mjs`（模块/路由/分组用到的图标必须都在白名单里、且两处一致）、生成器（图标名要能在 `@element-plus/icons-vue` 里找到才放行）。

---

## 2. 加一个页面模块（完整步骤）

### 先看这张表：你加的东西到底要动几个文件

「内核不用改」是对的，但**不等于「一个文件都不用改」**。按你要的能力对号入座：

| 你要做的 | 要动的文件 | 漏了会怎样 |
|---|---|---|
| **纯页面**（数据全在浏览器里） | ① `src/features/<id>/module.ts` ② 同目录的 `.vue` ③ `src/features/index.ts` 加一行 `registerModule()` | 侧边栏没这一项、路由表里没这条路由 |
| 上面 ＋ **用现成边车接口** | 再在 `src/core/sidecar.ts` 的 `api` 里加一条 `call(...)` | 页面拿不到数据（`api.xxx is not a function` 更直接） |
| 上面 ＋ **图标是新的** | 再改 `src/main.ts` 的**两处**：顶部 `import` 与 `ICONS` 映射 | **不报错**：侧边栏 / 页面里那块是空白。这是全套步骤里唯一静默失败的一步 |
| 上面 ＋ **新后端能力** | 再：① `server/lib/<能力>.mjs` ② `server/index.mjs` 顶部 `import` ③ 同文件路由表末尾加 `route(...)`（有锚点注释） | 接口 404，前端显示「未知接口」 |
| 上面 ＋ **新配置项** | 这三处**都要**：① `server/config.mjs` 的 `DEFAULTS` ② `server/lib/config-editable.mjs` 的白名单（**分节**还是**标量**，见 §3.4）③ `server/config.example.json` | 页面改不动那一项（PATCH 回 `rejected`）；`npm test` 会红（`scripts/tests/config-whitelist.test.mjs`） |
| 上面 ＋ **给智能体用** | 再改 `server/mcp.mjs` 的 `TOOLS` 与 `HANDLERS`（**名字必须一致**） | 调用时回「未知工具：xxx」，没有测试拦 |
| 上面 ＋ **开机自启 / 独立页面入口** | 不用改代码：`#/service`（`src/features/service/`）就是一个「只有一条接口、一个页面」的最小现成范本 | — |

图标那一步、MCP 那一步都属于「漏了不报错」，所以它们各自在源码里留了锚点注释：
`grep -rn "新图标加在这里" src/main.ts`、`grep -rn "新接口加在这里" server/index.mjs`。

### 目录约定（先记住这三条，再动手）

`src/features/` 下同时住着**功能模块**和**只被别处引用的共享组件**两类东西，
所以「这个目录是不是一个模块」要按下面这条判据看，别照目录名猜：

| 情况 | 怎么摆 | 现有例子 |
|---|---|---|
| 一个目录 = 一个模块 | 模块定义叫 `module.ts`，目录名 = 模块 `id` | `dashboard/` `plan/` `vocab/` `wiki/` `memo/` `guard/` `service/` |
| 一个目录 = 多个模块 | 每个模块一个 `<id>.module.ts`，**没有** `module.ts` | `office/` → `calendar.module.ts`（id=calendar）+ `usage.module.ts`（id=office-usage） |
| 只被别处引用的共享组件 | 放 `src/features/<域>/`，**不要**给它起模块文件 | `settings/` → `LlmSection.vue` / `EmbeddingSection.vue` / `SearchSection.vue`，被 `src/views/SettingsView.vue` 引用 |

**唯一入口**是 `src/features/index.ts` 里的 `registerModule()` —— 目录里有没有文件、叫什么，
注册表都不看，它只认你 `registerModule` 传进去的那个对象。
同一个接口的说明也抄在 `src/core/types.ts`（`WorkstationModule` 上方），两边保持一致。

下面以「阅读笔记」（`id: reading`，路径 `/reading`）为例，从零到能点开。

### 第 1 步：建目录

```
src/features/reading/
  module.ts        模块定义（登记用）
  ReadingHome.vue  首页
  Archive.vue      子页（可选）
```

目录名与 `id` 保持一致，方便日后搜索 —— 单模块目录都遵守这条（`dashboard` / `plan` / `vocab` / `wiki` / `memo` / `guard` / `service`）。
注意两个**反例**：`office/` 装了两个模块（所以是 `calendar.module.ts` / `usage.module.ts`），
`settings/` 根本不是模块（只有三个被设置页引用的 Section 组件）。判据见上面的「目录约定」。

### 第 2 步：写 `module.ts`

```ts
// src/features/reading/module.ts
import type { WorkstationModule } from '@/core/types'

export const readingModule: WorkstationModule = {
  id: 'reading',
  name: '阅读笔记',
  description: '记录与回顾读过的文章。',
  icon: 'Reading',        // 必须在 src/main.ts 的白名单里
  color: '#0ea5e9',       // 只用于卡片描边 / 徽标 / 统计数字，不是大面积填充色
  category: 'study',      // 学习组；不填 = 置顶入口
  order: 40,              // 越小越靠前（study 组现有 vocab=30、wiki=31）
  homePath: '/reading',
  routes: [
    {
      path: '/reading',
      name: 'reading-home',
      component: () => import('./ReadingHome.vue'),
      meta: { title: '阅读' },                 // 带 title 且没 hideInNav → 进侧边栏二级菜单
    },
    {
      path: '/reading/archive',
      name: 'reading-archive',
      component: () => import('./Archive.vue'),
      meta: { title: '归档', icon: 'Box' },
    },
  ],
}
```

约束回顾：`path` 写**绝对路径**；`name` 全局唯一（vue-router 重名会告警）；`component` 必须是 `() => import(...)`。

### 第 3 步：写页面

最小可运行的首页（含「边车没起来」的处理 —— 这是本仓库所有联网页面的统一写法）：

```vue
<!-- src/features/reading/ReadingHome.vue -->
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import EmptyState from '@/components/EmptyState.vue'
import SidecarOffline from '@/components/SidecarOffline.vue'
import { api, ensureSidecar } from '@/core/sidecar'

const ready = ref(false)
const loading = ref(true)
const notes = ref<any[]>([])

async function load() {
  loading.value = true
  // ensureSidecar(): 探一次 /api/health（并发调用只探一次），返回布尔
  ready.value = await ensureSidecar()
  if (!ready.value) {
    loading.value = false
    return
  }
  const r = await api.readingNotes()
  if (r.ok) notes.value = r.data?.notes ?? []
  loading.value = false
}

onMounted(load)
</script>

<template>
  <div class="ws-page">
    <PageHeader title="阅读笔记" subtitle="记录与回顾读过的文章" icon="Reading">
      <template #actions>
        <el-button :loading="loading" @click="load"><el-icon><Refresh /></el-icon>&nbsp;刷新</el-button>
      </template>
    </PageHeader>

    <!-- ready 为 false 时给引导；「重新检测」成功后会 emit ready → 回调里重新加载 -->
    <SidecarOffline v-if="!loading && !ready" what="阅读笔记" @ready="load" />

    <el-skeleton v-else-if="loading" :rows="6" animated />

    <EmptyState
      v-else-if="!notes.length"
      title="还没有笔记"
      description="先到「设置与数据」看看边车是否正常，然后在这里写第一条。"
    >
      <el-button type="primary">新增笔记</el-button>
    </EmptyState>

    <div v-else class="ws-card" style="padding: 18px">
      <div v-for="n in notes" :key="n.id" class="ws-row" style="justify-content: space-between">
        <span>{{ n.text }}</span>
        <span class="ws-dim">{{ new Date(n.at).toLocaleString('zh-CN') }}</span>
      </div>
    </div>
  </div>
</template>
```

关于 `api.readingNotes()`：`src/core/sidecar.ts` 里的 `api` 对象是**集中登记**所有后端调用的地方；新接口要在那里加一条（见 §3.3），不要在页面里裸 `fetch`。它的返回值统一是 `{ ok, data, error, status }`，`ok:false` 时 `error` 是可以直接显示给用户的中文原因。

### 第 4 步：注册

```ts
// src/features/index.ts
import { readingModule } from './reading/module'   // ← 加这一行
…
export function registerAllModules(): void {
  …
  registerModule(guardModule)
  registerModule(readingModule)   // ← 再加这一行
}
```

**到这一步就结束了**：侧边栏（学习组）、`/apps` 里的功能卡片、路由表都会自动出现。不需要动 `src/core/`、`src/router/`、`src/shell/` 的任何文件。

### 第 5 步：图标（最容易漏）

用到的图标名必须在 `src/main.ts` 里**两处**都有：顶部的 `import { … } from '@element-plus/icons-vue'`，以及 `const ICONS = { … }` 映射。漏了的表现是页面里那块空白（控制台会有 Vue 的解析警告），而构建照样过。列表本身是有意只列用到的（命名导入才能摇树，`import * as Icons` 会把 294 个图标全打进包）—— 这条为什么是「内核级例外」，见 §1.4 那一段。

两处都有 `// ↓ 新图标加在这里` 锚点，`grep -rn "新图标加在这里" src/main.ts` 就能定位。
`npm test` 里的 `scripts/tests/module-contract.test.mjs` 会替你查：模块 / 路由 / 分组用到的图标名必须都在白名单里，而且**两处必须一致** —— 漏了会红，不用等页面打开才发现。

### 第 6 步（可选）：`stats` / `badge` / `visible`

```ts
  // 首页卡片上的数字
  stats: () => [
    { label: '笔记', value: notesCount() },
    { label: '本周', value: weekCount(), color: '#16a34a' },
  ],
  // 侧栏条目右上角的胶囊
  badge: () => (dueCount() ? `${dueCount()} 待复习` : null),
  // 依赖没配好就藏起来（「没配 = 不显示」是内核约定）
  visible: () => cfgFilled('reading.dir'),
```

注意 `stats()` / `badge()` 是**同步**函数，会在渲染时被调用，别在里面发请求（要数据就先用 pinia store 或模块级缓存把它备好，`src/features/vocab/module.ts` 就是读 store）。

### 第 7 步：验证

```bash
npm run build       # 构建过关（能连带发现导出名写错、模板语法错）
npm run typecheck   # 更严的 vue-tsc（可选，但建议跑）
npm run dev:all     # 起边车 + Vite，然后打开 Vite 给的地址看：侧栏有没有新条目、点进去是不是一页报错
```

> 侧栏里**没有**新条目不一定是注册失败：第 6 步用了 `visible: () => cfgFilled('…')` 的模块，
> 配置为空时按「没配 = 不显示」那条内核约定**本来就不出现**。要看见它，先去 `server/config.json`
> 填上那一项（改完重启边车），或把 `visible` 改成 `() => true`。
> 生成器带 `--config` 时会在收尾输出里把这一步再说一遍。

> 开发态前端在 5273、边车在 5278，前端默认走同源相对路径 —— 记得在 URL 上加 `?sidecar=127.0.0.1:5278` 或建 `.env.local`（见 [README](../README.md) 的「快速开始」），否则你会看到一张「边车没连上」的卡片。

对照 [verifying.md](verifying.md) 里「改到这几块时的额外检查」那一节：注册表改动要确认「侧边栏条目数对不对」以及「没配的模块确实不在」。

---

## 3. 加一个边车接口（完整步骤）

场景接着上面：阅读笔记要存在服务端（这样智能体也能写），于是需要一个能力库 + 两条路由。

### 3.1 写能力库 `server/lib/reading.mjs`

一个 lib 负责一件事，路由只是它的薄封装。**只 import `node:` 内置模块和相对路径** —— 边车零第三方依赖是硬约束（`server/` 下现在没有任何一条指向 npm 包的 import）。

```js
// server/lib/reading.mjs
import path from 'node:path'
import { dataDir } from '../config.mjs'      // ← 数据目录的唯一入口
import { createJsonStore } from './jsonstore.mjs'

const VERSION = 1
const backupDir = () => path.join(dataDir(), 'backups')

const store = createJsonStore({
  name: 'reading-notes',
  file: () => path.join(dataDir(), 'reading-notes.json'),
  version: VERSION,
  empty: () => ({ version: VERSION, rev: 0, updatedAt: 0, notes: [] }),
  migrate: (raw) => ({
    version: VERSION,
    rev: raw.rev,
    updatedAt: raw.updatedAt,
    notes: Array.isArray(raw.notes) ? raw.notes : [],
  }),
  backupDir,
})

export function list() {
  return store.read().notes
}

export function add(text) {
  const t = String(text ?? '').trim()
  if (!t) return { ok: false, error: '内容不能为空' }
  const cur = store.read()
  const note = { id: `n_${Date.now().toString(36)}`, text: t.slice(0, 500), at: Date.now() }
  const { data, conflict } = store.write({ notes: [note, ...cur.notes] }, { baseRev: cur.rev, source: 'web' })
  return { ok: true, note, rev: data.rev, conflict: conflict?.copy ?? null }
}
```

数据存储的细节在 §4；这里只要记住「读 `store.read()`、写 `store.write(next, { baseRev })`、空结构写在 `empty()` 里」。

### 3.2 在 `server/index.mjs` 挂路由

两步：顶部 import 区加一行，路由区加你要的几条。

```js
// 顶部 import 区（按现有风格按字母/用途排）
import * as reading from './lib/reading.mjs'

/* --- 阅读笔记 --- */

route('GET', /^\/api\/reading\/notes$/, () => ({ ok: true, notes: reading.list() }))

route('POST', /^\/api\/reading\/note$/, (req, { body }) => reading.add(body?.text))
```

约定：

- **路径前缀用模块 id**（`/api/reading/*`），和前端模块一一对应，日后 grep 得到；
- **失败也返回 200 + `{ ok:false, error }`**（本仓库统一风格），不要靠 HTTP 状态码表达业务失败；
- 处理器**不要抛**（分发处兜底会回 500 + `接口内部出错：…`，但那是最后一道网，不是设计）；
- 慢调用包 `timed('reading.list', () => …)`；
- 需要收二进制就 `Content-Type: application/octet-stream`，body 里拿 `{ __bin }`。

### 3.3 前端加一条调用

`call()` 是 `src/core/sidecar.ts` 的模块内私有函数，所以在同一文件顶部的 `api` 对象里加：

```ts
export const api = {
  …
  readingNotes: () => call('/api/reading/notes'),
  readingAdd: (text: string) => call('/api/reading/note', { method: 'POST', body: { text } }),
}
```

`call` 已经替你处理了三件事：带上本地令牌（401 会自动重取一次再试）、30 秒默认超时（可用 `timeout` 覆盖）、失败时返回可读中文（`连不上边车服务（可能没启动）…` / `请求超时（30000ms）`）。

### 3.4 如果它需要配置项

**三处必改 + 一处按需**（漏一处不会报错，只会在某个地方表现为「改不动」「页面上没有这一项」或「别人不知道有这一项」）：

1. **`server/config.mjs` 的 `DEFAULTS`** —— 加一节（默认值一律**中性**：路径给空串、开关给保守值），例如：
   ```js
   /** 阅读笔记：库目录留空 = 模块不在侧边栏显示 */
   reading: { dir: '', maxNotes: 500 },
   ```
2. **`server/lib/config-editable.mjs` 的白名单** —— 想让「设置与数据」页能改它，就要挂上去。
   这份白名单**分两张表，按「这一项在 `config.json` 里是什么形状」分**：
   - 值是**对象**（一整个分节）→ 加进 `CONFIG_EDITABLE` 的对应分节数组（`reading: ['dir', 'maxNotes']`）；
   - 值是**字符串 / 数字 / 布尔**（标量，例如「输出语言」那种单值下拉）→ 加进 `CONFIG_EDITABLE_SCALARS`。
     **标量项误放进 `CONFIG_EDITABLE`（尤其写成空数组）的后果是永远改不动**：分发处的分节循环用
     `typeof v !== 'object'` 判形状，字符串一律被当成「无效分节」扔进 `rejected`，
     而页面把 HTTP 200 当成功 —— `outputLanguage` 真踩过这一脚（2026-09-27 修）。
   没进白名单的字段调 `PATCH /api/config` 会被**拒绝并点名**（这是有意的护栏，别绕过）。
3. **密钥**：如果这一项是密钥（token / API Key / 密码），加进 `server/config.mjs` 的 `SECRET_PATHS`：
   ```js
   ['reading', 'apiKey'],
   ```
   这样保存时它会自动落到 `server/credentials.json`，`/api/config` 返回时自动脱敏成 `****后四位`；`saveConfig` 也会把脱敏串与空串当成「不改」，避免一次保存把真值冲掉。
4. **「设置与数据」页上的输入框**（要能在页面上改时才加）—— 白名单只管**服务端**放不放行：
   页面那一栏是**硬编码表单**（`src/views/SettingsView.vue` 里一节一节手写的 `el-input` / 下拉），
   **不按白名单派生**。所以进了白名单的新字段，页面上**不会自动长出输入框**，
   得去那个文件加控件、把它并进该节 `save...()` 发给 `api.patchConfig()` 的那份 patch；
   不加就只能手改 `server/config.json`（手改要重启边车才生效，见 [CONFIG.md](CONFIG.md) §9.1）。

**不要**把默认值写成某台机器上的绝对路径、也不要写进 `config.example.json` 之外的任何地方；`config.example.json` 里要同步补一条带说明的项（贡献约定见 README）。
路径一律写**正斜杠**（反斜杠会被 JSON 当转义吃掉，见 `server/config.example.json` 里那条 `startupDir` 的教训）。

**这之后是白拿的**：加完跑 `npm test`。`scripts/tests/config-whitelist.test.mjs` 会把
`DEFAULTS` / 两张白名单 / `config.example.json` 三方对账，上面任何一步漏了它都会红并点名，
逐项说明见 [CONFIG.md §10](CONFIG.md)。

### 3.5 顺手挂到 MCP（可选）

想让智能体也能读写，就在 `server/mcp.mjs` 里加两条，**名字必须一致**：

```js
// ① TOOLS：给模型看的定义
const TOOLS = [
  …
  {
    name: 'add_reading_note',
    description: '给工作站的阅读笔记加一条。',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
]

// ② HANDLERS：真正干活的方法（方法名 = 工具名）
const HANDLERS = {
  …
  async add_reading_note({ text }) {
    const r = reading.add(text)
    return ok(r.ok ? `已记录：${text}` : r.error, { data: r })
  },
}
```

`tools/call` 是**按名字**从 `HANDLERS` 里取的（`server/mcp.mjs`），写错只在调用时回 `未知工具：xxx` —— 目前没有测试会替你拦住这种不一致，加完自己调一次。`server/mcp.mjs` 里已有 55 个工具，可以照抄一个形状（注意 `ok(text, { data })` 这个 helper 的用法）。

### 3.6 验证

```bash
npm run server                  # 起边车
```

```bash
# 带令牌调（令牌在 server/config.json 的 auth.token）
curl -s -H "X-WS-Token: <token>" http://127.0.0.1:5278/api/reading/notes
curl -s -X POST -H "Content-Type: application/json" -H "X-WS-Token: <token>" \
     -d '{"text":"第一条"}' http://127.0.0.1:5278/api/reading/note
```

然后看 `server/data/` 里有没有 `reading-notes.json`、连续写两次 `rev` 有没有 +1。这就是 [verifying.md](verifying.md) 里那条「每个新接口都该有 `ok:false` + 可读的 `error`，而不是 500」的具体做法。

---

## 4. 数据存储约定（jsonstore 的原子写与 `.bak`）

### 4.1 数据目录只有一个入口

```js
import { dataDir } from '../config.mjs'   // server/config.mjs:396
path.join(dataDir(), 'reading-notes.json')
```

`dataDir()`（`server/config.mjs`）的取值顺序是：环境变量 `WS_DATA_DIR`（测试用，可以把数据写到别处而不碰真实数据）→ 配置里的 `dataDir`；配置里**没写这一项**时才是出厂默认的仓库内 `server/data/`。

> ⚠️ 一个坑：把 `dataDir` 写成**空串不等于回默认** —— `dataDir()` 会原样返回空串，`path.join('', 'x.json')` 就是相对路径，数据会落到**进程的 cwd** 下。要回默认就删掉这一项，别写成 `""`（[CONFIG.md](CONFIG.md) §9 里有同样的提醒）。

> 仓库里有几个较早的 lib 自己复制了一份同样的表达式（`plan.mjs` / `vocab.mjs` / `summaries.mjs` / `usage-cache.mjs` 里各有一个模块内 `dataDir()`）。那是历史遗留，**新代码请从 `config.mjs` 导入**，别再复制。
> 另外，`jsonstore.mjs` 自己不做路径拼接 —— 它只接受一个返回绝对路径的 `file()` 函数。

### 4.2 `createJsonStore` 的六个参数

```js
const store = createJsonStore({
  name: 'reading-notes',            // 快照 / 冲突副本的文件名前缀
  file: () => path.join(dataDir(), 'reading-notes.json'),  // 函数形式（懒算，便于改配置后生效）
  version: 1,                       // 结构版本
  empty: () => ({ version: 1, rev: 0, updatedAt: 0, notes: [] }),  // 文件不存在时的空结构
  migrate: (raw) => ({ … }),        // 迁移 + 归一化：老结构升上来，脏字段剔掉（读时必过）
  backupDir: () => path.join(dataDir(), 'backups'),
})
```

它给你的成员：`read()`、`write(next, { baseRev, source })`、`summary()`（存储自检信息：文件大小 / `rev` / `updatedAt` / `savedBy`）、`path()`（数据文件绝对路径）、`backupDir()`。`version` 会写进每次保存的数据里，也是 `write` 覆盖的值之一。

### 4.3 写盘做了什么（这是它存在的理由）

`write(next, { baseRev, source })` 的动作序列：

1. 先 `read()` 一遍（确认当前文件可解析，同时拿到 `prevRev`）；
2. 如果调用方给了 `baseRev` 且与磁盘 `rev` 不一致 → 认为**别处也改过**（另一个窗口 / 另一个智能体），把**对方那一版**另存 `<file>.conflict-<时间>` 留证，并在返回值里带 `conflict`；
3. 把当前磁盘那份拷成 `<file>.bak`（回退用）；
4. **原子写**：先写 `<file>.tmp` 再 `rename` 到目标 —— 读到的要么是旧的完整内容、要么是新的完整内容，不存在半截；
5. 每天留一份快照到 `backups/<name>-YYYY-MM-DD.json`（同一天超过 1 小时才重写），并清理超出保留份数的旧快照与冲突副本；
6. 返回 `{ data, conflict, prevRev }`，`data` 里带着新的 `rev` / `updatedAt` / `savedBy: source`。

所以调用方的正确姿势是：

```js
const cur = store.read()
const { data, conflict } = store.write({ notes: next }, { baseRev: cur.rev, source: 'web' })
if (conflict) console.warn('有人也在写，对方版本已留证：', conflict.copy)
```

`source` 是给人和智能体看的（写进 `savedBy`），取值如 `'web'` / `'agent'` / `'mcp'`。

### 4.4 文件坏了会怎样（不是当空数据）

`read()` 遇到「文件在、但解析不出来」时：

1. 把坏文件另存 `<file>.corrupt-<时间>`（**不覆盖**，留证）；
2. 在 `<file>.bak` 与最近的每日快照里，按 `updatedAt` 取**最新**的一份回退，并把主文件按它修复；
3. 两份候选都没有，才按空结构处理，并在控制台写明「坏文件已保留，请人工检查」。

这条路径是可以用一条命令自查的：把某个数据文件写坏，重启边车，看它有没有回退 + 留证（[verifying.md](verifying.md) 里就是这么写的）。

### 4.5 什么该用 / 什么不该用

- **该用**：会被反复读写、丢了会心疼、还可能被智能体并发写的业务数据（看板 `dashboard.json`、规划台 `plan.json`、词单 `vocab/*.json`、随记 `memo/records.json` 都是）。
- **可选**：任务表 / 队列这种有明确生命周期的状态。`wiki-queue.mjs` 的队列用 `writeAtomic` 直接写（结构简单、不需要 rev）；`memo` 的 `jobs.json` 更轻 —— 一份普通快照，存在的唯一目的是**重启后对账**（把当时还在 `running` 的任务标成 `interrupted`），真正的业务数据 `records.json` 仍然走 jsonstore。重点是**别假装任务还在跑**。
- **不该用**：大块二进制（音频、图片）—— 直接 `fs.writeFileSync` 到你自己的子目录（`memo/inbox/` 就是这么做的），JSON 只留索引。向量这种体积大又整块替换的数据也另行处理（`wiki-embed.mjs` 是「一份 JSON + 暴力点积」，不走逐条 jsonstore）。

---

## 5. 长任务约定（起任务 + 轮询）

### 5.1 为什么不能让请求等完

Node 的 `requestTimeout` 默认 5 分钟：转写、文档解析、模型编译这类分钟级任务**在一个请求里等完必被掐**（`server/lib/memo.mjs` 头部与 [文件传输.md](文件传输.md) 都把这条写成了约定）。所以流程固定成三段：

```
① start   起任务：落盘（或登记到内存）→ 置 running → 立刻返回 jobId
② poll    页面按 1~2 秒调一次状态接口 → 拿到 running / 进度
③ done    任务结束时写正式数据（jsonstore）→ 状态置 done / error，结果里带上新数据的 id
```

### 5.2 服务端骨架

```js
// server/lib/reading.mjs（节选）
const jobs = new Map()   // 内存任务表；要跨重启就把快照写进 dataDir()（见下）

export function startImport(url) {
  const id = `j_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const job = { id, url, status: 'running', progress: 0, startedAt: Date.now(), error: null, resultId: null }
  jobs.set(id, job)
  void run(job)               // 关键：不 await，立刻把控制权还给请求
  return { ok: true, job }
}

async function run(job) {
  try {
    job.progress = 10
    const text = await fetchText(job.url)
    job.progress = 60
    const note = add(text)             // 落盘走 jsonstore
    job.resultId = note.note?.id ?? null
    job.status = 'done'
  } catch (err) {
    job.status = 'error'
    job.error = err.message
  } finally {
    job.progress = 100
    job.finishedAt = Date.now()
  }
}

export function jobStatus(id) {
  const job = jobs.get(id)
  if (!job) return { ok: false, error: `没有这个任务：${id}` }
  return { ok: true, job }
}
```

```js
// server/index.mjs
route('POST', /^\/api\/reading\/import$/, (req, { body }) => reading.startImport(String(body?.url ?? '')))
route('GET',  /^\/api\/reading\/job$/, (req, { query }) => reading.jobStatus(String(query.id ?? '')))
```

**要跨重启可见就得落盘**：随记的任务快照写在 `server/data/memo/jobs.json`，边车重启后会把死掉的 `running` 标成 `interrupted`；知识库更彻底 —— 队列本身就是一个落盘的状态机 `pending → parsing → extracted → ingesting → done/error`，每一步的结果写回队列项，所以页面刷新后能看到进行到哪了（`server/lib/wiki-queue.mjs`）。挑一个抄。

### 5.3 前端骨架

```ts
let timer: ReturnType<typeof setInterval> | null = null

function stopPoll() {
  if (timer) clearInterval(timer)
  timer = null
}

function pollJob(id: string) {
  stopPoll()
  const tick = async () => {
    const r = await api.readingJob(id)
    if (!r.ok) return
    job.value = r.data?.job ?? job.value
    const st = job.value?.status
    if (st && st !== 'running') {
      stopPoll()                                  // 终态就停，别一直轮
      if (st === 'done') {
        ElMessage.success('导入完成')
        await load()                              // 正式数据这时才落盘，重新拉一次
      } else {
        ElMessage.error(job.value.error ?? '导入失败')
      }
    }
  }
  void tick()                                     // 先立即打一次，别白等一个间隔
  timer = setInterval(tick, 1500)
}

onUnmounted(stopPoll)                             // 页面切走必须清掉，否则后台空转
```

仓库里的现成实例：`src/features/memo/MemoView.vue`（1.5 秒轮询转写任务，终态时刷新记录列表并打开新记录）、`src/features/wiki/WikiIngestView.vue`（3 秒轮询入库队列）、`src/features/guard/*`（端口 8 秒、智能体 10 秒、概览 12 秒）。两处细节值得照抄：**先立即 tick 一次**、**终态停止 + `onUnmounted` 清理**。

### 5.4 二进制上传走单独的通道

上传文件不要塞 JSON：`POST` 一个 `application/octet-stream` 的请求体，文件名放 `?name=`，边车侧 `readBody()` 会给你 `body.__bin`（`Buffer`）。随记的上传就是这个形状：

```js
route('POST', /^\/api\/memo\/upload$/, (req, { body, query }) => {
  const buf = body?.__bin
  if (!buf?.length) return { ok: false, error: '没有收到文件内容（要用 application/octet-stream 发原文件）' }
  return { ok: true, path: memo.stashUploadedAudio(String(query.name ?? ''), buf) }
})
```

上传本身通常是可以「一个请求里等完」的（大文件才需要任务化 —— 见 [文件传输.md](文件传输.md) 的约定）。

### 5.5 什么时候用 SSE

要「边生成边看」的才用它：`POST /api/memo/summarize/stream`（逐字推总结）与知识库问答的流式回答。写法是 handler 里 `res.writeHead(200, { 'Content-Type': 'text/event-stream', … })`，用 `res.on('close')` 建 `AbortController` 取消后端调用，最后**必须 `return 'handled'`**（分发处就不再动响应）。前端的读法见 `src/core/sidecar.ts` 的 `memoSummarizeStream` / `wikiChatStream`（不用 `EventSource`，因为它不能 POST、也带不上令牌头）。

**长任务仍然用轮询**：SSE 适合「几十秒的生成」，不适合「几分钟的后台任务」—— 用户会关页面、会断线，而任务不该因此丢。

---

## 6. 别这么做（坑）

1. **不要在页面里直连外部接口**（`fetch('https://api.xxx.com/…')`）。CORS 会被挡、密钥会进浏览器、页面被 XSS 就等于凭据泄露。一律「前端 → 边车 → 外部」。
2. **不要在一个请求里等长任务**。5 分钟的 `requestTimeout` 会在最需要它的时候掐掉你（§5.1）。
3. **不要自己 `fs.writeFileSync` 写业务 JSON**。绕过原子写，一次中断就是半截文件；绕过 `.bak` 与快照，坏了就没得回退；绕过 `rev`，并发写会静默丢数据。用 `createJsonStore`（§4）。
4. **不要在路由处理器里 `throw`**。兜底会把请求收成 500 + `接口内部出错：…`（`server/index.mjs` 的分发处），但那是最后一道网。返回 `{ ok:false, error:'人话' }`，让页面能直接把原因显示出来。
5. **不要把密钥、令牌、个人绝对路径写进代码 / 模块定义 / 文档**。密钥进 `SECRET_PATHS`（落 `credentials.json`），路径进 `DEFAULTS` 且默认留空；`config.example.json` 里用中性示例（`C:\资料\我的笔记`、`/path/to/doc.pdf`），**不要拿作者机器的路径当示例** —— 那是误导不是配置。
6. **不要为了加功能改内核**（`src/core/*`、`src/router/index.ts`、`src/shell/AppShell.vue`）。注册表已经派生了导航与路由；改内核意味着所有模块跟着你漂。真需要内核级能力（新的可见性钩子、新的分组），那是一次单独的、要想清楚向后兼容的改动。
7. **不要另起一套 localStorage key**。走 `@/core/storage` 的 `loadJSON/saveJSON`，它统一挂在 `workstation.` 命名空间下，设置页的「导出 / 恢复 / 清理」才认得出你的数据。
8. **不要在 `.vue` 里显式 import Element Plus 的组件**（模板里写标签，按需插件负责样式）。唯一例外是 `ElMessage` / `ElMessageBox` —— `main.ts` 全局引了它们的样式，显式 import 是安全的（现有十几个文件都这么写）。
9. **不要用没进白名单的图标名**。图标是运行时按字符串解析的，漏了就是空白；`src/main.ts` 的 `import` 与 `ICONS` 两处要同步。`npm test` 会拦（`scripts/tests/module-contract.test.mjs`：图标必须在白名单里，且两处一致）。
10. **不要把 `router-view` 包进 `<transition>`**。`src/App.vue` 的注释写了原因：Vue 的过渡靠 `transitionend`，渲染被节流或暂停时（后台标签、无头环境）旧页面会永久残留 —— 表现为切换路由后新旧页面同时挂在 DOM 上。
11. **不要在 MCP 里只改一半**：`TOOLS` 要写 `name`，`HANDLERS` 要有同名方法。写错只在调用时回「未知工具」，没有测试会拦你（`server/mcp.mjs`）。
12. **不要忽略 `visible()`**。依赖没配好就让它从侧边栏消失，比让人点进去看一页报错体贴，而且是内核约定（`src/core/appconfig.ts`）。
13. **不要把个人数据当内置数据放进 `src/`**。内置的东西会跟着代码一起分发（`src/features/vocab/builtin.ts` 的注释就是这条规矩：内置词单只能是无版权顾虑的自写内容，换成自己的词走「导入」）。同理，示例数据放 `server/data/` 的示例文件里，别写进 lib。
14. **不要在轮询里忘记清理**。`onUnmounted` 里 `clearInterval`（§5.3），否则页面切走后还在打接口。
15. **不要把 `logs/` 之类运行时产物加进版本库**，也不要 `git add -f` 强加 `server/config.json` / `credentials.json` / `server/data/` 里的个人内容 —— 提交前 `git status --short` 看一眼（`.gitignore` 的放行规则见 [verifying.md](verifying.md) 第 5 节）。

---

## 7. 参考资料

| 想知道什么 | 看哪 |
|---|---|
| 分层与数据流、一次请求的完整链路、鉴权握手、边车的启动与生命周期、从前身模块留下的设计教训 | [ARCHITECTURE.md](ARCHITECTURE.md) |
| 已注册的模块清单、边车能力清单、MCP 工具与外部依赖清单、**本开源版移除了什么** | [FEATURES.md](FEATURES.md) |
| 配置项逐项说明、页面上能改哪些、怎么换令牌 / 改端口 | [CONFIG.md](CONFIG.md) |
| 哪六类东西不该进仓库、怎么复查 | [PRIVACY.md](PRIVACY.md) |
| 已知慢点与首屏体积 | [PERFORMANCE.md](PERFORMANCE.md) |
| 颜色 / 字号 / 间距 / 组件纪律 | [design-system.md](design-system.md) |
| 改完怎么验、哪些改动要额外看一眼 | [verifying.md](verifying.md) |
| 校历文件格式 | [校历格式.md](校历格式.md) |
| 「每日一句」句库怎么导 | [每日一句导入.md](每日一句导入.md) |
| 文件传输 provider 要实现哪些函数 | [文件传输.md](文件传输.md) |
| 页面上的三步上手示例 | `#/dev-guide`（`src/views/DevGuideView.vue`） |
| **想跳过手工步骤**：一条命令生成模块骨架（含注册、图标白名单、按需的后端与配置） | `node scripts/new-feature.mjs --help`；骨架与逐项替换表在 `src/features/_template/` |
| 谁在替我守这些约定（注册表 / 图标 / 路由 / 配置白名单） | `scripts/tests/module-contract.test.mjs`、`scripts/tests/config-whitelist.test.mjs` —— `npm test` 会跑到；CI 见仓库根 `.github/workflows/ci.yml` |
| 现成的写法参照 | 模块：`src/features/plan/`（最简）、`src/features/service/`（一页 + 一条接口，最小完整例）、`src/features/vocab/`（多子页 + store）、`src/features/wiki/`（最复杂）<br>边车：`server/lib/plan.mjs`（jsonstore）、`server/lib/memo.mjs`（长任务 + SSE）、`server/lib/wiki-queue.mjs`（落盘队列） |
