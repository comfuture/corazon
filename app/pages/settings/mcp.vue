<script setup lang="ts">
import type { AgentHomeInfo, McpServerConfig, McpSettingsResponse } from '@@/types/settings'

definePageMeta({
  layout: 'settings'
})

type TransportType = 'command' | 'url'

type McpServerForm = {
  name: string
  transport: TransportType
  command: string
  url: string
  argsText: string
  envText: string
}

const toast = useToast()

const { data: agentHome } = await useFetch<AgentHomeInfo>('/api/settings/agent-home')
const { data, pending, refresh } = await useFetch<McpSettingsResponse>('/api/settings/mcp')

const forms = ref<McpServerForm[]>([])
const saving = ref(false)

const transportItems = [
  { label: 'Command', value: 'command' as const },
  { label: 'URL', value: 'url' as const }
]

const formatArgsText = (args: string[] | undefined) => (args ?? []).join('\n')

const formatEnvText = (env: Record<string, string> | undefined) =>
  Object.entries(env ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')

const toForm = (server: McpServerConfig): McpServerForm => ({
  name: server.name,
  transport: server.url ? 'url' : 'command',
  command: server.command ?? '',
  url: server.url ?? '',
  argsText: formatArgsText(server.args),
  envText: formatEnvText(server.env)
})

watch(
  data,
  (value) => {
    forms.value = (value?.servers ?? []).map(toForm)
  },
  { immediate: true }
)

const addServer = () => {
  forms.value.push({
    name: '',
    transport: 'command',
    command: '',
    url: '',
    argsText: '',
    envText: ''
  })
}

const removeServer = (index: number) => {
  forms.value.splice(index, 1)
}

const parseArgsText = (value: string) =>
  value
    .split('\n')
    .map(arg => arg.trim())
    .filter(Boolean)

const parseEnvText = (value: string) => {
  const record: Record<string, string> = {}
  const lines = value.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex <= 0) {
      throw new Error(`Invalid env format: "${trimmed}"`)
    }
    const key = trimmed.slice(0, separatorIndex).trim()
    const envValue = trimmed.slice(separatorIndex + 1).trim()
    if (!key) {
      throw new Error(`Invalid env key: "${trimmed}"`)
    }
    record[key] = envValue
  }
  return record
}

const buildPayload = (): McpServerConfig[] => {
  const payload: McpServerConfig[] = []
  for (const entry of forms.value) {
    const name = entry.name.trim()
    if (!name) {
      throw new Error('Server name is required.')
    }
    const item: McpServerConfig = { name }
    if (entry.transport === 'command') {
      const command = entry.command.trim()
      if (!command) {
        throw new Error(`Command is required for "${name}".`)
      }
      item.command = command
      const args = parseArgsText(entry.argsText)
      if (args.length > 0) {
        item.args = args
      }
      const env = parseEnvText(entry.envText)
      if (Object.keys(env).length > 0) {
        item.env = env
      }
    } else {
      const url = entry.url.trim()
      if (!url) {
        throw new Error(`URL is required for "${name}".`)
      }
      item.url = url
    }
    payload.push(item)
  }
  return payload
}

const saveServers = async () => {
  try {
    saving.value = true
    const servers = buildPayload()
    await $fetch<McpSettingsResponse>('/api/settings/mcp', {
      method: 'PUT',
      body: { servers }
    })
    await refresh()
    toast.add({
      title: 'Saved',
      description: 'MCP settings were updated.',
      color: 'success'
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save MCP settings.'
    toast.add({
      title: 'Save failed',
      description: message,
      color: 'error'
    })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UDashboardPanel id="settings-mcp-panel">
    <template #header>
      <UDashboardNavbar title="MCP">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UContainer class="py-6 sm:py-8">
        <div class="mx-auto flex w-full max-w-4xl flex-col gap-4">
          <UAlert
            color="neutral"
            variant="soft"
            icon="i-lucide-folder-cog"
            title="Config path"
            :description="agentHome?.configPath ?? 'Loading...'"
          />

          <UCard :ui="{ body: 'space-y-4' }">
            <div class="flex items-center justify-between">
              <h2 class="text-base font-semibold">
                MCP Servers
              </h2>
              <div class="flex items-center gap-2">
                <UButton
                  label="Add"
                  icon="i-lucide-plus"
                  color="neutral"
                  variant="outline"
                  @click="addServer"
                />
                <UButton
                  label="Save"
                  icon="i-lucide-save"
                  :loading="saving || pending"
                  @click="saveServers"
                />
              </div>
            </div>

            <div
              v-if="forms.length === 0"
              class="rounded-md border border-dashed border-default p-6 text-center text-sm text-muted-foreground"
            >
              No MCP servers configured.
            </div>

            <div
              v-for="(entry, index) in forms"
              :key="`${entry.name}-${index}`"
              class="space-y-3 rounded-md border border-default p-4"
            >
              <div class="flex items-start gap-3">
                <UInput
                  v-model="entry.name"
                  class="flex-1"
                  placeholder="Server name"
                />
                <USelect
                  v-model="entry.transport"
                  :items="transportItems"
                  class="w-36"
                />
                <UButton
                  icon="i-lucide-trash-2"
                  color="error"
                  variant="ghost"
                  @click="removeServer(index)"
                />
              </div>

              <template v-if="entry.transport === 'command'">
                <UInput
                  v-model="entry.command"
                  placeholder="Command"
                />
                <UTextarea
                  v-model="entry.argsText"
                  :rows="3"
                  placeholder="Args (one per line)"
                />
                <UTextarea
                  v-model="entry.envText"
                  :rows="3"
                  placeholder="Environment (KEY=VALUE per line)"
                />
              </template>

              <UInput
                v-else
                v-model="entry.url"
                placeholder="https://example.com/mcp"
              />
            </div>
          </UCard>
        </div>
      </UContainer>
    </template>
  </UDashboardPanel>
</template>
