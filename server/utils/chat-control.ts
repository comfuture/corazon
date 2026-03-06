import type { CodexChatUserMessage, CodexUIMessage } from '@@/types/chat-ui'
import { buildCodexInputFromUserMessage } from './stream.ts'
import {
  appendRuntimeTurnSteeringMessage,
  getRuntimeTurnControlByRunId,
  getRuntimeTurnControlByThreadId
} from './runtime.ts'

export const isCodexChatUserMessage = (value: unknown): value is CodexChatUserMessage => {
  if (typeof value !== 'object' || value == null) {
    return false
  }

  const candidate = value as Partial<CodexChatUserMessage>
  if (candidate.role !== 'user' || typeof candidate.id !== 'string' || !Array.isArray(candidate.parts)) {
    return false
  }

  return candidate.parts.every((part) => {
    if (typeof part !== 'object' || part == null || typeof part.type !== 'string') {
      return false
    }

    if (part.type === 'text') {
      return typeof (part as { text?: unknown }).text === 'string'
    }

    if (part.type === 'file') {
      return typeof (part as { url?: unknown }).url === 'string'
    }

    return false
  })
}

const resolveRuntimeChatControl = (runId: string | null, threadId: string | null) => {
  if (runId) {
    return getRuntimeTurnControlByRunId(runId)
  }

  if (threadId) {
    return getRuntimeTurnControlByThreadId(threadId)
  }

  return undefined
}

const assertControllable = (result: { ok: boolean, reason?: string }) => {
  if (result.ok) {
    return
  }

  if (result.reason === 'unsupported') {
    throw createError({
      statusCode: 409,
      statusMessage: 'Live turn control is only available in app-server mode.'
    })
  }

  throw createError({
    statusCode: 409,
    statusMessage: 'No active app-server turn is available for control.'
  })
}

export const interruptChatTurnControl = async (input: {
  runId?: string | null
  threadId?: string | null
}) => {
  const runId = typeof input.runId === 'string' && input.runId.length > 0 ? input.runId : null
  const threadId = typeof input.threadId === 'string' && input.threadId.length > 0 ? input.threadId : null
  const control = resolveRuntimeChatControl(runId, threadId)
  if (!control) {
    throw createError({
      statusCode: 409,
      statusMessage: 'No active chat turn was found to control.'
    })
  }

  const result = await control.thread.interruptActiveTurn()
  assertControllable(result)

  return {
    ok: true,
    queued: result.queued ?? false,
    turnId: result.turnId ?? null
  }
}

export const steerChatTurnControl = async (input: {
  runId?: string | null
  threadId?: string | null
  message: CodexChatUserMessage
}) => {
  if (!isCodexChatUserMessage(input.message)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'A valid user steering message is required.'
    })
  }

  const runId = typeof input.runId === 'string' && input.runId.length > 0 ? input.runId : null
  const threadId = typeof input.threadId === 'string' && input.threadId.length > 0 ? input.threadId : null
  const control = resolveRuntimeChatControl(runId, threadId)
  if (!control) {
    throw createError({
      statusCode: 409,
      statusMessage: 'No active chat turn was found to control.'
    })
  }

  const codexInput = buildCodexInputFromUserMessage(input.message)
  if (!codexInput || (Array.isArray(codexInput) && codexInput.length === 0)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Steering input is empty.'
    })
  }

  const result = await control.thread.steerActiveTurn(codexInput)
  assertControllable(result)
  appendRuntimeTurnSteeringMessage(control.runId, input.message as unknown as CodexUIMessage)

  return {
    ok: true,
    queued: result.queued ?? false,
    turnId: result.turnId ?? null
  }
}
