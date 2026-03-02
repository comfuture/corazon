import type { WorkflowEnhanceResponse } from '@@/types/workflow'

export default defineEventHandler(async (event): Promise<WorkflowEnhanceResponse> => {
  const body = await readBody(event)
  const text = typeof body?.text === 'string' ? body.text.trim() : ''

  if (!text) {
    throw createError({
      statusCode: 400,
      statusMessage: 'text is required.'
    })
  }

  const enhanced = await enhanceWorkflowInstruction(text)
  return { text: enhanced }
})

