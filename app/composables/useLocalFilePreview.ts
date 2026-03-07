type LocalFileTokenResponse = {
  token: string
  url: string
  expiresAt: number
  mediaType: string
  filename: string
  displayPath: string
}

type CacheEntry = {
  url: string
  expiresAt: number
  mediaType: string
  filename: string
  displayPath: string
}

type ResolvedLocalFile = CacheEntry

type SourceOccurrence = {
  start: number
  end: number
  source: string
  preferredMediaType?: string
  render: (resolvedSource: ResolvedLocalFile) => string
  fallbackRender?: () => string
}

const MARKDOWN_IMAGE_REGEX = /!\[[^\]]*\]\(([^)\n]+)\)/g
const MARKDOWN_LINK_REGEX = /\[([^\]]*)\]\(([^)\n]+)\)/g
const HTML_IMAGE_REGEX = /<img\b[^>]*\bsrc=(['"])(.*?)\1[^>]*>/gi
const IMAGE_EXTENSION_REGEX = /\.(avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp)(?:$|[?#])/i
const FILE_EXTENSION_REGEX = /(^|\/)[^/?#]+\.[a-z0-9]{1,16}(?:$|[?#])/i
const ABSOLUTE_LOCAL_PATH_REGEX = /^\/(?:users|home|private|var|tmp|volumes|opt|etc|applications|library|system)\b/i
const RELATIVE_LOCAL_PATH_REGEX = /^(?:\.{1,2}\/|~\/|[^:/?#][^?#]*\/)?[^/?#]+\.[a-z0-9]{1,16}(?:$|[?#])/i
const CACHE_STALE_BUFFER_MS = 5_000

const previewCache = new Map<string, CacheEntry>()
const inFlightRequests = new Map<string, Promise<ResolvedLocalFile | null>>()

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
    return `file:///${trimmed.slice('file://localhost/'.length)}`
  }

  return trimmed
}

const isIgnoredWebSource = (value: string) => {
  const normalized = value.trim().toLowerCase()
  return (
    !normalized
    || normalized.startsWith('http://')
    || normalized.startsWith('https://')
    || normalized.startsWith('data:')
    || normalized.startsWith('blob:')
    || normalized.startsWith('about:')
    || normalized.startsWith('mailto:')
    || normalized.startsWith('tel:')
    || normalized.startsWith('javascript:')
    || normalized.startsWith('#')
    || normalized.startsWith('/api/')
    || normalized.startsWith('/_nuxt/')
  )
}

const isResolvableLocalFileSource = (value: string) => {
  const normalized = value.trim().toLowerCase()
  if (isIgnoredWebSource(normalized) || !FILE_EXTENSION_REGEX.test(normalized)) {
    return false
  }

  return (
    normalized.startsWith('file://')
    || ABSOLUTE_LOCAL_PATH_REGEX.test(normalized)
    || RELATIVE_LOCAL_PATH_REGEX.test(normalized)
  )
}

const isResolvableLocalImageSource = (value: string) =>
  isResolvableLocalFileSource(value) && IMAGE_EXTENSION_REGEX.test(value.trim().toLowerCase())

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

const parseMarkdownTarget = (target: string) => {
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

const escapeMarkdownLinkLabel = (value: string) =>
  value
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')

const escapeMarkdownPlainText = (value: string) =>
  value
    .replace(/\\/g, '\\\\')
    .replace(/([`*_{}[\]()#+.!|-])/g, '\\$1')

const deriveFallbackDisplayPath = (source: string) => {
  const normalized = normalizeSource(source)
    .replace(/^file:\/\//i, '')
    .replace(/\\/g, '/')

  const corazonMarkerIndex = normalized.lastIndexOf('/.corazon/')
  if (corazonMarkerIndex !== -1) {
    return normalized.slice(corazonMarkerIndex + '/.corazon/'.length)
  }

  const projectMarker = '/corazon/'
  const projectMarkerIndex = normalized.toLowerCase().lastIndexOf(projectMarker)
  if (projectMarkerIndex !== -1) {
    const candidate = normalized.slice(projectMarkerIndex + projectMarker.length)
    if (/^(app|server|lib|types|docs|workflows)\//.test(candidate)) {
      return candidate
    }
  }

  const segments = normalized.split('/').filter(Boolean)
  if (segments.length >= 2) {
    return segments.slice(-2).join('/')
  }
  return segments[0] ?? normalized
}

const shouldRewriteLocalFileLabel = (label: string, source: string) => {
  const trimmed = label.trim()
  if (!trimmed) {
    return true
  }

  const normalizedLabel = normalizeSource(trimmed)
  const normalizedSource = normalizeSource(source)

  return normalizedLabel === normalizedSource || isResolvableLocalFileSource(normalizedLabel)
}

const resolveMarkdownLinkLabel = (
  label: string,
  resolvedSource: ResolvedLocalFile,
  source: string
) => {
  if (shouldRewriteLocalFileLabel(label, source)) {
    return resolvedSource.displayPath || resolvedSource.filename
  }
  return label.trim()
}

const collectMarkdownImageOccurrences = (content: string): SourceOccurrence[] => {
  const results: SourceOccurrence[] = []

  for (const match of content.matchAll(MARKDOWN_IMAGE_REGEX)) {
    const fullMatch = match[0]
    const rawTarget = match[1]
    if (!fullMatch || !rawTarget || match.index == null) {
      continue
    }

    const parsed = parseMarkdownTarget(rawTarget)
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
      preferredMediaType: inferImageMediaType(source),
      render: resolvedSource => fullMatch.replace(rawTarget, parsed.renderTarget(resolvedSource.url))
    })
  }

  return results
}

const collectMarkdownLocalFileLinkOccurrences = (content: string): SourceOccurrence[] => {
  const results: SourceOccurrence[] = []

  for (const match of content.matchAll(MARKDOWN_LINK_REGEX)) {
    const fullMatch = match[0]
    const rawLabel = match[1]
    const rawTarget = match[2]
    if (!fullMatch || rawLabel == null || !rawTarget || match.index == null) {
      continue
    }
    if (match.index > 0 && content[match.index - 1] === '!') {
      continue
    }

    const parsed = parseMarkdownTarget(rawTarget)
    if (!parsed) {
      continue
    }

    const source = normalizeSource(parsed.source)
    if (!isResolvableLocalFileSource(source)) {
      continue
    }

    const start = match.index
    const end = start + fullMatch.length

    results.push({
      start,
      end,
      source,
      render: (resolvedSource) => {
        const label = escapeMarkdownLinkLabel(resolveMarkdownLinkLabel(rawLabel, resolvedSource, source))
        return `[${label}](${parsed.renderTarget(resolvedSource.url)})`
      },
      fallbackRender: () => {
        const label = shouldRewriteLocalFileLabel(rawLabel, source)
          ? deriveFallbackDisplayPath(source)
          : rawLabel.trim()
        return escapeMarkdownPlainText(label)
      }
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
      preferredMediaType: inferImageMediaType(normalizedSource),
      render: resolvedSource =>
        fullMatch.replace(/(\bsrc=)(['"])(.*?)\2/i, (_value, prefix, quote) => {
          return `${prefix}${quote}${resolvedSource.url}${quote}`
        })
    })
  }

  return results
}

const buildCacheKey = (source: string, preferredMediaType?: string, threadId?: string | null) =>
  `${threadId ?? ''}::${source}::${preferredMediaType ?? ''}`

const resolveLocalFileToken = async (
  source: string,
  preferredMediaType?: string,
  threadId?: string | null
) => {
  if (!import.meta.client) {
    return null
  }

  const normalizedSource = normalizeSource(source)
  if (!isResolvableLocalFileSource(normalizedSource)) {
    return null
  }

  cleanupExpiredCache()

  const cacheKey = buildCacheKey(normalizedSource, preferredMediaType, threadId)
  const cached = previewCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now() + CACHE_STALE_BUFFER_MS) {
    return cached
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
          mediaType: preferredMediaType,
          threadId
        }
      })

      const entry: CacheEntry = {
        url: response.url,
        expiresAt: response.expiresAt,
        mediaType: response.mediaType,
        filename: response.filename,
        displayPath: response.displayPath
      }

      previewCache.set(cacheKey, entry)
      return entry
    } catch {
      return null
    } finally {
      inFlightRequests.delete(cacheKey)
    }
  })()

  inFlightRequests.set(cacheKey, request)
  return request
}

const resolveLocalFilePreviewUrl = async (
  source: string,
  preferredMediaType?: string,
  threadId?: string | null
) => {
  const resolved = await resolveLocalFileToken(source, preferredMediaType, threadId)
  return resolved?.url ?? null
}

const rewriteContentWithLocalFilePreviews = async (content: string, threadId?: string | null) => {
  if (!import.meta.client || !content) {
    return content
  }

  const occurrences = [
    ...collectMarkdownImageOccurrences(content),
    ...collectMarkdownLocalFileLinkOccurrences(content),
    ...collectHtmlImageOccurrences(content)
  ].sort((left, right) => left.start - right.start)

  if (!occurrences.length) {
    return content
  }

  const uniqueRequests = new Map<string, { source: string, preferredMediaType?: string }>()
  for (const occurrence of occurrences) {
    const cacheKey = buildCacheKey(occurrence.source, occurrence.preferredMediaType, threadId)
    if (!uniqueRequests.has(cacheKey)) {
      uniqueRequests.set(cacheKey, {
        source: occurrence.source,
        preferredMediaType: occurrence.preferredMediaType
      })
    }
  }

  const resolvedEntries = await Promise.all([...uniqueRequests.entries()].map(async ([cacheKey, request]) => {
    const resolved = await resolveLocalFileToken(request.source, request.preferredMediaType, threadId)
    return [cacheKey, resolved] as const
  }))

  const resolvedMap = new Map<string, ResolvedLocalFile>(
    resolvedEntries.filter((entry): entry is readonly [string, ResolvedLocalFile] => entry[1] !== null)
  )

  let result = ''
  let cursor = 0

  for (const occurrence of occurrences) {
    if (occurrence.start < cursor) {
      continue
    }

    result += content.slice(cursor, occurrence.start)

    const cacheKey = buildCacheKey(occurrence.source, occurrence.preferredMediaType, threadId)
    const resolvedSource = resolvedMap.get(cacheKey)
    if (resolvedSource) {
      result += occurrence.render(resolvedSource)
    } else if (occurrence.fallbackRender) {
      result += occurrence.fallbackRender()
    } else {
      result += content.slice(occurrence.start, occurrence.end)
    }

    cursor = occurrence.end
  }

  result += content.slice(cursor)
  return result
}

const rewriteContentWithLocalImagePreviews = rewriteContentWithLocalFilePreviews

export const useLocalFilePreview = () => ({
  resolveLocalFilePreviewUrl,
  rewriteContentWithLocalFilePreviews,
  rewriteContentWithLocalImagePreviews
})
