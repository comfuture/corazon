<script setup lang="ts">
import type { WorkflowDetailResponse } from '@@/types/workflow'
import type { NavigationMenuItem } from '@nuxt/ui'

const route = useRoute()

const workflowSlug = computed(() => {
  const raw = route.params.name
  if (Array.isArray(raw)) {
    return raw[0] ?? ''
  }
  return typeof raw === 'string' ? raw : ''
})

const definitionPath = computed(() => `/workflows/${workflowSlug.value}`)
const runsPath = computed(() => `/workflows/${workflowSlug.value}/runs`)

const { data, refresh } = await useFetch<WorkflowDetailResponse>(
  () => `/api/workflows/${encodeURIComponent(workflowSlug.value)}`,
  {
    query: {
      runsLimit: 0
    },
    cache: 'no-store'
  }
)

const workflow = computed(() => data.value?.workflow ?? null)
const panelTitle = computed(() => workflow.value?.frontmatter.name ?? workflowSlug.value)
const runsRefreshSignal = useState<{ slug: string, at: number }>('workflow-runs-refresh-signal', () => ({
  slug: '',
  at: 0
}))
const isRunsRoute = computed(() => route.path === runsPath.value || route.path.startsWith(`${runsPath.value}/`))
const panelUi = computed(() => (isRunsRoute.value ? { body: '!p-0' } : undefined))

const onToolbarRefresh = () => {
  if (isRunsRoute.value) {
    runsRefreshSignal.value = {
      slug: workflowSlug.value,
      at: Date.now()
    }
    return
  }

  void refresh()
}

const toolbarItems = computed<NavigationMenuItem[][]>(() => [[
  {
    label: 'Definition',
    icon: 'i-lucide-file-text',
    to: definitionPath.value,
    active: route.path === definitionPath.value
  },
  {
    label: 'Runs',
    icon: 'i-lucide-history',
    to: runsPath.value,
    active: route.path === runsPath.value
  }
]])
</script>

<template>
  <UDashboardPanel
    id="workflow-detail-panel"
    :ui="panelUi"
  >
    <template #header>
      <UDashboardNavbar :title="panelTitle">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <div class="flex items-center gap-2">
            <UButton
              color="neutral"
              variant="outline"
              icon="i-lucide-arrow-left"
              to="/workflows"
            >
              Back
            </UButton>
          </div>
        </template>
      </UDashboardNavbar>

      <UDashboardToolbar>
        <div class="flex w-full items-center gap-2">
          <UNavigationMenu
            :items="toolbarItems"
            highlight
            class="min-w-0 flex-1"
          />
          <UButton
            v-if="isRunsRoute"
            color="neutral"
            variant="outline"
            icon="i-lucide-refresh-cw"
            @click="onToolbarRefresh"
          >
            Refresh
          </UButton>
        </div>
      </UDashboardToolbar>
    </template>

    <template #body>
      <NuxtPage />
    </template>
  </UDashboardPanel>
</template>
