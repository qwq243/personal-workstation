<script setup lang="ts">
import { useRouter } from 'vue-router'
import EmptyState from '@/components/EmptyState.vue'

const router = useRouter()
</script>

<template>
  <div class="ws-page">
    <div class="ws-card" style="margin-top: 40px">
      <EmptyState title="这个页面不存在" description="检查一下地址，或者回首页看看装了哪些功能。" icon="Compass">
        <el-button type="primary" @click="router.push('/')">回到首页</el-button>
      </EmptyState>
    </div>
  </div>
</template>
