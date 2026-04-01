import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, parse, resolve } from 'node:path'

let cachedCorazonRootDir: string | null = null
let cachedCorazonRuntimeRootDir: string | null = null

const getLegacyCorazonRootDir = () => join(homedir(), '.corazon')

const getLinuxCorazonRootDir = () => {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim()
  if (xdgConfigHome) {
    return join(xdgConfigHome, 'corazon')
  }
  return join(homedir(), '.config', 'corazon')
}

const getWindowsCorazonRootDir = () => {
  const appData = process.env.APPDATA?.trim()
  if (appData) {
    return join(appData, 'Corazon')
  }
  return join(homedir(), 'AppData', 'Roaming', 'Corazon')
}

const normalizeCorazonRootCandidate = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) {
    return trimmed
  }

  const resolved = resolve(trimmed)
  const segments = resolved.split(/[\\/]+/).filter(Boolean)
  if (segments.length === 0) {
    return resolved
  }

  for (let index = 1; index < segments.length; index += 1) {
    const current = segments[index]?.toLowerCase()
    const previous = segments[index - 1]?.toLowerCase()

    if (current !== 'threads') {
      continue
    }
    if (previous !== 'corazon' && previous !== '.corazon') {
      continue
    }

    const rootInfo = parse(resolved).root
    const head = segments.slice(0, index)
    if (rootInfo) {
      const drive = rootInfo.replace(/[\\/]/g, '').toLowerCase()
      if (head[0]?.toLowerCase() === drive) {
        head.shift()
      }
      return join(rootInfo, ...head)
    }
    return join(...head)
  }

  return resolved
}

const normalizePathCandidate = (value: string) => {
  const trimmed = value.trim()
  return trimmed ? resolve(trimmed) : trimmed
}

const getDefaultRuntimeRootBasename = (corazonRootDir: string) => {
  const currentName = basename(corazonRootDir)
  if (!currentName) {
    return '.corazon-runtime'
  }
  if (currentName.startsWith('.') || currentName === currentName.toLowerCase()) {
    return `${currentName}-runtime`
  }
  return `${currentName}Runtime`
}

const getDefaultCorazonRuntimeRootDir = () => {
  const corazonRootDir = resolveCorazonRootDir()
  return join(dirname(corazonRootDir), getDefaultRuntimeRootBasename(corazonRootDir))
}

export const getPlatformDefaultCorazonRootDir = () => {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Corazon')
  }
  if (process.platform === 'win32') {
    return getWindowsCorazonRootDir()
  }
  return getLinuxCorazonRootDir()
}

export const resolveCorazonRootDir = () => {
  if (cachedCorazonRootDir) {
    return cachedCorazonRootDir
  }

  const configuredRoot = process.env.CORAZON_ROOT_DIR?.trim()
  if (configuredRoot) {
    cachedCorazonRootDir = normalizeCorazonRootCandidate(configuredRoot)
    return cachedCorazonRootDir
  }

  const legacyRoot = getLegacyCorazonRootDir()
  if (process.platform === 'darwin') {
    cachedCorazonRootDir = legacyRoot
    return cachedCorazonRootDir
  }

  if (existsSync(legacyRoot)) {
    cachedCorazonRootDir = legacyRoot
    return cachedCorazonRootDir
  }

  cachedCorazonRootDir = getPlatformDefaultCorazonRootDir()
  return cachedCorazonRootDir
}

export const resolveCorazonRuntimeRootDir = () => {
  if (cachedCorazonRuntimeRootDir) {
    return cachedCorazonRuntimeRootDir
  }

  const configuredRoot = process.env.CORAZON_RUNTIME_ROOT_DIR?.trim()
  if (configuredRoot) {
    cachedCorazonRuntimeRootDir = normalizePathCandidate(configuredRoot)
    return cachedCorazonRuntimeRootDir
  }

  cachedCorazonRuntimeRootDir = getDefaultCorazonRuntimeRootDir()
  return cachedCorazonRuntimeRootDir
}

export const getDefaultCodexSeedSourceDir = () => join(homedir(), '.codex')

export const resolveCorazonSkillsDir = () =>
  join(resolveCorazonRootDir(), 'skills')

export const resolveCorazonScriptsDir = () =>
  join(resolveCorazonRootDir(), 'scripts')

export const resolveCorazonThreadsDir = () =>
  process.env.CORAZON_THREADS_DIR?.trim()
    ? normalizePathCandidate(process.env.CORAZON_THREADS_DIR)
    : join(resolveCorazonRuntimeRootDir(), 'threads')

export const resolveWorkflowLocalDataDir = () =>
  process.env.WORKFLOW_LOCAL_DATA_DIR?.trim()
    ? normalizePathCandidate(process.env.WORKFLOW_LOCAL_DATA_DIR)
    : join(resolveCorazonRuntimeRootDir(), 'workflow-data')

export const ensureCorazonRuntimeEnvironment = () => {
  const corazonRootDir = resolveCorazonRootDir()
  const runtimeRootDir = resolveCorazonRuntimeRootDir()
  const threadsDir = resolveCorazonThreadsDir()
  const workflowLocalDataDir = resolveWorkflowLocalDataDir()

  if (!process.env.CORAZON_ROOT_DIR?.trim()) {
    process.env.CORAZON_ROOT_DIR = corazonRootDir
  }
  if (!process.env.CORAZON_RUNTIME_ROOT_DIR?.trim()) {
    process.env.CORAZON_RUNTIME_ROOT_DIR = runtimeRootDir
  }
  if (!process.env.CORAZON_THREADS_DIR?.trim()) {
    process.env.CORAZON_THREADS_DIR = threadsDir
  }
  if (!process.env.WORKFLOW_LOCAL_DATA_DIR?.trim()) {
    process.env.WORKFLOW_LOCAL_DATA_DIR = workflowLocalDataDir
  }

  return {
    corazonRootDir,
    runtimeRootDir,
    threadsDir,
    workflowLocalDataDir
  }
}
