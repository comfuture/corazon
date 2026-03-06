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
export type CodexThreadOptions = ThreadOptions & {
  developerInstructions?: string | null
}
export type CodexTurnOptions = TurnOptions
export type CodexTurn = RunResult
export type CodexThreadControlResult = {
  ok: boolean
  turnId?: string | null
  queued?: boolean
  reason?: 'unsupported' | 'no_active_turn'
}

export interface CodexThreadClient {
  readonly id: string | null
  readonly mode: CodexClientMode
  run(input: CodexInput, turnOptions?: CodexTurnOptions): Promise<CodexTurn>
  runStreamed(
    input: CodexInput,
    turnOptions?: CodexTurnOptions
  ): Promise<{ events: AsyncGenerator<CodexThreadEvent> }>
  interruptActiveTurn(): Promise<CodexThreadControlResult>
  steerActiveTurn(input: CodexInput): Promise<CodexThreadControlResult>
}

export interface CodexClient {
  readonly mode: CodexClientMode
  startThread(options?: CodexThreadOptions): CodexThreadClient
  resumeThread(id: string, options?: CodexThreadOptions): CodexThreadClient
}

export type CodexClientMode = 'sdk' | 'app-server'

export type CodexClientConfigValue = string
  | number
  | boolean
  | CodexClientConfigValue[]
  | { [key: string]: CodexClientConfigValue }

export type CodexClientInitOptions = {
  env?: Record<string, string>
  config?: { [key: string]: CodexClientConfigValue }
  mode?: CodexClientMode
}
