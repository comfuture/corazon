import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import type { WorkflowDefinition, WorkflowRunSummary, WorkflowTriggerType } from '@@/types/workflow'
import { createCodexClient } from './codex-client/index.ts'
import type { CodexClient, CodexThreadEvent, CodexUsage } from './codex-client/types.ts'

const WORKFLOW_MODEL = 'gpt-5.3-codex'
const WORKFLOW_FALLBACK_MODELS = ['gpt-5.3-codex-spark']
const WORKFLOW_OVERLOAD_RETRY_ATTEMPTS_PER_MODEL = 2
const WORKFLOW_OVERLOAD_RETRY_BASE_DELAY_MS = 3000
const WORKFLOW_OVERLOAD_RETRY_MAX_DELAY_MS = 15000
type WorkflowExecutionContext = {
  definition: WorkflowDefinition
  triggerType: WorkflowTriggerType
  triggerValue: string | null
}
type WorkflowAttemptError = Error & {
  transientOverload?: boolean
  safeToRetry?: boolean
}

let codexInstance: CodexClient | null = null
let workflowRunnerInitialized = false
const WORKFLOW_FINALIZATION_RETRY_LIMIT = 2

const overloadErrorPattern = /(?:server[_\s-]?is[_\s-]?overloaded|at\s+capacity|temporar(?:y|ily)\s+unavailable)/i

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

const isTransientOverloadError = (message: string) =>
  overloadErrorPattern.test(message)

const toWorkflowAttemptError = (
  error: unknown,
  safeToRetry: boolean
): WorkflowAttemptError => {
  const message = error instanceof Error ? error.message : String(error)
  const typed = new Error(message) as WorkflowAttemptError
  typed.transientOverload = isTransientOverloadError(message)
  typed.safeToRetry = safeToRetry
  return typed
}

const getWorkflowModelSequence = () => {
  const configuredFallbacks = (process.env.CORAZON_WORKFLOW_FALLBACK_MODELS ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)

  const candidates = [
    WORKFLOW_MODEL,
    ...(configuredFallbacks.length > 0 ? configuredFallbacks : WORKFLOW_FALLBACK_MODELS)
  ]
  return [...new Set(candidates)]
}

const getRetryDelayMs = (attemptIndex: number) => {
  const computed = WORKFLOW_OVERLOAD_RETRY_BASE_DELAY_MS * (2 ** attemptIndex)
  return Math.min(computed, WORKFLOW_OVERLOAD_RETRY_MAX_DELAY_MS)
}

const getCodexEnv = () => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value
    }
  }
  env.CODEX_HOME = ensureAgentBootstrap()
  const runtimePaths = ensureCorazonRuntimeEnvironment()
  env.CORAZON_RUNTIME_ROOT_DIR = runtimePaths.runtimeRootDir
  env.CORAZON_THREADS_DIR = runtimePaths.threadsDir
  env.WORKFLOW_LOCAL_DATA_DIR = runtimePaths.workflowLocalDataDir
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

const shouldApplySelfEvolutionNoOpCommentPolicy = (definition: WorkflowDefinition) =>
  definition.fileSlug === 'corazon-self-evolution'
  || definition.frontmatter.name.trim().toLowerCase() === 'corazon self evolution'

type SelfEvolutionRepoHygieneSnapshot = {
  repoPath: string
  probeTimestampIso: string
  available: boolean
  currentBranch: string | null
  detachedHead: boolean
  worktreeDirty: boolean
  goneTrackingBranches: string[]
  mergedBranchCleanupCandidates: string[]
  autoRecoverableActions: string[]
  manualInterventionReasons: string[]
  probeError: string | null
}

const SELF_EVOLUTION_REPO_DEFAULT_RELATIVE_PATH = 'repos/corazon'

const runGitCommand = (
  repoPath: string,
  args: string[]
) => {
  try {
    const output = execFileSync('git', ['-C', repoPath, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return {
      ok: true,
      output
    } as const
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      output: '',
      error: message
    } as const
  }
}

const resolveSelfEvolutionRepoPath = () => {
  const configured = process.env.CORAZON_SELF_EVOLUTION_REPO_DIR?.trim()
  if (configured) {
    return configured
  }
  return `${resolveCorazonRootDir()}/${SELF_EVOLUTION_REPO_DEFAULT_RELATIVE_PATH}`
}

const collectSelfEvolutionRepoHygieneSnapshot = (): SelfEvolutionRepoHygieneSnapshot => {
  const snapshot: SelfEvolutionRepoHygieneSnapshot = {
    repoPath: resolveSelfEvolutionRepoPath(),
    probeTimestampIso: new Date().toISOString(),
    available: false,
    currentBranch: null,
    detachedHead: false,
    worktreeDirty: false,
    goneTrackingBranches: [],
    mergedBranchCleanupCandidates: [],
    autoRecoverableActions: [],
    manualInterventionReasons: [],
    probeError: null
  }

  const insideWorktree = runGitCommand(snapshot.repoPath, ['rev-parse', '--is-inside-work-tree'])
  if (!insideWorktree.ok || insideWorktree.output.trim() !== 'true') {
    snapshot.probeError = insideWorktree.ok
      ? 'Repository path is not a git worktree.'
      : insideWorktree.error
    snapshot.manualInterventionReasons.push('Repository path is unavailable or not a valid git worktree.')
    return snapshot
  }
  snapshot.available = true

  const statusResult = runGitCommand(snapshot.repoPath, ['status', '--porcelain=2', '--branch'])
  if (!statusResult.ok) {
    snapshot.probeError = statusResult.error
    snapshot.manualInterventionReasons.push('Failed to inspect worktree status.')
    return snapshot
  }

  const statusLines = statusResult.output.split('\n').map(line => line.trimEnd())
  for (const line of statusLines) {
    if (!line) {
      continue
    }
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim()
      if (head === '(detached)') {
        snapshot.detachedHead = true
      } else if (head && head !== '(unknown)') {
        snapshot.currentBranch = head
      }
      continue
    }
    if (!line.startsWith('#')) {
      snapshot.worktreeDirty = true
    }
  }

  if (snapshot.detachedHead) {
    snapshot.manualInterventionReasons.push('HEAD is detached.')
  }
  if (snapshot.worktreeDirty) {
    snapshot.manualInterventionReasons.push('Worktree has uncommitted or untracked changes.')
  }

  const trackingResult = runGitCommand(snapshot.repoPath, [
    'for-each-ref',
    '--format=%(refname:short)%09%(upstream:track)',
    'refs/heads'
  ])
  if (trackingResult.ok) {
    snapshot.goneTrackingBranches = trackingResult.output
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const [branch, tracking] = line.split('\t')
        if (!branch || !tracking?.includes('[gone]')) {
          return []
        }
        return [branch]
      })
      .sort((a, b) => a.localeCompare(b))
  } else {
    snapshot.manualInterventionReasons.push('Failed to inspect local tracking branches.')
    snapshot.probeError = snapshot.probeError ?? trackingResult.error
  }

  const mergedBranchesResult = runGitCommand(snapshot.repoPath, [
    'branch',
    '--format=%(refname:short)',
    '--merged',
    'origin/main'
  ])
  if (mergedBranchesResult.ok) {
    const protectedBranches = new Set(['main', 'master', snapshot.currentBranch].filter(Boolean) as string[])
    snapshot.mergedBranchCleanupCandidates = mergedBranchesResult.output
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .filter(branch => !protectedBranches.has(branch))
      .sort((a, b) => a.localeCompare(b))
  } else {
    snapshot.manualInterventionReasons.push('Failed to inspect merged local branches against origin/main.')
    snapshot.probeError = snapshot.probeError ?? mergedBranchesResult.error
  }

  if (snapshot.goneTrackingBranches.length > 0) {
    const currentBranch = snapshot.currentBranch
    const includesCurrentBranch = currentBranch
      ? snapshot.goneTrackingBranches.includes(currentBranch)
      : false
    if (includesCurrentBranch) {
      snapshot.manualInterventionReasons.push(`Current branch ${currentBranch} tracks a missing upstream.`)
    }
    const nonCurrentBranches = snapshot.goneTrackingBranches.filter(branch => branch !== currentBranch)
    if (nonCurrentBranches.length > 0) {
      snapshot.autoRecoverableActions.push(
        `Prune ${nonCurrentBranches.length} local branch(es) tracking [gone] upstream refs after merge-state verification.`
      )
    }
  }

  if (snapshot.mergedBranchCleanupCandidates.length > 0) {
    snapshot.autoRecoverableActions.push(
      `Delete ${snapshot.mergedBranchCleanupCandidates.length} merged local branch(es) that are no longer needed.`
    )
  }

  return snapshot
}

const renderSelfEvolutionRepoHygieneSnapshot = (snapshot: SelfEvolutionRepoHygieneSnapshot) => {
  const autoRecoverable = snapshot.autoRecoverableActions.length > 0
    ? snapshot.autoRecoverableActions.join(' | ')
    : 'none'
  const manual = snapshot.manualInterventionReasons.length > 0
    ? snapshot.manualInterventionReasons.join(' | ')
    : 'none'
  const goneBranches = snapshot.goneTrackingBranches.length > 0
    ? snapshot.goneTrackingBranches.join(', ')
    : 'none'
  const mergedBranches = snapshot.mergedBranchCleanupCandidates.length > 0
    ? snapshot.mergedBranchCleanupCandidates.join(', ')
    : 'none'
  const currentBranch = snapshot.currentBranch ?? '(unknown)'
  const probeError = snapshot.probeError ?? 'none'

  return [
    'Self-evolution repo hygiene preflight:',
    `- repo_path: ${snapshot.repoPath}`,
    `- checked_at: ${snapshot.probeTimestampIso}`,
    `- available: ${snapshot.available ? 'yes' : 'no'}`,
    `- current_branch: ${currentBranch}`,
    `- detached_head: ${snapshot.detachedHead ? 'yes' : 'no'}`,
    `- worktree_dirty: ${snapshot.worktreeDirty ? 'yes' : 'no'}`,
    `- gone_tracking_branches: ${goneBranches}`,
    `- merged_branch_cleanup_candidates: ${mergedBranches}`,
    `- auto_recoverable_actions: ${autoRecoverable}`,
    `- manual_intervention_reasons: ${manual}`,
    `- probe_error: ${probeError}`
  ]
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
  const includeSelfEvolutionNoOpCommentPolicy = shouldApplySelfEvolutionNoOpCommentPolicy(definition)
  const selfEvolutionRepoHygieneSnapshot = includeSelfEvolutionNoOpCommentPolicy
    ? collectSelfEvolutionRepoHygieneSnapshot()
    : null

  return [
    `Workflow description: ${definition.frontmatter.description}`,
    `Allowed skills: ${allowedSkills}`,
    definition.instruction,
    '',
    'Use the execution context below while running this workflow.',
    'Use `notifyOperator` only for high-signal events that need prompt operator attention.',
    'Do not send routine successful completion notifications just because the workflow finished.',
    'When collecting GitHub PR feedback, do not rely on `gh pr view --comments`; use `scripts/gh-pr-feedback.sh <pr_number> --repo <owner/repo>` or `gh api repos/<owner>/<repo>/issues/<pr_number>/comments`, `gh api repos/<owner>/<repo>/pulls/<pr_number>/comments`, and `gh api repos/<owner>/<repo>/pulls/<pr_number>/reviews`.',
    'When collecting GitHub issue feedback, do not rely on `gh issue view --comments`; use `scripts/gh-issue-feedback.sh <issue_number> --repo <owner/repo>` or `gh api repos/<owner>/<repo>/issues/<issue_number>` and `gh api repos/<owner>/<repo>/issues/<issue_number>/comments`.',
    'When posting PR/issue progress updates with `gh`, preserve markdown code identifiers by piping comment text into `scripts/gh-comment-safe.sh` (or `gh ... --body-file`) instead of inline `--body "..."` shell strings.',
    ...(includeSelfEvolutionNoOpCommentPolicy
      ? [
          'For self-evolution PR maintenance, do not post routine no-op PR timeline comments.',
          'Post a PR comment only when at least one condition is true: code was pushed, review feedback was explicitly answered/resolved, PR check/review state changed since the previous run, or a new follow-up issue was created and linked.',
          'Include `Repo hygiene` in the final run report and distinguish `auto-recoverable` vs `manual intervention` outcomes.'
        ]
      : []),
    ...(selfEvolutionRepoHygieneSnapshot
      ? renderSelfEvolutionRepoHygieneSnapshot(selfEvolutionRepoHygieneSnapshot)
      : []),
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
    `corazon_runtime_root_directory: ${resolveCorazonRuntimeRootDir()}`,
    `thread_local_directory_pattern: ${corazonThreadsDir}/<threadId>`,
    `trigger_type: ${triggerType}`,
    `trigger_value: ${triggerValue ?? ''}`,
    `timezone: ${timezone}`,
    `current_date: ${toLocalDate(now)}`,
    `current_datetime_iso: ${now.toISOString()}`,
    '</run-context>'
  ].join('\n')
}

const shouldNotifyWorkflowSummary = (summary: WorkflowRunSummary) =>
  summary.status === 'failed'

const notifyWorkflowSummary = async (
  definition: WorkflowDefinition,
  summary: WorkflowRunSummary
) => {
  if (!shouldNotifyWorkflowSummary(summary)) {
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

  return
}

const collectRunCompletionData = async (
  definition: WorkflowDefinition,
  triggerType: WorkflowTriggerType,
  triggerValue: string | null,
  runId: string
) => {
  const codex = getCodex()
  const prompt = buildRunContextPrompt(definition, triggerType, triggerValue)
  const modelSequence = getWorkflowModelSequence()
  let lastError: Error | null = null

  for (let modelIndex = 0; modelIndex < modelSequence.length; modelIndex += 1) {
    const model = modelSequence[modelIndex] as string
    for (let attempt = 0; attempt < WORKFLOW_OVERLOAD_RETRY_ATTEMPTS_PER_MODEL; attempt += 1) {
      const thread = codex.startThread({
        model,
        workingDirectory: process.cwd()
      })
      let usage: CodexUsage | null = null
      let threadId: string | null = null
      let sessionFilePath: string | null = null
      let sawItemActivity = false

      try {
        const { events } = await thread.runStreamed(prompt)
        for await (const event of events) {
          const typed = event as CodexThreadEvent
          if (typed.type === 'thread.started') {
            threadId = typed.thread_id
            sessionFilePath = findSessionFileByThreadId(threadId)
            setWorkflowRunSessionReference(runId, threadId, sessionFilePath)
            continue
          }
          if (typed.type === 'item.started' || typed.type === 'item.updated' || typed.type === 'item.completed') {
            sawItemActivity = true
            continue
          }
          if (typed.type === 'turn.failed') {
            throw toWorkflowAttemptError(typed.error.message, !sawItemActivity)
          }
          if (typed.type === 'turn.completed') {
            usage = typed.usage
            continue
          }
        }
      } catch (error) {
        const typedError = toWorkflowAttemptError(error, !sawItemActivity)
        lastError = typedError
        const canRetry = typedError.transientOverload === true && typedError.safeToRetry === true
        const hasMoreAttemptsOnModel = attempt < WORKFLOW_OVERLOAD_RETRY_ATTEMPTS_PER_MODEL - 1
        const hasFallbackModel = modelIndex < modelSequence.length - 1

        if (canRetry && hasMoreAttemptsOnModel) {
          const delayMs = getRetryDelayMs(attempt)
          console.warn(`[workflow-runner] transient overload on model ${model}; retrying in ${delayMs}ms (attempt ${attempt + 1}/${WORKFLOW_OVERLOAD_RETRY_ATTEMPTS_PER_MODEL}).`)
          await sleep(delayMs)
          continue
        }

        if (canRetry && hasFallbackModel) {
          const fallbackModel = modelSequence[modelIndex + 1]
          console.warn(`[workflow-runner] transient overload on model ${model}; falling back to ${fallbackModel}.`)
          break
        }

        throw typedError
      }

      if (!usage) {
        const completionError = new Error(`Workflow turn with model ${model} ended without completion.`)
        lastError = completionError
        throw completionError
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
        totalInputTokens: usage.input_tokens ?? 0,
        totalCachedInputTokens: usage.cached_input_tokens ?? 0,
        totalOutputTokens: usage.output_tokens ?? 0,
        sessionThreadId: threadId,
        sessionFilePath
      })
      return
    }
  }
  throw (lastError ?? new Error('Workflow run exhausted all configured model attempts.'))
}

const completeWorkflowRunWithRetry = (input: Parameters<typeof completeWorkflowRun>[0]) => {
  let lastError: unknown = null
  for (let attempt = 1; attempt <= WORKFLOW_FINALIZATION_RETRY_LIMIT; attempt += 1) {
    try {
      completeWorkflowRun(input)
      return
    } catch (error) {
      lastError = error
      if (attempt >= WORKFLOW_FINALIZATION_RETRY_LIMIT) {
        break
      }
      console.error(`Workflow run finalization attempt ${attempt} failed, retrying...`, error)
    }
  }

  throw (lastError instanceof Error ? lastError : new Error(String(lastError)))
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
    completeWorkflowRunWithRetry({
      runId,
      status: 'failed',
      errorMessage: failureMessage
    })
  }

  const finalRun = getWorkflowRunById(runId)
  if (finalRun?.status === 'running') {
    const fallbackMessage = failureMessage
      ?? 'Workflow run ended without final status update. Marked as failed by completion guard.'
    completeWorkflowRunWithRetry({
      runId,
      status: 'failed',
      errorMessage: fallbackMessage
    })
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
  try {
    const reconciledRuns = finalizeStaleRunningWorkflowRuns()
    if (reconciledRuns > 0) {
      console.warn(`Recovered ${reconciledRuns} stale workflow run(s) left in running state.`)
    }
    setWorkflowScheduledExecutor(async (definition, triggerType, triggerValue) => {
      await executeWorkflowRun(definition, triggerType, triggerValue)
    })
    workflowRunnerInitialized = true
  } catch (error) {
    workflowRunnerInitialized = false
    throw error
  }
}
