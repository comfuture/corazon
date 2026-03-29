import { defineComponent, h, type PropType } from 'vue'
import type { DataUIPart } from 'ai'
import {
  CODEX_ITEM_PART,
  type CodexItemData,
  type CodexUIDataTypes
} from '@@/types/chat-ui'
import CzMessageItemCommandExecution from '../message-item/command-execution.vue'
import CzMessageItemFileChange from '../message-item/file-change.vue'
import CzMessageItemInternalToolCall from '../message-item/internal-tool-call.vue'
import CzMessageItemMcpToolCall from '../message-item/mcp-tool-call.vue'
import CzMessageItemSubagentActivity from '../message-item/subagent-activity.vue'
import CzMessageItemWebSearch from '../message-item/web-search.vue'
import CzMessageItemTodoList from '../message-item/todo-list.vue'
import CzMessageItemError from '../message-item/error.vue'

type MessagePart = {
  type?: string
  [key: string]: unknown
}

const isPartWithType = (part: unknown): part is { type: string } =>
  typeof part === 'object' && part !== null && 'type' in part

const asCodexItemPart = (part: unknown) =>
  isPartWithType(part) && part.type === CODEX_ITEM_PART
    ? (part as DataUIPart<CodexUIDataTypes> & { type: typeof CODEX_ITEM_PART, data: CodexItemData })
    : undefined

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const normalizeDynamicToolName = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .split('/')
    .filter(Boolean)
    .at(-1)
    ?.replace(/[_\-\s]/g, '') ?? ''

const isDynamicToolCall = (item: Extract<CodexItemData, { kind: 'mcp_tool_call' }>['item']) =>
  item.server === 'dynamic' || ['sharedmemory', 'corazonsharedmemory', 'manageworkflow', 'corazonmanageworkflow']
    .includes(normalizeDynamicToolName(item.tool ?? ''))

export default defineComponent({
  name: 'CzMessagePartItem',
  props: {
    part: {
      type: Object as PropType<MessagePart | null>,
      default: null
    }
  },
  setup(props) {
    return () => {
      const itemData = asCodexItemPart(props.part)?.data
      if (!itemData) {
        return null
      }

      const kind = isRecord(itemData) && typeof itemData.kind === 'string'
        ? itemData.kind
        : null

      switch (kind) {
        case 'command_execution':
          return h(CzMessageItemCommandExecution, {
            item: (itemData as Extract<CodexItemData, { kind: 'command_execution' }>).item
          })
        case 'file_change':
          return h(CzMessageItemFileChange, {
            item: (itemData as Extract<CodexItemData, { kind: 'file_change' }>).item
          })
        case 'subagent_activity':
          return h(CzMessageItemSubagentActivity, {
            item: (itemData as Extract<CodexItemData, { kind: 'subagent_activity' }>).item
          })
        case 'subagent_panel':
          return null
        case 'mcp_tool_call':
          if (isDynamicToolCall((itemData as Extract<CodexItemData, { kind: 'mcp_tool_call' }>).item)) {
            return h(CzMessageItemInternalToolCall, {
              item: (itemData as Extract<CodexItemData, { kind: 'mcp_tool_call' }>).item
            })
          }
          return h(CzMessageItemMcpToolCall, {
            item: (itemData as Extract<CodexItemData, { kind: 'mcp_tool_call' }>).item
          })
        case 'web_search':
          return h(CzMessageItemWebSearch, {
            item: (itemData as Extract<CodexItemData, { kind: 'web_search' }>).item
          })
        case 'todo_list':
          return h(CzMessageItemTodoList, {
            item: (itemData as Extract<CodexItemData, { kind: 'todo_list' }>).item
          })
        case 'error':
          return h(CzMessageItemError, {
            item: (itemData as Extract<CodexItemData, { kind: 'error' }>).item
          })
        default:
          return null
      }
    }
  }
})
