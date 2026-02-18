import type { UIMessageChunk } from 'ai'
import type { CodexChatWorkflowInput } from '../../types/codex-ui.ts'
import { getWorkflowMetadata, getWritable } from 'workflow'
import { createCodexChatTurnStream } from '../utils/codex-chat-turn.ts'

export async function codexChatTurnWorkflow(input: CodexChatWorkflowInput) {
  'use workflow'

  const { workflowRunId } = getWorkflowMetadata()
  await streamCodexChatTurn({
    ...input,
    workflowRunId
  })
}

async function streamCodexChatTurn(input: CodexChatWorkflowInput) {
  'use step'

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
