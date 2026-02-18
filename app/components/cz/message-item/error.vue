<script setup lang="ts">
import type { CodexItemData } from '@@/types/chat-ui'

type ErrorItem = Extract<CodexItemData, { kind: 'error' }>['item']

defineProps<{
  item: ErrorItem
}>()
</script>

<template>
  <UAlert
    color="error"
    variant="soft"
    icon="i-lucide-alert-triangle"
    title="Error"
  >
    <template #description>
      {{ item.message }}
    </template>
  </UAlert>
</template>
