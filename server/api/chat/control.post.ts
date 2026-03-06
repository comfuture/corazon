import type { H3Event } from 'h3'
import type { CodexChatControlRequest } from '@@/types/chat-ui'

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

  if (action === 'interrupt') {
    return interruptChatTurnControl({ runId, threadId })
  }

  if (action === 'steer') {
    const message = body.message
    return steerChatTurnControl({
      runId,
      threadId,
      message: message as Parameters<typeof steerChatTurnControl>[0]['message']
    })
  }

  throw createError({
    statusCode: 400,
    statusMessage: 'Unsupported chat control action.'
  })
})
