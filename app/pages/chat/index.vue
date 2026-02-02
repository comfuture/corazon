<script setup lang="ts">
const {
  chat,
  input,
  selectedModel,
  modelOptions,
  threadId,
  pendingThreadId,
  sendMessage,
  regenerate,
  stop,
  clearForNewThread,
  clearInput,
  markAutoRedirect
} = useCodexChat()
const { onCompositionStart, onCompositionEnd, onKeydownEnter, shouldSubmit } = useChatSubmitGuard()
const {
  attachments,
  isDragging,
  isUploading,
  fileInputRef,
  removeAttachment,
  clearAttachments,
  openFilePicker,
  onFileInputChange,
  onDragEnter,
  onDragLeave,
  onDragOver,
  onDrop,
  uploadAttachments
} = useChatAttachments()
const chatPromptRef = ref<{ textareaRef?: HTMLTextAreaElement | null } | null>(null)

const route = useRoute()

clearForNewThread()

const onSubmit = async (event?: Event) => {
  if (!shouldSubmit(event)) {
    return
  }
  if (!input.value.trim() && attachments.value.length === 0) {
    return
  }
  if (isUploading.value) {
    return
  }

  try {
    const { fileParts, uploadId } = await uploadAttachments(threadId.value)
    await sendMessage({ fileParts, attachmentUploadId: uploadId })
    clearAttachments()
  } catch (error) {
    console.error(error)
  }
}

const onReload = () => {
  void regenerate()
}

const onAttachmentInputChange = (event: Event) => {
  onFileInputChange(event)
  nextTick(() => {
    chatPromptRef.value?.textareaRef?.focus()
  })
}

watch(pendingThreadId, async (value) => {
  if (!value) {
    return
  }

  const routeThread = Array.isArray(route.params.thread)
    ? route.params.thread[0]
    : route.params.thread

  if (routeThread === value) {
    pendingThreadId.value = null
    return
  }

  clearInput()
  markAutoRedirect(value)
  await navigateTo(`/chat/${value}`)
  pendingThreadId.value = null
})
</script>

<template>
  <UDashboardPanel
    class="relative h-full min-h-0"
    @dragenter="onDragEnter"
    @dragleave="onDragLeave"
    @dragover="onDragOver"
    @drop="onDrop"
  >
    <template #body>
      <div class="flex h-full items-center justify-center px-4">
        <div class="w-full max-w-2xl">
          <UChatPrompt
            ref="chatPromptRef"
            v-model="input"
            :error="chat?.error"
            :ui="{ body: 'ps-2' }"
            @submit="onSubmit"
            @keydown.enter.capture="onKeydownEnter"
              @compositionstart="onCompositionStart"
              @compositionend="onCompositionEnd"
            >
            <template #leading>
              <div class="flex items-center gap-1 -mt-1.5">
                <UButton
                  icon="i-lucide-plus"
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  class="size-8"
                  aria-label="Add attachments"
                  @click="openFilePicker"
                />
                <input
                  ref="fileInputRef"
                  type="file"
                  multiple
                  class="hidden"
                  @change="onAttachmentInputChange"
                >
              </div>
            </template>

            <template
              v-if="attachments.length"
              #header
            >
              <div
                class="flex flex-wrap gap-2"
              >
                <div
                  v-for="item in attachments"
                  :key="item.id"
                  class="flex items-center gap-1"
                >
                  <UBadge
                    color="neutral"
                    variant="soft"
                    size="sm"
                    :leading-icon="item.icon"
                    class="max-w-[220px]"
                  >
                    <span class="truncate">{{ item.name }}</span>
                  </UBadge>
                  <UButton
                    icon="i-lucide-x"
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    aria-label="Remove attachment"
                    @click="removeAttachment(item.id)"
                  />
                </div>
              </div>
            </template>

            <UChatPromptSubmit
              :status="chat?.status ?? 'ready'"
              @stop="stop"
              @reload="onReload"
            />
          </UChatPrompt>
          <div class="mt-3 flex items-center">
            <USelect
              v-model="selectedModel"
              :items="modelOptions"
              size="sm"
              variant="ghost"
              class="w-40"
            />
          </div>
        </div>
      </div>
    </template>
    <template #footer>
      <div
        v-if="isDragging"
        class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border border-dashed border-primary/60 bg-primary/10 backdrop-blur-sm"
      >
        <div class="flex items-center gap-2 rounded-full bg-background/80 px-4 py-2 text-sm font-medium text-primary shadow">
          <UIcon name="i-lucide-upload-cloud" />
          Drop files to attach
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
