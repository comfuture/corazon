<script setup lang="ts">
import type {
  WorkflowDetailResponse,
  WorkflowRunHistoryResponse,
  WorkflowRunsPageResponse,
  WorkflowRunSummary
} from '@@/types/workflow'

const RUNS_PAGE_SIZE = 50
const RUNS_SCROLL_THRESHOLD_PX = 180
const AUTO_REFRESH_INTERVAL_MS = 10000
const RUNNING_DETAIL_REFRESH_INTERVAL_MS = 5000
const MAX_REFRESH_PRESERVE_COUNT = RUNS_PAGE_SIZE * 2

const route = useRoute()

const workflowSlug = computed(() => {
  const raw = route.params.name
  if (Array.isArray(raw)) {
    return raw[0] ?? ''
  }
  return typeof raw === 'string' ? raw : ''
})

const { data, refresh: refreshWorkflow } = await useFetch<WorkflowDetailResponse>(
  () => `/api/workflows/${encodeURIComponent(workflowSlug.value)}`,
  {
    query: {
      runsLimit: 0
    },
    cache: 'no-store'
  }
)

const workflow = computed(() => data.value?.workflow ?? null)
const runs = ref<WorkflowRunSummary[]>([])
const runsPending = ref(false)
const runsLoadingMore = ref(false)
const runsErrorMessage = ref<string | null>(null)
const runsHasMore = ref(false)
const runsNextOffset = ref(0)
const runsListRef = ref<HTMLElement | null>(null)
const runsListRequestToken = ref(0)

const runsRefreshSignal = useState<{ slug: string, at: number }>('workflow-runs-refresh-signal', () => ({
  slug: '',
  at: 0
}))

const selectedRunId = ref<string | null>(null)
const historyResponse = ref<WorkflowRunHistoryResponse | null>(null)
const historyPending = ref(false)
const historyRequestToken = ref(0)
const listPanelId = computed(() => `workflow-runs-list-${workflowSlug.value || 'default'}`)
const detailPanelId = computed(() => `workflow-runs-detail-${workflowSlug.value || 'default'}`)
const selectedRun = computed(() => runs.value.find(item => item.id === selectedRunId.value) ?? null)
const hasSelectedRun = computed(() => selectedRunId.value !== null)
const listPanelClass = computed(() => (hasSelectedRun.value ? '!min-h-0' : '!min-h-0 !w-full'))
const listPanelUi = {
  body: '!p-0 !overflow-hidden !gap-0'
}
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

const toErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message) {
    return error.message
  }
  return fallback
}

const fetchRunsPage = async (slug: string, offset: number) => {
  if (!slug) {
    return {
      runs: [],
      hasMore: false,
      nextOffset: null
    } satisfies WorkflowRunsPageResponse
  }

  return await $fetch<WorkflowRunsPageResponse>(
    `/api/workflows/${encodeURIComponent(slug)}/runs`,
    {
      query: {
        limit: RUNS_PAGE_SIZE,
        offset
      },
      cache: 'no-store'
    }
  )
}

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

const loadRunsList = async (options: { preserveCount?: number } = {}) => {
  const slug = workflowSlug.value
  const requestToken = runsListRequestToken.value + 1
  runsListRequestToken.value = requestToken
  const minimumCount = Math.max(RUNS_PAGE_SIZE, options.preserveCount ?? RUNS_PAGE_SIZE)

  runsPending.value = true

  try {
    let nextOffset = 0
    let hasMore = true
    const loaded: WorkflowRunSummary[] = []

    while (hasMore && loaded.length < minimumCount) {
      const page = await fetchRunsPage(slug, nextOffset)
      if (workflowSlug.value !== slug || runsListRequestToken.value !== requestToken) {
        return
      }

      loaded.push(...page.runs)
      hasMore = page.hasMore
      nextOffset = page.nextOffset ?? loaded.length

      if (page.runs.length === 0) {
        hasMore = false
      }
    }

    if (workflowSlug.value !== slug || runsListRequestToken.value !== requestToken) {
      return
    }

    runs.value = loaded
    runsHasMore.value = hasMore
    runsNextOffset.value = nextOffset
    runsErrorMessage.value = null
  } catch (error) {
    if (workflowSlug.value !== slug || runsListRequestToken.value !== requestToken) {
      return
    }

    runs.value = []
    runsHasMore.value = false
    runsNextOffset.value = 0
    runsErrorMessage.value = toErrorMessage(error, '실행 이력을 불러오지 못했습니다.')
  } finally {
    if (runsListRequestToken.value === requestToken) {
      runsPending.value = false
    }
  }
}

const loadMoreRuns = async () => {
  if (runsPending.value || runsLoadingMore.value || !runsHasMore.value) {
    return
  }

  const slug = workflowSlug.value
  const requestToken = runsListRequestToken.value

  try {
    runsLoadingMore.value = true
    const page = await fetchRunsPage(slug, runsNextOffset.value)
    if (workflowSlug.value !== slug || runsListRequestToken.value !== requestToken) {
      return
    }

    if (page.runs.length > 0) {
      runs.value = [...runs.value, ...page.runs]
    }

    runsHasMore.value = page.hasMore
    runsNextOffset.value = page.nextOffset ?? runs.value.length
    runsErrorMessage.value = null
  } catch (error) {
    runsErrorMessage.value = toErrorMessage(error, '추가 실행 이력을 불러오지 못했습니다.')
  } finally {
    runsLoadingMore.value = false
  }
}

const onRunsListScroll = () => {
  const container = runsListRef.value
  if (!container || runsPending.value || runsLoadingMore.value || !runsHasMore.value) {
    return
  }

  const remaining = container.scrollHeight - container.scrollTop - container.clientHeight
  if (remaining <= RUNS_SCROLL_THRESHOLD_PX) {
    void loadMoreRuns()
  }
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

watch(workflowSlug, () => {
  runsListRequestToken.value += 1

  selectedRunId.value = null
  historyResponse.value = null
  runs.value = []
  runsHasMore.value = false
  runsNextOffset.value = 0
  runsErrorMessage.value = null

  void loadRunsList()
}, { immediate: true })

const loadRunHistory = async (runId: string | null) => {
  const requestToken = historyRequestToken.value + 1
  historyRequestToken.value = requestToken

  if (!runId) {
    historyResponse.value = null
    return
  }

  try {
    historyPending.value = true
    const response = await $fetch<WorkflowRunHistoryResponse>(
      `/api/workflows/runs/${encodeURIComponent(runId)}/history`,
      { cache: 'no-store' }
    )

    if (historyRequestToken.value !== requestToken || selectedRunId.value !== runId) {
      return
    }

    historyResponse.value = response
    await scrollDetailToBottom()
  } catch (error) {
    if (historyRequestToken.value !== requestToken || selectedRunId.value !== runId) {
      return
    }

    console.error(error)
    historyResponse.value = null
  } finally {
    if (historyRequestToken.value === requestToken) {
      historyPending.value = false
    }
  }
}

const refreshRunsView = async (options: { refreshHistory?: boolean } = {}) => {
  const preserveCount = Math.min(
    runs.value.length > 0 ? runs.value.length : RUNS_PAGE_SIZE,
    MAX_REFRESH_PRESERVE_COUNT
  )

  await Promise.all([
    refreshWorkflow(),
    loadRunsList({ preserveCount })
  ])

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

        <div
          ref="runsListRef"
          class="h-full overflow-y-auto"
          @scroll.passive="onRunsListScroll"
        >
          <div
            v-if="runsPending"
            class="space-y-2 p-3"
          >
            <USkeleton class="h-14 w-full" />
            <USkeleton class="h-14 w-full" />
            <USkeleton class="h-14 w-full" />
          </div>

          <template v-else>
            <UAlert
              v-if="runsErrorMessage"
              color="error"
              variant="soft"
              class="m-4"
              :title="runsErrorMessage"
            />

            <UAlert
              v-else-if="runs.length === 0"
              color="neutral"
              variant="soft"
              class="m-4"
              title="실행 이력이 없습니다."
            />

            <template v-else>
              <UPageList divide>
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

              <div
                v-if="runsLoadingMore"
                class="px-3 py-2 text-xs text-muted-foreground"
              >
                실행 이력을 더 불러오는 중...
              </div>

              <div
                v-else-if="runsHasMore"
                class="px-3 py-2"
              >
                <UButton
                  block
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  @click="loadMoreRuns"
                >
                  더 불러오기
                </UButton>
              </div>
            </template>
          </template>
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
