<script setup lang="ts">
import type { CodexItemData } from '@@/types/codex-ui'

type CommandExecutionItem = Extract<CodexItemData, { kind: 'command_execution' }>['item']

const props = defineProps<{
  item: CommandExecutionItem
}>()

const outputOpen = ref(false)
const lastStatus = ref<string | null>(null)

watch(
  () => props.item?.status,
  (status) => {
    if (!status) {
      outputOpen.value = false
      lastStatus.value = null
      return
    }

    if (lastStatus.value === status) {
      return
    }

    lastStatus.value = status
    outputOpen.value = status === 'in_progress'
  },
  { immediate: true }
)

const onOutputOpenChange = (open: boolean) => {
  outputOpen.value = open
}
</script>

<template>
  <div class="relative rounded-md border border-muted/50 bg-muted/20 p-3 space-y-2">
    <div class="absolute right-3 top-3">
      <UIcon
        v-if="item.status === 'in_progress'"
        name="i-lucide-loader-2"
        class="h-4 w-4 animate-spin text-amber-500"
      />
      <UIcon
        v-else-if="item.status === 'completed'"
        name="i-lucide-check"
        class="h-4 w-4 text-emerald-500"
      />
      <UIcon
        v-else-if="item.status === 'failed'"
        name="i-lucide-x"
        class="h-4 w-4 text-rose-500"
      />
    </div>

    <div class="flex flex-wrap items-center gap-2 text-xs">
      <UBadge
        color="primary"
        variant="subtle"
      >
        Command
      </UBadge>
      <span class="font-mono text-xs break-all">{{ item.command }}</span>
    </div>

    <UCollapsible
      v-if="item.aggregated_output"
      :open="outputOpen"
      class="rounded-md border border-muted/40 bg-background/60"
      @update:open="onOutputOpenChange"
    >
      <UButton
        :label="outputOpen ? 'Hide output' : 'Show output'"
        color="neutral"
        variant="ghost"
        trailing-icon="i-lucide-chevron-down"
        size="xs"
        class="w-full justify-between px-2 py-1.5 text-xs"
      />

      <template #content>
        <div class="pt-2">
          <div class="rounded-md bg-muted/10 px-3 py-2">
            <pre class="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">{{ item.aggregated_output }}</pre>
          </div>
        </div>
      </template>
    </UCollapsible>

    <p
      v-else
      class="text-xs text-muted-foreground"
    >
      No output yet.
    </p>
  </div>
</template>
