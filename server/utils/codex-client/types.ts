import type {
  AgentMessageItem,
  CommandExecutionItem,
  ErrorItem,
  Input,
  McpToolCallItem,
  ReasoningItem,
  RunResult,
  ThreadErrorEvent,
  ThreadOptions,
  ThreadStartedEvent,
  TurnOptions,
  TurnCompletedEvent,
  TurnFailedEvent,
  TurnStartedEvent,
  TodoListItem,
  Usage,
  WebSearchItem
} from '@openai/codex-sdk'
import type { CodexFileChangeItem, CodexSubagentActivityItem } from '@@/types/chat-ui'

export type CodexInput = Input
export type CodexThreadItem
  = AgentMessageItem
    | ReasoningItem
    | CommandExecutionItem
    | CodexFileChangeItem
    | CodexSubagentActivityItem
    | McpToolCallItem
    | WebSearchItem
    | TodoListItem
    | ErrorItem
export type CodexThreadEvent
  = ThreadStartedEvent
    | TurnStartedEvent
    | TurnCompletedEvent
    | TurnFailedEvent
    | ThreadErrorEvent
    | { type: 'item.started', item: CodexThreadItem }
    | { type: 'item.updated', item: CodexThreadItem }
    | { type: 'item.completed', item: CodexThreadItem }
export type CodexUsage = Usage
export type CodexThreadOptions = ThreadOptions & {
  developerInstructions?: string | null
}
export type CodexTurnOptions = TurnOptions
export type CodexTurn = Omit<RunResult, 'items'> & {
  items: CodexThreadItem[]
}
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
