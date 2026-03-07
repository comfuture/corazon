import { randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve } from 'node:path'
import { lookup } from 'mime-types'

type LocalFilePreviewEntry = {
  path: string
  mediaType: string
  expiresAt: number
  contentDisposition: 'inline' | 'attachment'
  filename: string
  displayPath: string
}

const TOKEN_TTL_MS = 10 * 60 * 1000
const IMAGE_MEDIA_TYPE_PREFIX = 'image/'
const TEXT_MEDIA_TYPE = 'text/plain; charset=utf-8'
const TEXT_LIKE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.css',
  '.csv',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.ini',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.log',
  '.lua',
  '.md',
  '.mjs',
  '.py',
  '.rb',
  '.rs',
  '.scss',
  '.sh',
  '.sql',
  '.svg',
  '.swift',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.vue',
  '.xml',
  '.yaml',
  '.yml'
])
const TEXT_LIKE_MEDIA_TYPES = new Set([
  'application/javascript',
  'application/json',
  'application/ld+json',
  'application/sql',
  'application/toml',
  'application/typescript',
  'application/x-sh',
  'application/x-yaml',
  'application/xml',
  'text/html',
  'text/javascript',
  'text/markdown',
  'text/plain',
  'text/xml'
])

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

const normalizeDisplayPath = (allowedDirectories: string[], targetPath: string) => {
  for (const directory of allowedDirectories) {
    const relativePath = relative(directory, targetPath).replace(/\\/g, '/').trim()
    const isInside = relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
    if (!isInside) {
      continue
    }
    return relativePath || basename(targetPath)
  }

  return basename(targetPath)
}

const resolveServedFileMetadata = (filePath: string, preferredMediaType?: string) => {
  const normalizedPreferredType = preferredMediaType?.trim().toLowerCase()
  if (normalizedPreferredType?.startsWith(IMAGE_MEDIA_TYPE_PREFIX)) {
    return {
      mediaType: normalizedPreferredType,
      contentDisposition: 'inline' as const
    }
  }

  const extension = extname(filePath).toLowerCase()
  const inferredMediaType = String(inferMediaType(filePath)).toLowerCase()

  if (inferredMediaType.startsWith(IMAGE_MEDIA_TYPE_PREFIX)) {
    return {
      mediaType: inferredMediaType,
      contentDisposition: 'inline' as const
    }
  }

  if (extension === '.pdf' || inferredMediaType === 'application/pdf') {
    return {
      mediaType: 'application/pdf',
      contentDisposition: 'inline' as const
    }
  }

  if (
    TEXT_LIKE_EXTENSIONS.has(extension)
    || inferredMediaType.startsWith('text/')
    || TEXT_LIKE_MEDIA_TYPES.has(inferredMediaType)
  ) {
    return {
      mediaType: TEXT_MEDIA_TYPE,
      contentDisposition: 'inline' as const
    }
  }

  return {
    mediaType: 'application/octet-stream',
    contentDisposition: 'attachment' as const
  }
}

const assertAllowedPreviewPath = (resolvedPath: string, allowedDirectories: string[]) => {
  const isAllowed = allowedDirectories.some(directory => isInsideDirectory(resolvedPath, directory))
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
  const corazonRootDirectory = resolveCorazonRootDir()
  const canonicalCorazonRootDirectory = await realpath(corazonRootDirectory).catch(() => null)
  const allowedDirectories = [
    canonicalThreadWorkingDirectory,
    canonicalCorazonRootDirectory
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)

  const resolvedPath = resolveCandidatePath(normalizedPath, canonicalThreadWorkingDirectory)
  const canonicalPath = await realpath(resolvedPath).catch(() => null)
  if (!canonicalPath) {
    throw new Error('Local file not found.')
  }
  assertAllowedPreviewPath(canonicalPath, allowedDirectories)

  const fileStat = await stat(canonicalPath).catch(() => null)
  if (!fileStat || !fileStat.isFile()) {
    throw new Error('Local file not found.')
  }

  const resolvedFile = resolveServedFileMetadata(canonicalPath, preferredMediaType)
  const now = Date.now()
  cleanupExpiredEntries(now)

  const token = randomUUID()
  const expiresAt = now + TOKEN_TTL_MS
  const filename = basename(canonicalPath).replace(/"/g, '')
  const displayPath = normalizeDisplayPath(allowedDirectories, canonicalPath)

  localFilePreviewEntries.set(token, {
    path: canonicalPath,
    mediaType: resolvedFile.mediaType,
    expiresAt,
    contentDisposition: resolvedFile.contentDisposition,
    filename,
    displayPath
  })

  return {
    token,
    expiresAt,
    mediaType: resolvedFile.mediaType,
    filename,
    displayPath
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
    filename: entry.filename,
    displayPath: entry.displayPath,
    contentDisposition: entry.contentDisposition,
    content: await readFile(entry.path),
    expiresAt: entry.expiresAt
  }
}
