import type { H3Event } from 'h3'

export default defineEventHandler((event: H3Event) => {
  const threadId = getRouterParam(event, 'threadId')
  if (!threadId) {
    throw createError({ statusCode: 400, statusMessage: 'Missing thread id.' })
  }

  ensureThreadWorkingDirectory(threadId)
  const messages = loadThreadMessages(threadId)
  if (!messages) {
    return []
  }

  return messages
})
