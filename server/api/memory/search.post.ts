const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const query = typeof body?.query === 'string'
    ? body.query.trim()
    : ''

  if (!query) {
    throw createError({
      statusCode: 400,
      statusMessage: 'query is required.'
    })
  }

  const limit = typeof body?.limit === 'number'
    ? body.limit
    : undefined
  const filters = isObject(body?.filters)
    ? body.filters
    : undefined

  try {
    const results = await searchMemories({
      query,
      limit,
      filters
    })

    return {
      results
    }
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: error instanceof Error
        ? error.message
        : 'Memory search failed.'
    })
  }
})
