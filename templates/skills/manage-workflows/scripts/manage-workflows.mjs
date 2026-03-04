#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Codex } from '@openai/codex-sdk'
import { Cron } from 'croner'
import { rrulestr } from 'rrule'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

const WORKFLOWS_DIRECTORY = 'workflows'
const WORKFLOW_FILE_EXTENSION = '.md'
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/
const WORKFLOW_NAME_PATTERN = /^[A-Za-z]+(?: [A-Za-z]+){1,2}$/
const WORKFLOW_NAME_WORD_PATTERN = /^[A-Za-z]+$/
const DEFAULT_WORKFLOW_NAME = 'Task Workflow'
const INTERVAL_PATTERN = /^([1-9][0-9]*)(s|m|h)$/
const INFER_MODEL = 'gpt-5.1-codex-mini'

/** @typedef {'schedule' | 'interval' | 'rrule' | null} TriggerType */

const AI_ACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'confidence', 'reason', 'selector', 'listOptions', 'draft'],
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'create', 'update', 'delete']
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low']
    },
    reason: {
      type: 'string'
    },
    selector: {
      type: 'object',
      additionalProperties: false,
      required: ['slug', 'query'],
      properties: {
        slug: { type: ['string', 'null'] },
        query: { type: ['string', 'null'] }
      }
    },
    listOptions: {
      type: 'object',
      additionalProperties: false,
      required: ['runningOnly', 'activeOnly', 'query'],
      properties: {
        runningOnly: { type: 'boolean' },
        activeOnly: { type: 'boolean' },
        query: { type: ['string', 'null'] }
      }
    },
    draft: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'description', 'instruction', 'triggerType', 'triggerValue', 'workflowDispatch', 'skills'],
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        instruction: { type: 'string' },
        triggerType: {
          type: ['string', 'null'],
          enum: ['schedule', 'interval', 'rrule', null]
        },
        triggerValue: { type: ['string', 'null'] },
        workflowDispatch: { type: 'boolean' },
        skills: {
          type: 'array',
          items: { type: 'string' }
        }
      }
    }
  }
}

const toJson = payload => JSON.stringify(payload, null, 2)

const fail = (message, details) => {
  const payload = details ? { ok: false, error: message, details } : { ok: false, error: message }
  console.error(toJson(payload))
  process.exit(1)
}

const asString = value => typeof value === 'string' ? value.trim() : ''

const asStringArray = (value) => {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .filter(item => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)
}

const parseCsv = value => asString(value)
  .split(',')
  .map(item => item.trim())
  .filter(Boolean)

const parseBoolean = (value, fallback = null) => {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value !== 'string') {
    return fallback
  }
  const normalized = value.trim().toLowerCase()
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'y') {
    return true
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'n') {
    return false
  }
  return fallback
}

const splitCommandAndOptions = (argv) => {
  const [command, ...rest] = argv
  const options = {}

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (!token.startsWith('--')) {
      continue
    }

    const key = token.slice(2)
    const next = rest[index + 1]
    if (!next || next.startsWith('--')) {
      options[key] = true
      continue
    }

    options[key] = next
    index += 1
  }

  return { command, options }
}

let cachedCorazonRootDir = null

const getLegacyCorazonRootDir = () => join(homedir(), '.corazon')

const getLinuxCorazonRootDir = () => {
  const xdgConfigHome = asString(process.env.XDG_CONFIG_HOME)
  if (xdgConfigHome) {
    return join(xdgConfigHome, 'corazon')
  }
  return join(homedir(), '.config', 'corazon')
}

const getWindowsCorazonRootDir = () => {
  const appData = asString(process.env.APPDATA)
  if (appData) {
    return join(appData, 'Corazon')
  }
  return join(homedir(), 'AppData', 'Roaming', 'Corazon')
}

const getPlatformDefaultCorazonRootDir = () => {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Corazon')
  }
  if (process.platform === 'win32') {
    return getWindowsCorazonRootDir()
  }
  return getLinuxCorazonRootDir()
}

const resolveDefaultCorazonRootDir = () => {
  if (cachedCorazonRootDir) {
    return cachedCorazonRootDir
  }

  const configuredRoot = asString(process.env.CORAZON_ROOT_DIR) || asString(process.env.CORAZON_ROOT)
  if (configuredRoot) {
    cachedCorazonRootDir = configuredRoot
    return cachedCorazonRootDir
  }

  const legacyRoot = getLegacyCorazonRootDir()
  if (process.platform === 'darwin') {
    cachedCorazonRootDir = legacyRoot
    return cachedCorazonRootDir
  }

  if (existsSync(legacyRoot)) {
    cachedCorazonRootDir = legacyRoot
    return cachedCorazonRootDir
  }

  cachedCorazonRootDir = getPlatformDefaultCorazonRootDir()
  return cachedCorazonRootDir
}

const resolveRootDirectory = (options) => {
  const explicitRoot = asString(options.root)
  if (explicitRoot) {
    return resolve(explicitRoot)
  }
  return resolveDefaultCorazonRootDir()
}

const toTitleCase = (value) => {
  if (!value) {
    return value
  }
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase()
}

const normalizeWorkflowName = (value) => {
  const words = (value ?? '')
    .replace(/[^A-Za-z\s]/g, ' ')
    .split(/\s+/)
    .map(item => item.trim())
    .filter(item => item.length > 0 && WORKFLOW_NAME_WORD_PATTERN.test(item))

  if (words.length === 0) {
    return DEFAULT_WORKFLOW_NAME
  }

  if (words.length === 1) {
    return `${toTitleCase(words[0] ?? 'Task')} Workflow`
  }

  return words.slice(0, 3).map(toTitleCase).join(' ')
}

const deriveWorkflowDescription = (value) => {
  const trimmed = asString(value)
  if (!trimmed) {
    return 'Workflow created from manage-workflows skill'
  }
  return trimmed.length > 280 ? `${trimmed.slice(0, 280).trim()}...` : trimmed
}

const toWorkflowFileSlug = (value) => {
  const normalized = asString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return normalized || 'workflow'
}

const getWorkflowsDirectory = rootDir => join(rootDir, WORKFLOWS_DIRECTORY)

const getWorkflowFilePath = (rootDir, fileSlug) =>
  join(getWorkflowsDirectory(rootDir), `${fileSlug}${WORKFLOW_FILE_EXTENSION}`)

const ensureWorkflowsDirectory = (rootDir) => {
  const directory = getWorkflowsDirectory(rootDir)
  mkdirSync(directory, { recursive: true })
  return directory
}

const resolveUniqueWorkflowFileSlug = (rootDir, baseSlug) => {
  const normalized = toWorkflowFileSlug(baseSlug)
  const workflowsDir = ensureWorkflowsDirectory(rootDir)

  let nextSlug = normalized
  let index = 2

  while (existsSync(join(workflowsDir, `${nextSlug}${WORKFLOW_FILE_EXTENSION}`))) {
    nextSlug = `${normalized}-${index}`
    index += 1
  }

  return nextSlug
}

const asRecord = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return /** @type {Record<string, unknown>} */ (value)
}

const normalizeWorkflowFrontmatter = (value) => {
  const record = asRecord(value)
  if (!record) {
    return null
  }

  const on = asRecord(record.on)
  if (!on) {
    return null
  }

  return {
    name: asString(record.name),
    description: asString(record.description),
    on: {
      'schedule': asString(on.schedule) || undefined,
      'interval': asString(on.interval) || undefined,
      'rrule': asString(on.rrule) || undefined,
      'workflow-dispatch': on['workflow-dispatch'] === true
    },
    skills: asStringArray(record.skills)
  }
}

const validateCronExpression = (value) => {
  try {
    const cron = new Cron(value, () => {})
    cron.stop()
    return true
  } catch {
    return false
  }
}

const validateIntervalExpression = value => INTERVAL_PATTERN.test(asString(value))

const validateRRuleExpression = (value) => {
  try {
    rrulestr(value)
    return true
  } catch {
    return false
  }
}

const validateWorkflow = (frontmatter, instruction) => {
  const name = asString(frontmatter.name)
  const description = asString(frontmatter.description)
  const body = asString(instruction)

  if (!WORKFLOW_NAME_PATTERN.test(name)) {
    return 'Workflow name must be 2-3 English words.'
  }
  if (!description) {
    return 'Workflow description is required.'
  }
  if (!body) {
    return 'Workflow instruction is required.'
  }

  const schedule = asString(frontmatter.on.schedule)
  const interval = asString(frontmatter.on.interval)
  const rrule = asString(frontmatter.on.rrule)
  const workflowDispatch = frontmatter.on['workflow-dispatch'] === true

  const timeTriggerCount = [schedule, interval, rrule].filter(Boolean).length
  if (timeTriggerCount > 1) {
    return 'Only one time trigger is allowed: schedule, interval, or rrule.'
  }
  if (schedule && !validateCronExpression(schedule)) {
    return 'Invalid cron expression in on.schedule.'
  }
  if (interval && !validateIntervalExpression(interval)) {
    return 'Invalid interval expression in on.interval.'
  }
  if (rrule && !validateRRuleExpression(rrule)) {
    return 'Invalid RRULE expression in on.rrule.'
  }
  if (!schedule && !interval && !rrule && !workflowDispatch) {
    return 'Enable workflow-dispatch when no time trigger exists.'
  }

  return null
}

const serializeWorkflowSource = (frontmatterInput, instructionInput) => {
  const frontmatter = {
    name: normalizeWorkflowName(frontmatterInput.name),
    description: deriveWorkflowDescription(frontmatterInput.description),
    on: {
      'schedule': asString(frontmatterInput.on.schedule) || undefined,
      'interval': asString(frontmatterInput.on.interval) || undefined,
      'rrule': asString(frontmatterInput.on.rrule) || undefined,
      'workflow-dispatch': frontmatterInput.on['workflow-dispatch'] === true
    },
    skills: [...new Set(asStringArray(frontmatterInput.skills))]
  }
  const instruction = asString(instructionInput)

  const validationError = validateWorkflow(frontmatter, instruction)
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

const createInvalidWorkflow = input => ({
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

const parseWorkflowSource = (input) => {
  const matched = input.source.match(FRONTMATTER_PATTERN)
  if (!matched) {
    return createInvalidWorkflow({
      ...input,
      parseError: 'Workflow file must start with YAML frontmatter.'
    })
  }

  let parsedFrontmatter
  try {
    parsedFrontmatter = parseYaml(matched[1] ?? '')
  } catch (error) {
    return createInvalidWorkflow({
      ...input,
      parseError: error instanceof Error ? error.message : 'Invalid YAML frontmatter.'
    })
  }

  const frontmatter = normalizeWorkflowFrontmatter(parsedFrontmatter)
  if (!frontmatter) {
    return createInvalidWorkflow({
      ...input,
      parseError: 'Frontmatter must include name, description, on, skills.'
    })
  }

  const instruction = asString(matched[2] ?? '')
  const validationError = validateWorkflow(frontmatter, instruction)
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

const loadWorkflowDefinitions = (rootDir) => {
  const directory = getWorkflowsDirectory(rootDir)
  if (!existsSync(directory)) {
    return []
  }

  const entries = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(WORKFLOW_FILE_EXTENSION))

  return entries
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
}

const writeWorkflowDefinition = (rootDir, fileSlug, frontmatter, instruction) => {
  const normalizedSlug = toWorkflowFileSlug(fileSlug)
  const source = serializeWorkflowSource(frontmatter, instruction)
  const filePath = getWorkflowFilePath(rootDir, normalizedSlug)

  ensureWorkflowsDirectory(rootDir)
  writeFileSync(filePath, source, 'utf8')

  return parseWorkflowSource({
    fileSlug: normalizedSlug,
    filePath,
    source,
    updatedAt: statSync(filePath).mtimeMs
  })
}

const deleteWorkflowDefinitionBySlug = (rootDir, fileSlug) => {
  const normalizedSlug = toWorkflowFileSlug(fileSlug)
  const filePath = getWorkflowFilePath(rootDir, normalizedSlug)
  if (!existsSync(filePath)) {
    return false
  }
  rmSync(filePath, { force: true })
  return true
}

const findWorkflowBySelector = (workflows, selector) => {
  const slug = asString(selector.slug)
  const query = asString(selector.query)

  if (slug) {
    const normalizedSlug = toWorkflowFileSlug(slug)
    const matched = workflows.find(workflow => workflow.fileSlug === normalizedSlug)
    if (!matched) {
      throw new Error(`Workflow not found: ${normalizedSlug}`)
    }
    return matched
  }

  if (!query) {
    throw new Error('Provide --slug or --query.')
  }

  const normalizedQuery = query.toLowerCase()
  const matched = workflows.filter((workflow) => {
    const target = [
      workflow.fileSlug,
      workflow.frontmatter.name,
      workflow.frontmatter.description,
      workflow.instruction
    ].join('\n').toLowerCase()
    return target.includes(normalizedQuery)
  })

  if (matched.length === 0) {
    throw new Error(`No workflow matched query: ${query}`)
  }
  if (matched.length > 1) {
    throw new Error(`Multiple workflows matched query: ${query}`)
  }

  return matched[0]
}

const listDirectoryNames = (directoryPath) => {
  if (!directoryPath || !existsSync(directoryPath)) {
    return []
  }
  return readdirSync(directoryPath, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
}

const listAvailableSkills = (rootDir) => {
  const candidates = []
  const codexHome = asString(process.env.CODEX_HOME)
  if (codexHome) {
    candidates.push(join(codexHome, 'skills'))
  }
  candidates.push(join(homedir(), '.codex', 'skills'))
  candidates.push(join(rootDir, 'templates', 'skills'))

  const names = []
  for (const candidate of candidates) {
    names.push(...listDirectoryNames(candidate))
  }

  return [...new Set(names)].sort((left, right) => left.localeCompare(right))
}

const toWorkflowSummary = workflow => ({
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
  skills: [...workflow.frontmatter.skills],
  updatedAt: workflow.updatedAt
})

const buildManualDraft = ({ options, existing }) => {
  const explicitTriggerType = asString(options['trigger-type'])
  const explicitTriggerValue = asString(options['trigger-value'])
  const schedule = asString(options.schedule)
  const interval = asString(options.interval)
  const rrule = asString(options.rrule)

  /** @type {TriggerType} */
  let triggerType = null
  let triggerValue = null

  if (schedule) {
    triggerType = 'schedule'
    triggerValue = schedule
  } else if (interval) {
    triggerType = 'interval'
    triggerValue = interval
  } else if (rrule) {
    triggerType = 'rrule'
    triggerValue = rrule
  } else if ((explicitTriggerType === 'schedule' || explicitTriggerType === 'interval' || explicitTriggerType === 'rrule') && explicitTriggerValue) {
    triggerType = explicitTriggerType
    triggerValue = explicitTriggerValue
  } else if (existing) {
    if (existing.frontmatter.on.schedule) {
      triggerType = 'schedule'
      triggerValue = existing.frontmatter.on.schedule
    } else if (existing.frontmatter.on.interval) {
      triggerType = 'interval'
      triggerValue = existing.frontmatter.on.interval
    } else if (existing.frontmatter.on.rrule) {
      triggerType = 'rrule'
      triggerValue = existing.frontmatter.on.rrule
    }
  }

  if (options['clear-schedule'] === true || parseBoolean(options['clear-schedule'], false) === true) {
    if (triggerType === 'schedule') {
      triggerType = null
      triggerValue = null
    }
  }
  if (options['clear-interval'] === true || parseBoolean(options['clear-interval'], false) === true) {
    if (triggerType === 'interval') {
      triggerType = null
      triggerValue = null
    }
  }
  if (options['clear-rrule'] === true || parseBoolean(options['clear-rrule'], false) === true) {
    if (triggerType === 'rrule') {
      triggerType = null
      triggerValue = null
    }
  }

  const workflowDispatchOption = parseBoolean(options['workflow-dispatch'] ?? options.dispatch, null)
  const workflowDispatch = workflowDispatchOption != null
    ? workflowDispatchOption
    : existing
      ? existing.frontmatter.on['workflow-dispatch'] === true
      : true

  const explicitSkills = parseCsv(options.skills)
  const addSkills = parseCsv(options['add-skills'])
  const removeSkills = parseCsv(options['remove-skills'])

  const initialSkills = explicitSkills.length > 0
    ? explicitSkills
    : existing
      ? [...existing.frontmatter.skills]
      : []

  const skills = [...new Set([...initialSkills, ...addSkills])]
    .filter(skill => !removeSkills.includes(skill))

  return {
    name: asString(options.name) || (existing ? existing.frontmatter.name : ''),
    description: asString(options.description) || (existing ? existing.frontmatter.description : ''),
    instruction: asString(options.instruction) || (existing ? existing.instruction : ''),
    triggerType,
    triggerValue,
    workflowDispatch,
    skills
  }
}

let codexInstance = null

const getCodexEnv = () => {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value
    }
  }
  if (!env.CODEX_HOME) {
    env.CODEX_HOME = join(homedir(), '.codex')
  }
  return env
}

const getCodex = () => {
  if (codexInstance) {
    return codexInstance
  }

  codexInstance = new Codex({
    env: getCodexEnv(),
    config: {
      show_raw_agent_reasoning: false,
      approval_policy: 'never',
      sandbox_mode: 'danger-full-access'
    }
  })

  return codexInstance
}

const normalizeAIDraft = (draft, availableSkills) => {
  const triggerType = draft.triggerType === 'schedule' || draft.triggerType === 'interval' || draft.triggerType === 'rrule'
    ? draft.triggerType
    : null
  const triggerValue = asString(draft.triggerValue) || null

  return {
    name: normalizeWorkflowName(draft.name),
    description: deriveWorkflowDescription(draft.description),
    instruction: asString(draft.instruction),
    triggerType,
    triggerValue,
    workflowDispatch: draft.workflowDispatch === true,
    skills: asStringArray(draft.skills).filter(skill => availableSkills.includes(skill))
  }
}

const normalizeAIAction = (raw, availableSkills) => {
  const action = raw.action === 'list' || raw.action === 'create' || raw.action === 'update' || raw.action === 'delete'
    ? raw.action
    : 'list'

  const confidence = raw.confidence === 'high' || raw.confidence === 'medium' || raw.confidence === 'low'
    ? raw.confidence
    : 'low'

  const selectorRecord = asRecord(raw.selector) || {}
  const listOptionsRecord = asRecord(raw.listOptions) || {}
  const draftRecord = asRecord(raw.draft) || {}

  return {
    action,
    confidence,
    reason: asString(raw.reason),
    selector: {
      slug: asString(selectorRecord.slug) || null,
      query: asString(selectorRecord.query) || null
    },
    listOptions: {
      runningOnly: listOptionsRecord.runningOnly === true,
      activeOnly: listOptionsRecord.activeOnly === true,
      query: asString(listOptionsRecord.query) || null
    },
    draft: normalizeAIDraft(draftRecord, availableSkills)
  }
}

const inferActionFromText = async ({ text, workflows, availableSkills }) => {
  const requestText = asString(text)
  if (!requestText) {
    throw new Error('Text is required for inference.')
  }

  const workflowContext = workflows.map(workflow => ({
    fileSlug: workflow.fileSlug,
    name: workflow.frontmatter.name,
    description: workflow.frontmatter.description,
    on: workflow.frontmatter.on,
    skills: workflow.frontmatter.skills
  }))

  const prompt = [
    'You convert user requests into a workflow management action for Corazon.',
    'Return JSON that matches the schema exactly.',
    '- action must be one of: list, create, update, delete.',
    '- For update/delete, prefer selector.slug when a target workflow is identifiable.',
    '- For create/update draft fields, follow workflow syntax:',
    '  name: 2-3 English words (letters and spaces only).',
    '  description: concise summary.',
    '  instruction: runnable instruction body.',
    '  triggerType: schedule | interval | rrule | null.',
    '  triggerValue: cron for schedule, duration for interval, RFC5545 RRULE for rrule.',
    '  workflowDispatch: boolean.',
    '  skills: subset of available skills.',
    '- Prefer rrule for weekly/monthly natural-language recurrence (for example "매주 금요일", "every friday").',
    '- If listing running workflows is requested, set listOptions.runningOnly=true.',
    '',
    `User request: ${requestText}`,
    '',
    'Available skills:',
    ...availableSkills.map(skill => `- ${skill}`),
    '',
    'Existing workflows:',
    JSON.stringify(workflowContext, null, 2)
  ].join('\n')

  const thread = getCodex().startThread({
    model: INFER_MODEL,
    workingDirectory: process.cwd()
  })

  const result = await thread.run(prompt, { outputSchema: AI_ACTION_SCHEMA })
  const response = asString(result.finalResponse)
  if (!response) {
    throw new Error('LLM did not return a structured action.')
  }

  let parsed
  try {
    parsed = JSON.parse(response)
  } catch {
    throw new Error('Failed to parse LLM action JSON.')
  }

  return normalizeAIAction(parsed, availableSkills)
}

const draftToFrontmatter = (draft) => {
  const on = {
    'workflow-dispatch': draft.workflowDispatch === true
  }

  if (draft.triggerType === 'schedule' && draft.triggerValue) {
    on.schedule = draft.triggerValue
  } else if (draft.triggerType === 'interval' && draft.triggerValue) {
    on.interval = draft.triggerValue
  } else if (draft.triggerType === 'rrule' && draft.triggerValue) {
    on.rrule = draft.triggerValue
  }

  return {
    name: normalizeWorkflowName(draft.name),
    description: deriveWorkflowDescription(draft.description),
    on,
    skills: [...new Set(asStringArray(draft.skills))]
  }
}

const ensureDraftInstruction = (draft, fallbackInstruction = '') => {
  const instruction = asString(draft.instruction) || asString(fallbackInstruction)
  if (!instruction) {
    throw new Error('Workflow instruction is required.')
  }
  return instruction
}

const handleList = (rootDir, options) => {
  const workflows = loadWorkflowDefinitions(rootDir)
  const query = asString(options.query)
  const validOnly = options['valid-only'] === true || parseBoolean(options['valid-only'], false) === true
  const activeOnly = options['active-only'] === true || parseBoolean(options['active-only'], false) === true
  const runningOnly = options['running-only'] === true || parseBoolean(options['running-only'], false) === true

  let filtered = workflows

  if (query) {
    const normalized = query.toLowerCase()
    filtered = filtered.filter((workflow) => {
      const target = [
        workflow.fileSlug,
        workflow.frontmatter.name,
        workflow.frontmatter.description,
        workflow.instruction
      ].join('\n').toLowerCase()
      return target.includes(normalized)
    })
  }

  if (validOnly) {
    filtered = filtered.filter(workflow => workflow.isValid)
  }

  if (activeOnly) {
    filtered = filtered.filter(
      workflow => workflow.isValid && (
        workflow.frontmatter.on.schedule
        || workflow.frontmatter.on.interval
        || workflow.frontmatter.on.rrule
        || workflow.frontmatter.on['workflow-dispatch']
      )
    )
  }

  if (runningOnly) {
    filtered = filtered.filter(
      workflow => workflow.isValid && (
        workflow.frontmatter.on.schedule
        || workflow.frontmatter.on.interval
        || workflow.frontmatter.on.rrule
      )
    )
  }

  return {
    ok: true,
    action: 'list',
    count: filtered.length,
    workflows: filtered.map(toWorkflowSummary)
  }
}

const handleCreate = (rootDir, options) => {
  const draft = buildManualDraft({ options })
  const instruction = ensureDraftInstruction(draft, options['request-text'])

  if (!draft.name) {
    draft.name = normalizeWorkflowName(instruction)
  }
  if (!draft.description) {
    draft.description = deriveWorkflowDescription(instruction)
  }

  const frontmatter = draftToFrontmatter(draft)
  const fileSlug = resolveUniqueWorkflowFileSlug(rootDir, asString(options['file-slug']) || frontmatter.name)
  const created = writeWorkflowDefinition(rootDir, fileSlug, frontmatter, instruction)

  return {
    ok: true,
    action: 'create',
    workflow: toWorkflowSummary(created)
  }
}

const handleUpdate = (rootDir, options) => {
  const workflows = loadWorkflowDefinitions(rootDir)
  const target = findWorkflowBySelector(workflows, {
    slug: options.slug,
    query: options.query
  })

  if (!target.isValid) {
    throw new Error(`Cannot update invalid workflow: ${target.fileSlug}`)
  }

  const draft = buildManualDraft({ options, existing: target })
  const frontmatter = draftToFrontmatter({
    ...draft,
    name: draft.name || target.frontmatter.name,
    description: draft.description || target.frontmatter.description,
    workflowDispatch: draft.workflowDispatch,
    skills: draft.skills.length > 0 ? draft.skills : target.frontmatter.skills
  })
  const instruction = ensureDraftInstruction(draft, target.instruction)

  const updated = writeWorkflowDefinition(rootDir, target.fileSlug, frontmatter, instruction)
  return {
    ok: true,
    action: 'update',
    workflow: toWorkflowSummary(updated)
  }
}

const handleDelete = (rootDir, options) => {
  const workflows = loadWorkflowDefinitions(rootDir)
  const target = findWorkflowBySelector(workflows, {
    slug: options.slug,
    query: options.query
  })

  const deleted = deleteWorkflowDefinitionBySlug(rootDir, target.fileSlug)
  if (!deleted) {
    throw new Error(`Workflow not found: ${target.fileSlug}`)
  }

  return {
    ok: true,
    action: 'delete',
    deleted: true,
    workflow: toWorkflowSummary(target)
  }
}

const handleFromText = async (rootDir, options) => {
  const text = asString(options.text || options['request-text'])
  if (!text) {
    throw new Error('from-text requires --text.')
  }

  const workflows = loadWorkflowDefinitions(rootDir)
  const availableSkills = listAvailableSkills(rootDir)
  const parsed = await inferActionFromText({ text, workflows, availableSkills })

  return {
    ok: true,
    action: 'from-text',
    parsed
  }
}

const handleCreateFromAIDraft = (rootDir, draft, fallbackInstruction = '') => {
  const frontmatter = draftToFrontmatter({
    ...draft,
    name: draft.name || normalizeWorkflowName(fallbackInstruction),
    description: draft.description || deriveWorkflowDescription(fallbackInstruction)
  })
  const instruction = ensureDraftInstruction(draft, fallbackInstruction)
  const fileSlug = resolveUniqueWorkflowFileSlug(rootDir, frontmatter.name)
  const created = writeWorkflowDefinition(rootDir, fileSlug, frontmatter, instruction)

  return {
    ok: true,
    action: 'create',
    workflow: toWorkflowSummary(created)
  }
}

const handleUpdateFromAIDraft = (rootDir, selector, draft, fallbackInstruction = '') => {
  const workflows = loadWorkflowDefinitions(rootDir)
  const target = findWorkflowBySelector(workflows, selector)
  if (!target.isValid) {
    throw new Error(`Cannot update invalid workflow: ${target.fileSlug}`)
  }

  const nextDraft = {
    ...draft,
    name: draft.name || target.frontmatter.name,
    description: draft.description || target.frontmatter.description,
    instruction: draft.instruction || fallbackInstruction || target.instruction,
    workflowDispatch: draft.workflowDispatch,
    skills: draft.skills.length > 0 ? draft.skills : target.frontmatter.skills
  }

  if (!nextDraft.triggerType) {
    if (target.frontmatter.on.schedule) {
      nextDraft.triggerType = 'schedule'
      nextDraft.triggerValue = target.frontmatter.on.schedule
    } else if (target.frontmatter.on.interval) {
      nextDraft.triggerType = 'interval'
      nextDraft.triggerValue = target.frontmatter.on.interval
    } else if (target.frontmatter.on.rrule) {
      nextDraft.triggerType = 'rrule'
      nextDraft.triggerValue = target.frontmatter.on.rrule
    } else {
      nextDraft.triggerValue = null
    }
  }

  const frontmatter = draftToFrontmatter(nextDraft)
  const instruction = ensureDraftInstruction(nextDraft, target.instruction)
  const updated = writeWorkflowDefinition(rootDir, target.fileSlug, frontmatter, instruction)

  return {
    ok: true,
    action: 'update',
    workflow: toWorkflowSummary(updated)
  }
}

const handleApplyText = async (rootDir, options) => {
  const text = asString(options.text || options['request-text'])
  if (!text) {
    throw new Error('apply-text requires --text.')
  }

  const workflows = loadWorkflowDefinitions(rootDir)
  const availableSkills = listAvailableSkills(rootDir)
  const parsed = await inferActionFromText({ text, workflows, availableSkills })

  if (parsed.action === 'list') {
    return {
      ...handleList(rootDir, {
        'query': parsed.listOptions.query,
        'active-only': parsed.listOptions.activeOnly,
        'running-only': parsed.listOptions.runningOnly
      }),
      parsed
    }
  }

  if (parsed.action === 'delete') {
    return {
      ...handleDelete(rootDir, parsed.selector),
      parsed
    }
  }

  if (parsed.action === 'update') {
    return {
      ...handleUpdateFromAIDraft(rootDir, parsed.selector, parsed.draft, text),
      parsed
    }
  }

  return {
    ...handleCreateFromAIDraft(rootDir, parsed.draft, text),
    parsed
  }
}

const printHelp = () => {
  const lines = [
    'manage-workflows.mjs',
    '',
    'Usage:',
    '  node scripts/manage-workflows.mjs list [--root <dir>] [--running-only] [--active-only] [--query <text>]',
    '  node scripts/manage-workflows.mjs create [--root <dir>] --instruction <text> [--name <name>] [--description <text>]',
    '      [--schedule "<cron>" | --interval "<duration>" | --rrule "<rrule>"] [--workflow-dispatch true|false] [--skills "a,b"]',
    '  node scripts/manage-workflows.mjs update [--root <dir>] (--slug <slug> | --query <text>) [options]',
    '      options: --name --description --instruction --schedule --interval --rrule',
    '      --clear-schedule --clear-interval --clear-rrule --workflow-dispatch true|false',
    '      --skills "a,b" --add-skills "a,b" --remove-skills "a,b"',
    '  node scripts/manage-workflows.mjs delete [--root <dir>] (--slug <slug> | --query <text>)',
    '  node scripts/manage-workflows.mjs from-text [--root <dir>] --text "<chat input>"',
    '  node scripts/manage-workflows.mjs apply-text [--root <dir>] --text "<chat input>"',
    '',
    'Output:',
    '  JSON only. Success: { "ok": true, ... }  Error: { "ok": false, "error": "..." }'
  ]
  console.log(lines.join('\n'))
}

const main = async () => {
  const { command, options } = splitCommandAndOptions(process.argv.slice(2))
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp()
    return
  }

  const rootDir = resolveRootDirectory(options)

  try {
    let result

    if (command === 'list') {
      result = handleList(rootDir, options)
    } else if (command === 'create') {
      result = handleCreate(rootDir, options)
    } else if (command === 'update') {
      result = handleUpdate(rootDir, options)
    } else if (command === 'delete') {
      result = handleDelete(rootDir, options)
    } else if (command === 'from-text') {
      result = await handleFromText(rootDir, options)
    } else if (command === 'apply-text') {
      result = await handleApplyText(rootDir, options)
    } else {
      throw new Error(`Unsupported command: ${command}`)
    }

    console.log(toJson(result))
  } catch (error) {
    fail(error instanceof Error ? error.message : 'Unexpected error')
  }
}

await main()
