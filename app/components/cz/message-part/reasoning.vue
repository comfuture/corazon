<script setup lang="ts">
import MarkdownRender from 'markstream-vue'
import 'markstream-vue/index.css'

const props = defineProps<{
  part?: {
    text?: string
    state?: 'streaming' | 'done'
    ended?: boolean
    providerMetadata?: Record<string, unknown>
    [key: string]: unknown
  } | null
}>()

const getReasoningDurationSeconds = () => {
  const raw = props.part?.providerMetadata?.thinkingDurationMs
  if (typeof raw === 'number') {
    return Math.max(1, Math.ceil(raw / 1000))
  }
  if (raw && typeof raw === 'object' && 'value' in raw) {
    const value = (raw as { value?: unknown }).value
    return typeof value === 'number' ? Math.max(1, Math.ceil(value / 1000)) : undefined
  }
  return undefined
}

const reasoningDurationSeconds = computed(getReasoningDurationSeconds)
const isStreaming = computed(() => props.part?.state === 'streaming' && props.part?.ended !== true)
</script>

<template>
  <UChatReasoning
    icon="i-lucide-brain"
    :text="part?.text ?? ''"
    :streaming="isStreaming"
    :duration="reasoningDurationSeconds"
    :ui="{
      root: 'flex flex-col gap-2',
      body: 'reasoning-muted max-h-[200px] pt-2 overflow-y-auto text-sm text-dimmed'
    }"
  >
    <div class="reasoning-muted">
      <MarkdownRender :content="part?.text ?? ''" />
    </div>
  </UChatReasoning>
</template>

<style scoped>
.reasoning-muted :deep(.markdown-renderer.markstream-vue *) {
  font-size: 0.875rem;
  color: var(--ui-color-muted-foreground);
}
</style>
