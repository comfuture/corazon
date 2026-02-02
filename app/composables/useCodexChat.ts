import { Chat } from '@ai-sdk/vue'
import type { DataUIPart, FileUIPart } from 'ai'
import {
  CODEX_EVENT_PART,
  CODEX_ITEM_PART,
  type CodexThreadEventData,
  type CodexUIDataTypes,
  type CodexUIMessage
} from '@@/types/codex-ui'

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
      onError(error) {
        console.error(error)
      },
      onData(part) {
        if (!isCodexEventPart(part)) {
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
        }
      }
    }))
  }

  const baseRequestOptions = () => {
    const safetyBody = skipGitRepoCheck.value ? { skipGitRepoCheck: true } : {}
    if (!threadId.value) {
      return { body: { model: selectedModel.value, ...safetyBody } }
    }

    return resumeThread.value
      ? { body: { threadId: threadId.value, resume: true, ...safetyBody } }
      : { body: { threadId: threadId.value, ...safetyBody } }
  }

  const buildRequestOptions = (extraBody?: Record<string, unknown>) => {
    const base = baseRequestOptions()
    if (!extraBody || Object.keys(extraBody).length === 0) {
      return base
    }

    return { body: { ...base.body, ...extraBody } }
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
    const extraBody = options?.attachmentUploadId
      ? { attachmentUploadId: options.attachmentUploadId }
      : undefined
    const resolvedMessageId = options?.messageId
      ?? (options?.reusePendingMessageId ? pendingMessageId.value ?? undefined : undefined)
      ?? (shouldClearInput ? chatInstance.generateId() : undefined)
    let caughtError: unknown
    if (shouldClearInput && message.length > 0) {
      pendingInput.value = message
      pendingMessageId.value = resolvedMessageId ?? pendingMessageId.value
      input.value = ''
    }
    try {
      if (message.length > 0) {
        await chatInstance.sendMessage(
          { text: message, files: fileParts, messageId: resolvedMessageId },
          buildRequestOptions(extraBody)
        )
      } else {
        await chatInstance.sendMessage(
          { files: fileParts, messageId: resolvedMessageId },
          buildRequestOptions(extraBody)
        )
      }
    } catch (error) {
      caughtError = error
    }

    const trustError = isTrustErrorMessage(chatInstance.error?.message ?? '') && !skipGitRepoCheck.value
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

    await chatInstance.regenerate(baseRequestOptions() ?? {})
  }

  const stop = () => {
    chat.value?.stop()
  }

  const clearForNewThread = () => {
    threadId.value = null
    pendingThreadId.value = null
    autoRedirectThreadId.value = null
    resumeThread.value = false
    lastRestoredThreadId.value = null

    const chatInstance = chat.value
    if (!chatInstance) {
      return
    }

    if (chatInstance.status === 'streaming' || chatInstance.status === 'submitted') {
      return
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

    if (chatInstance.status === 'streaming' || chatInstance.status === 'submitted') {
      return
    }

    try {
      const history = await $fetch<CodexUIMessage[]>(`/api/chat/history/${next}`)
      if (Array.isArray(history)) {
        chatInstance.messages = history
        lastRestoredThreadId.value = next
      }
    } catch (error) {
      console.error(error)
    }
  }

  const setThreadFromRoute = async (next: string | null) => {
    if (!next) {
      return
    }

    threadId.value = next

    if (autoRedirectThreadId.value === next) {
      resumeThread.value = false
      autoRedirectThreadId.value = null
      return
    }

    resumeThread.value = true
    await restoreHistory(next)
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
