export type McpServerConfig = {
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
}

export type McpSettingsResponse = {
  servers: McpServerConfig[]
}

export type McpSettingsUpdateRequest = {
  servers: McpServerConfig[]
}

export type AgentHomeInfo = {
  agentHome: string
  runtimeRoot: string
  configPath: string
  skillsPath: string
  authPath: string
  threadsPath: string
  workflowDataPath: string
}

export type TelegramSettings = {
  botToken: string
  chatId: string
  idleTimeoutMinutes: number
  enabled: boolean
}

export type TelegramSettingsResponse = {
  telegram: TelegramSettings
}

export type TelegramChatCandidate = {
  chatId: string
  type: string
  title: string
  subtitle: string | null
  lastMessageText: string | null
  lastMessageAt: number | null
  updateId: number
}

export type TelegramChatDiscoveryResponse = {
  chats: TelegramChatCandidate[]
}

export type TelegramChatDiscoveryRequest = {
  botToken?: string
}

export type TelegramSettingsUpdateRequest = {
  telegram: {
    botToken?: string
    chatId?: string
    idleTimeoutMinutes?: number
  }
}

export type SkillSummary = {
  name: string
  path: string
  hasSkillFile: boolean
  isSystem: boolean
}

export type SkillListResponse = {
  skills: SkillSummary[]
}

export type SkillInstallRequest = {
  source: string
}

export type SkillInstallResponse = {
  installed: SkillSummary[]
}
