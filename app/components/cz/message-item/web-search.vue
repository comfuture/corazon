<script setup lang="ts">
import type { CodexItemData } from '@@/types/chat-ui'
import CzMessageItemChatTool from './chat-tool.vue'

type WebSearchItem = Extract<CodexItemData, { kind: 'web_search' }>['item']

defineProps<{
  item: WebSearchItem
}>()
</script>

<template>
  <CzMessageItemChatTool
    icon="i-lucide-search"
    text="Web Search"
    :suffix="item.query"
    :status="item.status"
  />
</template>
