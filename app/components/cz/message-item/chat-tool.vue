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

const open = ref(props.defaultOpen)
const isStreaming = computed(() => props.status === 'in_progress')

watch(() => props.status, (status, previous) => {
  if (status === 'in_progress' || status === 'failed') {
    open.value = true
    return
  }

  if (status === 'completed' && previous === 'in_progress') {
    open.value = false
  }
}, { immediate: true })
</script>

<template>
  <UChatTool
    :text="text"
    :suffix="suffix"
    :icon="icon"
    :streaming="isStreaming"
    :variant="variant"
    :open="open"
    :ui="ui"
    @update:open="open = $event"
  >
    <slot />
  </UChatTool>
</template>
