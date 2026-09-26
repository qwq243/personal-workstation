import 'vue-router'

declare module 'vue-router' {
  interface RouteMeta {
    /** 页面标题，会显示在顶栏，并用于侧边栏二级菜单文案 */
    title?: string
    /** Element Plus 图标名，用于侧边栏二级菜单 */
    icon?: string
    /** 不在侧边栏二级菜单中出现 */
    hideInNav?: boolean
  }
}
