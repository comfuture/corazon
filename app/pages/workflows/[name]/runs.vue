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

const { data, pending, refresh } = await useFetch<WorkflowDetailResponse>(
  () => `/api/workflows/${encodeURIComponent(workflowSlug.value)}`,
  {
    cache: 'no-store'
  }
)

const workflow = computed(() => data.value?.workflow ?? null)
const runs = computed(() => data.value?.runs ?? [])

const selectedRunId = ref<string | null>(null)
const historyResponse = ref<WorkflowRunHistoryResponse | null>(null)
const historyPending = ref(false)

watch(runs, (nextRuns) => {
  if (!nextRuns.length) {
    selectedRunId.value = null
    historyResponse.value = null
    return
  }

  if (!selectedRunId.value || !nextRuns.some(item => item.id === selectedRunId.value)) {
    selectedRunId.value = nextRuns[0]?.id ?? null
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
  } catch (error) {
    console.error(error)
    historyResponse.value = null
  } finally {
    historyPending.value = false
  }
}

watch(selectedRunId, (next) => {
  void loadRunHistory(next)
}, { immediate: true })

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
  <div class="flex h-full w-full flex-col gap-6 p-4 sm:p-6">
    <UAlert
      v-if="workflow && !workflow.isValid && workflow.parseError"
      color="error"
      variant="soft"
      :title="workflow.parseError"
    />

    <div class="flex items-center justify-between">
      <h2 class="text-base font-semibold">
        Run History
      </h2>
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

    <UAlert
      v-if="runs.length === 0"
      color="neutral"
      variant="soft"
      title="실행 이력이 없습니다."
    />

    <div
      v-else
      class="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]"
    >
      <div class="space-y-2">
        <button
          v-for="run in runs"
          :key="run.id"
          type="button"
          class="w-full rounded-md border border-default p-3 text-left transition hover:border-primary/50"
          :class="selectedRunId === run.id ? 'border-primary/70 bg-primary/5' : ''"
          @click="selectedRunId = run.id"
        >
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
        </button>
      </div>

      <div class="space-y-3 rounded-lg border border-default p-3 sm:p-4">
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
          title="실행 이력을 선택해 주세요."
        />
      </div>
    </div>
  </div>
</template>
