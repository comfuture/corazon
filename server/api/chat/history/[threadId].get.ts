import type { H3Event } from 'h3'
import type { CodexChatHistoryResponse } from '@@/types/chat-ui'
import { getRun } from 'workflow/api'

const resolveActiveRunId = async (threadId: string, activeRunId: string | null) => {
  if (!activeRunId) {
    return null
  }
  if (activeRunId.trim().length === 0) {
    clearThreadActiveRun(threadId)
    return null
  }

  try {
    const run = getRun(activeRunId)
    const status = await run.status
    if (status === 'running' || status === 'pending') {
      return activeRunId
    }
  } catch {
    // Ignore not-found and runtime errors; stale run IDs are cleaned below.
  }

  clearThreadActiveRun(threadId, activeRunId)
  return null
}

export default defineEventHandler(async (event: H3Event) => {
  const threadId = getRouterParam(event, 'threadId')
  if (!threadId) {
    throw createError({ statusCode: 400, statusMessage: 'Missing thread id.' })
  }

  ensureThreadWorkingDirectory(threadId)
  const messages = loadThreadMessages(threadId)
  const activeRunId = await resolveActiveRunId(threadId, getThreadActiveRun(threadId))

  const response: CodexChatHistoryResponse = {
    messages: messages ?? [],
    activeRunId
  }

  return response
})
