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

const { data, pending, refresh } = await useFetch<WorkflowDetailResponse>(
  () => `/api/workflows/${encodeURIComponent(workflowSlug.value)}`,
  {
    cache: 'no-store'
  }
)

const workflow = computed(() => data.value?.workflow ?? null)
const panelTitle = computed(() => workflow.value?.frontmatter.name ?? workflowSlug.value)

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
  <UDashboardPanel id="workflow-detail-panel">
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
            <UButton
              color="neutral"
              variant="outline"
              icon="i-lucide-refresh-cw"
              :loading="pending"
              @click="() => refresh()"
            >
              Refresh
            </UButton>
          </div>
        </template>
      </UDashboardNavbar>

      <UDashboardToolbar>
        <UNavigationMenu
          :items="toolbarItems"
          highlight
          class="flex-1"
        />
      </UDashboardToolbar>
    </template>

    <template #body>
      <NuxtPage />
    </template>
  </UDashboardPanel>
</template>
