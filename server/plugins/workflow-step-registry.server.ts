import type { UIMessageChunk } from 'ai'
import type { CodexChatWorkflowInput } from '@@/types/chat-ui'
import { getWritable } from 'workflow'
import { registerStepFunction } from 'workflow/internal/private'

async function streamCodexChatTurnRuntime(input: CodexChatWorkflowInput) {
  const writable = getWritable<UIMessageChunk>()
  const writer = writable.getWriter()
  const stream = createCodexChatTurnStream(input)
  const reader = stream.getReader()
  let hasFinishChunk = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (value?.type === 'finish') {
        hasFinishChunk = true
      }
      await writer.write(value)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await writer.write({
      type: 'error',
      errorText: message
    })
  } finally {
    if (!hasFinishChunk) {
      await writer.write({ type: 'finish' })
    }
    await writer.close()
    reader.releaseLock()
    writer.releaseLock()
  }
}

export default defineNitroPlugin(async () => {
  if (import.meta.prerender) {
    return
  }

  registerStepFunction(
    'step//./server/workflows/chat-turn//streamCodexChatTurn',
    streamCodexChatTurnRuntime
  )
})
