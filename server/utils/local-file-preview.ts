import { randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import { lookup } from 'mime-types'

type LocalFilePreviewEntry = {
  path: string
  mediaType: string
  expiresAt: number
}

const TOKEN_TTL_MS = 10 * 60 * 1000
const PREVIEW_SAFE_MEDIA_TYPE_PREFIX = 'image/'

const localFilePreviewEntries = new Map<string, LocalFilePreviewEntry>()

const isInsideDirectory = (targetPath: string, directory: string) => {
  const relativePath = relative(directory, targetPath)
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

const cleanupExpiredEntries = (now = Date.now()) => {
  for (const [token, entry] of localFilePreviewEntries.entries()) {
    if (entry.expiresAt <= now) {
      localFilePreviewEntries.delete(token)
    }
  }
}

const normalizeInputPath = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }

  const withoutQuotes = trimmed.replace(/^['"]+|['"]+$/g, '')
  let filePath = withoutQuotes
  if (withoutQuotes.startsWith('file://')) {
    try {
      const parsed = new URL(withoutQuotes)
      const hostname = parsed.hostname.toLowerCase()
      if (hostname && hostname !== 'localhost') {
        return ''
      }
      filePath = parsed.pathname
    } catch {
      filePath = withoutQuotes.replace(/^file:\/\//, '')
    }
  }

  try {
    return decodeURIComponent(filePath)
  } catch {
    return filePath
  }
}

const resolveCandidatePath = (inputPath: string, baseDirectory: string) => {
  if (isAbsolute(inputPath)) {
    return resolve(inputPath)
  }
  return resolve(baseDirectory, inputPath)
}

const inferMediaType = (filePath: string) => lookup(filePath) || 'application/octet-stream'

const assertAllowedPreviewPath = (resolvedPath: string, threadWorkingDirectory: string) => {
  const isAllowed = isInsideDirectory(resolvedPath, threadWorkingDirectory)
  if (!isAllowed) {
    throw new Error('Invalid local file path.')
  }
}

export const createLocalFilePreviewToken = async (
  path: string,
  preferredMediaType?: string,
  threadId?: string
) => {
  const normalizedPath = normalizeInputPath(path)
  if (!normalizedPath) {
    throw new Error('Missing local file path.')
  }

  const normalizedThreadId = threadId?.trim() || ''
  if (!normalizedThreadId) {
    throw new Error('Missing thread id.')
  }
  const threadConfig = getThreadConfig(normalizedThreadId)
  const threadWorkingDirectory = threadConfig?.workingDirectory?.trim() || ''
  if (!threadWorkingDirectory) {
    throw new Error('Invalid thread context.')
  }

  const canonicalThreadWorkingDirectory = await realpath(threadWorkingDirectory).catch(() => null)
  if (!canonicalThreadWorkingDirectory) {
    throw new Error('Invalid thread context.')
  }

  const resolvedPath = resolveCandidatePath(normalizedPath, canonicalThreadWorkingDirectory)
  const canonicalPath = await realpath(resolvedPath).catch(() => null)
  if (!canonicalPath) {
    throw new Error('Local file not found.')
  }
  assertAllowedPreviewPath(canonicalPath, canonicalThreadWorkingDirectory)

  const fileStat = await stat(canonicalPath).catch(() => null)
  if (!fileStat || !fileStat.isFile()) {
    throw new Error('Local file not found.')
  }

  const preferredType = preferredMediaType?.trim().toLowerCase()
  const inferredType = String(inferMediaType(canonicalPath)).toLowerCase()
  const mediaType = preferredType?.startsWith(PREVIEW_SAFE_MEDIA_TYPE_PREFIX) ? preferredType : inferredType
  if (!mediaType.startsWith(PREVIEW_SAFE_MEDIA_TYPE_PREFIX)) {
    throw new Error('Unsupported local file type.')
  }
  const now = Date.now()
  cleanupExpiredEntries(now)

  const token = randomUUID()
  const expiresAt = now + TOKEN_TTL_MS

  localFilePreviewEntries.set(token, {
    path: canonicalPath,
    mediaType,
    expiresAt
  })

  return {
    token,
    expiresAt
  }
}

export const readLocalFilePreviewByToken = async (token: string) => {
  cleanupExpiredEntries()
  const entry = localFilePreviewEntries.get(token)
  if (!entry) {
    return null
  }

  if (entry.expiresAt <= Date.now()) {
    localFilePreviewEntries.delete(token)
    return null
  }

  const fileStat = await stat(entry.path).catch(() => null)
  if (!fileStat || !fileStat.isFile()) {
    return null
  }

  return {
    path: entry.path,
    mediaType: entry.mediaType,
    filename: basename(entry.path).replace(/"/g, ''),
    content: await readFile(entry.path),
    expiresAt: entry.expiresAt
  }
}
