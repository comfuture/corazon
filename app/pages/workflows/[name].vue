<script setup lang="ts">
import type {
  WorkflowDetailResponse,
  WorkflowListResponse,
  WorkflowRunHistoryResponse,
  WorkflowRunSummary,
  WorkflowUpsertRequest
} from '@@/types/workflow'
import type { RadioGroupItem } from '@nuxt/ui'

type TriggerType = 'schedule' | 'interval'

const toast = useToast()
const route = useRoute()
const router = useRouter()

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

const { data: workflowListData } = await useFetch<WorkflowListResponse>('/api/workflows', {
  cache: 'no-store'
})

const availableSkills = computed(() => workflowListData.value?.availableSkills ?? [])
const workflow = computed(() => data.value?.workflow ?? null)
const runs = computed(() => data.value?.runs ?? [])

const triggerItems: RadioGroupItem[] = [
  {
    value: 'schedule',
    label: '크론',
    description: 'cron 문법으로 실행 시점을 지정합니다.'
  },
  {
    value: 'interval',
    label: '주기적',
    description: '120s, 60m, 2h 형식의 실행 주기입니다.'
  }
]

const form = reactive({
  name: '',
  description: '',
  instruction: '',
  triggerType: 'schedule' as TriggerType,
  triggerValue: '',
  workflowDispatch: false,
  skills: [] as string[]
})

const selectedRunId = ref<string | null>(null)
const historyResponse = ref<WorkflowRunHistoryResponse | null>(null)
const historyPending = ref(false)
const isSaving = ref(false)
const isDeleting = ref(false)
const isRunning = ref(false)

const syncFormFromWorkflow = () => {
  if (!workflow.value) {
    return
  }

  form.name = workflow.value.frontmatter.name
  form.description = workflow.value.frontmatter.description
  form.instruction = workflow.value.instruction
  form.workflowDispatch = workflow.value.frontmatter.on['workflow-dispatch'] === true
  form.skills = [...workflow.value.frontmatter.skills]

  if (workflow.value.frontmatter.on.schedule) {
    form.triggerType = 'schedule'
    form.triggerValue = workflow.value.frontmatter.on.schedule
  } else if (workflow.value.frontmatter.on.interval) {
    form.triggerType = 'interval'
    form.triggerValue = workflow.value.frontmatter.on.interval
  } else {
    form.triggerType = 'schedule'
    form.triggerValue = ''
  }

  if (!selectedRunId.value && runs.value.length > 0) {
    selectedRunId.value = runs.value[0]?.id ?? null
  }
}

watch(workflow, () => {
  syncFormFromWorkflow()
}, { immediate: true })

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

const selectedRun = computed<WorkflowRunSummary | null>(() => {
  if (!selectedRunId.value) {
    return null
  }
  return runs.value.find(item => item.id === selectedRunId.value) ?? null
})

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

const saveWorkflow = async () => {
  const triggerValue = form.triggerValue.trim()
  const hasTrigger = triggerValue.length > 0
  const payload: WorkflowUpsertRequest = {
    name: form.name.trim(),
    description: form.description.trim(),
    instruction: form.instruction.trim(),
    skills: [...new Set(form.skills)],
    triggerType: hasTrigger ? form.triggerType : null,
    triggerValue: hasTrigger ? triggerValue : null,
    workflowDispatch: form.workflowDispatch
  }

  if (!payload.workflowDispatch && payload.triggerType == null) {
    toast.add({
      title: '실행 조건이 필요합니다.',
      description: '크론/주기 또는 직접 실행 중 하나를 설정해 주세요.',
      color: 'warning'
    })
    return
  }

  try {
    isSaving.value = true
    await $fetch(`/api/workflows/${encodeURIComponent(workflowSlug.value)}`, {
      method: 'PUT',
      body: payload
    })
    await refresh()
    toast.add({
      title: '저장 완료',
      color: 'success'
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save workflow.'
    toast.add({
      title: '저장 실패',
      description: message,
      color: 'error'
    })
  } finally {
    isSaving.value = false
  }
}

const runNow = async () => {
  try {
    isRunning.value = true
    await $fetch(`/api/workflows/${encodeURIComponent(workflowSlug.value)}/run`, {
      method: 'POST'
    })
    await refresh()
    toast.add({
      title: '실행 완료',
      color: 'success'
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to run workflow.'
    toast.add({
      title: '실행 실패',
      description: message,
      color: 'error'
    })
  } finally {
    isRunning.value = false
  }
}

const deleteWorkflow = async () => {
  if (!import.meta.client || isDeleting.value) {
    return
  }

  const confirmed = window.confirm('Delete this workflow?')
  if (!confirmed) {
    return
  }

  try {
    isDeleting.value = true
    await $fetch(`/api/workflows/${encodeURIComponent(workflowSlug.value)}`, {
      method: 'DELETE'
    })
    toast.add({
      title: '삭제 완료',
      color: 'success'
    })
    await router.push('/workflows')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete workflow.'
    toast.add({
      title: '삭제 실패',
      description: message,
      color: 'error'
    })
  } finally {
    isDeleting.value = false
  }
}

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
  <UDashboardPanel id="workflow-detail-panel">
    <template #header>
      <UDashboardNavbar :title="workflow?.frontmatter.name ?? workflowSlug">
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
              icon="i-lucide-play"
              :loading="isRunning"
              @click="runNow"
            >
              Run now
            </UButton>
            <UButton
              icon="i-lucide-save"
              :loading="isSaving || pending"
              @click="saveWorkflow"
            >
              Save
            </UButton>
            <UButton
              color="error"
              variant="ghost"
              icon="i-lucide-trash-2"
              :loading="isDeleting"
              @click="deleteWorkflow"
            >
              Delete
            </UButton>
          </div>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UContainer class="py-6 sm:py-8">
        <div class="mx-auto flex w-full max-w-6xl flex-col gap-5">
          <UAlert
            v-if="workflow && !workflow.isValid && workflow.parseError"
            color="error"
            variant="soft"
            :title="workflow.parseError"
          />

          <UCard :ui="{ body: 'space-y-4' }">
            <div class="grid gap-4 md:grid-cols-2">
              <div class="space-y-1">
                <p class="text-xs font-medium text-muted-foreground">
                  name
                </p>
                <UInput
                  v-model="form.name"
                  placeholder="workflow name"
                />
              </div>
              <div class="space-y-1">
                <p class="text-xs font-medium text-muted-foreground">
                  description
                </p>
                <UInput
                  v-model="form.description"
                  placeholder="workflow description"
                />
              </div>
            </div>

            <URadioGroup
              v-model="form.triggerType"
              legend="trigger type"
              :items="triggerItems"
              variant="card"
            />

            <UInput
              v-model="form.triggerValue"
              :placeholder="form.triggerType === 'schedule' ? '0 18 * * *' : '2h'"
              :icon="form.triggerType === 'schedule' ? 'i-lucide-calendar-clock' : 'i-lucide-repeat'"
            />

            <USwitch
              v-model="form.workflowDispatch"
              label="workflow-dispatch 허용"
            />

            <UCheckboxGroup
              v-model="form.skills"
              legend="skills"
              :items="availableSkills"
              variant="list"
            />

            <UTextarea
              v-model="form.instruction"
              :rows="12"
              autoresize
              :maxrows="20"
              placeholder="워크플로 지시문"
            />
          </UCard>

          <UCard :ui="{ body: 'space-y-4' }">
            <div class="flex items-center justify-between">
              <h2 class="text-base font-semibold">
                Run History
              </h2>
              <UButton
                color="neutral"
                variant="outline"
                icon="i-lucide-refresh-cw"
                :loading="pending"
                @click="refresh"
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

            <div class="grid gap-4 lg:grid-cols-2">
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

              <UCard :ui="{ body: 'space-y-3' }">
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
              </UCard>
            </div>
          </UCard>
        </div>
      </UContainer>
    </template>
  </UDashboardPanel>
</template>
