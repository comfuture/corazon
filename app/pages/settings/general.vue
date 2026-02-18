<script setup lang="ts">
definePageMeta({
  layout: 'settings'
})

type ThemePreference = 'light' | 'dark' | 'system'
type FontSize = 'sm' | 'md' | 'lg'

const {
  themePreference,
  fontSize,
  enableNotifications,
  setThemePreference,
  setFontSize,
  setEnableNotifications
} = useSettings()

const themeOptions: Array<{ label: string, value: ThemePreference, icon: string }> = [
  { label: 'Light', value: 'light', icon: 'i-lucide-sun' },
  { label: 'Dark', value: 'dark', icon: 'i-lucide-moon' },
  { label: 'System', value: 'system', icon: 'i-lucide-monitor' }
]

const fontSizeOptions: Array<{ label: string, value: FontSize }> = [
  { label: 'Small', value: 'sm' },
  { label: 'Medium', value: 'md' },
  { label: 'Large', value: 'lg' }
]

const onThemeChange = (value: ThemePreference) => {
  setThemePreference(value)
}

const onFontSizeChange = (value: FontSize) => {
  setFontSize(value)
}

const onEnableNotificationsChange = async (value: boolean) => {
  await setEnableNotifications(value)
}
</script>

<template>
  <UDashboardPanel id="settings-general-panel">
    <template #header>
      <UDashboardNavbar title="General">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UContainer class="py-6 sm:py-8">
        <div class="mx-auto flex w-full max-w-3xl flex-col gap-6">
          <section class="space-y-3">
            <h2 class="text-xl font-semibold tracking-tight">
              Appearance
            </h2>

            <UCard :ui="{ body: 'divide-y divide-default p-0 sm:p-0' }">
              <div class="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
                <div>
                  <p class="text-sm font-medium">
                    Theme
                  </p>
                  <p class="text-sm text-muted-foreground">
                    Choose light, dark, or follow your system preference.
                  </p>
                </div>

                <UFieldGroup
                  size="sm"
                  class="w-full sm:w-auto"
                >
                  <UButton
                    v-for="option in themeOptions"
                    :key="option.value"
                    :label="option.label"
                    :icon="option.icon"
                    color="neutral"
                    :variant="themePreference === option.value ? 'solid' : 'outline'"
                    @click="onThemeChange(option.value)"
                  />
                </UFieldGroup>
              </div>

              <div class="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
                <div>
                  <p class="text-sm font-medium">
                    Font size
                  </p>
                  <p class="text-sm text-muted-foreground">
                    Adjust text size across the application.
                  </p>
                </div>

                <USelect
                  :model-value="fontSize"
                  :items="fontSizeOptions"
                  class="w-full sm:w-44"
                  @update:model-value="onFontSizeChange"
                />
              </div>
            </UCard>
          </section>

          <section class="space-y-3">
            <h2 class="text-xl font-semibold tracking-tight">
              Notification
            </h2>

            <UCard :ui="{ body: 'p-0 sm:p-0' }">
              <div class="flex items-center justify-between gap-4 p-4 sm:p-5">
                <div>
                  <p class="text-sm font-medium">
                    Enable Notification
                  </p>
                  <p class="text-sm text-muted-foreground">
                    Send a system notification when a turn ends while this chat is not visible.
                  </p>
                </div>

                <USwitch
                  :model-value="enableNotifications"
                  @update:model-value="onEnableNotificationsChange"
                />
              </div>
            </UCard>
          </section>
        </div>
      </UContainer>
    </template>
  </UDashboardPanel>
</template>
