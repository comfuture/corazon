import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type {
  DataUIPart,
  ReasoningUIPart,
  TextUIPart,
  UIMessageStreamWriter
} from 'ai'
import {
  CODEX_ITEM_PART,
  type CodexItemData,
  type CodexSubagentAgentStatus,
  type CodexSubagentPanelItem,
  type CodexUIDataTypes,
  type CodexUIMessage
} from '../../types/chat-ui.ts'
import type { ServerNotification } from '../../types/codex-app-server/ServerNotification.ts'
import type { ThreadItem as AppServerThreadItem } from '../../types/codex-app-server/v2/ThreadItem.ts'
import type { ThreadReadResponse } from '../../types/codex-app-server/v2/ThreadReadResponse.ts'
import type { UserInput } from '../../types/codex-app-server/v2/UserInput.ts'
import type { AppServerProtocol } from './codex-client/app-server-protocol.ts'
import type { CodexThreadItem } from './codex-client/types.ts'
import {
  appendCodexThreadItemDelta,
  notificationThreadId,
  notificationTurnId,
  toCodexThreadItem
} from './codex-client/thread-item.ts'

type CodexWriter = UIMessageStreamWriter<CodexUIMessage>
type SubagentTranscriptItemData = Exclude<CodexItemData, { kind: 'subagent_panel' }>
type CodexItemPart = DataUIPart<CodexUIDataTypes> & {
  type: typeof CODEX_ITEM_PART
  data: SubagentTranscriptItemData
}

type SubagentPanelState = {
  threadId: string
  name: string
  status: CodexSubagentAgentStatus | null
  messages: CodexUIMessage[]
  assistantMessageByTurnId: Map<string, CodexUIMessage>
  textPartByItemId: Map<string, TextUIPart>
  reasoningPartByItemId: Map<string, ReasoningUIPart>
  itemPartByItemId: Map<string, CodexItemPart>
  queuedNotifications: ServerNotification[]
  bootstrapped: boolean
  bootstrapPromise: Promise<void> | null
}

const ACTIVE_SUBAGENT_STATUSES = new Set<CodexSubagentAgentStatus | null>([
  null,
  'pendingInit',
  'running'
])

const shortThreadId = (value: string) => value.slice(0, 8)

const resolvePanelName = (
  threadId: string,
  value?: {
    nickname?: string | null
    role?: string | null
    name?: string | null
  }
) => {
  const nickname = value?.nickname?.trim()
  if (nickname) {
    return nickname
  }

  const role = value?.role?.trim()
  if (role) {
    return role
  }

  const name = value?.name?.trim()
  if (name) {
    return name
  }

  return shortThreadId(threadId)
}

const cloneMessages = (messages: CodexUIMessage[]) =>
  structuredClone(messages) as CodexUIMessage[]

const createPanelItemData = (state: SubagentPanelState): CodexItemData => {
  const item: CodexSubagentPanelItem = {
    id: `subagent-panel:${state.threadId}`,
    type: 'subagent_panel',
    threadId: state.threadId,
    name: state.name,
    status: state.status,
    messages: cloneMessages(state.messages)
  }

  return {
    kind: 'subagent_panel',
    item
  }
}

const createSubagentPanelState = (threadId: string): SubagentPanelState => ({
  threadId,
  name: shortThreadId(threadId),
  status: null,
  messages: [],
  assistantMessageByTurnId: new Map(),
  textPartByItemId: new Map(),
  reasoningPartByItemId: new Map(),
  itemPartByItemId: new Map(),
  queuedNotifications: [],
  bootstrapped: false,
  bootstrapPromise: null
})

const inputToMessageParts = (input: UserInput): CodexUIMessage['parts'] => {
  switch (input.type) {
    case 'text':
      return input.text.trim()
        ? [{
            type: 'text',
            text: input.text
          }]
        : []
    case 'image':
      return [{
        type: 'file',
        url: input.url,
        filename: basename(input.url),
        mediaType: 'image/*'
      }]
    case 'localImage':
      return [{
        type: 'file',
        url: `file://${input.path}`,
        filename: basename(input.path),
        mediaType: 'image/*'
      }]
    case 'skill':
      return [{
        type: 'text',
        text: `Skill: ${input.name}\n${input.path}`
      }]
    case 'mention':
      return [{
        type: 'text',
        text: `Mention: ${input.name}\n${input.path}`
      }]
    default:
      return []
  }
}

const appendUserMessageFromInputs = (state: SubagentPanelState, inputs: UserInput[]) => {
  const parts: CodexUIMessage['parts'] = []

  for (const input of inputs) {
    for (const part of inputToMessageParts(input)) {
      parts.push(part)
    }
  }

  if (parts.length === 0) {
    return
  }

  state.messages.push({
    id: `subagent-user-${randomUUID()}`,
    role: 'user',
    parts
  })
}

const ensureAssistantMessage = (state: SubagentPanelState, turnId: string | null) => {
  const key = turnId ?? `unknown:${state.messages.length}`
  const existing = state.assistantMessageByTurnId.get(key)
  if (existing) {
    return existing
  }

  const message: CodexUIMessage = {
    id: `subagent-assistant-${state.threadId}-${key}-${randomUUID()}`,
    role: 'assistant',
    parts: []
  }

  state.assistantMessageByTurnId.set(key, message)
  state.messages.push(message)
  return message
}

const ensureTextPart = (
  state: SubagentPanelState,
  turnId: string | null,
  itemId: string
) => {
  const existing = state.textPartByItemId.get(itemId)
  if (existing) {
    return existing
  }

  const message = ensureAssistantMessage(state, turnId)
  const part: TextUIPart = {
    type: 'text',
    text: '',
    state: 'streaming'
  }
  message.parts.push(part)
  state.textPartByItemId.set(itemId, part)
  return part
}

const ensureReasoningPart = (
  state: SubagentPanelState,
  turnId: string | null,
  itemId: string
) => {
  const existing = state.reasoningPartByItemId.get(itemId)
  if (existing) {
    return existing
  }

  const message = ensureAssistantMessage(state, turnId)
  const part: ReasoningUIPart = {
    type: 'reasoning',
    text: '',
    state: 'streaming',
    providerMetadata: {
      reasoningId: { value: itemId }
    }
  }
  message.parts.push(part)
  state.reasoningPartByItemId.set(itemId, part)
  return part
}

const upsertItemPart = (
  state: SubagentPanelState,
  turnId: string | null,
  item: SubagentTranscriptItemData
) => {
  const itemId = item.item.id
  const existing = state.itemPartByItemId.get(itemId)
  if (existing) {
    existing.data = item
    return
  }

  const message = ensureAssistantMessage(state, turnId)
  const part: CodexItemPart = {
    type: CODEX_ITEM_PART,
    id: itemId,
    data: item
  }
  message.parts.push(part)
  state.itemPartByItemId.set(itemId, part)
}

const setTextPartState = (
  part: TextUIPart,
  nextText: string,
  done: boolean
) => {
  part.text = nextText
  part.state = done ? 'done' : 'streaming'
}

const setReasoningPartState = (
  part: ReasoningUIPart,
  nextText: string,
  done: boolean
) => {
  part.text = nextText
  part.state = done ? 'done' : 'streaming'
}

const applyCommandDelta = (
  state: SubagentPanelState,
  turnId: string | null,
  itemId: string,
  delta: string
) => {
  const existing = state.itemPartByItemId.get(itemId)?.data
  if (existing?.kind === 'command_execution') {
    const next = appendCodexThreadItemDelta(existing.item, delta)
    upsertItemPart(state, turnId, {
      kind: 'command_execution',
      item: next as Extract<CodexItemData, { kind: 'command_execution' }>['item']
    })
    return
  }

  upsertItemPart(state, turnId, {
    kind: 'command_execution',
    item: {
      id: itemId,
      type: 'command_execution',
      command: 'command',
      aggregated_output: delta,
      status: 'in_progress'
    }
  })
}

const applyMcpProgress = (
  state: SubagentPanelState,
  turnId: string | null,
  itemId: string,
  message: string
) => {
  const existing = state.itemPartByItemId.get(itemId)?.data
  if (existing?.kind === 'mcp_tool_call') {
    const structured = typeof existing.item.result?.structured_content === 'object' && existing.item.result?.structured_content
      ? existing.item.result.structured_content as Record<string, unknown>
      : {}
    const progress = Array.isArray(structured.progress) ? structured.progress : []

    upsertItemPart(state, turnId, {
      kind: 'mcp_tool_call',
      item: {
        ...existing.item,
        result: {
          content: [],
          structured_content: {
            ...structured,
            progress: [...progress, message]
          }
        }
      }
    })
    return
  }

  upsertItemPart(state, turnId, {
    kind: 'mcp_tool_call',
    item: {
      id: itemId,
      type: 'mcp_tool_call',
      server: 'mcp',
      tool: 'tool',
      arguments: {},
      status: 'in_progress',
      result: {
        content: [],
        structured_content: {
          progress: [message]
        }
      }
    }
  })
}

const applyErrorItem = (
  state: SubagentPanelState,
  turnId: string | null,
  message: string
) => {
  const normalized = message.trim()
  if (!normalized) {
    return
  }

  upsertItemPart(state, turnId, {
    kind: 'error',
    item: {
      id: `subagent-error-${state.threadId}-${randomUUID()}`,
      type: 'error',
      message: normalized
    }
  })
}

const applyRawThreadItem = (
  state: SubagentPanelState,
  turnId: string | null,
  rawItem: AppServerThreadItem,
  done: boolean
) => {
  if (rawItem.type === 'userMessage') {
    appendUserMessageFromInputs(state, rawItem.content)
    return
  }

  const previous = (state.itemPartByItemId.get(rawItem.id)?.data?.item ?? null) as CodexThreadItem | null
  const normalized = toCodexThreadItem(rawItem, previous)
  if (!normalized) {
    return
  }

  if (normalized.type === 'agent_message') {
    const part = ensureTextPart(state, turnId, normalized.id)
    setTextPartState(part, normalized.text ?? '', done)
    return
  }

  if (normalized.type === 'reasoning') {
    const part = ensureReasoningPart(state, turnId, normalized.id)
    setReasoningPartState(part, normalized.text ?? '', done)
    return
  }

  upsertItemPart(state, turnId, {
    kind: normalized.type,
    item: normalized
  } as SubagentTranscriptItemData)
}

const applySnapshot = (
  state: SubagentPanelState,
  response: ThreadReadResponse
) => {
  state.name = resolvePanelName(state.threadId, {
    nickname: response.thread.agentNickname,
    role: response.thread.agentRole,
    name: response.thread.name
  })

  for (const turn of response.thread.turns) {
    const done = turn.status !== 'inProgress'
    for (const item of turn.items) {
      applyRawThreadItem(state, turn.id, item, done)
    }
  }
}

const emitSubagentPanel = (writer: CodexWriter, state: SubagentPanelState) => {
  const data = createPanelItemData(state)
  writer.write({
    type: CODEX_ITEM_PART,
    id: data.item.id,
    data
  })
}

const isSubagentActiveStatus = (status: CodexSubagentAgentStatus | null) =>
  ACTIVE_SUBAGENT_STATUSES.has(status)

type SubagentPanelManagerOptions = {
  protocol: AppServerProtocol
  writer: CodexWriter
}

export const createSubagentPanelManager = (options: SubagentPanelManagerOptions) => {
  const panels = new Map<string, SubagentPanelState>()
  const orphanNotifications = new Map<string, ServerNotification[]>()
  const knownSubagentThreadIds = new Set<string>()

  const getOrCreatePanel = (threadId: string) => {
    const existing = panels.get(threadId)
    if (existing) {
      return existing
    }

    const created = createSubagentPanelState(threadId)
    const queued = orphanNotifications.get(threadId)
    if (queued?.length) {
      created.queuedNotifications.push(...queued)
      orphanNotifications.delete(threadId)
    }
    panels.set(threadId, created)
    return created
  }

  const bootstrapPanel = async (threadId: string) => {
    const panel = getOrCreatePanel(threadId)
    if (panel.bootstrapped) {
      return
    }
    if (panel.bootstrapPromise) {
      await panel.bootstrapPromise
      return
    }

    panel.bootstrapPromise = (async () => {
      try {
        const response = await options.protocol.request<ThreadReadResponse>('thread/read', {
          threadId,
          includeTurns: true
        })
        applySnapshot(panel, response)
      } catch {
        // A subagent can be announced before the thread is fully readable.
      } finally {
        panel.bootstrapped = true
        panel.bootstrapPromise = null
        const queued = panel.queuedNotifications.splice(0, panel.queuedNotifications.length)
        for (const notification of queued) {
          applyNotification(notification)
        }
        emitSubagentPanel(options.writer, panel)
      }
    })()

    await panel.bootstrapPromise
  }

  const ensureActivePanel = (threadId: string, status: CodexSubagentAgentStatus | null) => {
    const panel = getOrCreatePanel(threadId)
    panel.status = status
    emitSubagentPanel(options.writer, panel)
    void bootstrapPanel(threadId)
  }

  const retirePanel = (threadId: string, status: CodexSubagentAgentStatus | null) => {
    const panel = getOrCreatePanel(threadId)
    panel.status = status
    emitSubagentPanel(options.writer, panel)
  }

  const applyNotification = (notification: ServerNotification) => {
    const threadId = notificationThreadId(notification)
    if (!threadId) {
      return
    }

    const panel = panels.get(threadId)
    if (!panel) {
      if (!knownSubagentThreadIds.has(threadId)) {
        return
      }
      const queued = orphanNotifications.get(threadId) ?? []
      queued.push(notification)
      orphanNotifications.set(threadId, queued)
      return
    }

    if (!panel.bootstrapped) {
      panel.queuedNotifications.push(notification)
      return
    }

    const turnId = notificationTurnId(notification)

    switch (notification.method) {
      case 'item/started':
        if (notification.params.item.type === 'userMessage') {
          return
        }
        applyRawThreadItem(panel, turnId, notification.params.item, false)
        emitSubagentPanel(options.writer, panel)
        return
      case 'item/completed':
        applyRawThreadItem(panel, turnId, notification.params.item, true)
        emitSubagentPanel(options.writer, panel)
        return
      case 'item/agentMessage/delta': {
        const part = ensureTextPart(panel, turnId, notification.params.itemId)
        setTextPartState(part, `${part.text}${notification.params.delta}`, false)
        emitSubagentPanel(options.writer, panel)
        return
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const part = ensureReasoningPart(panel, turnId, notification.params.itemId)
        setReasoningPartState(part, `${part.text}${notification.params.delta}`, false)
        emitSubagentPanel(options.writer, panel)
        return
      }
      case 'item/commandExecution/outputDelta':
        applyCommandDelta(panel, turnId, notification.params.itemId, notification.params.delta)
        emitSubagentPanel(options.writer, panel)
        return
      case 'item/mcpToolCall/progress':
        applyMcpProgress(panel, turnId, notification.params.itemId, notification.params.message)
        emitSubagentPanel(options.writer, panel)
        return
      case 'error':
        applyErrorItem(panel, turnId, notification.params.error.message)
        emitSubagentPanel(options.writer, panel)
        return
      default:
        return
    }
  }

  const observeParentItem = (item: Extract<CodexItemData, { kind: 'subagent_activity' }>['item']) => {
    const stateByThreadId = new Map(
      item.agentsStates.map(entry => [entry.threadId, entry.status] as const)
    )

    for (const threadId of item.receiverThreadIds) {
      knownSubagentThreadIds.add(threadId)
      const status = stateByThreadId.get(threadId) ?? null
      if (isSubagentActiveStatus(status)) {
        ensureActivePanel(threadId, status)
      } else {
        retirePanel(threadId, status)
      }
    }
  }

  const subscribe = () =>
    options.protocol.subscribe((notification) => {
      applyNotification(notification)
    })

  return {
    observeParentItem,
    subscribe
  }
}
