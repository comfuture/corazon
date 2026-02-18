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
const reasoningEnded = computed(() => props.part?.ended === true || props.part?.state === 'done')
const open = ref(!reasoningEnded.value)

watch(reasoningEnded, (ended) => {
  if (ended) {
    open.value = false
  }
}, { immediate: true })

const label = computed(() =>
  reasoningDurationMs.value == null ? 'Thinking...' : formatThinkingDuration(reasoningDurationMs.value)
)

const toggleOpen = () => {
  open.value = !open.value
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <UButton
      color="neutral"
      variant="ghost"
      size="sm"
      class="w-full justify-between px-0 py-0.5 text-muted"
      @click="toggleOpen"
    >
      <span>{{ label }}</span>
      <template #trailing>
        <UIcon
          name="i-lucide-chevron-right"
          class="size-3.5 text-muted transition-transform"
          :class="open ? 'rotate-90' : ''"
        />
      </template>
    </UButton>

    <div
      v-if="open"
      class="reasoning-muted"
    >
      <MarkdownRender :content="part?.text ?? ''" />
    </div>
  </div>
</template>

<style scoped>
.reasoning-muted :deep(.markdown-renderer.markstream-vue *) {
  font-size: 0.875rem;
  color: var(--ui-color-muted-foreground);
}
</style>
