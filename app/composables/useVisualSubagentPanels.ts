import type { MaybeRefOrGetter } from 'vue'
import { computed, toValue } from 'vue'
import type { CodexUIMessage } from '@@/types/chat-ui'

type UnknownRecord = Record<string, unknown>

export type VisualSubagentStatus
  = 'pendingInit'
    | 'running'
    | 'interrupted'
    | 'completed'
    | 'errored'
    | 'shutdown'
    | 'notFound'
    | null

export type VisualSubagentPanel = {
  threadId: string
  name: string
  status: VisualSubagentStatus
  messages: CodexUIMessage[]
}

type UnknownMessagePart = {
  type?: string
  [key: string]: unknown
}

const TERMINAL_STATUSES = new Set<Exclude<VisualSubagentStatus, null>>([
  'interrupted',
  'completed',
  'errored',
  'shutdown',
  'notFound'
])

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown) =>
  typeof value === 'string' ? value.trim() : ''

const asStatus = (value: unknown): VisualSubagentStatus => {
  if (value === null) {
    return null
  }
  if (
    value === 'pendingInit'
    || value === 'running'
    || value === 'interrupted'
    || value === 'completed'
    || value === 'errored'
    || value === 'shutdown'
    || value === 'notFound'
  ) {
    return value
  }
  return null
}

const shortThreadId = (value: string) => value.slice(0, 8)

const extractPanelData = (part: unknown) => {
  if (!isRecord(part) || part.type !== 'data-codex-item' || !isRecord(part.data)) {
    return null
  }

  if (part.data.kind !== 'subagent_panel') {
    return null
  }

  const threadId = asString(part.data.threadId)
  if (!threadId) {
    return null
  }

  const rawMessages = Array.isArray(part.data.messages) ? part.data.messages : []
  const messages = rawMessages.filter(isRecord) as unknown as CodexUIMessage[]

  return {
    threadId,
    name: asString(part.data.name),
    status: asStatus(part.data.status),
    messages
  } satisfies VisualSubagentPanel
}

export const useVisualSubagentPanels = (
  messages: MaybeRefOrGetter<ReadonlyArray<CodexUIMessage> | null | undefined>
) => {
  const panels = computed<VisualSubagentPanel[]>(() => {
    const source = toValue(messages) ?? []
    const panelMap = new Map<string, VisualSubagentPanel>()

    for (const message of source) {
      const parts = (message?.parts ?? []) as UnknownMessagePart[]
      for (const part of parts) {
        const panel = extractPanelData(part)
        if (!panel) {
          continue
        }

        if (TERMINAL_STATUSES.has(panel.status as Exclude<VisualSubagentStatus, null>)) {
          panelMap.delete(panel.threadId)
          continue
        }

        panelMap.delete(panel.threadId)
        panelMap.set(panel.threadId, {
          ...panel,
          name: panel.name || shortThreadId(panel.threadId)
        })
      }
    }

    return [...panelMap.values()]
  })

  const hasPanels = computed(() => panels.value.length > 0)

  return {
    panels,
    hasPanels
  }
}
