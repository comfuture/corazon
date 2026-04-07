export default defineEventHandler(async (event) => {
  const name = getRouterParam(event, 'name')
  if (!name) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing workflow name.'
    })
  }

  const definition = readWorkflowDefinitionBySlug(name)
  if (!definition) {
    throw createError({
      statusCode: 404,
      statusMessage: `Workflow not found: ${name}`
    })
  }
  if (!definition.isValid) {
    throw createError({
      statusCode: 400,
      statusMessage: definition.parseError ?? 'Invalid workflow definition.'
    })
  }
  if (definition.frontmatter.on['workflow-dispatch'] !== true) {
    throw createError({
      statusCode: 400,
      statusMessage: 'This workflow does not allow direct execution.'
    })
  }

  initializeWorkflowRunner()
  let run
  try {
    run = startWorkflowBySlug(definition.fileSlug, 'workflow-dispatch', 'manual')
  } catch (error) {
    if (isUnsupportedWorkflowLanguageError(error)) {
      throw createError({
        statusCode: 400,
        statusMessage: error instanceof Error
          ? error.message
          : 'This workflow language is not executable yet.'
      })
    }
    throw error
  }

  return { run }
})
