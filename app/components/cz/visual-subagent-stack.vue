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
const SUBAGENT_ACCENT_PALETTE = [
  'text-emerald-700 dark:text-emerald-300',
  'text-sky-700 dark:text-sky-300',
  'text-amber-800 dark:text-amber-300',
  'text-rose-700 dark:text-rose-300',
  'text-violet-700 dark:text-violet-300',
  'text-cyan-700 dark:text-cyan-300',
  'text-lime-800 dark:text-lime-300',
  'text-orange-700 dark:text-orange-300'
] as const

const scrollContainers = new Map<string, HTMLElement>()
const scrollRetryTimers = new Map<string, number>()
const scrollContainerRefs = new Map<string, (container: Element | null) => void>()

const paneSize = computed(() => {
  if (!props.agents.length) {
    return 100
  }

  return 100 / props.agents.length
})

const splitterGroupKey = computed(() =>
  props.agents.map(agent => agent.threadId).join(':') || 'subagent-panels'
)

const agentAccentClass = (index: number) =>
  SUBAGENT_ACCENT_PALETTE[index % SUBAGENT_ACCENT_PALETTE.length]

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

const summarizeMessage = (message: VisualSubagentPanel['messages'][number] | undefined) => {
  if (!message) {
    return ''
  }

  return (message.parts ?? [])
    .map((part) => {
      switch (part.type) {
        case 'text':
        case 'reasoning':
          return `${part.type}:${part.state ?? 'done'}:${part.text?.length ?? 0}`
        case 'data-codex-item': {
          const item = part.data?.item as { id?: string, status?: string } | undefined
          return `${part.type}:${part.id}:${item?.status ?? ''}:${item?.id ?? ''}`
        }
        case 'file':
          return `${part.type}:${part.url ?? ''}`
        default:
          return part.type
      }
    })
    .join('|')
}

const panelSignatures = computed(() =>
  props.agents.map(agent => ({
    threadId: agent.threadId,
    signature: [
      agent.messages.length,
      agent.messages.at(-1)?.id ?? '',
      summarizeMessage(agent.messages.at(-1))
    ].join(':'),
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
    :key="splitterGroupKey"
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
        :min-size="0"
        :max-size="100"
        class="min-h-0"
      >
        <div class="flex h-full min-h-0 flex-col bg-elevated/30">
          <div class="flex items-center justify-between gap-2 border-b border-muted px-3 py-2">
            <div class="min-w-0">
              <p
                class="truncate text-sm font-semibold"
                :class="agentAccentClass(index)"
              >
                {{ agent.name }}
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
            class="min-h-0 flex-1 overflow-y-auto px-3 py-2"
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
              :ui="{ root: 'subagent-chat-messages min-h-full min-w-0 [&>article]:min-w-0 [&_[data-slot=content]]:min-w-0' }"
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

<style scoped>
.subagent-chat-messages :deep(.markstream-vue),
.subagent-chat-messages :deep([data-slot='content']) {
  min-width: 0;
  max-width: 100%;
}

.subagent-chat-messages :deep(.markstream-vue p),
.subagent-chat-messages :deep(.markstream-vue li),
.subagent-chat-messages :deep(.markstream-vue a),
.subagent-chat-messages :deep(.markstream-vue .text-node),
.subagent-chat-messages :deep(.markstream-vue .link-node) {
  overflow-wrap: anywhere;
  word-break: break-word;
}

.subagent-chat-messages :deep(.markstream-vue code) {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-all;
}

.subagent-chat-messages :deep(.markstream-vue pre),
.subagent-chat-messages :deep(.markstream-vue pre[class^='language-']),
.subagent-chat-messages :deep(.markstream-vue pre[class*=' language-']),
.subagent-chat-messages :deep(.markstream-vue .code-block-content),
.subagent-chat-messages :deep(.markstream-vue .code-fallback-plain),
.subagent-chat-messages :deep(.markstream-vue .shiki),
.subagent-chat-messages :deep(.markstream-vue .shiki code) {
  max-width: 100%;
  white-space: pre-wrap !important;
  overflow-wrap: anywhere;
  word-break: break-word;
  overflow-x: hidden !important;
}
</style>
