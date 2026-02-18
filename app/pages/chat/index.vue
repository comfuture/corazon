<script setup lang="ts">
const {
  chat,
  input,
  selectedModel,
  modelOptions,
  skipGitRepoCheck,
  workdirRoot,
  loadWorkdirRoot,
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

const isInFlightWithoutResolvedThread = computed(() => {
  const status = chat.value?.status
  const inFlight = status === 'submitted' || status === 'streaming'
  return inFlight && (!threadId.value || !!pendingThreadId.value)
})

if (!isInFlightWithoutResolvedThread.value) {
  clearForNewThread()
}

const onSubmit = async (event?: Event, overrideText?: string, reusePendingMessageId = false) => {
  if (event && !shouldSubmit(event)) {
    return
  }
  const messageText = (overrideText ?? input.value).trim()
  if (!messageText && attachments.value.length === 0) {
    return
  }
  if (isUploading.value) {
    return
  }

  try {
    const { fileParts, uploadId } = await uploadAttachments(threadId.value)
    if (overrideText !== undefined) {
      await sendMessage({
        fileParts,
        attachmentUploadId: uploadId,
        text: messageText.length ? messageText : undefined,
        reusePendingMessageId
      })
    } else {
      await sendMessage({ fileParts, attachmentUploadId: uploadId })
    }
    clearAttachments()
  } catch (error) {
    console.error(error)
  }
}

const onReload = () => {
  void regenerate()
}

const trustErrorMessage = computed(() => chat.value?.error?.message ?? '')
const isTrustError = computed(() => {
  const message = trustErrorMessage.value
  return message.includes('Not inside a trusted directory')
    || message.includes('skip-git-repo-check')
})
const showTrustAlert = computed(() => isTrustError.value && !skipGitRepoCheck.value)
const hasVisibleMessages = computed(() => (chat.value?.messages?.length ?? 0) > 0)
const showMessageStage = computed(() => {
  const status = chat.value?.status
  return hasVisibleMessages.value || status === 'submitted' || status === 'streaming'
})
const trustConfigSnippet = computed(() => {
  const target = workdirRoot.value
  if (!target) {
    return 'Loading...'
  }
  return `[projects."${target}"]\ntrust_level = "trusted"`
})
const trustSnippetCopied = ref(false)

const retryTrustedSubmission = async () => {
  if (!isTrustError.value) {
    return
  }
  const draft = input.value
  if (!draft.trim() && attachments.value.length === 0) {
    return
  }
  input.value = ''
  await onSubmit(undefined, draft, true)
}

watch(skipGitRepoCheck, (value) => {
  if (value) {
    void retryTrustedSubmission()
  }
})

const copyTrustSnippet = async () => {
  if (!import.meta.client) {
    return
  }
  const value = trustConfigSnippet.value
  if (!value || value === 'Loading...') {
    return
  }
  try {
    await navigator.clipboard.writeText(value)
    trustSnippetCopied.value = true
    window.setTimeout(() => {
      trustSnippetCopied.value = false
    }, 1500)
  } catch (error) {
    console.error(error)
  }
}

onMounted(() => {
  void loadWorkdirRoot()
})

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
      <div class="flex h-full min-h-0 flex-col">
        <UContainer
          v-if="showMessageStage"
          class="min-h-0 flex-1 pt-3 sm:pt-4"
        >
          <UChatMessages
            :messages="chat?.messages ?? []"
            :status="chat?.status ?? 'ready'"
            :ui="{ root: 'codex-chat-messages-root' }"
            should-auto-scroll
          >
            <template #content="{ message }">
              <cz-message-content :message="message" />
            </template>
          </UChatMessages>
        </UContainer>
        <div :class="showMessageStage ? 'px-4 pb-4 sm:pb-6' : 'flex flex-1 items-center justify-center px-4'">
          <div class="w-full max-w-2xl">
            <UAlert
              v-if="showTrustAlert"
              color="warning"
              variant="soft"
              icon="i-lucide-shield-alert"
              title="Untrusted working directory"
              class="mb-4"
            >
              <template #description>
                <div class="space-y-3 text-sm">
                  <p>
                    Codex only runs inside trusted directories. Add your working directory to
                    <span class="font-mono text-xs">~/.codex/config.toml</span>:
                  </p>
                  <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <pre class="w-full rounded-md bg-muted/40 px-3 py-2 text-xs sm:w-auto sm:flex-1">{{ trustConfigSnippet }}</pre>
                    <UButton
                      :label="trustSnippetCopied ? 'Copied' : 'Copy'"
                      icon="i-lucide-copy"
                      size="xs"
                      variant="ghost"
                      @click="copyTrustSnippet"
                    />
                  </div>
                  <p class="text-xs text-muted-foreground">
                    Security note: bypassing this check lets Codex run outside a Git repo and may
                    write to your filesystem.
                  </p>
                  <UCheckbox
                    v-model="skipGitRepoCheck"
                    label="I understand the risks and want to run with --skip-git-repo-check"
                  />
                </div>
              </template>
            </UAlert>
            <UChatPrompt
              ref="chatPromptRef"
              v-model="input"
              :error="skipGitRepoCheck ? undefined : chat?.error"
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
              <cz-model-select
                v-model="selectedModel"
                :items="modelOptions"
                class="w-40"
              />
            </div>
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
