import { request as httpsRequest } from 'node:https'

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
  title?: string
  username?: string
  first_name?: string
  last_name?: string
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
  caption?: string
  photo?: TelegramPhotoSize[]
  document?: TelegramDocument
  chat: TelegramChat
  from?: TelegramUser
}

export type TelegramPhotoSize = {
  file_id: string
  file_unique_id: string
  width: number
  height: number
  file_size?: number
}

export type TelegramDocument = {
  file_id: string
  file_unique_id: string
  file_name?: string
  mime_type?: string
  file_size?: number
}

export type TelegramUpdate = {
  update_id: number
  message?: TelegramMessage
  edited_message?: TelegramMessage
}

type TelegramSendMessageResult = {
  message_id: number
}

type TelegramBooleanResult = true
type TelegramFileResult = {
  file_id: string
  file_unique_id: string
  file_size?: number
  file_path?: string
}

const TELEGRAM_API_BASE = 'https://api.telegram.org'
const TELEGRAM_FILE_DOWNLOAD_MAX_REDIRECTS = 3
const TELEGRAM_FILE_REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308])
const TELEGRAM_DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const TELEGRAM_LONG_POLL_GRACE_MS = 10_000

const toTelegramApiUrl = (botToken: string, method: string) =>
  `${TELEGRAM_API_BASE}/bot${encodeURIComponent(botToken)}/${method}`

const toTelegramFileUrl = (botToken: string, filePath: string) =>
  `${TELEGRAM_API_BASE}/file/bot${encodeURIComponent(botToken)}/${filePath.replace(/^\/+/, '')}`

const toErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const resolveTelegramRequestTimeoutMs = (timeoutSeconds?: number) =>
  Math.max(
    TELEGRAM_DEFAULT_REQUEST_TIMEOUT_MS,
    ((timeoutSeconds ?? 0) * 1000) + TELEGRAM_LONG_POLL_GRACE_MS
  )

const requestTelegramApiRaw = (input: {
  botToken: string
  method: string
  httpMethod?: 'GET' | 'POST'
  params?: Record<string, unknown>
  body?: Record<string, unknown>
  timeoutMs?: number
}) =>
  new Promise<{ statusCode: number, raw: string }>((resolve, reject) => {
    const url = new URL(toTelegramApiUrl(input.botToken, input.method))
    for (const [key, value] of Object.entries(input.params ?? {})) {
      if (value == null) {
        continue
      }
      url.searchParams.set(key, String(value))
    }
    const payload = input.httpMethod === 'GET' ? null : JSON.stringify(input.body ?? {})
    const timeoutMs = input.timeoutMs ?? TELEGRAM_DEFAULT_REQUEST_TIMEOUT_MS
    const request = httpsRequest({
      protocol: url.protocol,
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      method: input.httpMethod ?? 'POST',
      family: 4,
      headers: {
        ...(payload
          ? {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload)
            }
          : {})
      }
    }, (response) => {
      let raw = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        raw += chunk
      })
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode ?? 500,
          raw
        })
      })
    })

    const absoluteTimeout = setTimeout(() => {
      request.destroy(new Error(`Telegram API request timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    const clearAbsoluteTimeout = () => {
      clearTimeout(absoluteTimeout)
    }

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('Telegram API request timed out'))
    })
    request.on('error', (error) => {
      clearAbsoluteTimeout()
      reject(error)
    })
    request.on('close', clearAbsoluteTimeout)
    if (payload) {
      request.write(payload)
    }
    request.end()
  })

const requestTelegramApi = async <T>(input: {
  botToken: string
  method: string
  httpMethod?: 'GET' | 'POST'
  params?: Record<string, unknown>
  body?: Record<string, unknown>
  timeoutMs?: number
}) => {
  const { statusCode, raw } = await requestTelegramApiRaw(input)
  const payload = JSON.parse(raw) as TelegramApiOk<T> | TelegramApiError

  if (statusCode >= 400 || !payload || payload.ok !== true) {
    const description = !payload || payload.ok === true
      ? `Telegram API request failed: ${statusCode}`
      : payload.description
    throw new Error(description || `Telegram API request failed: ${statusCode}`)
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
  const allowedUpdates = JSON.stringify(['message', 'edited_message'])
  return requestTelegramApi<TelegramUpdate[]>({
    botToken,
    method: 'getUpdates',
    httpMethod: 'GET',
    params: {
      offset: options.offset,
      timeout: options.timeoutSeconds ?? 20,
      allowed_updates: allowedUpdates
    },
    timeoutMs: resolveTelegramRequestTimeoutMs(options.timeoutSeconds ?? 20)
  })
}

export const getTelegramFile = async (input: {
  botToken: string
  fileId: string
}) => {
  return requestTelegramApi<TelegramFileResult>({
    botToken: input.botToken,
    method: 'getFile',
    body: {
      file_id: input.fileId
    }
  })
}

export const downloadTelegramFile = async (input: {
  botToken: string
  filePath: string
  maxBytes?: number
  timeoutMs?: number
}) => {
  const maxBytes = typeof input.maxBytes === 'number' && input.maxBytes > 0
    ? input.maxBytes
    : null
  const timeoutMs = input.timeoutMs ?? TELEGRAM_DEFAULT_REQUEST_TIMEOUT_MS
  const downloadFromUrl = (url: URL, redirectCount: number): Promise<Buffer> =>
    new Promise<Buffer>((resolve, reject) => {
      let settled = false
      const resolveOnce = (value: Buffer | PromiseLike<Buffer>) => {
        if (settled) {
          return
        }
        settled = true
        resolve(value)
      }
      const rejectOnce = (error: Error) => {
        if (settled) {
          return
        }
        settled = true
        reject(error)
      }
      const request = httpsRequest({
        protocol: url.protocol,
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        family: 4
      }, (response) => {
        const statusCode = response.statusCode ?? 500
        const locationHeader = response.headers.location
        const redirectLocation = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader

        if (TELEGRAM_FILE_REDIRECT_STATUS_CODES.has(statusCode)) {
          response.resume()
          if (!redirectLocation) {
            rejectOnce(new Error(`Telegram file download redirect missing location: ${statusCode}`))
            return
          }
          if (redirectCount >= TELEGRAM_FILE_DOWNLOAD_MAX_REDIRECTS) {
            rejectOnce(new Error(`Telegram file download exceeded redirect limit (${TELEGRAM_FILE_DOWNLOAD_MAX_REDIRECTS})`))
            return
          }
          let nextUrl: URL
          try {
            nextUrl = new URL(redirectLocation, url)
          } catch {
            rejectOnce(new Error(`Telegram file download redirect has invalid location: ${redirectLocation}`))
            return
          }
          resolveOnce(downloadFromUrl(nextUrl, redirectCount + 1))
          return
        }

        if (statusCode >= 400) {
          rejectOnce(new Error(`Telegram file download failed: ${statusCode}`))
          response.resume()
          return
        }
        if (statusCode < 200 || statusCode >= 300) {
          rejectOnce(new Error(`Telegram file download returned unexpected status: ${statusCode}`))
          response.resume()
          return
        }

        const chunks: Buffer[] = []
        let totalBytes = 0
        response.on('data', (chunk: Buffer | string) => {
          if (settled) {
            return
          }
          const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          totalBytes += bufferChunk.length
          if (maxBytes !== null && totalBytes > maxBytes) {
            response.resume()
            rejectOnce(new Error(`Telegram file download exceeded max bytes (${maxBytes})`))
            request.destroy()
            return
          }
          chunks.push(bufferChunk)
        })
        response.on('end', () => {
          resolveOnce(Buffer.concat(chunks))
        })
      })

      const absoluteTimeout = setTimeout(() => {
        request.destroy(new Error(`Telegram file download timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const clearAbsoluteTimeout = () => {
        clearTimeout(absoluteTimeout)
      }

      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error('Telegram file download timed out'))
      })
      request.on('error', (error) => {
        clearAbsoluteTimeout()
        rejectOnce(error)
      })
      request.on('close', clearAbsoluteTimeout)
      request.end()
    })

  const url = new URL(toTelegramFileUrl(input.botToken, input.filePath))
  return downloadFromUrl(url, 0)
}

export const sendTelegramMessage = async (input: {
  botToken: string
  chatId: string
  text: string
  parseMode?: 'HTML' | 'MarkdownV2'
  disableWebPagePreview?: boolean
  replyToMessageId?: number | null
}) => {
  return requestTelegramApi<TelegramSendMessageResult>({
    botToken: input.botToken,
    method: 'sendMessage',
    body: {
      chat_id: input.chatId,
      text: input.text,
      parse_mode: input.parseMode ?? undefined,
      disable_web_page_preview: input.disableWebPagePreview ?? true,
      reply_to_message_id: input.replyToMessageId ?? undefined,
      allow_sending_without_reply: true
    }
  })
}

export const sendTelegramChatAction = async (input: {
  botToken: string
  chatId: string
  action: 'typing'
}) => {
  return requestTelegramApi<TelegramBooleanResult>({
    botToken: input.botToken,
    method: 'sendChatAction',
    body: {
      chat_id: input.chatId,
      action: input.action
    }
  })
}

export const editTelegramMessageText = async (input: {
  botToken: string
  chatId: string
  messageId: number
  text: string
  parseMode?: 'HTML' | 'MarkdownV2'
  disableWebPagePreview?: boolean
}) => {
  return requestTelegramApi<TelegramSendMessageResult>({
    botToken: input.botToken,
    method: 'editMessageText',
    body: {
      chat_id: input.chatId,
      message_id: input.messageId,
      text: input.text,
      parse_mode: input.parseMode ?? undefined,
      disable_web_page_preview: input.disableWebPagePreview ?? true
    }
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
