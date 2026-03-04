import type { WorkflowDetailResponse } from '@@/types/workflow'

export default defineEventHandler((event): WorkflowDetailResponse => {
  const name = getRouterParam(event, 'name')
  if (!name) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing workflow name.'
    })
  }

  const workflow = readWorkflowDefinitionBySlug(name)
  if (!workflow) {
    throw createError({
      statusCode: 404,
      statusMessage: `Workflow not found: ${name}`
    })
  }

  const query = getQuery(event)
  const rawRunsLimit = Number.parseInt(String(query.runsLimit ?? ''), 10)
  const runsLimit = Number.isFinite(rawRunsLimit) ? rawRunsLimit : 200
  const runs = runsLimit > 0
    ? loadWorkflowRunsBySlug(workflow.fileSlug, runsLimit)
    : []

  return {
    workflow,
    runs
  }
})
