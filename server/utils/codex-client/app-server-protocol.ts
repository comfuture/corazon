import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'
import type { ServerNotification } from '@@/types/codex-app-server/ServerNotification'
import type { ServerRequest } from '@@/types/codex-app-server/ServerRequest'
import type { RequestId } from '@@/types/codex-app-server/RequestId'
import type { CodexClientConfigValue } from './types.ts'

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

const INTERNAL_ORIGINATOR_ENV = 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE'
const CORAZON_ORIGINATOR = 'corazon_app_server'

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

const resolveCodexAppServerBin = async () => {
  const sdkEntryUrl = await import.meta.resolve('@openai/codex-sdk')
  const sdkEntryPath = fileURLToPath(sdkEntryUrl)
  const sdkRequire = createRequire(sdkEntryPath)
  return sdkRequire.resolve('@openai/codex/bin/codex.js')
}

const asServerRequest = (request: JsonRpcRequest): ServerRequest =>
  request as unknown as ServerRequest

export class AppServerProtocol {
  private readonly options: ProtocolOptions

  private process: ChildProcessWithoutNullStreams | null = null

  private reader: readline.Interface | null = null

  private startPromise: Promise<void> | null = null

  private nextRequestId = 1

  private pending = new Map<RequestId, PendingRequest>()

  private listeners = new Set<(notification: ServerNotification) => void>()

  private closeListeners = new Set<(error: Error) => void>()

  constructor(options: ProtocolOptions = {}) {
    this.options = options
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
    if (this.process) {
      return
    }

    if (this.startPromise) {
      await this.startPromise
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
    const codexBin = await resolveCodexAppServerBin()
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

    this.process = child
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
      this.handleProcessClosed(error)
    })

    child.once('close', (code, signal) => {
      const detail = signal ? `signal ${signal}` : `code ${code ?? 0}`
      this.handleProcessClosed(new Error(`Codex app-server exited with ${detail}.`))
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
        return {
          contentItems: [
            {
              type: 'inputText',
              text: `Dynamic tool "${request.params.tool}" is not configured in Corazon.`
            }
          ],
          success: false
        }
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

  private emitNotification(notification: ServerNotification) {
    for (const listener of this.listeners) {
      listener(notification)
    }
  }

  private handleProcessClosed(error: Error) {
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

    this.process = null
  }
}
