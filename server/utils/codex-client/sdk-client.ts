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
  run(input, turnOptions) {
    return value.run(input, turnOptions)
  },
  runStreamed(input, turnOptions) {
    return value.runStreamed(input, turnOptions)
  }
})

export const createSdkCodexClient = (options: CodexClientInitOptions): CodexClient => {
  const sdk = new Codex({
    env: options.env,
    config: options.config
  })

  return {
    startThread(threadOptions?: CodexThreadOptions) {
      return asThreadClient(sdk.startThread(threadOptions))
    },
    resumeThread(threadId: string, threadOptions?: CodexThreadOptions) {
      return asThreadClient(sdk.resumeThread(threadId, threadOptions))
    }
  }
}
