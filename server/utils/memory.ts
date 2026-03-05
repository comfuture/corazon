import type { CodexUIMessage } from '../../types/chat-ui.ts'
import {
  parseChromaConnectionUrl,
  registerMem0ChromadbProvider
} from './mem0-chromadb-store.ts'

const DEFAULT_MEMORY_USER_ID = 'corazon-shared'
const DEFAULT_SEARCH_LIMIT = 5
const MAX_SEARCH_LIMIT = 50
const DEFAULT_CHROMA_COLLECTION_NAME = 'mem0'
const DEFAULT_CHROMA_URL = 'http://127.0.0.1:8000'
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small'
const DEFAULT_LLM_MODEL = 'gpt-4o-mini'

type Mem0Message = {
  role: string
  content: string
}

type Mem0SearchResponse = {
  results?: unknown[]
}

type Mem0Engine = {
  add: (messages: Mem0Message[] | string, config: Record<string, unknown>) => Promise<Mem0SearchResponse>
  search: (query: string, config: Record<string, unknown>) => Promise<Mem0SearchResponse>
}

type MemoryRecordInput = {
  id?: unknown
  memory?: unknown
  data?: {
    memory?: unknown
  } | null
  score?: unknown
  metadata?: unknown
  createdAt?: unknown
  updatedAt?: unknown
  created_at?: unknown
  updated_at?: unknown
}

export type OpenAICompatMessageRole = 'system' | 'user' | 'assistant'

export type OpenAICompatMessage = {
  role: OpenAICompatMessageRole
  content: string
}

export type MemoryRecord = {
  id: string | null
  memory: string
  score: number | null
  metadata: Record<string, unknown> | null
  createdAt: string | null
  updatedAt: string | null
}

export type MemorySearchInput = {
  query: string
  limit?: number
  userId?: string | null
  filters?: Record<string, unknown>
}

export type RememberMessagesInput = {
  messages: OpenAICompatMessage[]
  userId?: string | null
  metadata?: Record<string, unknown>
}

export type RememberTextInput = {
  text: string
  userId?: string | null
  metadata?: Record<string, unknown>
}

export type RememberCodexMessagesInput = {
  messages: CodexUIMessage[]
  userId?: string | null
  metadata?: Record<string, unknown>
}

export type MemoryUpsertResult = {
  memories: MemoryRecord[]
  messageCount: number
}

let memoryEnginePromise: Promise<Mem0Engine> | null = null

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isMemoryRole = (value: unknown): value is OpenAICompatMessageRole =>
  value === 'user' || value === 'assistant' || value === 'system'

const normalizeText = (value: unknown) =>
  typeof value === 'string' ? value.trim() : ''

const clampSearchLimit = (value: unknown) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return DEFAULT_SEARCH_LIMIT
  }
  const rounded = Math.floor(parsed)
  if (rounded < 1) {
    return 1
  }
  return Math.min(rounded, MAX_SEARCH_LIMIT)
}

const resolveMemoryUserId = (value?: string | null) => {
  const configured = process.env.CORAZON_MEMORY_USER_ID?.trim()
  const explicit = value?.trim()
  if (explicit) {
    return explicit
  }
  if (configured) {
    return configured
  }
  return DEFAULT_MEMORY_USER_ID
}

const requireOpenAiApiKey = () => {
  const value = process.env.OPENAI_API_KEY?.trim()
  if (!value) {
    throw new Error('OPENAI_API_KEY is required for memory features.')
  }
  return value
}

const resolveChromaUrl = () =>
  process.env.CORAZON_MEMORY_CHROMA_URL?.trim()
  || process.env.CHROMA_URL?.trim()
  || DEFAULT_CHROMA_URL

const resolveChromaCollectionName = () =>
  process.env.CORAZON_MEMORY_CHROMA_COLLECTION?.trim()
  || DEFAULT_CHROMA_COLLECTION_NAME

const resolveChromaCloudApiKey = () =>
  process.env.CORAZON_MEMORY_CHROMA_API_KEY?.trim()
  || process.env.CHROMA_API_KEY?.trim()
  || ''

const resolveChromaTenant = () =>
  process.env.CORAZON_MEMORY_CHROMA_TENANT?.trim()
  || process.env.CHROMA_TENANT?.trim()
  || ''

const resolveChromaDatabase = () =>
  process.env.CORAZON_MEMORY_CHROMA_DATABASE?.trim()
  || process.env.CHROMA_DATABASE?.trim()
  || ''

const buildChromaHeaders = () => {
  const headers: Record<string, string> = {}
  const apiKey = resolveChromaCloudApiKey()
  if (apiKey) {
    headers['x-chroma-token'] = apiKey
  }
  return headers
}

const toIsoStringOrNull = (value: unknown) => {
  if (typeof value === 'string' && value.trim()) {
    return value
  }
  if (value instanceof Date) {
    return value.toISOString()
  }
  return null
}

const normalizeMemoryRecord = (value: unknown): MemoryRecord | null => {
  if (!isObject(value)) {
    return null
  }

  const input = value as MemoryRecordInput
  const memoryText = (() => {
    const direct = normalizeText(input.memory)
    if (direct) {
      return direct
    }
    const nested = normalizeText(input.data?.memory)
    return nested
  })()

  if (!memoryText) {
    return null
  }

  const score = typeof input.score === 'number' && Number.isFinite(input.score)
    ? input.score
    : null
  const metadata = isObject(input.metadata)
    ? input.metadata
    : null
  const id = typeof input.id === 'string' && input.id.trim()
    ? input.id
    : null

  return {
    id,
    memory: memoryText,
    score,
    metadata,
    createdAt: toIsoStringOrNull(input.createdAt ?? input.created_at),
    updatedAt: toIsoStringOrNull(input.updatedAt ?? input.updated_at)
  }
}

const normalizeMemoryResults = (results: unknown): MemoryRecord[] => {
  if (!Array.isArray(results)) {
    return []
  }

  const normalized: MemoryRecord[] = []
  for (const item of results) {
    const parsed = normalizeMemoryRecord(item)
    if (parsed) {
      normalized.push(parsed)
    }
  }
  return normalized
}

const createMemoryEngine = async (): Promise<Mem0Engine> => {
  const { Memory, VectorStoreFactory } = await import('mem0ai/oss')
  const openAiApiKey = requireOpenAiApiKey()
  registerMem0ChromadbProvider(VectorStoreFactory as unknown as {
    create: (provider: string, config: Record<string, unknown>) => unknown
  })

  const chromaCollection = resolveChromaCollectionName()
  const chromaUrl = resolveChromaUrl()
  const chromaCloudApiKey = resolveChromaCloudApiKey()
  const chromaTenant = resolveChromaTenant()
  const chromaDatabase = resolveChromaDatabase()

  const chromaClientParams: Record<string, unknown> = {}
  if (chromaTenant) {
    chromaClientParams.tenant = chromaTenant
  }
  if (chromaDatabase) {
    chromaClientParams.database = chromaDatabase
  }

  return Memory.fromConfig({
    embedder: {
      provider: 'openai',
      config: {
        apiKey: openAiApiKey,
        model: process.env.CORAZON_MEMORY_EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL
      }
    },
    vectorStore: {
      provider: 'chromadb',
      config: {
        collectionName: chromaCollection,
        url: chromaUrl,
        ...(Object.keys(chromaClientParams).length > 0
          ? chromaClientParams
          : {}),
        ...(chromaCloudApiKey
          ? { apiKey: chromaCloudApiKey }
          : {})
      }
    },
    llm: {
      provider: 'openai',
      config: {
        apiKey: openAiApiKey,
        model: process.env.CORAZON_MEMORY_LLM_MODEL?.trim() || DEFAULT_LLM_MODEL
      }
    },
    disableHistory: true
  }) as Mem0Engine
}

const getMemoryEngine = async () => {
  if (!memoryEnginePromise) {
    memoryEnginePromise = createMemoryEngine().catch((error) => {
      memoryEnginePromise = null
      throw error
    })
  }
  return memoryEnginePromise
}

export const ensureMemoryBackendReady = async () => {
  requireOpenAiApiKey()

  const { ChromaClient } = await import('chromadb')
  const headers = buildChromaHeaders()
  const tenant = resolveChromaTenant()
  const database = resolveChromaDatabase()
  const connection = parseChromaConnectionUrl(resolveChromaUrl())
  const client = new ChromaClient({
    host: connection.host,
    port: connection.port,
    ssl: connection.ssl,
    tenant: tenant || undefined,
    database: database || undefined,
    headers: Object.keys(headers).length > 0
      ? headers
      : undefined
  })

  await client.heartbeat()
}

const normalizeMessageContent = (value: unknown) =>
  typeof value === 'string'
    ? value.trim()
    : ''

export const normalizeOpenAICompatMessages = (value: unknown): OpenAICompatMessage[] => {
  if (!Array.isArray(value)) {
    return []
  }

  const normalized: OpenAICompatMessage[] = []
  for (const rawItem of value) {
    if (!isObject(rawItem)) {
      continue
    }
    const role = rawItem.role
    const content = normalizeMessageContent(rawItem.content)
    if (!isMemoryRole(role) || !content) {
      continue
    }
    normalized.push({ role, content })
  }
  return normalized
}

export const convertCodexMessagesToOpenAICompat = (messages: CodexUIMessage[]) => {
  const converted: OpenAICompatMessage[] = []

  for (const message of messages) {
    const role = message?.role
    if (!isMemoryRole(role)) {
      continue
    }

    const content = (message.parts ?? [])
      .filter(part => part?.type === 'text')
      .map(part => (part.text ?? '').trim())
      .filter(Boolean)
      .join('\n')
      .trim()

    if (!content) {
      continue
    }

    converted.push({
      role,
      content
    })
  }

  return converted
}

export const isMemoryConfigured = () => Boolean(process.env.OPENAI_API_KEY?.trim())

export const getMemoryHealth = async () => {
  requireOpenAiApiKey()
  await ensureMemoryBackendReady()
  await getMemoryEngine()
  return {
    configured: true,
    vectorStore: 'chromadb'
  }
}

export const searchMemories = async (input: MemorySearchInput) => {
  const query = input.query.trim()
  if (!query) {
    throw new Error('query is required')
  }

  const engine = await getMemoryEngine()
  const response = await engine.search(query, {
    userId: resolveMemoryUserId(input.userId),
    limit: clampSearchLimit(input.limit),
    filters: input.filters ?? {}
  })

  return normalizeMemoryResults(response.results)
}

export const rememberMessages = async (input: RememberMessagesInput): Promise<MemoryUpsertResult> => {
  const messages = input.messages.filter(item => item.content.trim().length > 0)
  if (!messages.length) {
    throw new Error('messages must contain at least one text entry')
  }

  const engine = await getMemoryEngine()
  const response = await engine.add(messages, {
    userId: resolveMemoryUserId(input.userId),
    metadata: input.metadata ?? {}
  })

  return {
    memories: normalizeMemoryResults(response.results),
    messageCount: messages.length
  }
}

export const rememberText = async (input: RememberTextInput) => {
  const text = input.text.trim()
  if (!text) {
    throw new Error('text is required')
  }

  return rememberMessages({
    messages: [{ role: 'user', content: text }],
    metadata: input.metadata,
    userId: input.userId
  })
}

export const rememberCodexMessages = async (input: RememberCodexMessagesInput) => {
  const converted = convertCodexMessagesToOpenAICompat(input.messages)
  if (!converted.length) {
    return {
      memories: [],
      messageCount: 0
    }
  }

  return rememberMessages({
    messages: converted,
    metadata: input.metadata,
    userId: input.userId
  })
}
