<script setup lang="ts">
import MessagePartRenderer from './message-part-renderer'

type MessagePart = {
  type?: string
  [key: string]: unknown
}

type ChatMessageLike = {
  id?: string
  role?: string
  parts?: MessagePart[]
}

defineProps<{
  message?: ChatMessageLike | null
}>()
</script>

<template>
  <div class="space-y-2">
    <MessagePartRenderer
      v-for="(part, index) in message?.parts ?? []"
      :key="('id' in (part ?? {}) && typeof part.id === 'string')
        ? part.id
        : `${message?.id}-${part?.type}-${index}`"
      :message="message"
      :part="part"
    />
  </div>
</template>
