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

  let resolvedRun = run
  let sessionFilePath = run.sessionFilePath

  const sessionThreadId = run.sessionThreadId
  const canResolveFromThread = typeof sessionThreadId === 'string' && sessionThreadId.length > 0
  const shouldResolveFromThread = !sessionFilePath || !existsSync(sessionFilePath)
  if (canResolveFromThread && shouldResolveFromThread) {
    const discoveredSessionFilePath = findSessionFileByThreadId(sessionThreadId)
    if (discoveredSessionFilePath) {
      sessionFilePath = discoveredSessionFilePath
      setWorkflowRunSessionReference(run.id, sessionThreadId, discoveredSessionFilePath)
      resolvedRun = {
        ...run,
        sessionFilePath: discoveredSessionFilePath
      }
    }
  }

  if (!sessionFilePath) {
    return {
      run: resolvedRun,
      historyUnavailable: true,
      unavailableReason: run.status === 'running'
        ? 'Session file is not ready yet. History will appear automatically.'
        : 'No session reference is available for this run.',
      messages: []
    }
  }

  if (!existsSync(sessionFilePath)) {
    return {
      run: resolvedRun,
      historyUnavailable: true,
      unavailableReason: 'Session file has been deleted. History can no longer be displayed.',
      messages: []
    }
  }

  const messages = loadWorkflowRunMessagesFromSessionFile(sessionFilePath) ?? []
  return {
    run: resolvedRun,
    historyUnavailable: false,
    unavailableReason: null,
    messages
  }
})
