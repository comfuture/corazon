import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ensureAgentBootstrap } from './agent-bootstrap.ts'

const SESSIONS_DIR = 'sessions'
const SESSION_FILE_SUFFIX = '.jsonl'
const SESSION_FILE_PREFIX = 'rollout-'

const listFilesRecursively = (directory: string, output: string[]) => {
  if (!existsSync(directory)) {
    return
  }

  const entries = readdirSync(directory, { withFileTypes: true })
  for (const entry of entries) {
    const nextPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      listFilesRecursively(nextPath, output)
      continue
    }
    if (entry.isFile()) {
      output.push(nextPath)
    }
  }
}

export const resolveSessionsRootDirectory = () => join(ensureAgentBootstrap(), SESSIONS_DIR)

export const findSessionFileByThreadId = (threadId: string) => {
  const normalized = threadId.trim()
  if (!normalized) {
    return null
  }

  const suffix = `-${normalized}${SESSION_FILE_SUFFIX}`
  const files: string[] = []
  listFilesRecursively(resolveSessionsRootDirectory(), files)

  let selectedPath: string | null = null
  let selectedMtime = 0

  for (const filePath of files) {
    const filename = basename(filePath)
    if (!filename.startsWith(SESSION_FILE_PREFIX) || !filename.endsWith(suffix)) {
      continue
    }

    const mtime = statSync(filePath).mtimeMs
    if (mtime >= selectedMtime) {
      selectedPath = filePath
      selectedMtime = mtime
    }
  }

  return selectedPath
}
