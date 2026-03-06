type TelegramApiOk<T> = {
  ok: true
  result: T
}

type TelegramApiError = {
  ok: false
  description?: string
}

export type TelegramChat = {
  id: number
  type: string
}

export type TelegramUser = {
  id: number
  is_bot?: boolean
  first_name?: string
  last_name?: string
  username?: string
}

export type TelegramMessage = {
  message_id: number
  date?: number
  text?: string
  chat: TelegramChat
  from?: TelegramUser
}

export type TelegramUpdate = {
  update_id: number
  message?: TelegramMessage
  edited_message?: TelegramMessage
}

type TelegramSendMessageResult = {
  message_id: number
}

const TELEGRAM_API_BASE = 'https://api.telegram.org'

const toTelegramApiUrl = (botToken: string, method: string) =>
  `${TELEGRAM_API_BASE}/bot${encodeURIComponent(botToken)}/${method}`

const toErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const requestTelegramApi = async <T>(botToken: string, method: string, body: Record<string, unknown>) => {
  const response = await fetch(toTelegramApiUrl(botToken, method), {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  })

  const payload = await response.json() as TelegramApiOk<T> | TelegramApiError

  if (!response.ok || !payload || payload.ok !== true) {
    const description = !payload || payload.ok === true
      ? `Telegram API request failed: ${response.status}`
      : payload.description
    throw new Error(description || `Telegram API request failed: ${response.status}`)
  }

  return payload.result
}

export const getTelegramUpdates = async (
  botToken: string,
  options: {
    offset?: number
    timeoutSeconds?: number
  } = {}
) => {
  return requestTelegramApi<TelegramUpdate[]>(botToken, 'getUpdates', {
    offset: options.offset,
    timeout: options.timeoutSeconds ?? 20,
    allowed_updates: ['message', 'edited_message']
  })
}

export const sendTelegramMessage = async (input: {
  botToken: string
  chatId: string
  text: string
  replyToMessageId?: number | null
}) => {
  return requestTelegramApi<TelegramSendMessageResult>(input.botToken, 'sendMessage', {
    chat_id: input.chatId,
    text: input.text,
    reply_to_message_id: input.replyToMessageId ?? undefined,
    allow_sending_without_reply: true
  })
}

export const editTelegramMessageText = async (input: {
  botToken: string
  chatId: string
  messageId: number
  text: string
}) => {
  return requestTelegramApi<TelegramSendMessageResult>(input.botToken, 'editMessageText', {
    chat_id: input.chatId,
    message_id: input.messageId,
    text: input.text
  })
}

export const getTelegramDisplayName = (user?: TelegramUser | null) => {
  if (!user) {
    return null
  }

  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim()
  if (fullName) {
    return fullName
  }
  if (typeof user.username === 'string' && user.username.trim()) {
    return `@${user.username.trim()}`
  }
  return null
}

export const isTelegramBotMessage = (message?: TelegramMessage | null) =>
  message?.from?.is_bot === true

export const isTelegramEditedUpdate = (update: TelegramUpdate) =>
  typeof update.edited_message?.message_id === 'number'

export const formatTelegramApiError = (error: unknown) => toErrorMessage(error)
