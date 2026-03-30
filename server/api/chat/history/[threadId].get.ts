import type { H3Event } from 'h3'
import type {
  CodexChatHistoryResponse,
  CodexItemData,
  CodexSubagentAgentStatus,
  CodexUIDataTypes,
  CodexUIMessage
} from '@@/types/chat-ui'
import { CODEX_ITEM_PART } from '@@/types/chat-ui'
import type { DataUIPart, ReasoningUIPart, TextUIPart } from 'ai'
import { getRun } from 'workflow/api'

const STALE_ACTIVE_RUN_IDLE_MS = 2 * 60 * 1000
const ACTIVE_SUBAGENT_STATUSES = new Set<CodexSubagentAgentStatus | null>([
  null,
  'pendingInit',
  'running'
])

type CodexItemPart = DataUIPart<CodexUIDataTypes> & {
  type: typeof CODEX_ITEM_PART
  data: CodexItemData
}

const isCodexItemPart = (part: unknown): part is CodexItemPart =>
  typeof part === 'object'
  && part !== null
  && 'type' in part
  && part.type === CODEX_ITEM_PART

const isStreamingTextPart = (part: unknown): part is TextUIPart | ReasoningUIPart =>
  typeof part === 'object'
  && part !== null
  && (() => {
    const candidate = part as { type?: unknown, state?: unknown }
    return (candidate.type === 'text' || candidate.type === 'reasoning')
      && candidate.state === 'streaming'
  })()

const hasOpenInFlightOperation = (messages: CodexUIMessage[]): boolean =>
  messages.some(message =>
    (message.parts ?? []).some((part) => {
      if (isStreamingTextPart(part)) {
        return true
      }

      if (!isCodexItemPart(part)) {
        return false
      }

      switch (part.data.kind) {
        case 'command_execution':
        case 'file_change':
        case 'mcp_tool_call':
        case 'subagent_activity':
          return part.data.item.status === 'in_progress'
        case 'subagent_panel':
          return hasOpenInFlightOperation(part.data.item.messages)
        default:
          return false
      }
    })
  )

const hasRepairableStaleState = (messages: CodexUIMessage[]): boolean =>
  messages.some(message =>
    (message.parts ?? []).some((part) => {
      if (isStreamingTextPart(part)) {
        return true
      }

      if (!isCodexItemPart(part)) {
        return false
      }

      switch (part.data.kind) {
        case 'command_execution':
        case 'file_change':
        case 'mcp_tool_call':
        case 'subagent_activity':
          return part.data.item.status === 'in_progress'
        case 'subagent_panel':
          return ACTIVE_SUBAGENT_STATUSES.has(part.data.item.status)
            || hasRepairableStaleState(part.data.item.messages)
        default:
          return false
      }
    })
  )

const finalizeSubagentStatus = (status: CodexSubagentAgentStatus | null) =>
  ACTIVE_SUBAGENT_STATUSES.has(status) ? 'interrupted' : status

const finalizeStaleMessages = (messages: CodexUIMessage[]): CodexUIMessage[] =>
  structuredClone(messages).map(message => ({
    ...message,
    parts: (message.parts ?? []).map((part) => {
      if (isStreamingTextPart(part)) {
        return {
          ...part,
          state: 'done'
        }
      }

      if (!isCodexItemPart(part)) {
        return part
      }

      switch (part.data.kind) {
        case 'command_execution':
          return part.data.item.status === 'in_progress'
            ? {
                ...part,
                data: {
                  ...part.data,
                  item: {
                    ...part.data.item,
                    status: 'failed'
                  }
                }
              }
            : part
        case 'file_change':
          return part.data.item.status === 'in_progress'
            ? {
                ...part,
                data: {
                  ...part.data,
                  item: {
                    ...part.data.item,
                    status: 'failed'
                  }
                }
              }
            : part
        case 'mcp_tool_call':
          return part.data.item.status === 'in_progress'
            ? {
                ...part,
                data: {
                  ...part.data,
                  item: {
                    ...part.data.item,
                    status: 'failed',
                    error: part.data.item.error ?? { message: 'Thread ended before the tool call finished.' }
                  }
                }
              }
            : part
        case 'subagent_activity':
          return {
            ...part,
            data: {
              ...part.data,
              item: {
                ...part.data.item,
                status: part.data.item.status === 'in_progress' ? 'failed' : part.data.item.status,
                agentsStates: part.data.item.agentsStates.map(agentState => ({
                  ...agentState,
                  status: finalizeSubagentStatus(agentState.status)
                }))
              }
            }
          }
        case 'subagent_panel':
          return {
            ...part,
            data: {
              ...part.data,
              item: {
                ...part.data.item,
                status: finalizeSubagentStatus(part.data.item.status),
                messages: finalizeStaleMessages(part.data.item.messages)
              }
            }
          }
        default:
          return part
      }
    })
  }))

const resolveActiveRunId = async (threadId: string, activeRunId: string | null) => {
  if (!activeRunId) {
    return null
  }
  if (activeRunId.trim().length === 0) {
    clearThreadActiveRun(threadId)
    return null
  }

  try {
    const run = getRun(activeRunId)
    const status = await run.status
    if (status === 'running' || status === 'pending') {
      return activeRunId
    }
  } catch {
    // Ignore not-found and runtime errors; stale run IDs are cleaned below.
  }

  clearThreadActiveRun(threadId, activeRunId)
  return null
}

export default defineEventHandler(async (event: H3Event) => {
  const threadId = getRouterParam(event, 'threadId')
  if (!threadId) {
    throw createError({ statusCode: 400, statusMessage: 'Missing thread id.' })
  }

  ensureThreadWorkingDirectory(threadId)
  const activeRunInfo = getThreadActiveRunInfo(threadId)
  let messages = loadThreadMessages(threadId) ?? []
  let activeRunId = await resolveActiveRunId(threadId, activeRunInfo?.runId ?? null)
  const hasExpiredHeartbeat = typeof activeRunInfo?.updatedAt === 'number'
    && Date.now() - activeRunInfo.updatedAt >= STALE_ACTIVE_RUN_IDLE_MS
  const hasVisibleInFlightWork = hasOpenInFlightOperation(messages)

  if (hasRepairableStaleState(messages)) {
    const hasTrackedActiveRun = Boolean(activeRunInfo?.runId)
    const canFinalizeStaleRun = !hasTrackedActiveRun
      || !activeRunId
      || (hasExpiredHeartbeat && !hasVisibleInFlightWork)

    if (canFinalizeStaleRun) {
      messages = finalizeStaleMessages(messages)
      saveThreadMessages(threadId, messages)
      if (activeRunInfo?.runId) {
        clearThreadActiveRun(threadId, activeRunInfo.runId)
      }
      activeRunId = null
    }
  }

  if (activeRunInfo?.runId && activeRunId && hasExpiredHeartbeat && !hasVisibleInFlightWork) {
    clearThreadActiveRun(threadId, activeRunInfo.runId)
    activeRunId = null
  }

  const response: CodexChatHistoryResponse = {
    messages,
    activeRunId
  }

  return response
})
