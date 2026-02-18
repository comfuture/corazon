import type { McpServerConfig, McpSettingsResponse, McpSettingsUpdateRequest } from '@@/types/settings'

const normalizeMcpServer = (value: unknown): McpServerConfig | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const raw = value as Record<string, unknown>
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name) {
    return null
  }

  const command = typeof raw.command === 'string' && raw.command.trim()
    ? raw.command.trim()
    : undefined
  const url = typeof raw.url === 'string' && raw.url.trim()
    ? raw.url.trim()
    : undefined

  if (!command && !url) {
    return null
  }

  const args = Array.isArray(raw.args)
    ? raw.args.filter((arg): arg is string => typeof arg === 'string' && arg.trim().length > 0)
    : undefined

  const env = (() => {
    if (!raw.env || typeof raw.env !== 'object' || Array.isArray(raw.env)) {
      return undefined
    }
    const pairs = Object.entries(raw.env)
      .filter(([key, envValue]) => key.trim().length > 0 && typeof envValue === 'string')
    if (!pairs.length) {
      return undefined
    }
    return Object.fromEntries(pairs)
  })()

  return {
    name,
    command,
    url,
    args,
    env
  }
}

export default defineEventHandler(async (event): Promise<McpSettingsResponse> => {
  const body = await readBody<McpSettingsUpdateRequest>(event)
  const rawServers = Array.isArray(body?.servers) ? body.servers : null

  if (!rawServers) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid payload: servers must be an array.'
    })
  }

  const normalized = rawServers.map(normalizeMcpServer)
  if (normalized.some(item => item === null)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid MCP server entry.'
    })
  }

  const servers = normalized.filter((item): item is McpServerConfig => item !== null)
  const deduped = new Set<string>()
  for (const server of servers) {
    if (deduped.has(server.name)) {
      throw createError({
        statusCode: 400,
        statusMessage: `Duplicated MCP server name: ${server.name}`
      })
    }
    deduped.add(server.name)
  }

  writeMcpServerConfigs(servers)

  return {
    servers: readMcpServerConfigs()
  }
})
