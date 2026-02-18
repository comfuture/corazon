import type { McpSettingsResponse } from '@@/types/settings'

export default defineEventHandler((): McpSettingsResponse => {
  return {
    servers: readMcpServerConfigs()
  }
})
