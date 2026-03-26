<script setup lang="ts">
import type {
  AgentHomeInfo,
  TelegramChatCandidate,
  TelegramChatDiscoveryResponse,
  TelegramSettingsResponse
} from '@@/types/settings'

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
const discovering = ref(false)
const discoveredChats = ref<TelegramChatCandidate[]>([])

const discoveredAtFormatter = new Intl.DateTimeFormat('ko-KR', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
})

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

const formatCandidateMeta = (candidate: TelegramChatCandidate) => {
  const parts = [
    candidate.subtitle,
    `ID ${candidate.chatId}`,
    candidate.lastMessageAt ? discoveredAtFormatter.format(new Date(candidate.lastMessageAt)) : null
  ]
  return parts.filter(Boolean).join(' · ')
}

const applyDiscoveredChat = (candidate: TelegramChatCandidate) => {
  form.chatId = candidate.chatId
  toast.add({
    title: 'Chat selected',
    description: `${candidate.title} chat ID was applied to the form.`,
    color: 'success'
  })
}

const discoverTelegramChats = async () => {
  if (!form.botToken.trim()) {
    toast.add({
      title: 'Bot token required',
      description: 'Enter the Telegram bot token first.',
      color: 'warning'
    })
    return
  }

  try {
    discovering.value = true
    const response = await $fetch<TelegramChatDiscoveryResponse>('/api/settings/telegram/discover', {
      method: 'POST',
      body: {
        botToken: form.botToken
      }
    })
    discoveredChats.value = response.chats

    if (response.chats.length === 0) {
      toast.add({
        title: 'No chats found',
        description: 'Send a fresh message to the bot from the target chat, then try again.',
        color: 'warning'
      })
      return
    }

    toast.add({
      title: 'Chats loaded',
      description: `${response.chats.length} recent Telegram chat candidate(s) were found.`,
      color: 'success'
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to discover Telegram chats.'
    toast.add({
      title: 'Discovery failed',
      description: message,
      color: 'error'
    })
  } finally {
    discovering.value = false
  }
}

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
              description="Only this Telegram chat is accepted in v1. If the old chat ID disappeared, send a fresh message to the bot and discover again."
            >
              <div class="space-y-3">
                <div class="flex flex-col gap-2 sm:flex-row">
                  <UInput
                    v-model="form.chatId"
                    autocomplete="off"
                    placeholder="-1001234567890"
                    class="flex-1"
                  />
                  <UButton
                    label="Find recent chats"
                    icon="i-lucide-search"
                    color="neutral"
                    variant="outline"
                    :loading="discovering"
                    @click="discoverTelegramChats"
                  />
                </div>

                <div class="rounded-lg border border-default bg-muted/30 p-3">
                  <p class="text-sm text-muted-foreground">
                    Discovery reads Telegram <code>getUpdates</code> and Corazon's recent observed chat cache.
                    If a chat ID vanished because the old conversation was deleted or expired, Telegram cannot recover it
                    until a new message is sent from that chat.
                  </p>
                </div>

                <div
                  v-if="discoveredChats.length > 0"
                  class="space-y-2"
                >
                  <button
                    v-for="candidate in discoveredChats"
                    :key="candidate.chatId"
                    type="button"
                    class="flex w-full items-start justify-between gap-4 rounded-lg border border-default p-3 text-left transition hover:border-primary/50 hover:bg-muted/40"
                    @click="applyDiscoveredChat(candidate)"
                  >
                    <div class="min-w-0 space-y-1">
                      <p class="truncate text-sm font-medium text-default">
                        {{ candidate.title }}
                      </p>
                      <p class="text-xs text-muted-foreground">
                        {{ formatCandidateMeta(candidate) }}
                      </p>
                      <p
                        v-if="candidate.lastMessageText"
                        class="line-clamp-2 text-sm text-muted-foreground"
                      >
                        {{ candidate.lastMessageText }}
                      </p>
                    </div>

                    <UBadge
                      :color="form.chatId === candidate.chatId ? 'success' : 'neutral'"
                      variant="soft"
                    >
                      {{ form.chatId === candidate.chatId ? 'Selected' : 'Use' }}
                    </UBadge>
                  </button>
                </div>
              </div>
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
              description="Telegram-origin turns are processed by the same chat-turn workflow, and assistant text is streamed progressively before final completion."
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
