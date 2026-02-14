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
  <div class="space-y-4">
    <MessagePartRenderer
      v-for="(part, index) in message?.parts ?? []"
      :key="`${message?.id}-${part?.type}-${index}`"
      :message="message"
      :part="part"
    />
  </div>
</template>
