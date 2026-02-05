import type { Thread } from '@openai/codex-sdk'

const runtimeThreads = new Map<string, Thread>()

export const getRuntimeThread = (threadId: string) => runtimeThreads.get(threadId)

export const hasRuntimeThread = (threadId: string) => runtimeThreads.has(threadId)

export const setRuntimeThread = (threadId: string, thread: Thread) => {
  runtimeThreads.set(threadId, thread)
}

export const deleteRuntimeThread = (threadId: string) => {
  runtimeThreads.delete(threadId)
}
