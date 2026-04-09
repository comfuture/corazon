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
    | 'policy-violation'
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
    metadata: WorkflowScriptExecutionMetadata
  }
  | {
    status: 'failed'
    errorCode: WorkflowScriptSandboxErrorCode
    errorMessage: string
    stdout: string
    stderr: string
    exitCode: number | null
    durationMs: number
    metadata: WorkflowScriptExecutionMetadata
  }

export type WorkflowScriptExecutionMetadata = {
  providerId: WorkflowScriptSandboxProviderId
  language: WorkflowLanguage
  triggerType: WorkflowTriggerType
  timeoutMs: number
  maxOutputBytes: number
  maxSourceBytes: number
  sourceBytes: number
  allowedEnvKeys: string[]
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
const WORKFLOW_SCRIPT_MAX_OUTPUT_BYTES_DEFAULT = 256_000
const WORKFLOW_SCRIPT_MAX_OUTPUT_BYTES_MIN = 1_024
const WORKFLOW_SCRIPT_MAX_SOURCE_BYTES_DEFAULT = 64_000
const WORKFLOW_SCRIPT_MAX_SOURCE_BYTES_MIN = 256

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

const resolveScriptMaxOutputBytes = () => {
  const raw = (process.env.CORAZON_WORKFLOW_SCRIPT_MAX_OUTPUT_BYTES ?? '').trim()
  if (raw === '') {
    return WORKFLOW_SCRIPT_MAX_OUTPUT_BYTES_DEFAULT
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < WORKFLOW_SCRIPT_MAX_OUTPUT_BYTES_MIN) {
    return WORKFLOW_SCRIPT_MAX_OUTPUT_BYTES_DEFAULT
  }
  return Math.floor(parsed)
}

const resolveScriptMaxSourceBytes = () => {
  const raw = (process.env.CORAZON_WORKFLOW_SCRIPT_MAX_SOURCE_BYTES ?? '').trim()
  if (raw === '') {
    return WORKFLOW_SCRIPT_MAX_SOURCE_BYTES_DEFAULT
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < WORKFLOW_SCRIPT_MAX_SOURCE_BYTES_MIN) {
    return WORKFLOW_SCRIPT_MAX_SOURCE_BYTES_DEFAULT
  }
  return Math.floor(parsed)
}

const resolveScriptEnvAllowlist = () => {
  const raw = (process.env.CORAZON_WORKFLOW_SCRIPT_ENV_ALLOWLIST ?? '').trim()
  if (raw === '') {
    return [] as string[]
  }
  return [...new Set(raw
    .split(',')
    .map(item => item.trim())
    .filter(Boolean))]
}

const buildScriptExecutionEnv = (allowlist: string[]) => {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? ''
  }

  for (const key of allowlist) {
    const value = process.env[key]
    if (typeof value === 'string') {
      env[key] = value
    }
  }
  return env
}

const isMissingTypeScriptRuntimeDependency = (error: unknown) => {
  if (!(error instanceof Error)) {
    return false
  }
  const message = error.message
  const moduleCode = typeof (error as { code?: unknown }).code === 'string'
    ? String((error as { code?: unknown }).code)
    : ''
  return message.includes('Cannot find package \'typescript\'')
    || message.includes('Cannot find module \'typescript\'')
    || (moduleCode === 'ERR_MODULE_NOT_FOUND' && /['"]typescript['"]/.test(message))
}

const formatProviderFailureMessage = (
  language: Exclude<WorkflowLanguage, 'markdown'>,
  error: unknown
) => {
  if (language === 'typescript' && isMissingTypeScriptRuntimeDependency(error)) {
    return 'Workflow script provider failed: missing runtime dependency "typescript". '
      + 'Install the "typescript" package in the runtime environment to execute TypeScript workflows.'
  }
  if (error instanceof Error) {
    return `Workflow script provider failed: ${error.message}`
  }
  return 'Workflow script provider failed with an unknown error.'
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
    maxOutputBytes: number
    envAllowlist: string[]
  }
) => {
  type ProcessExecutionResult
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

  const startedAt = Date.now()
  let stdout = ''
  let stderr = ''
  let stdoutBytes = 0
  let stderrBytes = 0

  return await new Promise<ProcessExecutionResult>((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildScriptExecutionEnv(options.envAllowlist)
    })

    const totalOutputBytes = () => stdoutBytes + stderrBytes
    let outputLimitExceeded = false
    let outputLimitStream: 'stdout' | 'stderr' | null = null

    const enforceOutputLimit = (stream: 'stdout' | 'stderr') => {
      if (outputLimitExceeded) {
        return
      }
      if (totalOutputBytes() <= options.maxOutputBytes) {
        return
      }
      outputLimitExceeded = true
      outputLimitStream = stream
      child.kill('SIGKILL')
    }

    child.stdout.on('data', (chunk) => {
      const text = String(chunk)
      stdout += text
      stdoutBytes += Buffer.byteLength(text)
      enforceOutputLimit('stdout')
    })
    child.stderr.on('data', (chunk) => {
      const text = String(chunk)
      stderr += text
      stderrBytes += Buffer.byteLength(text)
      enforceOutputLimit('stderr')
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
      if (outputLimitExceeded) {
        resolve({
          status: 'failed',
          errorCode: 'policy-violation',
          errorMessage:
            `Workflow script output exceeded ${options.maxOutputBytes} bytes`
            + (outputLimitStream ? ` on ${outputLimitStream}.` : '.'),
          stdout,
          stderr,
          exitCode: null,
          durationMs: Date.now() - startedAt
        })
        return
      }

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
    const sourceBytes = Buffer.byteLength(context.definition.instruction, 'utf8')
    if (context.definition.frontmatter.language === 'markdown') {
      const metadata: WorkflowScriptExecutionMetadata = {
        providerId: 'local',
        language: 'markdown',
        triggerType: context.triggerType,
        timeoutMs: resolveScriptTimeoutMs(),
        maxOutputBytes: resolveScriptMaxOutputBytes(),
        maxSourceBytes: resolveScriptMaxSourceBytes(),
        sourceBytes,
        allowedEnvKeys: resolveScriptEnvAllowlist()
      }
      return {
        status: 'failed',
        errorCode: 'unsupported-language',
        errorMessage: 'Markdown workflows must use the standard LLM execution path.',
        stdout: '',
        stderr: '',
        exitCode: null,
        durationMs: 0,
        metadata
      }
    }

    const language = context.definition.frontmatter.language
    const timeoutMs = resolveScriptTimeoutMs()
    const maxOutputBytes = resolveScriptMaxOutputBytes()
    const maxSourceBytes = resolveScriptMaxSourceBytes()
    const envAllowlist = resolveScriptEnvAllowlist()
    const metadata: WorkflowScriptExecutionMetadata = {
      providerId: 'local',
      language,
      triggerType: context.triggerType,
      timeoutMs,
      maxOutputBytes,
      maxSourceBytes,
      sourceBytes,
      allowedEnvKeys: [...envAllowlist]
    }
    if (sourceBytes > maxSourceBytes) {
      return {
        status: 'failed',
        errorCode: 'policy-violation',
        errorMessage:
          `Workflow script source exceeded ${maxSourceBytes} bytes `
          + `(${sourceBytes} bytes received).`,
        stdout: '',
        stderr: '',
        exitCode: null,
        durationMs: 0,
        metadata
      }
    }
    const tempDirectory = await mkdtemp(join(tmpdir(), 'corazon-workflow-script-'))
    try {
      console.info(
        `[workflow-script-sandbox] provider=${metadata.providerId} phase=prepare`
        + ` language=${metadata.language} trigger=${metadata.triggerType}`
        + ` timeoutMs=${metadata.timeoutMs} maxOutputBytes=${metadata.maxOutputBytes}`
        + ` sourceBytes=${metadata.sourceBytes}/${metadata.maxSourceBytes}`
        + ` allowEnv=${metadata.allowedEnvKeys.join(',') || '(none)'}`
      )
      await writeRunnableScript(tempDirectory, language, context.definition.instruction)
      const runtime = resolveScriptBinaryByLanguage(language)
      const executionResult = await executeScriptProcess(runtime.command, runtime.args, {
        cwd: tempDirectory,
        timeoutMs,
        maxOutputBytes,
        envAllowlist
      })
      console.info(
        `[workflow-script-sandbox] provider=${metadata.providerId} phase=teardown`
        + ` status=${executionResult.status} durationMs=${executionResult.durationMs}`
      )
      return {
        ...executionResult,
        metadata
      }
    } catch (error) {
      return {
        status: 'failed',
        errorCode: 'provider-error',
        errorMessage: formatProviderFailureMessage(language, error),
        stdout: '',
        stderr: '',
        exitCode: null,
        durationMs: 0,
        metadata
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

const resolveConfiguredProviderId = () => {
  const configured = (process.env.CORAZON_WORKFLOW_SCRIPT_SANDBOX_PROVIDER ?? '').trim().toLowerCase()
  return configured === '' ? 'local' : configured
}

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
