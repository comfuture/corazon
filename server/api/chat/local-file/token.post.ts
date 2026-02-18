import type { H3Event } from 'h3'

type LocalFileTokenRequest = {
  path?: unknown
  mediaType?: unknown
}

type LocalFileTokenResponse = {
  token: string
  url: string
  expiresAt: number
}

const normalizeString = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

const asHttpError = (error: unknown) => {
  const message = error instanceof Error ? error.message : 'Failed to create local file preview token.'

  if (message === 'Missing local file path.') {
    return createError({ statusCode: 400, statusMessage: message })
  }

  if (message === 'Invalid local file path.') {
    return createError({ statusCode: 403, statusMessage: message })
  }

  if (message === 'Local file not found.') {
    return createError({ statusCode: 404, statusMessage: message })
  }

  return createError({
    statusCode: 500,
    statusMessage: message
  })
}

export default defineEventHandler(async (event: H3Event): Promise<LocalFileTokenResponse> => {
  const body = await readBody<LocalFileTokenRequest>(event)
  const filePath = normalizeString(body?.path)
  const mediaType = normalizeString(body?.mediaType) || undefined

  try {
    const created = await createLocalFilePreviewToken(filePath, mediaType)
    return {
      token: created.token,
      url: `/api/chat/local-file/${encodeURIComponent(created.token)}`,
      expiresAt: created.expiresAt
    }
  } catch (error) {
    throw asHttpError(error)
  }
})
