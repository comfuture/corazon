<script setup lang="ts">
import MarkdownRender from 'markstream-vue'
import 'markstream-vue/index.css'

const props = defineProps<{
  role?: string
  part?: {
    text?: string
    [key: string]: unknown
  } | null
}>()

const { rewriteContentWithLocalImagePreviews } = useLocalFilePreview()
const renderedContent = ref('')

watch(
  [() => props.role, () => props.part?.text],
  async ([role, text], _previousValue, onCleanup) => {
    const sourceText = typeof text === 'string' ? text : ''
    renderedContent.value = sourceText

    if (!import.meta.client || role !== 'assistant' || !sourceText) {
      return
    }

    let cancelled = false
    onCleanup(() => {
      cancelled = true
    })

    const rewritten = await rewriteContentWithLocalImagePreviews(sourceText)
    if (!cancelled) {
      renderedContent.value = rewritten
    }
  },
  { immediate: true }
)
</script>

<template>
  <MarkdownRender
    v-if="role === 'assistant'"
    :content="renderedContent"
  />
  <p
    v-else-if="role === 'user'"
    class="whitespace-pre-wrap"
  >
    {{ part?.text }}
  </p>
</template>
