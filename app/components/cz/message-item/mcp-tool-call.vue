<script setup lang="ts">
import MarkdownRender from 'markstream-vue'
import 'markstream-vue/index.css'
import type { CodexItemData } from '@@/types/codex-ui'

type McpToolCallItem = Extract<CodexItemData, { kind: 'mcp_tool_call' }>['item']

defineProps<{
  item: McpToolCallItem
}>()

const statusColor = (status?: string) => {
  switch (status) {
    case 'completed':
      return 'success'
    case 'failed':
      return 'error'
    case 'in_progress':
      return 'warning'
    default:
      return 'neutral'
  }
}

const asCodeBlock = (value: string, language = 'text') => {
  const content = value.trim().length > 0 ? value : '(empty)'
  return `\`\`\`${language}\n${content}\n\`\`\``
}

const formatJson = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2) ?? ''
  } catch {
    return String(value)
  }
}
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex flex-wrap items-center gap-2">
        <UBadge
          color="primary"
          variant="subtle"
        >
          MCP
        </UBadge>
        <span class="text-xs">{{ item.server }}</span>
        <span class="font-mono text-xs">{{ item.tool }}</span>
        <UBadge
          :color="statusColor(item.status)"
          variant="soft"
        >
          {{ item.status }}
        </UBadge>
      </div>
    </template>

    <div class="space-y-3">
      <div>
        <div class="text-xs font-semibold text-muted">
          Arguments
        </div>
        <MarkdownRender
          :content="asCodeBlock(formatJson(item.arguments), 'json')"
        />
      </div>

      <div v-if="item.result">
        <div class="text-xs font-semibold text-muted">
          Result
        </div>
        <MarkdownRender
          :content="asCodeBlock(formatJson(item.result), 'json')"
        />
      </div>

      <UAlert
        v-if="item.error"
        color="error"
        variant="soft"
        icon="i-lucide-alert-triangle"
        title="Tool error"
      >
        <template #description>
          {{ item.error?.message }}
        </template>
      </UAlert>
    </div>
  </UCard>
</template>
