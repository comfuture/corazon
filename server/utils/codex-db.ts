import Database from 'better-sqlite3'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Usage } from '@openai/codex-sdk'
import { CODEX_ITEM_PART, type CodexUIMessage } from '@@/types/codex-ui'

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

type ThreadRow = {
  id: string
  title: string | null
  model: string | null
  working_directory: string | null
  created_at: number
  updated_at: number
  total_input_tokens: number
  total_cached_input_tokens: number
  total_output_tokens: number
  turn_count: number
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

const getThreadRootDirectory = () => {
  const home = homedir()
  const platform = process.platform
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Corazon', 'threads')
  }
  if (platform === 'win32') {
    const appData = process.env.APPDATA || process.env.LOCALAPPDATA || join(home, 'AppData', 'Roaming')
    return join(appData, 'Corazon', 'threads')
  }
  return join(home, '.corazon', 'threads')
}

let db: Database.Database | null = null

const getDb = () => {
  if (db) {
    return db
  }

  const dataDir = join(process.cwd(), '.data')
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

    CREATE INDEX IF NOT EXISTS threads_updated_at_idx ON threads(updated_at DESC);
    CREATE INDEX IF NOT EXISTS messages_thread_seq_idx ON messages(thread_id, seq);
  `)

  const columns = db.prepare('PRAGMA table_info(threads)').all() as { name: string }[]
  const hasColumn = (name: string) => columns.some(column => column.name === name)

  if (!hasColumn('model')) {
    db.exec('ALTER TABLE threads ADD COLUMN model TEXT')
  }

  if (!hasColumn('working_directory')) {
    db.exec('ALTER TABLE threads ADD COLUMN working_directory TEXT')
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
  const database = getDb()
  database.prepare('DELETE FROM threads WHERE id = ?').run(threadId)

  const threadDirectory = join(getThreadRootDirectory(), threadId)
  if (existsSync(threadDirectory)) {
    rmSync(threadDirectory, { recursive: true, force: true })
  }
}

export const loadThreadSummaries = (): ThreadSummary[] => {
  const database = getDb()
  const rows = database
    .prepare(
      `
      SELECT
        id,
        title,
        model,
        working_directory,
        created_at,
        updated_at,
        total_input_tokens,
        total_cached_input_tokens,
        total_output_tokens,
        turn_count
      FROM threads
      ORDER BY updated_at DESC
    `
    )
    .all() as ThreadRow[]

  return rows.map(row => ({
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
  }))
}
