import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Cron } from 'croner'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { WorkflowDefinition, WorkflowFrontmatter, WorkflowTriggerConfig } from '@@/types/workflow'

const WORKFLOWS_DIRECTORY = 'workflows'
const WORKFLOW_FILE_EXTENSION = '.md'
const INTERVAL_PATTERN = /^([1-9][0-9]*)(s|m|h)$/
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

const createInvalidWorkflow = (input: {
  fileSlug: string
  filePath: string
  source: string
  updatedAt: number
  parseError: string
}): WorkflowDefinition => ({
  fileSlug: input.fileSlug,
  filePath: input.filePath,
  source: input.source,
  frontmatter: {
    name: input.fileSlug,
    description: '',
    on: { 'workflow-dispatch': true },
    skills: []
  },
  instruction: '',
  isValid: false,
  parseError: input.parseError,
  updatedAt: input.updatedAt
})

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

const normalizeSkills = (value: unknown) => {
  if (!Array.isArray(value)) {
    return null
  }

  const normalized = value
    .filter(item => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)

  return [...new Set(normalized)]
}

const normalizeTriggerConfig = (value: unknown): WorkflowTriggerConfig | null => {
  const record = asRecord(value)
  if (!record) {
    return null
  }

  const schedule = typeof record.schedule === 'string' && record.schedule.trim()
    ? record.schedule.trim()
    : undefined
  const interval = typeof record.interval === 'string' && record.interval.trim()
    ? record.interval.trim()
    : undefined
  const workflowDispatch = record['workflow-dispatch'] === true

  return {
    'schedule': schedule,
    'interval': interval,
    'workflow-dispatch': workflowDispatch
  }
}

export const validateCronExpression = (value: string) => {
  try {
    const cron = new Cron(value, () => {})
    cron.stop()
    return true
  } catch {
    return false
  }
}

export const validateIntervalExpression = (value: string) => INTERVAL_PATTERN.test(value)

const validateWorkflowRules = (frontmatter: WorkflowFrontmatter, instruction: string) => {
  const name = frontmatter.name.trim()
  if (!name) {
    return 'Frontmatter "name" is required.'
  }

  const description = frontmatter.description.trim()
  if (!description) {
    return 'Frontmatter "description" is required.'
  }

  if (frontmatter.skills.length === 0) {
    return 'Frontmatter "skills" must contain at least one skill.'
  }

  const schedule = frontmatter.on.schedule?.trim()
  const interval = frontmatter.on.interval?.trim()
  const dispatch = frontmatter.on['workflow-dispatch'] === true

  if (schedule && interval) {
    return 'Only one time trigger is allowed: either "schedule" or "interval".'
  }

  if (schedule && !validateCronExpression(schedule)) {
    return 'Invalid cron expression in "on.schedule".'
  }

  if (interval && !validateIntervalExpression(interval)) {
    return 'Invalid interval expression in "on.interval".'
  }

  if (!schedule && !interval && !dispatch) {
    return 'At least one trigger must be configured. Enable "workflow-dispatch" when no schedule exists.'
  }

  if (!instruction.trim()) {
    return 'Workflow instruction body is required.'
  }

  return null
}

export const normalizeWorkflowFrontmatter = (value: unknown): WorkflowFrontmatter | null => {
  const record = asRecord(value)
  if (!record) {
    return null
  }

  const name = typeof record.name === 'string' ? record.name.trim() : ''
  const description = typeof record.description === 'string' ? record.description.trim() : ''
  const on = normalizeTriggerConfig(record.on)
  const skills = normalizeSkills(record.skills)

  if (!name || !description || !on || !skills) {
    return null
  }

  return {
    name,
    description,
    on,
    skills
  }
}

export const getWorkflowsDirectory = () => join(process.cwd(), WORKFLOWS_DIRECTORY)

export const ensureWorkflowsDirectory = () => {
  const directory = getWorkflowsDirectory()
  mkdirSync(directory, { recursive: true })
  return directory
}

export const toWorkflowFileSlug = (value: string) => {
  const normalized = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return normalized || 'workflow'
}

export const getWorkflowFilePath = (fileSlug: string) =>
  join(getWorkflowsDirectory(), `${fileSlug}${WORKFLOW_FILE_EXTENSION}`)

export const resolveUniqueWorkflowFileSlug = (baseSlug: string) => {
  const normalized = toWorkflowFileSlug(baseSlug)
  const workflowsDir = ensureWorkflowsDirectory()

  let nextSlug = normalized
  let index = 2

  while (existsSync(join(workflowsDir, `${nextSlug}${WORKFLOW_FILE_EXTENSION}`))) {
    nextSlug = `${normalized}-${index}`
    index += 1
  }

  return nextSlug
}

export const serializeWorkflowSource = (
  frontmatterInput: WorkflowFrontmatter,
  instructionInput: string
) => {
  const frontmatter: WorkflowFrontmatter = {
    name: frontmatterInput.name.trim(),
    description: frontmatterInput.description.trim(),
    on: {
      'schedule': frontmatterInput.on.schedule?.trim() || undefined,
      'interval': frontmatterInput.on.interval?.trim() || undefined,
      'workflow-dispatch': frontmatterInput.on['workflow-dispatch'] === true
    },
    skills: [...new Set(frontmatterInput.skills.map(item => item.trim()).filter(Boolean))]
  }

  const instruction = instructionInput.trim()
  const validationError = validateWorkflowRules(frontmatter, instruction)
  if (validationError) {
    throw new Error(validationError)
  }

  const yamlValue = stringifyYaml({
    name: frontmatter.name,
    description: frontmatter.description,
    on: frontmatter.on,
    skills: frontmatter.skills
  }).trimEnd()

  return `---\n${yamlValue}\n---\n${instruction}\n`
}

export const parseWorkflowSource = (input: {
  fileSlug: string
  filePath: string
  source: string
  updatedAt: number
}): WorkflowDefinition => {
  const matched = input.source.match(FRONTMATTER_PATTERN)
  if (!matched) {
    return createInvalidWorkflow({
      ...input,
      parseError: 'Workflow file must start with YAML frontmatter.'
    })
  }

  const frontmatterRaw = matched[1] ?? ''
  const instruction = (matched[2] ?? '').trim()

  let parsedFrontmatter: unknown
  try {
    parsedFrontmatter = parseYaml(frontmatterRaw)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid YAML frontmatter.'
    return createInvalidWorkflow({
      ...input,
      parseError: message
    })
  }

  const frontmatter = normalizeWorkflowFrontmatter(parsedFrontmatter)
  if (!frontmatter) {
    return createInvalidWorkflow({
      ...input,
      parseError: 'Frontmatter must include name, description, on, skills.'
    })
  }

  const validationError = validateWorkflowRules(frontmatter, instruction)
  if (validationError) {
    return createInvalidWorkflow({
      ...input,
      parseError: validationError
    })
  }

  return {
    fileSlug: input.fileSlug,
    filePath: input.filePath,
    source: input.source,
    frontmatter,
    instruction,
    isValid: true,
    parseError: null,
    updatedAt: input.updatedAt
  }
}

export const readWorkflowDefinitionBySlug = (fileSlug: string) => {
  const normalizedSlug = toWorkflowFileSlug(fileSlug)
  const filePath = getWorkflowFilePath(normalizedSlug)
  if (!existsSync(filePath)) {
    return null
  }

  const source = readFileSync(filePath, 'utf8')
  const updatedAt = statSync(filePath).mtimeMs
  return parseWorkflowSource({
    fileSlug: normalizedSlug,
    filePath,
    source,
    updatedAt
  })
}

export const loadWorkflowDefinitions = (): WorkflowDefinition[] => {
  const directory = ensureWorkflowsDirectory()
  const entries = readdirSync(directory, { withFileTypes: true })

  const workflows = entries
    .filter(entry => entry.isFile() && entry.name.endsWith(WORKFLOW_FILE_EXTENSION))
    .map((entry) => {
      const filePath = join(directory, entry.name)
      const source = readFileSync(filePath, 'utf8')
      const updatedAt = statSync(filePath).mtimeMs
      const fileSlug = entry.name.slice(0, -WORKFLOW_FILE_EXTENSION.length)
      return parseWorkflowSource({
        fileSlug,
        filePath,
        source,
        updatedAt
      })
    })
    .sort((left, right) => right.updatedAt - left.updatedAt || left.fileSlug.localeCompare(right.fileSlug))

  return workflows
}

export const writeWorkflowDefinition = (
  fileSlug: string,
  frontmatter: WorkflowFrontmatter,
  instruction: string
) => {
  const normalizedSlug = toWorkflowFileSlug(fileSlug)
  const source = serializeWorkflowSource(frontmatter, instruction)
  const filePath = getWorkflowFilePath(normalizedSlug)

  ensureWorkflowsDirectory()
  writeFileSync(filePath, source, 'utf8')

  const updatedAt = statSync(filePath).mtimeMs
  return parseWorkflowSource({
    fileSlug: normalizedSlug,
    filePath,
    source,
    updatedAt
  })
}

export const deleteWorkflowDefinitionBySlug = (fileSlug: string) => {
  const normalizedSlug = toWorkflowFileSlug(fileSlug)
  const filePath = getWorkflowFilePath(normalizedSlug)
  if (!existsSync(filePath)) {
    return false
  }
  rmSync(filePath, { force: true })
  return true
}
