import type { WorkflowTriggerGuessResponse } from '@@/types/workflow'

const toDailyCron = (hour: number, minute: number) => `${minute} ${hour} * * *`

const to24Hour = (hour: number, meridiem: 'am' | 'pm' | null) => {
  if (meridiem === 'am') {
    return hour === 12 ? 0 : hour
  }
  if (meridiem === 'pm') {
    return hour === 12 ? 12 : hour + 12
  }
  return hour
}

const parseKnownTrigger = (text: string): WorkflowTriggerGuessResponse | null => {
  const normalized = text.trim()
  if (!normalized) {
    return {
      triggerType: null,
      triggerValue: null,
      confidence: 'none'
    }
  }

  const koreanDaily = normalized.match(/매일\s*(오전|오후)?\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분?)?/i)
  if (koreanDaily) {
    const meridiem = koreanDaily[1] === '오전' ? 'am' : koreanDaily[1] === '오후' ? 'pm' : null
    const hour = Number.parseInt(koreanDaily[2] ?? '0', 10)
    const minute = Number.parseInt(koreanDaily[3] ?? '0', 10)
    if (hour >= 0 && hour <= 12 && minute >= 0 && minute <= 59) {
      return {
        triggerType: 'schedule',
        triggerValue: toDailyCron(to24Hour(hour, meridiem), minute),
        confidence: 'high'
      }
    }
  }

  const englishDaily = normalized.match(/every day(?: at)?\s+(\d{1,2})(?::(\d{1,2}))?\s*(am|pm)?/i)
  if (englishDaily) {
    const hour = Number.parseInt(englishDaily[1] ?? '0', 10)
    const minute = Number.parseInt(englishDaily[2] ?? '0', 10)
    const meridiem = (englishDaily[3]?.toLowerCase() as 'am' | 'pm' | undefined) ?? null
    if (hour >= 0 && hour <= 12 && minute >= 0 && minute <= 59) {
      return {
        triggerType: 'schedule',
        triggerValue: toDailyCron(to24Hour(hour, meridiem), minute),
        confidence: 'high'
      }
    }
  }

  if (/매시간/i.test(normalized) || /\bhourly\b/i.test(normalized)) {
    return {
      triggerType: 'interval',
      triggerValue: '1h',
      confidence: 'high'
    }
  }

  const intervalKo = normalized.match(/(\d+)\s*(초|분|시간)\s*(마다|주기|간격)/)
  if (intervalKo) {
    const amount = Number.parseInt(intervalKo[1] ?? '0', 10)
    const unit = intervalKo[2]
    if (amount > 0) {
      return {
        triggerType: 'interval',
        triggerValue: unit === '초' ? `${amount}s` : unit === '분' ? `${amount}m` : `${amount}h`,
        confidence: 'high'
      }
    }
  }

  const intervalEn = normalized.match(/\bevery\s+(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/i)
  if (intervalEn) {
    const amount = Number.parseInt(intervalEn[1] ?? '0', 10)
    const unit = intervalEn[2]?.toLowerCase() ?? ''
    if (amount > 0) {
      const mapped = unit.startsWith('sec') ? 's' : unit.startsWith('min') ? 'm' : 'h'
      return {
        triggerType: 'interval',
        triggerValue: `${amount}${mapped}`,
        confidence: 'high'
      }
    }
  }

  return null
}

export default defineEventHandler(async (event): Promise<WorkflowTriggerGuessResponse> => {
  const body = await readBody(event)
  const text = typeof body?.text === 'string' ? body.text.trim() : ''

  const known = parseKnownTrigger(text)
  if (known) {
    return known
  }

  try {
    const inferred = await inferWorkflowTriggerWithAI(text)
    if (!inferred || inferred.triggerType === 'none') {
      return {
        triggerType: null,
        triggerValue: null,
        confidence: 'none'
      }
    }

    if (inferred.triggerType === 'schedule' && validateCronExpression(inferred.triggerValue)) {
      return {
        triggerType: 'schedule',
        triggerValue: inferred.triggerValue,
        confidence: inferred.confidence
      }
    }

    if (inferred.triggerType === 'interval' && validateIntervalExpression(inferred.triggerValue)) {
      return {
        triggerType: 'interval',
        triggerValue: inferred.triggerValue,
        confidence: inferred.confidence
      }
    }
  } catch {
    // Ignore AI fallback failure and return no trigger.
  }

  return {
    triggerType: null,
    triggerValue: null,
    confidence: 'none'
  }
})

