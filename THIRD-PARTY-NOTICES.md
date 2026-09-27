# 第三方来源与许可（THIRD-PARTY NOTICES）

本项目自身以 **MIT** 分发，见仓库根目录的 [`LICENSE`](LICENSE)。
这份文件把「仓库里/构建产物里还有谁的代码」逐项列清楚，供再分发时一并携带。

生成方式（2026-09-27 实测，与本机 `node_modules` 一致）：

```bash
# ① 直接依赖与版本/许可
node -e "for (const n of ['vue','vue-router','pinia','element-plus','@element-plus/icons-vue','katex']) { const p=require('./node_modules/'+n+'/package.json'); console.log(p.name,p.version,p.license) }"

# ② 传递依赖闭包：按 package-lock.json 的 dependencies 图，从 6 个运行时依赖出发做可达闭包
#    （脚本见本文件末尾「附录 B」的说明；结果就是下面第 3 节那张表）

# ③ KaTeX 字体是否与上游逐字节相同
for f in src/assets/katex-fonts/*.woff2; do b=$(basename "$f"); md5sum "$f" "node_modules/katex/dist/fonts/$b"; done
```

---

## 1. 本项目自身

- **`server/` 下 0 个第三方依赖**：只有 `node:` 内置模块与相对路径（`crypto` `fs` `fs/promises`
  `http` `net` `os` `path` `url` `zlib`）。`server/mcp.mjs` 的 JSON-RPC 是手写的子集，没引 MCP SDK。
  所以后端这一半**没有第三方许可需要携带**。
- **前端**依赖如下三节。构建后它们会被内联进 `dist/assets/*.js`，所以「分发 `dist/`」与
  「分发源码」两种情形都要带这份文件（或至少带 `LICENSE` 与本文件）。

---

## 2. 前端运行时直接依赖（`dependencies`，6 个）

版本与许可取自 `node_modules/<包>/package.json` 的 `version` / `license` 字段。

| 包 | 版本 | 许可 | 在本项目里做什么 |
|---|---|---|---|
| [vue](https://github.com/vuejs/core) | 3.5.42 | MIT | 前端框架 |
| [vue-router](https://github.com/vuejs/router) | 4.6.4 | MIT | hash 路由（路由表由注册表派生） |
| [pinia](https://github.com/vuejs/pinia) | 3.0.4 | MIT | 全局状态（UI 主题、词单 store…） |
| [element-plus](https://github.com/element-plus/element-plus) | 2.14.5 | MIT | 组件库（按需引入，见 `vite.config.ts`） |
| [@element-plus/icons-vue](https://github.com/element-plus/element-plus-icons) | 2.3.2 | MIT | 图标（**必须在 `src/main.ts` 白名单里显式列名**，见该文件注释） |
| [katex](https://github.com/KaTeX/KaTeX) | 0.16.47 | MIT | 知识库正文里的 `$…$` 真 LaTeX 排版 |

## 3. 前端运行时依赖的**传递闭包**（共 59 个包，含上面 6 个）

`npm ci` 之后 `node_modules` 里，从上面 6 个包可达的全部包 —— 都由同一个 `package-lock.json` 锁定。
**其中大部分是打包期的编译器/工具**（`@vue/compiler-*`、`postcss`、`@babel/*`、`magic-string` 等），
真正的运行时代码由 Vite 摇树后内联进 `dist/`；这里按「可能被内联」从严全列。

| 包 | 版本 | 许可 |
|---|---|---|
| @babel/helper-string-parser | 7.29.7 | MIT |
| @babel/helper-validator-identifier | 7.29.7 | MIT |
| @babel/parser | 7.29.8 | MIT |
| @babel/types | 7.29.8 | MIT |
| @ctrl/tinycolor | 4.2.1 | MIT |
| @element-plus/icons-vue | 2.3.2 | MIT |
| @floating-ui/core | 1.8.0 | MIT |
| @floating-ui/dom | 1.8.0 | MIT |
| @floating-ui/utils | 0.2.12 | MIT |
| @jridgewell/sourcemap-codec | 1.6.0 | MIT |
| @popperjs/core | 2.11.8 | MIT |
| @types/lodash | 4.17.25 | MIT |
| @types/lodash-es | 4.17.12 | MIT |
| @types/web-bluetooth | 0.0.21 | MIT |
| @vue/compiler-core | 3.5.42 | MIT |
| @vue/compiler-dom | 3.5.42 | MIT |
| @vue/compiler-sfc | 3.5.42 | MIT |
| @vue/compiler-ssr | 3.5.42 | MIT |
| @vue/devtools-api | 7.7.10 | MIT |
| @vue/devtools-kit | 7.7.10 | MIT |
| @vue/devtools-shared | 7.7.10 | MIT |
| @vue/reactivity | 3.5.42 | MIT |
| @vue/runtime-core | 3.5.42 | MIT |
| @vue/runtime-dom | 3.5.42 | MIT |
| @vue/server-renderer | 3.5.42 | MIT |
| @vue/shared | 3.5.42 | MIT |
| @vueuse/core | 14.4.0 | MIT |
| @vueuse/metadata | 14.4.0 | MIT |
| @vueuse/shared | 14.4.0 | MIT |
| async-validator | 4.2.5 | MIT |
| birpc | 2.9.0 | MIT |
| commander | 8.3.0 | MIT |
| copy-anything | 4.1.0 | MIT |
| csstype | 3.2.3 | MIT |
| dayjs | 1.11.23 | MIT |
| element-plus | 2.14.5 | MIT |
| entities | 7.0.1 | **BSD-2-Clause** |
| estree-walker | 2.0.2 | MIT |
| hookable | 5.5.3 | MIT |
| katex | 0.16.47 | MIT |
| lodash | 4.18.1 | MIT |
| lodash-es | 4.18.1 | MIT |
| lodash-unified | 1.0.3 | MIT |
| magic-string | 0.30.21 | MIT |
| memoize-one | 6.0.0 | MIT |
| mitt | 3.0.1 | MIT |
| nanoid | 3.3.19 | MIT |
| normalize-wheel-es | 1.2.0 | **BSD-3-Clause** |
| perfect-debounce | 1.0.0 | MIT |
| picocolors | 1.1.1 | **ISC** |
| pinia | 3.0.4 | MIT |
| postcss | 8.5.28 | MIT |
| rfdc | 1.4.1 | MIT |
| source-map-js | 1.2.1 | **BSD-3-Clause** |
| speakingurl | 14.0.1 | **BSD-3-Clause** |
| superjson | 2.2.6 | MIT |
| vue | 3.5.42 | MIT |
| vue-component-type-helpers | 3.3.11 | MIT |
| vue-router | 4.6.4 | MIT |

**非 MIT 的四项**（再分发时请保留其许可声明）：
`entities`（BSD-2-Clause）、`normalize-wheel-es` / `source-map-js` / `speakingurl`（BSD-3-Clause）、
`picocolors`（ISC）。三者都与 MIT 兼容，**不需要**把本项目改成别的许可。

## 4. 构建期依赖（`devDependencies`，7 个）

它们只在 `npm install` / `npm run build` 时用到，**不随 `dist/` 分发**；但如果你是**分发源码**，
对方装依赖时会看到它们，所以一并列出（版本/许可同样取自 `node_modules/<包>/package.json`）。

| 包 | 版本 | 许可 |
|---|---|---|
| [vite](https://github.com/vitejs/vite) | 7.3.6 | MIT |
| [@vitejs/plugin-vue](https://github.com/vitejs/vite-plugin-vue) | 6.0.8 | MIT |
| [typescript](https://github.com/microsoft/TypeScript) | 5.9.3 | **Apache-2.0** |
| [vue-tsc](https://github.com/vuejs/language-tools) | 3.3.11 | MIT |
| [unplugin-auto-import](https://github.com/unplugin/unplugin-auto-import) | 21.1.0 | MIT |
| [unplugin-vue-components](https://github.com/unplugin/unplugin-vue-components) | 32.1.0 | MIT |
| [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped) | 22.20.2 | MIT |

> TypeScript 是唯一 Apache-2.0 的构建期依赖。它**不在 `server/` 里、也不进 `dist/`** ——
> 只在 `npm run typecheck`（`vue-tsc`）与 `.ts` 类型剥离时用到。

## 5. 仓库里随代码分发的**非 npm 资源**

这些不是 `npm install` 装来的，是直接躺在仓库里的文件，所以单独说明：

### 5.1 `src/assets/katex-fonts/*.woff2`（5 个）—— 上游 KaTeX 字体，MIT ✅ 已核实

| 文件 | 大小 |
|---|---|
| `KaTeX_Main-Regular.woff2` | 26,272 B |
| `KaTeX_Main-Bold.woff2` | 25,324 B |
| `KaTeX_Main-Italic.woff2` | 16,988 B |
| `KaTeX_Math-Italic.woff2` | 16,440 B |
| `KaTeX_Size1-Regular.woff2` | 5,468 B |

**核实结论（2026-09-27）**：这 5 个文件与 `node_modules/katex/dist/fonts/` 下的同名文件
**逐字节相同**（`md5sum` 两两一致，命令见文件开头第 ③ 条）。也就是说它们是 **KaTeX 发行版自带的字体**
（上游 KaTeX 为 MIT），不是第三方字体 —— 随本项目按 MIT 分发没有问题，署名要求由上面的
KaTeX 条目覆盖。之所以拷进仓库而不是从 `node_modules` 引用，见 `src/features/wiki/math-typeset.ts`
与 `vite.config.ts` 里字体打包的注释。

### 5.2 `src/assets/brand/ws-logo.webp` —— ⚠️ **唯一一处许可待权利人确认**

- 文件：`src/assets/brand/ws-logo.webp`，10,654 B，WebP（`RIFF/WEBP`，chunk 只有 `VP8X` / `ALPH` / `VP8`）。
- **仓库内没有留下它的来源记录**：既没有同名 `.svg` / `.ai` 之类源文件，文档里也没有出处说明。
- **文件里也没有署名线索**：2026-09-27 用 RIFF chunk 扫描确认，不含 `EXIF` / `XMP` / `ICCP` 等
  可能带作者信息的 chunk（只有上述三个），所以无法从文件本身判断它是不是原创。
- **结论**：这一处的来源**无法由代码或文件自己证明**，因此**不在本文件任何「已核实」的说法里**。
  它是仓库自带资源，随本项目一起按 `LICENSE`（MIT）分发；**如果它其实来自某个素材站或图标库**，
  权利人需要在此补一行「来源 URL + 该素材的许可」，并遵守其署名 / 商用条款。

> 处理建议（二选一，都是一行改动）：
> 1. 若为本项目自制 —— 把上面这段换成一句「本项目自制（2026），随本项目 MIT 分发」；
> 2. 若来自第三方 —— 补「来源：<URL>，许可：<许可名>，署名要求：<有/无>」。

### 5.3 示例数据与模板

`server/data/` 下提交的 7 个示例文件（`.gitkeep`、`README.md`、`dashboard.json`、`plan.json`、
`school-calendar.json`、`vocab/lists.json`、`vocab/progress.json`）与 `server/config.example.json`
都是本项目自造的**空结构或中性示例**（校历里那所「示例大学」是虚构的），不含第三方内容。

## 6. 一句话总结

- 后端（`server/`）：**零第三方依赖**，无授权负担。
- 前端：全部宽松许可（MIT 为主，另有 BSD-2 / BSD-3 / ISC / Apache-2.0 各一两类），
  与本项目的 MIT **兼容**，可以一起再分发。
- 随代码分发的非 npm 资源：KaTeX 字体**已核实**为上游 MIT；
  **`ws-logo.webp` 是唯一待确认项**（见 5.2）。

---

### 附录 B：第 3 节那张表是怎么算出来的

一个临时的零依赖 Node 脚本（**没有提交进仓库**，也不需要长期留着）就能复现，判据只有两条：

1. 起点 = `package.json` 的 6 个 `dependencies`；
2. 沿 `package-lock.json` 的 `packages['node_modules/<包名>'].dependencies` 做广度优先遍历，
   得到可达闭包；每个包的 `version` / `license` 依次取 lockfile 字段 → 已安装的
   `node_modules/<包>/package.json` 字段。

之所以用**闭包**而不是只列 `package.json` 里那 6 个：MIT 的署名义务跟着**实际分发的代码**走，
而 Vite 会把传递依赖一并内联进 `dist/assets/*.js`。只列直接依赖会漏掉 `lodash-es`（element-plus 用）、
`@ctrl/tinycolor`（element-plus 用）这类真正进了产物的包。

要复查只需重新跑一遍上面的第 ① ③ 两条命令 + 这个闭包遍历；`npm ci` 之后结果应与本文件一致。
