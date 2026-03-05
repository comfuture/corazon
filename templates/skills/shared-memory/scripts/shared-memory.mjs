#!/usr/bin/env node

const DEFAULT_LIMIT = 5
const DEFAULT_THRESHOLD = 0.62
const DEFAULT_MEMORY_API_BASE_URL = 'http://127.0.0.1:3000'

const toJson = payload => JSON.stringify(payload, null, 2)

const parseArgs = (argv) => {
  const [command, ...rest] = argv
  const options = {}
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (!arg.startsWith('--')) {
      continue
    }
    const key = arg.slice(2)
    const value = rest[index + 1]
    if (!value || value.startsWith('--')) {
      options[key] = 'true'
      continue
    }
    options[key] = value
    index += 1
  }
  return { command, options }
}

const requireOption = (options, key) => {
  const value = options[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`missing --${key}`)
  }
  return value.trim()
}

const clampLimit = (value) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return DEFAULT_LIMIT
  }
  const rounded = Math.floor(parsed)
  if (rounded < 1) {
    return 1
  }
  return Math.min(rounded, 100)
}

const clampThreshold = (value) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return DEFAULT_THRESHOLD
  }
  return Math.max(0, Math.min(parsed, 1))
}

const trimTrailingSlash = value => value.replace(/\/+$/, '')

const resolveApiBaseUrl = (options) => {
  const explicit = typeof options['api-base-url'] === 'string'
    ? options['api-base-url'].trim()
    : ''
  const fromEnv = process.env.CORAZON_MEMORY_API_BASE_URL?.trim() ?? ''
  const target = explicit || fromEnv || DEFAULT_MEMORY_API_BASE_URL
  if (!target) {
    throw new Error('memory API base URL is empty')
  }
  return trimTrailingSlash(target)
}

const readResponseJson = async (response) => {
  const text = await response.text()
  if (!text) {
    return {}
  }
  try {
    return JSON.parse(text)
  } catch {
    return {
      raw: text
    }
  }
}

const requestJson = async ({ url, method, body }) => {
  const response = await fetch(url, {
    method,
    headers: body
      ? {
          'content-type': 'application/json'
        }
      : undefined,
    body: body
      ? JSON.stringify(body)
      : undefined
  })

  const payload = await readResponseJson(response)

  if (!response.ok) {
    const errorMessage = typeof payload?.statusMessage === 'string' && payload.statusMessage.trim()
      ? payload.statusMessage
      : `Request failed: ${response.status}`
    throw new Error(errorMessage)
  }

  return payload
}

const ensureMemory = async (apiBaseUrl) => {
  const payload = await requestJson({
    url: `${apiBaseUrl}/api/memory/health`,
    method: 'GET'
  })

  return {
    apiBaseUrl,
    health: payload
  }
}

const searchMemory = async ({ apiBaseUrl, query, limit }) => {
  const payload = await requestJson({
    url: `${apiBaseUrl}/api/memory/search`,
    method: 'POST',
    body: {
      query,
      limit
    }
  })

  return {
    apiBaseUrl,
    query,
    limit,
    results: Array.isArray(payload?.results)
      ? payload.results
      : []
  }
}

const upsertMemory = async ({
  apiBaseUrl,
  section,
  text,
  threshold,
  memoryFile
}) => {
  const payload = await requestJson({
    url: `${apiBaseUrl}/api/memory/remember`,
    method: 'POST',
    body: {
      text,
      section,
      metadata: {
        source: 'shared-memory-skill',
        section,
        threshold,
        ...(memoryFile ? { legacyMemoryFile: memoryFile } : {})
      }
    }
  })

  return {
    apiBaseUrl,
    section,
    text,
    threshold,
    memories: Array.isArray(payload?.memories)
      ? payload.memories
      : [],
    messageCount: typeof payload?.messageCount === 'number'
      ? payload.messageCount
      : 0
  }
}

const run = async () => {
  const { command, options } = parseArgs(process.argv.slice(2))
  if (!command) {
    throw new Error('missing command (ensure|search|upsert)')
  }

  const apiBaseUrl = resolveApiBaseUrl(options)
  const legacyMemoryFile = typeof options['memory-file'] === 'string'
    ? options['memory-file'].trim()
    : null

  if (command === 'ensure') {
    return ensureMemory(apiBaseUrl)
  }

  if (command === 'search') {
    const query = requireOption(options, 'query')
    const limit = clampLimit(options.limit ?? DEFAULT_LIMIT)
    return searchMemory({
      apiBaseUrl,
      query,
      limit
    })
  }

  if (command === 'upsert') {
    const text = requireOption(options, 'text')
    const section = typeof options.section === 'string' && options.section.trim()
      ? options.section.trim()
      : 'Facts'
    const threshold = clampThreshold(options.threshold ?? DEFAULT_THRESHOLD)
    return upsertMemory({
      apiBaseUrl,
      section,
      text,
      threshold,
      memoryFile: legacyMemoryFile
    })
  }

  throw new Error(`unknown command: ${command}`)
}

run()
  .then((payload) => {
    process.stdout.write(`${toJson({ ok: true, ...payload })}\n`)
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stdout.write(`${toJson({ ok: false, error: message })}\n`)
    process.exitCode = 1
  })
