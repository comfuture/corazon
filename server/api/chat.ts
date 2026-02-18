import type { H3Event } from 'h3'
import { createUIMessageStreamResponse } from 'ai'
import { start } from 'workflow/api'
import type { CodexChatWorkflowInput, CodexUIMessage } from '@@/types/chat-ui'
import { codexChatTurnWorkflow } from '../workflows/chat-turn'

export default defineEventHandler(async (event: H3Event) => {
  const body = await readBody(event)

  const input: CodexChatWorkflowInput = {
    threadId: typeof body?.threadId === 'string' ? body.threadId : null,
    resume: body?.resume === true,
    attachmentUploadId: typeof body?.attachmentUploadId === 'string'
      ? body.attachmentUploadId
      : null,
    skipGitRepoCheck: body?.skipGitRepoCheck === true,
    model: typeof body?.model === 'string' ? body.model : null,
    messages: Array.isArray(body?.messages)
      ? (body.messages as CodexUIMessage[])
      : []
  }

  const run = await start(codexChatTurnWorkflow, [input])

  if (input.threadId) {
    setThreadActiveRun(input.threadId, run.runId)
  }

  return createUIMessageStreamResponse({
    stream: run.readable,
    status: 200,
    headers: {
      'x-workflow-run-id': run.runId
    }
  })
})
