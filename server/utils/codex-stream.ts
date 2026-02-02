import type { Input, ThreadEvent, ThreadItem, Usage } from '@openai/codex-sdk'
import type { UIMessage, UIMessageStreamWriter } from 'ai'
import {
  CODEX_EVENT_PART,
  CODEX_ITEM_PART,
  type CodexItemData,
  type CodexThreadEventData,
  type CodexUIMessage
} from '@@/types/codex-ui'

type CodexWriter = UIMessageStreamWriter<CodexUIMessage>

type TextKind = 'text' | 'reasoning'

type TextState = {
  buffer: Map<string, string>
  opened: Set<string>
}

const emptyInput: Input = ''

const isNonEmptyText = (value: string | undefined): value is string =>
  value != null && value.trim().length > 0

const isLocalFileUrl = (value: string) => value.startsWith('file://')

const stripFileUrl = (value: string) => value.replace(/^file:\/\//, '')

const asInputText = (value: string) => ({ type: 'text' as const, text: value })

const asInputImage = (value: string) => ({ type: 'local_image' as const, path: value })

type CodexInputPart = ReturnType<typeof asInputText> | ReturnType<typeof asInputImage>

const getLatestUserMessage = (messages: UIMessage[]) => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role === 'user') {
      return message
    }
  }
  return undefined
}

export const buildCodexInput = (messages: UIMessage[]): Input => {
  const latest = getLatestUserMessage(messages)

  if (!latest) {
    return emptyInput
  }

  const parts: CodexInputPart[] = []

  for (const part of latest?.parts ?? []) {
    if (part?.type === 'text') {
      const text = part.text
      if (isNonEmptyText(text)) {
        parts.push(asInputText(text))
      }
      continue
    }

    if (part?.type === 'file') {
      const fileUrl = part.url
      if (typeof fileUrl === 'string' && isLocalFileUrl(fileUrl)) {
        const filePath = stripFileUrl(fileUrl)
        if (part.mediaType?.startsWith('image/')) {
          parts.push(asInputImage(filePath))
        } else {
          const fileLabel = part.filename ? `Attached file: ${part.filename}` : 'Attached file'
          parts.push(asInputText(`${fileLabel}\n${filePath}`))
        }
      }
    }
  }

  if (parts.length === 0) {
    return emptyInput
  }

  const firstPart = parts[0]
  if (firstPart?.type === 'text') {
    return firstPart.text
  }

  return parts
}

const createTextState = (): TextState => ({
  buffer: new Map(),
  opened: new Set()
})

const pushTextDelta = (
  writer: CodexWriter,
  state: TextState,
  kind: TextKind,
  itemId: string,
  nextText: string,
  done: boolean,
  providerMetadata?: Record<string, unknown>
) => {
  const startType = kind === 'text' ? 'text-start' : 'reasoning-start'
  const deltaType = kind === 'text' ? 'text-delta' : 'reasoning-delta'
  const endType = kind === 'text' ? 'text-end' : 'reasoning-end'

  if (!state.opened.has(itemId)) {
    writer.write({ type: startType, id: itemId, providerMetadata })
    state.opened.add(itemId)
  }

  const previous = state.buffer.get(itemId) ?? ''
  const delta = nextText.startsWith(previous) ? nextText.slice(previous.length) : nextText

  if (delta.length > 0) {
    writer.write({ type: deltaType, id: itemId, delta })
  }

  state.buffer.set(itemId, nextText)

  if (done) {
    writer.write({ type: endType, id: itemId })
  }
}

const toThreadEventData = (event: ThreadEvent): CodexThreadEventData | null => {
  switch (event.type) {
    case 'thread.started':
      return { kind: 'thread.started', threadId: event.thread_id }
    case 'turn.started':
      return { kind: 'turn.started' }
    case 'turn.completed':
      return { kind: 'turn.completed', usage: event.usage }
    case 'turn.failed':
      return { kind: 'turn.failed', error: event.error }
    case 'error':
      return { kind: 'stream.error', message: event.message }
    default:
      return null
  }
}

const toItemData = (item: ThreadItem): CodexItemData | null => {
  switch (item.type) {
    case 'command_execution':
      return { kind: 'command_execution', item }
    case 'file_change':
      return { kind: 'file_change', item }
    case 'mcp_tool_call':
      return { kind: 'mcp_tool_call', item }
    case 'web_search':
      return { kind: 'web_search', item }
    case 'todo_list':
      return { kind: 'todo_list', item }
    case 'error':
      return { kind: 'error', item }
    default:
      return null
  }
}

type ThreadEventHandlerOptions = {
  onThreadStarted?: (threadId: string) => void
  onItemCompleted?: (item: ThreadItem) => void
  onTurnCompleted?: (usage: Usage) => void
  buildTurnCompletedData?: (usage: Usage) => CodexThreadEventData
}

const isTransientEvent = (data: CodexThreadEventData) =>
  data.kind === 'thread.started'
  || data.kind === 'turn.started'
  || data.kind === 'turn.completed'

export const createThreadEventHandler = (
  writer: CodexWriter,
  options: ThreadEventHandlerOptions = {}
) => {
  const reasoningState = createTextState()
  const textState = createTextState()
  let eventIndex = 0

  const writeThreadEvent = (data: CodexThreadEventData) => {
    eventIndex += 1
    writer.write({
      type: CODEX_EVENT_PART,
      id: `event-${eventIndex}`,
      data,
      transient: isTransientEvent(data)
    })
  }

  const writeItemData = (data: CodexItemData, itemId: string) => {
    writer.write({
      type: CODEX_ITEM_PART,
      id: itemId,
      data
    })
  }

  return (event: ThreadEvent) => {
    const threadEvent = toThreadEventData(event)
    if (threadEvent) {
      if (threadEvent.kind === 'thread.started') {
        options.onThreadStarted?.(threadEvent.threadId)
      }
      if (threadEvent.kind === 'turn.completed') {
        options.onTurnCompleted?.(threadEvent.usage)
      }
      const resolvedEvent = threadEvent.kind === 'turn.completed' && options.buildTurnCompletedData
        ? options.buildTurnCompletedData(threadEvent.usage)
        : threadEvent
      writeThreadEvent(resolvedEvent)
      return
    }

    if (
      event.type === 'item.started'
      || event.type === 'item.updated'
      || event.type === 'item.completed'
    ) {
      const done = event.type === 'item.completed'
      const item = event.item

      if (done) {
        options.onItemCompleted?.(item)
      }

      if (item.type === 'agent_message') {
        pushTextDelta(writer, textState, 'text', item.id, item.text ?? '', done)
        return
      }

      if (item.type === 'reasoning') {
        pushTextDelta(
          writer,
          reasoningState,
          'reasoning',
          item.id,
          item.text ?? '',
          done,
          { reasoningId: item.id }
        )
        return
      }

      const itemData = toItemData(item)
      if (itemData) {
        writeItemData(itemData, item.id)
      }
    }
  }
}
