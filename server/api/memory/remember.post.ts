const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const text = typeof body?.text === 'string'
    ? body.text.trim()
    : ''
  const messages = normalizeOpenAICompatMessages(body?.messages)
  const threadId = typeof body?.threadId === 'string'
    ? body.threadId.trim()
    : ''
  const section = typeof body?.section === 'string'
    ? body.section.trim()
    : ''

  if (!text && messages.length === 0) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Provide non-empty text or messages.'
    })
  }

  const metadata: Record<string, unknown> = isObject(body?.metadata)
    ? { ...body.metadata }
    : {}
  if (threadId) {
    metadata.threadId = threadId
  }
  if (section) {
    metadata.section = section
  }

  try {
    const result = text
      ? await rememberText({
          text,
          metadata
        })
      : await rememberMessages({
          messages,
          metadata
        })

    return result
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: error instanceof Error
        ? error.message
        : 'Failed to store memory.'
    })
  }
})
