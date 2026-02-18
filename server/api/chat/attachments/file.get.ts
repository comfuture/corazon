import { readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import type { H3Event } from 'h3'
import { lookup } from 'mime-types'

const inferMediaType = (filePath: string) => {
  return lookup(filePath) || 'application/octet-stream'
}

const isInsideDirectory = (targetPath: string, directory: string) => {
  const relativePath = relative(directory, targetPath)
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

const normalizeQueryValue = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

export default defineEventHandler(async (event: H3Event) => {
  const pathQuery = normalizeQueryValue(getQuery(event).path)
  if (!pathQuery) {
    throw createError({ statusCode: 400, statusMessage: 'Missing file path.' })
  }

  const runtimeRoot = resolve(ensureThreadRootDirectory())
  const resolvedPath = resolve(pathQuery)

  if (!isInsideDirectory(resolvedPath, runtimeRoot)) {
    throw createError({ statusCode: 403, statusMessage: 'Invalid attachment path.' })
  }

  let fileStat
  try {
    fileStat = await stat(resolvedPath)
  } catch {
    throw createError({ statusCode: 404, statusMessage: 'Attachment not found.' })
  }

  if (!fileStat.isFile()) {
    throw createError({ statusCode: 404, statusMessage: 'Attachment not found.' })
  }

  const requestedMediaType = normalizeQueryValue(getQuery(event).mediaType)
  const mediaType = requestedMediaType || inferMediaType(resolvedPath)
  setHeader(event, 'cache-control', 'private, max-age=3600')
  setHeader(event, 'content-type', mediaType)
  setHeader(event, 'content-disposition', `inline; filename="${basename(resolvedPath).replace(/"/g, '')}"`)

  return await readFile(resolvedPath)
})
