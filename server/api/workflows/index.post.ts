export default defineEventHandler(async (event) => {
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

  const requestedSlug = typeof body?.fileSlug === 'string' && body.fileSlug.trim()
    ? body.fileSlug.trim()
    : parsed.frontmatter.name
  const fileSlug = resolveUniqueWorkflowFileSlug(requestedSlug)

  const workflow = writeWorkflowDefinition(fileSlug, parsed.frontmatter, parsed.instruction)
  reloadWorkflowScheduler()

  return { workflow }
})

