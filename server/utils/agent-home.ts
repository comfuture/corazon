import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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
    cachedCorazonRootDir = configuredRoot
    return cachedCorazonRootDir
  }

  const legacyRoot = getLegacyCorazonRootDir()
  if (existsSync(legacyRoot)) {
    cachedCorazonRootDir = legacyRoot
    return cachedCorazonRootDir
  }

  cachedCorazonRootDir = getPlatformDefaultCorazonRootDir()
  return cachedCorazonRootDir
}

export const getDefaultCodexSeedSourceDir = () => join(homedir(), '.codex')
