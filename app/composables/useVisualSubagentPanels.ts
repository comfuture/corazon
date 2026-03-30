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
  firstSeenAt: number
  lastSeenAt: number
  isActive: boolean
}

const ACTIVE_SUBAGENT_STATUSES = new Set<CodexSubagentAgentStatus | null>([
  null,
  'pendingInit',
  'running'
])

export const isVisualSubagentActiveStatus = (
  status: CodexSubagentAgentStatus | null
) => ACTIVE_SUBAGENT_STATUSES.has(status)

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
) => {
  const availablePanels = computed<VisualSubagentPanel[]>(() => {
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
        const existingPanel = panels.get(panel.threadId)
        panels.set(panel.threadId, {
          threadId: panel.threadId,
          name: panel.name,
          status: panel.status,
          messages: panel.messages,
          firstSeenAt: existingPanel?.firstSeenAt ?? messageIndex,
          lastSeenAt: messageIndex,
          isActive: isVisualSubagentActiveStatus(panel.status)
        })
      }
    }

    return [...panels.values()]
      .sort((left, right) => left.firstSeenAt - right.firstSeenAt)
  })

  const activePanels = computed(() =>
    availablePanels.value.filter(panel => panel.isActive)
  )

  return {
    availablePanels,
    activePanels
  }
}
