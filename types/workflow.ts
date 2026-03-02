export type WorkflowTriggerType = 'schedule' | 'interval' | 'workflow-dispatch'

export type WorkflowTriggerConfig = {
  'schedule'?: string
  'interval'?: string
  'workflow-dispatch'?: boolean
}

export type WorkflowFrontmatter = {
  name: string
  description: string
  on: WorkflowTriggerConfig
  skills: string[]
}

export type WorkflowDefinition = {
  fileSlug: string
  filePath: string
  source: string
  frontmatter: WorkflowFrontmatter
  instruction: string
  isValid: boolean
  parseError: string | null
  updatedAt: number
}

export type WorkflowRunStatus = 'running' | 'completed' | 'failed'

export type WorkflowRunSummary = {
  id: string
  workflowName: string
  workflowFileSlug: string
  triggerType: WorkflowTriggerType
  triggerValue: string | null
  status: WorkflowRunStatus
  startedAt: number
  completedAt: number | null
  totalInputTokens: number
  totalCachedInputTokens: number
  totalOutputTokens: number
  sessionThreadId: string | null
  sessionFilePath: string | null
  errorMessage: string | null
}

export type WorkflowRunHistoryMessage = {
  role: 'user' | 'assistant' | 'system'
  text: string
  timestamp: string | null
}

export type WorkflowRunHistoryResponse = {
  run: WorkflowRunSummary | null
  historyUnavailable: boolean
  unavailableReason: string | null
  messages: WorkflowRunHistoryMessage[]
}

export type WorkflowListResponse = {
  workflows: WorkflowDefinition[]
  availableSkills: string[]
}

export type WorkflowDetailResponse = {
  workflow: WorkflowDefinition
  runs: WorkflowRunSummary[]
}

export type WorkflowTriggerGuessResponse = {
  triggerType: 'schedule' | 'interval' | null
  triggerValue: string | null
  confidence: 'high' | 'low' | 'none'
}

export type WorkflowUpsertRequest = {
  name: string
  description: string
  instruction: string
  skills: string[]
  triggerType: 'schedule' | 'interval' | null
  triggerValue: string | null
  workflowDispatch: boolean
}

export type WorkflowEnhanceRequest = {
  text: string
}

export type WorkflowEnhanceResponse = {
  text: string
}
