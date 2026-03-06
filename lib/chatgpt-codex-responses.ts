import { request as httpsRequest } from 'node:https'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureAgentBootstrap } from '../server/utils/agent-bootstrap.ts'

const CHATGPT_CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
const CHATGPT_CODEX_COMPACT_URL = 'https://chatgpt.com/backend-api/codex/responses/compact'
const CHATGPT_RESPONSES_TIMEOUT_MS = 60_000

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
type JsonObject = { [key: string]: JsonValue }

export type ChatgptCodexTextVerbosity = 'low' | 'medium' | 'high'
export type ChatgptCodexReasoningEffort = 'low' | 'medium' | 'high'

export type ChatgptCodexInputTextPart = {
  type: 'input_text'
  text: string
}

export type ChatgptCodexOutputTextPart = {
  type: 'output_text'
  text: string
}

export type ChatgptCodexMessageContentPart = ChatgptCodexInputTextPart
  | ChatgptCodexOutputTextPart

export type ChatgptCodexInputMessage = {
  type: 'message'
  role: 'user' | 'assistant' | 'system'
  content: ChatgptCodexMessageContentPart[]
}

export type ChatgptCodexOpaqueInputItem = JsonObject & {
  type: string
}

export type ChatgptCodexInputItem = ChatgptCodexInputMessage
  | ChatgptCodexOpaqueInputItem

export type ChatgptCodexResponsesRequest = {
  model: string
  instructions: string
  input: ChatgptCodexInputItem[]
  authPath?: string
  reasoningEffort?: ChatgptCodexReasoningEffort
  textVerbosity?: ChatgptCodexTextVerbosity
}

export type ChatgptCodexCompactRequest = {
  model: string
  instructions: string
  input: ChatgptCodexInputItem[]
  authPath?: string
}

export type ChatgptCodexSseEvent = {
  event: string
  data: JsonValue | string | null
  receivedAt: number
}

export type ChatgptCodexTextResponse = {
  responseId: string | null
  outputText: string
  events: ChatgptCodexSseEvent[]
  startedAt: number
  completedAt: number
  firstEventAt: number | null
  firstTextAt: number | null
}

export type ChatgptCodexCompactionResponse = {
  id: string
  object: 'response.compaction'
  createdAt: number
  output: ChatgptCodexInputItem[]
  usage: JsonObject | null
}

const toErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const getDefaultAuthPath = () => join(ensureAgentBootstrap(), 'auth.json')

const readChatgptAccessToken = (authPath = getDefaultAuthPath()) => {
  // ChatGPT-authenticated Codex requests reuse the ChatGPT session token stored in auth.json.
  // The private endpoint accepted Bearer auth with tokens.access_token during local verification.
  const raw = readFileSync(authPath, 'utf8')
  const parsed = JSON.parse(raw) as {
    tokens?: {
      access_token?: unknown
    }
  }
  const accessToken = parsed.tokens?.access_token
  if (typeof accessToken !== 'string' || !accessToken.trim()) {
    throw new Error(`Missing tokens.access_token in ${authPath}`)
  }
  return accessToken.trim()
}

const requestChatgptCodexJson = async <T>(input: {
  url: string
  payload: JsonObject
  authPath?: string
}) => {
  const accessToken = readChatgptAccessToken(input.authPath)
  const url = new URL(input.url)
  const payload = JSON.stringify(input.payload)

  return new Promise<T>((resolve, reject) => {
    const request = httpsRequest({
      protocol: url.protocol,
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      family: 4,
      headers: {
        'authorization': `Bearer ${accessToken}`,
        'accept': 'application/json',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    }, (response) => {
      let raw = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        raw += chunk
      })
      response.on('end', () => {
        const statusCode = response.statusCode ?? 500
        if (statusCode >= 400) {
          reject(new Error(`ChatGPT Codex request failed (${statusCode}): ${raw}`))
          return
        }

        try {
          resolve(JSON.parse(raw) as T)
        } catch (error) {
          reject(new Error(`Failed to parse ChatGPT Codex JSON response: ${toErrorMessage(error)}`))
        }
      })
    })

    request.setTimeout(CHATGPT_RESPONSES_TIMEOUT_MS, () => {
      request.destroy(new Error('ChatGPT Codex request timed out'))
    })
    request.on('error', reject)
    request.write(payload)
    request.end()
  })
}

const buildChatgptCodexPayload = (input: ChatgptCodexResponsesRequest) => ({
  // This private endpoint is stricter than the public Responses API.
  // Current observed requirements:
  // - instructions must be present
  // - input must be a message list
  // - store must be false
  // - stream must be true
  // We also omit optional fields unless explicitly requested because some models reject
  // otherwise-valid public API parameters such as metadata or low text verbosity.
  model: input.model,
  instructions: input.instructions,
  input: input.input,
  ...(input.reasoningEffort
    ? {
        reasoning: {
          effort: input.reasoningEffort
        }
      }
    : {}),
  ...(input.textVerbosity
    ? {
        text: {
          format: {
            type: 'text'
          },
          verbosity: input.textVerbosity
        }
      }
    : {}),
  store: false,
  stream: true
})

const buildChatgptCodexCompactPayload = (input: ChatgptCodexCompactRequest) => ({
  // Mirrors the standalone compaction flow in the public guide:
  // send the current input window and receive the canonical compacted window
  // to pass into the next /responses call as-is.
  model: input.model,
  instructions: input.instructions,
  input: input.input
})

const parseSseData = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  try {
    return JSON.parse(trimmed) as JsonValue
  } catch {
    return trimmed
  }
}

const parseSseChunk = (rawEvent: string): ChatgptCodexSseEvent | null => {
  const lines = rawEvent
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(Boolean)

  if (lines.length === 0) {
    return null
  }

  let event = 'message'
  const dataLines: string[] = []

  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim() || event
      continue
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart())
    }
  }

  return {
    event,
    data: parseSseData(dataLines.join('\n')),
    receivedAt: Date.now()
  }
}

const requestChatgptCodexResponseStream = (input: ChatgptCodexResponsesRequest) =>
  new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    const accessToken = readChatgptAccessToken(input.authPath)
    const url = new URL(CHATGPT_CODEX_RESPONSES_URL)
    const payload = JSON.stringify(buildChatgptCodexPayload(input))
    // Force SSE because the endpoint currently rejects stream=false.
    const request = httpsRequest({
      protocol: url.protocol,
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      family: 4,
      headers: {
        'authorization': `Bearer ${accessToken}`,
        'accept': 'text/event-stream',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    }, (response) => {
      const statusCode = response.statusCode ?? 500
      if (statusCode >= 400) {
        let raw = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          raw += chunk
        })
        response.on('end', () => {
          reject(new Error(`ChatGPT Codex responses request failed (${statusCode}): ${raw}`))
        })
        return
      }

      resolve(response)
    })

    request.setTimeout(CHATGPT_RESPONSES_TIMEOUT_MS, () => {
      request.destroy(new Error('ChatGPT Codex responses request timed out'))
    })
    request.on('error', reject)
    request.write(payload)
    request.end()
  })

export async function* streamChatgptCodexResponse(
  input: ChatgptCodexResponsesRequest
): AsyncGenerator<ChatgptCodexSseEvent> {
  const response = await requestChatgptCodexResponseStream(input)
  response.setEncoding('utf8')

  // Consume the raw SSE stream directly so callers can keep this helper lightweight
  // and avoid the heavier Codex harness / app-server stack for simple text turns.
  let buffer = ''
  try {
    for await (const chunk of response) {
      buffer += chunk

      while (true) {
        const separatorIndex = buffer.indexOf('\n\n')
        if (separatorIndex === -1) {
          break
        }

        const rawEvent = buffer.slice(0, separatorIndex)
        buffer = buffer.slice(separatorIndex + 2)

        const parsed = parseSseChunk(rawEvent)
        if (!parsed) {
          continue
        }

        yield parsed

        if (parsed.event === 'done' || parsed.data === '[DONE]') {
          return
        }
      }
    }

    if (buffer.trim()) {
      const parsed = parseSseChunk(buffer)
      if (parsed) {
        yield parsed
      }
    }
  } finally {
    response.destroy()
  }
}

export const compactChatgptCodexInputWindow = async (
  input: ChatgptCodexCompactRequest
): Promise<ChatgptCodexCompactionResponse> => {
  // The compact endpoint returns an opaque next context window. Do not try to interpret
  // or prune it here; callers should pass output straight into the next /responses call.
  const response = await requestChatgptCodexJson<{
    id?: unknown
    object?: unknown
    created_at?: unknown
    output?: unknown
    usage?: unknown
  }>({
    url: CHATGPT_CODEX_COMPACT_URL,
    payload: buildChatgptCodexCompactPayload(input),
    authPath: input.authPath
  })

  if (
    typeof response.id !== 'string'
    || response.object !== 'response.compaction'
    || typeof response.created_at !== 'number'
    || !Array.isArray(response.output)
  ) {
    throw new Error('Unexpected ChatGPT Codex compaction response shape.')
  }

  return {
    id: response.id,
    object: 'response.compaction',
    createdAt: response.created_at,
    output: response.output as ChatgptCodexInputItem[],
    usage: response.usage && typeof response.usage === 'object' && !Array.isArray(response.usage)
      ? response.usage as JsonObject
      : null
  }
}

const extractResponseId = (value: JsonValue | string | null) => {
  if (!value || typeof value === 'string' || Array.isArray(value)) {
    return null
  }

  const candidate = value as {
    response?: {
      id?: unknown
    }
  }
  const responseId = candidate.response?.id
  return typeof responseId === 'string' ? responseId : null
}

const extractOutputTextDelta = (event: ChatgptCodexSseEvent) => {
  // For the lightweight text helper we only assemble assistant text deltas.
  // Tool calls and richer output item shapes are intentionally left to higher-level clients.
  if (event.event !== 'response.output_text.delta') {
    return null
  }
  if (!event.data || typeof event.data === 'string' || Array.isArray(event.data)) {
    return null
  }

  const delta = (event.data as { delta?: unknown }).delta
  return typeof delta === 'string' ? delta : null
}

export const runChatgptCodexTextResponse = async (
  input: ChatgptCodexResponsesRequest
): Promise<ChatgptCodexTextResponse> => {
  // This helper intentionally returns the full event list plus the stitched text response.
  // The timing fields make it easy to compare "simple private responses" against the
  // existing harnessed Codex path when evaluating latency improvements.
  const startedAt = Date.now()
  const events: ChatgptCodexSseEvent[] = []
  let responseId: string | null = null
  let outputText = ''
  let firstEventAt: number | null = null
  let firstTextAt: number | null = null

  for await (const event of streamChatgptCodexResponse(input)) {
    events.push(event)

    if (firstEventAt == null) {
      firstEventAt = event.receivedAt
    }

    if (responseId == null) {
      responseId = extractResponseId(event.data)
    }

    const delta = extractOutputTextDelta(event)
    if (delta) {
      outputText += delta
      if (firstTextAt == null) {
        firstTextAt = event.receivedAt
      }
    }
  }

  return {
    responseId,
    outputText,
    events,
    startedAt,
    completedAt: Date.now(),
    firstEventAt,
    firstTextAt
  }
}

export const formatChatgptCodexResponsesError = (error: unknown) => toErrorMessage(error)

export const createSimpleChatgptCodexInput = (text: string): ChatgptCodexInputMessage[] => [{
  type: 'message',
  role: 'user',
  content: [{
    type: 'input_text',
    text
  }]
}]

export const createSimpleChatgptCodexAssistantOutput = (text: string): ChatgptCodexInputMessage => ({
  type: 'message',
  role: 'assistant',
  content: [{
    type: 'output_text',
    text
  }]
})
