<script setup lang="ts">
import type { CodexItemData } from '@@/types/chat-ui'
import CzMessageItemChatTool from './chat-tool.vue'

type CommandExecutionItem = Extract<CodexItemData, { kind: 'command_execution' }>['item']

const props = defineProps<{
  item: CommandExecutionItem
}>()

const commandPreview = computed(() => {
  const command = props.item.command?.trim() ?? ''
  return command || 'command'
})

const title = computed(() => {
  switch (props.item.status) {
    case 'in_progress':
      return '명령 실행 중'
    case 'completed':
      return '명령 실행'
    case 'failed':
      return '명령 실행 실패'
    default:
      return '명령'
  }
})

const icon = computed(() =>
  props.item.status === 'failed' ? 'i-lucide-triangle-alert' : 'i-lucide-terminal'
)
</script>

<template>
  <CzMessageItemChatTool
    :text="title"
    :suffix="commandPreview"
    :icon="icon"
    :status="item.status"
    variant="card"
    :default-open="item.status === 'failed'"
    :ui="{
      label: 'min-w-0 truncate',
      suffix: 'truncate font-mono text-xs',
      trigger: 'px-2 py-1.5',
      body: 'max-h-[320px] overflow-y-auto border-default p-2'
    }"
  >
    <div
      v-if="item.aggregated_output"
      class="rounded-md bg-muted/10 px-3 py-2"
    >
      <pre class="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">{{ item.aggregated_output }}</pre>
    </div>
    <p
      v-else
      class="text-xs text-muted-foreground"
    >
      No output yet.
    </p>
  </CzMessageItemChatTool>
</template>
