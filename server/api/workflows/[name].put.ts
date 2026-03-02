export default defineEventHandler(async (event) => {
  const name = getRouterParam(event, 'name')
  if (!name) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing workflow name.'
    })
  }

  const existing = readWorkflowDefinitionBySlug(name)
  if (!existing) {
    throw createError({
      statusCode: 404,
      statusMessage: `Workflow not found: ${name}`
    })
  }

  const body = await readBody(event)

  let parsed: ReturnType<typeof parseWorkflowUpsertRequest>
  try {
    parsed = parseWorkflowUpsertRequest(body)
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : 'Invalid request payload.'
    })
  }

  const workflow = writeWorkflowDefinition(existing.fileSlug, parsed.frontmatter, parsed.instruction)
  reloadWorkflowScheduler()

  return { workflow }
})
