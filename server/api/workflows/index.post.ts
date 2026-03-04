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

  const requestedSlug = typeof body?.fileSlug === 'string' ? body.fileSlug.trim() : ''
  const derivedSlug = deriveWorkflowFileSlugFromInput({
    requestedFileSlug: requestedSlug,
    workflowName: parsed.frontmatter.name,
    instruction: parsed.instruction
  })
  const fileSlug = resolveUniqueWorkflowFileSlug(derivedSlug)

  const workflow = writeWorkflowDefinition(fileSlug, parsed.frontmatter, parsed.instruction)
  reloadWorkflowScheduler()

  return { workflow }
})
