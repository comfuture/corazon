<script setup lang="ts">
type ToolStatus = 'in_progress' | 'completed' | 'failed' | string | null | undefined

const props = withDefaults(defineProps<{
  text?: string
  suffix?: string
  icon?: string
  status?: ToolStatus
  variant?: 'inline' | 'card'
  defaultOpen?: boolean
  ui?: Record<string, string>
}>(), {
  text: '',
  suffix: undefined,
  icon: undefined,
  status: undefined,
  variant: 'inline',
  defaultOpen: false,
  ui: undefined
})

const isRunning = computed(() => props.status === 'in_progress')
</script>

<template>
  <UChatTool
    :text="text"
    :suffix="suffix"
    :icon="icon"
    :loading="isRunning"
    :streaming="isRunning"
    :variant="variant"
    :default-open="defaultOpen"
    :ui="ui"
  >
    <slot />
  </UChatTool>
</template>
