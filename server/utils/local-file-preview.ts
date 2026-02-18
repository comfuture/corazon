import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import { lookup } from 'mime-types'

type LocalFilePreviewEntry = {
  path: string
  mediaType: string
  expiresAt: number
}

const TOKEN_TTL_MS = 10 * 60 * 1000

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
  const filePath = withoutQuotes.startsWith('file://')
    ? withoutQuotes.replace(/^file:\/\//, '')
    : withoutQuotes

  try {
    return decodeURIComponent(filePath)
  } catch {
    return filePath
  }
}

const resolveCandidatePath = (inputPath: string) => {
  if (isAbsolute(inputPath)) {
    return resolve(inputPath)
  }
  return resolve(process.cwd(), inputPath)
}

const inferMediaType = (filePath: string) => lookup(filePath) || 'application/octet-stream'

const getAllowedRoots = () => {
  const roots = [
    resolve(ensureThreadRootDirectory()),
    resolve(resolveCorazonRootDir()),
    resolve(process.cwd()),
    resolve(tmpdir()),
    resolve('/tmp'),
    resolve('/private/tmp')
  ]
  return [...new Set(roots)]
}

const assertAllowedPreviewPath = (resolvedPath: string) => {
  const allowedRoots = getAllowedRoots()
  const isAllowed = allowedRoots.some(root => isInsideDirectory(resolvedPath, root))
  if (!isAllowed) {
    throw new Error('Invalid local file path.')
  }
}

export const createLocalFilePreviewToken = async (path: string, preferredMediaType?: string) => {
  const normalizedPath = normalizeInputPath(path)
  if (!normalizedPath) {
    throw new Error('Missing local file path.')
  }

  const resolvedPath = resolveCandidatePath(normalizedPath)
  assertAllowedPreviewPath(resolvedPath)

  const fileStat = await stat(resolvedPath).catch(() => null)
  if (!fileStat || !fileStat.isFile()) {
    throw new Error('Local file not found.')
  }

  const mediaType = preferredMediaType?.trim() || inferMediaType(resolvedPath)
  const now = Date.now()
  cleanupExpiredEntries(now)

  const token = randomUUID()
  const expiresAt = now + TOKEN_TTL_MS

  localFilePreviewEntries.set(token, {
    path: resolvedPath,
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
