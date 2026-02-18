<script setup lang="ts">
import type { CodexItemData } from '@@/types/chat-ui'

type CommandExecutionItem = Extract<CodexItemData, { kind: 'command_execution' }>['item']

const props = defineProps<{
  item: CommandExecutionItem
}>()

const open = ref(false)

const commandPreview = computed(() => {
  const command = props.item.command?.trim() ?? ''
  return command || 'command'
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
          command
        </UBadge>
        <span class="block whitespace-pre-wrap break-all font-mono text-xs">{{ commandPreview }}</span>
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
    </template>
  </div>
</template>
