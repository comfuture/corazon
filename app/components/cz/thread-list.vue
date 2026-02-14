<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

withDefaults(
  defineProps<{
    collapsed?: boolean
  }>(),
  {
    collapsed: false
  }
)

const { threads, refreshThreads } = useCodexThreads()

onMounted(() => {
  void refreshThreads()
})

const menuItems = computed<NavigationMenuItem[]>(() =>
  threads.value.map(thread => ({
    label: thread.title ?? thread.id,
    icon: 'i-lucide-message-circle',
    to: `/chat/${thread.id}`
  }))
)
</script>

<template>
  <UNavigationMenu
    :collapsed="collapsed"
    :items="menuItems"
    orientation="vertical"
  />
</template>
