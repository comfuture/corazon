import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { getDefaultCodexSeedSourceDir, resolveCorazonRootDir } from './agent-home.ts'

const SEED_FILES = ['config.toml'] as const
const SEED_DIRECTORIES = ['skills', 'rules', 'vendor_imports'] as const
const AUTH_FILE = 'auth.json'
const AGENTS_FILE = 'AGENTS.md'

const DEFAULT_AGENTS_TEMPLATE = `# Corazon Agent Defaults

- Use Corazon runtime home as primary Codex home.
- Manage MCP servers from Settings > MCP.
- Manage local skills from Settings > Skill.
- Keep project instructions in repository AGENTS.md up to date.
`

let bootstrapDone = false

const copyDirectoryRecursive = (sourceDir: string, destinationDir: string) => {
  mkdirSync(destinationDir, { recursive: true })
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = join(sourceDir, entry.name)
    const destinationPath = join(destinationDir, entry.name)
    if (entry.isDirectory()) {
      copyDirectoryRecursive(sourcePath, destinationPath)
      continue
    }
    if (entry.isSymbolicLink()) {
      const linkTarget = readlinkSync(sourcePath)
      symlinkSync(linkTarget, destinationPath)
      continue
    }
    copyFileSync(sourcePath, destinationPath)
  }
}

const ensureLinkedAuthFile = (sourcePath: string, destinationPath: string) => {
  if (existsSync(destinationPath) || !existsSync(sourcePath)) {
    return
  }
  mkdirSync(dirname(destinationPath), { recursive: true })
  symlinkSync(sourcePath, destinationPath, 'file')
}

const ensureSeededFile = (sourcePath: string, destinationPath: string) => {
  if (existsSync(destinationPath) || !existsSync(sourcePath)) {
    return
  }
  mkdirSync(dirname(destinationPath), { recursive: true })
  copyFileSync(sourcePath, destinationPath)
}

const ensureSeededDirectory = (sourcePath: string, destinationPath: string) => {
  if (existsSync(destinationPath) || !existsSync(sourcePath)) {
    return
  }
  const stats = lstatSync(sourcePath)
  if (!stats.isDirectory()) {
    return
  }
  copyDirectoryRecursive(sourcePath, destinationPath)
}

const ensureDefaultAgentsFile = (agentHomeDir: string) => {
  const destinationPath = join(agentHomeDir, AGENTS_FILE)
  if (existsSync(destinationPath)) {
    return
  }
  writeFileSync(destinationPath, DEFAULT_AGENTS_TEMPLATE, 'utf8')
}

const getCodexSeedSourceDir = () => {
  const configured = process.env.CORAZON_CODEX_SEED_SOURCE?.trim()
  if (configured) {
    return configured
  }
  return getDefaultCodexSeedSourceDir()
}

export const ensureAgentBootstrap = () => {
  const agentHomeDir = resolveCorazonRootDir()
  if (bootstrapDone) {
    return agentHomeDir
  }

  mkdirSync(agentHomeDir, { recursive: true })
  mkdirSync(join(agentHomeDir, 'data'), { recursive: true })
  mkdirSync(join(agentHomeDir, 'threads'), { recursive: true })
  mkdirSync(join(agentHomeDir, 'workflow-data'), { recursive: true })

  const sourceRootDir = getCodexSeedSourceDir()
  if (existsSync(sourceRootDir)) {
    for (const filename of SEED_FILES) {
      ensureSeededFile(join(sourceRootDir, filename), join(agentHomeDir, filename))
    }
    for (const directoryName of SEED_DIRECTORIES) {
      ensureSeededDirectory(join(sourceRootDir, directoryName), join(agentHomeDir, directoryName))
    }
    ensureLinkedAuthFile(join(sourceRootDir, AUTH_FILE), join(agentHomeDir, AUTH_FILE))
  }

  ensureDefaultAgentsFile(agentHomeDir)
  bootstrapDone = true
  return agentHomeDir
}
