import type {
  InferUIMessageChunk,
  ReasoningUIPart,
  TextUIPart
} from 'ai'
import { randomUUID } from 'node:crypto'
import type { CodexUIMessage } from '@@/types/codex-ui'

type CodexChunk = InferUIMessageChunk<CodexUIMessage>
type CodexPart = CodexUIMessage['parts'][number]

type BuilderState = {
  parts: CodexPart[]
  textParts: Map<string, TextUIPart>
  reasoningParts: Map<string, ReasoningUIPart>
}

const createState = (): BuilderState => ({
  parts: [],
  textParts: new Map(),
  reasoningParts: new Map()
})

export const createCodexAssistantBuilder = () => {
  const state = createState()

  const startTextPart = (id: string, providerMetadata?: TextUIPart['providerMetadata']) => {
    const part: TextUIPart = {
      type: 'text',
      text: '',
      state: 'streaming',
      providerMetadata
    }

    state.parts.push(part)
    state.textParts.set(id, part)
  }

  const startReasoningPart = (
    id: string,
    providerMetadata?: ReasoningUIPart['providerMetadata']
  ) => {
    const part: ReasoningUIPart = {
      type: 'reasoning',
      text: '',
      state: 'streaming',
      providerMetadata
    }

    state.parts.push(part)
    state.reasoningParts.set(id, part)
  }

  const appendTextDelta = (id: string, delta: string) => {
    const part = state.textParts.get(id)
    if (!part) {
      startTextPart(id)
      const created = state.textParts.get(id)
      if (created) {
        created.text += delta
      }
      return
    }
    part.text += delta
  }

  const appendReasoningDelta = (id: string, delta: string) => {
    const part = state.reasoningParts.get(id)
    if (!part) {
      startReasoningPart(id)
      const created = state.reasoningParts.get(id)
      if (created) {
        created.text += delta
      }
      return
    }
    part.text += delta
  }

  const endTextPart = (id: string) => {
    const part = state.textParts.get(id)
    if (part) {
      part.state = 'done'
      state.textParts.delete(id)
    }
  }

  const endReasoningPart = (id: string) => {
    const part = state.reasoningParts.get(id)
    if (part) {
      part.state = 'done'
      state.reasoningParts.delete(id)
    }
  }

  const pushDataPart = (chunk: Extract<CodexChunk, { type: 'data-codex-event' | 'data-codex-item' }>) => {
    if (chunk.transient) {
      return
    }

    if (chunk.type === 'data-codex-item') {
      const existingIndex = state.parts.findIndex(part => part.type === chunk.type && part.id === chunk.id)
      if (existingIndex !== -1) {
        state.parts[existingIndex] = {
          ...state.parts[existingIndex],
          data: chunk.data
        } as CodexPart
        return
      }
    }

    state.parts.push({
      type: chunk.type,
      id: chunk.id,
      data: chunk.data
    } as CodexPart)
  }

  const apply = (chunk: CodexChunk) => {
    switch (chunk.type) {
      case 'text-start':
        startTextPart(chunk.id, chunk.providerMetadata)
        return
      case 'text-delta':
        appendTextDelta(chunk.id, chunk.delta)
        return
      case 'text-end':
        endTextPart(chunk.id)
        return
      case 'reasoning-start':
        startReasoningPart(chunk.id, chunk.providerMetadata)
        return
      case 'reasoning-delta':
        appendReasoningDelta(chunk.id, chunk.delta)
        return
      case 'reasoning-end':
        endReasoningPart(chunk.id)
        return
      default:
        if (chunk.type === 'data-codex-event' || chunk.type === 'data-codex-item') {
          pushDataPart(chunk)
        }
    }
  }

  const build = (): CodexUIMessage | null => {
    if (state.parts.length === 0) {
      return null
    }

    return {
      id: randomUUID(),
      role: 'assistant',
      parts: state.parts
    }
  }

  return {
    apply,
    build
  }
}
