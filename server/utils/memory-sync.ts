import type { ThreadMemorySyncCandidate } from './db.ts'
import {
  loadStaleThreadsForMemorySync,
  loadThreadMessages,
  markThreadMemorySyncFailure,
  markThreadMemorySyncSuccess
} from './db.ts'
import { isMemoryConfigured, rememberCodexMessages } from './memory.ts'

const STALE_THREAD_MS = 15 * 60 * 1000
const SYNC_INTERVAL_MS = 15 * 60 * 1000
const SYNC_BATCH_LIMIT = 20

let memorySyncInitialized = false
let memorySyncTimer: ReturnType<typeof setInterval> | null = null
let memorySyncRunning = false

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
  if (!isMemoryConfigured()) {
    return
  }

  memorySyncRunning = true
  try {
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
