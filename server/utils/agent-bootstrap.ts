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
import { dirname, join } from 'node:path'
import { getDefaultCodexSeedSourceDir, resolveCorazonRootDir } from './agent-home.ts'

const SEED_FILES = ['config.toml'] as const
const SEED_DIRECTORIES = ['skills', 'rules', 'vendor_imports'] as const
const AUTH_FILE = 'auth.json'
const AGENTS_FILE = 'AGENTS.md'
const AGENTS_SKELETON_FILE = 'agent-behavior.md'
const SYSTEM_SKILL_SYNC_NAMES = new Set(['shared-memory', 'manage-workflows'])
const LEGACY_MEMORY_GUIDANCE_PATTERN = /## Shared memory[\s\S]*?(?=\n## |\n# |$)/i
const UPDATED_SHARED_MEMORY_GUIDANCE = [
  '## Shared memory',
  '- In app-server mode, prefer native dynamic tool `sharedMemory` for long-term memory (`ensure` -> `search` -> `upsert`).',
  '- In sdk mode or fallback paths, use the `shared-memory` skill.',
  '- Treat Corazon memory APIs (`/api/memory/*`) as the shared memory interface across all threads.',
  '- Memory backend is `mem0` with ChromaDB vector storage; do not bypass it with direct file edits.',
  '- For memory reads/writes in a task, follow `ensure`, then `search`, then `upsert`.',
  '- Add memory when new stable facts/preferences/decisions emerge; search memory when prior context is needed.'
].join('\n')

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

const syncDirectoryRecursive = (sourceDir: string, destinationDir: string) => {
  mkdirSync(destinationDir, { recursive: true })

  const sourceEntries = readdirSync(sourceDir, { withFileTypes: true })
  const sourceNames = new Set(sourceEntries.map(entry => entry.name))

  for (const entry of sourceEntries) {
    const sourcePath = join(sourceDir, entry.name)
    const destinationPath = join(destinationDir, entry.name)

    if (entry.isDirectory()) {
      if (existsSync(destinationPath) && !lstatSync(destinationPath).isDirectory()) {
        rmSync(destinationPath, { recursive: true, force: true })
      }
      syncDirectoryRecursive(sourcePath, destinationPath)
      continue
    }

    if (entry.isSymbolicLink()) {
      if (existsSync(destinationPath)) {
        rmSync(destinationPath, { recursive: true, force: true })
      }
      const linkTarget = readlinkSync(sourcePath)
      symlinkSync(linkTarget, destinationPath)
      continue
    }

    if (existsSync(destinationPath) && lstatSync(destinationPath).isDirectory()) {
      rmSync(destinationPath, { recursive: true, force: true })
    }
    copyFileSync(sourcePath, destinationPath)
  }

  const destinationEntries = readdirSync(destinationDir, { withFileTypes: true })
  for (const entry of destinationEntries) {
    if (sourceNames.has(entry.name)) {
      continue
    }
    rmSync(join(destinationDir, entry.name), { recursive: true, force: true })
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
  const skeletonPath = join(process.cwd(), 'templates', AGENTS_SKELETON_FILE)
  if (existsSync(skeletonPath)) {
    writeFileSync(destinationPath, readFileSync(skeletonPath, 'utf8'), 'utf8')
    return
  }
  writeFileSync(destinationPath, '# Corazon Assistant\n', 'utf8')
}

const migrateLegacyAgentsFile = (agentHomeDir: string) => {
  const destinationPath = join(agentHomeDir, AGENTS_FILE)
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

const ensureBundledSkills = (agentHomeDir: string) => {
  const bundledSkillsRoot = join(process.cwd(), 'templates', 'skills')
  if (!existsSync(bundledSkillsRoot)) {
    return
  }

  const entries = readdirSync(bundledSkillsRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }
    const sourcePath = join(bundledSkillsRoot, entry.name)
    const destinationPath = join(agentHomeDir, 'skills', entry.name)
    if (!existsSync(destinationPath)) {
      ensureSeededDirectory(sourcePath, destinationPath)
      continue
    }

    const destinationStats = lstatSync(destinationPath)
    if (!destinationStats.isDirectory()) {
      continue
    }

    if (SYSTEM_SKILL_SYNC_NAMES.has(entry.name)) {
      // System-managed skills are fully synchronized on every startup.
      syncDirectoryRecursive(sourcePath, destinationPath)
      continue
    }

    // Non-system skills keep local changes while still receiving new files.
    copyDirectoryRecursive(sourcePath, destinationPath)
  }
}

const ensureSkillScriptPermissions = (agentHomeDir: string) => {
  if (process.platform === 'win32') {
    return
  }

  const skillsDir = join(agentHomeDir, 'skills')
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

  ensureBundledSkills(agentHomeDir)
  ensureSkillScriptPermissions(agentHomeDir)
  ensureDefaultAgentsFile(agentHomeDir)
  migrateLegacyAgentsFile(agentHomeDir)
  bootstrapDone = true
  return agentHomeDir
}
