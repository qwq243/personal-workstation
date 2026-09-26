/**
 * 界面偏好：主题、侧边栏状态。
 * 主题同时驱动 Element Plus 的暗色变量（html.dark）和本站自己的变量（html[data-theme]）。
 */
import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref, watch } from 'vue'
import { loadJSON, saveJSON } from '@/core/storage'

export type ThemeMode = 'light' | 'dark' | 'auto'

const mql = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null

export const useUiStore = defineStore('ui', () => {
  const theme = ref<ThemeMode>(loadJSON<ThemeMode>('ui.theme', 'light'))
  const sidebarCollapsed = ref<boolean>(loadJSON<boolean>('ui.sidebarCollapsed', false))
  const systemDark = ref<boolean>(mql?.matches ?? false)

  function onSystemChange(e: MediaQueryListEvent) {
    systemDark.value = e.matches
  }
  if (mql) {
    mql.addEventListener('change', onSystemChange)
    onScopeDispose(() => mql.removeEventListener('change', onSystemChange))
  }

  const resolvedTheme = computed<'light' | 'dark'>(() =>
    theme.value === 'auto' ? (systemDark.value ? 'dark' : 'light') : theme.value,
  )

  function applyTheme() {
    const root = document.documentElement
    root.dataset.theme = resolvedTheme.value
    root.classList.toggle('dark', resolvedTheme.value === 'dark')
  }

  watch(resolvedTheme, applyTheme, { immediate: true })
  watch(theme, (v) => saveJSON('ui.theme', v))
  watch(sidebarCollapsed, (v) => saveJSON('ui.sidebarCollapsed', v))

  function setTheme(v: ThemeMode) {
    theme.value = v
  }

  function toggleSidebar() {
    sidebarCollapsed.value = !sidebarCollapsed.value
  }

  return { theme, resolvedTheme, sidebarCollapsed, setTheme, toggleSidebar, applyTheme }
})
