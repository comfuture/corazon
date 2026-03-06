import type { CodexThreadClient } from './codex-client/types.ts'
import type { CodexUIMessage } from '@@/types/chat-ui'

const runtimeThreads = new Map<string, CodexThreadClient>()
const runtimeTurnControls = new Map<string, {
  runId: string
  threadId: string | null
  thread: CodexThreadClient
  steeringMessages: CodexUIMessage[]
}>()
const runtimeTurnRunsByThreadId = new Map<string, string>()

export const getRuntimeThread = (threadId: string) => runtimeThreads.get(threadId)

export const hasRuntimeThread = (threadId: string) => runtimeThreads.has(threadId)

export const setRuntimeThread = (threadId: string, thread: CodexThreadClient) => {
  runtimeThreads.set(threadId, thread)
}

export const deleteRuntimeThread = (threadId: string) => {
  runtimeThreads.delete(threadId)
}

export const setRuntimeTurnControl = (control: {
  runId: string
  threadId: string | null
  thread: CodexThreadClient
}) => {
  const previous = runtimeTurnControls.get(control.runId)
  if (previous?.threadId) {
    runtimeTurnRunsByThreadId.delete(previous.threadId)
  }

  runtimeTurnControls.set(control.runId, {
    ...control,
    steeringMessages: previous?.steeringMessages ?? []
  })

  if (control.threadId) {
    runtimeTurnRunsByThreadId.set(control.threadId, control.runId)
  }
}

export const updateRuntimeTurnControlThreadId = (runId: string, threadId: string) => {
  const existing = runtimeTurnControls.get(runId)
  if (!existing) {
    return
  }

  if (existing.threadId) {
    runtimeTurnRunsByThreadId.delete(existing.threadId)
  }

  existing.threadId = threadId
  runtimeTurnRunsByThreadId.set(threadId, runId)
}

export const getRuntimeTurnControlByRunId = (runId: string) => runtimeTurnControls.get(runId)

export const getRuntimeTurnControlByThreadId = (threadId: string) => {
  const runId = runtimeTurnRunsByThreadId.get(threadId)
  if (!runId) {
    return undefined
  }
  return runtimeTurnControls.get(runId)
}

export const appendRuntimeTurnSteeringMessage = (runId: string, message: CodexUIMessage) => {
  const existing = runtimeTurnControls.get(runId)
  if (!existing) {
    return
  }
  existing.steeringMessages = [...existing.steeringMessages, message]
}

export const getRuntimeTurnSteeringMessages = (runId: string) =>
  runtimeTurnControls.get(runId)?.steeringMessages ?? []

export const deleteRuntimeTurnControl = (runId: string) => {
  const existing = runtimeTurnControls.get(runId)
  if (!existing) {
    return
  }

  if (existing.threadId) {
    runtimeTurnRunsByThreadId.delete(existing.threadId)
  }

  runtimeTurnControls.delete(runId)
}
