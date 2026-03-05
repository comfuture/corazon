import type { CodexThreadClient } from './codex-client/types.ts'

const runtimeThreads = new Map<string, CodexThreadClient>()

export const getRuntimeThread = (threadId: string) => runtimeThreads.get(threadId)

export const hasRuntimeThread = (threadId: string) => runtimeThreads.has(threadId)

export const setRuntimeThread = (threadId: string, thread: CodexThreadClient) => {
  runtimeThreads.set(threadId, thread)
}

export const deleteRuntimeThread = (threadId: string) => {
  runtimeThreads.delete(threadId)
}
