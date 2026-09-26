import { createApp } from 'vue'
import type { Component } from 'vue'
import { createPinia } from 'pinia'
import {
  AlarmClock, ArrowDown, ArrowLeft, ArrowRight, Bell, Box, Briefcase, Calendar, ChatDotRound,
  Checked, CircleCheck, CircleCheckFilled, CircleCloseFilled, Clock, Close, CloseBold, Cloudy, Coin, Compass, Connection, CopyDocument, DataBoard,
  DataLine,
  Delete, Document, Download, EditPen, Expand, Files, Finished, Flag, Fold, FolderOpened, Grid, Headset, Hide, Histogram, InfoFilled, Iphone, Key, Link,
  List, Location, MagicStick, Microphone, Minus, Monitor, Moon, MoreFilled, Notebook, Opportunity, Picture, Plus, Reading, Refresh, RefreshRight,
  Right, Search, Select, Setting, Share, SuccessFilled, Sunny, Switch, SwitchButton, Timer, TrendCharts, Trophy,
  Upload, User, UserFilled, VideoCamera, VideoPause, VideoPlay, View, Wallet, WarningFilled,
} from '@element-plus/icons-vue'

import 'element-plus/theme-chalk/dark/css-vars.css'
/**
 * Message 与 MessageBox 是命令式调用，没有模板标签，按需引入只在「调用它的那个
 * .vue」里注入样式。两个例外会让弹窗变成无样式裸框：
 *  - 调用发生在 .ts 里（auto-import 不扫 .ts，只能显式导入，显式导入又让引用它的
 *    页面不再注入样式）；
 *  - 某个 .vue 自己写了 `import { ElMessage } from 'element-plus'`。
 * 这两份样式很小，全局引一份，所有页面的提示和确认框都有样式。
 */
import 'element-plus/es/components/message/style/css'
import 'element-plus/es/components/message-box/style/css'
import '@/styles/index.css'
// 知识库模块的内部观感（卡片/表格/标签/指标卡），8 个界面共用一份
import '@/styles/wiki.css'
// KaTeX：知识库正文里的 $...$ 真 LaTeX 用（math-typeset.ts 调 renderToString），
// 裸上下标那套（e^{x}、∫_0^∞）是自己排的、不吃这份 CSS
import 'katex/dist/katex.min.css'

import App from './App.vue'
import { createAppRouter, takeResumePath } from './router'
import { registerAllModules } from './features'
import { loadAppConfig } from './core/appconfig'

// 先注册功能模块，再创建路由（路由表由注册表派生）
registerAllModules()

const app = createApp(App)

app.use(createPinia())

/**
 * 全局图标白名单。
 *
 * 为什么必须显式列出来、而不能像组件那样按需自动引入：
 * 模板里的图标是**按字符串名动态解析**的 —— `<component :is="mod.icon">`，
 * 值来自各 module.ts 的 `icon: 'Grid'` / `<PageHeader icon="Setting">` 这类字符串。
 * 动态名字静态分析不出来，所以只能全局注册。
 *
 * 为什么用「命名导入 + 显式映射」而不是 `import * as Icons`：
 * 命名空间导入 + 动态取键（`Icons[name]`）会让打包器无法摇树，294 个图标会全部进包；
 * 只命名导入用到的这几十个，其余两百多个（约 80%）才能被裁掉。
 *
 * 维护：新增功能若图标不显示，多半是名字没在这里。把名字加进下面两个列表即可
 * —— 两处必须一致（import 与映射各一次）。
 */
const ICONS: Record<string, Component> = {
  AlarmClock, ArrowDown, ArrowLeft, ArrowRight, Bell, Box, Briefcase, Calendar, ChatDotRound,
  Checked, CircleCheck, CircleCheckFilled, CircleCloseFilled, Clock, Close, CloseBold, Cloudy, Coin, Compass, Connection, CopyDocument, DataBoard,
  DataLine,
  Delete, Document, Download, EditPen, Expand, Files, Finished, Flag, Fold, FolderOpened, Grid, Headset, Hide, Histogram, InfoFilled, Iphone, Key, Link,
  List, Location, MagicStick, Microphone, Minus, Monitor, Moon, MoreFilled, Notebook, Opportunity, Picture, Plus, Reading, Refresh, RefreshRight,
  Right, Search, Select, Setting, Share, SuccessFilled, Sunny, Switch, SwitchButton, Timer, TrendCharts, Trophy,
  Upload, User, UserFilled, VideoCamera, VideoPause, VideoPlay, View, Wallet, WarningFilled,
}

for (const [name, comp] of Object.entries(ICONS)) {
  app.component(name, comp)
}

/**
 * 配置要在建路由**之前**取一次。
 *
 * 原因：`collectRoutes()` 会按各模块的 `visible()` 过滤，而「没配 = 不显示」是内核约定
 * （见 core/appconfig.ts）。配置晚到的话，路由表就少了几条 —— 页面刷新能补上，
 * 但首次进入会「点了没反应」。
 *
 * 边车不在也照样往下走：loadAppConfig 内部吞掉错误，所有 visible() 当可见，
 * 页面自己的 SidecarOffline 会给出启动指引。
 */
void loadAppConfig().finally(() => {
  // Element Plus 不再全量 app.use(ElementPlus)：组件与 ElMessage 等由 unplugin 按需引入，
  // 中文 locale 交给 App.vue 的 <el-config-provider>。
  const router = createAppRouter()
  app.use(router)

  // 自愈重载回来后，接上重载前想切的那一页（见 router/index.ts 的 recoverFromStaleBuild）。
  // 等 isReady 再跳，避免和首次导航抢先后。
  router.isReady().then(() => {
    const resume = takeResumePath()
    if (resume && resume !== router.currentRoute.value.fullPath) void router.replace(resume)
  })

  app.mount('#app')
})
