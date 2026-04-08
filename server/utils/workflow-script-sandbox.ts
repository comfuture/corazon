import type {
  WorkflowDefinition,
  WorkflowLanguage,
  WorkflowTriggerType
} from '@@/types/workflow'

export type WorkflowScriptSandboxProviderId = 'local'
export type WorkflowScriptSandboxErrorCode = 'unsupported-language' | 'unsupported-provider'

export class WorkflowScriptSandboxError extends Error {
  readonly code: WorkflowScriptSandboxErrorCode
  readonly providerId: string

  constructor(code: WorkflowScriptSandboxErrorCode, providerId: string, message: string) {
    super(message)
    this.code = code
    this.providerId = providerId
  }
}

export type WorkflowScriptExecutionContext = {
  definition: WorkflowDefinition
  triggerType: WorkflowTriggerType
  triggerValue: string | null
}

export type WorkflowScriptExecutionResult = { status: 'completed' } | { status: 'failed', errorMessage: string }

export type WorkflowScriptSandboxProvider = {
  id: WorkflowScriptSandboxProviderId
  assertLanguageSupported: (language: Exclude<WorkflowLanguage, 'markdown'>) => void
  execute: (context: WorkflowScriptExecutionContext) => Promise<WorkflowScriptExecutionResult>
}

export const buildUnsupportedWorkflowLanguageMessage = (language: string) =>
  `Workflow language "${language}" is defined but not executable yet. `
  + 'Only "markdown" workflows can run until the sandboxed script runner lands.'

export const isUnsupportedWorkflowLanguageError = (error: unknown) =>
  (error instanceof WorkflowScriptSandboxError && error.code === 'unsupported-language')
  || (error instanceof Error
    && error.message.includes('is defined but not executable yet.')
    && error.message.includes('Only "markdown" workflows can run until the sandboxed script runner lands.'))

const localScriptSandboxProvider: WorkflowScriptSandboxProvider = {
  id: 'local',
  assertLanguageSupported(language) {
    throw new WorkflowScriptSandboxError(
      'unsupported-language',
      'local',
      buildUnsupportedWorkflowLanguageMessage(language)
    )
  },
  async execute(context) {
    return {
      status: 'failed',
      errorMessage: buildUnsupportedWorkflowLanguageMessage(context.definition.frontmatter.language)
    }
  }
}

const resolveConfiguredProviderId = () =>
  (process.env.CORAZON_WORKFLOW_SCRIPT_SANDBOX_PROVIDER ?? 'local').trim().toLowerCase()

export const resolveWorkflowScriptSandboxProvider = (): WorkflowScriptSandboxProvider => {
  const configured = resolveConfiguredProviderId()
  if (configured === 'local') {
    return localScriptSandboxProvider
  }

  throw new WorkflowScriptSandboxError(
    'unsupported-provider',
    configured,
    `Unsupported workflow script sandbox provider: "${configured}".`
  )
}

export const assertWorkflowLanguageIsRunnable = (definition: WorkflowDefinition) => {
  if (definition.frontmatter.language === 'markdown') {
    return
  }

  const provider = resolveWorkflowScriptSandboxProvider()
  provider.assertLanguageSupported(definition.frontmatter.language)
}

export const executeScriptWorkflowInSandbox = async (context: WorkflowScriptExecutionContext) => {
  const provider = resolveWorkflowScriptSandboxProvider()
  return provider.execute(context)
}
