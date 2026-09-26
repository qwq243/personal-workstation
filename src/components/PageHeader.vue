<script setup lang="ts">
/** 统一的页面头：标题 + 副标题 + 右侧操作区插槽 */
defineProps<{
  title: string
  subtitle?: string
  icon?: string
}>()
</script>

<template>
  <div class="ws-page-head">
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
