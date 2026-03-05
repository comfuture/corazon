import type { ThreadMemorySyncCandidate } from './db.ts'
import {
  loadStaleThreadsForMemorySync,
  loadThreadMessages,
  markThreadMemorySyncFailure,
  markThreadMemorySyncSuccess
} from './db.ts'
import { ensureMemoryBackendReady, isMemoryConfigured, rememberCodexMessages } from './memory.ts'

const STALE_THREAD_MS = 15 * 60 * 1000
const SYNC_INTERVAL_MS = 15 * 60 * 1000
const SYNC_BATCH_LIMIT = 20
const DEFAULT_BACKOFF_MS = 60 * 1000

let memorySyncInitialized = false
let memorySyncTimer: ReturnType<typeof setInterval> | null = null
let memorySyncRunning = false
let memorySyncBlockedUntil = 0

const parseBooleanEnv = (value: string | undefined, fallback: boolean) => {
  if (!value) {
    return fallback
  }
  const normalized = value.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false
  }
  return fallback
}

const resolveSyncEnabled = () =>
  parseBooleanEnv(process.env.CORAZON_MEMORY_SYNC_ENABLED, true)

const resolveBackoffMs = () => {
  const parsed = Number(process.env.CORAZON_MEMORY_SYNC_BACKOFF_MS)
  if (!Number.isFinite(parsed)) {
    return DEFAULT_BACKOFF_MS
  }
  return Math.max(15_000, Math.floor(parsed))
}

const toErrorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : String(error)

const buildSyncMetadata = (thread: ThreadMemorySyncCandidate) => ({
  source: 'stale-thread-sync',
  threadId: thread.id,
  threadUpdatedAt: thread.updatedAt,
  syncedAt: new Date().toISOString()
})

const syncStaleThread = async (thread: ThreadMemorySyncCandidate) => {
  const messages = loadThreadMessages(thread.id) ?? []
  await rememberCodexMessages({
    messages,
    metadata: buildSyncMetadata(thread)
  })
  markThreadMemorySyncSuccess(thread.id, thread.updatedAt)
}

export const runMemorySyncTick = async () => {
  if (memorySyncRunning) {
    return
  }
  if (!resolveSyncEnabled() || !isMemoryConfigured()) {
    return
  }

  const now = Date.now()
  if (memorySyncBlockedUntil > now) {
    return
  }

  memorySyncRunning = true
  try {
    try {
      await ensureMemoryBackendReady()
    } catch (error) {
      const message = toErrorMessage(error)
      const backoffMs = resolveBackoffMs()
      memorySyncBlockedUntil = Date.now() + backoffMs
      console.error(
        `[memory-sync] backend unavailable; retry after ${Math.floor(backoffMs / 1000)}s: ${message}`
      )
      return
    }

    const staleBefore = Date.now() - STALE_THREAD_MS
    const staleThreads = loadStaleThreadsForMemorySync(staleBefore, SYNC_BATCH_LIMIT)

    for (const thread of staleThreads) {
      try {
        await syncStaleThread(thread)
      } catch (error) {
        const message = toErrorMessage(error)
        markThreadMemorySyncFailure(thread.id, thread.updatedAt, message)
        console.error(`[memory-sync] failed thread=${thread.id}: ${message}`)
      }
    }
  } finally {
    memorySyncRunning = false
  }
}

export const initializeMemorySyncWorkflow = () => {
  if (memorySyncInitialized) {
    return
  }

  memorySyncInitialized = true
  void runMemorySyncTick()
  memorySyncTimer = setInterval(() => {
    void runMemorySyncTick()
  }, SYNC_INTERVAL_MS)
}

export const stopMemorySyncWorkflow = () => {
  if (memorySyncTimer) {
    clearInterval(memorySyncTimer)
    memorySyncTimer = null
  }
  memorySyncInitialized = false
}
