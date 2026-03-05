import { createAppServerCodexClient } from './app-server-client.ts'
import { createSdkCodexClient } from './sdk-client.ts'
import type { CodexClient, CodexClientInitOptions, CodexClientMode } from './types.ts'

const DEFAULT_MODE: CodexClientMode = 'app-server'

export const resolveCodexClientMode = (value: unknown): CodexClientMode => {
  if (value === 'sdk') {
    return 'sdk'
  }
  if (value === 'app-server') {
    return 'app-server'
  }
  return DEFAULT_MODE
}

const resolveMode = (options?: CodexClientInitOptions): CodexClientMode =>
  resolveCodexClientMode(options?.mode ?? process.env.CORAZON_CODEX_CLIENT_MODE ?? DEFAULT_MODE)

export const createCodexClient = (options: CodexClientInitOptions = {}): CodexClient => {
  const mode = resolveMode(options)
  console.info(`[corazon] codex client mode: ${mode}`)

  if (mode === 'app-server') {
    return createAppServerCodexClient(options)
  }

  return createSdkCodexClient(options)
}
