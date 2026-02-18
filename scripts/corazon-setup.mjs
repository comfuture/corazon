#!/usr/bin/env node
import {
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
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SEED_FILES = ['config.toml']
const SEED_DIRECTORIES = ['skills', 'rules', 'vendor_imports']
const AUTH_FILE = 'auth.json'
const AGENTS_FILE = 'AGENTS.md'
const AGENTS_SKELETON_FILE = 'agent-behavior.md'
const MEMORY_FILE = 'MEMORY.md'
const DEFAULT_MEMORY_SECTIONS = ['Facts', 'Preferences', 'Decisions', 'Tasks']

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
    return
  }
  if (existsSync(destinationPath) && !overwrite) {
    counters.skipped += 1
    return
  }
  mkdirSync(dirname(destinationPath), { recursive: true })
  copyFileSync(sourcePath, destinationPath)
  counters.copied += 1
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
  if (existsSync(destinationPath) && !overwrite) {
    counters.skipped += 1
    return
  }
  if (existsSync(destinationPath)) {
    rmSync(destinationPath, { recursive: true, force: true })
  }
  symlinkSync(sourcePath, destinationPath, 'file')
  counters.linked += 1
}

const buildDefaultMemoryContent = () =>
  `${DEFAULT_MEMORY_SECTIONS.map(section => `## ${section}`).join('\n\n')}\n`

const ensureMemoryFile = (runtimeRoot, counters) => {
  const destinationPath = join(runtimeRoot, MEMORY_FILE)
  if (existsSync(destinationPath)) {
    counters.skipped += 1
    return
  }
  writeFileSync(destinationPath, buildDefaultMemoryContent(), 'utf8')
  counters.copied += 1
}

const ensureAgentsFile = (runtimeRoot, overwrite, counters) => {
  const destinationPath = join(runtimeRoot, AGENTS_FILE)
  if (existsSync(destinationPath) && !overwrite) {
    counters.skipped += 1
    return
  }
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const skeletonPath = resolve(scriptDir, '..', 'templates', AGENTS_SKELETON_FILE)
  if (existsSync(skeletonPath)) {
    writeFileSync(destinationPath, readFileSync(skeletonPath, 'utf8'), 'utf8')
  } else {
    writeFileSync(destinationPath, '# Corazon Assistant\n', 'utf8')
  }
  counters.copied += 1
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
`)
}

export const run = (args = []) => {
  const options = parseArgs(args)
  if (options.help) {
    printUsage()
    return
  }

  const runtimeRoot = resolve(options.runtimeRoot || getDefaultRuntimeRoot())
  const codexHome = resolve(options.codexHome || getDefaultCodexHome())
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
    for (const filename of SEED_FILES) {
      ensureSeededFile(
        join(codexHome, filename),
        join(runtimeRoot, filename),
        options.overwrite,
        counters
      )
    }

    for (const directoryName of SEED_DIRECTORIES) {
      ensureSeededDirectory(
        join(codexHome, directoryName),
        join(runtimeRoot, directoryName),
        options.overwrite,
        counters
      )
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
  ensureSeededDirectory(
    resolve(scriptDir, '..', 'templates', 'skills', 'shared-memory'),
    join(runtimeRoot, 'skills', 'shared-memory'),
    options.overwrite,
    counters
  )

  ensureAgentsFile(runtimeRoot, options.overwrite, counters)
  ensureMemoryFile(runtimeRoot, counters)

  log(options, `Seeded/copied ${counters.copied} item(s), linked ${counters.linked} item(s), skipped ${counters.skipped} item(s).`)
  log(options, `Done. Mount ${runtimeRoot} into the container runtime root.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2))
}
