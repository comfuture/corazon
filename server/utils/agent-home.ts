import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, parse, resolve } from 'node:path'

let cachedCorazonRootDir: string | null = null

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

export const getDefaultCodexSeedSourceDir = () => join(homedir(), '.codex')

export const resolveWorkflowLocalDataDir = () =>
  join(resolveCorazonRootDir(), 'workflow-data')
