import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DynamicToolCallParams } from '@@/types/codex-app-server/v2/DynamicToolCallParams'
import type { DynamicToolCallOutputContentItem } from '@@/types/codex-app-server/v2/DynamicToolCallOutputContentItem'
import type { DynamicToolCallResponse } from '@@/types/codex-app-server/v2/DynamicToolCallResponse'
import type { DynamicToolSpec } from '@@/types/codex-app-server/v2/DynamicToolSpec'
import type { JsonValue } from '@@/types/codex-app-server/serde_json/JsonValue'
import type { WorkflowDefinition, WorkflowFrontmatter } from '@@/types/workflow'
import { getMemoryHealth, rememberText, searchMemories } from '../memory.ts'
import {
  deleteWorkflowDefinitionBySlug,
  deriveWorkflowFileSlugFromInput,
  loadWorkflowDefinitions,
  resolveUniqueWorkflowFileSlug,
  toWorkflowFileSlug,
  validateCronExpression,
  validateIntervalExpression,
  validateRRuleExpression,
  writeWorkflowDefinition
} from '../workflow-definitions.ts'
import { reloadWorkflowScheduler } from '../workflow-scheduler.ts'

type NativeDynamicToolHandler = (input: unknown, params: DynamicToolCallParams) => Promise<DynamicToolCallResponse>

type NativeDynamicTool = {
  aliases: string[]
  spec: DynamicToolSpec
  handle: NativeDynamicToolHandler
}

type WorkflowTriggerType = 'schedule' | 'interval' | 'rrule'

type ParsedWorkflowIntent = {
  action: 'create' | 'update' | 'delete' | 'list'
  confidence: 'low'
  reason: string
  selector: {
    slug: string | null
    query: string | null
  }
  listOptions: {
    runningOnly: boolean
    activeOnly: boolean
    query: string | null
  }
  draft: {
    name: string
    description: string
    instruction: string
    triggerType: WorkflowTriggerType | null
    triggerValue: string | null
    workflowDispatch: boolean
    skills: string[]
  }
}

const SHARED_MEMORY_TOOL_NAME = 'sharedMemory'
const MANAGE_WORKFLOW_TOOL_NAME = 'manageWorkflow'
const DEFAULT_MEMORY_SEARCH_LIMIT = 5
const DEFAULT_MEMORY_SECTION = 'Facts'
const DEFAULT_WORKFLOW_NAME = 'Task Workflow'
const WORKFLOW_NAME_WORD_PATTERN = /^[A-Za-z]+$/
const WORKFLOW_COMMANDS = new Set([
  'list',
  'create',
  'update',
  'delete',
  'from-text',
  'apply-text',
  'inspect'
])
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
const WORKFLOW_SCHEDULE_PATTERN = /\b(cron|rrule|interval|daily|weekly|monthly|every\s+\d+\s*(seconds?|minutes?|hours?|days?|weeks?|months?))\b|매(일|주|월|년|시간|분)|[0-9]+\s*(초|분|시간|일|주|개월)\s*마다/gi
const WORKFLOW_META_PATTERN = /(워크플로우\s*(생성|등록|수정|저장|작성)|create\s+(a\s+)?workflow|generate\s+(a\s+)?workflow)/gi
const WORKFLOW_ACTION_META_PATTERN = /(워크플로우\s*(생성|등록|수정|저장|작성|삭제|목록)|create\s+(a\s+)?workflow|generate\s+(a\s+)?workflow|update\s+(a\s+)?workflow|delete\s+(a\s+)?workflow)/gi
const WORKFLOW_DELETE_PATTERN = /(삭제|지워|remove|delete)/i
const WORKFLOW_LIST_PATTERN = /(목록|리스트|조회|보여|what|which|list|show)/i
const WORKFLOW_UPDATE_PATTERN = /(수정|업데이트|변경|edit|update|change)/i
const WORKFLOW_RUNNING_PATTERN = /(running|실행중|동작중|진행중)/i
const WORKFLOW_ACTIVE_PATTERN = /(active|활성)/i
const WORKFLOW_SAY_PATTERN = /(say|print|output|message|말하|출력|메시지|인사)/i
const WORKFLOW_SUMMARY_PATTERN = /(summary|summarize|report|digest|요약|리포트)/i
const WORKFLOW_QUOTED_TEXT_PATTERN = /["'“”‘’]([^"'“”‘’]+)["'“”‘’]/
const WORKFLOW_QUOTED_NAME_PATTERN = /["'“”‘’]([A-Za-z0-9\s-]{2,80})["'“”‘’]/
const RRULE_PATTERN = /FREQ=[A-Z]+(?:;[A-Z0-9-]+=[A-Z0-9,+:-]+)*/i
const INTERVAL_COMPACT_PATTERN = /\b([1-9][0-9]*)(s|m|h)\b/i
const INTERVAL_NATURAL_PATTERNS: Array<{ pattern: RegExp, unit: 's' | 'm' | 'h' }> = [
  { pattern: /([1-9][0-9]*)\s*(초|seconds?|secs?)\s*마다/i, unit: 's' },
  { pattern: /(?:every|매)\s*([1-9][0-9]*)\s*(초|seconds?|secs?)\b/i, unit: 's' },
  { pattern: /([1-9][0-9]*)\s*(분|minutes?|mins?)\s*마다/i, unit: 'm' },
  { pattern: /(?:every|매)\s*([1-9][0-9]*)\s*(분|minutes?|mins?)\b/i, unit: 'm' },
  { pattern: /([1-9][0-9]*)\s*(시간|hours?|hrs?)\s*마다/i, unit: 'h' },
  { pattern: /(?:every|매)\s*([1-9][0-9]*)\s*(시간|hours?|hrs?)\b/i, unit: 'h' }
]

const SHARED_MEMORY_TOOL_SCHEMA: JsonValue = {
  type: 'object',
  additionalProperties: false,
  properties: {
    command: {
      type: 'string',
      enum: ['ensure', 'search', 'upsert']
    },
    query: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    text: { type: 'string' },
    section: { type: 'string' }
  },
  required: ['command']
}

const MANAGE_WORKFLOWS_TOOL_SCHEMA: JsonValue = {
  type: 'object',
  additionalProperties: false,
  properties: {
    command: {
      type: 'string',
      enum: ['list', 'create', 'update', 'delete', 'from-text', 'apply-text', 'inspect']
    },
    text: { type: 'string' },
    slug: { type: 'string' },
    query: { type: 'string' },
    instruction: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    schedule: { type: 'string' },
    interval: { type: 'string' },
    rrule: { type: 'string' },
    workflowDispatch: { type: 'boolean' },
    fileSlug: { type: 'string' },
    skills: {
      oneOf: [
        { type: 'string' },
        { type: 'array', items: { type: 'string' } }
      ]
    },
    addSkills: {
      oneOf: [
        { type: 'string' },
        { type: 'array', items: { type: 'string' } }
      ]
    },
    removeSkills: {
      oneOf: [
        { type: 'string' },
        { type: 'array', items: { type: 'string' } }
      ]
    },
    validOnly: { type: 'boolean' },
    activeOnly: { type: 'boolean' },
    runningOnly: { type: 'boolean' },
    clearSchedule: { type: 'boolean' },
    clearInterval: { type: 'boolean' },
    clearRrule: { type: 'boolean' }
  },
  required: ['command']
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

const asString = (value: unknown) =>
  typeof value === 'string' ? value.trim() : ''

const asBoolean = (value: unknown, defaultValue = false) => {
  if (typeof value === 'boolean') {
    return value
  }

  if (typeof value !== 'string') {
    return defaultValue
  }

  const normalized = value.trim().toLowerCase()
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'y') {
    return true
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'n') {
    return false
  }
  return defaultValue
}

const clampMemoryLimit = (value: unknown) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MEMORY_SEARCH_LIMIT
  }
  const floored = Math.floor(parsed)
  if (floored < 1) {
    return 1
  }
  return Math.min(floored, 100)
}

const asStringList = (value: unknown) => {
  if (Array.isArray(value)) {
    return [...new Set(value.map(asString).filter(Boolean))]
  }

  const csv = asString(value)
  if (!csv) {
    return []
  }

  return [...new Set(csv.split(',').map(item => item.trim()).filter(Boolean))]
}

const normalizeToolName = (value: string) => {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) {
    return ''
  }
  const suffix = trimmed.split('/').filter(Boolean).at(-1) ?? trimmed
  return suffix.replace(/_/g, '-')
}

const normalizeCommand = (value: unknown) =>
  asString(value).toLowerCase().replace(/_/g, '-')

const toToolContent = (payload: unknown): DynamicToolCallOutputContentItem[] => {
  const text = JSON.stringify(payload, null, 2)
  return [{ type: 'inputText', text }]
}

const toolSuccess = (payload: Record<string, unknown>): DynamicToolCallResponse => ({
  success: true,
  contentItems: toToolContent({
    ok: true,
    ...payload
  })
})

const toolFailure = (message: string, details?: unknown): DynamicToolCallResponse => ({
  success: false,
  contentItems: toToolContent({
    ok: false,
    error: message,
    ...(details === undefined ? {} : { details })
  })
})

const toWorkflowSummary = (workflow: WorkflowDefinition) => ({
  fileSlug: workflow.fileSlug,
  filePath: workflow.filePath,
  isValid: workflow.isValid,
  parseError: workflow.parseError,
  name: workflow.frontmatter.name,
  description: workflow.frontmatter.description,
  schedule: workflow.frontmatter.on.schedule ?? null,
  interval: workflow.frontmatter.on.interval ?? null,
  rrule: workflow.frontmatter.on.rrule ?? null,
  workflowDispatch: workflow.frontmatter.on['workflow-dispatch'] === true,
  skills: workflow.frontmatter.skills,
  updatedAt: workflow.updatedAt
})

const normalizeWorkflowName = (value: string) => {
  const words = (value ?? '')
    .replace(/[^A-Za-z\s]/g, ' ')
    .split(/\s+/)
    .map(item => item.trim())
    .filter(Boolean)
    .filter(item => WORKFLOW_NAME_WORD_PATTERN.test(item))

  if (words.length === 0) {
    return DEFAULT_WORKFLOW_NAME
  }

  if (words.length === 1) {
    return `${words[0]} Workflow`
  }

  return words.slice(0, 3).map(word => `${word.slice(0, 1).toUpperCase()}${word.slice(1).toLowerCase()}`).join(' ')
}

const deriveWorkflowDescription = (value: string) => {
  const normalized = (value ?? '')
    .replace(WORKFLOW_META_PATTERN, ' ')
    .replace(WORKFLOW_SCHEDULE_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) {
    return '요청된 자동 작업을 수행합니다.'
  }

  return normalized.length > 180
    ? `${normalized.slice(0, 180).trimEnd()}...`
    : normalized
}

const tokenizeSlugSource = (value: string) =>
  (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .map(item => item.trim())
    .filter(item => item.length >= 2 && !SLUG_STOPWORDS.has(item))

const deriveInstructionBasedSlug = (instruction: string) => {
  const source = asString(instruction)
  if (!source) {
    return null
  }

  const quotedMatch = source.match(WORKFLOW_QUOTED_NAME_PATTERN)
  const quotedTokens = tokenizeSlugSource(quotedMatch?.[1] ?? '')
  if (quotedTokens.length > 0 && WORKFLOW_SAY_PATTERN.test(source)) {
    return `say-${quotedTokens.slice(0, 2).join('-')}`
  }

  const normalized = source
    .replace(WORKFLOW_ACTION_META_PATTERN, ' ')
    .replace(/\b(cron|rrule|interval|daily|weekly|monthly|hourly)\b/gi, ' ')
    .replace(/\bevery\s+\d+\s*(seconds?|minutes?|hours?|days?|weeks?|months?)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const tokens = tokenizeSlugSource(normalized)
  if (tokens.length > 0) {
    return tokens.slice(0, 4).join('-')
  }

  if (WORKFLOW_SAY_PATTERN.test(source)) {
    return 'say-message'
  }

  if (WORKFLOW_SUMMARY_PATTERN.test(source)) {
    return 'summary-report'
  }

  return null
}

const deriveFileSlug = (requestedFileSlug: string, workflowName: string, instruction: string) => {
  const requested = toWorkflowFileSlug(requestedFileSlug)
  if (requested && !GENERIC_WORKFLOW_SLUGS.has(requested)) {
    return requested
  }

  const fromName = toWorkflowFileSlug(workflowName)
  if (fromName && !GENERIC_WORKFLOW_SLUGS.has(fromName)) {
    return fromName
  }

  const fromInstruction = toWorkflowFileSlug(deriveInstructionBasedSlug(instruction) ?? '')
  if (fromInstruction && !GENERIC_WORKFLOW_SLUGS.has(fromInstruction)) {
    return fromInstruction
  }

  if (fromInstruction && fromInstruction !== 'workflow') {
    return fromInstruction
  }

  return fromName || requested || 'workflow'
}

const inferTriggerFromText = (text: string): { type: WorkflowTriggerType | null, value: string | null } => {
  const source = asString(text)
  if (!source) {
    return { type: null, value: null }
  }

  const rruleMatch = source.match(RRULE_PATTERN)
  if (rruleMatch) {
    const candidate = rruleMatch[0].toUpperCase()
    if (validateRRuleExpression(candidate)) {
      return { type: 'rrule', value: candidate }
    }
  }

  const tokens = source.replace(/\n/g, ' ').split(/\s+/).filter(Boolean)
  for (let index = 0; index <= tokens.length - 5; index += 1) {
    const candidate = tokens.slice(index, index + 5).join(' ')
    if (validateCronExpression(candidate)) {
      return { type: 'schedule', value: candidate }
    }
  }

  const compactInterval = source.match(INTERVAL_COMPACT_PATTERN)
  if (compactInterval) {
    const candidate = `${compactInterval[1]}${compactInterval[2]?.toLowerCase()}`
    if (validateIntervalExpression(candidate)) {
      return { type: 'interval', value: candidate }
    }
  }

  for (const entry of INTERVAL_NATURAL_PATTERNS) {
    const matched = source.match(entry.pattern)
    if (!matched) {
      continue
    }
    const candidate = `${matched[1]}${entry.unit}`
    if (validateIntervalExpression(candidate)) {
      return { type: 'interval', value: candidate }
    }
  }

  return { type: null, value: null }
}

const deriveInstructionFromText = (text: string) => {
  const source = asString(text)
  if (!source) {
    return ''
  }

  const quoted = source.match(WORKFLOW_QUOTED_TEXT_PATTERN)?.[1]?.trim() ?? ''
  if (quoted && WORKFLOW_SAY_PATTERN.test(source)) {
    return `각 실행에서 assistant 메시지로 정확히 "${quoted}" 한 줄만 출력한다.`
  }

  const normalized = source
    .replace(WORKFLOW_ACTION_META_PATTERN, ' ')
    .replace(WORKFLOW_SCHEDULE_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return normalized || source
}

const inferSelectorFromText = (
  text: string,
  workflows: WorkflowDefinition[]
): { slug: string | null, query: string | null } => {
  const source = asString(text).toLowerCase()
  if (!source || workflows.length === 0) {
    return { slug: null, query: asString(text) || null }
  }

  let bestSlug: string | null = null
  let bestScore = 0

  for (const workflow of workflows) {
    let score = 0
    const slug = workflow.fileSlug.toLowerCase()
    const name = workflow.frontmatter.name.toLowerCase()
    const description = workflow.frontmatter.description.toLowerCase()
    const instructionHead = workflow.instruction.toLowerCase().slice(0, 96)

    if (slug && source.includes(slug)) {
      score += 5
    }
    if (name && source.includes(name)) {
      score += 4
    }
    if (description && source.includes(description)) {
      score += 2
    }
    if (instructionHead && source.includes(instructionHead)) {
      score += 1
    }

    if (score > bestScore) {
      bestScore = score
      bestSlug = workflow.fileSlug
    }
  }

  if (bestScore <= 0) {
    return { slug: null, query: asString(text) || null }
  }

  return { slug: bestSlug, query: null }
}

const listAvailableSkills = () => {
  const candidates: string[] = []
  const codexHome = asString(process.env.CODEX_HOME)
  if (codexHome) {
    candidates.push(join(codexHome, 'skills'))
  }
  candidates.push(join(homedir(), '.codex', 'skills'))
  candidates.push(join(process.cwd(), 'templates', 'skills'))

  const names = new Set<string>()

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue
    }

    try {
      for (const entry of readdirSync(candidate, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue
        }
        if (entry.name.startsWith('.')) {
          continue
        }
        names.add(entry.name)
      }
    } catch {
      continue
    }
  }

  return [...names].sort((left, right) => left.localeCompare(right))
}

const parseWorkflowIntentFromText = (
  text: string,
  workflows: WorkflowDefinition[],
  availableSkills: string[]
): ParsedWorkflowIntent => {
  const source = asString(text)
  const lowered = source.toLowerCase()
  const selector = inferSelectorFromText(source, workflows)
  const trigger = inferTriggerFromText(source)
  const instruction = deriveInstructionFromText(source)
  const skills = availableSkills
    .filter(skill => lowered.includes(skill.toLowerCase()))
    .slice(0, 5)

  let action: ParsedWorkflowIntent['action'] = 'create'
  if (WORKFLOW_DELETE_PATTERN.test(source)) {
    action = 'delete'
  } else if (WORKFLOW_LIST_PATTERN.test(source)) {
    action = 'list'
  } else if (WORKFLOW_UPDATE_PATTERN.test(source)) {
    action = 'update'
  }

  return {
    action,
    confidence: 'low',
    reason: 'Deterministic local parser.',
    selector,
    listOptions: {
      runningOnly: WORKFLOW_RUNNING_PATTERN.test(source),
      activeOnly: WORKFLOW_ACTIVE_PATTERN.test(source),
      query: null
    },
    draft: {
      name: normalizeWorkflowName(instruction || source),
      description: deriveWorkflowDescription(instruction || source),
      instruction: instruction || source,
      triggerType: trigger.type,
      triggerValue: trigger.value,
      workflowDispatch: true,
      skills
    }
  }
}

const buildWorkflowFrontmatter = (input: {
  name: string
  description: string
  triggerType: WorkflowTriggerType | null
  triggerValue: string | null
  workflowDispatch: boolean
  skills: string[]
}): WorkflowFrontmatter => ({
  name: normalizeWorkflowName(input.name),
  description: deriveWorkflowDescription(input.description),
  on: {
    ...(input.triggerType === 'schedule' && input.triggerValue
      ? { schedule: input.triggerValue }
      : {}),
    ...(input.triggerType === 'interval' && input.triggerValue
      ? { interval: input.triggerValue }
      : {}),
    ...(input.triggerType === 'rrule' && input.triggerValue
      ? { rrule: input.triggerValue }
      : {}),
    'workflow-dispatch': input.workflowDispatch
  },
  skills: [...new Set(input.skills.map(item => item.trim()).filter(Boolean))]
})

const selectWorkflow = (
  workflows: WorkflowDefinition[],
  slugValue: unknown,
  queryValue: unknown
) => {
  const slug = asString(slugValue)
  if (slug) {
    const normalized = toWorkflowFileSlug(slug)
    const matched = workflows.find(item => item.fileSlug === normalized)
    if (!matched) {
      throw new Error(`Workflow not found: ${normalized}`)
    }
    return matched
  }

  const query = asString(queryValue).toLowerCase()
  if (!query) {
    throw new Error('Provide "slug" or "query".')
  }

  const matched = workflows.filter((workflow) => {
    const target = [
      workflow.fileSlug,
      workflow.frontmatter.name,
      workflow.frontmatter.description,
      workflow.instruction
    ].join('\n').toLowerCase()
    return target.includes(query)
  })

  if (matched.length === 0) {
    throw new Error(`No workflow matched query: ${queryValue}`)
  }
  if (matched.length > 1) {
    throw new Error(`Multiple workflows matched query: ${queryValue}`)
  }
  return matched[0] as WorkflowDefinition
}

const resolveTriggerInput = (args: Record<string, unknown>) => {
  const schedule = asString(args.schedule)
  const interval = asString(args.interval)
  const rrule = asString(args.rrule)

  if (schedule) {
    return { triggerType: 'schedule' as const, triggerValue: schedule }
  }
  if (interval) {
    return { triggerType: 'interval' as const, triggerValue: interval }
  }
  if (rrule) {
    return { triggerType: 'rrule' as const, triggerValue: rrule }
  }
  return { triggerType: null, triggerValue: null }
}

const handleWorkflowList = (args: Record<string, unknown>) => {
  const query = asString(args.query).toLowerCase()
  const validOnly = asBoolean(args.validOnly, false)
  const activeOnly = asBoolean(args.activeOnly, false)
  const runningOnly = asBoolean(args.runningOnly, false)

  let filtered = loadWorkflowDefinitions()

  if (query) {
    filtered = filtered.filter((workflow) => {
      const target = [
        workflow.fileSlug,
        workflow.frontmatter.name,
        workflow.frontmatter.description,
        workflow.instruction
      ].join('\n').toLowerCase()
      return target.includes(query)
    })
  }

  if (validOnly) {
    filtered = filtered.filter(workflow => workflow.isValid)
  }

  if (activeOnly) {
    filtered = filtered.filter(workflow =>
      workflow.isValid
      && (
        Boolean(workflow.frontmatter.on.schedule)
        || Boolean(workflow.frontmatter.on.interval)
        || Boolean(workflow.frontmatter.on.rrule)
        || workflow.frontmatter.on['workflow-dispatch'] === true
      ))
  }

  if (runningOnly) {
    filtered = filtered.filter(workflow =>
      workflow.isValid
      && (
        Boolean(workflow.frontmatter.on.schedule)
        || Boolean(workflow.frontmatter.on.interval)
        || Boolean(workflow.frontmatter.on.rrule)
      ))
  }

  return {
    action: 'list',
    count: filtered.length,
    workflows: filtered.map(toWorkflowSummary)
  }
}

const handleWorkflowInspect = (args: Record<string, unknown>) => {
  const workflows = loadWorkflowDefinitions()
  const workflow = selectWorkflow(workflows, args.slug, args.query)
  return {
    action: 'inspect',
    workflow: toWorkflowSummary(workflow),
    source: workflow.source
  }
}

const handleWorkflowCreate = (args: Record<string, unknown>) => {
  const instruction = asString(args.instruction)
  if (!instruction) {
    throw new Error('create requires "instruction".')
  }

  const { triggerType, triggerValue } = resolveTriggerInput(args)
  const frontmatter = buildWorkflowFrontmatter({
    name: asString(args.name) || instruction,
    description: asString(args.description) || instruction,
    triggerType,
    triggerValue,
    workflowDispatch: asBoolean(args.workflowDispatch, true),
    skills: asStringList(args.skills)
  })

  const fileSlug = resolveUniqueWorkflowFileSlug(
    deriveWorkflowFileSlugFromInput({
      requestedFileSlug: asString(args.fileSlug)
        || deriveFileSlug(asString(args.fileSlug), frontmatter.name, instruction),
      workflowName: frontmatter.name,
      instruction
    })
  )

  const created = writeWorkflowDefinition(fileSlug, frontmatter, instruction)
  reloadWorkflowScheduler()

  return {
    action: 'create',
    workflow: toWorkflowSummary(created)
  }
}

const handleWorkflowUpdate = (args: Record<string, unknown>) => {
  const workflows = loadWorkflowDefinitions()
  const target = selectWorkflow(workflows, args.slug, args.query)
  if (!target.isValid) {
    throw new Error(`Cannot update invalid workflow: ${target.fileSlug}`)
  }

  let triggerType: WorkflowTriggerType | null = null
  let triggerValue: string | null = null

  const fromInput = resolveTriggerInput(args)
  if (fromInput.triggerType && fromInput.triggerValue) {
    triggerType = fromInput.triggerType
    triggerValue = fromInput.triggerValue
  } else if (target.frontmatter.on.schedule) {
    triggerType = 'schedule'
    triggerValue = target.frontmatter.on.schedule
  } else if (target.frontmatter.on.interval) {
    triggerType = 'interval'
    triggerValue = target.frontmatter.on.interval
  } else if (target.frontmatter.on.rrule) {
    triggerType = 'rrule'
    triggerValue = target.frontmatter.on.rrule
  }

  if (asBoolean(args.clearSchedule, false) && triggerType === 'schedule') {
    triggerType = null
    triggerValue = null
  }
  if (asBoolean(args.clearInterval, false) && triggerType === 'interval') {
    triggerType = null
    triggerValue = null
  }
  if (asBoolean(args.clearRrule, false) && triggerType === 'rrule') {
    triggerType = null
    triggerValue = null
  }

  const explicitSkills = asStringList(args.skills)
  const addSkills = asStringList(args.addSkills)
  const removeSkillSet = new Set(asStringList(args.removeSkills))
  const nextSkillsBase = explicitSkills.length > 0
    ? explicitSkills
    : target.frontmatter.skills
  const nextSkills = [...new Set([...nextSkillsBase, ...addSkills])]
    .filter(item => !removeSkillSet.has(item))

  const frontmatter = buildWorkflowFrontmatter({
    name: asString(args.name) || target.frontmatter.name,
    description: asString(args.description) || target.frontmatter.description,
    triggerType,
    triggerValue,
    workflowDispatch: asBoolean(args.workflowDispatch, target.frontmatter.on['workflow-dispatch'] === true),
    skills: nextSkills
  })

  const instruction = asString(args.instruction) || target.instruction
  const updated = writeWorkflowDefinition(target.fileSlug, frontmatter, instruction)
  reloadWorkflowScheduler()

  return {
    action: 'update',
    workflow: toWorkflowSummary(updated)
  }
}

const handleWorkflowDelete = (args: Record<string, unknown>) => {
  const workflows = loadWorkflowDefinitions()
  const target = selectWorkflow(workflows, args.slug, args.query)
  const deleted = deleteWorkflowDefinitionBySlug(target.fileSlug)
  if (!deleted) {
    throw new Error(`Workflow not found: ${target.fileSlug}`)
  }
  reloadWorkflowScheduler()

  return {
    action: 'delete',
    deleted: true,
    workflow: toWorkflowSummary(target)
  }
}

const handleWorkflowFromText = (args: Record<string, unknown>) => {
  const text = asString(args.text)
  if (!text) {
    throw new Error('from-text requires "text".')
  }

  return {
    action: 'from-text',
    parsed: parseWorkflowIntentFromText(
      text,
      loadWorkflowDefinitions(),
      listAvailableSkills()
    )
  }
}

const handleWorkflowApplyText = (args: Record<string, unknown>) => {
  const text = asString(args.text)
  if (!text) {
    throw new Error('apply-text requires "text".')
  }

  const parsed = parseWorkflowIntentFromText(
    text,
    loadWorkflowDefinitions(),
    listAvailableSkills()
  )

  if (parsed.action === 'list') {
    const result = handleWorkflowList({
      query: parsed.listOptions.query ?? '',
      activeOnly: parsed.listOptions.activeOnly,
      runningOnly: parsed.listOptions.runningOnly
    })
    return {
      ...result,
      parsed
    }
  }

  if (parsed.action === 'delete') {
    const result = handleWorkflowDelete({
      slug: parsed.selector.slug ?? '',
      query: parsed.selector.query ?? ''
    })
    return {
      ...result,
      parsed
    }
  }

  if (parsed.action === 'update') {
    const result = handleWorkflowUpdate({
      slug: parsed.selector.slug ?? '',
      query: parsed.selector.query ?? '',
      name: parsed.draft.name,
      description: parsed.draft.description,
      instruction: parsed.draft.instruction,
      schedule: parsed.draft.triggerType === 'schedule' ? parsed.draft.triggerValue ?? '' : '',
      interval: parsed.draft.triggerType === 'interval' ? parsed.draft.triggerValue ?? '' : '',
      rrule: parsed.draft.triggerType === 'rrule' ? parsed.draft.triggerValue ?? '' : '',
      workflowDispatch: parsed.draft.workflowDispatch,
      skills: parsed.draft.skills
    })
    return {
      ...result,
      parsed
    }
  }

  const result = handleWorkflowCreate({
    instruction: parsed.draft.instruction || text,
    name: parsed.draft.name,
    description: parsed.draft.description,
    schedule: parsed.draft.triggerType === 'schedule' ? parsed.draft.triggerValue ?? '' : '',
    interval: parsed.draft.triggerType === 'interval' ? parsed.draft.triggerValue ?? '' : '',
    rrule: parsed.draft.triggerType === 'rrule' ? parsed.draft.triggerValue ?? '' : '',
    workflowDispatch: parsed.draft.workflowDispatch,
    skills: parsed.draft.skills
  })
  return {
    ...result,
    parsed
  }
}

const handleSharedMemoryTool: NativeDynamicToolHandler = async (input) => {
  const args = asRecord(input)
  const command = normalizeCommand(args.command)
  if (!command) {
    return toolFailure('shared-memory requires "command".')
  }

  try {
    if (command === 'ensure') {
      const health = await getMemoryHealth()
      return toolSuccess({
        tool: SHARED_MEMORY_TOOL_NAME,
        command,
        health
      })
    }

    if (command === 'search') {
      const query = asString(args.query)
      if (!query) {
        return toolFailure('shared-memory search requires "query".')
      }

      const limit = clampMemoryLimit(args.limit)
      const results = await searchMemories({
        query,
        limit
      })
      return toolSuccess({
        tool: SHARED_MEMORY_TOOL_NAME,
        command,
        query,
        limit,
        results
      })
    }

    if (command === 'upsert') {
      const text = asString(args.text)
      if (!text) {
        return toolFailure('shared-memory upsert requires "text".')
      }

      const section = asString(args.section) || DEFAULT_MEMORY_SECTION
      const upserted = await rememberText({
        text,
        metadata: {
          source: 'shared-memory-native-tool',
          section
        }
      })

      return toolSuccess({
        tool: SHARED_MEMORY_TOOL_NAME,
        command,
        section,
        text,
        memories: upserted.memories,
        messageCount: upserted.messageCount
      })
    }

    return toolFailure(`Unsupported shared-memory command: ${command}`)
  } catch (error) {
    return toolFailure(error instanceof Error ? error.message : String(error))
  }
}

const handleManageWorkflowsTool: NativeDynamicToolHandler = async (input) => {
  const args = asRecord(input)
  const command = normalizeCommand(args.command)
  if (!command) {
    return toolFailure('manage-workflows requires "command".')
  }

  if (!WORKFLOW_COMMANDS.has(command)) {
    return toolFailure(`Unsupported manage-workflows command: ${command}`)
  }

  try {
    if (command === 'list') {
      return toolSuccess({
        tool: MANAGE_WORKFLOW_TOOL_NAME,
        ...handleWorkflowList(args)
      })
    }

    if (command === 'inspect') {
      return toolSuccess({
        tool: MANAGE_WORKFLOW_TOOL_NAME,
        ...handleWorkflowInspect(args)
      })
    }

    if (command === 'create') {
      return toolSuccess({
        tool: MANAGE_WORKFLOW_TOOL_NAME,
        ...handleWorkflowCreate(args)
      })
    }

    if (command === 'update') {
      return toolSuccess({
        tool: MANAGE_WORKFLOW_TOOL_NAME,
        ...handleWorkflowUpdate(args)
      })
    }

    if (command === 'delete') {
      return toolSuccess({
        tool: MANAGE_WORKFLOW_TOOL_NAME,
        ...handleWorkflowDelete(args)
      })
    }

    if (command === 'from-text') {
      return toolSuccess({
        tool: MANAGE_WORKFLOW_TOOL_NAME,
        ...handleWorkflowFromText(args)
      })
    }

    return toolSuccess({
      tool: MANAGE_WORKFLOW_TOOL_NAME,
      ...handleWorkflowApplyText(args)
    })
  } catch (error) {
    return toolFailure(error instanceof Error ? error.message : String(error))
  }
}

const nativeTools: NativeDynamicTool[] = [
  {
    aliases: [
      SHARED_MEMORY_TOOL_NAME,
      'corazonSharedMemory',
      'shared-memory',
      'shared_memory'
    ],
    spec: {
      name: SHARED_MEMORY_TOOL_NAME,
      description: 'Native shared memory manager. Commands: ensure, search, upsert.',
      inputSchema: SHARED_MEMORY_TOOL_SCHEMA
    },
    handle: handleSharedMemoryTool
  },
  {
    aliases: [
      MANAGE_WORKFLOW_TOOL_NAME,
      'corazonManageWorkflow',
      'manage-workflows',
      'manage_workflows'
    ],
    spec: {
      name: MANAGE_WORKFLOW_TOOL_NAME,
      description: 'Native workflow definition manager for Corazon workflows/*.md. Commands: list/create/update/delete/from-text/apply-text/inspect.',
      inputSchema: MANAGE_WORKFLOWS_TOOL_SCHEMA
    },
    handle: handleManageWorkflowsTool
  }
]

const nativeToolRegistry = (() => {
  const registry = new Map<string, NativeDynamicTool>()
  for (const tool of nativeTools) {
    for (const alias of tool.aliases) {
      registry.set(normalizeToolName(alias), tool)
    }
  }
  return registry
})()

export const getNativeDynamicToolSpecs = (): DynamicToolSpec[] =>
  nativeTools.map(tool => ({
    name: tool.spec.name,
    description: tool.spec.description,
    inputSchema: tool.spec.inputSchema
  }))

export const resolveNativeDynamicToolCall = async (request: DynamicToolCallParams) => {
  const key = normalizeToolName(request.tool)
  const tool = nativeToolRegistry.get(key)
  if (!tool) {
    return null
  }

  return tool.handle(request.arguments, request)
}
