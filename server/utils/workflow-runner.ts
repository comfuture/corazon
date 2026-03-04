import { randomUUID } from 'node:crypto'
import { Codex, type ThreadEvent, type Usage } from '@openai/codex-sdk'
import type { WorkflowDefinition, WorkflowRunSummary, WorkflowTriggerType } from '@@/types/workflow'

const WORKFLOW_MODEL = 'gpt-5.3-codex'

let codexInstance: Codex | null = null
let workflowRunnerInitialized = false

const getCodexEnv = () => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value
    }
  }
  env.CODEX_HOME = ensureAgentBootstrap()
  return env
}

const getCodex = () => {
  if (codexInstance) {
    return codexInstance
  }

  codexInstance = new Codex({
    env: getCodexEnv(),
    config: {
      show_raw_agent_reasoning: true,
      approval_policy: 'never',
      sandbox_mode: 'danger-full-access'
    }
  })

  return codexInstance
}

const toLocalDate = (value: Date) => {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const buildRunContextPrompt = (
  definition: WorkflowDefinition,
  triggerType: WorkflowTriggerType,
  triggerValue: string | null
) => {
  const now = new Date()
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const allowedSkills = definition.frontmatter.skills.join(', ')

  return [
    `워크플로 설명: ${definition.frontmatter.description}`,
    `사용 가능한 스킬: ${allowedSkills}`,
    definition.instruction,
    '',
    '실행 시 아래 실행 콘텍스트를 참조해야 합니다.',
    '<run-context>',
    `workflow_name: ${definition.frontmatter.name}`,
    `workflow_description: ${definition.frontmatter.description}`,
    `workflow_file: workflows/${definition.fileSlug}.md`,
    `allowed_skills: ${allowedSkills}`,
    `working_directory: ${process.cwd()}`,
    `trigger_type: ${triggerType}`,
    `trigger_value: ${triggerValue ?? ''}`,
    `timezone: ${timezone}`,
    `current_date: ${toLocalDate(now)}`,
    `current_datetime_iso: ${now.toISOString()}`,
    '</run-context>'
  ].join('\n')
}

const collectRunCompletionData = async (
  definition: WorkflowDefinition,
  triggerType: WorkflowTriggerType,
  triggerValue: string | null,
  runId: string
) => {
  const codex = getCodex()
  const prompt = buildRunContextPrompt(definition, triggerType, triggerValue)
  const thread = codex.startThread({
    model: WORKFLOW_MODEL,
    workingDirectory: process.cwd()
  })

  let usage: Usage | null = null
  let threadId: string | null = null
  let sessionFilePath: string | null = null

  const { events } = await thread.runStreamed(prompt)
  for await (const event of events) {
    const typed = event as ThreadEvent
    if (typed.type === 'thread.started') {
      threadId = typed.thread_id
      sessionFilePath = findSessionFileByThreadId(threadId)
      setWorkflowRunSessionReference(runId, threadId, sessionFilePath)
      continue
    }
    if (typed.type === 'turn.completed') {
      usage = typed.usage
      continue
    }
  }

  if (threadId && !sessionFilePath) {
    sessionFilePath = findSessionFileByThreadId(threadId)
  }
  if (threadId || sessionFilePath) {
    setWorkflowRunSessionReference(runId, threadId, sessionFilePath)
  }

  completeWorkflowRun({
    runId,
    status: 'completed',
    totalInputTokens: usage?.input_tokens ?? 0,
    totalCachedInputTokens: usage?.cached_input_tokens ?? 0,
    totalOutputTokens: usage?.output_tokens ?? 0,
    sessionThreadId: threadId,
    sessionFilePath
  })
}

export const executeWorkflowRun = async (
  definition: WorkflowDefinition,
  triggerType: WorkflowTriggerType,
  triggerValue: string | null
): Promise<WorkflowRunSummary> => {
  if (!definition.isValid) {
    throw new Error(definition.parseError ?? 'Invalid workflow definition.')
  }

  const runId = `run_${randomUUID()}`
  createWorkflowRun({
    id: runId,
    workflowName: definition.frontmatter.name,
    workflowFileSlug: definition.fileSlug,
    triggerType,
    triggerValue
  })

  try {
    await collectRunCompletionData(definition, triggerType, triggerValue, runId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    completeWorkflowRun({
      runId,
      status: 'failed',
      errorMessage: message
    })
  }

  const summary = getWorkflowRunById(runId)
  if (!summary) {
    throw new Error('Failed to load workflow run summary.')
  }

  return summary
}

export const executeWorkflowBySlug = async (
  fileSlug: string,
  triggerType: WorkflowTriggerType,
  triggerValue: string | null
) => {
  const definition = readWorkflowDefinitionBySlug(fileSlug)
  if (!definition) {
    throw new Error(`Workflow not found: ${fileSlug}`)
  }
  if (!definition.isValid) {
    throw new Error(definition.parseError ?? 'Invalid workflow definition.')
  }
  if (triggerType === 'workflow-dispatch' && definition.frontmatter.on['workflow-dispatch'] !== true) {
    throw new Error('This workflow does not allow workflow-dispatch execution.')
  }

  return executeWorkflowRun(definition, triggerType, triggerValue)
}

export const initializeWorkflowRunner = () => {
  if (workflowRunnerInitialized) {
    return
  }
  workflowRunnerInitialized = true
  setWorkflowScheduledExecutor(async (definition, triggerType, triggerValue) => {
    await executeWorkflowRun(definition, triggerType, triggerValue)
  })
}
