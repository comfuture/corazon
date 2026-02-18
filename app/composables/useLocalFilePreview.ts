type LocalFileTokenResponse = {
  token: string
  url: string
  expiresAt: number
}

type CacheEntry = {
  url: string
  expiresAt: number
}

type SourceOccurrence = {
  start: number
  end: number
  source: string
  render: (resolvedSource: string) => string
}

const MARKDOWN_IMAGE_REGEX = /!\[[^\]]*\]\(([^)\n]+)\)/g
const HTML_IMAGE_REGEX = /<img\b[^>]*\bsrc=(['"])(.*?)\1[^>]*>/gi
const IMAGE_EXTENSION_REGEX = /\.(avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp)(?:$|[?#])/i
const CACHE_STALE_BUFFER_MS = 5_000

const previewCache = new Map<string, CacheEntry>()
const inFlightRequests = new Map<string, Promise<string | null>>()

const cleanupExpiredCache = (now = Date.now()) => {
  for (const [key, entry] of previewCache.entries()) {
    if (entry.expiresAt <= now) {
      previewCache.delete(key)
    }
  }
}

const normalizeSource = (value: string) => {
  const trimmed = value.trim().replace(/^['"]+|['"]+$/g, '')
  if (!trimmed) {
    return ''
  }

  if (trimmed.startsWith('file://localhost/')) {
    return `file://${trimmed.slice('file://localhost/'.length)}`
  }

  return trimmed
}

const isResolvableLocalImageSource = (value: string) => {
  const normalized = value.trim().toLowerCase()
  if (!normalized) {
    return false
  }

  if (
    normalized.startsWith('http://')
    || normalized.startsWith('https://')
    || normalized.startsWith('data:')
    || normalized.startsWith('blob:')
    || normalized.startsWith('about:')
    || normalized.startsWith('mailto:')
    || normalized.startsWith('tel:')
    || normalized.startsWith('#')
    || normalized.startsWith('/api/')
    || normalized.startsWith('/_nuxt/')
  ) {
    return false
  }

  return IMAGE_EXTENSION_REGEX.test(normalized)
}

const inferImageMediaType = (value: string) => {
  const normalized = value.toLowerCase()
  if (normalized.includes('.png')) {
    return 'image/png'
  }
  if (normalized.includes('.jpg') || normalized.includes('.jpeg')) {
    return 'image/jpeg'
  }
  if (normalized.includes('.webp')) {
    return 'image/webp'
  }
  if (normalized.includes('.gif')) {
    return 'image/gif'
  }
  if (normalized.includes('.svg')) {
    return 'image/svg+xml'
  }
  if (normalized.includes('.avif')) {
    return 'image/avif'
  }
  if (normalized.includes('.bmp')) {
    return 'image/bmp'
  }
  if (normalized.includes('.ico')) {
    return 'image/x-icon'
  }
  if (normalized.includes('.tif')) {
    return 'image/tiff'
  }
  return undefined
}

const parseMarkdownImageTarget = (target: string) => {
  const trimmed = target.trim()
  if (!trimmed) {
    return null
  }

  if (trimmed.startsWith('<')) {
    const closingIndex = trimmed.indexOf('>')
    if (closingIndex > 1) {
      const source = trimmed.slice(1, closingIndex).trim()
      const suffix = trimmed.slice(closingIndex + 1)
      if (!source) {
        return null
      }
      return {
        source,
        renderTarget: (resolvedSource: string) => `<${resolvedSource}>${suffix}`
      }
    }
  }

  const firstWhitespaceIndex = trimmed.search(/\s/)
  const sourceToken = firstWhitespaceIndex === -1 ? trimmed : trimmed.slice(0, firstWhitespaceIndex)
  const suffix = firstWhitespaceIndex === -1 ? '' : trimmed.slice(firstWhitespaceIndex)
  if (!sourceToken) {
    return null
  }

  const isDoubleQuoted = sourceToken.startsWith('"') && sourceToken.endsWith('"') && sourceToken.length >= 2
  const isSingleQuoted = sourceToken.startsWith('\'') && sourceToken.endsWith('\'') && sourceToken.length >= 2
  const quote = isDoubleQuoted ? '"' : (isSingleQuoted ? '\'' : '')
  const source = quote ? sourceToken.slice(1, -1) : sourceToken
  if (!source) {
    return null
  }

  return {
    source,
    renderTarget: (resolvedSource: string) =>
      quote ? `${quote}${resolvedSource}${quote}${suffix}` : `${resolvedSource}${suffix}`
  }
}

const collectMarkdownImageOccurrences = (content: string): SourceOccurrence[] => {
  const results: SourceOccurrence[] = []

  for (const match of content.matchAll(MARKDOWN_IMAGE_REGEX)) {
    const fullMatch = match[0]
    const rawTarget = match[1]
    if (!fullMatch || !rawTarget || match.index == null) {
      continue
    }

    const parsed = parseMarkdownImageTarget(rawTarget)
    if (!parsed) {
      continue
    }

    const source = normalizeSource(parsed.source)
    if (!isResolvableLocalImageSource(source)) {
      continue
    }

    const start = match.index
    const end = start + fullMatch.length

    results.push({
      start,
      end,
      source,
      render: (resolvedSource: string) => fullMatch.replace(rawTarget, parsed.renderTarget(resolvedSource))
    })
  }

  return results
}

const collectHtmlImageOccurrences = (content: string): SourceOccurrence[] => {
  const results: SourceOccurrence[] = []

  for (const match of content.matchAll(HTML_IMAGE_REGEX)) {
    const fullMatch = match[0]
    const source = match[2]
    if (!fullMatch || !source || match.index == null) {
      continue
    }

    const normalizedSource = normalizeSource(source)
    if (!isResolvableLocalImageSource(normalizedSource)) {
      continue
    }

    const start = match.index
    const end = start + fullMatch.length

    results.push({
      start,
      end,
      source: normalizedSource,
      render: (resolvedSource: string) =>
        fullMatch.replace(/(\bsrc=)(['"])(.*?)\2/i, (_value, prefix, quote) => {
          return `${prefix}${quote}${resolvedSource}${quote}`
        })
    })
  }

  return results
}

const buildCacheKey = (source: string, preferredMediaType?: string) =>
  `${source}::${preferredMediaType ?? ''}`

const resolveLocalFilePreviewUrl = async (source: string, preferredMediaType?: string) => {
  if (!import.meta.client) {
    return null
  }

  const normalizedSource = normalizeSource(source)
  if (!isResolvableLocalImageSource(normalizedSource)) {
    return null
  }

  cleanupExpiredCache()

  const cacheKey = buildCacheKey(normalizedSource, preferredMediaType)
  const cached = previewCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now() + CACHE_STALE_BUFFER_MS) {
    return cached.url
  }

  const inFlight = inFlightRequests.get(cacheKey)
  if (inFlight) {
    return inFlight
  }

  const request = (async () => {
    try {
      const response = await $fetch<LocalFileTokenResponse>('/api/chat/local-file/token', {
        method: 'POST',
        body: {
          path: normalizedSource,
          mediaType: preferredMediaType
        }
      })

      previewCache.set(cacheKey, {
        url: response.url,
        expiresAt: response.expiresAt
      })

      return response.url
    } catch {
      return null
    } finally {
      inFlightRequests.delete(cacheKey)
    }
  })()

  inFlightRequests.set(cacheKey, request)
  return request
}

const rewriteContentWithLocalImagePreviews = async (content: string) => {
  if (!import.meta.client || !content) {
    return content
  }

  const occurrences = [
    ...collectMarkdownImageOccurrences(content),
    ...collectHtmlImageOccurrences(content)
  ].sort((left, right) => left.start - right.start)

  if (!occurrences.length) {
    return content
  }

  const uniqueSources = [...new Set(occurrences.map(item => item.source))]
  const resolvedEntries = await Promise.all(uniqueSources.map(async (source) => {
    const url = await resolveLocalFilePreviewUrl(source, inferImageMediaType(source))
    return [source, url] as const
  }))

  const resolvedMap = new Map<string, string>(
    resolvedEntries
      .filter((entry): entry is readonly [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)
  )

  if (!resolvedMap.size) {
    return content
  }

  let result = ''
  let cursor = 0

  for (const occurrence of occurrences) {
    if (occurrence.start < cursor) {
      continue
    }

    result += content.slice(cursor, occurrence.start)

    const resolvedSource = resolvedMap.get(occurrence.source)
    if (resolvedSource) {
      result += occurrence.render(resolvedSource)
    } else {
      result += content.slice(occurrence.start, occurrence.end)
    }

    cursor = occurrence.end
  }

  result += content.slice(cursor)
  return result
}

export const useLocalFilePreview = () => ({
  resolveLocalFilePreviewUrl,
  rewriteContentWithLocalImagePreviews
})
