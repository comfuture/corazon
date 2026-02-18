<script setup lang="ts">
import type { DataUIPart } from 'ai'
import {
  CODEX_EVENT_PART,
  type CodexThreadEventData,
  type CodexUIDataTypes
} from '@@/types/chat-ui'

const props = defineProps<{
  part?: {
    type?: string
    [key: string]: unknown
  } | null
}>()

const isPartWithType = (part: unknown): part is { type: string } =>
  typeof part === 'object' && part !== null && 'type' in part

const asCodexEventPart = (part: unknown) =>
  isPartWithType(part) && part.type === CODEX_EVENT_PART
    ? (part as DataUIPart<CodexUIDataTypes> & { type: typeof CODEX_EVENT_PART, data: CodexThreadEventData })
    : undefined

const eventData = computed(() => asCodexEventPart(props.part)?.data)

const shouldRenderEvent = computed(() => {
  const event = eventData.value
  if (!event) {
    return false
  }

  return event.kind !== 'thread.started'
    && event.kind !== 'thread.ended'
    && event.kind !== 'turn.started'
    && event.kind !== 'turn.completed'
    && event.kind !== 'thread.title'
})

const color = computed(() => {
  const event = eventData.value
  if (!event) {
    return 'neutral'
  }

  switch (event.kind) {
    case 'turn.failed':
    case 'stream.error':
      return 'error'
    case 'turn.completed':
      return 'success'
    default:
      return 'neutral'
  }
})

const title = computed(() => {
  const event = eventData.value
  if (!event) {
    return 'Event'
  }

  switch (event.kind) {
    case 'thread.started':
      return 'Thread started'
    case 'thread.ended':
      return 'Thread ended'
    case 'thread.title':
      return 'Thread title updated'
    case 'turn.started':
      return 'Turn started'
    case 'turn.completed':
      return 'Turn completed'
    case 'turn.failed':
      return 'Turn failed'
    case 'stream.error':
      return 'Stream error'
    default:
      return 'Event'
  }
})
</script>

<template>
  <UAlert
    v-if="shouldRenderEvent"
    :color="color"
    variant="soft"
    icon="i-lucide-activity"
    :title="title"
  >
    <template #description>
      <template v-if="eventData?.kind === 'turn.failed'">
        <span class="text-sm">{{ eventData.error?.message }}</span>
      </template>

      <template v-else-if="eventData?.kind === 'stream.error'">
        <span class="text-sm">{{ eventData.message }}</span>
      </template>

      <template v-else>
        <span class="text-sm text-muted">Codex event received.</span>
      </template>
    </template>
  </UAlert>
</template>
