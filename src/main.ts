import { createApp } from 'vue'
import type { Component } from 'vue'
import { createPinia } from 'pinia'
// ↓ 新图标加在这里（import 与 ICONS 两处）
import {
  Aim, AlarmClock, ArrowDown, ArrowLeft, ArrowRight, Bell, Box, Briefcase, Calendar, ChatDotRound,
  CaretBottom, CaretRight, Checked, CircleCheck, CircleCheckFilled, CircleCloseFilled, Clock, Close, CloseBold, Cloudy, Coin, Compass, Connection, CopyDocument, Cpu, DataBoard,
  DataLine,
  Delete, Document, Download, EditPen, Expand, Film, Files, Finished, Flag, Fold, FolderOpened, Grid, Headset, Hide, Histogram, InfoFilled, Iphone, Key, Link, Loading,
  List, Location, MagicStick, Menu, Microphone, Minus, Monitor, Moon, MoreFilled, Notebook, Opportunity, Picture, Plus, Printer, Promotion, Reading, Refresh, RefreshRight,
  Right, Search, Select, Setting, Share, Star, StarFilled, SuccessFilled, Sunny, Switch, SwitchButton, Timer, Tools, TrendCharts, Trophy,
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

import App from './App.vue'
import { createAppRouter, takeResumePath } from './router'
import { registerAllModules } from './features'
import { loadAppConfig } from './core/appconfig'
import { getModules } from '@/core/registry'
import { MODULE_GROUPS } from '@/core/types'

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
 * 维护：新增功能若图标不显示（侧边栏 / 页面里那块空白），十有八九是名字没在这里。
 * 加名字要改**两处**，就是下面这两个锚点标出来的地方 —— 它们必须一致
 * （顶上 `import { … } from '@element-plus/icons-vue'` 一次，`ICONS` 映射一次）。
 * 这是「加一个模块」里唯一漏了不会报错的步骤（模板按字符串解析图标，打包器看不出来），
 * 所以两处都留了锚点注释，grep 「新图标加在这里」就能定位。
 */
// ↓ 新图标加在这里（import 与 ICONS 两处）
const ICONS: Record<string, Component> = {
  Aim, AlarmClock, ArrowDown, ArrowLeft, ArrowRight, Bell, Box, Briefcase, Calendar, ChatDotRound,
  CaretBottom, CaretRight, Checked, CircleCheck, CircleCheckFilled, CircleCloseFilled, Clock, Close, CloseBold, Cloudy, Coin, Compass, Connection, CopyDocument, Cpu, DataBoard,
  DataLine,
  Delete, Document, Download, EditPen, Expand, Film, Files, Finished, Flag, Fold, FolderOpened, Grid, Headset, Hide, Histogram, InfoFilled, Iphone, Key, Link, Loading,
  List, Location, MagicStick, Menu, Microphone, Minus, Monitor, Moon, MoreFilled, Notebook, Opportunity, Picture, Plus, Printer, Promotion, Reading, Refresh, RefreshRight,
  Right, Search, Select, Setting, Share, Star, StarFilled, SuccessFilled, Sunny, Switch, SwitchButton, Timer, Tools, TrendCharts, Trophy,
  Upload, User, UserFilled, VideoCamera, VideoPause, VideoPlay, View, Wallet, WarningFilled,
}

for (const [name, comp] of Object.entries(ICONS)) {
  app.component(name, comp)
}

/**
 * 图标自检：模块与分组的 `icon` 是按字符串解析的，漏进上面两份列表**不会报错**，
 * 只是那一处空白。大写字母开头的一律按组件名看待（emoji 那类跳过，它本来就该按纯文本渲染）。
 */
for (const mod of getModules()) {
  if (/^[A-Z]/.test(mod.icon) && !ICONS[mod.icon]) {
    console.warn(`[icons] 功能「${mod.name}」的图标 ${mod.icon} 不在白名单里，会显示为空白（src/main.ts）`)
  }
}
for (const g of MODULE_GROUPS) {
  if (/^[A-Z]/.test(g.icon) && !ICONS[g.icon]) {
    console.warn(`[icons] 分组「${g.name}」的图标 ${g.icon} 不在白名单里，会显示为空白（src/main.ts）`)
  }
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
