import { randomUUID } from 'node:crypto'
import { access, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { H3Event, MultiPartData } from 'h3'

const toFieldValue = (value: unknown) => {
  if (typeof value === 'string') {
    return value.trim()
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('utf8').trim()
  }
  return ''
}

const sanitizeFilename = (name: string) => {
  const base = basename(name)
  return base.length > 0 ? base : 'attachment'
}

const pathExists = async (path: string) => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const ensureUniqueFilePath = async (dir: string, filename: string) => {
  const extension = extname(filename)
  const base = extension ? filename.slice(0, -extension.length) : filename
  let candidate = join(dir, filename)
  let index = 1

  while (await pathExists(candidate)) {
    candidate = join(dir, `${base}-${index}${extension}`)
    index += 1
  }

  return candidate
}

export default defineEventHandler(async (event: H3Event) => {
  const formData = await readMultipartFormData(event)
  if (!formData) {
    throw createError({ statusCode: 400, statusMessage: 'Missing multipart form data.' })
  }

  let threadId: string | null = null
  let uploadId: string | null = null
  const files: MultiPartData[] = []

  for (const entry of formData) {
    if (entry.filename) {
      files.push(entry)
      continue
    }

    if (entry.name === 'threadId') {
      const value = toFieldValue(entry.data)
      threadId = value || null
      continue
    }

    if (entry.name === 'uploadId') {
      const value = toFieldValue(entry.data)
      uploadId = value || null
    }
  }

  if (!files.length) {
    throw createError({ statusCode: 400, statusMessage: 'No files provided.' })
  }

  const resolvedUploadId = uploadId ?? randomUUID()
  const targetDir = threadId
    ? ensureThreadAttachmentsDirectory(threadId)
    : ensurePendingAttachmentsDirectory(resolvedUploadId)

  const savedFiles = []

  for (const file of files) {
    if (!file.data) {
      continue
    }
    const rawName = sanitizeFilename(file.filename ?? 'attachment')
    const filePath = await ensureUniqueFilePath(targetDir, rawName)
    const filename = basename(filePath)
    await writeFile(filePath, file.data)
    savedFiles.push({
      filename,
      mediaType: file.type ?? null,
      url: `file://${filePath}`
    })
  }

  if (!savedFiles.length) {
    throw createError({ statusCode: 400, statusMessage: 'Failed to persist attachments.' })
  }

  return {
    uploadId: threadId ? null : resolvedUploadId,
    threadId,
    files: savedFiles
  }
})
