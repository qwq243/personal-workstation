/// <reference types="vite/client" />

/**
 * Vite 在构建期注入的环境变量。
 *
 * 只有 `VITE_` 前缀的会进前端包 —— 也就是说**这里面不能放任何密钥**。
 * 目前只用来指定边车地址（开发态需要；生产态同源，留空即可）。
 */
interface ImportMetaEnv {
  /** 边车地址，例如 http://127.0.0.1:5278。留空 = 同源相对路径 */
  readonly VITE_SIDECAR_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
