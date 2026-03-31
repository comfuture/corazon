<script setup lang="ts">
import type { CodexItemData } from '@@/types/chat-ui'
import CzMessageItemChatTool from './chat-tool.vue'

type McpToolCallItem = Extract<CodexItemData, { kind: 'mcp_tool_call' }>['item']

const props = defineProps<{
  item: McpToolCallItem
}>()

const formatPrettyJson = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2) ?? ''
  } catch {
    return String(value)
  }
}

const callPreview = computed(() => {
  const server = props.item.server?.trim() || 'mcp'
  const tool = props.item.tool?.trim() || 'tool'
  return `${server} ${tool}`
})

const argumentsText = computed(() => formatPrettyJson(props.item.arguments))
const resultText = computed(() => formatPrettyJson(props.item.result))

const progressLines = computed(() => {
  const structured = props.item.result?.structured_content
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) {
    return []
  }

  const progress = (structured as { progress?: unknown }).progress
  if (!Array.isArray(progress)) {
    return []
  }

  return progress.map((entry) => {
    if (typeof entry === 'string') {
      return entry
    }

    try {
      return JSON.stringify(entry)
    } catch {
      return String(entry)
    }
  })
})

const title = computed(() => {
  switch (props.item.status) {
    case 'in_progress':
      return 'MCP 도구 실행 중'
    case 'completed':
      return 'MCP 도구 실행'
    case 'failed':
      return 'MCP 도구 실행 실패'
    default:
      return 'MCP 도구'
  }
})

const icon = computed(() =>
  props.item.status === 'failed' ? 'i-lucide-triangle-alert' : 'i-lucide-plug-zap'
)
</script>

<template>
  <CzMessageItemChatTool
    :text="title"
    :suffix="callPreview"
    :icon="icon"
    :status="item.status"
    variant="card"
    :default-open="item.status === 'failed'"
  >
    <div class="space-y-2">
      <div
        v-if="item.arguments != null"
        class="rounded-md border border-muted/60 bg-muted/10 px-3 py-2"
      >
        <p class="mb-2 text-xs font-medium text-muted-foreground">
          Arguments
        </p>
        <pre class="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">{{ argumentsText }}</pre>
      </div>

      <div
        v-if="progressLines.length > 0"
        class="rounded-md border border-muted/60 bg-muted/10 px-3 py-2"
      >
        <p class="mb-2 text-xs font-medium text-muted-foreground">
          Progress
        </p>
        <ul class="space-y-1">
          <li
            v-for="(line, index) in progressLines"
            :key="`${item.id}-progress-${index}`"
            class="font-mono text-xs text-muted-foreground break-words"
          >
            {{ line }}
          </li>
        </ul>
      </div>

      <div
        v-if="item.result"
        class="rounded-md bg-muted/10 px-3 py-2"
      >
        <pre class="whitespace-pre-wrap break-words text-sm text-muted-foreground">{{ resultText }}</pre>
      </div>

      <p
        v-else
        class="text-sm text-muted-foreground"
      >
        No result yet.
      </p>

      <p
        v-if="item.error?.message"
        class="text-sm text-rose-500/90"
      >
        {{ item.error.message }}
      </p>
    </div>
  </CzMessageItemChatTool>
</template>
