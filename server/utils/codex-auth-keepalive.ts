import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSharedAppServerProtocol } from './codex-client/app-server-protocol.ts'
import { ensureCorazonRuntimeEnvironment } from './agent-home.ts'
import { ensureAgentBootstrap } from './agent-bootstrap.ts'

type AuthMetadata = {
  authMode: string | null
  lastRefreshMs: number | null
}

type AccountReadResult = {
  account?: {
    type?: string | null
  } | null
  requiresOpenaiAuth?: boolean
}

const DEFAULT_KEEPALIVE_INTERVAL_MS = 24 * 60 * 60 * 1000
const DEFAULT_REFRESH_THRESHOLD_MS = 6 * 24 * 60 * 60 * 1000

const CODEX_CLIENT_CONFIG = {
  show_raw_agent_reasoning: true,
  approval_policy: 'never',
  sandbox_mode: 'danger-full-access'
} as const

let codexAuthKeepaliveInitialized = false
let codexAuthKeepaliveTimer: ReturnType<typeof setInterval> | null = null
let codexAuthKeepaliveRunning = false

const parseBooleanEnv = (value: string | undefined, fallback: boolean) => {
  if (!value) {
    return fallback
  }

  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false
  }

  return fallback
}

const parseDurationEnv = (value: string | undefined, fallbackMs: number) => {
  if (!value) {
    return fallbackMs
  }

  const trimmed = value.trim().toLowerCase()
  const numeric = Number(trimmed)
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.floor(numeric)
  }

  const matched = trimmed.match(/^([1-9][0-9]*)(ms|s|m|h|d)$/)
  if (!matched) {
    return fallbackMs
  }

  const amount = Number.parseInt(matched[1] ?? '0', 10)
  const unit = matched[2]
  if (!Number.isFinite(amount) || amount <= 0) {
    return fallbackMs
  }

  switch (unit) {
    case 'ms':
      return amount
    case 's':
      return amount * 1000
    case 'm':
      return amount * 60 * 1000
    case 'h':
      return amount * 60 * 60 * 1000
    case 'd':
      return amount * 24 * 60 * 60 * 1000
    default:
      return fallbackMs
  }
}

const resolveKeepaliveEnabled = () =>
  parseBooleanEnv(process.env.CORAZON_CODEX_AUTH_KEEPALIVE_ENABLED, false)

const resolveKeepaliveIntervalMs = () =>
  Math.max(60 * 60 * 1000, parseDurationEnv(process.env.CORAZON_CODEX_AUTH_KEEPALIVE_INTERVAL, DEFAULT_KEEPALIVE_INTERVAL_MS))

const resolveRefreshThresholdMs = () =>
  Math.max(60 * 60 * 1000, parseDurationEnv(process.env.CORAZON_CODEX_AUTH_KEEPALIVE_REFRESH_THRESHOLD, DEFAULT_REFRESH_THRESHOLD_MS))

const toTimestampMs = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1_000_000_000_000) {
      return Math.floor(value)
    }
    if (value > 1_000_000_000) {
      return Math.floor(value * 1000)
    }
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) {
      return null
    }

    const numeric = Number(trimmed)
    if (Number.isFinite(numeric)) {
      return toTimestampMs(numeric)
    }

    const parsed = Date.parse(trimmed)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return null
}

const getAuthFilePath = () => join(ensureAgentBootstrap(), 'auth.json')

const readAuthMetadata = (): AuthMetadata | null => {
  try {
    const raw = readFileSync(getAuthFilePath(), 'utf8')
    const parsed = JSON.parse(raw) as {
      auth_mode?: unknown
      last_refresh?: unknown
    }

    return {
      authMode: typeof parsed.auth_mode === 'string' ? parsed.auth_mode : null,
      lastRefreshMs: toTimestampMs(parsed.last_refresh)
    }
  } catch {
    return null
  }
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

const shouldRefreshAuth = (metadata: AuthMetadata | null) => {
  if (!metadata || metadata.authMode !== 'chatgpt') {
    return false
  }

  if (metadata.lastRefreshMs == null) {
    return true
  }

  return (Date.now() - metadata.lastRefreshMs) >= resolveRefreshThresholdMs()
}

export const runCodexAuthKeepaliveTick = async () => {
  if (!resolveKeepaliveEnabled() || codexAuthKeepaliveRunning) {
    return
  }

  const metadata = readAuthMetadata()
  if (!shouldRefreshAuth(metadata)) {
    return
  }

  codexAuthKeepaliveRunning = true
  try {
    const protocol = getSharedAppServerProtocol({
      env: getCodexEnv(),
      config: CODEX_CLIENT_CONFIG
    })

    const result = await protocol.request<AccountReadResult>('account/read', { refreshToken: true })
    const accountType = result.account?.type ?? metadata?.authMode ?? 'unknown'
    console.info(`[codex-auth-keepalive] refreshed managed auth via app-server (account type: ${accountType}).`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[codex-auth-keepalive] refresh failed: ${message}`)
  } finally {
    codexAuthKeepaliveRunning = false
  }
}

export const initializeCodexAuthKeepalive = () => {
  if (codexAuthKeepaliveInitialized || !resolveKeepaliveEnabled()) {
    return
  }

  codexAuthKeepaliveInitialized = true
  void runCodexAuthKeepaliveTick()
  codexAuthKeepaliveTimer = setInterval(() => {
    void runCodexAuthKeepaliveTick()
  }, resolveKeepaliveIntervalMs())
}

export const stopCodexAuthKeepalive = () => {
  if (codexAuthKeepaliveTimer) {
    clearInterval(codexAuthKeepaliveTimer)
    codexAuthKeepaliveTimer = null
  }
  codexAuthKeepaliveInitialized = false
  codexAuthKeepaliveRunning = false
}
