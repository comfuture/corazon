import type { WorkflowRunsPageResponse } from '@@/types/workflow'

export default defineEventHandler((event): WorkflowRunsPageResponse => {
  setHeader(event, 'cache-control', 'no-store')

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
  const rawLimit = Number.parseInt(String(query.limit ?? ''), 10)
  const rawOffset = Number.parseInt(String(query.offset ?? ''), 10)

  const limit = Number.isFinite(rawLimit) ? rawLimit : 50
  const offset = Number.isFinite(rawOffset) ? rawOffset : 0

  return loadWorkflowRunsPageBySlug(workflow.fileSlug, {
    limit,
    offset
  })
})
