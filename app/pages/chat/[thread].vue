<script setup lang="ts">
import type { DataUIPart } from 'ai'
import MarkdownRender from 'markstream-vue'
import 'markstream-vue/index.css'
import {
  CODEX_EVENT_PART,
  CODEX_ITEM_PART,
  type CodexItemData,
  type CodexThreadEventData,
  type CodexUIDataTypes
} from '@@/types/codex-ui'

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
const routeThreadId = computed(() => {
  const param = route.params.thread
  if (Array.isArray(param)) {
    return param[0]
  }
  return typeof param === 'string' ? param : null
})

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

const asCodeBlock = (value: string, language = 'text') => {
  const content = value.trim().length > 0 ? value : '(empty)'
  return `\`\`\`${language}\n${content}\n\`\`\``
}

const formatJson = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2) ?? ''
  } catch {
    return String(value)
  }
}

const statusColor = (status?: string) => {
  switch (status) {
    case 'completed':
      return 'success'
    case 'failed':
      return 'error'
    case 'in_progress':
      return 'warning'
    default:
      return 'neutral'
  }
}

const changeKindColor = (kind?: string) => {
  switch (kind) {
    case 'add':
      return 'success'
    case 'delete':
      return 'error'
    case 'update':
      return 'warning'
    default:
      return 'neutral'
  }
}

const eventColor = (event?: CodexThreadEventData) => {
  if (!event) {
    return 'neutral'
  }

  switch (event.kind) {
    case 'turn.failed':
    case 'stream.error':
      return 'error'
    case 'turn.completed':
      return 'success'
    default:
      return 'neutral'
  }
}

const eventTitle = (event?: CodexThreadEventData) => {
  if (!event) {
    return 'Event'
  }

  switch (event.kind) {
    case 'thread.started':
      return 'Thread started'
    case 'thread.title':
      return 'Thread title updated'
    case 'turn.started':
      return 'Turn started'
    case 'turn.completed':
      return 'Turn completed'
    case 'turn.failed':
      return 'Turn failed'
    case 'stream.error':
      return 'Stream error'
    default:
      return 'Event'
  }
}

const isPartWithType = (part: unknown): part is { type: string } =>
  typeof part === 'object' && part !== null && 'type' in part

const asCodexEventPart = (part: unknown) =>
  isPartWithType(part) && part.type === CODEX_EVENT_PART
    ? (part as DataUIPart<CodexUIDataTypes> & { type: typeof CODEX_EVENT_PART, data: CodexThreadEventData })
    : undefined

const asCodexItemPart = (part: unknown) =>
  isPartWithType(part) && part.type === CODEX_ITEM_PART
    ? (part as DataUIPart<CodexUIDataTypes> & { type: typeof CODEX_ITEM_PART, data: CodexItemData })
    : undefined

type CommandExecutionItem = Extract<CodexItemData, { kind: 'command_execution' }>['item']
type FileChangeItem = Extract<CodexItemData, { kind: 'file_change' }>['item']
type McpToolCallItem = Extract<CodexItemData, { kind: 'mcp_tool_call' }>['item']
type WebSearchItem = Extract<CodexItemData, { kind: 'web_search' }>['item']
type TodoListItem = Extract<CodexItemData, { kind: 'todo_list' }>['item']
type ErrorItem = Extract<CodexItemData, { kind: 'error' }>['item']

const getEventData = (part: unknown) => asCodexEventPart(part)?.data

const getReasoningKey = (message: { id?: string } | null | undefined, index: number) =>
  `${message?.id ?? 'message'}-reasoning-${index}`

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

const getFilePreviewUrl = (part?: { url?: string, mediaType?: string }) => {
  if (!part?.url || !part.mediaType?.startsWith('image/')) {
    return null
  }
  return part.url.startsWith('data:') ? part.url : null
}

const reasoningOpenState = reactive(new Map<string, boolean>())
const reasoningCompletionState = reactive(new Map<string, boolean>())

const getReasoningDurationMs = (
  message: { parts?: unknown[] } | null | undefined,
  index: number
) => {
  const part = message?.parts?.[index]
  if (part && typeof part === 'object' && 'type' in part && part.type === 'reasoning') {
    const metadata = (part as { providerMetadata?: Record<string, unknown> }).providerMetadata
    const raw = metadata?.thinkingDurationMs
    if (typeof raw === 'number') {
      return raw
    }
    if (raw && typeof raw === 'object' && 'value' in raw) {
      const value = (raw as { value?: unknown }).value
      return typeof value === 'number' ? value : null
    }
    return null
  }
  return null
}

const formatThinkingDuration = (durationMs: number) => {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000))
  if (totalSeconds < 60) {
    return `Thought for ${totalSeconds}s`
  }
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `Thought for ${minutes}m ${String(seconds).padStart(2, '0')}s`
}

const getReasoningLabel = (
  message: { parts?: unknown[] } | null | undefined,
  index: number
) => {
  const durationMs = getReasoningDurationMs(message, index)
  return durationMs == null ? 'Thinking...' : formatThinkingDuration(durationMs)
}

const commandOutputOpenState = reactive(new Map<string, boolean>())
const commandStatusState = reactive(new Map<string, string>())

const getCommandKey = (item?: CommandExecutionItem | null) => {
  if (!item?.id) {
    return null
  }
  return `command-${item.id}`
}

const syncCommandOutputState = (item?: CommandExecutionItem | null) => {
  const key = getCommandKey(item)
  if (!key || !item) {
    return
  }
  const lastStatus = commandStatusState.get(key)
  if (lastStatus === item.status) {
    return
  }
  commandStatusState.set(key, item.status)
  if (item.status !== 'in_progress') {
    commandOutputOpenState.set(key, false)
  }
}

const isCommandOutputOpen = (item?: CommandExecutionItem | null) => {
  const key = getCommandKey(item)
  if (!key || !item) {
    return false
  }
  syncCommandOutputState(item)
  if (commandOutputOpenState.has(key)) {
    return commandOutputOpenState.get(key) ?? false
  }
  return item.status === 'in_progress'
}

const setCommandOutputOpen = (item: CommandExecutionItem | undefined, open: boolean) => {
  const key = getCommandKey(item)
  if (!key) {
    return
  }
  commandOutputOpenState.set(key, open)
}

const isReasoningOpen = (
  message: { id?: string, parts?: unknown[] } | null | undefined,
  index: number
) => {
  const key = getReasoningKey(message, index)
  const durationMs = getReasoningDurationMs(message, index)
  if (durationMs != null && !reasoningCompletionState.get(key)) {
    reasoningCompletionState.set(key, true)
    reasoningOpenState.set(key, false)
  }
  if (reasoningOpenState.has(key)) {
    return reasoningOpenState.get(key) ?? false
  }
  return durationMs == null
}

const setReasoningOpen = (
  message: { id?: string, parts?: unknown[] } | null | undefined,
  index: number,
  open: boolean
) => {
  const key = getReasoningKey(message, index)
  reasoningOpenState.set(key, open)
}

const shouldRenderEvent = (part: unknown) => {
  const data = getEventData(part)
  if (!data) {
    return false
  }
  return data.kind !== 'thread.started'
    && data.kind !== 'turn.started'
    && data.kind !== 'turn.completed'
    && data.kind !== 'thread.title'
}

const getThreadId = (part: unknown) => {
  const data = getEventData(part)
  return data?.kind === 'thread.started' ? data.threadId : undefined
}

const getTurnErrorMessage = (part: unknown) => {
  const data = getEventData(part)
  return data?.kind === 'turn.failed' ? data.error?.message : undefined
}

const getStreamErrorMessage = (part: unknown) => {
  const data = getEventData(part)
  return data?.kind === 'stream.error' ? data.message : undefined
}

const getItemData = (part: unknown) => asCodexItemPart(part)?.data

const getCommandExecutionItem = (part: unknown): CommandExecutionItem | undefined => {
  const data = getItemData(part)
  return data?.kind === 'command_execution' ? data.item : undefined
}

const getFileChangeItem = (part: unknown): FileChangeItem | undefined => {
  const data = getItemData(part)
  return data?.kind === 'file_change' ? data.item : undefined
}

const getMcpToolCallItem = (part: unknown): McpToolCallItem | undefined => {
  const data = getItemData(part)
  return data?.kind === 'mcp_tool_call' ? data.item : undefined
}

const getWebSearchItem = (part: unknown): WebSearchItem | undefined => {
  const data = getItemData(part)
  return data?.kind === 'web_search' ? data.item : undefined
}

const getTodoListItem = (part: unknown): TodoListItem | undefined => {
  const data = getItemData(part)
  return data?.kind === 'todo_list' ? data.item : undefined
}

const getErrorItem = (part: unknown): ErrorItem | undefined => {
  const data = getItemData(part)
  return data?.kind === 'error' ? data.item : undefined
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
      <UDashboardNavbar :title="threadTitle ?? routeThreadId ?? 'Chat'">
        <template #leading>
          <UDashboardSidebarCollapse />
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
          should-auto-scroll
        >
          <template #content="{ message }">
            <div class="space-y-4">
              <template
                v-for="(part, index) in message?.parts ?? []"
                :key="`${message?.id}-${part?.type}-${index}`"
              >
                <MarkdownRender
                  v-if="part?.type === 'text' && message?.role === 'assistant'"
                  :content="part?.text ?? ''"
                />
                <p
                  v-else-if="part?.type === 'text' && message?.role === 'user'"
                  class="whitespace-pre-wrap"
                >
                  {{ part?.text }}
                </p>

                <div
                  v-else-if="part?.type === 'file'"
                  class="flex items-center gap-3 rounded-md border border-muted/50 bg-muted/20 p-2 text-sm"
                >
                  <UAvatar
                    :src="getFilePreviewUrl(part) ?? undefined"
                    :icon="getFilePreviewUrl(part) ? undefined : fileIconForMediaType(part?.mediaType)"
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

                <UCollapsible
                  v-else-if="part?.type === 'reasoning'"
                  :open="isReasoningOpen(message, index)"
                  class="flex flex-col gap-2 rounded-md border border-muted/50 bg-muted/30 p-2"
                  @update:open="value => setReasoningOpen(message, index, value)"
                >
                  <UButton
                    :label="getReasoningLabel(message, index)"
                    color="neutral"
                    variant="ghost"
                    trailing-icon="i-lucide-chevron-down"
                    size="sm"
                    class="justify-between"
                  />

                  <template #content>
                    <div class="reasoning-muted">
                      <MarkdownRender :content="part?.text ?? ''" />
                    </div>
                  </template>
                </UCollapsible>

                <UAlert
                  v-else-if="part?.type === CODEX_EVENT_PART && shouldRenderEvent(part)"
                  :color="eventColor(getEventData(part))"
                  variant="soft"
                  icon="i-lucide-activity"
                  :title="eventTitle(getEventData(part))"
                >
                  <template #description>
                    <template v-if="getEventData(part)?.kind === 'thread.started'">
                      <span class="font-mono text-xs">{{ getThreadId(part) }}</span>
                    </template>

                    <template v-else-if="getEventData(part)?.kind === 'turn.failed'">
                      <span class="text-sm">{{ getTurnErrorMessage(part) }}</span>
                    </template>

                    <template v-else-if="getEventData(part)?.kind === 'stream.error'">
                      <span class="text-sm">{{ getStreamErrorMessage(part) }}</span>
                    </template>

                    <template v-else>
                      <span class="text-sm text-muted">Codex event received.</span>
                    </template>
                  </template>
                </UAlert>

                <template v-else-if="part?.type === CODEX_ITEM_PART">
                  <template v-if="getCommandExecutionItem(part)">
                    <div class="relative rounded-md border border-muted/50 bg-muted/20 p-3 space-y-2">
                      <div class="absolute right-3 top-3">
                        <UIcon
                          v-if="getCommandExecutionItem(part)?.status === 'in_progress'"
                          name="i-lucide-loader-2"
                          class="h-4 w-4 animate-spin text-amber-500"
                        />
                        <UIcon
                          v-else-if="getCommandExecutionItem(part)?.status === 'completed'"
                          name="i-lucide-check"
                          class="h-4 w-4 text-emerald-500"
                        />
                        <UIcon
                          v-else-if="getCommandExecutionItem(part)?.status === 'failed'"
                          name="i-lucide-x"
                          class="h-4 w-4 text-rose-500"
                        />
                      </div>
                      <div class="flex flex-wrap items-center gap-2 text-xs">
                        <UBadge
                          color="primary"
                          variant="subtle"
                        >
                          Command
                        </UBadge>
                        <span class="font-mono text-xs break-all">
                          {{ getCommandExecutionItem(part)?.command }}
                        </span>
                      </div>

                      <UCollapsible
                        v-if="getCommandExecutionItem(part)?.aggregated_output"
                        :open="isCommandOutputOpen(getCommandExecutionItem(part))"
                        class="rounded-md border border-muted/40 bg-background/60"
                        @update:open="value => setCommandOutputOpen(getCommandExecutionItem(part) ?? undefined, value)"
                      >
                        <UButton
                          :label="isCommandOutputOpen(getCommandExecutionItem(part)) ? 'Hide output' : 'Show output'"
                          color="neutral"
                          variant="ghost"
                          trailing-icon="i-lucide-chevron-down"
                          size="xs"
                          class="w-full justify-between px-2 py-1.5 text-xs"
                        />

                        <template #content>
                          <div class="pt-2">
                            <div class="rounded-md bg-muted/10 px-3 py-2">
                              <pre class="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">{{ getCommandExecutionItem(part)?.aggregated_output }}</pre>
                            </div>
                          </div>
                        </template>
                      </UCollapsible>

                      <p
                        v-else
                        class="text-xs text-muted-foreground"
                      >
                        No output yet.
                      </p>
                    </div>
                  </template>

                  <template v-else-if="getFileChangeItem(part)">
                    <UCard>
                      <template #header>
                        <div class="flex flex-wrap items-center gap-2">
                          <UBadge
                            color="primary"
                            variant="subtle"
                          >
                            File changes
                          </UBadge>
                          <UBadge
                            :color="statusColor(getFileChangeItem(part)?.status)"
                            variant="soft"
                          >
                            {{ getFileChangeItem(part)?.status }}
                          </UBadge>
                        </div>
                      </template>

                      <ul class="space-y-2 text-sm">
                        <li
                          v-for="(change, changeIndex) in getFileChangeItem(part)?.changes ?? []"
                          :key="`${getFileChangeItem(part)?.id}-${change?.path}-${changeIndex}`"
                          class="flex items-center gap-2"
                        >
                          <UBadge
                            :color="changeKindColor(change?.kind)"
                            variant="soft"
                          >
                            {{ change?.kind }}
                          </UBadge>
                          <span class="font-mono text-xs break-all">{{ change?.path }}</span>
                        </li>
                      </ul>
                    </UCard>
                  </template>

                  <template v-else-if="getMcpToolCallItem(part)">
                    <UCard>
                      <template #header>
                        <div class="flex flex-wrap items-center gap-2">
                          <UBadge
                            color="primary"
                            variant="subtle"
                          >
                            MCP
                          </UBadge>
                          <span class="text-xs">{{ getMcpToolCallItem(part)?.server }}</span>
                          <span class="font-mono text-xs">{{ getMcpToolCallItem(part)?.tool }}</span>
                          <UBadge
                            :color="statusColor(getMcpToolCallItem(part)?.status)"
                            variant="soft"
                          >
                            {{ getMcpToolCallItem(part)?.status }}
                          </UBadge>
                        </div>
                      </template>

                      <div class="space-y-3">
                        <div>
                          <div class="text-xs font-semibold text-muted">
                            Arguments
                          </div>
                          <MarkdownRender
                            :content="
                              asCodeBlock(formatJson(getMcpToolCallItem(part)?.arguments), 'json')
                            "
                          />
                        </div>

                        <div v-if="getMcpToolCallItem(part)?.result">
                          <div class="text-xs font-semibold text-muted">
                            Result
                          </div>
                          <MarkdownRender
                            :content="
                              asCodeBlock(formatJson(getMcpToolCallItem(part)?.result), 'json')
                            "
                          />
                        </div>

                        <UAlert
                          v-if="getMcpToolCallItem(part)?.error"
                          color="error"
                          variant="soft"
                          icon="i-lucide-alert-triangle"
                          title="Tool error"
                        >
                          <template #description>
                            {{ getMcpToolCallItem(part)?.error?.message }}
                          </template>
                        </UAlert>
                      </div>
                    </UCard>
                  </template>

                  <template v-else-if="getWebSearchItem(part)">
                    <UAlert
                      color="info"
                      variant="soft"
                      icon="i-lucide-search"
                      title="Web search"
                    >
                      <template #description>
                        {{ getWebSearchItem(part)?.query }}
                      </template>
                    </UAlert>
                  </template>

                  <template v-else-if="getTodoListItem(part)">
                    <UCard>
                      <template #header>
                        <div class="flex items-center gap-2">
                          <UBadge
                            color="primary"
                            variant="subtle"
                          >
                            Todo list
                          </UBadge>
                          <UBadge
                            color="neutral"
                            variant="subtle"
                          >
                            {{ getTodoListItem(part)?.items?.length ?? 0 }} items
                          </UBadge>
                        </div>
                      </template>

                      <ul class="space-y-2">
                        <li
                          v-for="(todo, todoIndex) in getTodoListItem(part)?.items ?? []"
                          :key="`${getTodoListItem(part)?.id}-${todoIndex}`"
                          class="flex items-start gap-2"
                        >
                          <UCheckbox
                            :model-value="todo?.completed ?? false"
                            disabled
                          />
                          <span :class="todo?.completed ? 'text-muted line-through' : 'text-sm'">
                            {{ todo?.text }}
                          </span>
                        </li>
                      </ul>
                    </UCard>
                  </template>

                  <template v-else-if="getErrorItem(part)">
                    <UAlert
                      color="error"
                      variant="soft"
                      icon="i-lucide-alert-triangle"
                      title="Error"
                    >
                      <template #description>
                        {{ getErrorItem(part)?.message }}
                      </template>
                    </UAlert>
                  </template>
                </template>
              </template>
            </div>
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
          <USelect
            v-model="selectedModel"
            :items="modelOptions"
            size="sm"
            variant="ghost"
            class="w-40"
          />
        </div>
      </UContainer>
    </template>
  </UDashboardPanel>
</template>

<style>
.reasoning-muted .markdown-renderer.markstream-vue * {
  font-size: 0.875rem; /* text-sm */
  color: var(--ui-color-muted-foreground);
}
</style>
