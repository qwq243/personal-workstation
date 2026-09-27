# 功能模板（`src/features/_template/`）

这个目录是**一份可以照抄的最小功能模块**，也是 `scripts/new-feature.mjs` 的输入
—— 生成器读的就是这两个文件，把下面那些「演示值」换成你的，其余一字不动。
所以这里改一次，生成出来的骨架跟着变，两边不会漂。

## 它为什么不会被自动注册（这是有意的）

`src/features/` 下**没有任何 glob / 自动扫描**：模块靠 `src/features/index.ts` 里
一条条 `registerModule(...)` 显式登记（`src/main.ts` 只调用 `registerAllModules()`）。
所以这个目录躺在那里既不会被注册、也不会出现在侧边栏。
下划线前缀只是给人和生成器看的约定（生成器会拒绝 `--id _template`，也不允许 id 以下划线开头）。

> 反过来说：**新建的模块目录也不会自动注册** —— 必须去 `src/features/index.ts` 加两行
> （生成器会自动加；手抄的话见 [docs/EXTENDING.md](../../../docs/EXTENDING.md) §2 第 4 步）。
> 这条约定有测试盯着：`scripts/tests/module-contract.test.mjs` 会发现「有模块文件但没注册」。

## 怎么用它

**推荐：跑生成器**（它会连注册、图标白名单、按需的后端文件一起改好）：

```bash
node scripts/new-feature.mjs reading --name 阅读笔记 --icon Reading --group study
node scripts/new-feature.mjs reading --name 阅读笔记 --icon Reading --group study --api --config
node scripts/new-feature.mjs reading --name 阅读笔记 --icon Reading --dry-run   # 只看会改什么
```

**或者手抄**：把这两个文件拷到 `src/features/<你的 id>/`，改名 `module.ts` /
`<Pascal>Home.vue`，然后按下面的表逐项替换，最后去 `src/features/index.ts` 注册。

## 演示值 → 你要替换成什么

### A. 字符串替换（生成器按**这个顺序**做，顺序本身有意义）

长串必须早于 `'template'`：`'template-home'` / `templateModule` / `TemplateHome` 都比它长，
先换短的会把自己换坏。

| # | 模板里的演示值 | 换成 | 出现在 |
|---|---|---|---|
| 1 | `TemplateHome` | `<Pascal>Home` | `module.ts` 的 `import('./TemplateHome.vue')`；输出文件名也用它 |
| 2 | `templateModule` | `<camel>Module`（导出的常量名） | `module.ts` |
| 3 | `'template-home'` | `'<id>-home'`（路由 name，全局唯一） | `module.ts` 的 `routes[].name` |
| 4 | `'template'` | `'<id>'` | `module.ts` 的 `id` |
| 5 | `template.dir` | `<camel>.dir`（配置项路径，要和在 `DEFAULTS` 里加的键一致） | `module.ts` 的 `visible()` |
| 6 | `/template`（**不是** `</template>`） | `/<--path>`（也含注释里的 `#/template`） | `homePath` / `routes[].path` / 两处注释 |
| 7 | `功能模板` | `--name` | `name` / `meta.title` / 页面标题 / `SidecarOffline` 的 `what` |
| 8 | `一句话说明这个功能干什么（改这一行）` | `--desc` | `description` 与页面副标题 |
| 9 | `'Grid'` 与 `"Grid"` | `'<--icon>'` / `"<--icon>"` | 模块 `icon`、`meta.icon`，以及 `.vue` 模板属性里的 `icon="Grid"`（单双引号两种都要换） |

> 第 6 条有个**真踩过的坑**：一开始用的是朴素的 `split('/template')`，它把 `</template>`
> 也改成了 `</reading>` —— 生成的 `.vue` 直接语法错误（"Invalid end tag"）。
> 现在用「前面不能是 `<` 或字母数字、后面不能是 `-` 或字母数字」限定，
> 并且生成器会在落盘前用 `@vue/compiler-sfc` 解析一遍生成的页面（见下）。

### B. 整行处理（生成器按功能开关决定）

| # | 模板里的那一行 | 什么情况下 | 变成 |
|---|---|---|---|
| 10 | `  order: 100, // 同组内越小越靠前…` | **总是** | `  order: <若同组当前最大值 +1>,`（同组 = 同一个 `category`；置顶区 = 所有没有 `category` 的模块） |
| 11 | `  // category: 'study',   // 归组…` | 传了 `--group` | `  category: '<--group>',`（整行替换，注释一起走） |
| 12 | `  // visible: () => cfgFilled('template.dir'), …` | 传了 `--config` | 去掉 `// ` 放开 |
| 13 | `// import { cfgFilled } from '@/core/appconfig' …` | 传了 `--config` | 去掉 `// ` 放开 |
| 14 | 页面里 `// const r = await api.templateItems()` 与下一行 | 传了 `--api` | 放开并改名成 `api.<camel>Items()` |

- **没传 `--group`** → 那一行保持注释（模块是**置顶入口**，不参与分组），`order` 仍会填成置顶区当前最大值 +1。
- **没传 `--config`** → `visible()` 与 `cfgFilled` 的 import 都保持注释（模块无条件显示）。

## 图标那一步：唯一「漏了不报错」的

模板里 `icon: 'Grid'` 是演示值，真正让它显示出来要靠 `src/main.ts` 的两处白名单
（`import` 与 `ICONS` 映射）。生成器会自动插进去；手抄的话照着
`src/main.ts` 里 `// ↓ 新图标加在这里（import 与 ICONS 两处）` 那两个锚点各加一行，
否则表现是「侧边栏 / 页面里那块空白」+ 一条 Vue 警告（[EXTENDING.md](../../../docs/EXTENDING.md) §2 第 5 步）。

三道护栏：

- `scripts/tests/module-contract.test.mjs` —— 模块里用到的图标名必须都在白名单里，且白名单两处必须一致；
- 生成器自己 —— 图标名要能在 `@element-plus/icons-vue` 里找到才放行（写错的名字直接中止）；
- 生成器落盘前的 **SFC 自检** —— 生成的页面先用 `@vue/compiler-sfc` 解析一遍，语法坏了当场中止，
  不让你 build 到一半才发现。

## 这两个文件里还预置了什么（都可以删）

- `visible` / `stats` / `badge` 三处**注释掉的示例行**；
- 联网页面的标准四段结构：`ensureSidecar()` → `SidecarOffline` 引导卡 → 空态 `EmptyState` → 列表。
  纯页面（数据全在浏览器里）就把 `api` / `ensureSidecar` / `SidecarOffline` 那几行删掉；
- 轮询的写法见 [EXTENDING.md](../../../docs/EXTENDING.md) §5.3（**终态要停、`onUnmounted` 要清**）。
