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

  const runs = loadWorkflowRunsBySlug(workflow.fileSlug, 200)

  return {
    workflow,
    runs
  }
})

