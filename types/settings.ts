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
  configPath: string
  skillsPath: string
  authPath: string
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
