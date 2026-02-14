<script setup lang="ts">
type ModelOption = {
  label: string
  value: string
}

defineProps<{
  items: ModelOption[]
}>()

const modelValue = defineModel<string>({ required: true })
</script>

<template>
  <USelect
    v-model="modelValue"
    :items="items"
    size="sm"
    variant="ghost"
    v-bind="$attrs"
  />
</template>
