import { randomUUID } from 'node:crypto'
import { start, getRun } from 'workflow/api'
import type { UIMessageChunk } from 'ai'
import type {
  CodexChatUserMessage,
  CodexUIMessage,
  CodexThreadEventData
} from '@@/types/chat-ui'
import { codexChatTurnWorkflow } from '../workflows/chat-turn'
import {
  assignTelegramSessionThread,
  createTelegramSession,
  finalizeTelegramSessionRun,
  getLatestTelegramSession,
  getTelegramTransportState,
  loadThreadMessages,
  recordTelegramSessionInbound,
  setTelegramSessionActiveRun,
  setThreadOrigin,
  upsertTelegramTransportState
} from './db.ts'
import { readTelegramSettings } from './settings-config.ts'
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

const TELEGRAM_POLL_TIMEOUT_SECONDS = 20
const TELEGRAM_DISABLED_RETRY_MS = 5000
const TELEGRAM_ERROR_RETRY_MS = 3000
const TELEGRAM_STATE_KEY = 'default'

let telegramTransportInitialized = false
let telegramProcessingQueue = Promise.resolve()

const sleep = async (ms: number) => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

const normalizeChatId = (value: string | number) => String(value).trim()

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

type TelegramWorkflowRun = {
  runId: string
  readable: ReadableStream<UIMessageChunk>
}

const processTelegramWorkflowRun = async (input: {
  run: TelegramWorkflowRun
  sessionId: string
  botToken: string
  chatId: string
  replyToMessageId: number
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
        await sendTelegramMessage({
          botToken: input.botToken,
          chatId: input.chatId,
          text: `Error: ${message}`,
          replyToMessageId: input.replyToMessageId
        })
        continue
      }

      if (value.type === 'error') {
        const message = value.errorText?.trim() || 'Telegram turn failed.'
        await sendTelegramMessage({
          botToken: input.botToken,
          chatId: input.chatId,
          text: `Error: ${message}`,
          replyToMessageId: input.replyToMessageId
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
        await sendTelegramMessage({
          botToken: input.botToken,
          chatId: input.chatId,
          text,
          replyToMessageId: input.replyToMessageId
        })
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
      await sendTelegramMessage({
        botToken: input.botToken,
        chatId: input.chatId,
        text: `Error: ${message}`,
        replyToMessageId: input.replyToMessageId
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

const handleTelegramTextMessage = async (settings: ReturnType<typeof readTelegramSettings>, message: TelegramMessage) => {
  const latestSession = getLatestTelegramSession(settings.chatId)
  const route = resolveTelegramSessionRoute(latestSession, settings.idleTimeoutMinutes)

  if (route.kind === 'reuse' && route.session.activeRunId) {
    const stillRunning = await resolveActiveRunStillRunning(route.session.activeRunId)
    if (stillRunning) {
      await sendTelegramMessage({
        botToken: settings.botToken,
        chatId: settings.chatId,
        text: 'A Telegram turn is already running. Wait for it to finish before sending the next message.',
        replyToMessageId: message.message_id
      })
      return
    }

    finalizeTelegramSessionRun({
      sessionId: route.session.id
    })
  }

  const session = route.kind === 'reuse'
    ? route.session
    : createTelegramSession({
        id: randomUUID(),
        chatId: settings.chatId,
        lastInboundMessageId: message.message_id,
        startedAt: Date.now(),
        lastInboundAt: Date.now()
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
  const userMessage = toTelegramUserMessage(message)
  const nextMessages = [...existingMessages, userMessage as unknown as CodexUIMessage]
  const run = await start(codexChatTurnWorkflow, [{
    threadId: session.threadId,
    resume: Boolean(session.threadId),
    messages: nextMessages
  }])

  setTelegramSessionActiveRun(session.id, run.runId)

  void processTelegramWorkflowRun({
    run,
    sessionId: session.id,
    botToken: settings.botToken,
    chatId: settings.chatId,
    replyToMessageId: message.message_id
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
    replyToMessageId: message.message_id
  })
}

const processTelegramUpdate = async (
  settings: ReturnType<typeof readTelegramSettings>,
  update: TelegramUpdate
) => {
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
