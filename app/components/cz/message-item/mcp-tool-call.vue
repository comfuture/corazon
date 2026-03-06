<script setup lang="ts">
import type { CodexItemData } from '@@/types/chat-ui'

type McpToolCallItem = Extract<CodexItemData, { kind: 'mcp_tool_call' }>['item']

const props = defineProps<{
  item: McpToolCallItem
}>()

const open = ref(false)

const formatOneLineJson = (value: unknown) => {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

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
  const args = formatOneLineJson(props.item.arguments)
  return args ? `${server} ${tool} ${args}` : `${server} ${tool}`
})

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

const toggleOpen = () => {
  open.value = !open.value
}
</script>

<template>
  <div class="space-y-2">
    <UButton
      color="neutral"
      variant="ghost"
      size="sm"
      class="w-full justify-between px-0 py-0.5 text-muted"
      @click="toggleOpen"
    >
      <span class="min-w-0 flex flex-1 items-center gap-2 text-left">
        <UBadge
          color="primary"
          variant="subtle"
          size="xs"
        >
          MCP
        </UBadge>
        <span class="block truncate font-mono text-xs">{{ callPreview }}</span>
      </span>
      <template #trailing>
        <div class="flex items-center gap-2">
          <UIcon
            v-if="item.status === 'in_progress'"
            name="i-lucide-loader-2"
            class="h-3.5 w-3.5 animate-spin text-amber-500"
          />
          <UIcon
            v-else-if="item.status === 'completed'"
            name="i-lucide-check"
            class="h-3.5 w-3.5 text-emerald-500"
          />
          <UIcon
            v-else-if="item.status === 'failed'"
            name="i-lucide-x"
            class="h-3.5 w-3.5 text-rose-500"
          />
          <UIcon
            name="i-lucide-chevron-right"
            class="size-3.5 text-muted transition-transform"
            :class="open ? 'rotate-90' : ''"
          />
        </div>
      </template>
    </UButton>

    <template v-if="open">
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
    </template>
  </div>
</template>
