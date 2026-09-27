<script setup lang="ts">
/** 全部应用：功能卡片由注册表自动生成，按大模块（学习 / 待办 / 校内）分组。 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { getGroupedModules, getPinnedModules } from '@/core/registry'

const router = useRouter()
/** 置顶入口（进程守护 / 运行与自启）：没有 category 的模块 */
const pinned = computed(() => getPinnedModules())
/** 大模块分组 */
const groups = computed(() => getGroupedModules())

function isComponentIcon(icon: string) {
  return /^[A-Z]/.test(icon)
}

function open(path: string) {
  router.push(path)
}
</script>

<template>
  <div class="ws-page ws-page--wide">
    <div class="hero">
      <div class="hero__text">
        <h1 class="hero__title">全部应用</h1>
        <p class="hero__sub">
          工作站的功能按大模块归好了：成长、办公、学习、待办、校内。每天进来先看每日看板，人怎么走看成长。
        </p>
      </div>
      <div class="hero__stat">
        <div class="hero__stat-num">{{ pinned.length + groups.reduce((n, g) => n + g.modules.length, 0) }}</div>
        <div class="hero__stat-label">个功能</div>
      </div>
    </div>

    <section v-if="pinned.length" class="group">
      <div class="group__title">常用</div>
      <div class="grid">
        <button
          v-for="mod in pinned"
          :key="mod.id"
          class="app-card"
          :style="{ '--card-accent': mod.color ?? 'var(--ws-accent)' }"
          @click="open(mod.homePath)"
        >
          <div class="app-card__top">
            <div class="app-card__icon">
              <el-icon v-if="isComponentIcon(mod.icon)"><component :is="mod.icon" /></el-icon>
              <span v-else>{{ mod.icon }}</span>
            </div>
            <span v-if="mod.badge && mod.badge()" class="app-card__badge">{{ mod.badge() }}</span>
            <el-icon class="app-card__arrow"><Right /></el-icon>
          </div>

          <div class="app-card__name">{{ mod.name }}</div>
          <div class="app-card__desc">{{ mod.description }}</div>

          <div v-if="mod.stats && mod.stats().length" class="app-card__stats">
            <div v-for="s in mod.stats()" :key="s.label" class="app-stat">
              <div class="app-stat__v" :style="{ color: s.color }">{{ s.value }}</div>
              <div class="app-stat__l">{{ s.label }}</div>
            </div>
          </div>
        </button>
      </div>
    </section>

    <section v-for="g in groups" :key="g.group.id" class="group">
      <div class="group__title">
        <el-icon class="group__icon" :style="{ color: g.group.color }">
          <component :is="g.group.icon" />
        </el-icon>
        <span>{{ g.group.name }}</span>
      </div>
      <div class="grid">
        <button
          v-for="mod in g.modules"
          :key="mod.id"
          class="app-card"
          :style="{ '--card-accent': mod.color ?? g.group.color }"
          @click="open(mod.homePath)"
        >
          <div class="app-card__top">
            <div class="app-card__icon">
              <el-icon v-if="isComponentIcon(mod.icon)"><component :is="mod.icon" /></el-icon>
              <span v-else>{{ mod.icon }}</span>
            </div>
            <span v-if="mod.badge && mod.badge()" class="app-card__badge">{{ mod.badge() }}</span>
            <el-icon class="app-card__arrow"><Right /></el-icon>
          </div>

          <div class="app-card__name">{{ mod.name }}</div>
          <div class="app-card__desc">{{ mod.description }}</div>

          <div v-if="mod.stats && mod.stats().length" class="app-card__stats">
            <div v-for="s in mod.stats()" :key="s.label" class="app-stat">
              <div class="app-stat__v" :style="{ color: s.color }">{{ s.value }}</div>
              <div class="app-stat__l">{{ s.label }}</div>
            </div>
          </div>
        </button>

        <button class="app-card app-card--ghost" @click="open('/dev-guide')">
          <div class="app-card__top">
            <div class="app-card__icon"><el-icon><Plus /></el-icon></div>
          </div>
          <div class="app-card__name">添加新功能</div>
          <div class="app-card__desc">三步接上一个新模块，看「扩展开发」里的说明。</div>
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ws-space-6);
  padding: var(--ws-space-6) 28px;
  border-radius: var(--ws-radius-lg);
  border: 1px solid var(--ws-border);
  background: linear-gradient(135deg, color-mix(in srgb, var(--ws-accent) 9%, var(--ws-panel)), var(--ws-panel) 62%);
  box-shadow: var(--ws-shadow-1);
  margin-bottom: var(--ws-space-6);
  flex-wrap: wrap;
}
.hero__title {
  font-size: var(--ws-fs-xl);
  font-weight: 700;
  letter-spacing: -0.02em;
}
.hero__sub {
  color: var(--ws-text-2);
  font-size: var(--ws-fs-sm);
  margin-top: 7px;
  max-width: 560px;
}
.hero__stat {
  text-align: center;
  padding: 8px 22px;
  border-left: 1px solid var(--ws-border);
}
.hero__stat-num {
  font-size: var(--ws-fs-xl);
  font-weight: 700;
  color: var(--ws-accent);
  line-height: 1.1;
}
.hero__stat-label {
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-3);
  margin-top: 2px;
}

.group + .group {
  margin-top: 28px;
}
.group__title {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: var(--ws-fs-lg);
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--ws-text);
  margin-bottom: 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--ws-border);
}
.group__icon {
  font-size: 18px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(258px, 1fr));
  gap: var(--ws-space-4);
}

.app-card {
  position: relative;
  text-align: left;
  padding: var(--ws-space-5);
  border-radius: var(--ws-radius-lg);
  border: 1px solid var(--ws-border);
  background: var(--ws-panel);
  box-shadow: var(--ws-shadow-1);
  cursor: pointer;
  font: inherit;
  color: inherit;
  transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease;
  overflow: hidden;
}
.app-card::before {
  content: '';
  position: absolute;
  inset: 0 0 auto 0;
  height: 3px;
  background: var(--card-accent, var(--ws-accent));
  opacity: 0;
  transition: opacity 0.16s ease;
}
.app-card:hover {
  transform: translateY(-3px);
  box-shadow: var(--ws-shadow-2);
  border-color: color-mix(in srgb, var(--card-accent, var(--ws-accent)) 35%, var(--ws-border));
}
.app-card:hover::before {
  opacity: 1;
}
.app-card__top {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}
.app-card__icon {
  width: 40px;
  height: 40px;
  border-radius: var(--ws-radius);
  display: grid;
  place-items: center;
  font-size: 20px;
  color: var(--card-accent, var(--ws-accent));
  background: color-mix(in srgb, var(--card-accent, var(--ws-accent)) 12%, transparent);
}
.app-card__badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: var(--ws-radius-pill);
  color: var(--card-accent, var(--ws-accent));
  background: color-mix(in srgb, var(--card-accent, var(--ws-accent)) 12%, transparent);
}
.app-card__arrow {
  margin-left: auto;
  color: var(--ws-text-3);
  transition: transform 0.16s ease, color 0.16s ease;
}
.app-card:hover .app-card__arrow {
  transform: translateX(3px);
  color: var(--card-accent, var(--ws-accent));
}
.app-card__name {
  font-size: var(--ws-fs-md);
  font-weight: 650;
  letter-spacing: -0.01em;
}
.app-card__desc {
  color: var(--ws-text-2);
  font-size: var(--ws-fs-sm);
  margin-top: 5px;
  line-height: 1.55;
}
.app-card__stats {
  display: flex;
  gap: var(--ws-space-5);
  margin-top: var(--ws-space-4);
  padding-top: 14px;
  border-top: 1px dashed var(--ws-border);
}
.app-stat__v {
  font-size: var(--ws-fs-md);
  font-weight: 700;
  line-height: 1.2;
}
.app-stat__l {
  font-size: var(--ws-fs-xs);
  color: var(--ws-text-3);
  margin-top: 1px;
}

.app-card--ghost {
  border-style: dashed;
  background: transparent;
  box-shadow: none;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.app-card--ghost .app-card__icon {
  color: var(--ws-text-3);
  background: var(--ws-panel-2);
}
.app-card--ghost:hover {
  border-color: var(--ws-accent);
}
</style>
