import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parse, stringify } from '@iarna/toml'
import type {
  AgentHomeInfo,
  McpServerConfig,
  TelegramSettings
} from '@@/types/settings'
import { ensureAgentBootstrap } from './agent-bootstrap.ts'
import {
  resolveCorazonRuntimeRootDir,
  resolveCorazonThreadsDir,
  resolveWorkflowLocalDataDir
} from './agent-home.ts'

type JsonObject = Record<string, unknown>
type TomlInput = Parameters<typeof stringify>[0]

const isPlainObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const toStringValue = (value: unknown) => typeof value === 'string' ? value : undefined

const toStringArray = (value: unknown) => {
  if (!Array.isArray(value)) {
    return undefined
  }
  const items = value.filter(item => typeof item === 'string') as string[]
  return items.length > 0 ? items : undefined
}

const toStringRecord = (value: unknown) => {
  if (!isPlainObject(value)) {
    return undefined
  }
  const entries = Object.entries(value).filter(entry =>
    typeof entry[0] === 'string' && typeof entry[1] === 'string'
  ) as Array<[string, string]>
  if (!entries.length) {
    return undefined
  }
  return Object.fromEntries(entries)
}

const getAgentHomeDir = () => ensureAgentBootstrap()

export const getAgentHomeInfo = (): AgentHomeInfo => {
  const agentHome = getAgentHomeDir()
  return {
    agentHome,
    runtimeRoot: resolveCorazonRuntimeRootDir(),
    configPath: join(agentHome, 'config.toml'),
    skillsPath: join(agentHome, 'skills'),
    authPath: join(agentHome, 'auth.json'),
    threadsPath: resolveCorazonThreadsDir(),
    workflowDataPath: resolveWorkflowLocalDataDir()
  }
}

const getConfigPath = () => getAgentHomeInfo().configPath
const DEFAULT_TELEGRAM_IDLE_TIMEOUT_MINUTES = 15

const readConfigRoot = (): JsonObject => {
  const configPath = getConfigPath()
  if (!existsSync(configPath)) {
    return {}
  }
  const raw = readFileSync(configPath, 'utf8')
  if (!raw.trim()) {
    return {}
  }
  const parsed = parse(raw)
  return isPlainObject(parsed) ? parsed : {}
}

const asPositiveInteger = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  const normalized = Math.floor(value)
  if (normalized < 1) {
    return undefined
  }
  return normalized
}

export const readMcpServerConfigs = (): McpServerConfig[] => {
  const configRoot = readConfigRoot()
  const mcpServers = configRoot.mcp_servers
  if (!isPlainObject(mcpServers)) {
    return []
  }

  const items: McpServerConfig[] = []
  for (const [name, value] of Object.entries(mcpServers)) {
    if (!isPlainObject(value)) {
      continue
    }
    const item: McpServerConfig = {
      name
    }
    const command = toStringValue(value.command)
    const args = toStringArray(value.args)
    const env = toStringRecord(value.env)
    const url = toStringValue(value.url)

    if (command) {
      item.command = command
    }
    if (args?.length) {
      item.args = args
    }
    if (env && Object.keys(env).length > 0) {
      item.env = env
    }
    if (url) {
      item.url = url
    }
    items.push(item)
  }

  return items.sort((left, right) => left.name.localeCompare(right.name))
}

export const readTelegramSettings = (): TelegramSettings => {
  const configRoot = readConfigRoot()
  const telegram = configRoot.telegram
  const botToken = isPlainObject(telegram) ? toStringValue(telegram.bot_token)?.trim() ?? '' : ''
  const chatId = isPlainObject(telegram) ? toStringValue(telegram.chat_id)?.trim() ?? '' : ''
  const idleTimeoutMinutes = isPlainObject(telegram)
    ? asPositiveInteger(telegram.idle_timeout_minutes) ?? DEFAULT_TELEGRAM_IDLE_TIMEOUT_MINUTES
    : DEFAULT_TELEGRAM_IDLE_TIMEOUT_MINUTES

  return {
    botToken,
    chatId,
    idleTimeoutMinutes,
    enabled: botToken.length > 0 && chatId.length > 0
  }
}

export const writeMcpServerConfigs = (servers: McpServerConfig[]) => {
  const configPath = getConfigPath()
  const configRoot = readConfigRoot()
  const nextMcpServers: Record<string, JsonObject> = {}

  for (const server of servers) {
    const name = server.name.trim()
    if (!name) {
      continue
    }
    const entry: JsonObject = {}
    if (typeof server.command === 'string' && server.command.trim()) {
      entry.command = server.command.trim()
    }
    if (Array.isArray(server.args) && server.args.length > 0) {
      const args = server.args.filter(arg => typeof arg === 'string' && arg.trim())
      if (args.length > 0) {
        entry.args = args
      }
    }
    if (server.env && typeof server.env === 'object' && Object.keys(server.env).length > 0) {
      const envEntries = Object.entries(server.env).filter(([key, value]) =>
        typeof key === 'string'
        && key.trim().length > 0
        && typeof value === 'string'
      )
      if (envEntries.length > 0) {
        entry.env = Object.fromEntries(envEntries)
      }
    }
    if (typeof server.url === 'string' && server.url.trim()) {
      entry.url = server.url.trim()
    }
    nextMcpServers[name] = entry
  }

  configRoot.mcp_servers = nextMcpServers
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, stringify(configRoot as TomlInput), 'utf8')
}

export const writeTelegramSettings = (settings: {
  botToken?: string
  chatId?: string
  idleTimeoutMinutes?: number
}) => {
  const configPath = getConfigPath()
  const configRoot = readConfigRoot()
  const botToken = typeof settings.botToken === 'string' ? settings.botToken.trim() : ''
  const chatId = typeof settings.chatId === 'string' ? settings.chatId.trim() : ''
  const idleTimeoutMinutes = asPositiveInteger(settings.idleTimeoutMinutes)
    ?? DEFAULT_TELEGRAM_IDLE_TIMEOUT_MINUTES

  configRoot.telegram = {
    bot_token: botToken,
    chat_id: chatId,
    idle_timeout_minutes: idleTimeoutMinutes
  }

  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, stringify(configRoot as TomlInput), 'utf8')
}
