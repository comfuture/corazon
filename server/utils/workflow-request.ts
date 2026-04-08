import type { WorkflowFrontmatter, WorkflowLanguage, WorkflowTriggerConfig, WorkflowUpsertRequest } from '@@/types/workflow'

const WORKFLOW_NAME_PATTERN = /^[A-Za-z]+(?: [A-Za-z]+){1,2}$/
const WORKFLOW_LANGUAGES = new Set<WorkflowLanguage>(['markdown', 'typescript', 'python'])

const normalizeLanguage = (value: unknown): WorkflowLanguage => {
  if (typeof value !== 'string' || !value.trim()) {
    return 'markdown'
  }
  const normalized = value.trim().toLowerCase()
  if (!WORKFLOW_LANGUAGES.has(normalized as WorkflowLanguage)) {
    throw new Error('Workflow language must be one of: markdown, typescript, python.')
  }
  return normalized as WorkflowLanguage
}

const asString = (value: unknown) => typeof value === 'string' ? value.trim() : ''

const asStringArray = (value: unknown) => {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .filter(item => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)
}

const normalizeTriggerConfig = (input: {
  language: WorkflowLanguage
  triggerType: WorkflowUpsertRequest['triggerType']
  triggerValue: string | null
  workflowDispatch: boolean
}): WorkflowTriggerConfig => {
  const on: WorkflowTriggerConfig = {
    'workflow-dispatch': input.workflowDispatch
  }

  if (input.triggerType === 'schedule') {
    if (!input.triggerValue) {
      throw new Error('Schedule value is required.')
    }
    if (!validateCronExpression(input.triggerValue)) {
      throw new Error('Invalid cron expression.')
    }
    on.schedule = input.triggerValue
    return on
  }

  if (input.triggerType === 'interval') {
    if (!input.triggerValue) {
      throw new Error('Interval value is required.')
    }
    if (!validateIntervalExpression(input.triggerValue)) {
      throw new Error('Invalid interval expression.')
    }
    on.interval = input.triggerValue
    return on
  }

  if (input.triggerType === 'rrule') {
    if (!input.triggerValue) {
      throw new Error('RRULE value is required.')
    }
    if (!validateRRuleExpression(input.triggerValue)) {
      throw new Error('Invalid RRULE expression.')
    }
    on.rrule = input.triggerValue
    return on
  }

  if (!input.workflowDispatch) {
    throw new Error('Enable direct execution when no schedule/interval/rrule is configured.')
  }

  return on
}

export const parseWorkflowUpsertRequest = (body: unknown) => {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>

  const name = asString(raw.name)
  const description = asString(raw.description)
  const language = normalizeLanguage(raw.language)
  const instructionInput = asString(raw.instruction)
  const instruction = language === 'markdown'
    ? normalizeWorkflowInstructionText(instructionInput)
    : instructionInput
  const skills = asStringArray(raw.skills)
  const triggerType = raw.triggerType === 'schedule' || raw.triggerType === 'interval' || raw.triggerType === 'rrule'
    ? raw.triggerType
    : null
  const triggerValue = raw.triggerValue == null ? null : asString(raw.triggerValue)
  const workflowDispatch = raw.workflowDispatch === true

  if (!name) {
    throw new Error('Workflow name is required.')
  }
  if (!WORKFLOW_NAME_PATTERN.test(name)) {
    throw new Error('Workflow name must be 2-3 English words.')
  }
  if (!description) {
    throw new Error('Workflow description is required.')
  }
  if (!instruction) {
    throw new Error('Workflow instruction is required.')
  }

  const frontmatter: WorkflowFrontmatter = {
    name,
    description,
    language,
    on: normalizeTriggerConfig({
      language,
      triggerType,
      triggerValue,
      workflowDispatch
    }),
    skills: [...new Set(skills)]
  }

  return {
    frontmatter,
    instruction
  }
}
