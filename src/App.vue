<script setup lang="ts">
import AppShell from '@/shell/AppShell.vue'
import { useUiStore } from '@/core/ui'
import zhCn from 'element-plus/es/locale/lang/zh-cn'

// 初始化主题（在 store 内部已 watch，这里只是确保组件树创建时就绑定）
useUiStore()
</script>

<template>
  <!--
    Element Plus 改成按需引入后，中文 locale 不能再由 app.use(ElementPlus, { locale }) 提供，
    改在这里的 ConfigProvider 给出。el-config-provider 是**无包裹元素**的（只渲染默认插槽），
    所以套在 AppShell 外面不会多一层 DOM、不影响整体 flex 布局。
    少了它，日期选择器、分页等组件会退回英文。
  -->
  <el-config-provider :locale="zhCn">
    <AppShell>
      <!--
        刻意不用 <transition> 包裹路由视图：
        Vue 的过渡依赖 transitionend 事件来完成卸载，而浏览器的渲染/合成被节流或
        暂停时（后台标签页、无头/未合成的环境）过渡事件不会到达，旧页面会永久残留，
        表现为路由切换后新旧页面同时挂在 DOM 上。功能页面都是懒加载的异步组件，
        一旦卡住很难自愈。这里直接渲染，保证导航永远可靠；视觉动效交给 CSS 悬停态。
      -->
      <router-view />
    </AppShell>
  </el-config-provider>
</template>
