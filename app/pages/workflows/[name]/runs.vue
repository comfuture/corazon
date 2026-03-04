<script setup lang="ts">
import type {
  WorkflowDetailResponse,
  WorkflowRunHistoryResponse,
  WorkflowRunSummary
} from '@@/types/workflow'

const route = useRoute()

const workflowSlug = computed(() => {
  const raw = route.params.name
  if (Array.isArray(raw)) {
    return raw[0] ?? ''
  }
  return typeof raw === 'string' ? raw : ''
})

const { data, refresh } = await useFetch<WorkflowDetailResponse>(
  () => `/api/workflows/${encodeURIComponent(workflowSlug.value)}`,
  {
    cache: 'no-store'
  }
)

const workflow = computed(() => data.value?.workflow ?? null)
const runs = computed(() => data.value?.runs ?? [])
const runsRefreshSignal = useState<{ slug: string, at: number }>('workflow-runs-refresh-signal', () => ({
  slug: '',
  at: 0
}))

const selectedRunId = ref<string | null>(null)
const historyResponse = ref<WorkflowRunHistoryResponse | null>(null)
const historyPending = ref(false)
const listPanelId = computed(() => `workflow-runs-list-${workflowSlug.value || 'default'}`)
const detailPanelId = computed(() => `workflow-runs-detail-${workflowSlug.value || 'default'}`)
const selectedRun = computed(() => runs.value.find(item => item.id === selectedRunId.value) ?? null)
const hasSelectedRun = computed(() => selectedRunId.value !== null)
const listPanelClass = computed(() => (hasSelectedRun.value ? '!min-h-0' : '!min-h-0 !w-full'))
const listPanelUi = {
  body: '!p-0 !overflow-hidden !gap-0'
}
const AUTO_REFRESH_INTERVAL_MS = 10000
const RUNNING_DETAIL_REFRESH_INTERVAL_MS = 5000
const refreshInFlight = ref(false)
const queuedHistoryRefresh = ref(false)
const autoRefreshTimer = ref<ReturnType<typeof setInterval> | null>(null)
const historyBottomRef = ref<HTMLElement | null>(null)
const shouldRefreshSelectedHistory = computed(() =>
  !!selectedRunId.value
  && (
    selectedRun.value?.status === 'running'
    || historyResponse.value?.historyUnavailable === true
  )
)
const refreshIntervalMs = computed(() =>
  shouldRefreshSelectedHistory.value ? RUNNING_DETAIL_REFRESH_INTERVAL_MS : AUTO_REFRESH_INTERVAL_MS
)

const scrollDetailToBottom = async () => {
  if (!import.meta.client) {
    return
  }

  await nextTick()

  const detailRoot = document.getElementById(detailPanelId.value)
  const detailBody = detailRoot?.querySelector<HTMLElement>('[data-slot="body"]') ?? null
  if (detailBody) {
    detailBody.scrollTop = detailBody.scrollHeight
  }

  historyBottomRef.value?.scrollIntoView({ block: 'end' })
}

watch(runs, (nextRuns) => {
  if (!nextRuns.length) {
    selectedRunId.value = null
    historyResponse.value = null
    return
  }

  if (selectedRunId.value && !nextRuns.some(item => item.id === selectedRunId.value)) {
    selectedRunId.value = null
    historyResponse.value = null
  }
}, { immediate: true })

const loadRunHistory = async (runId: string | null) => {
  if (!runId) {
    historyResponse.value = null
    return
  }

  try {
    historyPending.value = true
    historyResponse.value = await $fetch<WorkflowRunHistoryResponse>(
      `/api/workflows/runs/${encodeURIComponent(runId)}/history`,
      { cache: 'no-store' }
    )
    await scrollDetailToBottom()
  } catch (error) {
    console.error(error)
    historyResponse.value = null
  } finally {
    historyPending.value = false
  }
}

const refreshRunsView = async (options: { refreshHistory?: boolean } = {}) => {
  await refresh()

  if (options.refreshHistory && selectedRunId.value) {
    await loadRunHistory(selectedRunId.value)
  }
}

const requestRunsRefresh = async (refreshHistory: boolean) => {
  if (refreshInFlight.value) {
    queuedHistoryRefresh.value = queuedHistoryRefresh.value || refreshHistory
    return
  }

  refreshInFlight.value = true
  let nextRefreshHistory = refreshHistory

  try {
    do {
      queuedHistoryRefresh.value = false
      await refreshRunsView({ refreshHistory: nextRefreshHistory })
      nextRefreshHistory = queuedHistoryRefresh.value
    } while (nextRefreshHistory)
  } finally {
    refreshInFlight.value = false
  }
}

const restartAutoRefresh = () => {
  if (autoRefreshTimer.value) {
    clearInterval(autoRefreshTimer.value)
    autoRefreshTimer.value = null
  }

  if (!import.meta.client) {
    return
  }

  autoRefreshTimer.value = setInterval(() => {
    if (document.visibilityState !== 'visible') {
      return
    }

    void requestRunsRefresh(shouldRefreshSelectedHistory.value)
  }, refreshIntervalMs.value)
}

watch(selectedRunId, (next) => {
  void loadRunHistory(next)
}, { immediate: true })

watch(() => runsRefreshSignal.value.at, (next, prev) => {
  if (next === prev || next === 0 || runsRefreshSignal.value.slug !== workflowSlug.value) {
    return
  }

  void requestRunsRefresh(selectedRunId.value !== null)
})

watch(refreshIntervalMs, () => {
  restartAutoRefresh()
})

onMounted(() => {
  restartAutoRefresh()
})

onBeforeUnmount(() => {
  if (autoRefreshTimer.value) {
    clearInterval(autoRefreshTimer.value)
    autoRefreshTimer.value = null
  }
})

const runStatusColor = (status: WorkflowRunSummary['status']) => {
  if (status === 'completed') {
    return 'success'
  }
  if (status === 'failed') {
    return 'error'
  }
  return 'warning'
}

const formatDateTime = (timestamp: number | null) => {
  if (!timestamp) {
    return '-'
  }
  return new Date(timestamp).toLocaleString()
}
</script>

<template>
  <div class="flex h-full min-h-0 w-full">
    <UDashboardPanel
      :id="listPanelId"
      :resizable="hasSelectedRun"
      :min-size="40"
      :default-size="46"
      :max-size="72"
      :class="listPanelClass"
      :ui="listPanelUi"
    >
      <template #body>
        <UAlert
          v-if="workflow && !workflow.isValid && workflow.parseError"
          color="error"
          variant="soft"
          class="m-4"
          :title="workflow.parseError"
        />

        <UAlert
          v-if="runs.length === 0"
          color="neutral"
          variant="soft"
          class="m-4"
          title="실행 이력이 없습니다."
        />

        <div
          v-else
          class="h-full overflow-y-auto"
        >
          <UPageList
            divide
          >
            <ULink
              v-for="run in runs"
              :key="run.id"
              raw
              as="button"
              type="button"
              :active="selectedRunId === run.id"
              class="block w-full px-3 py-3 text-left text-foreground transition-colors"
              active-class="bg-primary/10"
              inactive-class="hover:bg-muted/60"
              @click="selectedRunId = run.id"
            >
              <div>
                <div class="flex items-center justify-between gap-2">
                  <UBadge
                    :color="runStatusColor(run.status)"
                    variant="soft"
                  >
                    {{ run.status }}
                  </UBadge>
                  <span class="text-xs text-muted-foreground">
                    {{ formatDateTime(run.startedAt) }}
                  </span>
                </div>
                <p class="mt-2 text-xs text-muted-foreground">
                  {{ run.triggerType }}: {{ run.triggerValue || '-' }}
                </p>
                <p class="mt-1 text-xs text-muted-foreground">
                  in {{ run.totalInputTokens }} (cached {{ run.totalCachedInputTokens }}) · out {{ run.totalOutputTokens }}
                </p>
              </div>
            </ULink>
          </UPageList>
        </div>
      </template>
    </UDashboardPanel>

    <UDashboardPanel
      v-if="hasSelectedRun"
      :id="detailPanelId"
      class="!min-h-0"
    >
      <template #header>
        <div class="flex items-center justify-between px-4 py-3 sm:px-6">
          <h3 class="text-base font-semibold">
            Run Detail
          </h3>
          <UBadge
            v-if="selectedRun"
            :color="runStatusColor(selectedRun.status)"
            variant="soft"
          >
            {{ selectedRun.status }}
          </UBadge>
        </div>
      </template>

      <template #body>
        <div
          v-if="selectedRun"
          class="grid gap-2 rounded-lg border border-default p-3 text-xs text-muted-foreground sm:grid-cols-2"
        >
          <p><span class="font-medium text-foreground">Started</span>: {{ formatDateTime(selectedRun.startedAt) }}</p>
          <p><span class="font-medium text-foreground">Completed</span>: {{ formatDateTime(selectedRun.completedAt) }}</p>
          <p><span class="font-medium text-foreground">Trigger</span>: {{ selectedRun.triggerType }} ({{ selectedRun.triggerValue || '-' }})</p>
          <p><span class="font-medium text-foreground">Tokens</span>: in {{ selectedRun.totalInputTokens }} / out {{ selectedRun.totalOutputTokens }}</p>
        </div>

        <div v-if="historyPending">
          <USkeleton class="h-6 w-full" />
          <USkeleton class="mt-2 h-6 w-full" />
          <USkeleton class="mt-2 h-6 w-2/3" />
        </div>

        <template v-else-if="historyResponse">
          <UAlert
            v-if="historyResponse.historyUnavailable"
            color="warning"
            variant="soft"
            :title="historyResponse.unavailableReason ?? '이력을 표시할 수 없습니다.'"
          />

          <UAlert
            v-else-if="historyResponse.messages.length === 0"
            color="neutral"
            variant="soft"
            title="표시할 메시지가 없습니다."
          />

          <div
            v-else
            class="space-y-2"
          >
            <div
              v-for="(message, index) in historyResponse.messages"
              :key="`${message.role}-${index}`"
              class="rounded-md border border-default p-2"
            >
              <p class="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {{ message.role }}
                <span
                  v-if="message.timestamp"
                  class="normal-case"
                >
                  · {{ new Date(message.timestamp).toLocaleString() }}
                </span>
              </p>
              <p class="whitespace-pre-wrap text-sm">
                {{ message.text }}
              </p>
            </div>
          </div>
        </template>

        <UAlert
          v-else
          color="neutral"
          variant="soft"
          title="이력을 불러오지 못했습니다."
        />
        <div ref="historyBottomRef" />
      </template>
    </UDashboardPanel>
  </div>
</template>
