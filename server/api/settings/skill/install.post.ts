import type { SkillInstallRequest, SkillInstallResponse } from '@@/types/settings'

export default defineEventHandler(async (event): Promise<SkillInstallResponse> => {
  const body = await readBody<SkillInstallRequest>(event)
  const source = typeof body?.source === 'string' ? body.source.trim() : ''
  if (!source) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Source is required.'
    })
  }

  try {
    return {
      installed: installSkillsFromSource(source)
    }
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : 'Failed to install skills.'
    })
  }
})
