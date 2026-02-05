import { isAbsolute, relative, resolve } from 'node:path'
import type { H3Event } from 'h3'

export default defineEventHandler((event: H3Event) => {
  const threadId = getRouterParam(event, 'threadId')
  if (!threadId) {
    throw createError({ statusCode: 400, statusMessage: 'Missing thread id.' })
  }

  if (
    threadId === '.'
    || threadId === '..'
    || threadId === '_pending'
    || threadId.includes('/')
    || threadId.includes('\\')
  ) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid thread id.' })
  }

  const root = ensureThreadRootDirectory()
  const resolvedRoot = resolve(root)
  const resolvedTarget = resolve(root, threadId)
  const relativeTarget = relative(resolvedRoot, resolvedTarget)
  if (!relativeTarget || relativeTarget.startsWith('..') || isAbsolute(relativeTarget)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid thread id.' })
  }

  const deleted = deleteThread(threadId)
  if (!deleted) {
    throw createError({ statusCode: 404, statusMessage: 'Thread not found.' })
  }

  return { ok: true }
})
