<script setup lang="ts">
import { computed } from 'vue'
import {
  SplitterGroup,
  SplitterPanel,
  SplitterResizeHandle
} from 'reka-ui'
import type { VisualSubagentPanel } from '@/composables/useVisualSubagentPanels'

const props = defineProps<{
  agents: VisualSubagentPanel[]
}>()

const paneSize = computed(() => {
  if (!props.agents.length) {
    return 100
  }

  return 100 / props.agents.length
})

const statusColor = (status: VisualSubagentPanel['status']) => {
  switch (status) {
    case 'running':
      return 'info'
    case 'pendingInit':
      return 'primary'
    case 'completed':
      return 'success'
    case 'interrupted':
      return 'warning'
    case 'errored':
      return 'error'
    case 'shutdown':
    case 'notFound':
      return 'neutral'
    default:
      return 'neutral'
  }
}

const statusLabel = (status: VisualSubagentPanel['status']) => {
  switch (status) {
    case 'pendingInit':
      return 'pending'
    case 'running':
      return 'running'
    case 'completed':
      return 'completed'
    case 'interrupted':
      return 'interrupted'
    case 'errored':
      return 'errored'
    case 'shutdown':
      return 'shutdown'
    case 'notFound':
      return 'not found'
    default:
      return 'active'
  }
}

const messageRoleLabel = (role: string | undefined) =>
  role === 'user' ? 'user' : 'assistant'
</script>

<template>
  <SplitterGroup
    direction="vertical"
    class="h-full min-h-0"
  >
    <template
      v-for="(agent, index) in agents"
      :key="agent.threadId"
    >
      <SplitterPanel
        :id="agent.threadId"
        :order="index + 1"
        :default-size="paneSize"
        :min-size="18"
        class="min-h-0"
      >
        <div class="flex h-full min-h-0 flex-col bg-elevated/30">
          <div class="flex items-center justify-between gap-2 border-b border-muted px-4 py-3">
            <div class="min-w-0">
              <p class="truncate text-sm font-semibold text-default">
                {{ agent.name }}
              </p>
              <p class="font-mono text-[11px] text-muted-foreground">
                {{ agent.threadId.slice(0, 8) }}
              </p>
            </div>
            <UBadge
              :color="statusColor(agent.status)"
              variant="soft"
              size="sm"
            >
              {{ statusLabel(agent.status) }}
            </UBadge>
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <div
              v-if="agent.messages.length === 0"
              class="rounded-lg border border-dashed border-muted px-3 py-4 text-sm text-muted-foreground"
            >
              Waiting for subagent output...
            </div>

            <div
              v-else
              class="space-y-4"
            >
              <div
                v-for="message in agent.messages"
                :key="message.id"
                class="space-y-2 rounded-lg border border-muted/70 bg-default/5 px-3 py-3"
              >
                <div class="flex items-center gap-2">
                  <UBadge
                    :color="message.role === 'user' ? 'neutral' : 'primary'"
                    variant="subtle"
                    size="xs"
                  >
                    {{ messageRoleLabel(message.role) }}
                  </UBadge>
                </div>
                <cz-message-content :message="message" />
              </div>
            </div>
          </div>
        </div>
      </SplitterPanel>

      <SplitterResizeHandle
        v-if="index < agents.length - 1"
        class="relative flex h-2 items-center justify-center bg-transparent before:h-px before:w-full before:bg-border"
      />
    </template>
  </SplitterGroup>
</template>
