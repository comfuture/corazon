import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import type { SkillSummary } from '@@/types/settings'
import { ensureAgentBootstrap } from './agent-bootstrap.ts'

const SKILL_FILE_NAME = 'SKILL.md'
const SYSTEM_SKILL_NAMES = new Set(['shared-memory'])

const isSafeSkillName = (name: string) => /^[A-Za-z0-9._-]+$/.test(name)
const isSystemSkillName = (name: string) => name.startsWith('.') || SYSTEM_SKILL_NAMES.has(name)

const normalizeSkillName = (name: string) =>
  name
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\s+/g, '-')

const parseSkillNameFromSkillFile = (sourcePath: string) => {
  const skillFilePath = join(sourcePath, SKILL_FILE_NAME)
  if (!existsSync(skillFilePath)) {
    return null
  }
  const content = readFileSync(skillFilePath, 'utf8')
  const frontMatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!frontMatterMatch) {
    return null
  }
  const nameMatch = frontMatterMatch[1]?.match(/^\s*name\s*:\s*(.+)\s*$/m)
  if (!nameMatch) {
    return null
  }
  const rawName = nameMatch[1]
  if (!rawName) {
    return null
  }
  return normalizeSkillName(rawName.replace(/^['"]|['"]$/g, ''))
}

const isInsideDirectory = (targetPath: string, basePath: string) => {
  const normalizedTarget = resolve(targetPath)
  const normalizedBase = resolve(basePath)
  return normalizedTarget === normalizedBase || normalizedTarget.startsWith(`${normalizedBase}${sep}`)
}

const getSkillsRootDir = () => join(ensureAgentBootstrap(), 'skills')

const toSkillSummary = (name: string): SkillSummary => {
  const skillsRoot = getSkillsRootDir()
  const path = join(skillsRoot, name)
  return {
    name,
    path,
    hasSkillFile: existsSync(join(path, SKILL_FILE_NAME)),
    isSystem: isSystemSkillName(name)
  }
}

const collectInstallTargets = (sourceRoot: string, preferredRootName?: string) => {
  const rootSkillFile = join(sourceRoot, SKILL_FILE_NAME)
  if (existsSync(rootSkillFile)) {
    const rootNameFromSkillFile = parseSkillNameFromSkillFile(sourceRoot)
    const rootName = normalizeSkillName(rootNameFromSkillFile || preferredRootName || basename(sourceRoot))
    if (!rootName || !isSafeSkillName(rootName)) {
      throw new Error(`Invalid skill name from source root: ${rootName}`)
    }
    return [{
      name: rootName,
      path: sourceRoot
    }]
  }

  const targets: Array<{ name: string, path: string }> = []
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue
    }
    const entryPath = join(sourceRoot, entry.name)
    if (!existsSync(join(entryPath, SKILL_FILE_NAME))) {
      continue
    }
    const normalizedName = normalizeSkillName(entry.name)
    if (!normalizedName || !isSafeSkillName(normalizedName)) {
      throw new Error(`Invalid skill name: ${entry.name}`)
    }
    targets.push({
      name: normalizedName,
      path: entryPath
    })
  }

  if (!targets.length) {
    throw new Error('No SKILL.md was found in the source.')
  }

  return targets
}

const isRemoteGitSource = (source: string) =>
  source.startsWith('http://')
  || source.startsWith('https://')
  || source.startsWith('git@')
  || source.startsWith('ssh://')

const getStableSkillNameFromSource = (source: string) => {
  const normalizedSource = source.trim().replace(/\/+$/, '')
  if (!normalizedSource) {
    return null
  }
  const sourceWithoutGit = normalizedSource.replace(/\.git$/i, '')
  const gitUrlMatch = sourceWithoutGit.match(/[:/]([^/:]+)$/)
  if (!gitUrlMatch) {
    return null
  }
  const candidate = normalizeSkillName(gitUrlMatch[1] || '')
  return candidate || null
}

const resolveInstallSource = (source: string) => {
  if (isRemoteGitSource(source)) {
    const tempPath = mkdtempSync(join(tmpdir(), 'corazon-skill-'))
    execFileSync('git', ['clone', '--depth', '1', source, tempPath], { stdio: 'ignore' })
    return {
      path: tempPath,
      cleanup: () => rmSync(tempPath, { recursive: true, force: true })
    }
  }

  const localPath = resolve(source)
  if (!existsSync(localPath)) {
    throw new Error(`Source path not found: ${localPath}`)
  }
  return {
    path: localPath,
    cleanup: () => {}
  }
}

export const listInstalledSkills = (): SkillSummary[] => {
  const skillsRoot = getSkillsRootDir()
  mkdirSync(skillsRoot, { recursive: true })

  const skills = readdirSync(skillsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => toSkillSummary(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))

  return skills
}

export const installSkillsFromSource = (source: string): SkillSummary[] => {
  const normalizedSource = source.trim()
  if (!normalizedSource) {
    throw new Error('Source is required.')
  }

  const resolved = resolveInstallSource(normalizedSource)
  const skillsRoot = getSkillsRootDir()
  mkdirSync(skillsRoot, { recursive: true })

  try {
    const preferredRootName = getStableSkillNameFromSource(normalizedSource)
    const targets = collectInstallTargets(resolved.path, preferredRootName ?? undefined)
    const installed: SkillSummary[] = []

    for (const target of targets) {
      if (!isSafeSkillName(target.name)) {
        throw new Error(`Invalid skill name: ${target.name}`)
      }
      const destination = join(skillsRoot, target.name)
      if (!isInsideDirectory(destination, skillsRoot)) {
        throw new Error(`Unsafe skill destination: ${destination}`)
      }
      if (existsSync(destination)) {
        throw new Error(`Skill already exists: ${target.name}`)
      }
      cpSync(target.path, destination, { recursive: true, errorOnExist: true, force: false })
      installed.push(toSkillSummary(target.name))
    }

    return installed
  } finally {
    resolved.cleanup()
  }
}

export const removeInstalledSkill = (name: string) => {
  const normalizedName = name.trim()
  if (!normalizedName || !isSafeSkillName(normalizedName)) {
    throw new Error('Invalid skill name.')
  }
  if (isSystemSkillName(normalizedName)) {
    throw new Error('System skills cannot be removed from UI.')
  }

  const skillsRoot = getSkillsRootDir()
  const target = join(skillsRoot, normalizedName)
  if (!isInsideDirectory(target, skillsRoot)) {
    throw new Error('Invalid skill path.')
  }
  if (!existsSync(target)) {
    throw new Error(`Skill not found: ${normalizedName}`)
  }

  rmSync(target, { recursive: true, force: false })
}
