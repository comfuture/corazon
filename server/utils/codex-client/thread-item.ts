import type { ServerNotification } from '@@/types/codex-app-server/ServerNotification'
import type { ThreadItem as AppServerThreadItem } from '@@/types/codex-app-server/v2/ThreadItem'
import type { CodexThreadItem } from './types.ts'

const normalizeCommandStatus = (status: string): Extract<CodexThreadItem, { type: 'command_execution' }>['status'] => {
  if (status === 'inProgress') {
    return 'in_progress'
  }
  if (status === 'completed') {
    return 'completed'
  }
  return 'failed'
}

const normalizeMcpStatus = (status: string): Extract<CodexThreadItem, { type: 'mcp_tool_call' }>['status'] => {
  if (status === 'inProgress') {
    return 'in_progress'
  }
  if (status === 'completed') {
    return 'completed'
  }
  return 'failed'
}

const normalizeFileChangeStatus = (status: string): Extract<CodexThreadItem, { type: 'file_change' }>['status'] => {
  if (status === 'inProgress') {
    return 'in_progress' as Extract<CodexThreadItem, { type: 'file_change' }>['status']
  }
  if (status === 'completed') {
    return 'completed'
  }
  return 'failed'
}

const normalizePatchChangeKind = (
  kind: unknown
): Extract<CodexThreadItem, { type: 'file_change' }>['changes'][number]['kind'] => {
  if (typeof kind === 'object' && kind && 'type' in kind) {
    const value = (kind as { type?: unknown }).type
    if (value === 'add' || value === 'delete' || value === 'update') {
      return value
    }
  }
  return 'update'
}

const normalizeDynamicStatus = (status: string): Extract<CodexThreadItem, { type: 'command_execution' }>['status'] => {
  if (status === 'inProgress') {
    return 'in_progress'
  }
  if (status === 'completed') {
    return 'completed'
  }
  return 'failed'
}

const normalizeDynamicPatchStatus = (
  status: string,
  success: boolean | null
): Extract<CodexThreadItem, { type: 'file_change' }>['status'] => {
  if (status === 'failed' || success === false) {
    return 'failed'
  }
  return 'completed'
}

const normalizeCollabStatus = (
  status: string
): Extract<CodexThreadItem, { type: 'subagent_activity' }>['status'] => {
  if (status === 'inProgress') {
    return 'in_progress'
  }
  if (status === 'completed') {
    return 'completed'
  }
  return 'failed'
}

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const toSubagentStates = (
  receiverThreadIds: string[],
  agentsStates: Record<string, {
    status: Extract<CodexThreadItem, { type: 'subagent_activity' }>['agentsStates'][number]['status']
    message: string | null
  } | undefined>
): Extract<CodexThreadItem, { type: 'subagent_activity' }>['agentsStates'] => {
  const orderedIds = [
    ...receiverThreadIds,
    ...Object.keys(agentsStates).filter(threadId => !receiverThreadIds.includes(threadId))
  ]

  return orderedIds.map((threadId) => {
    const state = agentsStates[threadId]
    return {
      threadId,
      status: state?.status ?? null,
      message: state?.message ?? null
    }
  })
}

const getStringField = (value: unknown, key: string): string | null => {
  if (!isObjectRecord(value)) {
    return null
  }

  const field = value[key]
  return typeof field === 'string' ? field : null
}

const isExecCommandTool = (tool: string) => {
  const value = tool.trim().toLowerCase()
  return value === 'exec_command' || value === 'command/exec' || value.endsWith('/exec_command')
}

const isApplyPatchTool = (tool: string) => {
  const value = tool.trim().toLowerCase()
  return value === 'apply_patch' || value.endsWith('/apply_patch')
}

const toDynamicContentText = (
  contentItems: Array<{ type: 'inputText', text: string } | { type: 'inputImage', imageUrl: string }> | null
) =>
  (contentItems ?? [])
    .map(item => item.type === 'inputText' ? item.text : `[image] ${item.imageUrl}`)
    .join('\n')
    .trim()

export const toCodexThreadItem = (
  raw: AppServerThreadItem,
  previous?: CodexThreadItem | null
): CodexThreadItem | null => {
  switch (raw.type) {
    case 'agentMessage':
      return {
        id: raw.id,
        type: 'agent_message',
        text: raw.text
      }
    case 'reasoning': {
      const summaryText = raw.summary.join('\n')
      const contentText = raw.content.join('\n')
      const text = [summaryText, contentText].filter(Boolean).join('\n').trim()
      const previousText = previous?.type === 'reasoning' ? previous.text : ''
      return {
        id: raw.id,
        type: 'reasoning',
        text: text || previousText
      }
    }
    case 'commandExecution':
      return {
        id: raw.id,
        type: 'command_execution',
        command: raw.command,
        aggregated_output: raw.aggregatedOutput ?? (previous?.type === 'command_execution' ? previous.aggregated_output : ''),
        exit_code: typeof raw.exitCode === 'number' ? raw.exitCode : undefined,
        status: normalizeCommandStatus(raw.status)
      }
    case 'fileChange':
      return {
        id: raw.id,
        type: 'file_change',
        changes: (raw.changes ?? []).map(change => ({
          path: change.path,
          kind: normalizePatchChangeKind(change.kind),
          diff: typeof change.diff === 'string' ? change.diff : undefined
        })),
        status: normalizeFileChangeStatus(raw.status)
      }
    case 'mcpToolCall':
      return {
        id: raw.id,
        type: 'mcp_tool_call',
        server: raw.server,
        tool: raw.tool,
        arguments: raw.arguments,
        result: raw.result
          ? {
              content: raw.result.content as unknown[],
              structured_content: raw.result.structuredContent
            }
          : undefined,
        error: raw.error ? { message: raw.error.message } : undefined,
        status: normalizeMcpStatus(raw.status)
      }
    case 'dynamicToolCall': {
      if (isExecCommandTool(raw.tool)) {
        return {
          id: raw.id,
          type: 'command_execution',
          command: getStringField(raw.arguments, 'command')
            ?? getStringField(raw.arguments, 'cmd')
            ?? raw.tool,
          aggregated_output: toDynamicContentText(raw.contentItems)
            || (previous?.type === 'command_execution' ? previous.aggregated_output : ''),
          status: normalizeDynamicStatus(raw.status)
        }
      }

      if (isApplyPatchTool(raw.tool)) {
        return {
          id: raw.id,
          type: 'file_change',
          changes: previous?.type === 'file_change' ? previous.changes : [],
          status: normalizeDynamicPatchStatus(raw.status, raw.success)
        }
      }

      return {
        id: raw.id,
        type: 'mcp_tool_call',
        server: 'dynamic',
        tool: raw.tool,
        arguments: raw.arguments,
        result: raw.contentItems
          ? {
              content: [],
              structured_content: {
                success: raw.success,
                contentItems: raw.contentItems
              }
            }
          : undefined,
        error: raw.success === false ? { message: 'Dynamic tool call failed.' } : undefined,
        status: normalizeMcpStatus(raw.status)
      }
    }
    case 'collabAgentToolCall':
      return {
        id: raw.id,
        type: 'subagent_activity',
        action: raw.tool,
        status: normalizeCollabStatus(raw.status),
        senderThreadId: raw.senderThreadId,
        receiverThreadIds: raw.receiverThreadIds,
        prompt: raw.prompt,
        model: raw.model,
        reasoningEffort: raw.reasoningEffort,
        agentsStates: toSubagentStates(raw.receiverThreadIds, raw.agentsStates)
      }
    case 'webSearch':
      return {
        id: raw.id,
        type: 'web_search',
        query: raw.query
      }
    default:
      return null
  }
}

export const appendCodexThreadItemDelta = (
  previous: CodexThreadItem,
  delta: string
): CodexThreadItem => {
  if (previous.type === 'agent_message') {
    return {
      ...previous,
      text: `${previous.text}${delta}`
    }
  }

  if (previous.type === 'reasoning') {
    return {
      ...previous,
      text: `${previous.text}${delta}`
    }
  }

  if (previous.type === 'command_execution') {
    return {
      ...previous,
      aggregated_output: `${previous.aggregated_output}${delta}`
    }
  }

  return previous
}

export const notificationTurnId = (notification: ServerNotification): string | null => {
  const params = notification.params as { turnId?: unknown, turn?: { id?: unknown } } | undefined
  const direct = params?.turnId
  if (typeof direct === 'string') {
    return direct
  }

  const fromTurn = params?.turn?.id
  if (typeof fromTurn === 'string') {
    return fromTurn
  }

  return null
}

export const notificationThreadId = (notification: ServerNotification): string | null => {
  const params = notification.params as { threadId?: unknown } | undefined
  return typeof params?.threadId === 'string' ? params.threadId : null
}
