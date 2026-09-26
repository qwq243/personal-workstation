import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

export default defineConfig({
  plugins: [
    vue(),
    /**
     * Element Plus 按需引入。
     *
     * 原来 main.ts 是 `app.use(ElementPlus)` 全量安装 + `element-plus/dist/index.css`
     * 全量样式，而模板里实际只用 28 个组件，其余全被打进主包（主 JS 1.18 MB）。
     * 加这两个插件后：模板里的 `<el-xxx>` 与脚本里的 `ElMessage` 都在编译期解析成
     * 「用哪个引哪个 + 自动带该组件 CSS」，未用到的组件不再进包。
     *
     * 配套改动（漏一个就样式缺失或白屏）：
     *  - main.ts 不再 `app.use(ElementPlus)`、不再全量引 index.css；
     *  - 中文 locale 改由 App.vue 的 <el-config-provider :locale="zhCn"> 提供；
     *  - 各 .vue 里原本 `import { ElMessage } from 'element-plus'` 的显式导入要删掉，
     *    否则插件认为「已导入」而不再注入样式，弹窗会变成无样式裸框。
     */
    AutoImport({
      resolvers: [ElementPlusResolver()],
      dts: 'src/auto-imports.d.ts',
    }),
    Components({
      resolvers: [ElementPlusResolver()],
      dts: 'src/components.d.ts',
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
    /**
     * 防双份依赖（重要）：
     * Windows 下若构建进程 cwd 的盘符是小写（如 d:\...，本会话的 shell 初始化
     * cd 失败会退化成小写 cwd），vite 从相对路径解析出的模块 id 就是 d:/...，
     * 而 alias / import.meta.url 等给出 D:/... —— rollup 视为**两个不同模块**，
     * pinia 会被打进两份。两份 pinia 有两个不同的 piniaSymbol，install 时
     * provide 的是 A 的 symbol，组件里 inject 的是 B 的 symbol，取不到实例，
     * App setup 一调 store 就抛 `Cannot read properties of undefined (reading '_s')`，
     * 整个应用白屏。
     * dedupe 强制这些包全项目走同一次解析，从根上避免大小写分裂。
     */
    dedupe: ['vue', 'vue-router', 'pinia'],
  },
  server: {
    port: 5273,
    host: '127.0.0.1',
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1600,
  },
})
