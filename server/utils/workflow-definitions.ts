import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Cron } from 'croner'
import rrule from 'rrule'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { WorkflowDefinition, WorkflowFrontmatter, WorkflowLanguage, WorkflowTriggerConfig } from '@@/types/workflow'
import { resolveCorazonRootDir } from './agent-home.ts'

const { rrulestr } = rrule

const WORKFLOWS_DIRECTORY = 'workflows'
const WORKFLOW_FILE_EXTENSION = '.md'
const INTERVAL_PATTERN = /^([1-9][0-9]*)(s|m|h)$/
const WORKFLOW_LANGUAGES = new Set<WorkflowLanguage>(['markdown', 'typescript', 'python'])
const DEFAULT_WORKFLOW_LANGUAGE: WorkflowLanguage = 'markdown'
const WORKFLOW_NAME_PATTERN = /^[A-Za-z]+(?: [A-Za-z]+){1,2}$/
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/
const WORKFLOW_CADENCE_CORE = String.raw`(?:매\s*\d+\s*(?:초|분|시간|일|주|개월|달|월|년)마다|(?:\d+\s*(?:초|분|시간|일|주|개월|달|월|년))(?:에)?\s*(?:한\s*번|한번)|매(?:일|주|월|년)|every\s+\d+\s*(?:seconds?|minutes?|hours?|days?|weeks?|months?)|every\s+(?:second|minute|hour|day|week|month)s?|daily|weekly|monthly|hourly)`
const WORKFLOW_LEADING_CADENCE_PATTERN = new RegExp(
  String.raw`^\s*${WORKFLOW_CADENCE_CORE}(?:\s+(?:at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|on\s+\w+|오전\s*\d{1,2}(?::\d{2})?\s*시?|오후\s*\d{1,2}(?::\d{2})?\s*시?|[월화수목금토일]요일?))?(?:\s*(?:에|마다))?(?:\s*(?:실행(?:하세요|해라|합니다|됩니다)?|run|execute(?:\s+it)?))?(?:\s*[,;:]\s*|\s+)`,
  'iu'
)
const WORKFLOW_INVOCATION_PREFIX_PATTERN = /^(?:\s*(?:실행할\s*때마다|실행\s*시마다|실행시마다|실행\s*시|각\s*실행(?:에서)?|매번|호출\s*시(?:마다)?|호출시(?:마다)?|트리거(?:될\s*때마다|시(?:마다)?)|on each run|every execution|at each execution|upon invocation|on invocation|per run|when(?:ever)?\s+(?:the workflow is |it is )?(?:run|invoked|triggered)))\s*/iu
const WORKFLOW_META_TAIL_PATTERN = /(?:워크플로우\s*(?:생성|만들(?:어|어줘|어 주세요|어주세요)?|등록|작성|저장|수정|업데이트)|(?:create|make|generate|set\s+up)(?:\s+me)?\s+(?:a\s+)?workflow)\s*(?:해줘|해주세요|해\s*주세요|please)?$/iu
const WORKFLOW_CADENCE_ONLY_PATTERN = new RegExp(
  String.raw`^\s*${WORKFLOW_CADENCE_CORE}(?:\s+(?:at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|on\s+\w+|오전\s*\d{1,2}(?::\d{2})?\s*시?|오후\s*\d{1,2}(?::\d{2})?\s*시?|[월화수목금토일]요일?))?(?:\s*(?:에|마다))?(?:\s*(?:실행(?:하세요|해라|합니다|됩니다)?|run|execute(?:\s+it)?))?\s*$`,
  'iu'
)
const WORKFLOW_INVOCATION_ONLY_PATTERN = /^(?:실행할\s*때마다|실행\s*시마다|실행시마다|실행\s*시|각\s*실행(?:에서)?|매번|호출\s*시(?:마다)?|호출시(?:마다)?|트리거(?:될\s*때마다|시(?:마다)?)|on each run|every execution|at each execution|upon invocation|on invocation|per run)$/iu
const WORKFLOW_DETAIL_SECTION_PATTERNS = [
  /<goal>[\s\S]*?<\/goal>/iu,
  /<context>[\s\S]*?<\/context>/iu,
  /<steps>[\s\S]*?<\/steps>/iu,
  /<output>[\s\S]*?<\/output>/iu
]
const WORKFLOW_STEP_LINE_PATTERN = /^(?:[-*]\s+|[0-9]+\.\s+)/u
const WORKFLOW_MIN_DETAIL_LENGTH = 140
const WORKFLOW_MIN_DETAIL_LINES = 3
const WORKFLOW_MIN_DETAIL_SENTENCES = 3
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
    language: DEFAULT_WORKFLOW_LANGUAGE,
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
  if (value == null) {
    return []
  }

  if (!Array.isArray(value)) {
    return null
  }

  const normalized = value
    .filter(item => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)

  return [...new Set(normalized)]
}

const normalizeWorkflowLanguage = (value: unknown): WorkflowLanguage | null => {
  if (value == null) {
    return DEFAULT_WORKFLOW_LANGUAGE
  }
  if (typeof value !== 'string') {
    return null
  }
  const normalized = value.trim().toLowerCase()
  if (!WORKFLOW_LANGUAGES.has(normalized as WorkflowLanguage)) {
    return null
  }
  return normalized as WorkflowLanguage
}

const sanitizeWorkflowInstructionSentence = (value: string) => {
  let sentence = value
    .replace(/^```(?:text|markdown)?\s*/iu, '')
    .replace(/\s*```$/iu, '')
    .trim()

  if (!sentence) {
    return ''
  }

  const stripForClassification = (input: string) =>
    input
      .replace(/[.,!?;:。！？]+$/gu, '')
      .replace(/^["'“”‘’`]+|["'“”‘’`]+$/gu, '')
      .trim()

  sentence = sentence.replace(WORKFLOW_META_TAIL_PATTERN, '').trim()

  let previous = ''
  while (sentence && previous !== sentence) {
    previous = sentence
    const classified = stripForClassification(sentence)
    if (WORKFLOW_CADENCE_ONLY_PATTERN.test(classified) || WORKFLOW_INVOCATION_ONLY_PATTERN.test(classified)) {
      return ''
    }

    sentence = sentence
      .replace(WORKFLOW_LEADING_CADENCE_PATTERN, '')
      .replace(WORKFLOW_INVOCATION_PREFIX_PATTERN, '')
      .replace(/^[,;:.\-)\]]+\s*/u, '')
      .trim()
  }

  const classified = stripForClassification(sentence)
  if (!classified) {
    return ''
  }
  if (WORKFLOW_CADENCE_ONLY_PATTERN.test(classified) || WORKFLOW_INVOCATION_ONLY_PATTERN.test(classified)) {
    return ''
  }

  return sentence
}

export const normalizeWorkflowInstructionText = (value: string) => {
  const source = value
    .replace(/\r\n/g, '\n')
    .trim()

  if (!source) {
    return ''
  }

  const lines = source
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line
      .split(/(?<=[.!?。！？])\s+/u)
      .map(sanitizeWorkflowInstructionSentence)
      .filter(Boolean)
      .join(' ')
      .trim())
    .filter(Boolean)

  return lines
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const countWorkflowInstructionSections = (value: string) =>
  WORKFLOW_DETAIL_SECTION_PATTERNS.filter(pattern => pattern.test(value)).length

const countWorkflowInstructionLines = (value: string) =>
  value
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .length

const countWorkflowInstructionSentences = (value: string) =>
  value
    .split(/\n+/)
    .flatMap(line => line.split(/(?<=[.!?。！？])\s+/u))
    .map(sentence => sentence.trim())
    .filter(Boolean)
    .length

export const isDetailedWorkflowInstruction = (value: string) => {
  const normalized = normalizeWorkflowInstructionText(value)
  if (!normalized) {
    return false
  }

  if (countWorkflowInstructionSections(normalized) >= 4) {
    return true
  }

  const lines = countWorkflowInstructionLines(normalized)
  const sentences = countWorkflowInstructionSentences(normalized)
  const structuredStepLines = normalized
    .split('\n')
    .map(line => line.trim())
    .filter(line => WORKFLOW_STEP_LINE_PATTERN.test(line))
    .length

  return normalized.length >= WORKFLOW_MIN_DETAIL_LENGTH
    && (
      lines >= WORKFLOW_MIN_DETAIL_LINES
      || sentences >= WORKFLOW_MIN_DETAIL_SENTENCES
      || structuredStepLines >= 2
    )
}

export const buildDetailedWorkflowInstruction = (value: string) => {
  const normalized = normalizeWorkflowInstructionText(value)
  if (!normalized) {
    return ''
  }

  if (isDetailedWorkflowInstruction(normalized)) {
    return normalized
  }

  const goalText = normalized.replace(/\s*\n+\s*/g, ' ').trim()

  return [
    '<goal>',
    `- ${goalText}`,
    '</goal>',
    '',
    '<context>',
    '- Review the latest conversation, shared memory, workflow history, relevant files, and available tool outputs before acting.',
    '- Recover missing identifiers, preferences, or prerequisites from available context instead of guessing when possible.',
    '</context>',
    '',
    '<steps>',
    '1. Translate the goal above into a concrete execution plan with a clear completion condition.',
    '2. Gather the required context, state, references, and prerequisites before taking action.',
    '3. Perform the actual work using the available tools and allowed skills.',
    '4. If the first attempt is incomplete, do the obvious follow-up retrieval or recovery step.',
    '5. Verify completion and leave only precise blockers when the goal cannot be finished.',
    '</steps>',
    '',
    '<output>',
    '- Deliver the requested result or final action directly.',
    '- Use the user\'s requested language for the final deliverable unless the task explicitly requires another language.',
    '- Keep the final report concise and include only essential validation details or follow-up items.',
    '</output>'
  ].join('\n')
}

export const ensureDetailedWorkflowInstruction = (value: string) =>
  buildDetailedWorkflowInstruction(value)

export const getWorkflowInstructionDetailError = (instruction: string) => {
  const normalized = normalizeWorkflowInstructionText(instruction)
  if (!normalized) {
    return 'Workflow instruction body is required.'
  }
  if (isDetailedWorkflowInstruction(normalized)) {
    return null
  }

  return 'Workflow instruction must be a detailed execution brief. Include concrete execution steps, required context/resources, and the expected output or completion criteria.'
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

const validateWorkflowRules = (
  frontmatter: WorkflowFrontmatter,
  instruction: string,
  options: { requireDetailedInstruction?: boolean } = {}
) => {
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
  const language = frontmatter.language

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

  if (!WORKFLOW_LANGUAGES.has(language)) {
    return 'Frontmatter "language" must be one of: markdown, typescript, python.'
  }

  if (!instruction.trim()) {
    return 'Workflow instruction body is required.'
  }

  if (options.requireDetailedInstruction && language === 'markdown') {
    const instructionDetailError = getWorkflowInstructionDetailError(instruction)
    if (instructionDetailError) {
      return instructionDetailError
    }
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
  const language = normalizeWorkflowLanguage(record.language)
  const on = normalizeTriggerConfig(record.on)
  const skills = normalizeSkills(record.skills)

  if (!name || !description || !language || !on || !skills) {
    return null
  }

  return {
    name,
    description,
    language,
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
  const source = normalizeWorkflowInstructionText(instruction) || instruction.trim()
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
    language: normalizeWorkflowLanguage(frontmatterInput.language) ?? DEFAULT_WORKFLOW_LANGUAGE,
    on: {
      'schedule': frontmatterInput.on.schedule?.trim() || undefined,
      'interval': frontmatterInput.on.interval?.trim() || undefined,
      'rrule': frontmatterInput.on.rrule?.trim() || undefined,
      'workflow-dispatch': frontmatterInput.on['workflow-dispatch'] === true
    },
    skills: [...new Set(frontmatterInput.skills.map(item => item.trim()).filter(Boolean))]
  }

  const normalizedInstruction = normalizeWorkflowInstructionText(instructionInput)
  const instruction = frontmatter.language === 'markdown'
    ? ensureDetailedWorkflowInstruction(normalizedInstruction)
    : instructionInput.replace(/\r\n/g, '\n').trim()
  const validationError = validateWorkflowRules(frontmatter, instruction, {
    requireDetailedInstruction: true
  })
  if (validationError) {
    throw new Error(validationError)
  }

  const yamlValue = stringifyYaml({
    name: frontmatter.name,
    description: frontmatter.description,
    language: frontmatter.language,
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
      parseError: 'Frontmatter must include name, description, language, on, skills.'
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
