import { Codex } from '@openai/codex-sdk'
import type {
  CodexClient,
  CodexClientInitOptions,
  CodexThreadClient,
  CodexThreadOptions
} from './types.ts'

const asThreadClient = (value: ReturnType<Codex['startThread']>): CodexThreadClient => ({
  get id() {
    return value.id
  },
  mode: 'sdk',
  run(input, turnOptions) {
    return value.run(input, turnOptions)
  },
  runStreamed(input, turnOptions) {
    return value.runStreamed(input, turnOptions)
  },
  async interruptActiveTurn() {
    return {
      ok: false,
      reason: 'unsupported'
    }
  },
  async steerActiveTurn() {
    return {
      ok: false,
      reason: 'unsupported'
    }
  }
})

export const createSdkCodexClient = (options: CodexClientInitOptions): CodexClient => {
  const sdk = new Codex({
    env: options.env,
    config: options.config
  })

  return {
    mode: 'sdk',
    startThread(threadOptions?: CodexThreadOptions) {
      return asThreadClient(sdk.startThread(threadOptions))
    },
    resumeThread(threadId: string, threadOptions?: CodexThreadOptions) {
      return asThreadClient(sdk.resumeThread(threadId, threadOptions))
    }
  }
}
