import Database from 'better-sqlite3'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Usage } from '@openai/codex-sdk'
import type { WorkflowRunStatus, WorkflowRunSummary, WorkflowTriggerType } from '@@/types/workflow'
import { CODEX_ITEM_PART, type CodexUIMessage } from '../../types/chat-ui.ts'
import { resolveCorazonRootDir } from './agent-home.ts'

export type ThreadSummary = {
  id: string
  title: string | null
  model: string | null
  workingDirectory: string | null
  createdAt: number
  updatedAt: number
  turnCount: number
  totalInputTokens: number
  totalCachedInputTokens: number
  totalOutputTokens: number
}

export type ThreadOrigin = 'telegram' | 'web'

export type ThreadOriginInfo = {
  origin: ThreadOrigin | null
  originChannelId: string | null
}

export type ThreadSummaryCursor = {
  updatedAt: number
  id: string
}

export type ThreadSummaryPage = {
  items: ThreadSummary[]
  nextCursor: ThreadSummaryCursor | null
}

export type ThreadMemorySyncCandidate = {
  id: string
  updatedAt: number
}

export type TelegramTransportState = {
  key: string
  lastUpdateId: number | null
  lastPollStartedAt: number | null
  lastPollSucceededAt: number | null
  lastPollError: string | null
  updatedAt: number
}

export type TelegramSession = {
  id: string
  chatId: string
  threadId: string | null
  activeRunId: string | null
  lastInboundMessageId: number | null
  lastOutboundMessageId: number | null
  lastOutboundKind: string | null
  startedAt: number
  lastInboundAt: number
  lastCompletedAt: number | null
  carryoverSummary: string | null
  sessionSummary: string | null
  summaryUpdatedAt: number | null
  resumedFromSessionId: string | null
  resumeConfidence: number | null
  status: string
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export type TelegramRecentChat = {
  chatId: string
  type: string
  title: string
  subtitle: string | null
  lastMessageText: string | null
  lastMessageAt: number | null
  lastUpdateId: number
  createdAt: number
  updatedAt: number
}

type ThreadRow = {
  id: string
  title: string | null
  model: string | null
  working_directory: string | null
  origin: string | null
  origin_channel_id: string | null
  created_at: number
  updated_at: number
  total_input_tokens: number
  total_cached_input_tokens: number
  total_output_tokens: number
  turn_count: number
}

type ThreadMemorySyncRow = {
  id: string
  updated_at: number
}

type WorkflowRunRow = {
  id: string
  workflow_name: string
  workflow_file_slug: string
  trigger_type: WorkflowTriggerType
  trigger_value: string | null
  status: WorkflowRunStatus
  started_at: number
  completed_at: number | null
  total_input_tokens: number
  total_cached_input_tokens: number
  total_output_tokens: number
  session_thread_id: string | null
  session_file_path: string | null
  error_message: string | null
}

type TelegramTransportStateRow = {
  key: string
  last_update_id: number | null
  last_poll_started_at: number | null
  last_poll_succeeded_at: number | null
  last_poll_error: string | null
  updated_at: number
}

type TelegramSessionRow = {
  id: string
  chat_id: string
  thread_id: string | null
  active_run_id: string | null
  last_inbound_message_id: number | null
  last_outbound_message_id: number | null
  last_outbound_kind: string | null
  started_at: number
  last_inbound_at: number
  last_completed_at: number | null
  carryover_summary: string | null
  session_summary: string | null
  summary_updated_at: number | null
  resumed_from_session_id: string | null
  resume_confidence: number | null
  status: string
  last_error: string | null
  created_at: number
  updated_at: number
}

type TelegramRecentChatRow = {
  chat_id: string
  type: string
  title: string
  subtitle: string | null
  last_message_text: string | null
  last_message_at: number | null
  last_update_id: number
  created_at: number
  updated_at: number
}

type CodexPart = CodexUIMessage['parts'][number]

const normalizeCodexItemParts = (messages: CodexUIMessage[]) =>
  messages.map((message) => {
    const parts = message.parts as CodexPart[] | undefined
    if (!parts || parts.length === 0) {
      return message
    }

    const merged: CodexPart[] = []
    const indexById = new Map<string, number>()
    let hasDuplicates = false

    for (const part of parts) {
      if (part?.type === CODEX_ITEM_PART && typeof part.id === 'string') {
        const existingIndex = indexById.get(part.id)
        if (existingIndex !== undefined) {
          hasDuplicates = true
          merged[existingIndex] = {
            ...merged[existingIndex],
            data: part.data
          } as CodexPart
          continue
        }
        indexById.set(part.id, merged.length)
      }
      merged.push(part)
    }

    if (!hasDuplicates) {
      return message
    }

    return {
      ...message,
      parts: merged
    }
  })

const getRuntimeRoot = () => resolveCorazonRootDir()

const getThreadRootDirectory = () => join(getRuntimeRoot(), 'threads')

let db: Database.Database | null = null

const getDataDirectory = () => join(getRuntimeRoot(), 'data')

const getDb = () => {
  if (db) {
    return db
  }

  const dataDir = getDataDirectory()
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(dataDir, 'codex.sqlite')

  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      title TEXT,
      model TEXT,
      working_directory TEXT,
      origin TEXT,
      origin_channel_id TEXT,
      active_run_id TEXT,
      active_run_updated_at INTEGER,
      memory_synced_source_updated_at INTEGER,
      memory_last_synced_at INTEGER,
      memory_sync_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      turn_count INTEGER NOT NULL DEFAULT 0,
      last_usage_json TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      message_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
      UNIQUE (thread_id, seq)
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      workflow_file_slug TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      trigger_value TEXT,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      session_thread_id TEXT,
      session_file_path TEXT,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS telegram_transport_state (
      key TEXT PRIMARY KEY,
      last_update_id INTEGER,
      last_poll_started_at INTEGER,
      last_poll_succeeded_at INTEGER,
      last_poll_error TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS telegram_sessions (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      thread_id TEXT,
      active_run_id TEXT,
      last_inbound_message_id INTEGER,
      last_outbound_message_id INTEGER,
      last_outbound_kind TEXT,
      started_at INTEGER NOT NULL,
      last_inbound_at INTEGER NOT NULL,
      last_completed_at INTEGER,
      carryover_summary TEXT,
      session_summary TEXT,
      summary_updated_at INTEGER,
      resumed_from_session_id TEXT,
      resume_confidence REAL,
      status TEXT NOT NULL DEFAULT 'active',
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS telegram_recent_chats (
      chat_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      subtitle TEXT,
      last_message_text TEXT,
      last_message_at INTEGER,
      last_update_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS threads_updated_at_idx ON threads(updated_at DESC);
    CREATE INDEX IF NOT EXISTS messages_thread_seq_idx ON messages(thread_id, seq);
    CREATE INDEX IF NOT EXISTS runs_workflow_started_idx ON runs(workflow_file_slug, started_at DESC);
    CREATE INDEX IF NOT EXISTS runs_started_idx ON runs(started_at DESC);
    CREATE INDEX IF NOT EXISTS telegram_sessions_chat_updated_idx ON telegram_sessions(chat_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS telegram_recent_chats_updated_idx ON telegram_recent_chats(updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS telegram_sessions_thread_unique_idx
      ON telegram_sessions(thread_id)
      WHERE thread_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS telegram_sessions_active_run_unique_idx
      ON telegram_sessions(active_run_id)
      WHERE active_run_id IS NOT NULL;
  `)

  const columns = db.prepare('PRAGMA table_info(threads)').all() as { name: string }[]
  const hasColumn = (name: string) => columns.some(column => column.name === name)
  const telegramSessionColumns = db.prepare('PRAGMA table_info(telegram_sessions)').all() as { name: string }[]
  const hasTelegramSessionColumn = (name: string) =>
    telegramSessionColumns.some(column => column.name === name)

  if (!hasColumn('model')) {
    db.exec('ALTER TABLE threads ADD COLUMN model TEXT')
  }

  if (!hasColumn('working_directory')) {
    db.exec('ALTER TABLE threads ADD COLUMN working_directory TEXT')
  }

  if (!hasColumn('origin')) {
    db.exec('ALTER TABLE threads ADD COLUMN origin TEXT')
  }

  if (!hasColumn('origin_channel_id')) {
    db.exec('ALTER TABLE threads ADD COLUMN origin_channel_id TEXT')
  }

  if (!hasColumn('active_run_id')) {
    db.exec('ALTER TABLE threads ADD COLUMN active_run_id TEXT')
  }

  if (!hasColumn('active_run_updated_at')) {
    db.exec('ALTER TABLE threads ADD COLUMN active_run_updated_at INTEGER')
  }

  if (!hasColumn('memory_synced_source_updated_at')) {
    db.exec('ALTER TABLE threads ADD COLUMN memory_synced_source_updated_at INTEGER')
  }

  if (!hasColumn('memory_last_synced_at')) {
    db.exec('ALTER TABLE threads ADD COLUMN memory_last_synced_at INTEGER')
  }

  if (!hasColumn('memory_sync_error')) {
    db.exec('ALTER TABLE threads ADD COLUMN memory_sync_error TEXT')
  }

  if (!hasTelegramSessionColumn('session_summary')) {
    db.exec('ALTER TABLE telegram_sessions ADD COLUMN session_summary TEXT')
  }

  if (!hasTelegramSessionColumn('summary_updated_at')) {
    db.exec('ALTER TABLE telegram_sessions ADD COLUMN summary_updated_at INTEGER')
  }

  if (!hasTelegramSessionColumn('resumed_from_session_id')) {
    db.exec('ALTER TABLE telegram_sessions ADD COLUMN resumed_from_session_id TEXT')
  }

  if (!hasTelegramSessionColumn('resume_confidence')) {
    db.exec('ALTER TABLE telegram_sessions ADD COLUMN resume_confidence REAL')
  }

  return db
}

export const initializeDatabase = () => {
  getDb()
}

export const ensureThread = (threadId: string) => {
  const now = Date.now()
  const database = getDb()
  database
    .prepare(
      `
      INSERT INTO threads (id, created_at, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
    `
    )
    .run(threadId, now, now)
}

export const ensureThreadRootDirectory = () => {
  const root = getThreadRootDirectory()
  mkdirSync(root, { recursive: true })
  return root
}

export const ensureThreadWorkingDirectory = (threadId: string) => {
  const root = ensureThreadRootDirectory()
  const directory = join(root, threadId)
  mkdirSync(directory, { recursive: true })
  setThreadWorkingDirectory(threadId, directory)
  return directory
}

const getPendingAttachmentsRootDirectory = () => join(ensureThreadRootDirectory(), '_pending')

export const getPendingAttachmentsDirectory = (uploadId: string) =>
  join(getPendingAttachmentsRootDirectory(), uploadId)

export const ensurePendingAttachmentsDirectory = (uploadId: string) => {
  const directory = getPendingAttachmentsDirectory(uploadId)
  mkdirSync(directory, { recursive: true })
  return directory
}

export const ensureThreadAttachmentsDirectory = (threadId: string) => {
  const workingDirectory = ensureThreadWorkingDirectory(threadId)
  const directory = join(workingDirectory, 'attachments')
  mkdirSync(directory, { recursive: true })
  return directory
}

export const saveThreadMessages = (threadId: string, messages: CodexUIMessage[]) => {
  const now = Date.now()
  const database = getDb()
  const deleteStmt = database.prepare('DELETE FROM messages WHERE thread_id = ?')
  const insertStmt = database.prepare(
    'INSERT INTO messages (thread_id, seq, message_json, created_at) VALUES (?, ?, ?, ?)'
  )
  const updateThread = database.prepare('UPDATE threads SET updated_at = ? WHERE id = ?')
  const normalized = normalizeCodexItemParts(messages)

  const insertMessages = database.transaction((items: CodexUIMessage[]) => {
    deleteStmt.run(threadId)
    items.forEach((message, index) => {
      insertStmt.run(threadId, index, JSON.stringify(message), now)
    })
    updateThread.run(now, threadId)
  })

  ensureThread(threadId)
  insertMessages(normalized)
}

export const loadThreadMessages = (threadId: string): CodexUIMessage[] | null => {
  const database = getDb()
  const rows = database
    .prepare('SELECT message_json FROM messages WHERE thread_id = ? ORDER BY seq ASC')
    .all(threadId) as { message_json?: string }[]

  if (!rows.length) {
    return null
  }

  const parsed: CodexUIMessage[] = []
  for (const row of rows) {
    if (!row.message_json) {
      continue
    }
    try {
      const value = JSON.parse(row.message_json)
      if (value) {
        parsed.push(value as CodexUIMessage)
      }
    } catch {
      return null
    }
  }

  if (!parsed.length) {
    return null
  }
  return normalizeCodexItemParts(parsed)
}

export const loadStaleThreadsForMemorySync = (
  staleBefore: number,
  limit = 20
): ThreadMemorySyncCandidate[] => {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 200))
  const database = getDb()
  const rows = database
    .prepare(
      `
      SELECT id, updated_at
      FROM threads
      WHERE id != '_pending'
      AND updated_at <= ?
      AND active_run_id IS NULL
      AND (
        memory_synced_source_updated_at IS NULL
        OR memory_synced_source_updated_at < updated_at
      )
      ORDER BY updated_at ASC, id ASC
      LIMIT ?
    `
    )
    .all(staleBefore, safeLimit) as ThreadMemorySyncRow[]

  return rows.map(row => ({
    id: row.id,
    updatedAt: row.updated_at
  }))
}

export const markThreadMemorySyncSuccess = (
  threadId: string,
  sourceUpdatedAt: number,
  syncedAt?: number
) => {
  const now = syncedAt ?? Date.now()
  const database = getDb()
  database
    .prepare(
      `
      UPDATE threads
      SET
        memory_synced_source_updated_at = ?,
        memory_last_synced_at = ?,
        memory_sync_error = NULL
      WHERE id = ?
    `
    )
    .run(sourceUpdatedAt, now, threadId)
  return now
}

export const markThreadMemorySyncFailure = (
  threadId: string,
  _sourceUpdatedAt: number,
  message: string,
  syncedAt?: number
) => {
  const now = syncedAt ?? Date.now()
  const database = getDb()
  database
    .prepare(
      `
      UPDATE threads
      SET
        memory_last_synced_at = ?,
        memory_sync_error = ?
      WHERE id = ?
    `
    )
    .run(now, message.trim() || 'Memory sync failed.', threadId)
  return now
}

export const recordThreadUsage = (threadId: string, usage: Usage) => {
  const now = Date.now()
  const database = getDb()
  database
    .prepare(
      `
      INSERT INTO threads (
        id,
        created_at,
        updated_at,
        total_input_tokens,
        total_cached_input_tokens,
        total_output_tokens,
        turn_count,
        last_usage_json
      )
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(id) DO UPDATE SET
        updated_at = excluded.updated_at,
        total_input_tokens = total_input_tokens + excluded.total_input_tokens,
        total_cached_input_tokens = total_cached_input_tokens + excluded.total_cached_input_tokens,
        total_output_tokens = total_output_tokens + excluded.total_output_tokens,
        turn_count = turn_count + 1,
        last_usage_json = excluded.last_usage_json
    `
    )
    .run(
      threadId,
      now,
      now,
      usage.input_tokens,
      usage.cached_input_tokens,
      usage.output_tokens,
      JSON.stringify(usage)
    )
}

export const setThreadTitle = (threadId: string, title: string) => {
  const now = Date.now()
  const database = getDb()
  ensureThread(threadId)
  database
    .prepare('UPDATE threads SET title = ?, updated_at = ? WHERE id = ?')
    .run(title, now, threadId)
  return now
}

export const setThreadModel = (threadId: string, model: string) => {
  const now = Date.now()
  const database = getDb()
  ensureThread(threadId)
  database
    .prepare('UPDATE threads SET model = ?, updated_at = ? WHERE id = ?')
    .run(model, now, threadId)
  return now
}

export const setThreadWorkingDirectory = (threadId: string, workingDirectory: string) => {
  const now = Date.now()
  const database = getDb()
  ensureThread(threadId)
  database
    .prepare('UPDATE threads SET working_directory = ?, updated_at = ? WHERE id = ?')
    .run(workingDirectory, now, threadId)
  return now
}

const normalizeThreadOrigin = (value: unknown): ThreadOrigin | null => {
  if (value === 'telegram' || value === 'web') {
    return value
  }
  return null
}

export const setThreadOrigin = (
  threadId: string,
  origin: ThreadOrigin,
  originChannelId?: string | null
) => {
  const now = Date.now()
  const database = getDb()
  ensureThread(threadId)
  database
    .prepare(
      `
      UPDATE threads
      SET origin = ?, origin_channel_id = ?, updated_at = ?
      WHERE id = ?
    `
    )
    .run(origin, originChannelId ?? null, now, threadId)
  return now
}

export const getThreadOrigin = (threadId: string): ThreadOriginInfo | null => {
  const database = getDb()
  const row = database
    .prepare('SELECT origin, origin_channel_id FROM threads WHERE id = ?')
    .get(threadId) as { origin?: string | null, origin_channel_id?: string | null } | undefined
  if (!row) {
    return null
  }
  return {
    origin: normalizeThreadOrigin(row.origin),
    originChannelId: row.origin_channel_id ?? null
  }
}

export const isTelegramOriginThread = (threadId: string) =>
  getThreadOrigin(threadId)?.origin === 'telegram'

export const setThreadActiveRun = (threadId: string, runId: string, updatedAt?: number) => {
  const now = updatedAt ?? Date.now()
  const database = getDb()
  ensureThread(threadId)
  database
    .prepare(
      `
      UPDATE threads
      SET active_run_id = ?, active_run_updated_at = ?, updated_at = ?
      WHERE id = ?
    `
    )
    .run(runId, now, now, threadId)
  return now
}

export const clearThreadActiveRun = (threadId: string, runId?: string) => {
  const now = Date.now()
  const database = getDb()
  ensureThread(threadId)

  if (runId) {
    const result = database
      .prepare(
        `
        UPDATE threads
        SET active_run_id = NULL, active_run_updated_at = ?, updated_at = ?
        WHERE id = ? AND active_run_id = ?
      `
      )
      .run(now, now, threadId, runId)
    return result.changes > 0
  }

  database
    .prepare(
      `
      UPDATE threads
      SET active_run_id = NULL, active_run_updated_at = ?, updated_at = ?
      WHERE id = ?
    `
    )
    .run(now, now, threadId)
  return true
}

export const getThreadActiveRun = (threadId: string): string | null => {
  const database = getDb()
  const row = database
    .prepare('SELECT active_run_id FROM threads WHERE id = ?')
    .get(threadId) as { active_run_id?: string | null } | undefined
  return row?.active_run_id ?? null
}

export const getThreadTitle = (threadId: string): string | null => {
  const database = getDb()
  const row = database
    .prepare('SELECT title FROM threads WHERE id = ?')
    .get(threadId) as { title?: string | null } | undefined
  return row?.title ?? null
}

export const getThreadConfig = (threadId: string) => {
  const database = getDb()
  const row = database
    .prepare('SELECT model, working_directory FROM threads WHERE id = ?')
    .get(threadId) as { model?: string | null, working_directory?: string | null } | undefined
  if (!row) {
    return null
  }
  return {
    model: row.model ?? null,
    workingDirectory: row.working_directory ?? null
  }
}

export const deleteThread = (threadId: string) => {
  if (threadId === '_pending') {
    return false
  }
  const database = getDb()
  const result = database.prepare('DELETE FROM threads WHERE id = ?').run(threadId)
  if (result.changes === 0) {
    return false
  }

  const threadDirectory = join(getThreadRootDirectory(), threadId)
  if (existsSync(threadDirectory)) {
    rmSync(threadDirectory, { recursive: true, force: true })
  }

  return true
}

const toThreadSummary = (row: ThreadRow): ThreadSummary => ({
  id: row.id,
  title: row.title ?? null,
  model: row.model ?? null,
  workingDirectory: row.working_directory ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  turnCount: row.turn_count,
  totalInputTokens: row.total_input_tokens,
  totalCachedInputTokens: row.total_cached_input_tokens,
  totalOutputTokens: row.total_output_tokens
})

const toTelegramTransportState = (row: TelegramTransportStateRow): TelegramTransportState => ({
  key: row.key,
  lastUpdateId: row.last_update_id ?? null,
  lastPollStartedAt: row.last_poll_started_at ?? null,
  lastPollSucceededAt: row.last_poll_succeeded_at ?? null,
  lastPollError: row.last_poll_error ?? null,
  updatedAt: row.updated_at
})

const toTelegramSession = (row: TelegramSessionRow): TelegramSession => ({
  id: row.id,
  chatId: row.chat_id,
  threadId: row.thread_id ?? null,
  activeRunId: row.active_run_id ?? null,
  lastInboundMessageId: row.last_inbound_message_id ?? null,
  lastOutboundMessageId: row.last_outbound_message_id ?? null,
  lastOutboundKind: row.last_outbound_kind ?? null,
  startedAt: row.started_at,
  lastInboundAt: row.last_inbound_at,
  lastCompletedAt: row.last_completed_at ?? null,
  carryoverSummary: row.carryover_summary ?? null,
  sessionSummary: row.session_summary ?? null,
  summaryUpdatedAt: row.summary_updated_at ?? null,
  resumedFromSessionId: row.resumed_from_session_id ?? null,
  resumeConfidence: typeof row.resume_confidence === 'number' ? row.resume_confidence : null,
  status: row.status,
  lastError: row.last_error ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at
})

const toTelegramRecentChat = (row: TelegramRecentChatRow): TelegramRecentChat => ({
  chatId: row.chat_id,
  type: row.type,
  title: row.title,
  subtitle: row.subtitle ?? null,
  lastMessageText: row.last_message_text ?? null,
  lastMessageAt: row.last_message_at ?? null,
  lastUpdateId: row.last_update_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at
})

export const loadThreadSummaries = (
  limit = 50,
  cursor: ThreadSummaryCursor | null = null
): ThreadSummaryPage => {
  const safeLimit = Math.max(1, Math.min(limit, 100))
  const requestedCount = safeLimit + 1
  const database = getDb()
  const rows = database
    .prepare(
      `
      SELECT
        id,
        title,
        model,
        working_directory,
        origin,
        origin_channel_id,
        created_at,
        updated_at,
        total_input_tokens,
        total_cached_input_tokens,
        total_output_tokens,
        turn_count
      FROM threads
      WHERE (
        ? IS NULL
        OR updated_at < ?
        OR (updated_at = ? AND id < ?)
      )
      ORDER BY updated_at DESC
      , id DESC
      LIMIT ?
    `
    )
    .all(
      cursor?.updatedAt ?? null,
      cursor?.updatedAt ?? null,
      cursor?.updatedAt ?? null,
      cursor?.id ?? null,
      requestedCount
    ) as ThreadRow[]

  const hasMore = rows.length > safeLimit
  const slicedRows = hasMore ? rows.slice(0, safeLimit) : rows
  const items = slicedRows.map(toThreadSummary)
  const last = items.at(-1) ?? null

  return {
    items,
    nextCursor: hasMore && last
      ? {
          updatedAt: last.updatedAt,
          id: last.id
        }
      : null
  }
}

export const getTelegramTransportState = (key = 'default'): TelegramTransportState | null => {
  const database = getDb()
  const row = database
    .prepare(
      `
      SELECT
        key,
        last_update_id,
        last_poll_started_at,
        last_poll_succeeded_at,
        last_poll_error,
        updated_at
      FROM telegram_transport_state
      WHERE key = ?
    `
    )
    .get(key) as TelegramTransportStateRow | undefined

  return row ? toTelegramTransportState(row) : null
}

export const upsertTelegramTransportState = (input: {
  key?: string
  lastUpdateId?: number | null
  lastPollStartedAt?: number | null
  lastPollSucceededAt?: number | null
  lastPollError?: string | null
  updatedAt?: number
}) => {
  const key = input.key?.trim() || 'default'
  const updatedAt = input.updatedAt ?? Date.now()
  const database = getDb()
  database
    .prepare(
      `
      INSERT INTO telegram_transport_state (
        key,
        last_update_id,
        last_poll_started_at,
        last_poll_succeeded_at,
        last_poll_error,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        last_update_id = excluded.last_update_id,
        last_poll_started_at = excluded.last_poll_started_at,
        last_poll_succeeded_at = excluded.last_poll_succeeded_at,
        last_poll_error = excluded.last_poll_error,
        updated_at = excluded.updated_at
    `
    )
    .run(
      key,
      input.lastUpdateId ?? null,
      input.lastPollStartedAt ?? null,
      input.lastPollSucceededAt ?? null,
      input.lastPollError ?? null,
      updatedAt
    )

  return getTelegramTransportState(key)
}

export const upsertTelegramRecentChat = (input: {
  chatId: string
  type: string
  title: string
  subtitle?: string | null
  lastMessageText?: string | null
  lastMessageAt?: number | null
  lastUpdateId: number
  updatedAt?: number
}) => {
  const now = input.updatedAt ?? Date.now()
  const database = getDb()
  database
    .prepare(
      `
      INSERT INTO telegram_recent_chats (
        chat_id,
        type,
        title,
        subtitle,
        last_message_text,
        last_message_at,
        last_update_id,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        type = excluded.type,
        title = excluded.title,
        subtitle = excluded.subtitle,
        last_message_text = excluded.last_message_text,
        last_message_at = excluded.last_message_at,
        last_update_id = excluded.last_update_id,
        updated_at = excluded.updated_at
    `
    )
    .run(
      input.chatId,
      input.type,
      input.title,
      input.subtitle ?? null,
      input.lastMessageText ?? null,
      input.lastMessageAt ?? null,
      input.lastUpdateId,
      now,
      now
    )
}

export const loadTelegramRecentChats = (limit = 20): TelegramRecentChat[] => {
  const safeLimit = Math.max(1, Math.min(limit, 100))
  const database = getDb()
  const rows = database
    .prepare(
      `
      SELECT
        chat_id,
        type,
        title,
        subtitle,
        last_message_text,
        last_message_at,
        last_update_id,
        created_at,
        updated_at
      FROM telegram_recent_chats
      ORDER BY updated_at DESC, chat_id DESC
      LIMIT ?
    `
    )
    .all(safeLimit) as TelegramRecentChatRow[]

  return rows.map(toTelegramRecentChat)
}

export const createTelegramSession = (input: {
  id: string
  chatId: string
  threadId?: string | null
  activeRunId?: string | null
  lastInboundMessageId?: number | null
  lastOutboundMessageId?: number | null
  lastOutboundKind?: string | null
  startedAt?: number
  lastInboundAt?: number
  lastCompletedAt?: number | null
  carryoverSummary?: string | null
  sessionSummary?: string | null
  summaryUpdatedAt?: number | null
  resumedFromSessionId?: string | null
  resumeConfidence?: number | null
  status?: string
  lastError?: string | null
}) => {
  const database = getDb()
  const startedAt = input.startedAt ?? Date.now()
  const lastInboundAt = input.lastInboundAt ?? startedAt
  const status = input.status?.trim() || 'active'
  database
    .prepare(
      `
      INSERT INTO telegram_sessions (
        id,
        chat_id,
        thread_id,
        active_run_id,
        last_inbound_message_id,
        last_outbound_message_id,
        last_outbound_kind,
        started_at,
        last_inbound_at,
        last_completed_at,
        carryover_summary,
        session_summary,
        summary_updated_at,
        resumed_from_session_id,
        resume_confidence,
        status,
        last_error,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    )
    .run(
      input.id,
      input.chatId,
      input.threadId ?? null,
      input.activeRunId ?? null,
      input.lastInboundMessageId ?? null,
      input.lastOutboundMessageId ?? null,
      input.lastOutboundKind ?? null,
      startedAt,
      lastInboundAt,
      input.lastCompletedAt ?? null,
      input.carryoverSummary ?? null,
      input.sessionSummary ?? null,
      input.summaryUpdatedAt ?? null,
      input.resumedFromSessionId ?? null,
      input.resumeConfidence ?? null,
      status,
      input.lastError ?? null,
      startedAt,
      startedAt
    )

  return getTelegramSessionById(input.id)
}

export const getTelegramSessionById = (id: string): TelegramSession | null => {
  const database = getDb()
  const row = database
    .prepare(
      `
      SELECT
        id,
        chat_id,
        thread_id,
        active_run_id,
        last_inbound_message_id,
        last_outbound_message_id,
        last_outbound_kind,
        started_at,
        last_inbound_at,
        last_completed_at,
        carryover_summary,
        session_summary,
        summary_updated_at,
        resumed_from_session_id,
        resume_confidence,
        status,
        last_error,
        created_at,
        updated_at
      FROM telegram_sessions
      WHERE id = ?
    `
    )
    .get(id) as TelegramSessionRow | undefined

  return row ? toTelegramSession(row) : null
}

export const getLatestTelegramSession = (chatId: string): TelegramSession | null => {
  const database = getDb()
  const row = database
    .prepare(
      `
      SELECT
        id,
        chat_id,
        thread_id,
        active_run_id,
        last_inbound_message_id,
        last_outbound_message_id,
        last_outbound_kind,
        started_at,
        last_inbound_at,
        last_completed_at,
        carryover_summary,
        session_summary,
        summary_updated_at,
        resumed_from_session_id,
        resume_confidence,
        status,
        last_error,
        created_at,
        updated_at
      FROM telegram_sessions
      WHERE chat_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `
    )
    .get(chatId) as TelegramSessionRow | undefined

  return row ? toTelegramSession(row) : null
}

export const loadRecentTelegramSessions = (chatId: string, limit = 5): TelegramSession[] => {
  const safeLimit = Math.max(1, Math.min(limit, 20))
  const database = getDb()
  const rows = database
    .prepare(
      `
      SELECT
        id,
        chat_id,
        thread_id,
        active_run_id,
        last_inbound_message_id,
        last_outbound_message_id,
        last_outbound_kind,
        started_at,
        last_inbound_at,
        last_completed_at,
        carryover_summary,
        session_summary,
        summary_updated_at,
        resumed_from_session_id,
        resume_confidence,
        status,
        last_error,
        created_at,
        updated_at
      FROM telegram_sessions
      WHERE chat_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `
    )
    .all(chatId, safeLimit) as TelegramSessionRow[]

  return rows.map(toTelegramSession)
}

export const getTelegramSessionByThreadId = (threadId: string): TelegramSession | null => {
  const database = getDb()
  const row = database
    .prepare(
      `
      SELECT
        id,
        chat_id,
        thread_id,
        active_run_id,
        last_inbound_message_id,
        last_outbound_message_id,
        last_outbound_kind,
        started_at,
        last_inbound_at,
        last_completed_at,
        carryover_summary,
        session_summary,
        summary_updated_at,
        resumed_from_session_id,
        resume_confidence,
        status,
        last_error,
        created_at,
        updated_at
      FROM telegram_sessions
      WHERE thread_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `
    )
    .get(threadId) as TelegramSessionRow | undefined

  return row ? toTelegramSession(row) : null
}

export const getTelegramSessionByActiveRun = (runId: string): TelegramSession | null => {
  const database = getDb()
  const row = database
    .prepare(
      `
      SELECT
        id,
        chat_id,
        thread_id,
        active_run_id,
        last_inbound_message_id,
        last_outbound_message_id,
        last_outbound_kind,
        started_at,
        last_inbound_at,
        last_completed_at,
        carryover_summary,
        session_summary,
        summary_updated_at,
        resumed_from_session_id,
        resume_confidence,
        status,
        last_error,
        created_at,
        updated_at
      FROM telegram_sessions
      WHERE active_run_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `
    )
    .get(runId) as TelegramSessionRow | undefined

  return row ? toTelegramSession(row) : null
}

export const assignTelegramSessionThread = (
  sessionId: string,
  threadId: string,
  updatedAt?: number
) => {
  const now = updatedAt ?? Date.now()
  const database = getDb()
  database
    .prepare(
      `
      UPDATE telegram_sessions
      SET thread_id = ?, updated_at = ?
      WHERE id = ?
    `
    )
    .run(threadId, now, sessionId)
  return now
}

export const setTelegramSessionActiveRun = (
  sessionId: string,
  activeRunId: string | null,
  updatedAt?: number
) => {
  const now = updatedAt ?? Date.now()
  const database = getDb()
  database
    .prepare(
      `
      UPDATE telegram_sessions
      SET active_run_id = ?, updated_at = ?
      WHERE id = ?
    `
    )
    .run(activeRunId, now, sessionId)
  return now
}

export const recordTelegramSessionInbound = (input: {
  sessionId: string
  messageId?: number | null
  at?: number
}) => {
  const now = input.at ?? Date.now()
  const database = getDb()
  database
    .prepare(
      `
      UPDATE telegram_sessions
      SET
        last_inbound_message_id = COALESCE(?, last_inbound_message_id),
        last_inbound_at = ?,
        updated_at = ?
      WHERE id = ?
    `
    )
    .run(input.messageId ?? null, now, now, input.sessionId)
  return now
}

export const recordTelegramSessionOutbound = (input: {
  sessionId: string
  messageId?: number | null
  kind?: string | null
  at?: number
}) => {
  const now = input.at ?? Date.now()
  const database = getDb()
  database
    .prepare(
      `
      UPDATE telegram_sessions
      SET
        last_outbound_message_id = COALESCE(?, last_outbound_message_id),
        last_outbound_kind = ?,
        updated_at = ?
      WHERE id = ?
    `
    )
    .run(input.messageId ?? null, input.kind ?? null, now, input.sessionId)
  return now
}

export const setTelegramSessionCarryoverSummary = (
  sessionId: string,
  summary: string | null,
  updatedAt?: number
) => {
  const now = updatedAt ?? Date.now()
  const database = getDb()
  database
    .prepare(
      `
      UPDATE telegram_sessions
      SET carryover_summary = ?, updated_at = ?
      WHERE id = ?
    `
    )
    .run(summary, now, sessionId)
  return now
}

export const setTelegramSessionSummary = (input: {
  sessionId: string
  summary: string | null
  summaryUpdatedAt?: number | null
  resumedFromSessionId?: string | null
  resumeConfidence?: number | null
  updatedAt?: number
}) => {
  const now = input.updatedAt ?? Date.now()
  const summaryUpdatedAt = input.summary == null
    ? null
    : (input.summaryUpdatedAt ?? now)
  const database = getDb()
  database
    .prepare(
      `
      UPDATE telegram_sessions
      SET
        session_summary = ?,
        summary_updated_at = ?,
        resumed_from_session_id = COALESCE(?, resumed_from_session_id),
        resume_confidence = COALESCE(?, resume_confidence),
        updated_at = ?
      WHERE id = ?
    `
    )
    .run(
      input.summary,
      summaryUpdatedAt,
      input.resumedFromSessionId ?? null,
      input.resumeConfidence ?? null,
      now,
      input.sessionId
    )
  return now
}

export const finalizeTelegramSessionRun = (input: {
  sessionId: string
  completedAt?: number
  errorMessage?: string | null
  status?: string
}) => {
  const completedAt = input.completedAt ?? Date.now()
  const status = input.status?.trim() || (input.errorMessage ? 'error' : 'active')
  const database = getDb()
  database
    .prepare(
      `
      UPDATE telegram_sessions
      SET
        active_run_id = NULL,
        last_completed_at = ?,
        status = ?,
        last_error = ?,
        updated_at = ?
      WHERE id = ?
    `
    )
    .run(
      completedAt,
      status,
      input.errorMessage ?? null,
      completedAt,
      input.sessionId
    )
  return completedAt
}

const toWorkflowRunSummary = (row: WorkflowRunRow): WorkflowRunSummary => ({
  id: row.id,
  workflowName: row.workflow_name,
  workflowFileSlug: row.workflow_file_slug,
  triggerType: row.trigger_type,
  triggerValue: row.trigger_value,
  status: row.status,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  totalInputTokens: row.total_input_tokens,
  totalCachedInputTokens: row.total_cached_input_tokens,
  totalOutputTokens: row.total_output_tokens,
  sessionThreadId: row.session_thread_id,
  sessionFilePath: row.session_file_path,
  errorMessage: row.error_message
})

export const createWorkflowRun = (input: {
  id: string
  workflowName: string
  workflowFileSlug: string
  triggerType: WorkflowTriggerType
  triggerValue?: string | null
  startedAt?: number
}) => {
  const database = getDb()
  const startedAt = input.startedAt ?? Date.now()

  database
    .prepare(
      `
      INSERT INTO runs (
        id,
        workflow_name,
        workflow_file_slug,
        trigger_type,
        trigger_value,
        status,
        started_at
      )
      VALUES (?, ?, ?, ?, ?, 'running', ?)
    `
    )
    .run(
      input.id,
      input.workflowName,
      input.workflowFileSlug,
      input.triggerType,
      input.triggerValue ?? null,
      startedAt
    )
}

export const setWorkflowRunSessionReference = (
  runId: string,
  sessionThreadId: string | null,
  sessionFilePath: string | null
) => {
  const database = getDb()
  database
    .prepare(
      `
      UPDATE runs
      SET session_thread_id = ?, session_file_path = ?
      WHERE id = ?
    `
    )
    .run(sessionThreadId, sessionFilePath, runId)
}

export const completeWorkflowRun = (input: {
  runId: string
  status: Exclude<WorkflowRunStatus, 'running'>
  totalInputTokens?: number
  totalCachedInputTokens?: number
  totalOutputTokens?: number
  completedAt?: number
  sessionThreadId?: string | null
  sessionFilePath?: string | null
  errorMessage?: string | null
}) => {
  const database = getDb()
  const completedAt = input.completedAt ?? Date.now()

  database
    .prepare(
      `
      UPDATE runs
      SET
        status = ?,
        completed_at = ?,
        total_input_tokens = ?,
        total_cached_input_tokens = ?,
        total_output_tokens = ?,
        session_thread_id = COALESCE(?, session_thread_id),
        session_file_path = COALESCE(?, session_file_path),
        error_message = ?
      WHERE id = ?
    `
    )
    .run(
      input.status,
      completedAt,
      input.totalInputTokens ?? 0,
      input.totalCachedInputTokens ?? 0,
      input.totalOutputTokens ?? 0,
      input.sessionThreadId ?? null,
      input.sessionFilePath ?? null,
      input.errorMessage ?? null,
      input.runId
    )
}

export const finalizeStaleRunningWorkflowRuns = (input?: {
  completedAt?: number
  errorMessage?: string
}) => {
  const database = getDb()
  const completedAt = input?.completedAt ?? Date.now()
  const errorMessage = input?.errorMessage
    ?? 'Recovered on startup: previous workflow process ended before finalizing this run.'

  const result = database
    .prepare(
      `
      UPDATE runs
      SET
        status = 'failed',
        completed_at = ?,
        error_message = CASE
          WHEN error_message IS NULL OR TRIM(error_message) = '' THEN ?
          ELSE error_message
        END
      WHERE status = 'running'
    `
    )
    .run(completedAt, errorMessage)

  return result.changes
}

export const getWorkflowRunById = (runId: string): WorkflowRunSummary | null => {
  const database = getDb()
  const row = database
    .prepare(
      `
      SELECT
        id,
        workflow_name,
        workflow_file_slug,
        trigger_type,
        trigger_value,
        status,
        started_at,
        completed_at,
        total_input_tokens,
        total_cached_input_tokens,
        total_output_tokens,
        session_thread_id,
        session_file_path,
        error_message
      FROM runs
      WHERE id = ?
    `
    )
    .get(runId) as WorkflowRunRow | undefined

  if (!row) {
    return null
  }

  return toWorkflowRunSummary(row)
}

export const loadWorkflowRunsPageBySlug = (
  workflowFileSlug: string,
  options: {
    limit?: number
    offset?: number
  } = {}
) => {
  const safeLimit = Math.max(1, Math.min(options.limit ?? 50, 200))
  const safeOffset = Math.max(0, Math.floor(options.offset ?? 0))
  const database = getDb()
  const rows = database
    .prepare(
      `
      SELECT
        id,
        workflow_name,
        workflow_file_slug,
        trigger_type,
        trigger_value,
        status,
        started_at,
        completed_at,
        total_input_tokens,
        total_cached_input_tokens,
        total_output_tokens,
        session_thread_id,
        session_file_path,
        error_message
      FROM runs
      WHERE workflow_file_slug = ?
      ORDER BY started_at DESC, id DESC
      LIMIT ?
      OFFSET ?
    `
    )
    .all(workflowFileSlug, safeLimit + 1, safeOffset) as WorkflowRunRow[]

  const hasMore = rows.length > safeLimit
  const runs = rows
    .slice(0, safeLimit)
    .map(toWorkflowRunSummary)

  return {
    runs,
    hasMore,
    nextOffset: hasMore ? safeOffset + runs.length : null
  }
}

export const loadWorkflowRunsBySlug = (workflowFileSlug: string, limit = 50): WorkflowRunSummary[] => {
  const page = loadWorkflowRunsPageBySlug(workflowFileSlug, {
    limit,
    offset: 0
  })

  return page.runs
}
