import type { FileUIPart } from 'ai'

type ChatAttachment = {
  id: string
  file: File
  name: string
  size: number
  mediaType: string
  previewUrl: string | null
  icon: string
}

type UploadResponse = {
  uploadId: string | null
  threadId: string | null
  files: Array<{
    filename: string
    mediaType: string | null
    url: string
  }>
}

const getFileIcon = (file: File) => {
  if (file.type.startsWith('image/')) {
    return 'i-lucide-image'
  }
  if (file.type.startsWith('video/')) {
    return 'i-lucide-file-video'
  }
  if (file.type.startsWith('audio/')) {
    return 'i-lucide-file-audio'
  }
  if (file.type === 'application/pdf') {
    return 'i-lucide-file-text'
  }
  if (file.type.includes('spreadsheet') || file.name.endsWith('.csv')) {
    return 'i-lucide-file-spreadsheet'
  }
  if (file.type.includes('zip') || file.name.endsWith('.zip')) {
    return 'i-lucide-file-archive'
  }
  return 'i-lucide-file'
}

export const useChatAttachments = () => {
  const attachments = ref<ChatAttachment[]>([])
  const isDragging = ref(false)
  const isUploading = ref(false)
  const dragDepth = ref(0)
  const fileInputRef = ref<HTMLInputElement | null>(null)

  const createPreviewUrl = (file: File) => {
    if (!import.meta.client) {
      return null
    }
    if (file.type.startsWith('image/')) {
      return URL.createObjectURL(file)
    }
    return null
  }

  const addFiles = (fileList?: FileList | File[] | null) => {
    if (!fileList) {
      return
    }
    const items = Array.from(fileList)
    if (!items.length) {
      return
    }

    const next = items.map(file => ({
      id: crypto.randomUUID(),
      file,
      name: file.name,
      size: file.size,
      mediaType: file.type || 'application/octet-stream',
      previewUrl: createPreviewUrl(file),
      icon: getFileIcon(file)
    }))

    attachments.value = [...attachments.value, ...next]
  }

  const removeAttachment = (id: string) => {
    const existing = attachments.value.find(item => item.id === id)
    if (existing?.previewUrl && import.meta.client) {
      URL.revokeObjectURL(existing.previewUrl)
    }
    attachments.value = attachments.value.filter(item => item.id !== id)
  }

  const clearAttachments = () => {
    if (import.meta.client) {
      attachments.value.forEach((item) => {
        if (item.previewUrl) {
          URL.revokeObjectURL(item.previewUrl)
        }
      })
    }
    attachments.value = []
  }

  const openFilePicker = () => {
    fileInputRef.value?.click()
  }

  const onFileInputChange = (event: Event) => {
    const target = event.target as HTMLInputElement | null
    if (!target?.files) {
      return
    }
    addFiles(target.files)
    target.value = ''
  }

  const onDragEnter = (event: DragEvent) => {
    if (!event.dataTransfer?.types?.includes('Files')) {
      return
    }
    dragDepth.value += 1
    isDragging.value = true
  }

  const onDragLeave = () => {
    dragDepth.value = Math.max(0, dragDepth.value - 1)
    if (dragDepth.value === 0) {
      isDragging.value = false
    }
  }

  const onDragOver = (event: DragEvent) => {
    if (event.dataTransfer?.types?.includes('Files')) {
      event.preventDefault()
    }
  }

  const onDrop = (event: DragEvent) => {
    if (!event.dataTransfer?.files?.length) {
      dragDepth.value = 0
      isDragging.value = false
      return
    }
    event.preventDefault()
    addFiles(event.dataTransfer.files)
    dragDepth.value = 0
    isDragging.value = false
  }

  const uploadAttachments = async (threadId?: string | null) => {
    if (!attachments.value.length) {
      return { fileParts: [] as FileUIPart[], uploadId: null as string | null }
    }

    const formData = new FormData()
    attachments.value.forEach((attachment) => {
      formData.append('files', attachment.file, attachment.name)
    })

    if (threadId) {
      formData.append('threadId', threadId)
    }

    isUploading.value = true
    try {
      const response = await $fetch<UploadResponse>('/api/chat/attachments', {
        method: 'POST',
        body: formData
      })

      const fileParts = response.files.map(file => ({
        type: 'file' as const,
        url: file.url,
        filename: file.filename,
        mediaType: file.mediaType ?? 'application/octet-stream'
      }))

      return { fileParts, uploadId: response.uploadId }
    } finally {
      isUploading.value = false
    }
  }

  return {
    attachments,
    isDragging,
    isUploading,
    fileInputRef,
    addFiles,
    removeAttachment,
    clearAttachments,
    openFilePicker,
    onFileInputChange,
    onDragEnter,
    onDragLeave,
    onDragOver,
    onDrop,
    uploadAttachments
  }
}
