<script setup lang="ts">
import MarkdownRender from 'markstream-vue'
import 'markstream-vue/index.css'

const props = defineProps<{
  part?: {
    text?: string
    providerMetadata?: Record<string, unknown>
    [key: string]: unknown
  } | null
}>()

const getReasoningDurationMs = () => {
  const raw = props.part?.providerMetadata?.thinkingDurationMs
  if (typeof raw === 'number') {
    return raw
  }
  if (raw && typeof raw === 'object' && 'value' in raw) {
    const value = (raw as { value?: unknown }).value
    return typeof value === 'number' ? value : null
  }
  return null
}

const formatThinkingDuration = (durationMs: number) => {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000))
  if (totalSeconds < 60) {
    return `Thought for ${totalSeconds}s`
  }
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `Thought for ${minutes}m ${String(seconds).padStart(2, '0')}s`
}

const reasoningDurationMs = computed(getReasoningDurationMs)
const open = ref(true)
const settled = ref(false)

watch(reasoningDurationMs, (durationMs) => {
  if (durationMs != null && !settled.value) {
    settled.value = true
    open.value = false
    return
  }

  if (!settled.value) {
    open.value = durationMs == null
  }
}, { immediate: true })

const label = computed(() =>
  reasoningDurationMs.value == null ? 'Thinking...' : formatThinkingDuration(reasoningDurationMs.value)
)

const onOpenChange = (value: boolean) => {
  open.value = value
}
</script>

<template>
  <UCollapsible
    :open="open"
    class="flex flex-col gap-2 rounded-md border border-muted/50 bg-muted/30 p-2"
    @update:open="onOpenChange"
  >
    <UButton
      :label="label"
      color="neutral"
      variant="ghost"
      trailing-icon="i-lucide-chevron-down"
      size="sm"
      class="justify-between"
    />

    <template #content>
      <div class="reasoning-muted">
        <MarkdownRender :content="part?.text ?? ''" />
      </div>
    </template>
  </UCollapsible>
</template>

<style scoped>
.reasoning-muted :deep(.markdown-renderer.markstream-vue *) {
  font-size: 0.875rem;
  color: var(--ui-color-muted-foreground);
}
</style>
