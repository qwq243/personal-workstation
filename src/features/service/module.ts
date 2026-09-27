/**
 * 运行与自启 —— 开机自启这条链的页面入口（`#/service`）。
 *
 * 只回答一个问题：「关掉终端之后，工作台还会自己起来吗」—— 边车进程状态 + 自启位体检 + 开启 / 关闭 / 删除。
 * 没有「重启边车」按钮：边车重启自己会先把自己杀掉、请求没人接，要重启就跑 `npm run server`。
 * 依赖 Windows 的启动文件夹 / `.lnk` / `wscript.exe`；换平台要连同 `panel.mjs` / `autostart.mjs` 另做实现。
 */
import type { WorkstationModule } from '@/core/types'

export const serviceModule: WorkstationModule = {
  id: 'service',
  name: '运行与自启',
  description: '边车自己的状态与开机自启位：端口与 PID、自启项体检（编码 / 路径 / 用的哪个 node），以及开启 / 关闭 / 删除。',
  icon: 'Monitor',
  color: '#0891b2',
  // 不填 category = 置顶入口（和「进程守护」一样：都是「本机后台服务」这一类，不属于任何分组）
  order: 8,
  homePath: '/service',
  routes: [
    {
      path: '/service',
      name: 'service-home',
      component: () => import('./ServiceView.vue'),
      // 单页模块：不在侧边栏挂二级菜单（避免二级项与功能名重复）
      meta: { title: '运行与自启', icon: 'Monitor', hideInNav: true },
    },
  ],
}
