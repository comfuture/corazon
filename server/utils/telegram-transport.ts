import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { start, getRun } from 'workflow/api'
import type { UIMessageChunk } from 'ai'
import {
  buildRecoveredConversationDeveloperInstructions,
  createSimpleChatgptCodexInput,
  runChatgptCodexTextResponse
} from '../../lib/chatgpt-codex-responses.ts'
import { CODEX_ITEM_PART } from '@@/types/chat-ui'
import type {
  CodexChatUserMessage,
  CodexItemData,
  CodexThreadEventData,
  CodexUIMessage
} from '@@/types/chat-ui'
import { codexChatTurnWorkflow } from '../workflows/chat-turn'
import {
  assignTelegramSessionThread,
  clearThreadActiveRun,
  createTelegramSession,
  ensurePendingAttachmentsDirectory,
  finalizeTelegramSessionRun,
  getTelegramSessionById,
  getTelegramTransportState,
  getThreadActiveRun,
  loadRecentTelegramSessions,
  loadThreadMessages,
  recordTelegramSessionInbound,
  recordTelegramSessionOutbound,
  setTelegramSessionActiveRun,
  setTelegramSessionSummary,
  setThreadOrigin,
  upsertTelegramRecentChat,
  upsertTelegramTransportState
} from './db.ts'
import type { TelegramSession } from './db.ts'
import { readTelegramSettings } from './settings-config.ts'
import { toTelegramChatCandidateFromMessage } from './telegram-chat-discovery.ts'
import {
  hasTelegramContinuationHint,
  isTelegramSessionImmediatelyReusable,
  type TelegramSessionRouteDecision
} from './telegram-session.ts'
import {
  editTelegramMessageText,
  downloadTelegramFile,
  formatTelegramApiError,
  getTelegramFile,
  getTelegramDisplayName,
  sendTelegramChatAction,
  getTelegramUpdates,
  isTelegramBotMessage,
  isTelegramEditedUpdate,
  sendTelegramMessage,
  type TelegramMessage,
  type TelegramUpdate
} from './telegram-bot.ts'
import { ensureAgentBootstrap } from './agent-bootstrap.ts'
import { createCodexClient } from './codex-client/index.ts'
import type { CodexClient } from './codex-client/types.ts'
import { deleteRuntimeThread, deleteRuntimeTurnControl } from './runtime.ts'

const TELEGRAM_POLL_TIMEOUT_SECONDS = 20
const TELEGRAM_DISABLED_RETRY_MS = 5000
const TELEGRAM_ERROR_RETRY_MS = 3000
const TELEGRAM_STATE_KEY = 'default'
const TELEGRAM_TEXT_MAX_LENGTH = 3500
const TELEGRAM_STEER_RETRY_ATTEMPTS = 5
const TELEGRAM_STEER_RETRY_MS = 300
const TELEGRAM_TYPING_REFRESH_MS = 4000
const TELEGRAM_DRAFT_UPDATE_MIN_INTERVAL_MS = 800
const TELEGRAM_ROUTE_CANDIDATE_LIMIT = 5
const TELEGRAM_ROUTE_TRANSCRIPT_LINE_LIMIT = 12
const TELEGRAM_RESUME_CONFIDENCE_THRESHOLD = 0.72
const TELEGRAM_CARRYOVER_CONFIDENCE_THRESHOLD = 0.55
const TELEGRAM_NEW_CONFIDENCE_THRESHOLD = 0.65
const TELEGRAM_MAX_IMAGE_BYTES = 20 * 1024 * 1024
const TELEGRAM_SUPPORTED_IMAGE_MIME_PREFIX = 'image/'
const CARRYOVER_ROUTE_MODEL = 'gpt-5.4-mini'
const CARRYOVER_SUMMARY_MODEL = 'gpt-5.1-codex-mini'
const CARRYOVER_WORKDIR = '/tmp'

let telegramTransportInitialized = false
let telegramProcessingQueue = Promise.resolve()
let telegramSummaryCodex: CodexClient | null = null
const telegramTypingControllers = new Map<string, ReturnType<typeof createTelegramTypingControllerInternal>>()

const sleep = async (ms: number) => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

const normalizeChatId = (value: string | number) => String(value).trim()

const compactWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim()

const truncate = (value: string, max = 180) => {
  const normalized = compactWhitespace(value)
  if (normalized.length <= max) {
    return normalized
  }
  return `${normalized.slice(0, Math.max(0, max - 1)).trim()}…`
}

const normalizeTelegramText = (value: string) =>
  value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

const truncateTelegramText = (value: string, max = TELEGRAM_TEXT_MAX_LENGTH) => {
  if (value.length <= max) {
    return value
  }
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

const escapeTelegramHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

const escapeTelegramAttribute = (value: string) =>
  escapeTelegramHtml(value).replace(/"/g, '&quot;')

const MARKDOWN_LINK_REGEX = /\[([^\]\n]+)\]\(([^)\n]+)\)/g
const FILE_EXTENSION_REGEX = /(^|\/)[^/?#]+\.[a-z0-9]{1,16}(?:$|[?#])/i
const ABSOLUTE_LOCAL_PATH_REGEX = /^\/(?:users|home|private|var|tmp|volumes|opt|etc|applications|library|system|root)\b/i
const RELATIVE_LOCAL_PATH_REGEX = /^(?:\.{1,2}\/|~\/|[^:/?#][^?#]*\/)?[^/?#]+\.[a-z0-9]{1,16}(?:$|[?#])/i

const normalizeLocalSource = (value: string) => value.trim().replace(/^['"]+|['"]+$/g, '')

const isResolvableLocalFileSource = (value: string) => {
  const normalized = normalizeLocalSource(value).toLowerCase()
  if (!normalized || !FILE_EXTENSION_REGEX.test(normalized)) {
    return false
  }

  if (
    normalized.startsWith('http://')
    || normalized.startsWith('https://')
    || normalized.startsWith('data:')
    || normalized.startsWith('blob:')
    || normalized.startsWith('mailto:')
    || normalized.startsWith('tel:')
    || normalized.startsWith('javascript:')
    || normalized.startsWith('#')
    || normalized.startsWith('/api/')
    || normalized.startsWith('/_nuxt/')
  ) {
    return false
  }

  return (
    normalized.startsWith('file://')
    || ABSOLUTE_LOCAL_PATH_REGEX.test(normalized)
    || RELATIVE_LOCAL_PATH_REGEX.test(normalized)
  )
}

const parseMarkdownTargetSource = (target: string) => {
  const trimmed = target.trim()
  if (!trimmed) {
    return ''
  }

  if (trimmed.startsWith('<')) {
    const closingBracketIndex = trimmed.indexOf('>')
    if (closingBracketIndex > 1) {
      const wrappedSource = trimmed.slice(1, closingBracketIndex)
      return normalizeLocalSource(wrappedSource)
    }
  }

  const firstWhitespaceIndex = trimmed.search(/\s/)
  const sourceToken = firstWhitespaceIndex === -1 ? trimmed : trimmed.slice(0, firstWhitespaceIndex)
  if (!sourceToken) {
    return ''
  }

  const isDoubleQuoted = sourceToken.startsWith('"') && sourceToken.endsWith('"') && sourceToken.length >= 2
  const isSingleQuoted = sourceToken.startsWith('\'') && sourceToken.endsWith('\'') && sourceToken.length >= 2
  const source = isDoubleQuoted || isSingleQuoted ? sourceToken.slice(1, -1) : sourceToken
  return normalizeLocalSource(source)
}

const resolveTelegramPublicBaseUrl = () => {
  const candidates = [
    process.env.CORAZON_PUBLIC_BASE_URL,
    process.env.NUXT_PUBLIC_SITE_URL,
    process.env.SITE_URL,
    process.env.APP_BASE_URL
  ]

  for (const candidate of candidates) {
    const value = candidate?.trim()
    if (!value) {
      continue
    }
    try {
      const parsed = new URL(value)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        continue
      }
      return parsed.toString().replace(/\/+$/, '')
    } catch {
      continue
    }
  }

  return ''
}

const toTelegramPublicUrl = (baseUrl: string, path: string) => {
  if (!baseUrl) {
    return ''
  }
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${baseUrl}${normalizedPath}`
}

const rewriteTelegramLocalFileLinks = async (value: string, threadId: string | null) => {
  const baseUrl = resolveTelegramPublicBaseUrl()
  let rewritten = ''
  let cursor = 0
  const matches = value.matchAll(MARKDOWN_LINK_REGEX)

  for (const match of matches) {
    const fullMatch = match[0]
    const label = match[1] || ''
    const target = match[2] || ''
    if (!fullMatch || match.index == null) {
      continue
    }

    rewritten += value.slice(cursor, match.index)
    cursor = match.index + fullMatch.length

    if (match.index > 0 && value[match.index - 1] === '!') {
      rewritten += fullMatch
      continue
    }

    const source = parseMarkdownTargetSource(target)
    if (!source || !isResolvableLocalFileSource(source)) {
      rewritten += fullMatch
      continue
    }

    if (!threadId) {
      const fallbackLabel = label.trim() || source
      rewritten += `${fallbackLabel} (local file: ${source})`
      continue
    }

    try {
      const preview = await createLocalFilePreviewToken(source, undefined, threadId)
      const previewUrl = toTelegramPublicUrl(baseUrl, `/api/chat/local-file/${encodeURIComponent(preview.token)}`)
      const fallbackDisplay = preview.displayPath || preview.filename || source
      const nextLabel = label.trim() || fallbackDisplay

      if (!previewUrl) {
        rewritten += `${nextLabel} (local file: ${fallbackDisplay})`
        continue
      }

      rewritten += `[${nextLabel}](${previewUrl})`
    } catch (error) {
      console.warn('[telegram] failed to create local file preview token:', formatTelegramApiError(error))
      const fallbackLabel = label.trim() || source
      rewritten += `${fallbackLabel} (local file: ${source})`
    }
  }

  rewritten += value.slice(cursor)
  return rewritten
}

const renderTelegramHtml = async (value: string, threadId: string | null) => {
  const placeholders: string[] = []
  const stash = (html: string) => {
    const token = `__TG_PLACEHOLDER_${placeholders.length}__`
    placeholders.push(html)
    return token
  }

  let text = truncateTelegramText(normalizeTelegramText(value))
  if (!text) {
    return ''
  }

  text = await rewriteTelegramLocalFileLinks(text, threadId)

  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label: string, url: string) =>
    stash(`<a href="${escapeTelegramAttribute(url)}">${escapeTelegramHtml(label)}</a>`)
  )

  text = text.replace(/```(?:[\w#+.-]+)?\n?([\s\S]*?)```/g, (_match, code: string) =>
    stash(`<pre><code>${escapeTelegramHtml(String(code).replace(/\n$/, ''))}</code></pre>`)
  )

  text = text.replace(/`([^`\n]+)`/g, (_match, code: string) =>
    stash(`<code>${escapeTelegramHtml(code)}</code>`)
  )

  text = escapeTelegramHtml(text)
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
  text = text.replace(/\*\*([^\n]+?)\*\*/g, '<b>$1</b>')

  return text.replace(/__TG_PLACEHOLDER_(\d+)__/g, (_match, index: string) => {
    return placeholders[Number(index)] ?? ''
  })
}

const formatTelegramUserText = (message: TelegramMessage) => {
  const text = message.text?.trim() || message.caption?.trim() || ''
  if (!text) {
    return ''
  }

  if (message.chat.type === 'group' || message.chat.type === 'supergroup') {
    const displayName = getTelegramDisplayName(message.from)
    if (displayName) {
      return `${displayName}: ${text}`
    }
  }

  return text
}

const shouldReplyInTelegramChat = (message: TelegramMessage) =>
  message.chat.type === 'group' || message.chat.type === 'supergroup'

const sanitizeTelegramFilename = (value: string) => {
  const normalized = basename(value).replace(/[\\/\0]/g, '').trim()
  return normalized || 'telegram-image'
}

const ensureUniqueTelegramAttachmentPath = (directory: string, filename: string) => {
  const extension = extname(filename)
  const base = extension ? filename.slice(0, -extension.length) : filename
  let candidate = join(directory, filename)
  let index = 1

  while (existsSync(candidate)) {
    candidate = join(directory, `${base}-${index}${extension}`)
    index += 1
  }

  return candidate
}

const resolveTelegramImageExtension = (filePath: string, mediaType: string | null) => {
  const fromPath = extname(filePath).toLowerCase()
  if (fromPath) {
    return fromPath
  }
  if (mediaType === 'image/png') {
    return '.png'
  }
  if (mediaType === 'image/webp') {
    return '.webp'
  }
  if (mediaType === 'image/gif') {
    return '.gif'
  }
  return '.jpg'
}

const hasTelegramPhotoAttachment = (message: TelegramMessage) =>
  Array.isArray(message.photo) && message.photo.length > 0

const hasTelegramImageDocumentAttachment = (message: TelegramMessage) =>
  typeof message.document?.file_id === 'string'
  && (message.document.mime_type?.toLowerCase().startsWith(TELEGRAM_SUPPORTED_IMAGE_MIME_PREFIX) ?? false)

const hasTelegramImageAttachment = (message: TelegramMessage) =>
  hasTelegramPhotoAttachment(message) || hasTelegramImageDocumentAttachment(message)

const resolveTelegramAttachmentTarget = (message: TelegramMessage) => {
  if (hasTelegramPhotoAttachment(message)) {
    const photoSizes = message.photo ?? []
    const best = photoSizes
      .slice()
      .sort((a, b) => {
        const sizeDiff = (b.file_size ?? 0) - (a.file_size ?? 0)
        if (sizeDiff !== 0) {
          return sizeDiff
        }
        return (b.width * b.height) - (a.width * a.height)
      })[0]
    if (best?.file_id) {
      return {
        fileId: best.file_id,
        mediaType: 'image/jpeg' as const,
        sourceName: null as string | null
      }
    }
  }

  if (hasTelegramImageDocumentAttachment(message)) {
    const mediaType = message.document?.mime_type?.toLowerCase() ?? 'image/jpeg'
    return {
      fileId: message.document!.file_id,
      mediaType,
      sourceName: message.document?.file_name?.trim() || null
    }
  }

  return null
}

const buildTelegramImageAttachment = async (
  settings: ReturnType<typeof readTelegramSettings>,
  message: TelegramMessage
) => {
  const target = resolveTelegramAttachmentTarget(message)
  if (!target) {
    return null
  }

  const fileMeta = await getTelegramFile({
    botToken: settings.botToken,
    fileId: target.fileId
  })
  const filePath = fileMeta.file_path?.trim() ?? ''
  if (!filePath) {
    throw new Error('Telegram image file path is missing.')
  }
  if ((fileMeta.file_size ?? 0) > TELEGRAM_MAX_IMAGE_BYTES) {
    throw new Error('Telegram image is too large to process (max 20MB).')
  }

  const payload = await downloadTelegramFile({
    botToken: settings.botToken,
    filePath
  })
  if (!payload.length) {
    throw new Error('Telegram image download returned empty payload.')
  }

  const uploadId = randomUUID()
  const directory = ensurePendingAttachmentsDirectory(uploadId)
  const fallbackName = `telegram-image-${message.message_id}${resolveTelegramImageExtension(filePath, target.mediaType)}`
  const filename = sanitizeTelegramFilename(target.sourceName || fallbackName)
  const filePathOnDisk = ensureUniqueTelegramAttachmentPath(directory, filename)
  await writeFile(filePathOnDisk, payload)

  return {
    uploadId,
    part: {
      type: 'file' as const,
      url: `file://${filePathOnDisk}`,
      filename: basename(filePathOnDisk),
      mediaType: target.mediaType
    }
  }
}

const toTelegramUserMessage = (message: TelegramMessage, input?: {
  imagePart?: {
    type: 'file'
    url: string
    filename: string
    mediaType: string
  } | null
}): CodexChatUserMessage => {
  const parts: CodexChatUserMessage['parts'] = []
  const userText = formatTelegramUserText(message)
  if (userText) {
    parts.push({
      type: 'text',
      text: userText
    })
  }
  if (input?.imagePart) {
    parts.push(input.imagePart)
  }

  return {
    id: `telegram-${message.chat.id}-${message.message_id}`,
    role: 'user',
    parts
  }
}

const isEventChunk = (chunk: unknown): chunk is UIMessageChunk & {
  type: 'data-codex-event'
  data: CodexThreadEventData
} =>
  typeof chunk === 'object'
  && chunk !== null
  && 'type' in chunk
  && chunk.type === 'data-codex-event'

const isItemChunk = (chunk: unknown): chunk is UIMessageChunk & {
  type: 'data-codex-item'
  data: CodexItemData
} =>
  typeof chunk === 'object'
  && chunk !== null
  && 'type' in chunk
  && chunk.type === CODEX_ITEM_PART

type TelegramWorkflowRun = {
  runId: string
  readable: ReadableStream<UIMessageChunk>
}

const getSummaryCodexEnv = () => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value
    }
  }
  env.CODEX_HOME = ensureAgentBootstrap()
  return env
}

const getSummaryCodex = () => {
  if (telegramSummaryCodex) {
    return telegramSummaryCodex
  }

  telegramSummaryCodex = createCodexClient({
    env: getSummaryCodexEnv(),
    config: {
      show_raw_agent_reasoning: true,
      approval_policy: 'never',
      sandbox_mode: 'danger-full-access'
    }
  })

  return telegramSummaryCodex
}

const formatTelegramReasoningSummary = (text: string) => {
  const normalized = truncate(text, 140)
  return normalized ? `Thinking: ${normalized}` : null
}

const formatTelegramItemSummary = (data: CodexItemData) => {
  switch (data.kind) {
    case 'command_execution': {
      const command = truncate(data.item.command ?? 'command', 120)
      return `Command ${data.item.status}: ${command}`
    }
    case 'mcp_tool_call': {
      const server = data.item.server?.trim() || 'mcp'
      const tool = data.item.tool?.trim() || 'tool'
      const status = data.item.status || 'completed'
      return `Tool ${status}: ${server}/${tool}`
    }
    case 'file_change': {
      const changes = data.item.changes ?? []
      const paths = changes
        .map(change => change?.path?.trim())
        .filter((value): value is string => Boolean(value))
        .slice(0, 3)
        .join(', ')
      const detail = paths ? ` (${truncate(paths, 120)})` : ''
      return `Files ${data.item.status}: ${changes.length} change(s)${detail}`
    }
    case 'subagent_activity': {
      const label = (() => {
        switch (data.item.action) {
          case 'spawnAgent':
            return 'Subagent spawn'
          case 'sendInput':
            return 'Subagent message'
          case 'resumeAgent':
            return 'Subagent resume'
          case 'wait':
            return 'Subagent wait'
          case 'closeAgent':
            return 'Subagent close'
          default:
            return 'Subagent activity'
        }
      })()
      const target = data.item.receiverThreadIds.length === 1
        ? (data.item.receiverThreadIds[0] ?? '')
        : `${data.item.receiverThreadIds.length} agents`
      return `${label} ${data.item.status}: ${truncate(target, 120)}`
    }
    case 'web_search':
      return `Web search: ${truncate(data.item.query ?? '', 140)}`
    case 'todo_list': {
      const total = data.item.items?.length ?? 0
      const completed = data.item.items?.filter(item => item?.completed).length ?? 0
      return `Todo updated: ${completed}/${total}`
    }
    case 'error':
      return `Error: ${truncate(data.item.message ?? '', 160)}`
    default:
      return null
  }
}

const renderTranscriptLineFromMessage = (message: CodexUIMessage) => {
  const role = message.role === 'assistant' ? 'Assistant' : 'User'
  const segments: string[] = []

  for (const part of message.parts ?? []) {
    if (part.type === 'text' && typeof part.text === 'string') {
      const text = truncate(part.text, 180)
      if (text) {
        segments.push(text)
      }
      continue
    }

    if (part.type === 'reasoning' && typeof part.text === 'string') {
      const summary = formatTelegramReasoningSummary(part.text)
      if (summary) {
        segments.push(summary)
      }
      continue
    }

    if (part.type === CODEX_ITEM_PART && typeof part.data === 'object' && part.data) {
      const summary = formatTelegramItemSummary(part.data as CodexItemData)
      if (summary) {
        segments.push(summary)
      }
    }
  }

  if (segments.length === 0) {
    return null
  }

  return `${role}: ${segments.join(' | ')}`
}

const buildCarryoverTranscript = (messages: CodexUIMessage[], lineLimit = 30) => {
  const lines = messages
    .map(renderTranscriptLineFromMessage)
    .filter((value): value is string => Boolean(value))

  return lines.slice(-lineLimit).join('\n')
}

const normalizeCarryoverSummary = (value: string) => {
  const lines = value
    .split('\n')
    .map(line => line.replace(/^[-*\d.\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, 10)
  if (lines.length === 0) {
    return ''
  }
  return lines.map(line => `- ${truncate(line, 180)}`).join('\n')
}

const generateTelegramSessionSummary = async (threadId: string) => {
  const messages = loadThreadMessages(threadId) ?? []
  if (messages.length === 0) {
    return null
  }

  const transcript = buildCarryoverTranscript(messages)
  if (!transcript) {
    return null
  }

  const prompt = [
    'Summarize this Telegram-origin Corazon thread for seamless continuation.',
    'Return at most 6 bullet lines.',
    'Keep only ongoing intent, relevant facts, recent decisions, unfinished work, and user preferences.',
    'Avoid quoting long passages or mentioning internal tooling unless it matters to the next turn.',
    '',
    transcript
  ].join('\n')

  const thread = getSummaryCodex().startThread({
    model: CARRYOVER_SUMMARY_MODEL,
    modelReasoningEffort: 'low',
    workingDirectory: CARRYOVER_WORKDIR,
    skipGitRepoCheck: true
  })
  const result = await thread.run(prompt)
  const summary = normalizeCarryoverSummary(result.finalResponse ?? '')
  return summary || null
}

const ensureTelegramSessionSummary = async (
  session: Pick<
    TelegramSession,
    'id' | 'threadId' | 'sessionSummary' | 'summaryUpdatedAt' | 'lastCompletedAt' | 'lastInboundAt'
  >
) => {
  const lastActivityAt = session.lastCompletedAt ?? session.lastInboundAt ?? null
  const summaryText = session.sessionSummary?.trim() ?? ''
  const summaryIsFresh = Boolean(summaryText)
    && lastActivityAt != null
    && session.summaryUpdatedAt != null
    && session.summaryUpdatedAt >= lastActivityAt

  if (summaryIsFresh) {
    return summaryText
  }

  if (!session.threadId) {
    return null
  }

  const summary = await generateTelegramSessionSummary(session.threadId)
  if (!summary) {
    return null
  }

  setTelegramSessionSummary({
    sessionId: session.id,
    summary
  })

  return summary
}

const refreshTelegramSessionSummary = async (sessionId: string) => {
  const session = getTelegramSessionById(sessionId)
  if (!session?.threadId) {
    return null
  }

  const summary = await generateTelegramSessionSummary(session.threadId)
  setTelegramSessionSummary({
    sessionId,
    summary
  })
  return summary
}

type TelegramRouteClassification = {
  decision: 'resume' | 'carryover' | 'new' | 'unsure'
  sessionId: string | null
  confidence: number | null
  reason: string
}

type TelegramRouteCandidate = {
  session: TelegramSession
  transcript: string
}

const normalizeTelegramRouteConfidence = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  return Math.max(0, Math.min(1, value))
}

const parseTelegramRouteClassification = (value: string): TelegramRouteClassification | null => {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  const match = trimmed.match(/\{[\s\S]*\}/)
  if (!match) {
    return null
  }

  try {
    const parsed = JSON.parse(match[0]) as {
      decision?: unknown
      sessionId?: unknown
      confidence?: unknown
      reason?: unknown
    }
    const decision = parsed.decision
    if (
      decision !== 'resume'
      && decision !== 'carryover'
      && decision !== 'new'
      && decision !== 'unsure'
    ) {
      return null
    }

    return {
      decision,
      sessionId: typeof parsed.sessionId === 'string' && parsed.sessionId.trim()
        ? parsed.sessionId.trim()
        : null,
      confidence: normalizeTelegramRouteConfidence(parsed.confidence),
      reason: typeof parsed.reason === 'string' && parsed.reason.trim()
        ? parsed.reason.trim()
        : ''
    }
  } catch {
    return null
  }
}

const classifyTelegramSessionRoute = async (input: {
  messageText: string
  candidates: TelegramRouteCandidate[]
}) => {
  if (input.candidates.length === 0) {
    return null
  }

  const candidatesText = input.candidates
    .map((candidate, index) => [
      `Candidate ${index + 1}`,
      `sessionId: ${candidate.session.id}`,
      `updatedAt: ${new Date(candidate.session.updatedAt).toISOString()}`,
      'recent transcript:',
      candidate.transcript
    ].join('\n'))
    .join('\n\n')

  try {
    const result = await runChatgptCodexTextResponse({
      model: CARRYOVER_ROUTE_MODEL,
      instructions: [
        'You route resumed Telegram conversations for Corazon.',
        'Compare the new user message against each candidate session transcript.',
        'Choose "resume" only when the new message clearly depends on the exact same prior context or unfinished work.',
        'Choose "carryover" when the message is probably related, but starting a fresh session with a prepended compact summary is safer than resuming the old session directly.',
        'Choose "new" when the message starts an unrelated topic.',
        'Reply with JSON only and no markdown.',
        'Schema:',
        '{"decision":"resume"|"carryover"|"new"|"unsure","sessionId":"<candidate session id or null>","confidence":0.0,"reason":"short explanation"}'
      ].join('\n'),
      input: createSimpleChatgptCodexInput([
        'New message:',
        input.messageText,
        '',
        candidatesText
      ].join('\n')),
      reasoningEffort: 'low'
    })
    return parseTelegramRouteClassification(result.outputText)
  } catch (error) {
    console.warn('[telegram] semantic route classification failed:', formatTelegramApiError(error))
    return null
  }
}

const resolveSemanticTelegramSessionRoute = async (input: {
  sessions: TelegramSession[]
  idleTimeoutMinutes: number
  messageText: string
  now?: number
}): Promise<TelegramSessionRouteDecision> => {
  const now = input.now ?? Date.now()
  const recentSessions = input.sessions
  const latestSession = recentSessions[0] ?? null

  if (!latestSession) {
    return {
      kind: 'new',
      reason: 'No previous Telegram session exists.'
    }
  }

  if (isTelegramSessionImmediatelyReusable(latestSession, input.idleTimeoutMinutes, now)) {
    return {
      kind: 'reuse',
      session: latestSession,
      reason: latestSession.activeRunId
        ? 'Latest Telegram session still has an active run.'
        : 'Latest Telegram session is still within the idle timeout.'
    }
  }

  const candidateSessions = recentSessions
    .filter(session => Boolean(session.threadId))
    .slice(0, TELEGRAM_ROUTE_CANDIDATE_LIMIT)

  const resolvedCandidates = candidateSessions
    .map((session) => {
      if (!session.threadId) {
        return null
      }

      const messages = loadThreadMessages(session.threadId) ?? []
      const transcript = buildCarryoverTranscript(messages, TELEGRAM_ROUTE_TRANSCRIPT_LINE_LIMIT)
      if (!transcript) {
        return null
      }

      return {
        session,
        transcript
      }
    })
    .filter((value): value is TelegramRouteCandidate => Boolean(value))

  const classification = await classifyTelegramSessionRoute({
    messageText: input.messageText,
    candidates: resolvedCandidates
  })

  const matchedCandidate = classification?.sessionId
    ? resolvedCandidates.find(candidate => candidate.session.id === classification.sessionId) ?? null
    : null
  const continuationHint = hasTelegramContinuationHint(input.messageText)

  if (
    classification?.decision === 'resume'
    && matchedCandidate
    && (classification.confidence ?? 0) >= TELEGRAM_RESUME_CONFIDENCE_THRESHOLD
  ) {
    return {
      kind: 'reuse',
      session: matchedCandidate.session,
      reason: classification.reason || 'Semantic routing matched the previous Telegram session.',
      confidence: classification.confidence
    }
  }

  if (
    (classification?.decision === 'carryover' || classification?.decision === 'resume')
    && matchedCandidate
    && (classification.confidence ?? 0) >= TELEGRAM_CARRYOVER_CONFIDENCE_THRESHOLD
  ) {
    return {
      kind: 'carryover',
      previousSession: matchedCandidate.session,
      reason: classification.reason || 'Semantic routing matched related prior context.',
      confidence: classification.confidence
    }
  }

  if (
    classification?.decision === 'new'
    && (classification.confidence ?? 0) >= TELEGRAM_NEW_CONFIDENCE_THRESHOLD
  ) {
    return {
      kind: 'new',
      reason: classification.reason || 'Semantic routing marked the message as a new topic.'
    }
  }

  if (continuationHint && latestSession.threadId) {
    return {
      kind: 'carryover',
      previousSession: latestSession,
      reason: 'Continuation wording suggests related context, but confidence was not high enough for direct resume.',
      confidence: classification?.confidence ?? null
    }
  }

  return {
    kind: 'new',
    reason: classification?.reason || 'Message did not confidently match a previous Telegram session.'
  }
}

const resolveSessionReplyToMessageId = (
  sessionId: string,
  fallbackReplyToMessageId?: number | null
) => {
  if (typeof fallbackReplyToMessageId !== 'number') {
    return null
  }

  return getTelegramSessionById(sessionId)?.lastInboundMessageId ?? fallbackReplyToMessageId
}

const isTelegramMessageNotModifiedError = (error: unknown) => {
  const message = formatTelegramApiError(error).toLowerCase()
  return message.includes('message is not modified')
}

const renderTelegramMessageContent = async (input: {
  text: string
  threadId: string | null
}) => {
  const html = await renderTelegramHtml(input.text, input.threadId)
  if (html) {
    return {
      text: html,
      parseMode: 'HTML' as const
    }
  }

  return {
    text: input.text
  }
}

const sendSessionTelegramMessage = async (input: {
  sessionId: string
  botToken: string
  chatId: string
  text: string
  fallbackReplyToMessageId?: number | null
  kind: string
}) => {
  const text = normalizeTelegramText(input.text)
  if (!text) {
    return null
  }
  const threadId = getTelegramSessionById(input.sessionId)?.threadId ?? null
  const content = await renderTelegramMessageContent({
    text,
    threadId
  })

  const result = await sendTelegramMessage({
    botToken: input.botToken,
    chatId: input.chatId,
    text: content.text,
    parseMode: content.parseMode,
    replyToMessageId: resolveSessionReplyToMessageId(input.sessionId, input.fallbackReplyToMessageId)
  })

  recordTelegramSessionOutbound({
    sessionId: input.sessionId,
    messageId: result.message_id,
    kind: input.kind
  })

  return result.message_id
}

const upsertSessionTelegramDraftMessage = async (input: {
  sessionId: string
  botToken: string
  chatId: string
  text: string
  fallbackReplyToMessageId?: number | null
  existingMessageId?: number | null
}) => {
  const text = normalizeTelegramText(input.text)
  if (!text) {
    return input.existingMessageId ?? null
  }
  const threadId = getTelegramSessionById(input.sessionId)?.threadId ?? null
  const content = await renderTelegramMessageContent({
    text,
    threadId
  })

  if (typeof input.existingMessageId === 'number') {
    try {
      await editTelegramMessageText({
        botToken: input.botToken,
        chatId: input.chatId,
        messageId: input.existingMessageId,
        text: content.text,
        parseMode: content.parseMode
      })
      return input.existingMessageId
    } catch (error) {
      if (isTelegramMessageNotModifiedError(error)) {
        return input.existingMessageId
      }
      console.warn('[telegram] draft edit failed, sending new message:', formatTelegramApiError(error))
    }
  }

  return sendSessionTelegramMessage({
    sessionId: input.sessionId,
    botToken: input.botToken,
    chatId: input.chatId,
    text,
    fallbackReplyToMessageId: input.fallbackReplyToMessageId,
    kind: 'text'
  })
}

const createTelegramTypingControllerInternal = (input: {
  botToken: string
  chatId: string
}) => {
  let active = false
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = () => {
    if (!timer) {
      return
    }
    clearTimeout(timer)
    timer = null
  }

  const scheduleNext = () => {
    if (!active || stopped) {
      return
    }

    clearTimer()
    timer = setTimeout(() => {
      void pulse()
    }, TELEGRAM_TYPING_REFRESH_MS)
  }

  const pulse = async () => {
    if (!active || stopped) {
      return
    }

    try {
      await sendTelegramChatAction({
        botToken: input.botToken,
        chatId: input.chatId,
        action: 'typing'
      })
    } catch (error) {
      console.error('[telegram] typing update failed:', formatTelegramApiError(error))
    } finally {
      scheduleNext()
    }
  }

  return {
    start() {
      if (stopped || active) {
        return
      }

      active = true
      void pulse()
    },
    stop() {
      active = false
      clearTimer()
    },
    dispose() {
      stopped = true
      active = false
      clearTimer()
    }
  }
}

const getTelegramTypingController = (input: {
  botToken: string
  chatId: string
}) => {
  const existing = telegramTypingControllers.get(input.chatId)
  if (existing) {
    return existing
  }

  const controller = createTelegramTypingControllerInternal(input)
  telegramTypingControllers.set(input.chatId, controller)
  return controller
}

const stopTelegramTypingController = (chatId: string) => {
  const existing = telegramTypingControllers.get(chatId)
  if (!existing) {
    return
  }

  existing.dispose()
  telegramTypingControllers.delete(chatId)
}

const releaseTelegramTypingController = (
  chatId: string,
  controller: ReturnType<typeof createTelegramTypingControllerInternal>
) => {
  const existing = telegramTypingControllers.get(chatId)
  if (existing === controller) {
    existing.dispose()
    telegramTypingControllers.delete(chatId)
    return
  }

  controller.dispose()
}

const resolveThreadRunOwnership = async (threadId: string | null, telegramOwnedRunId: string | null) => {
  if (!threadId) {
    return { kind: 'none' as const, runId: null }
  }

  const activeRunId = getThreadActiveRun(threadId)
  if (!activeRunId) {
    return { kind: 'none' as const, runId: null }
  }

  const stillRunning = await resolveActiveRunStillRunning(activeRunId)
  if (!stillRunning) {
    clearThreadActiveRun(threadId, activeRunId)
    return { kind: 'none' as const, runId: null }
  }

  if (telegramOwnedRunId && activeRunId === telegramOwnedRunId) {
    return { kind: 'telegram' as const, runId: activeRunId }
  }

  return { kind: 'other' as const, runId: activeRunId }
}

const processTelegramWorkflowRun = async (input: {
  run: TelegramWorkflowRun
  sessionId: string
  botToken: string
  chatId: string
  fallbackReplyToMessageId?: number | null
}) => {
  const reader = input.run.readable.getReader()
  const textBuffer = new Map<string, string>()
  const textDraftMessageIds = new Map<string, number>()
  const textDraftLastSentAt = new Map<string, number>()
  const textDraftLastSentText = new Map<string, string>()
  const clearTextDraftState = (textId: string) => {
    textDraftLastSentAt.delete(textId)
    textDraftLastSentText.delete(textId)
    textDraftMessageIds.delete(textId)
  }
  const typing = getTelegramTypingController({
    botToken: input.botToken,
    chatId: input.chatId
  })
  let turnCompleted = false
  let turnFailed = false

  try {
    typing.start()

    const flushTextDraft = async (textId: string, force: boolean) => {
      const rawText = textBuffer.get(textId) ?? ''
      const normalizedText = normalizeTelegramText(rawText)
      if (!normalizedText) {
        return
      }

      const lastSentText = textDraftLastSentText.get(textId) ?? ''
      if (lastSentText === normalizedText) {
        return
      }

      const now = Date.now()
      const lastSentAt = textDraftLastSentAt.get(textId) ?? 0
      if (!force && now - lastSentAt < TELEGRAM_DRAFT_UPDATE_MIN_INTERVAL_MS) {
        return
      }

      const messageId = await upsertSessionTelegramDraftMessage({
        sessionId: input.sessionId,
        botToken: input.botToken,
        chatId: input.chatId,
        text: normalizedText,
        fallbackReplyToMessageId: input.fallbackReplyToMessageId,
        existingMessageId: textDraftMessageIds.get(textId) ?? null
      })

      if (typeof messageId === 'number') {
        textDraftMessageIds.set(textId, messageId)
      }
      textDraftLastSentAt.set(textId, now)
      textDraftLastSentText.set(textId, normalizedText)
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      if (!value) {
        continue
      }

      if (isEventChunk(value) && value.data.kind === 'thread.started') {
        assignTelegramSessionThread(input.sessionId, value.data.threadId)
        setThreadOrigin(value.data.threadId, 'telegram', input.chatId)
        continue
      }

      if (isEventChunk(value) && value.data.kind === 'turn.completed') {
        turnCompleted = true
        typing.stop()
        continue
      }

      if (isEventChunk(value) && value.data.kind === 'turn.failed') {
        turnFailed = true
        typing.stop()
        const message = value.data.error?.message?.trim() || 'Telegram turn failed.'
        await sendSessionTelegramMessage({
          sessionId: input.sessionId,
          botToken: input.botToken,
          chatId: input.chatId,
          text: `Error: ${message}`,
          fallbackReplyToMessageId: input.fallbackReplyToMessageId,
          kind: 'error'
        })
        continue
      }

      if (value.type === 'error') {
        turnFailed = true
        typing.stop()
        const message = value.errorText?.trim() || 'Telegram turn failed.'
        await sendSessionTelegramMessage({
          sessionId: input.sessionId,
          botToken: input.botToken,
          chatId: input.chatId,
          text: `Error: ${message}`,
          fallbackReplyToMessageId: input.fallbackReplyToMessageId,
          kind: 'error'
        })
        continue
      }

      if (value.type === 'text-start') {
        textBuffer.set(value.id, '')
        clearTextDraftState(value.id)
        continue
      }

      if (value.type === 'text-delta') {
        const previous = textBuffer.get(value.id) ?? ''
        textBuffer.set(value.id, `${previous}${value.delta}`)
        typing.stop()
        await flushTextDraft(value.id, false)
        continue
      }

      if (value.type === 'text-end') {
        const text = (textBuffer.get(value.id) ?? '').trim()
        await flushTextDraft(value.id, true)
        if (text && !textDraftMessageIds.has(value.id)) {
          typing.stop()
          await sendSessionTelegramMessage({
            sessionId: input.sessionId,
            botToken: input.botToken,
            chatId: input.chatId,
            text,
            fallbackReplyToMessageId: input.fallbackReplyToMessageId,
            kind: 'text'
          })
        }
        textBuffer.delete(value.id)
        clearTextDraftState(value.id)
        continue
      }

      if (
        value.type === 'reasoning-start'
        || value.type === 'reasoning-delta'
        || value.type === 'reasoning-end'
      ) {
        typing.start()
        continue
      }

      if (isItemChunk(value)) {
        typing.start()
        continue
      }
    }

    typing.stop()
    finalizeTelegramSessionRun({
      sessionId: input.sessionId
    })
    if (turnCompleted && !turnFailed) {
      void refreshTelegramSessionSummary(input.sessionId).catch((error) => {
        console.error('[telegram] failed to refresh session summary:', formatTelegramApiError(error))
      })
    }
  } catch (error) {
    typing.stop()
    const message = formatTelegramApiError(error)
    finalizeTelegramSessionRun({
      sessionId: input.sessionId,
      errorMessage: message
    })
    try {
      await sendSessionTelegramMessage({
        sessionId: input.sessionId,
        botToken: input.botToken,
        chatId: input.chatId,
        text: `Error: ${message}`,
        fallbackReplyToMessageId: input.fallbackReplyToMessageId,
        kind: 'error'
      })
    } catch (sendError) {
      console.error('[telegram] failed to report run error:', sendError)
    }
  } finally {
    releaseTelegramTypingController(input.chatId, typing)
    reader.releaseLock()
  }
}

const resolveActiveRunStillRunning = async (runId: string) => {
  try {
    const status = await getRun(runId).status
    return status === 'running' || status === 'pending'
  } catch {
    return false
  }
}

const isMissingActiveTurnControlError = (message: string) =>
  message.includes('No active chat turn was found to control.')

const steerTelegramActiveRun = async (input: {
  runId: string
  threadId: string | null
  message: CodexChatUserMessage
}) => {
  let lastErrorMessage: string | null = null

  for (let attempt = 0; attempt < TELEGRAM_STEER_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await steerChatTurnControl({
        runId: input.runId,
        threadId: input.threadId,
        message: input.message
      })
      return { kind: 'steered' as const }
    } catch (error) {
      const errorMessage = formatTelegramApiError(error)
      lastErrorMessage = errorMessage
      if (!isMissingActiveTurnControlError(errorMessage)) {
        return {
          kind: 'error' as const,
          message: errorMessage
        }
      }

      if (attempt < TELEGRAM_STEER_RETRY_ATTEMPTS - 1) {
        await sleep(TELEGRAM_STEER_RETRY_MS)
      }
    }
  }

  const stillRunning = await resolveActiveRunStillRunning(input.runId)
  if (stillRunning) {
    return {
      kind: 'detached' as const,
      message: lastErrorMessage ?? 'No active chat turn was found to control.'
    }
  }

  return {
    kind: 'stale' as const,
    message: lastErrorMessage ?? 'No active chat turn was found to control.'
  }
}

const handleTelegramTextMessage = async (
  settings: ReturnType<typeof readTelegramSettings>,
  message: TelegramMessage
) => {
  const messageText = formatTelegramUserText(message)
  let imageAttachment: Awaited<ReturnType<typeof buildTelegramImageAttachment>> = null
  if (hasTelegramImageAttachment(message)) {
    try {
      imageAttachment = await buildTelegramImageAttachment(settings, message)
    } catch (error) {
      const failureMessage = `Image attachment could not be processed: ${formatTelegramApiError(error)}`
      await sendTelegramMessage({
        botToken: settings.botToken,
        chatId: settings.chatId,
        text: failureMessage,
        replyToMessageId: shouldReplyInTelegramChat(message) ? message.message_id : undefined
      })
    }
  }
  if (!messageText && !imageAttachment) {
    await handleUnsupportedTelegramMessage(settings, message)
    return
  }

  const recentSessions = loadRecentTelegramSessions(settings.chatId, TELEGRAM_ROUTE_CANDIDATE_LIMIT)
  const route = await resolveSemanticTelegramSessionRoute({
    sessions: recentSessions,
    idleTimeoutMinutes: settings.idleTimeoutMinutes,
    messageText: messageText || '[Image attachment]'
  })
  const userMessage = toTelegramUserMessage(message, {
    imagePart: imageAttachment?.part ?? null
  })
  const fallbackReplyToMessageId = shouldReplyInTelegramChat(message)
    ? message.message_id
    : null

  if (route.kind === 'reuse') {
    recordTelegramSessionInbound({
      sessionId: route.session.id,
      messageId: message.message_id
    })

    const ownership = await resolveThreadRunOwnership(route.session.threadId, route.session.activeRunId)
    if (ownership.kind === 'telegram' && ownership.runId) {
      const steerResult = await steerTelegramActiveRun({
        runId: ownership.runId,
        threadId: route.session.threadId,
        message: userMessage
      })

      if (steerResult.kind === 'steered') {
        return
      }

      if (steerResult.kind === 'error') {
        stopTelegramTypingController(settings.chatId)
        await sendSessionTelegramMessage({
          sessionId: route.session.id,
          botToken: settings.botToken,
          chatId: settings.chatId,
          text: `Busy: ${steerResult.message}`,
          fallbackReplyToMessageId,
          kind: 'error'
        })
        return
      }

      if (route.session.threadId) {
        deleteRuntimeThread(route.session.threadId)
        clearThreadActiveRun(route.session.threadId, ownership.runId)
      }
      deleteRuntimeTurnControl(ownership.runId)
      stopTelegramTypingController(settings.chatId)
      setTelegramSessionActiveRun(route.session.id, null)
    }

    if (ownership.kind === 'other') {
      stopTelegramTypingController(settings.chatId)
      await sendSessionTelegramMessage({
        sessionId: route.session.id,
        botToken: settings.botToken,
        chatId: settings.chatId,
        text: 'This thread is currently busy from the web. Wait for completion before sending a Telegram follow-up.',
        fallbackReplyToMessageId,
        kind: 'error'
      })
      return
    }
  }

  const carryoverSummary = route.kind === 'carryover'
    ? await ensureTelegramSessionSummary(route.previousSession)
    : null

  const session = route.kind === 'reuse'
    ? route.session
    : createTelegramSession({
        id: randomUUID(),
        chatId: settings.chatId,
        lastInboundMessageId: message.message_id,
        startedAt: Date.now(),
        lastInboundAt: Date.now(),
        carryoverSummary,
        resumedFromSessionId: route.kind === 'carryover' ? route.previousSession.id : null,
        resumeConfidence: route.kind === 'carryover' ? (route.confidence ?? null) : null,
        status: 'active'
      })

  if (!session) {
    throw new Error('Failed to create Telegram session.')
  }

  recordTelegramSessionInbound({
    sessionId: session.id,
    messageId: message.message_id
  })

  const existingMessages = session.threadId
    ? (loadThreadMessages(session.threadId) ?? [])
    : []
  const nextMessages = [...existingMessages, userMessage as unknown as CodexUIMessage]
  const harnessInstructions = carryoverSummary
    ? buildRecoveredConversationDeveloperInstructions(carryoverSummary)
    : null
  stopTelegramTypingController(settings.chatId)
  const run = await start(codexChatTurnWorkflow, [{
    threadId: session.threadId,
    resume: Boolean(session.threadId),
    attachmentUploadId: imageAttachment?.uploadId ?? null,
    origin: 'telegram',
    originChannelId: settings.chatId,
    streamMode: 'telegram',
    harnessInstructions,
    messages: nextMessages
  }])

  setTelegramSessionActiveRun(session.id, run.runId)

  void processTelegramWorkflowRun({
    run,
    sessionId: session.id,
    botToken: settings.botToken,
    chatId: settings.chatId,
    fallbackReplyToMessageId
  })
}

const handleUnsupportedTelegramMessage = async (
  settings: ReturnType<typeof readTelegramSettings>,
  message: TelegramMessage
) => {
  await sendTelegramMessage({
    botToken: settings.botToken,
    chatId: settings.chatId,
    text: 'Unsupported message type. Telegram transport currently supports text and image attachments.',
    replyToMessageId: shouldReplyInTelegramChat(message) ? message.message_id : undefined
  })
}

const processTelegramUpdate = async (
  settings: ReturnType<typeof readTelegramSettings>,
  update: TelegramUpdate
) => {
  const observedMessage = update.message ?? update.edited_message
  if (observedMessage && !isTelegramBotMessage(observedMessage)) {
    const candidate = toTelegramChatCandidateFromMessage(update.update_id, observedMessage)
    upsertTelegramRecentChat({
      chatId: candidate.chatId,
      type: candidate.type,
      title: candidate.title,
      subtitle: candidate.subtitle,
      lastMessageText: candidate.lastMessageText,
      lastMessageAt: candidate.lastMessageAt,
      lastUpdateId: candidate.updateId
    })
  }

  if (isTelegramEditedUpdate(update)) {
    return
  }

  const message = update.message
  if (!message) {
    return
  }

  if (normalizeChatId(message.chat.id) !== settings.chatId.trim()) {
    return
  }

  if (isTelegramBotMessage(message)) {
    return
  }

  await handleTelegramTextMessage(settings, message)
}

const enqueueTelegramUpdate = async (
  settings: ReturnType<typeof readTelegramSettings>,
  update: TelegramUpdate
) => {
  telegramProcessingQueue = telegramProcessingQueue
    .catch(() => {})
    .then(() => processTelegramUpdate(settings, update))

  await telegramProcessingQueue
}

const pollTelegramLoop = async () => {
  while (true) {
    const settings = readTelegramSettings()
    if (!settings.enabled) {
      await sleep(TELEGRAM_DISABLED_RETRY_MS)
      continue
    }

    const state = getTelegramTransportState(TELEGRAM_STATE_KEY)
    const startedAt = Date.now()
    upsertTelegramTransportState({
      key: TELEGRAM_STATE_KEY,
      lastUpdateId: state?.lastUpdateId ?? null,
      lastPollStartedAt: startedAt,
      lastPollSucceededAt: state?.lastPollSucceededAt ?? null,
      lastPollError: null,
      updatedAt: startedAt
    })

    try {
      const updates = await getTelegramUpdates(settings.botToken, {
        offset: state?.lastUpdateId != null ? state.lastUpdateId + 1 : undefined,
        timeoutSeconds: TELEGRAM_POLL_TIMEOUT_SECONDS
      })

      let lastUpdateId = state?.lastUpdateId ?? null
      for (const update of updates) {
        await enqueueTelegramUpdate(settings, update)
        lastUpdateId = update.update_id
        upsertTelegramTransportState({
          key: TELEGRAM_STATE_KEY,
          lastUpdateId,
          lastPollStartedAt: startedAt,
          lastPollSucceededAt: Date.now(),
          lastPollError: null,
          updatedAt: Date.now()
        })
      }

      upsertTelegramTransportState({
        key: TELEGRAM_STATE_KEY,
        lastUpdateId,
        lastPollStartedAt: startedAt,
        lastPollSucceededAt: Date.now(),
        lastPollError: null,
        updatedAt: Date.now()
      })
    } catch (error) {
      const message = formatTelegramApiError(error)
      console.error('[telegram] polling failed:', message)
      upsertTelegramTransportState({
        key: TELEGRAM_STATE_KEY,
        lastUpdateId: state?.lastUpdateId ?? null,
        lastPollStartedAt: startedAt,
        lastPollSucceededAt: state?.lastPollSucceededAt ?? null,
        lastPollError: message,
        updatedAt: Date.now()
      })
      await sleep(TELEGRAM_ERROR_RETRY_MS)
    }
  }
}

export const initializeTelegramTransport = () => {
  if (telegramTransportInitialized) {
    return
  }
  telegramTransportInitialized = true
  void pollTelegramLoop()
}
