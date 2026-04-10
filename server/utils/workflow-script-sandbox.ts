import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { accessSync, constants as fsConstants } from 'node:fs'
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
  containmentModeRequested: WorkflowScriptContainmentMode
  containmentModeApplied: WorkflowScriptContainmentAppliedMode
  containmentEnforced: boolean
  containmentFallbackReason: string | null
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

export type WorkflowScriptContainmentMode = 'host' | 'auto' | 'linux-strict'
export type WorkflowScriptContainmentAppliedMode = 'host' | 'linux-strict'

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
const WORKFLOW_SCRIPT_CONTAINMENT_MODE_DEFAULT: WorkflowScriptContainmentMode = 'host'

type WorkflowScriptContainmentPolicy = {
  requested: WorkflowScriptContainmentMode
  applied: WorkflowScriptContainmentAppliedMode
  enforced: boolean
  executionPrefix: string[]
  fallbackReason: string | null
  unsupportedReason: string | null
}

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

const resolveScriptContainmentMode = (): WorkflowScriptContainmentMode => {
  const raw = (process.env.CORAZON_WORKFLOW_SCRIPT_CONTAINMENT_MODE ?? '').trim().toLowerCase()
  if (raw === 'auto' || raw === 'linux-strict' || raw === 'host') {
    return raw
  }
  return WORKFLOW_SCRIPT_CONTAINMENT_MODE_DEFAULT
}

const resolveScriptContainmentLinuxPrefix = () => {
  const raw = (process.env.CORAZON_WORKFLOW_SCRIPT_CONTAINMENT_LINUX_PREFIX ?? '').trim()
  if (raw === '') {
    return { args: [] as string[], error: null as string | null }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {
      args: [],
      error:
        'CORAZON_WORKFLOW_SCRIPT_CONTAINMENT_LINUX_PREFIX must be a JSON string array '
        + '(for example: ["systemd-run","--scope","--user","--"]).'
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return {
      args: [],
      error:
        'CORAZON_WORKFLOW_SCRIPT_CONTAINMENT_LINUX_PREFIX must be a non-empty JSON string array.'
    }
  }
  const args = parsed
    .map(item => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean)
  if (args.length === 0) {
    return {
      args: [],
      error:
        'CORAZON_WORKFLOW_SCRIPT_CONTAINMENT_LINUX_PREFIX must include at least one non-empty command token.'
    }
  }
  return { args, error: null as string | null }
}

const isExecutableOnPath = (command: string) => {
  if (command.includes('/') || command.includes('\\')) {
    try {
      accessSync(command, fsConstants.X_OK)
      return true
    } catch {
      return false
    }
  }
  const pathValue = process.env.PATH ?? ''
  const entries = pathValue.split(':').map(item => item.trim()).filter(Boolean)
  for (const entry of entries) {
    const resolved = join(entry, command)
    try {
      accessSync(resolved, fsConstants.X_OK)
      return true
    } catch {
      continue
    }
  }
  return false
}

const resolveScriptContainmentPolicy = (): WorkflowScriptContainmentPolicy => {
  const requested = resolveScriptContainmentMode()
  const { args: linuxPrefix, error: linuxPrefixError } = resolveScriptContainmentLinuxPrefix()
  if (requested === 'linux-strict' && process.platform !== 'linux') {
    return {
      requested,
      applied: 'linux-strict',
      enforced: false,
      executionPrefix: [],
      fallbackReason: null,
      unsupportedReason:
        'CORAZON_WORKFLOW_SCRIPT_CONTAINMENT_MODE=linux-strict requires a Linux host.'
    }
  }
  if (requested === 'host') {
    return {
      requested,
      applied: 'host',
      enforced: false,
      executionPrefix: [],
      fallbackReason: null,
      unsupportedReason: null
    }
  }
  if (process.platform !== 'linux') {
    return {
      requested,
      applied: 'host',
      enforced: false,
      executionPrefix: [],
      fallbackReason:
        `OS-level containment is Linux-only; using host process sandbox limits on ${process.platform}.`,
      unsupportedReason: null
    }
  }
  if (linuxPrefixError !== null) {
    if (requested === 'auto') {
      return {
        requested,
        applied: 'host',
        enforced: false,
        executionPrefix: [],
        fallbackReason: `${linuxPrefixError} Using host process sandbox limits only.`,
        unsupportedReason: null
      }
    }
    return {
      requested,
      applied: 'linux-strict',
      enforced: false,
      executionPrefix: [],
      fallbackReason: null,
      unsupportedReason: linuxPrefixError
    }
  }
  if (linuxPrefix.length > 0) {
    const containmentCommand = linuxPrefix[0] ?? ''
    if (!isExecutableOnPath(containmentCommand)) {
      const unsupportedReason = `Configured Linux containment launcher "${containmentCommand}" is not executable or not found on PATH.`
      if (requested === 'auto') {
        return {
          requested,
          applied: 'host',
          enforced: false,
          executionPrefix: [],
          fallbackReason: `${unsupportedReason} Using host process sandbox limits only.`,
          unsupportedReason: null
        }
      }
      return {
        requested,
        applied: 'linux-strict',
        enforced: false,
        executionPrefix: [],
        fallbackReason: null,
        unsupportedReason
      }
    }
    return {
      requested,
      applied: 'linux-strict',
      enforced: true,
      executionPrefix: linuxPrefix,
      fallbackReason: null,
      unsupportedReason: null
    }
  }
  if (requested === 'auto') {
    return {
      requested,
      applied: 'host',
      enforced: false,
      executionPrefix: [],
      fallbackReason:
        'OS-level containment adapter is not configured; set '
        + 'CORAZON_WORKFLOW_SCRIPT_CONTAINMENT_LINUX_PREFIX to enable strict containment. '
        + 'Using host process sandbox limits only.',
      unsupportedReason: null
    }
  }
  return {
    requested,
    applied: 'linux-strict',
    enforced: false,
    executionPrefix: [],
    fallbackReason: null,
    unsupportedReason:
      'CORAZON_WORKFLOW_SCRIPT_CONTAINMENT_MODE=linux-strict requires '
      + 'CORAZON_WORKFLOW_SCRIPT_CONTAINMENT_LINUX_PREFIX to be configured with a Linux containment launcher '
      + '(for example: ["systemd-run","--scope","--user","--"]).'
  }
}

const resolveScriptRuntimeWithContainment = (
  containmentPolicy: WorkflowScriptContainmentPolicy,
  runtime: { command: string, args: string[] }
) => {
  if (!containmentPolicy.enforced || containmentPolicy.executionPrefix.length === 0) {
    return runtime
  }
  const prefixCommand = containmentPolicy.executionPrefix[0]
  if (!prefixCommand) {
    return runtime
  }
  const prefixArgs = containmentPolicy.executionPrefix.slice(1)
  return {
    command: prefixCommand,
    args: [...prefixArgs, runtime.command, ...runtime.args]
  }
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
    return scriptPath
  }
  const transpiled = await transpileTypeScriptToModule(source)
  const scriptPath = join(directory, 'script.mjs')
  await writeFile(scriptPath, transpiled, 'utf8')
  return scriptPath
}

const isIgnorableTmpUsageError = (error: unknown) =>
  (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'

const computeDirectoryBytes = async (
  directory: string,
  options: {
    ignoredFilePaths: Set<string>
  }
) => {
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
    } catch (error) {
      if (isIgnorableTmpUsageError(error)) {
        continue
      }
      throw error
    }
    for (const entry of entries) {
      const entryPath = join(current, entry.name)
      if (options.ignoredFilePaths.has(entryPath)) {
        continue
      }
      if (entry.isDirectory()) {
        stack.push(entryPath)
        continue
      }
      if (!entry.isFile()) {
        continue
      }
      try {
        total += (await stat(entryPath)).size
      } catch (error) {
        if (isIgnorableTmpUsageError(error)) {
          continue
        }
        throw error
      }
    }
  }
  return total
}

const formatTmpUsageInspectionError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  return `Unable to inspect temporary workspace usage: ${message}`
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
    ignoredTmpFilePaths: string[]
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
      policyTriggered: WorkflowScriptExecutionMetadata['policyTriggered']
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
    let tmpInspectionError: string | null = null
    let tmpObservationRunning = false
    let tmpObservationPromise: Promise<void> | null = null
    const ignoredTmpFilePaths = new Set(options.ignoredTmpFilePaths)

    const observeTmpUsage = async () => {
      tmpBytes = await computeDirectoryBytes(options.cwd, { ignoredFilePaths: ignoredTmpFilePaths })
      if (tmpLimitExceeded) {
        return
      }
      if (tmpBytes > options.maxTmpBytes) {
        tmpLimitExceeded = true
        killExecution('SIGKILL')
      }
    }

    const startTmpObservation = () => {
      if (tmpObservationRunning || tmpInspectionError !== null || tmpLimitExceeded) {
        return
      }
      tmpObservationRunning = true
      tmpObservationPromise = (async () => {
        try {
          await observeTmpUsage()
        } catch (error) {
          if (tmpInspectionError === null) {
            tmpInspectionError = formatTmpUsageInspectionError(error)
            tmpLimitExceeded = true
            killExecution('SIGKILL')
          }
        } finally {
          tmpObservationRunning = false
          tmpObservationPromise = null
        }
      })()
    }

    const flushTmpObservation = async () => {
      if (tmpObservationPromise !== null) {
        await tmpObservationPromise
      }
      if (tmpInspectionError !== null) {
        return
      }
      try {
        await observeTmpUsage()
      } catch (error) {
        if (tmpInspectionError === null) {
          tmpInspectionError = formatTmpUsageInspectionError(error)
          tmpLimitExceeded = true
        }
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
      startTmpObservation()
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
        tmpBytes,
        policyTriggered: 'none'
      })
    })

    child.on('close', async (exitCode, signal) => {
      clearTimeout(timeoutHandle)
      clearInterval(tmpUsageHandle)
      await flushTmpObservation()
      if (tmpInspectionError !== null) {
        resolve({
          status: 'failed',
          errorCode: 'policy-violation',
          errorMessage: tmpInspectionError,
          stdout,
          stderr,
          exitCode: null,
          durationMs: Date.now() - startedAt,
          stdoutBytes,
          stderrBytes,
          outputTruncated,
          terminationSignal: signal,
          terminationScope,
          tmpBytes,
          policyTriggered: 'tmp-size'
        })
        return
      }
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
          tmpBytes,
          policyTriggered: 'tmp-size'
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
          tmpBytes,
          policyTriggered: 'output-size'
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
          tmpBytes,
          policyTriggered: 'none'
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
          tmpBytes,
          policyTriggered: 'none'
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
    const containmentPolicy = resolveScriptContainmentPolicy()
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
        containmentModeRequested: containmentPolicy.requested,
        containmentModeApplied: containmentPolicy.applied,
        containmentEnforced: containmentPolicy.enforced,
        containmentFallbackReason: containmentPolicy.fallbackReason,
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
      containmentModeRequested: containmentPolicy.requested,
      containmentModeApplied: containmentPolicy.applied,
      containmentEnforced: containmentPolicy.enforced,
      containmentFallbackReason: containmentPolicy.fallbackReason,
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
    if (containmentPolicy.unsupportedReason !== null) {
      metadata.failurePhase = 'prepare'
      const durationMs = Date.now() - startedAt
      metadata.executionDurationMs = durationMs
      metadata.prepareDurationMs = durationMs
      return {
        status: 'failed',
        errorCode: 'provider-error',
        errorMessage: containmentPolicy.unsupportedReason,
        stdout: '',
        stderr: '',
        exitCode: null,
        durationMs,
        metadata
      }
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
        + ` containmentRequested=${metadata.containmentModeRequested}`
        + ` containmentApplied=${metadata.containmentModeApplied}`
        + ` containmentEnforced=${metadata.containmentEnforced}`
        + ` containmentFallback=${metadata.containmentFallbackReason ?? '(none)'}`
        + ` sourceBytes=${metadata.sourceBytes}/${metadata.maxSourceBytes}`
        + ` allowEnv=${metadata.allowedEnvKeys.join(',') || '(none)'}`
      )
      const runnerScriptPath = await writeRunnableScript(
        tempDirectory,
        language,
        context.definition.instruction
      )
      const runtime = resolveScriptBinaryByLanguage(language)
      const runtimeWithContainment = resolveScriptRuntimeWithContainment(containmentPolicy, runtime)
      metadata.prepareDurationMs = Date.now() - startedAt
      metadata.runtimeCommand = runtimeWithContainment.command
      metadata.runtimeArgs = [...runtimeWithContainment.args]
      executionPhase = 'execute'
      executeStartedAt = Date.now()
      console.info(
        `[workflow-script-sandbox] provider=${metadata.providerId} phase=execute-start`
        + ` command=${runtimeWithContainment.command}`
        + ` args=${runtimeWithContainment.args.join(' ') || '(none)'}`
      )
      const executionResult = await executeScriptProcess(
        runtimeWithContainment.command,
        runtimeWithContainment.args,
        {
          cwd: tempDirectory,
          timeoutMs,
          maxOutputBytes,
          envAllowlist,
          maxTmpBytes,
          ignoredTmpFilePaths: [runnerScriptPath]
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
      if (executionResult.status === 'failed') {
        metadata.policyTriggered = executionResult.policyTriggered
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
