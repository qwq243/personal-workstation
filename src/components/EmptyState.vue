<script setup lang="ts">
/** 空状态占位：icon 传 Element Plus 图标名（默认 Box） */
defineProps<{
  title: string
  description?: string
  icon?: string
}>()
</script>

<template>
  <div class="empty">
    <div class="empty__icon">
      <el-icon><component :is="icon ?? 'Box'" /></el-icon>
    </div>
    <div class="empty__title">{{ title }}</div>
    <p v-if="description" class="empty__desc">{{ description }}</p>
    <div v-if="$slots.default" class="empty__actions">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.empty {
  text-align: center;
  padding: 54px 20px;
}
.empty__icon {
  width: 52px;
  height: 52px;
  margin: 0 auto 14px;
  border-radius: var(--ws-radius-lg);
  display: grid;
  place-items: center;
  font-size: 24px;
  color: var(--ws-text-3);
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
}
.empty__title {
  font-size: var(--ws-fs-md);
  font-weight: 600;
}
.empty__desc {
  color: var(--ws-text-2);
  font-size: var(--ws-fs-sm);
  margin-top: 5px;
}
.empty__actions {
  margin-top: 18px;
}
</style>
