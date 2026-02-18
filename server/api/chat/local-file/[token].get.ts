export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, 'token')?.trim() || ''
  if (!token) {
    throw createError({ statusCode: 400, statusMessage: 'Missing local file token.' })
  }

  const payload = await readLocalFilePreviewByToken(token)
  if (!payload) {
    throw createError({ statusCode: 404, statusMessage: 'Local file preview not found.' })
  }

  const maxAgeSeconds = Math.max(1, Math.floor((payload.expiresAt - Date.now()) / 1000))

  setHeader(event, 'cache-control', `private, max-age=${maxAgeSeconds}`)
  setHeader(event, 'content-type', payload.mediaType)
  setHeader(event, 'content-disposition', `inline; filename="${payload.filename}"`)

  return payload.content
})
