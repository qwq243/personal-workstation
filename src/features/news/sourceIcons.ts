/**
 * 信息来源的「平台图标」：一个源一枚，写在 `NewsView.vue` / `NewsCard.vue` 里 import。
 * 全部是简单的扁平 SVG，颜色走**设计令牌**（`--ws-*`）而不是写死 ——
 * 只把「黑色/白色」那一处用 `currentColor` 挖出来，暗色主题自动跟上，不用另维护一套。
 *
 * 新增源时在这里 + 页面的 `SOURCE_ICON` 表各补一条（两边都要），
 * 否则会退化成通用的 RSS 图标：能点，但认不出是哪家。
 */
export { default as ChsiIcon } from './icons/ChsiIcon.vue'
export { default as XIcon } from './icons/XIcon.vue'
export { default as LinuxDoIcon } from './icons/LinuxDoIcon.vue'
export { default as V2exIcon } from './icons/V2exIcon.vue'
export { default as HnIcon } from './icons/HnIcon.vue'
export { default as GithubIcon } from './icons/GithubIcon.vue'
export { default as SspaiIcon } from './icons/SspaiIcon.vue'
export { default as WeixinIcon } from './icons/WeixinIcon.vue'
export { default as RssIcon } from './icons/RssIcon.vue'
