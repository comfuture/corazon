import {
  createSimpleChatgptCodexInput,
  createJsonSchemaResponseFormat,
  formatChatgptCodexResponsesError,
  runChatgptCodexTextResponse
} from '../../lib/chatgpt-codex-responses.ts'
import { z } from 'zod'
import { createCodexClient } from './codex-client/index.ts'
import type { CodexClient } from './codex-client/types.ts'

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

let codexInstance: CodexClient | null = null
const WORKFLOW_DRAFT_MODEL = 'gpt-5.4-mini'
const WORKFLOW_DRAFT_REASONING_EFFORT = 'low'

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

  codexInstance = createCodexClient({
    env: getCodexEnv(),
    config: {
      show_raw_agent_reasoning: false,
      approval_policy: 'never',
      sandbox_mode: 'danger-full-access'
    }
  })

  return codexInstance
}

const workflowDraftAiResultSchema = z.object({
  suggestedName: z.string(),
  suggestedDescription: z.string(),
  enhancedInstruction: z.string(),
  triggerType: z.enum(['schedule', 'interval', 'rrule', 'none']),
  triggerValue: z.string(),
  confidence: z.enum(['high', 'low']),
  suggestedSkills: z.array(z.string())
})

type WorkflowDraftAiResult = z.infer<typeof workflowDraftAiResultSchema>

const WORKFLOW_DRAFT_RESPONSE_FORMAT = createJsonSchemaResponseFormat(
  'workflow_draft',
  workflowDraftAiResultSchema
)

const normalizeDraftAiResult = (raw: WorkflowDraftAiResult, availableSkills: string[]) => {
  const availableSet = new Set(availableSkills)
  const rawSkills = Array.isArray(raw.suggestedSkills) ? raw.suggestedSkills : []
  const suggestedSkills = rawSkills
    .map(item => item.trim())
    .filter(item => item.length > 0 && availableSet.has(item))

  return {
    suggestedName: raw.suggestedName.trim(),
    suggestedDescription: raw.suggestedDescription.trim(),
    enhancedInstruction: ensureDetailedWorkflowInstruction(raw.enhancedInstruction),
    triggerType: raw.triggerType,
    triggerValue: raw.triggerValue.trim(),
    confidence: raw.confidence,
    suggestedSkills: [...new Set(suggestedSkills)]
  }
}

const parseJsonObjectFromText = <T>(value: string) => {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  const candidates = [
    trimmed,
    trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() ?? ''
  ].filter(Boolean)

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T
    } catch {
      const startIndex = candidate.indexOf('{')
      const endIndex = candidate.lastIndexOf('}')
      if (startIndex === -1 || endIndex <= startIndex) {
        continue
      }
      try {
        return JSON.parse(candidate.slice(startIndex, endIndex + 1)) as T
      } catch {
        continue
      }
    }
  }

  return null
}

export const inferWorkflowDraftWithAI = async (input: {
  text: string
  availableSkills: string[]
}) => {
  const source = input.text.trim()
  if (!source) {
    return null
  }

  const response = await runChatgptCodexTextResponse({
    model: WORKFLOW_DRAFT_MODEL,
    reasoningEffort: WORKFLOW_DRAFT_REASONING_EFFORT,
    textVerbosity: 'low',
    responseFormat: WORKFLOW_DRAFT_RESPONSE_FORMAT,
    instructions: [
      'You generate workflow drafts for a lightweight workflow builder.',
      '',
      '<drafting_principles>',
      '- Keep the draft minimal but complete.',
      '- Include only details that change execution, output, or completion criteria.',
      '- Prefer compact, information-dense wording over repetition or boilerplate.',
      '- Write suggestedDescription and enhancedInstruction in the same language as the user request.',
      '- Do not invent missing recipients, data sources, destinations, or output formats.',
      '- If important specifics are missing, write the most reliable generic execution brief possible without fabricating details.',
      '</drafting_principles>',
      '',
      '<workflow_instruction_rules>',
      '- enhancedInstruction must be the workflow body prompt that directly performs the user intent.',
      '- enhancedInstruction must be detailed enough to execute without re-reading the original request.',
      '- For simple deterministic tasks, use the shortest instruction that still specifies the exact action and output.',
      '- For multi-step or long-horizon tasks, make dependencies, required context/resources, ordered steps, recovery behavior, and completion checks explicit.',
      '- Prefer sections such as <goal>, <context>, <steps>, and <output> when they improve reliability.',
      '- Include only sections and steps that materially change execution.',
      '- When the final deliverable has no fixed language requirement, follow the user\'s prompt language.',
      '- If the workflow needs reusable helper code, a custom executable, or long-lived operating guidance, prefer a supporting skill under `${CODEX_HOME}/skills` created with `skill-creator` instead of ad hoc files.',
      '- Do not direct the workflow to place helper scripts in `${CODEX_HOME}/threads` or in shared directories such as `${CODEX_HOME}/threads/scripts`.',
      '- If a standalone script is still necessary, assume reusable scripts live under `${CODEX_HOME}/scripts` and thread-local scripts live only under a concrete `${CODEX_HOME}/threads/<threadId>/...` directory.',
      '- Do not tell the workflow to create, register, update, save, or manage a workflow.',
      '- Do not mention cadence or schedule inside suggestedDescription or enhancedInstruction.',
      '- If the user request contains cadence or timing language, infer it into trigger fields and remove it completely from enhancedInstruction.',
      '- Avoid invocation boilerplate such as "on each run", "every execution", "at each execution", or direct equivalents in the user\'s language.',
      '- The workflow prompt is read only when invoked, so write only runtime behavior.',
      '</workflow_instruction_rules>',
      '',
      '<field_rules>',
      '- suggestedName must be English only, 2 or 3 words, Title Case.',
      '- suggestedDescription must describe the actual task the workflow performs in one sentence.',
      '- Put all schedule information only in triggerType and triggerValue.',
      '- If no trigger can be inferred, return triggerType="none" and triggerValue="".',
      '- suggestedSkills must contain only exact names from availableSkills.',
      '</field_rules>',
      '',
      '<trigger_rules>',
      '- schedule: 5-field cron (minute hour day month weekday)',
      '- interval: 120s, 60m, or 2h',
      '- rrule: RFC 5545 RRULE without DTSTART',
      '</trigger_rules>',
      '',
      '<example>',
      'User request: Create a workflow that says "Hello" every 2 minutes.',
      'enhancedInstruction: <goal>\n- Output exactly one assistant message: "Hello".\n</goal>\n\n<context>\n- Do not perform any additional work when no extra requirement is provided.\n</context>\n\n<steps>\n1. Prepare the greeting message without extra lookup or narration.\n2. Output exactly one assistant message containing only "Hello".\n3. Do not add any prefix, explanation, code block, or extra line.\n</steps>\n\n<output>\n- Leave the final output as a single line containing only "Hello".\n</output>',
      'suggestedDescription: Outputs one configured greeting line.',
      '</example>'
    ].join('\n'),
    input: createSimpleChatgptCodexInput([
      'availableSkills:',
      ...input.availableSkills.map(skill => `- ${skill}`),
      '',
      `userRequest: ${source}`
    ].join('\n'))
  }).catch((error) => {
    console.error('Failed to infer workflow draft with ChatGPT Codex responses:', formatChatgptCodexResponsesError(error))
    return null
  })

  const output = response?.outputText?.trim() ?? ''
  if (!output) {
    return null
  }

  const candidate = parseJsonObjectFromText<WorkflowDraftAiResult>(output)
  if (!candidate) {
    return null
  }

  const parsed = workflowDraftAiResultSchema.safeParse(candidate)
  if (!parsed.success) {
    return null
  }

  return normalizeDraftAiResult(parsed.data, input.availableSkills)
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
