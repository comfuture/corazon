<template>
  <UDashboardGroup>
    <UDashboardSidebar
      resizable
      collapsible
    >
      <template #header="{ collapsed }">
        <div class="flex items-center justify-center text-xl">
          <span v-if="collapsed">❤️</span>
          <span
            v-else
            class="flex items-center gap-2 text-base font-semibold"
          >
            <span>❤️</span>
            <span>Corazón</span>
          </span>
        </div>
      </template>
      <template #default="{ collapsed }">
        <UButton
          to="/chat"
          color="primary"
          variant="soft"
          icon="i-lucide-plus"
          :label="collapsed ? undefined : 'New chat'"
          :square="collapsed"
          class="mb-4 w-full justify-center"
          :block="!collapsed"
        />
        <cz-thread-list :collapsed="collapsed" />
      </template>
      <template #footer="{ collapsed }">
        <UButton
          to="/settings/general"
          color="neutral"
          variant="ghost"
          icon="i-lucide-settings"
          :label="collapsed ? undefined : 'Settings'"
          :square="collapsed"
          class="w-full justify-center"
          :block="!collapsed"
        />
      </template>
    </UDashboardSidebar>
    <NuxtPage />
  </UDashboardGroup>
</template>
