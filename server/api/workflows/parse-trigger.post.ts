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

  try {
    const inferred = await inferWorkflowTriggerWithAI(text)
    if (!inferred || inferred.triggerType === 'none') {
      return {
        triggerType: null,
        triggerValue: null,
        confidence: 'none',
        suggestedName,
        suggestedSkills
      }
    }

    if (inferred.triggerType === 'schedule' && validateCronExpression(inferred.triggerValue)) {
      return {
        triggerType: 'schedule',
        triggerValue: inferred.triggerValue,
        confidence: inferred.confidence,
        suggestedName,
        suggestedSkills
      }
    }

    if (inferred.triggerType === 'interval' && validateIntervalExpression(inferred.triggerValue)) {
      return {
        triggerType: 'interval',
        triggerValue: inferred.triggerValue,
        confidence: inferred.confidence,
        suggestedName,
        suggestedSkills
      }
    }

    if (inferred.triggerType === 'rrule' && validateRRuleExpression(inferred.triggerValue)) {
      return {
        triggerType: 'rrule',
        triggerValue: inferred.triggerValue,
        confidence: inferred.confidence,
        suggestedName,
        suggestedSkills
      }
    }
  } catch {
    // Ignore AI fallback failure and return no trigger.
  }

  return {
    triggerType: null,
    triggerValue: null,
    confidence: 'none',
    suggestedName,
    suggestedSkills
  }
})
