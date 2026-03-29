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
import { dirname, join, relative, resolve as resolvePath } from 'node:path'
import { normalizeImageGenerationFeatureConfig } from '@@/lib/image-generation-config.mjs'
import { getDefaultCodexSeedSourceDir, resolveCorazonRootDir } from './agent-home.ts'

const SEED_FILES = ['config.toml'] as const
const SEED_DIRECTORIES = ['skills', 'rules', 'vendor_imports'] as const
const AUTH_FILE = 'auth.json'
const AGENTS_FILE = 'AGENTS.md'
const AGENTS_SKELETON_FILE = 'agent-behavior.md'
const SYSTEM_SKILL_SYNC_NAMES = new Set(['shared-memory', 'manage-workflows'])
const SHARED_MEMORY_GUIDANCE_PATTERN = /## Shared memory[\s\S]*?(?=\n## |\n# |$)/i
const WORKFLOW_GUIDANCE_PATTERN = /## Workflow management[\s\S]*?(?=\n## |\n# |$)/i
const LEGACY_SHARED_MEMORY_SKILL_HINT = /for long-term memory,\s*use the `shared-memory` skill\./i
const LEGACY_WORKFLOW_SKILL_HINT = /use the `manage-workflows` skill for workflow operations\./i
const UPDATED_SHARED_MEMORY_GUIDANCE = [
  '## Shared memory',
  '- In app-server mode, assume native dynamic tool `sharedMemory` is available and use it first for long-term memory with `search` and `upsert`.',
  '- In sdk mode or fallback paths, use the `shared-memory` skill.',
  '- Treat Corazon memory APIs (`/api/memory/*`) as the shared memory interface across all threads.',
  '- Memory backend is `mem0` with ChromaDB vector storage; do not bypass it with direct file edits.',
  '- Add memory when new stable facts/preferences/decisions emerge; search memory when prior context is needed.'
].join('\n')
const UPDATED_WORKFLOW_GUIDANCE = [
  '## Workflow management',
  '- Treat recurring or automated requests (for example: daily, weekly, monthly, recurring, or scheduled work) as workflow operations.',
  '- In app-server mode, assume native dynamic tool `manageWorkflow` is available and use it first for workflow operations.',
  '- Prefer explicit `manageWorkflow` commands for workflow operations: list/inspect/create/update/delete/dispatch.',
  '- Use `manageWorkflow` `apply-text` only for natural-language workflow authoring and draft extraction.',
  '- Author workflow instructions as a detailed execution brief that fulfills user intent.',
  '- Include the goal, required context/resources, concrete execution steps, and expected output or completion criteria in the workflow instruction.',
  '- When the workflow deliverable has no fixed language requirement, follow the user\'s prompt language.',
  '- If reusable helper code, a custom executable, or long-lived operating guidance is required, create/update a supporting skill under `${CODEX_HOME}/skills` with `skill-creator` before finalizing the workflow, then include that skill in the workflow skills list.',
  '- If a standalone script is still necessary, place reusable scripts under `${CODEX_HOME}/scripts`.',
  '- Use `${CODEX_HOME}/threads/<threadId>/...` only for thread-local artifacts when the concrete thread directory is known.',
  '- Never place scripts in `${CODEX_HOME}/threads` itself or in shared directories such as `${CODEX_HOME}/threads/scripts`.',
  '- In sdk mode or fallback paths, use the `manage-workflows` skill.',
  '- Prefer `rrule` for recurring schedules that are hard to express or maintain with cron, and use cron when it is sufficient.',
  '- Never use OS-level schedulers (`crontab`, `systemd`, `launchd`) for Corazon workflow requests.',
  '- When the user asks to create/update/delete a Corazon workflow, route through Corazon workflow tooling before considering generic shell operations.'
].join('\n')
const OPERATOR_NOTIFICATION_GUIDANCE = [
  '## Operator notifications',
  '- In app-server mode, assume native dynamic tool `notifyOperator` is available for operator-facing Telegram alerts.',
  '- Use `notifyOperator` for blocker, warning, or other high-signal updates from workflows and background tasks when the user should hear about them without manually checking logs.',
  '- Keep notifications concise and action-oriented. Include workflow/run/task context and a recommended next action when known.',
  '- Routine successful workflow completion is not by itself a reason to notify the operator.',
  '- Avoid noisy success spam; prefer failures, warnings, manual dispatch outcomes, and unusual autonomous events that merit attention.'
].join('\n')

let bootstrapDone = false

const pathExists = (targetPath: string) => {
  try {
    lstatSync(targetPath)
    return true
  } catch {
    return false
  }
}

const getSymlinkTarget = (sourcePath: string, destinationPath: string) => {
  const relativeTarget = relative(dirname(destinationPath), sourcePath)
  return relativeTarget || '.'
}

const shouldRelinkFile = (sourcePath: string, destinationPath: string) => {
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
  if (!existsSync(sourcePath)) {
    return
  }
  const shouldRelink = shouldRelinkFile(sourcePath, destinationPath)
  if (pathExists(destinationPath) && !shouldRelink) {
    return
  }
  if (pathExists(destinationPath)) {
    rmSync(destinationPath, { recursive: true, force: true })
  }
  mkdirSync(dirname(destinationPath), { recursive: true })
  symlinkSync(getSymlinkTarget(sourcePath, destinationPath), destinationPath, 'file')
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

const ensureImageGenerationFeatureEnabled = (configPath: string) => {
  if (!existsSync(configPath)) {
    return
  }

  const original = readFileSync(configPath, 'utf8')
  const { changed, output } = normalizeImageGenerationFeatureConfig(original)
  if (!changed) {
    return
  }
  writeFileSync(configPath, output, 'utf8')
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

const updateGuidanceSection = (content: string, pattern: RegExp, guidance: string) =>
  content.match(pattern)
    ? content.replace(pattern, `${guidance}\n`)
    : `${content.trimEnd()}\n\n${guidance}\n`

const migrateLegacyAgentsFile = (agentHomeDir: string) => {
  const destinationPath = join(agentHomeDir, AGENTS_FILE)
  if (!existsSync(destinationPath)) {
    return
  }

  const previous = readFileSync(destinationPath, 'utf8')
  let next = previous

  if (
    previous.match(SHARED_MEMORY_GUIDANCE_PATTERN)
    || previous.includes('${CODEX_HOME}/MEMORY.md')
    || LEGACY_SHARED_MEMORY_SKILL_HINT.test(previous)
  ) {
    next = updateGuidanceSection(next, SHARED_MEMORY_GUIDANCE_PATTERN, UPDATED_SHARED_MEMORY_GUIDANCE)
  }

  if (previous.match(WORKFLOW_GUIDANCE_PATTERN) || LEGACY_WORKFLOW_SKILL_HINT.test(previous)) {
    next = updateGuidanceSection(next, WORKFLOW_GUIDANCE_PATTERN, UPDATED_WORKFLOW_GUIDANCE)
  }

  if (!next.includes('## Operator notifications')) {
    next = `${next.trimEnd()}\n\n${OPERATOR_NOTIFICATION_GUIDANCE}\n`
  }

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
  mkdirSync(join(agentHomeDir, 'skills'), { recursive: true })
  mkdirSync(join(agentHomeDir, 'scripts'), { recursive: true })
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
  ensureImageGenerationFeatureEnabled(join(agentHomeDir, 'config.toml'))

  ensureBundledSkills(agentHomeDir)
  ensureSkillScriptPermissions(agentHomeDir)
  ensureDefaultAgentsFile(agentHomeDir)
  migrateLegacyAgentsFile(agentHomeDir)
  bootstrapDone = true
  return agentHomeDir
}
