<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

const route = useRoute()

const items = computed<NavigationMenuItem[][]>(() => [[
  {
    label: 'General',
    icon: 'i-lucide-sliders-horizontal',
    to: '/settings/general',
    active: route.path === '/settings' || route.path.startsWith('/settings/general')
  }
]])
</script>

<template>
  <UDashboardGroup storage-key="settings-dashboard">
    <UDashboardSidebar
      resizable
      collapsible
      :default-size="24"
      :min-size="21"
      :max-size="40"
      :ui="{ footer: 'border-t border-default' }"
    >
      <template #header="{ collapsed }">
        <div class="flex items-center justify-center gap-2 text-base font-semibold">
          <UIcon
            name="i-lucide-settings-2"
            class="size-4"
          />
          <span v-if="!collapsed">Settings</span>
        </div>
      </template>

      <template #default="{ collapsed }">
        <UNavigationMenu
          orientation="vertical"
          :items="items"
          :collapsed="collapsed"
          highlight
          :tooltip="false"
          :popover="false"
        />
      </template>

      <template #footer="{ collapsed }">
        <UButton
          to="/chat"
          icon="i-lucide-arrow-left"
          color="neutral"
          variant="ghost"
          :label="collapsed ? undefined : 'Back to chat'"
          :square="collapsed"
          :block="!collapsed"
        />
      </template>
    </UDashboardSidebar>

    <NuxtPage />
  </UDashboardGroup>
</template>
