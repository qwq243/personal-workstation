# 文件传输 provider（这里现在是空的）

这个目录是给**你自己**放文件传输实现的（WebDAV / S3 / rclone / 局域网共享都行）。

仓库刻意不带任何云盘实现：**不带任何依赖第三方客户端私有接口 / 逆向的能力** ——
那种实现换个版本就失效，也要把你的账号登录态交给工具。

接口约定、要导出的函数、以及「任务化 / 凭据只存一处 / 别名目录要可配」三条约定，
见 **`docs/文件传输.md`**（仓库根下 `docs/` 里）。

写完一个 provider 之后，照 `docs/ARCHITECTURE.md` 的三步法接进来：
`server/config.mjs` 加一节配置 → `server/index.mjs` 加 `/api/*` 路由 →
`src/features/transfer/` 加模块并在 `src/features/index.ts` 注册。
