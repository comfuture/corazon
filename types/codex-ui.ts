import type {
  CommandExecutionItem,
  ErrorItem,
  FileChangeItem,
  McpToolCallItem,
  ThreadError,
  TodoListItem,
  Usage,
  WebSearchItem
} from '@openai/codex-sdk'
import type { UIMessage } from 'ai'

export type CodexThreadEventData
  = {
    kind: 'thread.started'
    threadId: string
  }
  | {
    kind: 'turn.started'
  }
  | {
    kind: 'turn.completed'
    usage: Usage
    durationMs?: number
    reasoningDurations?: Record<string, number>
  }
  | {
    kind: 'thread.title'
    threadId: string
    title: string
    updatedAt: number
  }
  | {
    kind: 'turn.failed'
    error: ThreadError
  }
  | {
    kind: 'stream.error'
    message: string
  }

export type CodexItemData
  = {
    kind: 'command_execution'
    item: CommandExecutionItem
  }
  | {
    kind: 'file_change'
    item: FileChangeItem
  }
  | {
    kind: 'mcp_tool_call'
    item: McpToolCallItem
  }
  | {
    kind: 'web_search'
    item: WebSearchItem
  }
  | {
    kind: 'todo_list'
    item: TodoListItem
  }
  | {
    kind: 'error'
    item: ErrorItem
  }

export type CodexUIDataTypes = {
  'codex-event': CodexThreadEventData
  'codex-item': CodexItemData
}

export type CodexUIMessage = UIMessage<unknown, CodexUIDataTypes>

export const CODEX_EVENT_PART = 'data-codex-event' as const
export const CODEX_ITEM_PART = 'data-codex-item' as const
