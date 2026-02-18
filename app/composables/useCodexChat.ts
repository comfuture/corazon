import { Chat } from '@ai-sdk/vue'
import { WorkflowChatTransport } from '@workflow/ai'
import type { DataUIPart, FileUIPart } from 'ai'
import {
  CODEX_EVENT_PART,
  CODEX_ITEM_PART,
  type CodexChatHistoryResponse,
  type CodexThreadEventData,
  type CodexUIDataTypes,
  type CodexUIMessage
} from '@@/types/chat-ui'

const sharedChat = shallowRef<Chat<CodexUIMessage> | null>(null)

type CodexEventPart = DataUIPart<CodexUIDataTypes> & {
  type: typeof CODEX_EVENT_PART
  data: CodexThreadEventData
}

type CodexItemPart = DataUIPart<CodexUIDataTypes> & {
  type: typeof CODEX_ITEM_PART
}

const isCodexEventPart = (part: DataUIPart<CodexUIDataTypes>): part is CodexEventPart =>
  part.type === CODEX_EVENT_PART
const isCodexItemPart = (part: DataUIPart<CodexUIDataTypes>): part is CodexItemPart =>
  part.type === CODEX_ITEM_PART
const isTrustErrorMessage = (message: string) =>
  message.includes('Not inside a trusted directory') || message.includes('skip-git-repo-check')
const isChatInFlight = (status: string | undefined) =>
  status === 'streaming' || status === 'submitted'
const CHAT_MESSAGES_ROOT_SELECTOR = '.codex-chat-messages-root'
const CHAT_SCROLL_RETRY_DELAY_MS = 48
const CHAT_SCROLL_RETRY_COUNT = 4

const isCompletedCodexItem = (part: CodexItemPart) => {
  const item = part.data?.item as Record<string, unknown> | undefined
  return !!item && 'status' in item && item.status === 'completed'
}

const getChatScrollContainer = () => {
  if (!import.meta.client) {
    return null
  }

  const root = document.querySelector<HTMLElement>(CHAT_MESSAGES_ROOT_SELECTOR)
  if (!root) {
    return null
  }

  return root.closest<HTMLElement>('[data-slot="body"]')
}

const scrollChatToBottomNow = () => {
  const container = getChatScrollContainer()
  if (!container) {
    return
  }
  container.scrollTop = container.scrollHeight
}

const queueScrollChatToBottom = (attempt = 0) => {
  if (!import.meta.client) {
    return
  }

  void nextTick(() => {
    scrollChatToBottomNow()
    if (attempt >= CHAT_SCROLL_RETRY_COUNT) {
      return
    }
    window.setTimeout(() => {
      queueScrollChatToBottom(attempt + 1)
    }, CHAT_SCROLL_RETRY_DELAY_MS)
  })
}

export const useCodexChat = () => {
  const { upsertThread, setThreadTitle, applyTurnUsage } = useCodexThreads()
  const chat = import.meta.client
    ? sharedChat
    : shallowRef<Chat<CodexUIMessage> | null>(null)
  const input = useState('codex-chat-input', () => '')
  const selectedModel = useState('codex-selected-model', () => 'gpt-5.2-codex')
  const skipGitRepoCheck = useState('codex-skip-git-repo-check', () => false)
  const skipGitRepoCheckLoaded = useState('codex-skip-git-repo-check-loaded', () => false)
  const workdirRoot = useState<string | null>('codex-workdir-root', () => null)
  const modelOptions = [
    { label: 'gpt-5.2-codex', value: 'gpt-5.2-codex' },
    { label: 'gpt-5.2', value: 'gpt-5.2' },
    { label: 'gpt-5.1-codex-mini', value: 'gpt-5.1-codex-mini' }
  ]
  const threadId = useState<string | null>('codex-thread-id', () => null)
  const pendingThreadId = useState<string | null>('codex-pending-thread-id', () => null)
  const autoRedirectThreadId = useState<string | null>('codex-auto-redirect-thread-id', () => null)
  const resumeThread = useState<boolean>('codex-resume-thread', () => false)
  const lastRestoredThreadId = useState<string | null>('codex-last-restored-thread-id', () => null)
  const pendingInput = useState<string | null>('codex-pending-input', () => null)
  const pendingMessageId = useState<string | null>('codex-pending-message-id', () => null)
  const pendingAttachmentUploadId = useState<string | null>('codex-pending-attachment-upload-id', () => null)
  const threadRunMap = useState<Record<string, string>>('codex-thread-run-map', () => ({}))
  const pendingWorkflowRunId = useState<string | null>('codex-pending-workflow-run-id', () => null)
  const lastResumedRunId = useState<string | null>('codex-last-resumed-run-id', () => null)

  const setThreadRunId = (nextThreadId: string, runId: string) => {
    threadRunMap.value = {
      ...threadRunMap.value,
      [nextThreadId]: runId
    }
  }

  const clearThreadRunId = (nextThreadId: string) => {
    if (!threadRunMap.value[nextThreadId]) {
      return
    }
    threadRunMap.value = Object.fromEntries(
      Object.entries(threadRunMap.value).filter(([key]) => key !== nextThreadId)
    )
  }

  const resolveRunIdForThread = (nextThreadId: string | null) => {
    if (!nextThreadId) {
      return null
    }
    return threadRunMap.value[nextThreadId] ?? null
  }

  if (import.meta.client && !skipGitRepoCheckLoaded.value) {
    const stored = window.localStorage.getItem('codex-skip-git-repo-check')
    if (stored === 'true') {
      skipGitRepoCheck.value = true
    }
    if (stored === 'false') {
      skipGitRepoCheck.value = false
    }
    skipGitRepoCheckLoaded.value = true
  }

  watch(skipGitRepoCheck, (value) => {
    if (!import.meta.client) {
      return
    }
    window.localStorage.setItem('codex-skip-git-repo-check', value ? 'true' : 'false')
  })

  if (import.meta.client && !chat.value) {
    chat.value = markRaw(new Chat<CodexUIMessage>({
      transport: new WorkflowChatTransport<CodexUIMessage>({
        api: '/api/chat',
        onChatSendMessage(response) {
          const runId = response.headers.get('x-workflow-run-id')
          if (!runId) {
            return
          }

          const currentThreadId = threadId.value
          if (currentThreadId) {
            setThreadRunId(currentThreadId, runId)
            pendingWorkflowRunId.value = null
            return
          }

          pendingWorkflowRunId.value = runId
        },
        onChatEnd() {
          const currentThreadId = threadId.value
          if (currentThreadId) {
            const currentRunId = resolveRunIdForThread(currentThreadId)
            clearThreadRunId(currentThreadId)
            if (currentRunId && lastResumedRunId.value === currentRunId) {
              lastResumedRunId.value = null
            }
          }
          pendingWorkflowRunId.value = null
        },
        prepareSendMessagesRequest(request) {
          const body: Record<string, unknown> = {
            messages: request.messages,
            model: selectedModel.value
          }

          if (threadId.value) {
            body.threadId = threadId.value
          }
          if (resumeThread.value) {
            body.resume = true
          }
          if (skipGitRepoCheck.value) {
            body.skipGitRepoCheck = true
          }
          if (pendingAttachmentUploadId.value) {
            body.attachmentUploadId = pendingAttachmentUploadId.value
            pendingAttachmentUploadId.value = null
          }

          return {
            ...request,
            api: '/api/chat',
            headers: {
              ...(request.headers ?? {}),
              'Content-Type': 'application/json'
            },
            body
          }
        },
        prepareReconnectToStreamRequest(request) {
          const runId = resolveRunIdForThread(threadId.value) ?? pendingWorkflowRunId.value
          if (!runId) {
            return request
          }

          return {
            ...request,
            api: `/api/chat/${encodeURIComponent(runId)}/stream`
          }
        }
      }),
      onError(error) {
        console.error(error)
      },
      onData(part) {
        if (!isCodexEventPart(part)) {
          if (isCodexItemPart(part) && isCompletedCodexItem(part)) {
            queueScrollChatToBottom()
          }

          if (isCodexItemPart(part) && part.data?.kind === 'command_execution') {
            const chatInstance = chat.value
            if (!chatInstance) {
              return
            }

            const messages = chatInstance.messages as CodexUIMessage[]
            for (let index = messages.length - 1; index >= 0; index -= 1) {
              const message = messages[index]
              if (!message) {
                continue
              }
              const parts = message?.parts as DataUIPart<CodexUIDataTypes>[] | undefined
              if (!parts || parts.length === 0) {
                continue
              }

              let hasMatch = false
              const nextParts: DataUIPart<CodexUIDataTypes>[] = []
              for (const existingPart of parts) {
                if (existingPart.type === CODEX_ITEM_PART && existingPart.id === part.id) {
                  if (!hasMatch) {
                    hasMatch = true
                    nextParts.push({ ...existingPart, data: part.data })
                  }
                  continue
                }
                nextParts.push(existingPart)
              }

              if (hasMatch) {
                message.parts = nextParts
                chatInstance.messages = [...chatInstance.messages]
                return
              }
            }
          }
          return
        }

        if (part.data.kind === 'thread.started') {
          threadId.value = part.data.threadId
          pendingThreadId.value = part.data.threadId
          upsertThread({ id: part.data.threadId, updatedAt: Date.now() })

          if (pendingWorkflowRunId.value) {
            setThreadRunId(part.data.threadId, pendingWorkflowRunId.value)
            pendingWorkflowRunId.value = null
          }
        }

        if (part.data.kind === 'thread.ended') {
          clearThreadRunId(part.data.threadId)
          pendingWorkflowRunId.value = null
          upsertThread({ id: part.data.threadId, updatedAt: part.data.endedAt })
          queueScrollChatToBottom()

          const chatInstance = chat.value
          if (threadId.value === part.data.threadId && chatInstance && isChatInFlight(chatInstance.status)) {
            void chatInstance.stop()
          }
          return
        }

        if (part.data.kind === 'thread.title') {
          setThreadTitle(part.data.threadId, part.data.title, part.data.updatedAt)
        }

        if (part.data.kind === 'turn.completed') {
          if (threadId.value) {
            applyTurnUsage(threadId.value, part.data.usage)
          }

          const durations = part.data.reasoningDurations
          if (!durations || Object.keys(durations).length === 0) {
            queueScrollChatToBottom()
            return
          }

          const chatInstance = chat.value
          if (!chatInstance) {
            return
          }

          const lastAssistant = [...chatInstance.messages].reverse().find(message => message.role === 'assistant')
          if (!lastAssistant) {
            return
          }

          for (const partItem of lastAssistant.parts ?? []) {
            if (partItem.type !== 'reasoning') {
              continue
            }
            const metadata = partItem.providerMetadata as { reasoningId?: unknown } | undefined
            const rawReasoningId = metadata?.reasoningId
            const reasoningId = typeof rawReasoningId === 'string'
              ? rawReasoningId
              : rawReasoningId && typeof rawReasoningId === 'object' && 'value' in rawReasoningId
                ? (rawReasoningId as { value?: unknown }).value
                : null
            if (typeof reasoningId !== 'string') {
              continue
            }
            const durationMs = durations[reasoningId]
            if (typeof durationMs !== 'number') {
              continue
            }
            partItem.providerMetadata = {
              ...(partItem.providerMetadata ?? {}),
              thinkingDurationMs: { value: durationMs }
            }
          }

          chatInstance.messages = [...chatInstance.messages]
          queueScrollChatToBottom()
        }
      }
    }))
  }

  const sendMessage = async (options?: {
    fileParts?: FileUIPart[]
    attachmentUploadId?: string | null
    text?: string
    clearInput?: boolean
    messageId?: string
    reusePendingMessageId?: boolean
  }) => {
    const chatInstance = chat.value
    if (!chatInstance) {
      return
    }
    const rawText = options?.text ?? input.value
    const message = rawText.trim()
    const fileParts = options?.fileParts ?? []
    if (message.length === 0 && fileParts.length === 0) {
      return
    }
    const shouldClearInput = options?.clearInput ?? options?.text === undefined
    const usedResume = resumeThread.value
    const resolvedMessageId = options?.messageId
      ?? (options?.reusePendingMessageId ? pendingMessageId.value ?? undefined : undefined)
    let caughtError: unknown

    pendingAttachmentUploadId.value = options?.attachmentUploadId ?? null

    if (shouldClearInput && message.length > 0) {
      pendingInput.value = message
      input.value = ''
    }

    try {
      if (message.length > 0) {
        await chatInstance.sendMessage({ text: message, files: fileParts, messageId: resolvedMessageId })
      } else {
        await chatInstance.sendMessage({ files: fileParts, messageId: resolvedMessageId })
      }
    } catch (error) {
      caughtError = error
    } finally {
      pendingAttachmentUploadId.value = null
    }

    const trustError = isTrustErrorMessage(chatInstance.error?.message ?? '') && !skipGitRepoCheck.value
    if (trustError && !pendingMessageId.value) {
      const lastMessage = chatInstance.lastMessage
      if (lastMessage?.role === 'user') {
        pendingMessageId.value = lastMessage.id
      }
    }
    if (usedResume && !trustError) {
      resumeThread.value = false
    }
    if (trustError && shouldClearInput && pendingInput.value && !input.value) {
      input.value = pendingInput.value
    }
    if (!trustError || skipGitRepoCheck.value) {
      pendingInput.value = null
      pendingMessageId.value = null
    }
    if (caughtError) {
      throw caughtError
    }
  }

  const regenerate = async () => {
    const chatInstance = chat.value
    if (!chatInstance) {
      return
    }

    await chatInstance.regenerate()
  }

  const stop = () => {
    void chat.value?.stop()
  }

  const clearForNewThread = () => {
    threadId.value = null
    pendingThreadId.value = null
    autoRedirectThreadId.value = null
    resumeThread.value = false
    lastRestoredThreadId.value = null
    lastResumedRunId.value = null
    pendingWorkflowRunId.value = null
    pendingAttachmentUploadId.value = null

    const chatInstance = chat.value
    if (!chatInstance) {
      return
    }

    if (isChatInFlight(chatInstance.status)) {
      void chatInstance.stop()
    }

    chatInstance.messages = []
  }

  const clearInput = () => {
    input.value = ''
  }

  const markAutoRedirect = (next: string) => {
    autoRedirectThreadId.value = next
    resumeThread.value = false
  }

  const restoreHistory = async (next: string) => {
    if (!import.meta.client) {
      return
    }

    if (lastRestoredThreadId.value === next) {
      return
    }

    const chatInstance = chat.value
    if (!chatInstance) {
      return
    }

    try {
      const history = await $fetch<CodexChatHistoryResponse>(`/api/chat/history/${next}`)
      chatInstance.messages = history?.messages ?? []
      lastRestoredThreadId.value = next
      queueScrollChatToBottom()

      if (history?.activeRunId) {
        pendingWorkflowRunId.value = null
        setThreadRunId(next, history.activeRunId)
        if (lastResumedRunId.value !== history.activeRunId) {
          await chatInstance.resumeStream()
          lastResumedRunId.value = history.activeRunId
          queueScrollChatToBottom()
        }
      } else {
        clearThreadRunId(next)
        lastResumedRunId.value = null
        pendingWorkflowRunId.value = null
        if (isChatInFlight(chatInstance.status)) {
          await chatInstance.stop()
        }
        queueScrollChatToBottom()
      }
    } catch (error) {
      console.error(error)
    }
  }

  const setThreadFromRoute = async (next: string | null) => {
    if (!next) {
      return
    }

    const currentThreadId = threadId.value
    const chatInstance = chat.value
    if (currentThreadId && currentThreadId !== next && chatInstance && isChatInFlight(chatInstance.status)) {
      await chatInstance.stop()
    }

    threadId.value = next

    if (autoRedirectThreadId.value === next) {
      resumeThread.value = false
      autoRedirectThreadId.value = null
      return
    }

    resumeThread.value = true
    await restoreHistory(next)
    queueScrollChatToBottom()
  }

  const loadWorkdirRoot = async () => {
    if (workdirRoot.value) {
      return
    }
    try {
      const data = await $fetch<{ root?: string }>('/api/chat/workdir')
      if (data?.root) {
        workdirRoot.value = data.root
      }
    } catch (error) {
      console.error(error)
    }
  }

  return {
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
    markAutoRedirect,
    setThreadFromRoute
  }
}
