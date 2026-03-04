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

const DESCRIPTION_MAX_LENGTH = 180
const DESCRIPTION_SCHEDULE_PATTERN = /\b(cron|rrule|interval|daily|weekly|monthly|every\s+\d+\s*(seconds?|minutes?|hours?|days?|weeks?|months?))\b|매(일|주|월|년|시간|분)|[0-9]+\s*(초|분|시간|일|주|개월)\s*마다/gi
const DESCRIPTION_META_PATTERN = /(워크플로우\s*(생성|등록|수정|저장|작성)|create\s+(a\s+)?workflow|generate\s+(a\s+)?workflow)/gi

const sanitizeDescription = (value: string) => value
  .replace(DESCRIPTION_META_PATTERN, '')
  .replace(DESCRIPTION_SCHEDULE_PATTERN, '')
  .replace(/\s+/g, ' ')
  .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
  .trim()

const deriveWorkflowDescriptionFallback = (value: string) => {
  const normalized = sanitizeDescription(value)

  if (!normalized) {
    return '요청된 자동 작업을 수행합니다.'
  }

  return normalized.length > DESCRIPTION_MAX_LENGTH
    ? `${normalized.slice(0, DESCRIPTION_MAX_LENGTH).trim()}...`
    : normalized
}

const normalizeSuggestedDescription = (value: string | null | undefined, fallback: string) => {
  const normalized = sanitizeDescription(value ?? '')

  if (!normalized) {
    return deriveWorkflowDescriptionFallback(fallback)
  }

  return normalized.length > DESCRIPTION_MAX_LENGTH
    ? `${normalized.slice(0, DESCRIPTION_MAX_LENGTH).trim()}...`
    : normalized
}

const normalizeSuggestedSkills = (skills: string[], availableSkills: string[]) => {
  const availableSet = new Set(availableSkills)
  return [...new Set(skills.filter(skill => availableSet.has(skill)))]
}

export default defineEventHandler(async (event): Promise<WorkflowTriggerGuessResponse> => {
  const body = await readBody(event)
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  const availableSkills = listInstalledSkills().map(skill => skill.name)

  let suggestedName = normalizeWorkflowName(text)
  let suggestedDescription = text ? deriveWorkflowDescriptionFallback(text) : null
  let suggestedSkills: string[] = []
  let enhancedText = text

  let triggerType: WorkflowTriggerGuessResponse['triggerType'] = null
  let triggerValue: string | null = null
  let confidence: WorkflowTriggerGuessResponse['confidence'] = 'none'

  if (text) {
    try {
      const inferred = await inferWorkflowDraftWithAI({
        text,
        availableSkills
      })

      if (inferred) {
        suggestedName = normalizeWorkflowName(inferred.suggestedName)
        enhancedText = inferred.enhancedInstruction.trim() || text
        suggestedDescription = normalizeSuggestedDescription(
          inferred.suggestedDescription,
          inferred.enhancedInstruction || text
        )
        suggestedSkills = normalizeSuggestedSkills(inferred.suggestedSkills, availableSkills)

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
    } catch (error) {
      console.error('Failed to infer workflow draft with AI:', error)
    }
  }

  return {
    triggerType,
    triggerValue,
    confidence,
    suggestedName,
    suggestedDescription,
    suggestedSkills,
    enhancedText: enhancedText.trim() || text
  }
})
