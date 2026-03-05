import type { ChromaClient as ChromaClientType, Collection as ChromaCollectionType } from 'chromadb'

type ChromaMetadataValue = string | number | boolean

type ChromaVectorStoreConfig = {
  collectionName?: string
  url?: string
  tenant?: string
  database?: string
  apiKey?: string
  headers?: Record<string, string>
}

type VectorStoreResult = {
  id: string
  payload: Record<string, unknown>
  score?: number
}

type VectorStoreFactoryLike = {
  create: (provider: string, config: Record<string, unknown>) => unknown
}

const DEFAULT_CHROMA_URL = 'http://127.0.0.1:8000'
const DEFAULT_COLLECTION_NAME = 'mem0'
const PAYLOAD_JSON_KEY = '_mem0_payload_json'
const DOCUMENT_KEY = '_mem0_document'
const SCORE_FLOOR = -1_000_000

let chromaProviderRegistered = false

const isScalarMetadataValue = (value: unknown): value is ChromaMetadataValue =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const toErrorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : String(error)

const toSafeJson = (value: unknown) => {
  try {
    return JSON.stringify(value)
  } catch {
    return '{}'
  }
}

const fromSafeJson = (value: string | undefined) => {
  if (!value) {
    return null
  }

  try {
    const parsed = JSON.parse(value)
    return isObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

const toMetadata = (payload: Record<string, unknown>) => {
  const metadata: Record<string, ChromaMetadataValue> = {}

  for (const [key, value] of Object.entries(payload)) {
    if (isScalarMetadataValue(value)) {
      metadata[key] = value
    }
  }

  metadata[PAYLOAD_JSON_KEY] = toSafeJson(payload)
  metadata[DOCUMENT_KEY] = extractDocument(payload)
  return metadata
}

const extractDocument = (payload: Record<string, unknown>) => {
  const direct = typeof payload.data === 'string' ? payload.data.trim() : ''
  if (direct) {
    return direct
  }
  const dataField = isObject(payload.data) && typeof payload.data.memory === 'string'
    ? payload.data.memory.trim()
    : ''
  if (dataField) {
    return dataField
  }
  const memoryField = typeof payload.memory === 'string'
    ? payload.memory.trim()
    : ''
  if (memoryField) {
    return memoryField
  }
  return toSafeJson(payload)
}

const normalizeWhereFilter = (filters?: Record<string, unknown>) => {
  if (!filters || !Object.keys(filters).length) {
    return undefined
  }

  const where: Record<string, ChromaMetadataValue> = {}
  for (const [key, value] of Object.entries(filters)) {
    if (isScalarMetadataValue(value)) {
      where[key] = value
    }
  }

  return Object.keys(where).length > 0 ? where : undefined
}

const normalizeScoreFromDistance = (distance: unknown) => {
  if (typeof distance !== 'number' || !Number.isFinite(distance)) {
    return undefined
  }
  return Math.max(SCORE_FLOOR, 1 - distance)
}

const ensureStringArray = (value: unknown) =>
  Array.isArray(value)
    ? value.filter(item => typeof item === 'string')
    : []

const getOrEmptyObjectArray = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value)
    ? value.map((item) => {
        if (!isObject(item)) {
          return {}
        }
        return item
      })
    : []

const pickStringHeaders = (value: unknown): Record<string, string> | undefined => {
  if (!isObject(value)) {
    return undefined
  }

  const entries = Object.entries(value)
    .filter(([, item]) => typeof item === 'string')
    .map(([key, item]) => [key, item as string] as [string, string])
  if (!entries.length) {
    return undefined
  }
  return Object.fromEntries(entries) as Record<string, string>
}

export class Mem0ChromaVectorStore {
  private client: ChromaClientType | null = null
  private collectionPromise: Promise<ChromaCollectionType> | null = null
  private readonly collectionName: string
  private readonly url: string
  private readonly tenant?: string
  private readonly database?: string
  private readonly apiKey?: string
  private readonly headers?: Record<string, string>
  private userId = 'corazon-memory-user'

  constructor(config: ChromaVectorStoreConfig) {
    this.collectionName = config.collectionName?.trim() || DEFAULT_COLLECTION_NAME
    this.url = config.url?.trim() || DEFAULT_CHROMA_URL
    this.tenant = config.tenant?.trim() || undefined
    this.database = config.database?.trim() || undefined
    this.apiKey = config.apiKey?.trim() || undefined
    this.headers = config.headers
  }

  private async getClient() {
    if (this.client) {
      return this.client
    }

    const { ChromaClient } = await import('chromadb')
    const headers: Record<string, string> = {
      ...(this.headers ?? {})
    }
    if (this.apiKey) {
      headers['x-chroma-token'] = this.apiKey
    }

    this.client = new ChromaClient({
      path: this.url,
      tenant: this.tenant,
      database: this.database,
      headers
    })

    return this.client
  }

  private async getCollection() {
    if (!this.collectionPromise) {
      this.collectionPromise = this.getClient()
        .then(client => client.getOrCreateCollection({
          name: this.collectionName,
          embeddingFunction: null
        }))
    }

    return this.collectionPromise
  }

  private buildVectorStoreResult(input: {
    id: string
    metadata: Record<string, unknown>
    score?: number
  }): VectorStoreResult {
    const payload = fromSafeJson(typeof input.metadata[PAYLOAD_JSON_KEY] === 'string'
      ? input.metadata[PAYLOAD_JSON_KEY]
      : undefined)

    return {
      id: input.id,
      payload: payload ?? {},
      score: input.score
    }
  }

  async insert(vectors: number[][], ids: string[], payloads: Record<string, unknown>[]) {
    const collection = await this.getCollection()
    await collection.upsert({
      ids,
      embeddings: vectors,
      metadatas: payloads.map(toMetadata),
      documents: payloads.map(extractDocument)
    })
  }

  async search(query: number[], limit = 5, filters?: Record<string, unknown>) {
    const collection = await this.getCollection()
    const result = await collection.query({
      queryEmbeddings: [query],
      nResults: limit,
      where: normalizeWhereFilter(filters),
      include: ['metadatas', 'distances']
    })

    const ids = ensureStringArray(result.ids?.[0])
    const metadatas = getOrEmptyObjectArray(result.metadatas?.[0])
    const distances = Array.isArray(result.distances?.[0]) ? result.distances[0] : []

    const items: VectorStoreResult[] = []
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index]
      if (!id) {
        continue
      }
      const metadata = metadatas[index] ?? {}
      items.push(this.buildVectorStoreResult({
        id,
        metadata,
        score: normalizeScoreFromDistance(distances[index])
      }))
    }

    return items
  }

  async get(vectorId: string) {
    const collection = await this.getCollection()
    const result = await collection.get({
      ids: [vectorId],
      include: ['metadatas']
    })
    const id = ensureStringArray(result.ids)[0]
    if (!id) {
      return null
    }
    const metadata = getOrEmptyObjectArray(result.metadatas)[0] ?? {}
    return this.buildVectorStoreResult({
      id,
      metadata
    })
  }

  async update(vectorId: string, vector: number[], payload: Record<string, unknown>) {
    const collection = await this.getCollection()
    await collection.update({
      ids: [vectorId],
      embeddings: [vector],
      metadatas: [toMetadata(payload)],
      documents: [extractDocument(payload)]
    })
  }

  async delete(vectorId: string) {
    const collection = await this.getCollection()
    await collection.delete({
      ids: [vectorId]
    })
  }

  async deleteCol() {
    const client = await this.getClient()
    await client.deleteCollection({
      name: this.collectionName
    })
    this.collectionPromise = null
  }

  async list(filters?: Record<string, unknown>, limit = 100): Promise<[VectorStoreResult[], number]> {
    const collection = await this.getCollection()
    const result = await collection.get({
      where: normalizeWhereFilter(filters),
      limit,
      include: ['metadatas']
    })

    const ids = ensureStringArray(result.ids)
    const metadatas = getOrEmptyObjectArray(result.metadatas)
    const items: VectorStoreResult[] = []

    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index]
      if (!id) {
        continue
      }
      items.push(this.buildVectorStoreResult({
        id,
        metadata: metadatas[index] ?? {}
      }))
    }

    return [items, items.length]
  }

  async getUserId() {
    return this.userId
  }

  async setUserId(userId: string) {
    this.userId = userId.trim() || this.userId
  }

  async initialize() {
    await this.getCollection()
  }
}

export const registerMem0ChromadbProvider = (vectorStoreFactory: VectorStoreFactoryLike) => {
  if (chromaProviderRegistered) {
    return
  }

  const originalCreate = vectorStoreFactory.create.bind(vectorStoreFactory)
  vectorStoreFactory.create = (provider: string, config: Record<string, unknown>) => {
    if (provider === 'chromadb' || provider === 'chroma') {
      try {
        return new Mem0ChromaVectorStore({
          collectionName: typeof config.collectionName === 'string'
            ? config.collectionName
            : undefined,
          url: typeof config.url === 'string'
            ? config.url
            : undefined,
          tenant: typeof config.tenant === 'string'
            ? config.tenant
            : undefined,
          database: typeof config.database === 'string'
            ? config.database
            : undefined,
          apiKey: typeof config.apiKey === 'string'
            ? config.apiKey
            : undefined,
          headers: pickStringHeaders(config.headers)
        })
      } catch (error) {
        throw new Error(`Failed to initialize chromadb provider: ${toErrorMessage(error)}`)
      }
    }
    return originalCreate(provider, config)
  }

  chromaProviderRegistered = true
}
