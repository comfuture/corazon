import { existsSync } from 'node:fs'
import type { WorkflowRunHistoryResponse } from '@@/types/workflow'

export default defineEventHandler((event): WorkflowRunHistoryResponse => {
  const runId = getRouterParam(event, 'runId')
  if (!runId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing run id.'
    })
  }

  const run = getWorkflowRunById(runId)
  if (!run) {
    throw createError({
      statusCode: 404,
      statusMessage: `Run not found: ${runId}`
    })
  }

  if (!run.sessionFilePath) {
    return {
      run,
      historyUnavailable: true,
      unavailableReason: 'No session reference is available for this run.',
      messages: []
    }
  }

  if (!existsSync(run.sessionFilePath)) {
    return {
      run,
      historyUnavailable: true,
      unavailableReason: 'Session file has been deleted. History can no longer be displayed.',
      messages: []
    }
  }

  const messages = loadWorkflowRunMessagesFromSessionFile(run.sessionFilePath) ?? []
  return {
    run,
    historyUnavailable: false,
    unavailableReason: null,
    messages
  }
})

