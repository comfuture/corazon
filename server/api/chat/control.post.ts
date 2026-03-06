import type { H3Event } from 'h3'
import type { CodexChatControlRequest, CodexChatUserMessage, CodexUIMessage } from '@@/types/chat-ui'

const isUserMessage = (value: unknown): value is CodexChatUserMessage => {
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

const resolveControl = (runId: string | null, threadId: string | null) => {
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

export default defineEventHandler(async (event: H3Event) => {
  const body = await readBody(event) as Partial<CodexChatControlRequest> | null
  if (!body) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing chat control payload.'
    })
  }

  const action = body?.action
  const runId = typeof body?.runId === 'string' && body.runId.length > 0 ? body.runId : null
  const threadId = typeof body?.threadId === 'string' && body.threadId.length > 0 ? body.threadId : null
  const control = resolveControl(runId, threadId)

  if (!control) {
    throw createError({
      statusCode: 409,
      statusMessage: 'No active chat turn was found to control.'
    })
  }

  if (action === 'interrupt') {
    const result = await control.thread.interruptActiveTurn()
    assertControllable(result)
    return {
      ok: true,
      queued: result.queued ?? false,
      turnId: result.turnId ?? null
    }
  }

  if (action === 'steer') {
    const message = body.message
    if (!isUserMessage(message)) {
      throw createError({
        statusCode: 400,
        statusMessage: 'A valid user steering message is required.'
      })
    }

    const input = buildCodexInputFromUserMessage(message)
    if (!input || (Array.isArray(input) && input.length === 0)) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Steering input is empty.'
      })
    }

    const result = await control.thread.steerActiveTurn(input)
    assertControllable(result)
    appendRuntimeTurnSteeringMessage(control.runId, message as unknown as CodexUIMessage)
    return {
      ok: true,
      queued: result.queued ?? false,
      turnId: result.turnId ?? null
    }
  }

  throw createError({
    statusCode: 400,
    statusMessage: 'Unsupported chat control action.'
  })
})
