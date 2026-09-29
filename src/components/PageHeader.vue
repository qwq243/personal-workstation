<script setup lang="ts">
/** 统一的页面头：标题 + 副标题 + 右侧操作区插槽 */
defineProps<{
  title: string
  subtitle?: string
  icon?: string
  /**
   * 手机档收起副标题（opt-in，2026-09-29）。
   * 副标题多是说明文字，但手机第一屏宝贵 —— 做题目这种「一进来就要看题」的页面
   * 让它在小屏上省一行（样式见 styles/index.css 的 .ws-page-head.is-compact）。
   */
  compact?: boolean
}>()
</script>

<template>
  <div class="ws-page-head" :class="{ 'is-compact': compact }">
    <div>
      <h1 class="ws-title">
        <el-icon v-if="icon" style="color: var(--ws-accent)"><component :is="icon" /></el-icon>
        {{ title }}
      </h1>
      <p v-if="subtitle" class="ws-subtitle">{{ subtitle }}</p>
    </div>
    <div class="ws-row" style="flex-wrap: wrap">
      <slot name="actions" />
    </div>
  </div>
</template>
