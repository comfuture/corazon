import { Codex } from '@openai/codex-sdk'

type TriggerAiResult = {
  triggerType: 'schedule' | 'interval' | 'none'
  triggerValue: string
  confidence: 'high' | 'low'
}

type WorkflowNameAiResult = {
  name: string
}

let codexInstance: Codex | null = null

const getCodexEnv = () => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value
    }
  }
  env.CODEX_HOME = ensureAgentBootstrap()
  return env
}

const getCodex = () => {
  if (codexInstance) {
    return codexInstance
  }

  codexInstance = new Codex({
    env: getCodexEnv(),
    config: {
      show_raw_agent_reasoning: false,
      approval_policy: 'never',
      sandbox_mode: 'danger-full-access'
    }
  })

  return codexInstance
}

export const enhanceWorkflowInstruction = async (text: string) => {
  const prompt = [
    '다음 워크플로 요청 문장을 에이전트가 실행하기 좋은 지시문으로 개선하세요.',
    '- 원문 언어를 유지하세요.',
    '- 작업 대상/범위/결과물을 더 구체화하세요.',
    '- 결과는 지시문 본문만 반환하고 설명은 제외하세요.',
    '',
    text.trim()
  ].join('\n')

  const thread = getCodex().startThread({
    model: 'gpt-5.1-codex-mini',
    workingDirectory: process.cwd()
  })
  const result = await thread.run(prompt)
  const enhanced = result.finalResponse?.trim() ?? ''
  return enhanced || text.trim()
}

const TRIGGER_AI_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['triggerType', 'triggerValue', 'confidence'],
  properties: {
    triggerType: {
      type: 'string',
      enum: ['schedule', 'interval', 'none']
    },
    triggerValue: {
      type: 'string'
    },
    confidence: {
      type: 'string',
      enum: ['high', 'low']
    }
  }
} as const

export const inferWorkflowTriggerWithAI = async (text: string) => {
  const prompt = [
    'Extract the execution trigger from the text below.',
    '- If the trigger type is schedule, return a 5-field cron expression (minute hour day month weekday).',
    '- If the trigger type is interval, return it in the format 120s, 60m, or 2h.',
    '- If a trigger cannot be inferred, return triggerType=none.',
    '- Follow this normalization rule: "every day at 6 PM" -> 0 18 * * *.',
    '',
    text.trim()
  ].join('\n')

  const thread = getCodex().startThread({
    model: 'gpt-5.1-codex-mini',
    workingDirectory: process.cwd()
  })

  const result = await thread.run(prompt, {
    outputSchema: TRIGGER_AI_SCHEMA
  })

  const response = result.finalResponse?.trim() ?? ''
  if (!response) {
    return null
  }

  try {
    const parsed = JSON.parse(response) as TriggerAiResult
    if (
      (parsed.triggerType === 'schedule' || parsed.triggerType === 'interval' || parsed.triggerType === 'none')
      && typeof parsed.triggerValue === 'string'
      && (parsed.confidence === 'high' || parsed.confidence === 'low')
    ) {
      return parsed
    }
  } catch {
    return null
  }

  return null
}

const WORKFLOW_NAME_AI_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: {
      type: 'string'
    }
  }
} as const

export const inferWorkflowNameWithAI = async (text: string) => {
  const prompt = [
    'Generate a concise workflow name from the instruction.',
    '- Use English only.',
    '- Use exactly 2 or 3 words.',
    '- Use letters (A-Z) and spaces only.',
    '- Use Title Case.',
    '- Return only JSON that matches the schema.',
    '',
    text.trim()
  ].join('\n')

  const thread = getCodex().startThread({
    model: 'gpt-5.1-codex-mini',
    workingDirectory: process.cwd()
  })

  const result = await thread.run(prompt, {
    outputSchema: WORKFLOW_NAME_AI_SCHEMA
  })

  const response = result.finalResponse?.trim() ?? ''
  if (!response) {
    return null
  }

  try {
    const parsed = JSON.parse(response) as WorkflowNameAiResult
    if (typeof parsed.name === 'string') {
      return parsed.name
    }
  } catch {
    return null
  }

  return null
}
