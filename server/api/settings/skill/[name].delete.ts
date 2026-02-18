export default defineEventHandler((event) => {
  const name = getRouterParam(event, 'name')
  if (!name) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Skill name is required.'
    })
  }

  try {
    removeInstalledSkill(decodeURIComponent(name))
    return {
      ok: true
    }
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : 'Failed to delete skill.'
    })
  }
})
