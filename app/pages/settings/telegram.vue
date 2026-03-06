<script setup lang="ts">
import type { AgentHomeInfo, TelegramSettingsResponse } from '@@/types/settings'

definePageMeta({
  layout: 'settings'
})

const toast = useToast()
const { data: agentHome } = await useFetch<AgentHomeInfo>('/api/settings/agent-home')
const { data, pending, refresh } = await useFetch<TelegramSettingsResponse>('/api/settings/telegram')

const form = reactive({
  botToken: '',
  chatId: '',
  idleTimeoutMinutes: 15
})
const saving = ref(false)

watch(
  data,
  (value) => {
    form.botToken = value?.telegram.botToken ?? ''
    form.chatId = value?.telegram.chatId ?? ''
    form.idleTimeoutMinutes = value?.telegram.idleTimeoutMinutes ?? 15
  },
  { immediate: true }
)

const enabled = computed(() => {
  return form.botToken.trim().length > 0 && form.chatId.trim().length > 0
})

const saveTelegramSettings = async () => {
  const idleTimeoutMinutes = Math.floor(Number(form.idleTimeoutMinutes))
  if (!Number.isFinite(idleTimeoutMinutes) || idleTimeoutMinutes < 1) {
    toast.add({
      title: 'Invalid timeout',
      description: 'Idle timeout must be at least 1 minute.',
      color: 'warning'
    })
    return
  }

  try {
    saving.value = true
    await $fetch<TelegramSettingsResponse>('/api/settings/telegram', {
      method: 'PUT',
      body: {
        telegram: {
          botToken: form.botToken,
          chatId: form.chatId,
          idleTimeoutMinutes
        }
      }
    })
    await refresh()
    toast.add({
      title: 'Saved',
      description: 'Telegram settings were updated.',
      color: 'success'
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save Telegram settings.'
    toast.add({
      title: 'Save failed',
      description: message,
      color: 'error'
    })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UDashboardPanel id="settings-telegram-panel">
    <template #header>
      <UDashboardNavbar title="Telegram">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UContainer class="py-6 sm:py-8">
        <div class="mx-auto flex w-full max-w-4xl flex-col gap-4">
          <UAlert
            color="neutral"
            variant="soft"
            icon="i-lucide-folder-cog"
            title="Config path"
            :description="agentHome?.configPath ?? 'Loading...'"
          />

          <UCard :ui="{ body: 'space-y-4' }">
            <div class="flex items-center justify-between gap-3">
              <div>
                <h2 class="text-base font-semibold">
                  Telegram bot transport
                </h2>
                <p class="text-sm text-muted-foreground">
                  Corazon uses long polling for one configured chat room.
                </p>
              </div>

              <UBadge
                :color="enabled ? 'success' : 'warning'"
                variant="soft"
              >
                {{ enabled ? 'Enabled' : 'Disabled' }}
              </UBadge>
            </div>

            <UFormField
              label="Bot token"
              description="Telegram Bot API token used for long polling and replies."
            >
              <UInput
                v-model="form.botToken"
                type="password"
                autocomplete="off"
                placeholder="123456:ABC..."
              />
            </UFormField>

            <UFormField
              label="Chat ID"
              description="Only this Telegram chat is accepted in v1."
            >
              <UInput
                v-model="form.chatId"
                autocomplete="off"
                placeholder="-1001234567890"
              />
            </UFormField>

            <UFormField
              label="Idle timeout"
              description="After this many minutes without a completed Telegram message, the next input starts a new Corazon thread."
            >
              <UInput
                v-model.number="form.idleTimeoutMinutes"
                type="number"
                min="1"
                step="1"
              />
            </UFormField>

            <UAlert
              color="info"
              variant="soft"
              icon="i-lucide-info"
              title="Behavior"
              description="Telegram-origin turns are processed by the same chat-turn workflow, but Telegram output is emitted only on completed text or compact completed activity items."
            />

            <div class="flex justify-end">
              <UButton
                label="Save"
                icon="i-lucide-save"
                :loading="saving || pending"
                @click="saveTelegramSettings"
              />
            </div>
          </UCard>
        </div>
      </UContainer>
    </template>
  </UDashboardPanel>
</template>
