import { Chat } from '@ai-sdk/vue'
import type { DataUIPart, FileUIPart } from 'ai'
import {
  CODEX_EVENT_PART,
  type CodexThreadEventData,
  type CodexUIDataTypes,
  type CodexUIMessage
} from '@@/types/codex-ui'

const sharedChat = shallowRef<Chat<CodexUIMessage> | null>(null)

type CodexEventPart = DataUIPart<CodexUIDataTypes> & {
  type: typeof CODEX_EVENT_PART
  data: CodexThreadEventData
}

const isCodexEventPart = (part: DataUIPart<CodexUIDataTypes>): part is CodexEventPart =>
  part.type === CODEX_EVENT_PART

export const useCodexChat = () => {
  const { upsertThread, setThreadTitle, applyTurnUsage } = useCodexThreads()
  const chat = import.meta.client
    ? sharedChat
    : shallowRef<Chat<CodexUIMessage> | null>(null)
  const input = useState('codex-chat-input', () => '')
  const selectedModel = useState('codex-selected-model', () => 'gpt-5.2-codex')
  const skipGitRepoCheck = useState('codex-skip-git-repo-check', () => false)
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

  if (import.meta.client && !chat.value) {
    chat.value = markRaw(new Chat<CodexUIMessage>({
      onError(error) {
        console.error(error)
      },
      onData(part) {
        if (!isCodexEventPart(part)) {
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

          const durationMs = part.data.durationMs
          if (!durationMs) {
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
            if (partItem.type === 'reasoning') {
              partItem.providerMetadata = {
                ...(partItem.providerMetadata ?? {}),
                thinkingDurationMs: { value: durationMs }
              }
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

  const sendMessage = async (options?: { fileParts?: FileUIPart[], attachmentUploadId?: string | null }) => {
    const chatInstance = chat.value
    if (!chatInstance) {
      return
    }
    const message = input.value.trim()
    const fileParts = options?.fileParts ?? []
    if (message.length === 0 && fileParts.length === 0) {
      return
    }

    input.value = ''
    const usedResume = resumeThread.value
    const extraBody = options?.attachmentUploadId
      ? { attachmentUploadId: options.attachmentUploadId }
      : undefined
    if (message.length > 0) {
      await chatInstance.sendMessage({ text: message, files: fileParts }, buildRequestOptions(extraBody))
    } else {
      await chatInstance.sendMessage({ files: fileParts }, buildRequestOptions(extraBody))
    }
    if (usedResume) {
      resumeThread.value = false
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
