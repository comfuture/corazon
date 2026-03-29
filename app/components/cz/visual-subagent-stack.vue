<script setup lang="ts">
import type { VisualSubagentPanel, VisualSubagentStatus } from '../../composables/useVisualSubagentPanels'

const props = defineProps<{
  panels: VisualSubagentPanel[]
}>()

const shortThreadId = (value: string) => value.slice(0, 8)

const statusLabel = (status: VisualSubagentStatus) => {
  switch (status) {
    case 'pendingInit':
      return 'pending'
    case 'running':
      return 'running'
    case 'interrupted':
      return 'interrupted'
    case 'completed':
      return 'completed'
    case 'errored':
      return 'errored'
    case 'shutdown':
      return 'shutdown'
    case 'notFound':
      return 'not found'
    default:
      return 'live'
  }
}

const statusColor = (status: VisualSubagentStatus) => {
  switch (status) {
    case 'running':
      return 'info'
    case 'pendingInit':
      return 'primary'
    case 'interrupted':
      return 'warning'
    case 'errored':
      return 'error'
    case 'shutdown':
    case 'notFound':
      return 'neutral'
    default:
      return 'success'
  }
}
</script>

<template>
  <SplitterGroup
    direction="vertical"
    class="flex h-full min-h-0 flex-col"
  >
    <template
      v-for="(panel, index) in props.panels"
      :key="panel.threadId"
    >
      <SplitterPanel
        :id="panel.threadId"
        :order="index + 1"
        :default-size="100 / props.panels.length"
        :min-size="18"
        class="min-h-0 overflow-hidden rounded-2xl border border-default bg-elevated/80 shadow-sm"
      >
        <div class="flex h-full min-h-0 flex-col">
          <div class="flex items-start justify-between gap-3 border-b border-default/70 bg-muted/20 px-3 py-2.5">
            <div class="min-w-0">
              <p class="truncate text-sm font-semibold text-default">
                {{ panel.name || shortThreadId(panel.threadId) }}
              </p>
              <p class="font-mono text-[11px] text-muted-foreground">
                {{ shortThreadId(panel.threadId) }}
              </p>
            </div>
            <UBadge
              :color="statusColor(panel.status)"
              variant="soft"
              size="xs"
              class="shrink-0"
            >
              {{ statusLabel(panel.status) }}
            </UBadge>
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            <div
              v-if="panel.messages.length > 0"
              class="space-y-3"
            >
              <div
                v-for="message in panel.messages"
                :key="message.id"
                class="rounded-xl border border-default/70 bg-background/80 p-3 shadow-sm"
              >
                <div class="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                  <span>{{ message.role }}</span>
                </div>
                <cz-message-content :message="message" />
              </div>
            </div>

            <div
              v-else
              class="flex h-full min-h-24 items-center justify-center rounded-xl border border-dashed border-muted/70 bg-muted/10 px-4 py-6 text-sm text-muted-foreground"
            >
              Waiting for subagent transcript...
            </div>
          </div>
        </div>
      </SplitterPanel>

      <SplitterResizeHandle
        v-if="index < props.panels.length - 1"
        class="mx-3 my-2 h-1 rounded-full bg-muted/70"
      />
    </template>
  </SplitterGroup>
</template>
