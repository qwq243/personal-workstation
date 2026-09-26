<script setup lang="ts">
import PageHeader from '@/components/PageHeader.vue'

const steps = [
  {
    t: '1. 建目录',
    d: '在 src/features/ 下新建一个文件夹，例如 src/features/reading/，功能之间互不干扰。',
  },
  {
    t: '2. 写 module.ts',
    d: '实现 WorkstationModule 接口：声明 id / 名称 / 图标 / 首页路径 / 子路由。路由 path 写完整绝对路径，带 meta.title 的会自动出现在侧边栏二级菜单。',
  },
  {
    t: '3. 注册',
    d: '在 src/features/index.ts 里 registerModule(yourModule)。侧边栏、首页卡片、路由表都会自动生成，其它文件一行都不用改。',
  },
  {
    t: '4. 要后端能力再加（可选）',
    d: '需要读本地文件 / 访问外部接口 / 存不能丢的数据时：server/lib/<名字>.mjs 写能力，server/index.mjs 加它的 /api/* 路由，前端通过 @/core/sidecar 的 call 调。数据一律走 server/lib/jsonstore.mjs（原子写 + .bak + 按天快照）。',
  },
]

/** 数据源要自己接的几处：这里只给「接哪儿、怎么写」，不预置任何别人的实现 */
const slots = [
  {
    t: '教务（课表 / 成绩 / 签到）',
    d: '依赖你所在学校的接口与个人身份，所以仓库里没有带。写一个 server/lib/<你的教务>.mjs 当客户端，再按上面第 4 步接上即可。',
  },
  {
    t: '文件传输（手机 ↔ 电脑）',
    d: '接口约定与一个空的 provider 目录已经留好：docs/文件传输.md。WebDAV / S3 / rclone 都能接，注意上传下载要做成「起任务 + 轮询」。',
  },
  {
    t: '课表 / 待办 / 早报这类看板卡片',
    d: '看板只是容器：后端往 /api/overview 的返回里加一节，前端在 src/features/dashboard/DashboardHome.vue 里加一张卡。写法照现有卡片抄。',
  },
  {
    t: '网页正文抓取',
    d: '默认只支持公开可读的页面（RSS / Atom 与静态 HTML）。要登录的、靠 JS 渲染的页面拿不到 —— 那不是没做完，是不该由工具替你把凭据带上去。',
  },
]
</script>

<template>
  <div class="ws-page">
    <PageHeader title="扩展开发" subtitle="工作站的功能是「插件式」的，加功能不改内核" icon="MagicStick" />

    <div class="ws-card pad">
      <div class="h">三步加一个功能</div>
      <div class="steps">
        <div v-for="(s, i) in steps" :key="i" class="step">
          <div class="step__n">{{ i + 1 }}</div>
          <div>
            <div class="step__t">{{ s.t }}</div>
            <div class="step__d">{{ s.d }}</div>
          </div>
        </div>
      </div>
    </div>

    <div class="ws-card pad" style="margin-top: 18px">
      <div class="h">模块骨架示例</div>
      <pre class="code">// src/features/reading/module.ts
import type { WorkstationModule } from '@/core/types'

export const readingModule: WorkstationModule = {
  id: 'reading',
  name: '阅读笔记',
  description: '记录与回顾读过的文章',
  icon: 'Reading',        // Element Plus 图标名（禁用 emoji）
  color: '#0ea5e9',
  order: 20,               // 越小越靠前
  homePath: '/reading',
  routes: [
    { path: '/reading', component: () => import('./ReadingHome.vue'),
      meta: { title: '阅读' } },
    { path: '/reading/archive', component: () => import('./Archive.vue'),
      meta: { title: '归档', icon: 'Box' } },
  ],
  // 可选：给首页卡片提供指标
  stats: () => [{ label: '篇笔记', value: 12 }],
}</pre>
      <div class="ws-dim" style="margin-top: 10px">
        然后在 <code class="ws-mono">src/features/index.ts</code> 中
        <code class="ws-mono">registerModule(readingModule)</code> 即完成接入。
      </div>
    </div>

    <div class="ws-card pad" style="margin-top: 18px">
      <div class="h">要自己接的几处（仓库里没有预置实现）</div>
      <ul class="list">
        <li v-for="(s, i) in slots" :key="i">
          <b>{{ s.t }}</b>：{{ s.d }}
        </li>
      </ul>
    </div>

    <div class="ws-card pad" style="margin-top: 18px">
      <div class="h">内核提供的能力</div>
      <ul class="list">
        <li>
          <b>存储命名空间</b>：<code class="ws-mono">@/core/storage</code> 的
          <code class="ws-mono">loadJSON / saveJSON</code>，数据统一落在
          <code class="ws-mono">workstation.*</code>，设置页可一键备份恢复。
        </li>
        <li><b>主题</b>：<code class="ws-mono">@/core/ui</code> 的 useUiStore，浅色 / 深色 / 跟随系统。</li>
        <li>
          <b>样式变量</b>：<code class="ws-mono">src/styles/index.css</code> 里的
          <code class="ws-mono">--ws-*</code> 变量，自动适配深色。
        </li>
        <li><b>组件库</b>：Element Plus 已全量注册，模板里直接写 <code class="ws-mono">&lt;el-button&gt;</code> 和图标即可。</li>
        <li><b>通用组件</b>：<code class="ws-mono">PageHeader</code> / <code class="ws-mono">EmptyState</code> / <code class="ws-mono">SidecarOffline</code>。</li>
        <li>
          <b>可见性钩子</b>：模块的 <code class="ws-mono">visible()</code> 返回 false 就从侧边栏与首页隐藏。
          约定是「没配 = 不显示」（依赖的目录 / 端点没填就别让人点进去看报错），
          见 <code class="ws-mono">@/core/appconfig</code>。
        </li>
      </ul>
      <div class="ws-dim" style="margin-top: 12px">
        更完整的说明在仓库的 <code class="ws-mono">docs/architecture.md</code>（三分法、配置分层、
        以及从删掉的模块里留下的设计教训）与 <code class="ws-mono">docs/verifying.md</code>（改完怎么验）。
      </div>
    </div>
  </div>
</template>

<style scoped>
.pad {
  padding: 22px 24px;
}
.h {
  font-size: 15px;
  font-weight: 650;
  margin-bottom: 16px;
}
.steps {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.step {
  display: flex;
  gap: 13px;
}
.step__n {
  width: 26px;
  height: 26px;
  flex: 0 0 26px;
  border-radius: 99px;
  display: grid;
  place-items: center;
  font-size: 12.5px;
  font-weight: 650;
  color: var(--ws-accent);
  background: var(--ws-accent-soft);
}
.step__t {
  font-weight: 600;
  font-size: 13.8px;
}
.step__d {
  color: var(--ws-text-2);
  font-size: 13px;
  margin-top: 3px;
}
.code {
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
  border-radius: var(--ws-radius);
  padding: 15px 17px;
  overflow-x: auto;
  font-family: var(--ws-mono);
  font-size: 12.4px;
  line-height: 1.65;
  color: var(--ws-text);
  margin: 0;
}
.list {
  margin: 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 9px;
  color: var(--ws-text-2);
  font-size: 13.3px;
}
.list b {
  color: var(--ws-text);
}
code {
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
  border-radius: 5px;
  padding: 1px 5px;
  font-size: 0.92em;
}
</style>
