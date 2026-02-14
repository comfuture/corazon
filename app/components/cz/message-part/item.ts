import { defineComponent, h, type PropType } from 'vue'
import type { DataUIPart } from 'ai'
import {
  CODEX_ITEM_PART,
  type CodexItemData,
  type CodexUIDataTypes
} from '@@/types/codex-ui'
import CzMessageItemCommandExecution from '../message-item/command-execution.vue'
import CzMessageItemFileChange from '../message-item/file-change.vue'
import CzMessageItemMcpToolCall from '../message-item/mcp-tool-call.vue'
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

      switch (itemData.kind) {
        case 'command_execution':
          return h(CzMessageItemCommandExecution, { item: itemData.item })
        case 'file_change':
          return h(CzMessageItemFileChange, { item: itemData.item })
        case 'mcp_tool_call':
          return h(CzMessageItemMcpToolCall, { item: itemData.item })
        case 'web_search':
          return h(CzMessageItemWebSearch, { item: itemData.item })
        case 'todo_list':
          return h(CzMessageItemTodoList, { item: itemData.item })
        case 'error':
          return h(CzMessageItemError, { item: itemData.item })
        default:
          return null
      }
    }
  }
})
