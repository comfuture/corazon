#!/usr/bin/env node
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_EXCLUDES = new Set(['log', 'logs', 'tmp', 'sessions'])
const SESSION_LOG_PATTERN = /^session-.*\.jsonl$/

const getDefaultRuntimeRoot = () => join(homedir(), '.corazon')

const getDefaultCodexHome = () => {
  const configured = process.env.CODEX_HOME?.trim()
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

const copySymlink = (source, destination, overwrite) => {
  if (!overwrite && existsSync(destination)) {
    return false
  }
  const target = readlinkSync(source)
  try {
    symlinkSync(target, destination)
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      return false
    }
    throw error
  }
  return true
}

const copyFile = (source, destination, overwrite) => {
  if (!overwrite && existsSync(destination)) {
    return false
  }
  copyFileSync(source, destination)
  return true
}

const shouldSkipEntry = (name, isDirectory) => {
  if (DEFAULT_EXCLUDES.has(name)) {
    return true
  }
  if (!isDirectory && SESSION_LOG_PATTERN.test(name)) {
    return true
  }
  return false
}

const copyTree = (sourceRoot, destinationRoot, overwrite) => {
  const stats = lstatSync(sourceRoot)
  if (stats.isSymbolicLink()) {
    const didCopy = copySymlink(sourceRoot, destinationRoot, overwrite)
    return {
      copied: didCopy ? 1 : 0,
      skipped: didCopy ? 0 : 1
    }
  }
  if (!stats.isDirectory()) {
    const didCopy = copyFile(sourceRoot, destinationRoot, overwrite)
    return {
      copied: didCopy ? 1 : 0,
      skipped: didCopy ? 0 : 1
    }
  }

  if (!existsSync(destinationRoot)) {
    mkdirSync(destinationRoot, { recursive: true })
  }

  let copied = 0
  let skipped = 0

  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    const entryName = entry.name
    const isDirectory = entry.isDirectory()
    if (shouldSkipEntry(entryName, isDirectory)) {
      skipped += 1
      continue
    }
    const sourcePath = join(sourceRoot, entryName)
    const destinationPath = join(destinationRoot, entryName)
    if (entry.isSymbolicLink()) {
      const didCopy = copySymlink(sourcePath, destinationPath, overwrite)
      copied += didCopy ? 1 : 0
      skipped += didCopy ? 0 : 1
      continue
    }
    if (isDirectory) {
      const result = copyTree(sourcePath, destinationPath, overwrite)
      copied += result.copied
      skipped += result.skipped
      continue
    }
    const didCopy = copyFile(sourcePath, destinationPath, overwrite)
    copied += didCopy ? 1 : 0
    skipped += didCopy ? 0 : 1
  }

  return { copied, skipped }
}

const printUsage = () => {
  console.log(`corazon setup

Usage:
  corazon setup [options]

Options:
  -r, --runtime-root <path>  Destination runtime root directory
  -c, --codex-home <path>    Source Codex home directory
  --overwrite, --force       Overwrite existing files
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
  const targetCodexHome = join(runtimeRoot, '.codex')

  log(options, `Corazon setup starting...`)
  log(options, `Runtime root: ${runtimeRoot}`)
  log(options, `Codex home: ${codexHome}`)

  if (!existsSync(codexHome)) {
    console.error(`Codex home not found at ${codexHome}`)
    console.error(`Run codex once or set --codex-home to the correct path.`)
    process.exit(1)
  }

  mkdirSync(runtimeRoot, { recursive: true })
  mkdirSync(targetCodexHome, { recursive: true })
  mkdirSync(join(runtimeRoot, 'data'), { recursive: true })
  mkdirSync(join(runtimeRoot, 'threads'), { recursive: true })

  const result = copyTree(codexHome, targetCodexHome, options.overwrite)

  log(options, `Copied ${result.copied} item(s), skipped ${result.skipped} item(s).`)
  log(options, `Done. Mount ${runtimeRoot} into the container runtime root.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2))
}
