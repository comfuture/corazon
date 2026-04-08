import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type {
  WorkflowDefinition,
  WorkflowLanguage,
  WorkflowTriggerType
} from '@@/types/workflow'

export type WorkflowScriptSandboxProviderId = 'local'
export type WorkflowScriptSandboxErrorCode
  = | 'unsupported-language'
    | 'unsupported-provider'
    | 'execution-timeout'
    | 'execution-failed'
    | 'provider-error'

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

export type WorkflowScriptExecutionResult
  = | {
    status: 'completed'
    stdout: string
    stderr: string
    exitCode: number
    durationMs: number
  }
  | {
    status: 'failed'
    errorCode: WorkflowScriptSandboxErrorCode
    errorMessage: string
    stdout: string
    stderr: string
    exitCode: number | null
    durationMs: number
  }

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

const WORKFLOW_SCRIPT_TIMEOUT_MS_DEFAULT = 60_000

const resolveScriptTimeoutMs = () => {
  const raw = (process.env.CORAZON_WORKFLOW_SCRIPT_TIMEOUT_MS ?? '').trim()
  if (raw === '') {
    return WORKFLOW_SCRIPT_TIMEOUT_MS_DEFAULT
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return WORKFLOW_SCRIPT_TIMEOUT_MS_DEFAULT
  }
  return Math.floor(parsed)
}

const resolveScriptBinaryByLanguage = (language: Exclude<WorkflowLanguage, 'markdown'>) => {
  if (language === 'python') {
    return { command: process.env.CORAZON_WORKFLOW_PYTHON_BIN?.trim() || 'python3', args: ['script.py'] }
  }
  return { command: 'node', args: ['script.mjs'] }
}

const transpileTypeScriptToModule = async (source: string) => {
  const typescriptModule = await import('typescript')
  return typescriptModule.transpileModule(source, {
    compilerOptions: {
      target: typescriptModule.ScriptTarget.ES2022,
      module: typescriptModule.ModuleKind.ES2022,
      moduleResolution: typescriptModule.ModuleResolutionKind.Bundler
    }
  }).outputText
}

const writeRunnableScript = async (
  directory: string,
  language: Exclude<WorkflowLanguage, 'markdown'>,
  source: string
) => {
  if (language === 'python') {
    const scriptPath = join(directory, 'script.py')
    await writeFile(scriptPath, `${source.trim()}\n`, 'utf8')
    return
  }
  const transpiled = await transpileTypeScriptToModule(source)
  const scriptPath = join(directory, 'script.mjs')
  await writeFile(scriptPath, transpiled, 'utf8')
}

const executeScriptProcess = async (
  command: string,
  args: string[],
  options: {
    cwd: string
    timeoutMs: number
  }
) => {
  const startedAt = Date.now()
  let stdout = ''
  let stderr = ''

  return await new Promise<WorkflowScriptExecutionResult>((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? ''
      }
    })

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })

    let timedOut = false
    const timeoutHandle = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)

    child.on('error', (error) => {
      clearTimeout(timeoutHandle)
      resolve({
        status: 'failed',
        errorCode: 'provider-error',
        errorMessage: `Failed to start script runtime: ${error.message}`,
        stdout,
        stderr,
        exitCode: null,
        durationMs: Date.now() - startedAt
      })
    })

    child.on('close', (exitCode) => {
      clearTimeout(timeoutHandle)
      if (timedOut) {
        resolve({
          status: 'failed',
          errorCode: 'execution-timeout',
          errorMessage: `Workflow script execution timed out after ${options.timeoutMs}ms.`,
          stdout,
          stderr,
          exitCode: null,
          durationMs: Date.now() - startedAt
        })
        return
      }

      if (exitCode !== 0) {
        resolve({
          status: 'failed',
          errorCode: 'execution-failed',
          errorMessage: `Workflow script process exited with code ${exitCode}.`,
          stdout,
          stderr,
          exitCode: exitCode ?? null,
          durationMs: Date.now() - startedAt
        })
        return
      }

      resolve({
        status: 'completed',
        stdout,
        stderr,
        exitCode: 0,
        durationMs: Date.now() - startedAt
      })
    })
  })
}

const localScriptSandboxProvider: WorkflowScriptSandboxProvider = {
  id: 'local',
  assertLanguageSupported(_language) {
    return
  },
  async execute(context) {
    if (context.definition.frontmatter.language === 'markdown') {
      return {
        status: 'failed',
        errorCode: 'unsupported-language',
        errorMessage: 'Markdown workflows must use the standard LLM execution path.',
        stdout: '',
        stderr: '',
        exitCode: null,
        durationMs: 0
      }
    }

    const language = context.definition.frontmatter.language
    const timeoutMs = resolveScriptTimeoutMs()
    const tempDirectory = await mkdtemp(join(tmpdir(), 'corazon-workflow-script-'))
    try {
      await writeRunnableScript(tempDirectory, language, context.definition.instruction)
      const runtime = resolveScriptBinaryByLanguage(language)
      const executionResult = await executeScriptProcess(runtime.command, runtime.args, {
        cwd: tempDirectory,
        timeoutMs
      })
      return executionResult
    } catch (error) {
      return {
        status: 'failed',
        errorCode: 'provider-error',
        errorMessage: error instanceof Error
          ? `Workflow script provider failed: ${error.message}`
          : 'Workflow script provider failed with an unknown error.',
        stdout: '',
        stderr: '',
        exitCode: null,
        durationMs: 0
      }
    } finally {
      try {
        await rm(tempDirectory, { recursive: true, force: true })
      } catch {
        // no-op cleanup guard
      }
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
