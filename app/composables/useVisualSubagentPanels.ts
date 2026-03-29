import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import type { DataUIPart } from 'ai'
import type {
  CodexItemData,
  CodexSubagentAgentStatus,
  CodexUIDataTypes,
  CodexUIMessage
} from '@@/types/chat-ui'
import { CODEX_ITEM_PART } from '@@/types/chat-ui'

export type VisualSubagentPanel = {
  threadId: string
  name: string
  status: CodexSubagentAgentStatus | null
  messages: CodexUIMessage[]
  lastSeenAt: number
}

const ACTIVE_SUBAGENT_STATUSES = new Set<CodexSubagentAgentStatus | null>([
  null,
  'pendingInit',
  'running'
])

const isCodexItemPart = (
  part: unknown
): part is DataUIPart<CodexUIDataTypes> & {
  type: typeof CODEX_ITEM_PART
  data: CodexItemData
} =>
  typeof part === 'object'
  && part !== null
  && 'type' in part
  && part.type === CODEX_ITEM_PART

export const useVisualSubagentPanels = (
  messages: MaybeRefOrGetter<CodexUIMessage[] | null | undefined>
) => computed<VisualSubagentPanel[]>(() => {
  const resolvedMessages = toValue(messages) ?? []
  const panels = new Map<string, VisualSubagentPanel>()

  for (let messageIndex = 0; messageIndex < resolvedMessages.length; messageIndex += 1) {
    const message = resolvedMessages[messageIndex]
    const parts = message?.parts ?? []

    for (const part of parts) {
      if (!isCodexItemPart(part) || part.data.kind !== 'subagent_panel') {
        continue
      }

      const panel = part.data.item
      panels.set(panel.threadId, {
        threadId: panel.threadId,
        name: panel.name,
        status: panel.status,
        messages: panel.messages,
        lastSeenAt: messageIndex
      })
    }
  }

  return [...panels.values()]
    .filter(panel => ACTIVE_SUBAGENT_STATUSES.has(panel.status))
    .sort((left, right) => left.lastSeenAt - right.lastSeenAt)
})
