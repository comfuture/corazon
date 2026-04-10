import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
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
  executionDurationMs: number
  prepareDurationMs: number
  executeDurationMs: number
  teardownDurationMs: number
  timeoutMs: number
  maxOutputBytes: number
  maxSourceBytes: number
  maxTmpBytes: number
  sourceBytes: number
  tmpBytes: number
  allowedEnvKeys: string[]
  runtimeCommand: string | null
  runtimeArgs: string[]
  stdoutBytes: number
  stderrBytes: number
  totalOutputBytes: number
  outputTruncated: boolean
  terminationSignal: NodeJS.Signals | null
  terminationScope: 'none' | 'process' | 'process-group'
  policyTriggered: 'none' | 'source-size' | 'output-size' | 'tmp-size'
  failurePhase: 'none' | 'prepare' | 'execute'
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
const WORKFLOW_SCRIPT_MAX_TMP_BYTES_DEFAULT = 8 * 1024 * 1024
const WORKFLOW_SCRIPT_MAX_TMP_BYTES_MIN = 4_096

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

const resolveScriptMaxTmpBytes = () => {
  const raw = (process.env.CORAZON_WORKFLOW_SCRIPT_MAX_TMP_BYTES ?? '').trim()
  if (raw === '') {
    return WORKFLOW_SCRIPT_MAX_TMP_BYTES_DEFAULT
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < WORKFLOW_SCRIPT_MAX_TMP_BYTES_MIN) {
    return WORKFLOW_SCRIPT_MAX_TMP_BYTES_DEFAULT
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

const buildScriptExecutionEnv = (allowlist: string[], sandboxDirectory: string) => {
  const reservedKeys = new Set(['HOME', 'TMPDIR'])
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: sandboxDirectory,
    TMPDIR: sandboxDirectory
  }

  for (const key of allowlist) {
    if (reservedKeys.has(key)) {
      continue
    }
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

const computeDirectoryBytes = async (directory: string) => {
  let total = 0
  const stack = [directory]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) {
      continue
    }
    let entries: Dirent[]
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const entryPath = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(entryPath)
        continue
      }
      if (!entry.isFile()) {
        continue
      }
      try {
        total += (await stat(entryPath)).size
      } catch {
        // ignore transient file-system races while the script is still running
      }
    }
  }
  return total
}

const executeScriptProcess = async (
  command: string,
  args: string[],
  options: {
    cwd: string
    timeoutMs: number
    maxOutputBytes: number
    envAllowlist: string[]
    maxTmpBytes: number
  }
) => {
  type ProcessExecutionResult
    = | {
      status: 'completed'
      stdout: string
      stderr: string
      exitCode: number
      durationMs: number
      stdoutBytes: number
      stderrBytes: number
      outputTruncated: boolean
      terminationSignal: NodeJS.Signals | null
      terminationScope: 'none' | 'process' | 'process-group'
      tmpBytes: number
    }
    | {
      status: 'failed'
      errorCode: WorkflowScriptSandboxErrorCode
      errorMessage: string
      stdout: string
      stderr: string
      exitCode: number | null
      durationMs: number
      stdoutBytes: number
      stderrBytes: number
      outputTruncated: boolean
      terminationSignal: NodeJS.Signals | null
      terminationScope: 'none' | 'process' | 'process-group'
      tmpBytes: number
    }

  const startedAt = Date.now()
  let stdout = ''
  let stderr = ''
  let stdoutBytes = 0
  let stderrBytes = 0
  let capturedOutputBytes = 0
  let outputTruncated = false

  const appendCapturedOutput = (current: string, chunk: string) => {
    const chunkBytes = Buffer.byteLength(chunk)
    const remainingCaptureBytes = Math.max(options.maxOutputBytes - capturedOutputBytes, 0)
    if (remainingCaptureBytes <= 0) {
      if (chunkBytes > 0) {
        outputTruncated = true
      }
      return current
    }
    if (chunkBytes <= remainingCaptureBytes) {
      capturedOutputBytes += chunkBytes
      return current + chunk
    }
    outputTruncated = true
    const chunkBuffer = Buffer.from(chunk)
    const truncatedChunk = chunkBuffer.subarray(0, remainingCaptureBytes).toString('utf8')
    capturedOutputBytes += remainingCaptureBytes
    return current + truncatedChunk
  }

  return await new Promise<ProcessExecutionResult>((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildScriptExecutionEnv(options.envAllowlist, options.cwd),
      detached: process.platform !== 'win32'
    })
    let terminationScope: 'none' | 'process' | 'process-group' = 'none'

    const killExecution = (signal: NodeJS.Signals = 'SIGKILL') => {
      if (process.platform !== 'win32' && typeof child.pid === 'number' && child.pid > 0) {
        try {
          process.kill(-child.pid, signal)
          terminationScope = 'process-group'
          return
        } catch {
          // fall through to single-process kill
        }
      }

      if (child.kill(signal)) {
        terminationScope = 'process'
      }
    }

    const totalOutputBytes = () => stdoutBytes + stderrBytes
    let outputLimitExceeded = false
    let outputLimitStream: 'stdout' | 'stderr' | null = null
    let tmpLimitExceeded = false
    let tmpBytes = 0

    const observeTmpUsage = async () => {
      tmpBytes = await computeDirectoryBytes(options.cwd)
      if (tmpLimitExceeded) {
        return
      }
      if (tmpBytes > options.maxTmpBytes) {
        tmpLimitExceeded = true
        killExecution('SIGKILL')
      }
    }

    const enforceOutputLimit = (stream: 'stdout' | 'stderr') => {
      if (outputLimitExceeded) {
        return
      }
      if (totalOutputBytes() <= options.maxOutputBytes) {
        return
      }
      outputLimitExceeded = true
      outputLimitStream = stream
      killExecution('SIGKILL')
    }

    child.stdout.on('data', (chunk) => {
      const text = String(chunk)
      const chunkBytes = Buffer.byteLength(text)
      stdoutBytes += chunkBytes
      stdout = appendCapturedOutput(stdout, text)
      enforceOutputLimit('stdout')
    })
    child.stderr.on('data', (chunk) => {
      const text = String(chunk)
      const chunkBytes = Buffer.byteLength(text)
      stderrBytes += chunkBytes
      stderr = appendCapturedOutput(stderr, text)
      enforceOutputLimit('stderr')
    })

    let timedOut = false
    const timeoutHandle = setTimeout(() => {
      timedOut = true
      killExecution('SIGKILL')
    }, options.timeoutMs)
    const tmpUsageHandle = setInterval(() => {
      void observeTmpUsage()
    }, 100)

    child.on('error', (error) => {
      clearTimeout(timeoutHandle)
      clearInterval(tmpUsageHandle)
      resolve({
        status: 'failed',
        errorCode: 'provider-error',
        errorMessage: `Failed to start script runtime: ${error.message}`,
        stdout,
        stderr,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        stdoutBytes,
        stderrBytes,
        outputTruncated,
        terminationSignal: null,
        terminationScope,
        tmpBytes
      })
    })

    child.on('close', async (exitCode, signal) => {
      clearTimeout(timeoutHandle)
      clearInterval(tmpUsageHandle)
      await observeTmpUsage()
      if (tmpLimitExceeded) {
        resolve({
          status: 'failed',
          errorCode: 'policy-violation',
          errorMessage:
            `Workflow script temporary workspace exceeded ${options.maxTmpBytes} bytes `
            + `(${tmpBytes} bytes observed).`,
          stdout,
          stderr,
          exitCode: null,
          durationMs: Date.now() - startedAt,
          stdoutBytes,
          stderrBytes,
          outputTruncated,
          terminationSignal: signal,
          terminationScope,
          tmpBytes
        })
        return
      }
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
          durationMs: Date.now() - startedAt,
          stdoutBytes,
          stderrBytes,
          outputTruncated,
          terminationSignal: signal,
          terminationScope,
          tmpBytes
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
          durationMs: Date.now() - startedAt,
          stdoutBytes,
          stderrBytes,
          outputTruncated,
          terminationSignal: signal,
          terminationScope,
          tmpBytes
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
          durationMs: Date.now() - startedAt,
          stdoutBytes,
          stderrBytes,
          outputTruncated,
          terminationSignal: signal,
          terminationScope,
          tmpBytes
        })
        return
      }

      resolve({
        status: 'completed',
        stdout,
        stderr,
        exitCode: 0,
        durationMs: Date.now() - startedAt,
        stdoutBytes,
        stderrBytes,
        outputTruncated,
        terminationSignal: signal,
        terminationScope,
        tmpBytes
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
    const startedAt = Date.now()
    const sourceBytes = Buffer.byteLength(context.definition.instruction, 'utf8')
    if (context.definition.frontmatter.language === 'markdown') {
      const metadata: WorkflowScriptExecutionMetadata = {
        providerId: 'local',
        language: 'markdown',
        triggerType: context.triggerType,
        executionDurationMs: 0,
        prepareDurationMs: 0,
        executeDurationMs: 0,
        teardownDurationMs: 0,
        timeoutMs: resolveScriptTimeoutMs(),
        maxOutputBytes: resolveScriptMaxOutputBytes(),
        maxSourceBytes: resolveScriptMaxSourceBytes(),
        maxTmpBytes: resolveScriptMaxTmpBytes(),
        sourceBytes,
        tmpBytes: 0,
        allowedEnvKeys: resolveScriptEnvAllowlist(),
        runtimeCommand: null,
        runtimeArgs: [],
        stdoutBytes: 0,
        stderrBytes: 0,
        totalOutputBytes: 0,
        outputTruncated: false,
        terminationSignal: null,
        terminationScope: 'none',
        policyTriggered: 'none',
        failurePhase: 'none'
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
    const maxTmpBytes = resolveScriptMaxTmpBytes()
    const envAllowlist = resolveScriptEnvAllowlist()
    const metadata: WorkflowScriptExecutionMetadata = {
      providerId: 'local',
      language,
      triggerType: context.triggerType,
      executionDurationMs: 0,
      prepareDurationMs: 0,
      executeDurationMs: 0,
      teardownDurationMs: 0,
      timeoutMs,
      maxOutputBytes,
      maxSourceBytes,
      maxTmpBytes,
      sourceBytes,
      tmpBytes: 0,
      allowedEnvKeys: [...envAllowlist],
      runtimeCommand: null,
      runtimeArgs: [],
      stdoutBytes: 0,
      stderrBytes: 0,
      totalOutputBytes: 0,
      outputTruncated: false,
      terminationSignal: null,
      terminationScope: 'none',
      policyTriggered: 'none',
      failurePhase: 'none'
    }
    if (sourceBytes > maxSourceBytes) {
      metadata.policyTriggered = 'source-size'
      const durationMs = Date.now() - startedAt
      metadata.executionDurationMs = durationMs
      return {
        status: 'failed',
        errorCode: 'policy-violation',
        errorMessage:
          `Workflow script source exceeded ${maxSourceBytes} bytes `
          + `(${sourceBytes} bytes received).`,
        stdout: '',
        stderr: '',
        exitCode: null,
        durationMs,
        metadata
      }
    }
    const tempDirectory = await mkdtemp(join(tmpdir(), 'corazon-workflow-script-'))
    let executionPhase: 'prepare' | 'execute' = 'prepare'
    let executeStartedAt: number | null = null
    let result: WorkflowScriptExecutionResult | null = null
    try {
      console.info(
        `[workflow-script-sandbox] provider=${metadata.providerId} phase=prepare`
        + ` language=${metadata.language} trigger=${metadata.triggerType}`
        + ` timeoutMs=${metadata.timeoutMs} maxOutputBytes=${metadata.maxOutputBytes}`
        + ` maxTmpBytes=${metadata.maxTmpBytes}`
        + ` sourceBytes=${metadata.sourceBytes}/${metadata.maxSourceBytes}`
        + ` allowEnv=${metadata.allowedEnvKeys.join(',') || '(none)'}`
      )
      await writeRunnableScript(tempDirectory, language, context.definition.instruction)
      const runtime = resolveScriptBinaryByLanguage(language)
      metadata.prepareDurationMs = Date.now() - startedAt
      metadata.runtimeCommand = runtime.command
      metadata.runtimeArgs = [...runtime.args]
      executionPhase = 'execute'
      executeStartedAt = Date.now()
      console.info(
        `[workflow-script-sandbox] provider=${metadata.providerId} phase=execute-start`
        + ` command=${runtime.command} args=${runtime.args.join(' ') || '(none)'}`
      )
      const executionResult = await executeScriptProcess(runtime.command, runtime.args, {
        cwd: tempDirectory,
        timeoutMs,
        maxOutputBytes,
        envAllowlist,
        maxTmpBytes
      })
      metadata.stdoutBytes = executionResult.stdoutBytes
      metadata.stderrBytes = executionResult.stderrBytes
      metadata.totalOutputBytes = executionResult.stdoutBytes + executionResult.stderrBytes
      metadata.outputTruncated = executionResult.outputTruncated
      metadata.tmpBytes = executionResult.tmpBytes
      metadata.terminationSignal = executionResult.terminationSignal
      metadata.terminationScope = executionResult.terminationScope
      metadata.executionDurationMs = executionResult.durationMs
      metadata.executeDurationMs = executionResult.durationMs
      if (executionResult.status === 'failed' && executionResult.errorCode === 'policy-violation') {
        metadata.policyTriggered = executionResult.errorMessage.includes('temporary workspace exceeded')
          ? 'tmp-size'
          : 'output-size'
      }
      if (executionResult.status === 'failed' && executionResult.errorCode === 'provider-error') {
        metadata.failurePhase = 'execute'
      }
      console.info(
        `[workflow-script-sandbox] provider=${metadata.providerId} phase=teardown`
        + ` status=${executionResult.status} durationMs=${executionResult.durationMs}`
        + ` stdoutBytes=${executionResult.stdoutBytes} stderrBytes=${executionResult.stderrBytes}`
        + ` tmpBytes=${executionResult.tmpBytes}`
        + ` signal=${executionResult.terminationSignal ?? '(none)'}`
        + ` terminationScope=${executionResult.terminationScope}`
        + (executionResult.status === 'failed'
          ? ` errorCode=${executionResult.errorCode}`
          : '')
        + (executionResult.status === 'failed' && executionResult.errorCode === 'provider-error'
          ? ` failurePhase=${metadata.failurePhase}`
          : '')
        + ` prepareDurationMs=${metadata.prepareDurationMs}`
        + ` executeDurationMs=${metadata.executeDurationMs}`
        + ` teardownDurationMs=${metadata.teardownDurationMs}`
      )
      result = {
        ...executionResult,
        metadata
      }
      return result
    } catch (error) {
      metadata.failurePhase = executionPhase
      const message = formatProviderFailureMessage(language, error)
      const durationMs = Date.now() - startedAt
      metadata.executionDurationMs = durationMs
      if (executionPhase === 'prepare') {
        metadata.prepareDurationMs = durationMs
      }
      if (executionPhase === 'execute' && executeStartedAt !== null) {
        metadata.executeDurationMs = Date.now() - executeStartedAt
      }
      console.warn(
        `[workflow-script-sandbox] provider=${metadata.providerId} phase=teardown`
        + ' status=failed errorCode=provider-error'
        + ` failurePhase=${metadata.failurePhase} message=${message}`
        + ` prepareDurationMs=${metadata.prepareDurationMs}`
        + ` executeDurationMs=${metadata.executeDurationMs}`
        + ` teardownDurationMs=${metadata.teardownDurationMs}`
      )
      result = {
        status: 'failed',
        errorCode: 'provider-error',
        errorMessage: message,
        stdout: '',
        stderr: '',
        exitCode: null,
        durationMs,
        metadata
      }
      return result
    } finally {
      const teardownStartedAt = Date.now()
      try {
        await rm(tempDirectory, { recursive: true, force: true })
      } catch {
        // no-op cleanup guard
      } finally {
        metadata.teardownDurationMs = Date.now() - teardownStartedAt
        if (result !== null) {
          result.metadata.teardownDurationMs = metadata.teardownDurationMs
        }
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
