import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import readline from 'node:readline'
import type { ServerNotification } from '@@/types/codex-app-server/ServerNotification'
import type { ServerRequest } from '@@/types/codex-app-server/ServerRequest'
import type { RequestId } from '@@/types/codex-app-server/RequestId'
import type { DynamicToolCallParams } from '@@/types/codex-app-server/v2/DynamicToolCallParams'
import type { DynamicToolCallResponse } from '@@/types/codex-app-server/v2/DynamicToolCallResponse'
import type { CodexClientConfigValue } from './types.ts'
import { resolveNativeDynamicToolCall } from './native-tools.ts'

type JsonRpcError = {
  code: number
  message: string
  data?: unknown
}

type JsonRpcRequest = {
  id: RequestId
  method: string
  params?: unknown
}

type JsonRpcResponse = {
  id: RequestId
  result?: unknown
  error?: JsonRpcError
}

type JsonRpcNotification = {
  method: string
  params?: unknown
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

type ProtocolOptions = {
  env?: Record<string, string>
  config?: Record<string, CodexClientConfigValue>
}

type AppServerPidFile = {
  pid: number
  signature: string
  startedAt: number
}

const buildDynamicToolFailureResponse = (message: string): DynamicToolCallResponse => ({
  contentItems: [
    {
      type: 'inputText',
      text: message
    }
  ],
  success: false
})

const INTERNAL_ORIGINATOR_ENV = 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE'
const CORAZON_ORIGINATOR = 'corazon_app_server'
const DEFAULT_PID_DIR = join(process.cwd(), '.corazon', 'run')

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value != null

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  isObject(value) && !Array.isArray(value)

const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/

const formatTomlKey = (key: string) => (TOML_BARE_KEY.test(key) ? key : JSON.stringify(key))

const toTomlValue = (value: CodexClientConfigValue, path: string): string => {
  if (typeof value === 'string') {
    return JSON.stringify(value)
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Codex config override at ${path} must be a finite number.`)
    }
    return String(value)
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }

  if (Array.isArray(value)) {
    const parts = value.map((item, index) => toTomlValue(item, `${path}[${index}]`))
    return `[${parts.join(', ')}]`
  }

  if (isPlainObject(value)) {
    const parts: string[] = []
    for (const [key, child] of Object.entries(value)) {
      parts.push(`${formatTomlKey(key)} = ${toTomlValue(child as CodexClientConfigValue, `${path}.${key}`)}`)
    }
    return `{${parts.join(', ')}}`
  }

  throw new Error(`Unsupported Codex config override value at ${path}.`)
}

const flattenConfigOverrides = (
  value: Record<string, CodexClientConfigValue>,
  prefix: string,
  output: string[]
) => {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (isPlainObject(child)) {
      flattenConfigOverrides(child as Record<string, CodexClientConfigValue>, path, output)
      continue
    }
    output.push(`${path}=${toTomlValue(child, path)}`)
  }
}

const serializeConfigOverrides = (value?: Record<string, CodexClientConfigValue>) => {
  if (!value) {
    return []
  }
  const output: string[] = []
  flattenConfigOverrides(value, '', output)
  return output
}

const normalizeSignatureValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(item => normalizeSignatureValue(item))
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalizeSignatureValue(child)])
    )
  }

  return value
}

const resolveProtocolSignature = (options: ProtocolOptions) =>
  JSON.stringify(normalizeSignatureValue({
    codeXHome: options.env?.CODEX_HOME ?? process.env.CODEX_HOME ?? null,
    config: options.config ?? {}
  }))

const resolvePidFilePath = (options: ProtocolOptions, signature: string) => {
  const digest = createHash('sha256').update(signature).digest('hex').slice(0, 16)
  const baseDir = options.env?.CODEX_HOME
    ? join(options.env.CODEX_HOME, 'run')
    : process.env.CODEX_HOME
      ? join(process.env.CODEX_HOME, 'run')
      : DEFAULT_PID_DIR
  return join(baseDir, `codex-app-server-${digest}.pid.json`)
}

const readPidFile = (path: string): AppServerPidFile | null => {
  if (!existsSync(path)) {
    return null
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<AppServerPidFile>
    if (
      typeof parsed.pid === 'number'
      && Number.isInteger(parsed.pid)
      && typeof parsed.signature === 'string'
      && typeof parsed.startedAt === 'number'
    ) {
      return {
        pid: parsed.pid,
        signature: parsed.signature,
        startedAt: parsed.startedAt
      }
    }
  } catch {
    return null
  }

  return null
}

const writePidFile = (path: string, data: AppServerPidFile) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(data)}\n`, 'utf8')
}

const removePidFile = (path: string) => {
  rmSync(path, { force: true })
}

const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const toProtocolError = (error: unknown): JsonRpcError => {
  if (isObject(error)) {
    const code = typeof error.code === 'number' ? error.code : -32000
    const message = typeof error.message === 'string' ? error.message : 'Unknown app-server error.'
    const data = 'data' in error ? error.data : undefined
    return { code, message, data }
  }

  return {
    code: -32000,
    message: error instanceof Error ? error.message : String(error)
  }
}

const isServerRequestMessage = (value: unknown): value is JsonRpcRequest =>
  isObject(value) && 'id' in value && 'method' in value

const isResponseMessage = (value: unknown): value is JsonRpcResponse =>
  isObject(value) && 'id' in value && !('method' in value)

const isNotificationMessage = (value: unknown): value is JsonRpcNotification =>
  isObject(value) && 'method' in value && !('id' in value)

const buildDefaultEnv = () => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value
    }
  }
  return env
}

const resolveCodexSdkPackageRoot = () => {
  const sdkPackageRoot = join(process.cwd(), 'node_modules', '@openai', 'codex-sdk')
  if (!existsSync(sdkPackageRoot)) {
    throw new Error(`Unable to locate @openai/codex-sdk at ${sdkPackageRoot}`)
  }
  return realpathSync(sdkPackageRoot)
}

const resolveCodexAppServerBin = () => {
  const sdkPackageRoot = resolveCodexSdkPackageRoot()
  const sdkRequire = createRequire(join(sdkPackageRoot, 'package.json'))
  return sdkRequire.resolve('@openai/codex/bin/codex.js')
}

const asServerRequest = (request: JsonRpcRequest): ServerRequest =>
  request as unknown as ServerRequest

export class AppServerProtocol {
  private readonly options: ProtocolOptions

  private readonly signature: string

  private readonly pidFilePath: string

  private process: ChildProcessWithoutNullStreams | null = null

  private reader: readline.Interface | null = null

  private startPromise: Promise<void> | null = null

  private processGeneration = 0

  private nextRequestId = 1

  private pending = new Map<RequestId, PendingRequest>()

  private listeners = new Set<(notification: ServerNotification) => void>()

  private closeListeners = new Set<(error: Error) => void>()

  constructor(options: ProtocolOptions = {}, signature = resolveProtocolSignature(options)) {
    this.options = options
    this.signature = signature
    this.pidFilePath = resolvePidFilePath(options, signature)
  }

  subscribe(listener: (notification: ServerNotification) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  onClose(listener: (error: Error) => void) {
    this.closeListeners.add(listener)
    return () => {
      this.closeListeners.delete(listener)
    }
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    await this.ensureStarted()

    const requestId = this.nextRequestId
    this.nextRequestId += 1

    const payload: JsonRpcRequest = { id: requestId, method }
    if (params !== undefined) {
      payload.params = params
    }

    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: value => resolve(value as T),
        reject
      })

      try {
        this.write(payload)
      } catch (error) {
        this.pending.delete(requestId)
        reject(error)
      }
    })
  }

  private async ensureStarted() {
    if (this.startPromise) {
      await this.startPromise
      return
    }

    if (this.process && this.ensureHealthy()) {
      return
    }

    this.startPromise = this.startInternal()

    try {
      await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  private async startInternal() {
    const codexBin = resolveCodexAppServerBin()
    const args = [codexBin, 'app-server', '--listen', 'stdio://']

    for (const configOverride of serializeConfigOverrides(this.options.config)) {
      args.push('--config', configOverride)
    }

    const env = this.options.env ? { ...this.options.env } : buildDefaultEnv()
    if (!env[INTERNAL_ORIGINATOR_ENV]) {
      env[INTERNAL_ORIGINATOR_ENV] = CORAZON_ORIGINATOR
    }

    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const generation = ++this.processGeneration

    this.process = child
    if (typeof child.pid === 'number') {
      writePidFile(this.pidFilePath, {
        pid: child.pid,
        signature: this.signature,
        startedAt: Date.now()
      })
    }
    this.reader = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity
    })

    this.reader.on('line', (line) => {
      this.handleLine(line)
    })

    child.stderr.on('data', (chunk) => {
      const message = chunk.toString('utf8').trim()
      if (message) {
        console.error(`[codex app-server] ${message}`)
      }
    })

    child.once('error', (error) => {
      this.handleProcessClosed(generation, error)
    })

    child.once('close', (code, signal) => {
      const detail = signal ? `signal ${signal}` : `code ${code ?? 0}`
      this.handleProcessClosed(generation, new Error(`Codex app-server exited with ${detail}.`))
    })

    await this.request('initialize', {
      clientInfo: {
        name: 'corazon_app_server',
        title: 'Corazon App Server Harness',
        version: '0.1.0'
      },
      capabilities: {
        experimentalApi: true
      }
    })

    this.write({ method: 'initialized' })
  }

  private write(payload: Record<string, unknown>) {
    if (!this.ensureHealthy()) {
      throw new Error('Codex app-server is not healthy.')
    }

    if (!this.process?.stdin || this.process.stdin.destroyed) {
      throw new Error('Codex app-server stdin is not available.')
    }

    this.process.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  private handleLine(line: string) {
    const source = line.trim()
    if (!source) {
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(source)
    } catch {
      console.error('[codex app-server] Failed to parse JSON message:', source)
      return
    }

    if (isServerRequestMessage(parsed)) {
      void this.handleServerRequest(parsed)
      return
    }

    if (isResponseMessage(parsed)) {
      this.handleResponse(parsed)
      return
    }

    if (isNotificationMessage(parsed)) {
      this.emitNotification(parsed as unknown as ServerNotification)
    }
  }

  private handleResponse(response: JsonRpcResponse) {
    const pending = this.pending.get(response.id)
    if (!pending) {
      return
    }

    this.pending.delete(response.id)

    if (response.error) {
      pending.reject(response.error)
      return
    }

    pending.resolve(response.result)
  }

  private async handleServerRequest(request: JsonRpcRequest) {
    const typedRequest = asServerRequest(request)

    try {
      const result = await this.resolveServerRequest(typedRequest)
      this.write({ id: request.id, result })
    } catch (error) {
      this.write({ id: request.id, error: toProtocolError(error) })
    }
  }

  private async resolveServerRequest(request: ServerRequest) {
    switch (request.method) {
      case 'item/commandExecution/requestApproval':
        return { decision: 'decline' }
      case 'item/fileChange/requestApproval':
        return { decision: 'decline' }
      case 'item/tool/requestUserInput':
        return { answers: {} }
      case 'item/tool/call':
        return this.resolveDynamicToolCall(request.params)
      case 'applyPatchApproval':
        return { decision: 'denied' }
      case 'execCommandApproval':
        return { decision: 'denied' }
      case 'account/chatgptAuthTokens/refresh':
        throw new Error('ChatGPT token refresh is not supported in Corazon app-server client mode.')
      default:
        throw new Error(`Unsupported server request method: ${(request as { method: string }).method}`)
    }
  }

  private emitDynamicToolStarted(params: DynamicToolCallParams) {
    this.emitNotification({
      method: 'item/started',
      params: {
        threadId: params.threadId,
        turnId: params.turnId,
        item: {
          type: 'dynamicToolCall',
          id: params.callId,
          tool: params.tool,
          arguments: params.arguments,
          status: 'inProgress',
          contentItems: null,
          success: null,
          durationMs: null
        }
      }
    } as ServerNotification)
  }

  private emitDynamicToolCompleted(
    params: DynamicToolCallParams,
    response: DynamicToolCallResponse,
    durationMs: number
  ) {
    this.emitNotification({
      method: 'item/completed',
      params: {
        threadId: params.threadId,
        turnId: params.turnId,
        item: {
          type: 'dynamicToolCall',
          id: params.callId,
          tool: params.tool,
          arguments: params.arguments,
          status: response.success ? 'completed' : 'failed',
          contentItems: response.contentItems,
          success: response.success,
          durationMs
        }
      }
    } as ServerNotification)
  }

  private async resolveDynamicToolCall(params: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
    const startedAt = Date.now()
    this.emitDynamicToolStarted(params)

    let response: DynamicToolCallResponse
    try {
      response = await resolveNativeDynamicToolCall(params) ?? buildDynamicToolFailureResponse(
        `Dynamic tool "${params.tool}" is not configured in Corazon.`
      )
    } catch (error) {
      response = buildDynamicToolFailureResponse(error instanceof Error ? error.message : String(error))
    }

    this.emitDynamicToolCompleted(params, response, Date.now() - startedAt)
    return response
  }

  private emitNotification(notification: ServerNotification) {
    for (const listener of this.listeners) {
      listener(notification)
    }
  }

  private ensureHealthy() {
    const child = this.process
    if (!child) {
      return false
    }

    if (
      child.killed
      || child.exitCode !== null
      || child.signalCode !== null
      || !child.stdin
      || child.stdin.destroyed
    ) {
      this.handleProcessClosed(this.processGeneration, new Error('Codex app-server became unavailable.'))
      return false
    }

    const pid = child.pid
    if (typeof pid !== 'number' || !isProcessAlive(pid)) {
      this.handleProcessClosed(this.processGeneration, new Error('Codex app-server pid is no longer alive.'))
      return false
    }

    const pidFile = readPidFile(this.pidFilePath)
    if (!pidFile || pidFile.pid !== pid || pidFile.signature !== this.signature) {
      writePidFile(this.pidFilePath, {
        pid,
        signature: this.signature,
        startedAt: Date.now()
      })
    }

    return true
  }

  private handleProcessClosed(generation: number, error: Error) {
    if (generation !== this.processGeneration) {
      return
    }

    if (!this.process && !this.reader) {
      return
    }

    for (const [id, pending] of this.pending) {
      pending.reject(error)
      this.pending.delete(id)
    }

    for (const listener of this.closeListeners) {
      listener(error)
    }

    this.emitNotification({
      method: 'error',
      params: {
        error: {
          message: error.message,
          codexErrorInfo: null,
          additionalDetails: null
        },
        willRetry: false,
        threadId: '',
        turnId: ''
      }
    } as ServerNotification)

    if (this.reader) {
      this.reader.close()
      this.reader = null
    }

    const pid = this.process?.pid
    this.process = null
    const pidFile = readPidFile(this.pidFilePath)
    if (!pidFile || typeof pid !== 'number' || pidFile.pid === pid) {
      removePidFile(this.pidFilePath)
    }
  }
}

const sharedProtocols = new Map<string, AppServerProtocol>()

export const getSharedAppServerProtocol = (options: ProtocolOptions = {}) => {
  const signature = resolveProtocolSignature(options)
  const existing = sharedProtocols.get(signature)
  if (existing) {
    return existing
  }

  const protocol = new AppServerProtocol(options, signature)
  sharedProtocols.set(signature, protocol)
  return protocol
}
