<script setup lang="ts">
import MarkdownRender from 'markstream-vue'
import 'markstream-vue/index.css'

defineProps<{
  role?: string
  part?: {
    text?: string
    [key: string]: unknown
  } | null
}>()
</script>

<template>
  <MarkdownRender
    v-if="role === 'assistant'"
    :content="part?.text ?? ''"
  />
  <p
    v-else-if="role === 'user'"
    class="whitespace-pre-wrap"
  >
    {{ part?.text }}
  </p>
</template>
