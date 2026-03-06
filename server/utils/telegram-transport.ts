import { randomUUID } from 'node:crypto'
import { start, getRun } from 'workflow/api'
import type { UIMessageChunk } from 'ai'
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
  finalizeTelegramSessionRun,
  getLatestTelegramSession,
  getTelegramSessionById,
  getTelegramTransportState,
  getThreadActiveRun,
  loadThreadMessages,
  recordTelegramSessionInbound,
  recordTelegramSessionOutbound,
  setTelegramSessionActiveRun,
  setThreadOrigin,
  upsertTelegramRecentChat,
  upsertTelegramTransportState
} from './db.ts'
import { readTelegramSettings } from './settings-config.ts'
import { toTelegramChatCandidateFromMessage } from './telegram-chat-discovery.ts'
import { resolveTelegramSessionRoute } from './telegram-session.ts'
import {
  formatTelegramApiError,
  getTelegramDisplayName,
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

const TELEGRAM_POLL_TIMEOUT_SECONDS = 20
const TELEGRAM_DISABLED_RETRY_MS = 5000
const TELEGRAM_ERROR_RETRY_MS = 3000
const TELEGRAM_STATE_KEY = 'default'
const TELEGRAM_TEXT_MAX_LENGTH = 3500
const TELEGRAM_STEER_RETRY_ATTEMPTS = 5
const TELEGRAM_STEER_RETRY_MS = 300
const CARRYOVER_MODEL = 'gpt-5.1-codex-mini'
const CARRYOVER_WORKDIR = '/tmp'

let telegramTransportInitialized = false
let telegramProcessingQueue = Promise.resolve()
let telegramSummaryCodex: CodexClient | null = null

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

const renderTelegramHtml = (value: string) => {
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
  const text = message.text?.trim() ?? ''
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

const toTelegramUserMessage = (message: TelegramMessage): CodexChatUserMessage => {
  return {
    id: `telegram-${message.chat.id}-${message.message_id}`,
    role: 'user',
    parts: [{
      type: 'text',
      text: formatTelegramUserText(message)
    }]
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

const buildCarryoverTranscript = (messages: CodexUIMessage[]) => {
  const lines = messages
    .map(renderTranscriptLineFromMessage)
    .filter((value): value is string => Boolean(value))

  return lines.slice(-30).join('\n')
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

const buildCarryoverInputPrefix = (summary: string) => {
  return [
    '[Telegram session carry-over]',
    'Continue the conversation naturally using this compact context from the previous Telegram thread.',
    'Do not mention that this summary was injected unless the user asks.',
    summary
  ].join('\n')
}

const generateCarryoverSummary = async (threadId: string) => {
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
    model: CARRYOVER_MODEL,
    modelReasoningEffort: 'low',
    workingDirectory: CARRYOVER_WORKDIR,
    skipGitRepoCheck: true
  })
  const result = await thread.run(prompt)
  const summary = normalizeCarryoverSummary(result.finalResponse ?? '')
  return summary || null
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

  const result = await sendTelegramMessage({
    botToken: input.botToken,
    chatId: input.chatId,
    text: renderTelegramHtml(text),
    parseMode: 'HTML',
    replyToMessageId: resolveSessionReplyToMessageId(input.sessionId, input.fallbackReplyToMessageId)
  })

  recordTelegramSessionOutbound({
    sessionId: input.sessionId,
    messageId: result.message_id,
    kind: input.kind
  })

  return result.message_id
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

  try {
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

      if (isEventChunk(value) && value.data.kind === 'turn.failed') {
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
        continue
      }

      if (value.type === 'text-delta') {
        const previous = textBuffer.get(value.id) ?? ''
        textBuffer.set(value.id, `${previous}${value.delta}`)
        continue
      }

      if (value.type === 'text-end') {
        const text = (textBuffer.get(value.id) ?? '').trim()
        textBuffer.delete(value.id)
        if (!text) {
          continue
        }
        await sendSessionTelegramMessage({
          sessionId: input.sessionId,
          botToken: input.botToken,
          chatId: input.chatId,
          text,
          fallbackReplyToMessageId: input.fallbackReplyToMessageId,
          kind: 'text'
        })
        continue
      }

      if (
        value.type === 'reasoning-start'
        || value.type === 'reasoning-delta'
        || value.type === 'reasoning-end'
      ) {
        continue
      }

      if (isItemChunk(value)) {
        continue
      }
    }

    finalizeTelegramSessionRun({
      sessionId: input.sessionId
    })
  } catch (error) {
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
  const latestSession = getLatestTelegramSession(settings.chatId)
  const route = resolveTelegramSessionRoute(latestSession, settings.idleTimeoutMinutes)
  const userMessage = toTelegramUserMessage(message)
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
        clearThreadActiveRun(route.session.threadId, ownership.runId)
      }
      setTelegramSessionActiveRun(route.session.id, null)
    }

    if (ownership.kind === 'other') {
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

  const carryoverSummary = route.kind === 'rollover' && route.previousSession.threadId
    ? await generateCarryoverSummary(route.previousSession.threadId)
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
  const inputPrefix = carryoverSummary ? buildCarryoverInputPrefix(carryoverSummary) : null
  const run = await start(codexChatTurnWorkflow, [{
    threadId: session.threadId,
    resume: Boolean(session.threadId),
    origin: 'telegram',
    originChannelId: settings.chatId,
    streamMode: 'telegram',
    inputPrefix,
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
    text: 'Text messages only are supported in Telegram transport v1.',
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

  if (!message.text?.trim()) {
    await handleUnsupportedTelegramMessage(settings, message)
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
