<script setup lang="ts">
const {
  chat,
  input,
  selectedModel,
  modelOptions,
  skipGitRepoCheck,
  workdirRoot,
  loadWorkdirRoot,
  setThreadFromRoute,
  sendMessage,
  regenerate,
  stop
} = useCodexChat()
const { threads, refreshThreads } = useCodexThreads()
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
const router = useRouter()
const routeThreadId = computed(() => {
  const param = route.params.thread
  if (Array.isArray(param)) {
    return param[0]
  }
  return typeof param === 'string' ? param : null
})
const isDeleteModalOpen = ref(false)
const isDeletingThread = ref(false)
const deleteError = ref<string | null>(null)

const openDeleteModal = () => {
  if (!routeThreadId.value) {
    return
  }
  deleteError.value = null
  isDeleteModalOpen.value = true
}

const confirmDeleteThread = async () => {
  const threadId = routeThreadId.value
  if (!threadId || isDeletingThread.value) {
    return
  }
  isDeletingThread.value = true
  deleteError.value = null
  try {
    await $fetch(`/api/chat/threads/${threadId}`, { method: 'DELETE' })
    isDeleteModalOpen.value = false
    await refreshThreads()
    await router.push('/chat')
  } catch (error) {
    console.error(error)
    const message = (error as { data?: { statusMessage?: string } })?.data?.statusMessage
    deleteError.value = message || 'Failed to delete chat.'
  } finally {
    isDeletingThread.value = false
  }
}

watch(
  routeThreadId,
  (value) => {
    if (value) {
      void setThreadFromRoute(value)
    }
  },
  { immediate: true }
)

onMounted(() => {
  void refreshThreads()
  void loadWorkdirRoot()
})

const threadTitle = computed(() => {
  const id = routeThreadId.value
  if (!id) {
    return null
  }
  return threads.value.find(thread => thread.id === id)?.title ?? null
})

const threadTokens = computed(() => {
  const id = routeThreadId.value
  if (!id) {
    return null
  }
  const thread = threads.value.find(item => item.id === id)
  if (!thread) {
    return null
  }
  return thread.totalInputTokens + thread.totalCachedInputTokens + thread.totalOutputTokens
})

const threadWorkingDirectory = computed(() => {
  const id = routeThreadId.value
  if (!id) {
    return null
  }
  return threads.value.find(item => item.id === id)?.workingDirectory ?? null
})

const trustErrorMessage = computed(() => chat.value?.error?.message ?? '')
const isTrustError = computed(() => {
  const message = trustErrorMessage.value
  return message.includes('Not inside a trusted directory')
    || message.includes('skip-git-repo-check')
})
const showTrustAlert = computed(() => isTrustError.value && !skipGitRepoCheck.value)
const trustConfigSnippet = computed(() => {
  const target = threadWorkingDirectory.value ?? workdirRoot.value
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

const threadUsage = computed(() => {
  const id = routeThreadId.value
  if (!id) {
    return null
  }
  const thread = threads.value.find(item => item.id === id)
  if (!thread) {
    return null
  }
  return {
    input: thread.totalInputTokens,
    cached: thread.totalCachedInputTokens,
    output: thread.totalOutputTokens
  }
})

const formatTokenTotal = (value: number) => {
  if (value < 1000) {
    return String(value)
  }
  const short = value / 1000
  const rounded = short >= 10 ? short.toFixed(0) : short.toFixed(1)
  return `${rounded.replace(/\.0$/, '')}k`
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
    const { fileParts, uploadId } = await uploadAttachments(routeThreadId.value)
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

const onAttachmentInputChange = (event: Event) => {
  onFileInputChange(event)
  nextTick(() => {
    chatPromptRef.value?.textareaRef?.focus()
  })
}
</script>

<template>
  <UDashboardPanel
    class="relative h-full min-h-0"
    @dragenter="onDragEnter"
    @dragleave="onDragLeave"
    @dragover="onDragOver"
    @drop="onDrop"
  >
    <template #header>
      <UDashboardNavbar>
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #title>
          <div class="flex min-w-0 items-center gap-2">
            <span class="truncate">{{ threadTitle ?? routeThreadId ?? 'Chat' }}</span>
            <UButton
              icon="i-lucide-trash-2"
              color="neutral"
              variant="ghost"
              size="xs"
              class="text-muted-foreground hover:text-foreground"
              aria-label="Delete chat"
              :disabled="!routeThreadId"
              @click="openDeleteModal"
            />
          </div>
        </template>
        <template #right>
          <div class="flex items-center gap-3">
            <div
              v-if="threadTokens !== null && threadUsage"
              class="text-right leading-tight text-muted-foreground"
            >
              <div class="text-xs font-medium">
                {{ formatTokenTotal(threadTokens) }} tokens
              </div>
              <div class="text-[11px] text-muted-foreground/80">
                in {{ formatTokenTotal(threadUsage.input) }}
                ({{ formatTokenTotal(threadUsage.cached) }})
                · out {{ formatTokenTotal(threadUsage.output) }}
              </div>
            </div>
            <UButton
              to="/chat"
              icon="i-lucide-plus"
              label="New chat"
              color="primary"
              variant="soft"
              size="sm"
              class="hidden sm:inline-flex"
            />
            <UButton
              to="/chat"
              icon="i-lucide-plus"
              color="primary"
              variant="soft"
              size="sm"
              class="sm:hidden"
              aria-label="New chat"
            />
          </div>
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <UContainer>
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
      <UContainer class="pb-4 sm:pb-6">
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
      </UContainer>
      <UModal
        v-model:open="isDeleteModalOpen"
        title="Delete chat?"
        description="This permanently deletes the current chat thread."
        :ui="{ footer: 'justify-end' }"
      >
        <template #body>
          <p class="text-sm text-muted-foreground">
            This action cannot be undone. You will be redirected to start a new chat.
          </p>
          <UAlert
            v-if="deleteError"
            color="error"
            variant="soft"
            :title="deleteError"
            class="mt-4"
          />
        </template>
        <template #footer>
          <div class="flex gap-2">
            <UButton
              label="Cancel"
              color="neutral"
              variant="outline"
              :disabled="isDeletingThread"
              @click="isDeleteModalOpen = false; deleteError = null"
            />
            <UButton
              label="Delete"
              color="error"
              :loading="isDeletingThread"
              @click="confirmDeleteThread"
            />
          </div>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
