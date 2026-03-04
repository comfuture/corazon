import { Codex } from '@openai/codex-sdk'

type TriggerAiResult = {
  triggerType: 'schedule' | 'interval' | 'rrule' | 'none'
  triggerValue: string
  confidence: 'high' | 'low'
}

type WorkflowNameAiResult = {
  name: string
}

type WorkflowSkillAiResult = {
  skills: string[]
}

type WorkflowDraftAiResult = {
  suggestedName: string
  suggestedDescription: string
  enhancedInstruction: string
  triggerType: 'schedule' | 'interval' | 'rrule' | 'none'
  triggerValue: string
  confidence: 'high' | 'low'
  suggestedSkills: string[]
}

type EnhanceWorkflowInstructionOptions = {
  availableSkills?: string[]
  suggestedSkills?: string[]
  suggestedName?: string | null
  triggerType?: 'schedule' | 'interval' | 'rrule' | null
  triggerValue?: string | null
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

const WORKFLOW_DRAFT_AI_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'suggestedName',
    'suggestedDescription',
    'enhancedInstruction',
    'triggerType',
    'triggerValue',
    'confidence',
    'suggestedSkills'
  ],
  properties: {
    suggestedName: { type: 'string' },
    suggestedDescription: { type: 'string' },
    enhancedInstruction: { type: 'string' },
    triggerType: {
      type: 'string',
      enum: ['schedule', 'interval', 'rrule', 'none']
    },
    triggerValue: { type: 'string' },
    confidence: {
      type: 'string',
      enum: ['high', 'low']
    },
    suggestedSkills: {
      type: 'array',
      items: { type: 'string' }
    }
  }
} as const

const normalizeDraftAiResult = (raw: WorkflowDraftAiResult, availableSkills: string[]) => {
  const availableSet = new Set(availableSkills)
  const rawSkills = Array.isArray(raw.suggestedSkills) ? raw.suggestedSkills : []
  const suggestedSkills = rawSkills
    .map(item => item.trim())
    .filter(item => item.length > 0 && availableSet.has(item))

  return {
    suggestedName: raw.suggestedName.trim(),
    suggestedDescription: raw.suggestedDescription.trim(),
    enhancedInstruction: raw.enhancedInstruction.trim(),
    triggerType: raw.triggerType,
    triggerValue: raw.triggerValue.trim(),
    confidence: raw.confidence,
    suggestedSkills: [...new Set(suggestedSkills)]
  }
}

export const inferWorkflowDraftWithAI = async (input: {
  text: string
  availableSkills: string[]
}) => {
  const source = input.text.trim()
  if (!source) {
    return null
  }

  const prompt = [
    '다음 사용자 요청을 분석해 워크플로 초안을 JSON으로 생성하세요.',
    '- suggestedName: 영문 2~3단어 이름.',
    '- suggestedDescription: 워크플로가 실제로 무엇을 하는지 1문장 요약.',
    '- enhancedInstruction: 각 실행에서 수행할 실제 작업 지시문.',
    '- triggerType/triggerValue/confidence: 실행 주기 추론 결과.',
    '- suggestedSkills: availableSkills 중 필요한 항목만 선택.',
    '',
    '중요 규칙:',
    '- 메타 작업(워크플로우 생성/등록/수정/저장 지시)을 작성하지 마세요.',
    '- 사용자의 실제 의도를 수행하는 실행 지시를 작성하세요.',
    '- 실행 주기/시간표현은 enhancedInstruction/suggestedDescription에 포함하지 마세요.',
    '- 스케줄 정보는 triggerType/triggerValue에만 작성하세요.',
    '',
    'triggerType 규칙:',
    '- schedule: 5-field cron (minute hour day month weekday)',
    '- interval: 120s, 60m, 2h 형식',
    '- rrule: RFC 5545 RRULE (DTSTART 제외)',
    '- 추론 불가 시 triggerType=none, triggerValue=""',
    '',
    '예시:',
    '입력: 2분에 한번 "안녕하세요" 라고 말하는 워크플로우',
    'enhancedInstruction: 각 실행에서 assistant 메시지로 정확히 "안녕하세요" 한 줄만 출력한다.',
    'suggestedDescription: 실행 시마다 지정된 인사 메시지를 한 줄로 출력합니다.',
    '',
    'availableSkills:',
    ...input.availableSkills.map(skill => `- ${skill}`),
    '',
    `userRequest: ${source}`
  ].join('\n')

  const thread = getCodex().startThread({
    model: 'gpt-5.1-codex-mini',
    workingDirectory: process.cwd()
  })

  const result = await thread.run(prompt, {
    outputSchema: WORKFLOW_DRAFT_AI_SCHEMA
  })

  const response = result.finalResponse?.trim() ?? ''
  if (!response) {
    return null
  }

  try {
    const parsed = JSON.parse(response) as WorkflowDraftAiResult
    return normalizeDraftAiResult(parsed, input.availableSkills)
  } catch {
    return null
  }
}

export const enhanceWorkflowInstruction = async (
  text: string,
  options: EnhanceWorkflowInstructionOptions = {}
) => {
  const availableSkills = options.availableSkills ?? []
  const suggestedSkills = options.suggestedSkills ?? []
  const prompt = [
    '다음 워크플로 요청 문장을 "각 실행에서 수행할 작업 지시문"으로 개선하세요.',
    '- 원문 언어를 유지하세요.',
    '- 사용자의 의도를 직접 수행하도록 작성하세요.',
    '- "워크플로우를 생성/등록/수정/저장" 같은 메타 작업 지시는 금지합니다.',
    '- 작업 대상/범위/결과물/완료조건을 더 구체화하세요.',
    '- 실행 주기/시간표현은 지시문에서 제거하세요. 스케줄은 런타임 run_context가 처리합니다.',
    '- 사용 가능한 스킬과 추천 스킬을 참고해 실행 가능한 절차를 구체화하세요.',
    '- 결과는 지시문 본문만 반환하고 설명은 제외하세요.',
    '',
    '예시:',
    '입력: 2분에 한번 "안녕하세요" 라고 말하는 워크플로우',
    '출력: 각 실행에서 assistant 메시지로 정확히 "안녕하세요" 한 줄만 출력한다.',
    '',
    `<suggested-workflow-name>${options.suggestedName ?? ''}</suggested-workflow-name>`,
    `<suggested-trigger-type>${options.triggerType ?? ''}</suggested-trigger-type>`,
    `<suggested-trigger-value>${options.triggerValue ?? ''}</suggested-trigger-value>`,
    '<available-skills>',
    ...availableSkills.map(skill => `- ${skill}`),
    '</available-skills>',
    '<suggested-skills>',
    ...suggestedSkills.map(skill => `- ${skill}`),
    '</suggested-skills>',
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
      enum: ['schedule', 'interval', 'rrule', 'none']
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
    '- If the trigger type is rrule, return an RFC 5545 RRULE string without DTSTART.',
    '- Prefer rrule when the request describes weekly/monthly recurrence in natural language.',
    '- If a trigger cannot be inferred, return triggerType=none.',
    '- Follow this normalization rule: "every day at 6 PM" -> FREQ=DAILY;BYHOUR=18;BYMINUTE=0.',
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
      (parsed.triggerType === 'schedule' || parsed.triggerType === 'interval' || parsed.triggerType === 'rrule' || parsed.triggerType === 'none')
      && typeof parsed.triggerValue === 'string'
      && (parsed.confidence === 'high' || parsed.confidence === 'low')
    ) {
      return parsed
    }
  } catch (error) {
    console.error('Failed to parse AI response for trigger inference:', error, 'Response:', response)
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

const WORKFLOW_SKILL_AI_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['skills'],
  properties: {
    skills: {
      type: 'array',
      items: {
        type: 'string'
      }
    }
  }
} as const

const normalizeSuggestedSkills = (skills: string[], availableSkills: string[]) => {
  const availableMap = new Map(availableSkills.map(skill => [skill.toLowerCase(), skill]))
  const normalized: string[] = []

  for (const rawSkill of skills) {
    const skill = rawSkill.trim()
    if (!skill) {
      continue
    }
    const matched = availableMap.get(skill.toLowerCase())
    if (!matched || normalized.includes(matched)) {
      continue
    }
    normalized.push(matched)
  }

  return normalized
}

const inferSkillsFromDirectMentions = (text: string, availableSkills: string[]) => {
  const normalized = text.toLowerCase()
  return availableSkills.filter(skill => normalized.includes(skill.toLowerCase())).slice(0, 5)
}

export const inferWorkflowSkillsWithAI = async (text: string, availableSkills: string[]) => {
  const source = text.trim()
  if (!source || availableSkills.length === 0) {
    return []
  }

  const directlyMentionedSkills = inferSkillsFromDirectMentions(source, availableSkills)

  const prompt = [
    'Choose helpful Codex skills for the workflow instruction.',
    '- Select zero to five skills from the available skills list.',
    '- Use exact skill names only.',
    '- Prefer precision over recall.',
    '- Return only JSON matching the schema.',
    '',
    `Instruction: ${source}`,
    '',
    'Available skills:',
    ...availableSkills.map(skill => `- ${skill}`)
  ].join('\n')

  const thread = getCodex().startThread({
    model: 'gpt-5.1-codex-mini',
    workingDirectory: process.cwd()
  })

  const result = await thread.run(prompt, {
    outputSchema: WORKFLOW_SKILL_AI_SCHEMA
  })

  const response = result.finalResponse?.trim() ?? ''
  if (!response) {
    return directlyMentionedSkills
  }

  try {
    const parsed = JSON.parse(response) as WorkflowSkillAiResult
    if (!Array.isArray(parsed.skills)) {
      return directlyMentionedSkills
    }
    const aiSkills = normalizeSuggestedSkills(parsed.skills, availableSkills)
    return normalizeSuggestedSkills([...directlyMentionedSkills, ...aiSkills], availableSkills).slice(0, 5)
  } catch {
    return directlyMentionedSkills
  }
}
