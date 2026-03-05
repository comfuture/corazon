import type {
  Input,
  RunResult,
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
  TurnOptions,
  Usage
} from '@openai/codex-sdk'

export type CodexInput = Input
export type CodexThreadEvent = ThreadEvent
export type CodexThreadItem = ThreadItem
export type CodexUsage = Usage
export type CodexThreadOptions = ThreadOptions
export type CodexTurnOptions = TurnOptions
export type CodexTurn = RunResult

export interface CodexThreadClient {
  readonly id: string | null
  run(input: CodexInput, turnOptions?: CodexTurnOptions): Promise<CodexTurn>
  runStreamed(
    input: CodexInput,
    turnOptions?: CodexTurnOptions
  ): Promise<{ events: AsyncGenerator<CodexThreadEvent> }>
}

export interface CodexClient {
  startThread(options?: CodexThreadOptions): CodexThreadClient
  resumeThread(id: string, options?: CodexThreadOptions): CodexThreadClient
}

export type CodexClientMode = 'sdk' | 'app-server'

export type CodexClientConfigValue
  = string
  | number
  | boolean
  | CodexClientConfigValue[]
  | { [key: string]: CodexClientConfigValue }

export type CodexClientInitOptions = {
  env?: Record<string, string>
  config?: { [key: string]: CodexClientConfigValue }
  mode?: CodexClientMode
}
