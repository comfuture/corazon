#!/usr/bin/env node
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { normalizeImageGenerationFeatureConfig } from '../lib/image-generation-config.mjs'

const SEED_DIRECTORIES = ['skills', 'rules', 'vendor_imports']
const AUTH_FILE = 'auth.json'
const AGENTS_FILE = 'AGENTS.md'
const AGENTS_SKELETON_FILE = 'agent-behavior.md'
const SYSTEM_SKILL_SYNC_NAMES = ['shared-memory', 'manage-workflows']
const LEGACY_MEMORY_GUIDANCE_PATTERN = /## Shared memory[\s\S]*?(?=\n## |\n# |$)/i
const UPDATED_SHARED_MEMORY_GUIDANCE = [
  '## Shared memory',
  '- For long-term memory, use the `shared-memory` skill.',
  '- Treat Corazon memory APIs (`/api/memory/*`) as the shared memory interface across all threads.',
  '- Memory backend is `mem0` with ChromaDB vector storage; do not bypass it with direct file edits.',
  '- For memory reads/writes in a task, follow the skill workflow: `ensure`, then `search`, then `upsert`.',
  '- Add memory when new stable facts/preferences/decisions emerge; search memory when prior context is needed.'
].join('\n')

const getPlatformDefaultRuntimeRoot = () => {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Corazon')
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim()
    if (appData) {
      return join(appData, 'Corazon')
    }
    return join(homedir(), 'AppData', 'Roaming', 'Corazon')
  }
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim()
  if (xdgConfigHome) {
    return join(xdgConfigHome, 'corazon')
  }
  return join(homedir(), '.config', 'corazon')
}

const getDefaultRuntimeRoot = () => {
  const configured = process.env.CORAZON_ROOT_DIR?.trim()
  if (configured) {
    return configured
  }
  const legacyRoot = join(homedir(), '.corazon')
  if (process.platform === 'darwin') {
    return legacyRoot
  }
  if (existsSync(legacyRoot)) {
    return legacyRoot
  }
  return getPlatformDefaultRuntimeRoot()
}

const getDefaultCodexHome = () => {
  const configured = process.env.CORAZON_CODEX_SEED_SOURCE?.trim()
  if (configured) {
    return configured
  }
  return join(homedir(), '.codex')
}

const parseArgs = (args) => {
  const options = {
    runtimeRoot: null,
    codexHome: null,
    overwrite: false,
    quiet: false
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--runtime-root' || arg === '-r') {
      options.runtimeRoot = args[index + 1]
      index += 1
      continue
    }
    if (arg.startsWith('--runtime-root=')) {
      options.runtimeRoot = arg.split('=', 2)[1]
      continue
    }
    if (arg === '--codex-home' || arg === '-c') {
      options.codexHome = args[index + 1]
      index += 1
      continue
    }
    if (arg.startsWith('--codex-home=')) {
      options.codexHome = arg.split('=', 2)[1]
      continue
    }
    if (arg === '--overwrite' || arg === '--force') {
      options.overwrite = true
      continue
    }
    if (arg === '--quiet' || arg === '-q') {
      options.quiet = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    options.help = true
  }

  return options
}

const log = (state, message) => {
  if (!state.quiet) {
    console.log(message)
  }
}

const pathExists = (targetPath) => {
  try {
    lstatSync(targetPath)
    return true
  } catch {
    return false
  }
}

const getSymlinkTarget = (sourcePath, destinationPath) => {
  const relativeTarget = relative(dirname(destinationPath), sourcePath)
  return relativeTarget || '.'
}

const shouldRelinkFile = (sourcePath, destinationPath) => {
  try {
    const destinationStats = lstatSync(destinationPath)
    if (!destinationStats.isSymbolicLink()) {
      return false
    }
    const existingTarget = readlinkSync(destinationPath)
    return resolvePath(dirname(destinationPath), existingTarget) !== sourcePath
  } catch {
    return false
  }
}

const copyDirectoryRecursive = (sourceDir, destinationDir, overwrite, counters) => {
  mkdirSync(destinationDir, { recursive: true })
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = join(sourceDir, entry.name)
    const destinationPath = join(destinationDir, entry.name)
    if (entry.isDirectory()) {
      copyDirectoryRecursive(sourcePath, destinationPath, overwrite, counters)
      continue
    }
    if (entry.isSymbolicLink()) {
      if (existsSync(destinationPath) && !overwrite) {
        counters.skipped += 1
        continue
      }
      if (existsSync(destinationPath)) {
        rmSync(destinationPath, { recursive: true, force: true })
      }
      const linkTarget = readlinkSync(sourcePath)
      symlinkSync(linkTarget, destinationPath)
      counters.copied += 1
      continue
    }
    if (existsSync(destinationPath) && !overwrite) {
      counters.skipped += 1
      continue
    }
    copyFileSync(sourcePath, destinationPath)
    counters.copied += 1
  }
}

const ensureSeededFile = (sourcePath, destinationPath, overwrite, counters) => {
  if (!existsSync(sourcePath)) {
    counters.skipped += 1
    return false
  }
  if (existsSync(destinationPath) && !overwrite) {
    counters.skipped += 1
    return false
  }
  mkdirSync(dirname(destinationPath), { recursive: true })
  copyFileSync(sourcePath, destinationPath)
  counters.copied += 1
  return true
}

const ensureSeededDirectory = (sourcePath, destinationPath, overwrite, counters) => {
  if (!existsSync(sourcePath)) {
    counters.skipped += 1
    return
  }
  if (existsSync(destinationPath) && !overwrite) {
    counters.skipped += 1
    return
  }
  if (existsSync(destinationPath) && overwrite) {
    rmSync(destinationPath, { recursive: true, force: true })
  }
  const sourceStats = lstatSync(sourcePath)
  if (!sourceStats.isDirectory()) {
    counters.skipped += 1
    return
  }
  copyDirectoryRecursive(sourcePath, destinationPath, overwrite, counters)
}

const ensureLinkedAuthFile = (sourcePath, destinationPath, overwrite, counters) => {
  if (!existsSync(sourcePath)) {
    counters.skipped += 1
    return
  }
  const shouldRelink = shouldRelinkFile(sourcePath, destinationPath)
  if (pathExists(destinationPath) && !overwrite && !shouldRelink) {
    counters.skipped += 1
    return
  }
  if (pathExists(destinationPath)) {
    rmSync(destinationPath, { recursive: true, force: true })
  }
  symlinkSync(getSymlinkTarget(sourcePath, destinationPath), destinationPath, 'file')
  counters.linked += 1
}

const ensureAgentsFile = (runtimeRoot, overwrite, counters) => {
  const destinationPath = join(runtimeRoot, AGENTS_FILE)
  if (existsSync(destinationPath) && !overwrite) {
    counters.skipped += 1
    return
  }
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const skeletonPath = resolvePath(scriptDir, '..', 'templates', AGENTS_SKELETON_FILE)
  if (existsSync(skeletonPath)) {
    writeFileSync(destinationPath, readFileSync(skeletonPath, 'utf8'), 'utf8')
  } else {
    writeFileSync(destinationPath, '# Corazon Assistant\n', 'utf8')
  }
  counters.copied += 1
}

const migrateLegacyAgentsFile = (runtimeRoot) => {
  const destinationPath = join(runtimeRoot, AGENTS_FILE)
  if (!existsSync(destinationPath)) {
    return
  }

  const previous = readFileSync(destinationPath, 'utf8')
  if (!previous.includes('${CODEX_HOME}/MEMORY.md')) {
    return
  }

  const next = previous.match(LEGACY_MEMORY_GUIDANCE_PATTERN)
    ? previous.replace(LEGACY_MEMORY_GUIDANCE_PATTERN, `${UPDATED_SHARED_MEMORY_GUIDANCE}\n`)
    : `${previous.trimEnd()}\n\n${UPDATED_SHARED_MEMORY_GUIDANCE}\n`

  if (next !== previous) {
    writeFileSync(destinationPath, next, 'utf8')
  }
}

const ensureSkillScriptPermissions = (runtimeRoot) => {
  if (process.platform === 'win32') {
    return
  }

  const skillsDir = join(runtimeRoot, 'skills')
  if (!existsSync(skillsDir)) {
    return
  }

  const skillEntries = readdirSync(skillsDir, { withFileTypes: true })
  for (const skillEntry of skillEntries) {
    if (!skillEntry.isDirectory()) {
      continue
    }

    const scriptsDir = join(skillsDir, skillEntry.name, 'scripts')
    if (!existsSync(scriptsDir)) {
      continue
    }

    try {
      chmodSync(scriptsDir, 0o755)
    } catch {
      continue
    }

    const scriptEntries = readdirSync(scriptsDir, { withFileTypes: true })
    for (const scriptEntry of scriptEntries) {
      const path = join(scriptsDir, scriptEntry.name)
      if (scriptEntry.isDirectory()) {
        try {
          chmodSync(path, 0o755)
        } catch {
          // Ignore per-entry permission failures and continue.
        }
        continue
      }

      if (!scriptEntry.isFile()) {
        continue
      }

      if (!/\.(mjs|cjs|js|sh|bash|zsh|py|rb|pl)$/i.test(scriptEntry.name)) {
        continue
      }

      try {
        chmodSync(path, 0o755)
      } catch {
        // Ignore per-entry permission failures and continue.
      }
    }
  }
}

const ensureImageGenerationFeatureEnabled = (configPath) => {
  if (!existsSync(configPath)) {
    return false
  }

  const original = readFileSync(configPath, 'utf8')
  const { changed, output } = normalizeImageGenerationFeatureConfig(original)
  if (!changed) {
    return false
  }
  writeFileSync(configPath, output, 'utf8')

  return true
}

const printUsage = () => {
  console.log(`corazon setup

Usage:
  corazon setup [options]

Options:
  -r, --runtime-root <path>  Destination runtime root directory
  -c, --codex-home <path>    Source Codex home directory (default: ~/.codex)
  --overwrite, --force       Overwrite existing seeded files
  -q, --quiet                Suppress logs
  -h, --help                 Show this help

Examples:
  corazon setup --runtime-root ./.corazon
  corazon setup --codex-home ~/.codex
  corazon setup --runtime-root ./.docker-state/.corazon --codex-home ~/.codex
`)
}

export const run = (args = []) => {
  const options = parseArgs(args)
  if (options.help) {
    printUsage()
    return
  }

  const runtimeRoot = resolvePath(options.runtimeRoot || getDefaultRuntimeRoot())
  const codexHome = resolvePath(options.codexHome || getDefaultCodexHome())
  const counters = {
    copied: 0,
    linked: 0,
    skipped: 0
  }

  log(options, 'Corazon setup starting...')
  log(options, `Runtime root: ${runtimeRoot}`)
  log(options, `Codex seed source: ${codexHome}`)

  mkdirSync(runtimeRoot, { recursive: true })
  mkdirSync(join(runtimeRoot, 'data'), { recursive: true })
  mkdirSync(join(runtimeRoot, 'threads'), { recursive: true })
  mkdirSync(join(runtimeRoot, 'workflow-data'), { recursive: true })

  if (existsSync(codexHome)) {
    const configSeeded = ensureSeededFile(
      join(codexHome, 'config.toml'),
      join(runtimeRoot, 'config.toml'),
      options.overwrite,
      counters
    )

    for (const directoryName of SEED_DIRECTORIES) {
      ensureSeededDirectory(
        join(codexHome, directoryName),
        join(runtimeRoot, directoryName),
        options.overwrite,
        counters
      )
    }

    if (configSeeded || existsSync(join(runtimeRoot, 'config.toml'))) {
      const featureUpdated = ensureImageGenerationFeatureEnabled(join(runtimeRoot, 'config.toml'))
      if (featureUpdated) {
        log(options, 'Enabled `features.image_generation = true` in runtime config.toml.')
      }
    }

    ensureLinkedAuthFile(
      join(codexHome, AUTH_FILE),
      join(runtimeRoot, AUTH_FILE),
      options.overwrite,
      counters
    )
  } else {
    log(options, `Codex seed source not found: ${codexHome} (continuing without seed copy).`)
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url))
  for (const skillName of SYSTEM_SKILL_SYNC_NAMES) {
    ensureSeededDirectory(
      resolvePath(scriptDir, '..', 'templates', 'skills', skillName),
      join(runtimeRoot, 'skills', skillName),
      true,
      counters
    )
  }

  ensureAgentsFile(runtimeRoot, options.overwrite, counters)
  migrateLegacyAgentsFile(runtimeRoot)
  ensureSkillScriptPermissions(runtimeRoot)

  log(options, `Seeded/copied ${counters.copied} item(s), linked ${counters.linked} item(s), skipped ${counters.skipped} item(s).`)
  log(options, `Done. Mount ${runtimeRoot} into the container runtime root.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2))
}
