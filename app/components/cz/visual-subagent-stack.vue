<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, watch } from 'vue'
import {
  SplitterGroup,
  SplitterPanel,
  SplitterResizeHandle
} from 'reka-ui'
import type { VisualSubagentPanel } from '@/composables/useVisualSubagentPanels'

const props = defineProps<{
  agents: VisualSubagentPanel[]
}>()

const SCROLL_RETRY_DELAY_MS = 48
const SCROLL_RETRY_COUNT = 4

const scrollContainers = new Map<string, HTMLElement>()
const scrollRetryTimers = new Map<string, number>()
const scrollContainerRefs = new Map<string, (container: Element | null) => void>()

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

const isStreamingStatus = (status: VisualSubagentPanel['status']) =>
  status === 'pendingInit' || status === 'running'

const clearScrollRetry = (threadId: string) => {
  const timer = scrollRetryTimers.get(threadId)
  if (timer !== undefined) {
    window.clearTimeout(timer)
    scrollRetryTimers.delete(threadId)
  }
}

const scrollContainerToBottom = (threadId: string) => {
  const container = scrollContainers.get(threadId)
  if (!container) {
    return
  }
  container.scrollTop = container.scrollHeight
}

const queueScrollToBottom = (threadId: string, attempt = 0) => {
  if (!import.meta.client) {
    return
  }

  if (attempt === 0) {
    clearScrollRetry(threadId)
  }

  void nextTick(() => {
    scrollContainerToBottom(threadId)
    if (attempt >= SCROLL_RETRY_COUNT) {
      return
    }

    const timer = window.setTimeout(() => {
      queueScrollToBottom(threadId, attempt + 1)
    }, SCROLL_RETRY_DELAY_MS)

    scrollRetryTimers.set(threadId, timer)
  })
}

const setScrollContainer = (threadId: string, container: Element | null) => {
  if (!(container instanceof HTMLElement)) {
    scrollContainers.delete(threadId)
    clearScrollRetry(threadId)
    return
  }

  scrollContainers.set(threadId, container)
  queueScrollToBottom(threadId)
}

const scrollContainerRef = (threadId: string) => {
  const existing = scrollContainerRefs.get(threadId)
  if (existing) {
    return existing
  }

  const ref = (container: Element | null) => {
    setScrollContainer(threadId, container)
  }

  scrollContainerRefs.set(threadId, ref)
  return ref
}

const panelSignatures = computed(() =>
  props.agents.map(agent => ({
    threadId: agent.threadId,
    signature: JSON.stringify(agent.messages),
    status: agent.status
  }))
)

watch(panelSignatures, (signatures) => {
  const activeThreadIds = new Set(signatures.map(entry => entry.threadId))

  for (const { threadId } of signatures) {
    queueScrollToBottom(threadId)
  }

  for (const threadId of scrollRetryTimers.keys()) {
    if (!activeThreadIds.has(threadId)) {
      clearScrollRetry(threadId)
    }
  }
}, { immediate: true })

onBeforeUnmount(() => {
  for (const threadId of scrollRetryTimers.keys()) {
    clearScrollRetry(threadId)
  }
})
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

          <div
            :ref="scrollContainerRef(agent.threadId)"
            class="min-h-0 flex-1 overflow-y-auto px-4 py-3"
          >
            <div
              v-if="agent.messages.length === 0"
              class="rounded-lg border border-dashed border-muted px-3 py-4 text-sm text-muted-foreground"
            >
              Waiting for subagent output...
            </div>

            <UChatMessages
              v-else
              :messages="agent.messages"
              :status="isStreamingStatus(agent.status) ? 'streaming' : 'ready'"
              :user="{
                ui: {
                  root: 'scroll-mt-4',
                  container: 'gap-3 pb-8',
                  content: 'px-4 py-3 rounded-lg min-h-12'
                }
              }"
              :ui="{ root: 'min-h-full' }"
              compact
              should-auto-scroll
            >
              <template #content="{ message }">
                <cz-message-content :message="message" />
              </template>
            </UChatMessages>
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
