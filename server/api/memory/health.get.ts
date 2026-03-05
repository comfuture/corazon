export default defineEventHandler(async () => {
  try {
    const health = await getMemoryHealth()
    return {
      ok: true,
      ...health
    }
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: error instanceof Error
        ? error.message
        : 'Failed to initialize memory engine.'
    })
  }
})
