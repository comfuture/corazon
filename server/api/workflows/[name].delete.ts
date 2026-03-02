export default defineEventHandler((event) => {
  const name = getRouterParam(event, 'name')
  if (!name) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing workflow name.'
    })
  }

  const deleted = deleteWorkflowDefinitionBySlug(name)
  if (!deleted) {
    throw createError({
      statusCode: 404,
      statusMessage: `Workflow not found: ${name}`
    })
  }

  reloadWorkflowScheduler()

  return {
    deleted: true
  }
})

