import { randomUUID } from 'node:crypto'
import type { WorkflowDefinition, WorkflowRunSummary, WorkflowTriggerType } from '@@/types/workflow'
import { createCodexClient } from './codex-client/index.ts'
import type { CodexClient, CodexThreadEvent, CodexUsage } from './codex-client/types.ts'

const WORKFLOW_MODEL = 'gpt-5.3-codex'
type WorkflowExecutionContext = {
  definition: WorkflowDefinition
  triggerType: WorkflowTriggerType
  triggerValue: string | null
}

let codexInstance: CodexClient | null = null
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

  codexInstance = createCodexClient({
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
  const corazonRootDir = resolveCorazonRootDir()
  const corazonSkillsDir = resolveCorazonSkillsDir()
  const corazonScriptsDir = resolveCorazonScriptsDir()
  const corazonThreadsDir = resolveCorazonThreadsDir()

  return [
    `Workflow description: ${definition.frontmatter.description}`,
    `Allowed skills: ${allowedSkills}`,
    definition.instruction,
    '',
    'Use the execution context below while running this workflow.',
    'If reusable helper code, a custom executable, or long-lived operating guidance is required, create or update a supporting skill under the Corazon skills directory with `skill-creator` before relying on ad hoc files.',
    'If a standalone script is still necessary, place reusable scripts under the Corazon scripts directory.',
    'Use the Corazon thread-local path pattern only when the concrete thread directory is known.',
    `Never create scripts in the Corazon threads root itself or in shared directories such as ${corazonThreadsDir}/scripts.`,
    '<run-context>',
    `workflow_name: ${definition.frontmatter.name}`,
    `workflow_description: ${definition.frontmatter.description}`,
    `workflow_file: workflows/${definition.fileSlug}.md`,
    `allowed_skills: ${allowedSkills}`,
    `working_directory: ${process.cwd()}`,
    `corazon_root_directory: ${corazonRootDir}`,
    `corazon_skills_directory: ${corazonSkillsDir}`,
    `corazon_scripts_directory: ${corazonScriptsDir}`,
    `corazon_threads_directory: ${corazonThreadsDir}`,
    `thread_local_directory_pattern: ${corazonThreadsDir}/<threadId>`,
    `trigger_type: ${triggerType}`,
    `trigger_value: ${triggerValue ?? ''}`,
    `timezone: ${timezone}`,
    `current_date: ${toLocalDate(now)}`,
    `current_datetime_iso: ${now.toISOString()}`,
    '</run-context>'
  ].join('\n')
}

const shouldNotifyWorkflowSummary = (
  definition: WorkflowDefinition,
  summary: WorkflowRunSummary
) => {
  if (summary.status === 'failed') {
    return true
  }

  if (summary.triggerType === 'workflow-dispatch') {
    return true
  }

  return definition.fileSlug === 'corazon-self-evolution' && summary.status === 'completed'
}

const notifyWorkflowSummary = async (
  definition: WorkflowDefinition,
  summary: WorkflowRunSummary
) => {
  if (!shouldNotifyWorkflowSummary(definition, summary)) {
    return
  }

  if (summary.status === 'failed') {
    const result = await sendWorkflowRunOperatorNotification({
      definition,
      summary,
      severity: 'blocker',
      title: `${definition.frontmatter.name} failed`,
      message: summary.errorMessage || 'Workflow execution failed before completion.',
      nextAction: 'Review the workflow run history and session log, then resolve the blocker or rerun the workflow.'
    })
    if (!result.delivered) {
      throw new Error(result.skippedReason || 'Failed to deliver workflow failure operator notification.')
    }
    return
  }

  const completionKind = summary.triggerType === 'workflow-dispatch'
    ? 'Manual workflow dispatch completed.'
    : 'Scheduled autonomous workflow run completed.'

  const usageSummary = [
    `Status: ${summary.status}`,
    `Input tokens: ${summary.totalInputTokens}`,
    `Output tokens: ${summary.totalOutputTokens}`
  ].join('\n')

  const result = await sendWorkflowRunOperatorNotification({
    definition,
    summary,
    severity: 'info',
    title: `${definition.frontmatter.name} completed`,
    message: `${completionKind}\n${usageSummary}`,
    nextAction: summary.triggerType === 'workflow-dispatch'
      ? 'Inspect the workflow run details if you want the full execution transcript.'
      : null
  })
  if (!result.delivered) {
    throw new Error(result.skippedReason || 'Failed to deliver workflow completion operator notification.')
  }
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

  let usage: CodexUsage | null = null
  let threadId: string | null = null
  let sessionFilePath: string | null = null

  const { events } = await thread.runStreamed(prompt)
  for await (const event of events) {
    const typed = event as CodexThreadEvent
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

const finalizeWorkflowRunExecution = async (
  context: WorkflowExecutionContext,
  runId: string
) => {
  let failureMessage: string | null = null
  try {
    await collectRunCompletionData(context.definition, context.triggerType, context.triggerValue, runId)
  } catch (error) {
    failureMessage = error instanceof Error ? error.message : String(error)
    try {
      completeWorkflowRun({
        runId,
        status: 'failed',
        errorMessage: failureMessage
      })
    } catch (completeError) {
      console.error('Failed to finalize workflow run after execution error:', completeError)
    }
  }

  const finalRun = getWorkflowRunById(runId)
  if (finalRun?.status === 'running') {
    const fallbackMessage = failureMessage
      ?? 'Workflow run ended without final status update. Marked as failed by completion guard.'
    try {
      completeWorkflowRun({
        runId,
        status: 'failed',
        errorMessage: fallbackMessage
      })
    } catch (guardError) {
      console.error('Failed to apply workflow completion guard:', guardError)
    }
  }

  const summary = getWorkflowRunById(runId)
  if (!summary) {
    throw new Error('Failed to load workflow run summary.')
  }

  try {
    await notifyWorkflowSummary(context.definition, summary)
  } catch (error) {
    console.error('Failed to send operator notification for workflow run:', error)
  }

  return summary
}

const createRunningWorkflowRun = (
  definition: WorkflowDefinition,
  triggerType: WorkflowTriggerType,
  triggerValue: string | null
) => {
  const runId = `run_${randomUUID()}`
  createWorkflowRun({
    id: runId,
    workflowName: definition.frontmatter.name,
    workflowFileSlug: definition.fileSlug,
    triggerType,
    triggerValue
  })

  const summary = getWorkflowRunById(runId)
  if (!summary) {
    throw new Error('Failed to create workflow run.')
  }

  return summary
}

export const executeWorkflowRun = async (
  definition: WorkflowDefinition,
  triggerType: WorkflowTriggerType,
  triggerValue: string | null
): Promise<WorkflowRunSummary> => {
  if (!definition.isValid) {
    throw new Error(definition.parseError ?? 'Invalid workflow definition.')
  }

  const runningSummary = createRunningWorkflowRun(definition, triggerType, triggerValue)
  return finalizeWorkflowRunExecution({
    definition,
    triggerType,
    triggerValue
  }, runningSummary.id)
}

export const startWorkflowRun = (
  definition: WorkflowDefinition,
  triggerType: WorkflowTriggerType,
  triggerValue: string | null
): WorkflowRunSummary => {
  if (!definition.isValid) {
    throw new Error(definition.parseError ?? 'Invalid workflow definition.')
  }

  const runningSummary = createRunningWorkflowRun(definition, triggerType, triggerValue)
  void finalizeWorkflowRunExecution({
    definition,
    triggerType,
    triggerValue
  }, runningSummary.id)
    .catch((error) => {
      console.error('Unhandled workflow run execution failure:', error)
    })

  return runningSummary
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

export const startWorkflowBySlug = (
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

  return startWorkflowRun(definition, triggerType, triggerValue)
}

export const initializeWorkflowRunner = () => {
  if (workflowRunnerInitialized) {
    return
  }
  workflowRunnerInitialized = true
  const reconciledRuns = finalizeStaleRunningWorkflowRuns()
  if (reconciledRuns > 0) {
    console.warn(`Recovered ${reconciledRuns} stale workflow run(s) left in running state.`)
  }
  setWorkflowScheduledExecutor(async (definition, triggerType, triggerValue) => {
    await executeWorkflowRun(definition, triggerType, triggerValue)
  })
}
