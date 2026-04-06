import { copyFileSync, existsSync, lstatSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'

const AUTH_SEED_COPY_ALIASES = new Set(['copy', 'copy-once', 'seed-copy'])

const pathExists = (path) => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

export const resolveAuthSeedMode = (rawMode = process.env.CORAZON_AUTH_SEED_MODE) => {
  const raw = rawMode?.trim().toLowerCase()
  if (raw && AUTH_SEED_COPY_ALIASES.has(raw)) {
    return 'copy-once'
  }
  return 'link'
}

export const ensureCopiedAuthFile = ({
  sourcePath,
  destinationPath,
  overwrite = false,
  skipIfExistingNonSymlink = true,
  onSkip,
  onCopy
}) => {
  if (!existsSync(sourcePath)) {
    onSkip?.()
    return 'missing-source'
  }

  const destinationExists = pathExists(destinationPath)

  if (destinationExists && !overwrite && skipIfExistingNonSymlink) {
    try {
      const destinationStats = lstatSync(destinationPath)
      if (!destinationStats.isSymbolicLink()) {
        onSkip?.()
        return 'skipped'
      }
    } catch {
      // Fall through and try to replace the existing entry.
    }
  }

  if (destinationExists) {
    rmSync(destinationPath, { recursive: true, force: true })
  }

  mkdirSync(dirname(destinationPath), { recursive: true })
  copyFileSync(sourcePath, destinationPath)
  onCopy?.()
  return 'copied'
}
