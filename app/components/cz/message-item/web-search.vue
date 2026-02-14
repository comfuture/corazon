<script setup lang="ts">
import type { CodexItemData } from '@@/types/codex-ui'

type WebSearchItem = Extract<CodexItemData, { kind: 'web_search' }>['item']

defineProps<{
  item: WebSearchItem
}>()
</script>

<template>
  <UAlert
    color="info"
    variant="soft"
    icon="i-lucide-search"
    title="Web search"
  >
    <template #description>
      {{ item.query }}
    </template>
  </UAlert>
</template>
