import { defineComponent, h, resolveComponent, type PropType } from 'vue'
import {
  CODEX_EVENT_PART,
  CODEX_ITEM_PART
} from '@@/types/chat-ui'
import CzMessagePartText from './message-part/text.vue'
import CzMessagePartFile from './message-part/file.vue'
import CzMessagePartEvent from './message-part/event.vue'
import CzMessagePartItem from './message-part/item'

type ChatMessageLike = {
  role?: string
}

type MessagePart = {
  type?: string
  [key: string]: unknown
}

export default defineComponent({
  name: 'CzMessagePartRenderer',
  props: {
    message: {
      type: Object as PropType<ChatMessageLike | null>,
      default: null
    },
    part: {
      type: Object as PropType<MessagePart | null>,
      default: null
    }
  },
  setup(props) {
    const chatReasoning = resolveComponent('UChatReasoning')
    const partSnapshot = () => (props.part ? { ...props.part } : null)
    const getReasoningDurationSeconds = (part?: MessagePart | null) => {
      const providerMetadata = part?.providerMetadata
      if (!providerMetadata || typeof providerMetadata !== 'object') {
        return undefined
      }

      const raw = 'thinkingDurationMs' in providerMetadata
        ? (providerMetadata as { thinkingDurationMs?: unknown }).thinkingDurationMs
        : undefined

      if (typeof raw === 'number') {
        return Math.max(1, Math.ceil(raw / 1000))
      }

      if (raw && typeof raw === 'object' && 'value' in raw) {
        const value = (raw as { value?: unknown }).value
        return typeof value === 'number' ? Math.max(1, Math.ceil(value / 1000)) : undefined
      }

      return undefined
    }

    const debugFallback = () => {
      const snapshot = partSnapshot()
      try {
        return JSON.stringify({
          role: props.message?.role,
          type: snapshot?.type,
          part: snapshot
        }, null, 2)
      } catch {
        return String(snapshot)
      }
    }

    return () => {
      const snapshot = partSnapshot()

      switch (snapshot?.type) {
        case 'text':
          return h(CzMessagePartText, {
            role: props.message?.role,
            part: snapshot
          })
        case 'file':
          return h(CzMessagePartFile, {
            part: snapshot
          })
        case 'reasoning':
          return h(chatReasoning, {
            icon: 'i-lucide-brain',
            text: typeof snapshot.text === 'string' ? snapshot.text : '',
            streaming: snapshot.state === 'streaming' && snapshot.ended !== true,
            duration: getReasoningDurationSeconds(snapshot)
          })
        case CODEX_EVENT_PART:
          return h(CzMessagePartEvent, {
            part: snapshot
          })
        case CODEX_ITEM_PART:
          return h(CzMessagePartItem, {
            part: snapshot
          })
        default:
          return h(
            'pre',
            {
              class: 'whitespace-pre-wrap break-all rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning'
            },
            debugFallback()
          )
      }
    }
  }
})
