import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Cron } from 'croner'
import { rrulestr } from 'rrule'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { WorkflowDefinition, WorkflowFrontmatter, WorkflowTriggerConfig } from '@@/types/workflow'
import { resolveCorazonRootDir } from './agent-home'

const WORKFLOWS_DIRECTORY = 'workflows'
const WORKFLOW_FILE_EXTENSION = '.md'
const INTERVAL_PATTERN = /^([1-9][0-9]*)(s|m|h)$/
const WORKFLOW_NAME_PATTERN = /^[A-Za-z]+(?: [A-Za-z]+){1,2}$/
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/
const GENERIC_WORKFLOW_SLUGS = new Set([
  'workflow',
  'task-workflow',
  'workflow-task',
  'new-workflow'
])
const SLUG_STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'for',
  'with',
  'without',
  'to',
  'of',
  'in',
  'on',
  'at',
  'by',
  'from',
  'run',
  'runs',
  'running',
  'workflow',
  'workflows',
  'task',
  'tasks',
  'assistant',
  'message',
  'messages',
  'output',
  'execute',
  'execution',
  'create',
  'update',
  'delete',
  'save'
])

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
  const rrule = typeof record.rrule === 'string' && record.rrule.trim()
    ? record.rrule.trim()
    : undefined
  const workflowDispatch = record['workflow-dispatch'] === true

  return {
    'schedule': schedule,
    'interval': interval,
    'rrule': rrule,
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

export const validateRRuleExpression = (value: string) => {
  try {
    const parsed = rrulestr(value)
    const next = parsed.after(new Date())
    return next instanceof Date
  } catch {
    return false
  }
}

const validateWorkflowRules = (frontmatter: WorkflowFrontmatter, instruction: string) => {
  const name = frontmatter.name.trim()
  if (!name) {
    return 'Frontmatter "name" is required.'
  }
  if (!WORKFLOW_NAME_PATTERN.test(name)) {
    return 'Frontmatter "name" must be 2-3 English words.'
  }

  const description = frontmatter.description.trim()
  if (!description) {
    return 'Frontmatter "description" is required.'
  }

  const schedule = frontmatter.on.schedule?.trim()
  const interval = frontmatter.on.interval?.trim()
  const rrule = frontmatter.on.rrule?.trim()
  const dispatch = frontmatter.on['workflow-dispatch'] === true

  const timeTriggerCount = [schedule, interval, rrule].filter(Boolean).length
  if (timeTriggerCount > 1) {
    return 'Only one time trigger is allowed: "schedule", "interval", or "rrule".'
  }

  if (schedule && !validateCronExpression(schedule)) {
    return 'Invalid cron expression in "on.schedule".'
  }

  if (interval && !validateIntervalExpression(interval)) {
    return 'Invalid interval expression in "on.interval".'
  }

  if (rrule && !validateRRuleExpression(rrule)) {
    return 'Invalid RRULE expression in "on.rrule".'
  }

  if (!schedule && !interval && !rrule && !dispatch) {
    return 'At least one trigger must be configured. Enable "workflow-dispatch" when no time trigger exists.'
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

export const getWorkflowsDirectory = () => join(resolveCorazonRootDir(), WORKFLOWS_DIRECTORY)

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

const tokenizeSlugSource = (value: string) => (value ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9\s]+/g, ' ')
  .split(/\s+/)
  .map(item => item.trim())
  .filter(item => item.length >= 2 && !SLUG_STOPWORDS.has(item))

const deriveInstructionBasedSlug = (instruction: string) => {
  const source = instruction.trim()
  if (!source) {
    return null
  }

  const quotedTextMatch = source.match(/["'“”‘’]([A-Za-z0-9\s-]{2,80})["'“”‘’]/)
  const quotedTokens = tokenizeSlugSource(quotedTextMatch?.[1] ?? '')
  if (quotedTokens.length > 0 && /(say|print|output|message|말하|출력|메시지|인사)/i.test(source)) {
    return `say-${quotedTokens.slice(0, 2).join('-')}`
  }

  const normalized = source
    .replace(/(워크플로우\s*(생성|등록|수정|저장|작성)|create\s+(a\s+)?workflow|generate\s+(a\s+)?workflow)/gi, ' ')
    .replace(/\b(cron|rrule|interval|daily|weekly|monthly|hourly)\b/gi, ' ')
    .replace(/\bevery\s+\d+\s*(seconds?|minutes?|hours?|days?|weeks?|months?)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const tokens = tokenizeSlugSource(normalized)
  if (tokens.length > 0) {
    return tokens.slice(0, 4).join('-')
  }

  if (/(say|print|output|message|말하|출력|메시지|인사)/i.test(source)) {
    return 'say-message'
  }
  if (/(summary|summarize|report|digest|요약|리포트)/i.test(source)) {
    return 'summary-report'
  }

  return null
}

export const deriveWorkflowFileSlugFromInput = (input: {
  requestedFileSlug?: string | null
  workflowName: string
  instruction: string
}) => {
  const requestedSlug = toWorkflowFileSlug(input.requestedFileSlug ?? '')
  if (requestedSlug && !GENERIC_WORKFLOW_SLUGS.has(requestedSlug)) {
    return requestedSlug
  }

  const nameSlug = toWorkflowFileSlug(input.workflowName)
  if (nameSlug && !GENERIC_WORKFLOW_SLUGS.has(nameSlug)) {
    return nameSlug
  }

  const instructionSlug = toWorkflowFileSlug(deriveInstructionBasedSlug(input.instruction) ?? '')
  if (instructionSlug && !GENERIC_WORKFLOW_SLUGS.has(instructionSlug)) {
    return instructionSlug
  }

  if (instructionSlug && instructionSlug !== 'workflow') {
    return instructionSlug
  }

  return nameSlug || requestedSlug || 'workflow'
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
      'rrule': frontmatterInput.on.rrule?.trim() || undefined,
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
