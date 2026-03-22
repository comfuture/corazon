import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DynamicToolCallParams } from '@@/types/codex-app-server/v2/DynamicToolCallParams'
import type { DynamicToolCallOutputContentItem } from '@@/types/codex-app-server/v2/DynamicToolCallOutputContentItem'
import type { DynamicToolCallResponse } from '@@/types/codex-app-server/v2/DynamicToolCallResponse'
import type { DynamicToolSpec } from '@@/types/codex-app-server/v2/DynamicToolSpec'
import type { JsonValue } from '@@/types/codex-app-server/serde_json/JsonValue'
import type { WorkflowDefinition, WorkflowFrontmatter } from '@@/types/workflow'
import { rememberText, searchMemories } from '../memory.ts'
import {
  deleteWorkflowDefinitionBySlug,
  deriveWorkflowFileSlugFromInput,
  loadWorkflowDefinitions,
  normalizeWorkflowInstructionText,
  ensureDetailedWorkflowInstruction,
  resolveUniqueWorkflowFileSlug,
  toWorkflowFileSlug,
  validateCronExpression,
  validateIntervalExpression,
  validateRRuleExpression,
  writeWorkflowDefinition
} from '../workflow-definitions.ts'
import { inferWorkflowDraftWithAI } from '../workflow-ai.ts'
import { reloadWorkflowScheduler } from '../workflow-scheduler.ts'

type NativeDynamicToolHandler = (input: unknown, params: DynamicToolCallParams) => Promise<DynamicToolCallResponse>

type NativeDynamicTool = {
  aliases: string[]
  spec: DynamicToolSpec
  handle: NativeDynamicToolHandler
}

type WorkflowTriggerType = 'schedule' | 'interval' | 'rrule'

type ParsedWorkflowDraft = {
  confidence: 'high' | 'low'
  reason: string
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
const NOTIFY_OPERATOR_TOOL_NAME = 'notifyOperator'
const DEFAULT_MEMORY_SEARCH_LIMIT = 5
const DEFAULT_MEMORY_SECTION = 'Facts'
const DEFAULT_WORKFLOW_NAME = 'Task Workflow'
const WORKFLOW_DESCRIPTION_MAX_LENGTH = 180
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

const SHARED_MEMORY_TOOL_SCHEMA: JsonValue = {
  type: 'object',
  additionalProperties: false,
  properties: {
    command: {
      type: 'string',
      enum: ['search', 'upsert']
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
    mode: {
      type: 'string',
      enum: ['auto', 'create', 'update']
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

const NOTIFY_OPERATOR_TOOL_SCHEMA: JsonValue = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    message: { type: 'string' },
    nextAction: { type: 'string' },
    severity: {
      type: 'string',
      enum: ['info', 'warning', 'blocker']
    },
    source: {
      type: 'string',
      enum: ['workflow', 'background-task', 'system']
    },
    workflowName: { type: 'string' },
    workflowFileSlug: { type: 'string' },
    runId: { type: 'string' },
    triggerType: {
      type: 'string',
      enum: ['schedule', 'interval', 'rrule', 'workflow-dispatch']
    },
    triggerValue: { type: 'string' },
    sessionThreadId: { type: 'string' },
    taskName: { type: 'string' },
    branch: { type: 'string' },
    prNumber: { type: 'integer' },
    issueNumber: { type: 'integer' }
  },
  required: ['title']
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

const asInteger = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value)
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10)
    return Number.isFinite(parsed) ? parsed : null
  }

  return null
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

const normalizeWorkflowDescription = (value: string) => {
  const normalized = (value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim()

  if (!normalized) {
    return '요청된 자동 작업을 수행합니다.'
  }

  return normalized.length > WORKFLOW_DESCRIPTION_MAX_LENGTH
    ? `${normalized.slice(0, WORKFLOW_DESCRIPTION_MAX_LENGTH).trimEnd()}...`
    : normalized
}

const resolveValidatedTrigger = (
  triggerType: 'schedule' | 'interval' | 'rrule' | 'none',
  triggerValue: string
): { triggerType: WorkflowTriggerType | null, triggerValue: string | null } => {
  const value = asString(triggerValue)
  if (!value) {
    return { triggerType: null, triggerValue: null }
  }

  if (triggerType === 'schedule' && validateCronExpression(value)) {
    return { triggerType: 'schedule', triggerValue: value }
  }
  if (triggerType === 'interval' && validateIntervalExpression(value)) {
    return { triggerType: 'interval', triggerValue: value }
  }
  if (triggerType === 'rrule' && validateRRuleExpression(value)) {
    return { triggerType: 'rrule', triggerValue: value }
  }

  return { triggerType: null, triggerValue: null }
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

const parseWorkflowDraftFromText = async (text: string): Promise<ParsedWorkflowDraft> => {
  const source = asString(text)
  const availableSkills = listAvailableSkills()

  try {
    const inferred = await inferWorkflowDraftWithAI({
      text: source,
      availableSkills
    })

    if (inferred) {
      const resolvedTrigger = resolveValidatedTrigger(inferred.triggerType, inferred.triggerValue)
      return {
        confidence: inferred.confidence,
        reason: 'AI workflow draft parser.',
        draft: {
          name: normalizeWorkflowName(inferred.suggestedName || source),
          description: normalizeWorkflowDescription(
            inferred.suggestedDescription || inferred.enhancedInstruction || source
          ),
          instruction: ensureDetailedWorkflowInstruction(
            asString(inferred.enhancedInstruction) || source
          ),
          triggerType: resolvedTrigger.triggerType,
          triggerValue: resolvedTrigger.triggerValue,
          workflowDispatch: true,
          skills: [...new Set(inferred.suggestedSkills.map(item => item.trim()).filter(Boolean))]
        }
      }
    }
  } catch (error) {
    console.error('Failed to parse workflow draft with AI:', error)
  }

  return {
    confidence: 'low',
    reason: 'AI parser unavailable; used conservative fallback.',
    draft: {
      name: normalizeWorkflowName(source),
      description: normalizeWorkflowDescription(source),
      instruction: ensureDetailedWorkflowInstruction(source),
      triggerType: null,
      triggerValue: null,
      workflowDispatch: true,
      skills: []
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
  description: normalizeWorkflowDescription(input.description),
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
  const instruction = normalizeWorkflowInstructionText(asString(args.instruction))
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

  const fileSlug = resolveUniqueWorkflowFileSlug(deriveWorkflowFileSlugFromInput({
    requestedFileSlug: asString(args.fileSlug) || null,
    workflowName: frontmatter.name,
    instruction
  }))

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

  const instruction = normalizeWorkflowInstructionText(asString(args.instruction)) || target.instruction
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

const resolveApplyTextMode = (value: unknown): 'auto' | 'create' | 'update' => {
  const normalized = normalizeCommand(value)
  if (normalized === 'create' || normalized === 'update') {
    return normalized
  }
  return 'auto'
}

const handleWorkflowFromText = async (args: Record<string, unknown>) => {
  const text = asString(args.text)
  if (!text) {
    throw new Error('from-text requires "text".')
  }

  const parsed = await parseWorkflowDraftFromText(text)
  const hasTarget = Boolean(asString(args.slug) || asString(args.query))

  return {
    action: 'from-text',
    parsed,
    recommendedCommand: hasTarget ? 'update' : 'create'
  }
}

const handleWorkflowApplyText = async (args: Record<string, unknown>) => {
  const text = asString(args.text)
  if (!text) {
    throw new Error('apply-text requires "text".')
  }

  const parsed = await parseWorkflowDraftFromText(text)
  const hasTarget = Boolean(asString(args.slug) || asString(args.query))
  const requestedMode = resolveApplyTextMode(args.mode)
  const resolvedMode = requestedMode === 'auto'
    ? (hasTarget ? 'update' : 'create')
    : requestedMode

  if (resolvedMode === 'update') {
    if (!hasTarget) {
      throw new Error('apply-text update mode requires "slug" or "query".')
    }

    const result = handleWorkflowUpdate({
      slug: asString(args.slug),
      query: asString(args.query),
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
      parsed,
      resolvedMode
    }
  }

  const result = handleWorkflowCreate({
    instruction: parsed.draft.instruction || text,
    fileSlug: asString(args.fileSlug),
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
    parsed,
    resolvedMode
  }
}

const handleSharedMemoryTool: NativeDynamicToolHandler = async (input) => {
  const args = asRecord(input)
  const command = normalizeCommand(args.command)
  if (!command) {
    return toolFailure('shared-memory requires "command".')
  }

  try {
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
        ...await handleWorkflowFromText(args)
      })
    }

    return toolSuccess({
      tool: MANAGE_WORKFLOW_TOOL_NAME,
      ...await handleWorkflowApplyText(args)
    })
  } catch (error) {
    return toolFailure(error instanceof Error ? error.message : String(error))
  }
}

const handleNotifyOperatorTool: NativeDynamicToolHandler = async (input) => {
  const args = asRecord(input)
  const title = asString(args.title)
  if (!title) {
    return toolFailure('notify-operator requires "title".')
  }

  try {
    const result = await sendOperatorNotification({
      title,
      message: asString(args.message) || null,
      nextAction: asString(args.nextAction) || null,
      severity: (
        asString(args.severity) === 'warning'
        || asString(args.severity) === 'blocker'
        || asString(args.severity) === 'info'
      )
        ? asString(args.severity) as 'info' | 'warning' | 'blocker'
        : 'info',
      source: (
        asString(args.source) === 'workflow'
        || asString(args.source) === 'background-task'
        || asString(args.source) === 'system'
      )
        ? asString(args.source) as 'workflow' | 'background-task' | 'system'
        : 'system',
      context: {
        workflowName: asString(args.workflowName) || null,
        workflowFileSlug: asString(args.workflowFileSlug) || null,
        runId: asString(args.runId) || null,
        triggerType: (
          asString(args.triggerType) === 'schedule'
          || asString(args.triggerType) === 'interval'
          || asString(args.triggerType) === 'rrule'
          || asString(args.triggerType) === 'workflow-dispatch'
        )
          ? asString(args.triggerType) as 'schedule' | 'interval' | 'rrule' | 'workflow-dispatch'
          : null,
        triggerValue: asString(args.triggerValue) || null,
        sessionThreadId: asString(args.sessionThreadId) || null,
        taskName: asString(args.taskName) || null,
        branch: asString(args.branch) || null,
        prNumber: asInteger(args.prNumber),
        issueNumber: asInteger(args.issueNumber)
      }
    })

    return toolSuccess({
      tool: NOTIFY_OPERATOR_TOOL_NAME,
      delivered: result.delivered,
      skippedReason: result.skippedReason,
      messageId: result.messageId
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
      description: 'Native shared memory manager. Commands: search and upsert.',
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
      description: 'Native workflow manager for Corazon workflows/*.md. Prefer explicit commands (list/inspect/create/update/delete). from-text/apply-text use AI draft parsing for natural-language workflow authoring.',
      inputSchema: MANAGE_WORKFLOWS_TOOL_SCHEMA
    },
    handle: handleManageWorkflowsTool
  },
  {
    aliases: [
      NOTIFY_OPERATOR_TOOL_NAME,
      'corazonNotifyOperator',
      'notify-operator',
      'notify_operator'
    ],
    spec: {
      name: NOTIFY_OPERATOR_TOOL_NAME,
      description: 'Native operator notification sender for high-signal Telegram alerts from workflows and background tasks.',
      inputSchema: NOTIFY_OPERATOR_TOOL_SCHEMA
    },
    handle: handleNotifyOperatorTool
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
