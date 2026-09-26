/** 静态资源模块声明（tsconfig 只开了 node types，没有 vite/client） */
declare module '*.webp' {
  const src: string
  export default src
}
declare module '*.png' {
  const src: string
  export default src
}
declare module '*.jpg' {
  const src: string
  export default src
}
declare module '*.svg' {
  const src: string
  export default src
}
