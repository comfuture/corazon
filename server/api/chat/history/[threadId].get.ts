import type { H3Event } from 'h3'
import type { CodexChatHistoryResponse } from '@@/types/chat-ui'

export default defineEventHandler((event: H3Event) => {
  const threadId = getRouterParam(event, 'threadId')
  if (!threadId) {
    throw createError({ statusCode: 400, statusMessage: 'Missing thread id.' })
  }

  ensureThreadWorkingDirectory(threadId)
  const messages = loadThreadMessages(threadId)
  const activeRunId = getThreadActiveRun(threadId)

  const response: CodexChatHistoryResponse = {
    messages: messages ?? [],
    activeRunId
  }

  return response
})
