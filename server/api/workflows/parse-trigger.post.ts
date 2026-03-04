import type { WorkflowTriggerGuessResponse } from '@@/types/workflow'

const WORKFLOW_NAME_WORD_PATTERN = /^[A-Za-z]+$/
const DEFAULT_WORKFLOW_NAME = 'Task Workflow'

const toTitleCase = (value: string) => {
  if (!value) {
    return value
  }
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase()
}

const normalizeWorkflowName = (value: string | null | undefined) => {
  const words = (value ?? '')
    .replace(/[^A-Za-z\s]/g, ' ')
    .split(/\s+/)
    .map(item => item.trim())
    .filter(item => item.length > 0 && WORKFLOW_NAME_WORD_PATTERN.test(item))

  if (words.length === 0) {
    return DEFAULT_WORKFLOW_NAME
  }

  if (words.length === 1) {
    return `${toTitleCase(words[0] ?? 'Task')} Workflow`
  }

  return words.slice(0, 3).map(toTitleCase).join(' ')
}

const suggestWorkflowName = async (text: string) => {
  const fallback = normalizeWorkflowName(text)
  if (!text.trim()) {
    return fallback
  }

  try {
    const aiName = await inferWorkflowNameWithAI(text)
    return normalizeWorkflowName(aiName)
  } catch {
    return fallback
  }
}

export default defineEventHandler(async (event): Promise<WorkflowTriggerGuessResponse> => {
  const body = await readBody(event)
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  const availableSkills = listInstalledSkills().map(skill => skill.name)
  const [suggestedName, suggestedSkills] = await Promise.all([
    suggestWorkflowName(text),
    inferWorkflowSkillsWithAI(text, availableSkills).catch(() => [])
  ])

  let triggerType: WorkflowTriggerGuessResponse['triggerType'] = null
  let triggerValue: string | null = null
  let confidence: WorkflowTriggerGuessResponse['confidence'] = 'none'

  try {
    const inferred = await inferWorkflowTriggerWithAI(text)
    if (inferred && inferred.triggerType !== 'none') {
      if (inferred.triggerType === 'schedule' && validateCronExpression(inferred.triggerValue)) {
        triggerType = 'schedule'
        triggerValue = inferred.triggerValue
        confidence = inferred.confidence
      } else if (inferred.triggerType === 'interval' && validateIntervalExpression(inferred.triggerValue)) {
        triggerType = 'interval'
        triggerValue = inferred.triggerValue
        confidence = inferred.confidence
      } else if (inferred.triggerType === 'rrule' && validateRRuleExpression(inferred.triggerValue)) {
        triggerType = 'rrule'
        triggerValue = inferred.triggerValue
        confidence = inferred.confidence
      }
    }
  } catch {
    // Ignore AI fallback failure and return no trigger.
  }

  const enhancedText = await enhanceWorkflowInstruction(text, {
    availableSkills,
    suggestedSkills,
    suggestedName,
    triggerType,
    triggerValue
  }).catch(() => text)

  return {
    triggerType,
    triggerValue,
    confidence,
    suggestedName,
    suggestedSkills,
    enhancedText: enhancedText.trim() || text
  }
})
