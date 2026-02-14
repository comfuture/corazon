import { defineComponent, h, type PropType } from 'vue'
import {
  CODEX_EVENT_PART,
  CODEX_ITEM_PART
} from '@@/types/codex-ui'
import CzMessagePartText from './message-part/text.vue'
import CzMessagePartFile from './message-part/file.vue'
import CzMessagePartReasoning from './message-part/reasoning.vue'
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
    const partSnapshot = () => (props.part ? { ...props.part } : null)

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
          return h(CzMessagePartReasoning, {
            part: snapshot
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
