<script setup lang="ts">
const props = defineProps<{
  part?: {
    url?: string
    mediaType?: string
    filename?: string
    [key: string]: unknown
  } | null
}>()

const fileIconForMediaType = (mediaType?: string) => {
  if (!mediaType) {
    return 'i-lucide-file'
  }
  if (mediaType.startsWith('image/')) {
    return 'i-lucide-image'
  }
  if (mediaType.startsWith('video/')) {
    return 'i-lucide-file-video'
  }
  if (mediaType.startsWith('audio/')) {
    return 'i-lucide-file-audio'
  }
  if (mediaType === 'application/pdf') {
    return 'i-lucide-file-text'
  }
  if (mediaType.includes('spreadsheet')) {
    return 'i-lucide-file-spreadsheet'
  }
  if (mediaType.includes('zip')) {
    return 'i-lucide-file-archive'
  }
  return 'i-lucide-file'
}

const previewUrl = computed(() => {
  if (!props.part?.url || !props.part.mediaType?.startsWith('image/')) {
    return null
  }

  const sourceUrl = props.part.url
  if (
    sourceUrl.startsWith('data:')
    || sourceUrl.startsWith('blob:')
    || sourceUrl.startsWith('http://')
    || sourceUrl.startsWith('https://')
    || sourceUrl.startsWith('/')
  ) {
    return sourceUrl
  }

  if (sourceUrl.startsWith('file://')) {
    const filePath = sourceUrl.replace(/^file:\/\//, '')
    const query = new URLSearchParams({
      path: filePath,
      mediaType: props.part.mediaType
    })
    return `/api/chat/attachments/file?${query.toString()}`
  }

  return null
})
</script>

<template>
  <div class="flex items-center gap-3 rounded-md border border-muted/50 bg-muted/20 p-2 text-sm">
    <UAvatar
      :src="previewUrl ?? undefined"
      :icon="previewUrl ? undefined : fileIconForMediaType(part?.mediaType)"
      size="sm"
      :alt="part?.filename ?? 'Attachment'"
    />
    <div class="min-w-0">
      <div class="truncate font-medium">
        {{ part?.filename ?? 'Attachment' }}
      </div>
      <div class="text-xs text-muted-foreground">
        {{ part?.mediaType ?? 'file' }}
      </div>
    </div>
  </div>
</template>
