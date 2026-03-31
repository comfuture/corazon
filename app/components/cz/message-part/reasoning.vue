<script setup lang="ts">
import MarkdownRender from 'markstream-vue'
import 'markstream-vue/index.css'

defineProps<{
  part?: {
    text?: string
    state?: 'streaming' | 'done'
    ended?: boolean
    providerMetadata?: Record<string, unknown>
    [key: string]: unknown
  } | null
}>()
</script>

<template>
  <UChatReasoning
    icon="i-lucide-brain"
    :text="part?.text ?? ''"
    :streaming="part?.state === 'streaming' && part?.ended !== true"
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
