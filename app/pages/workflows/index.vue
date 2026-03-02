<script setup lang="ts">
import type {
  WorkflowDefinition,
  WorkflowEnhanceResponse,
  WorkflowListResponse,
  WorkflowTriggerGuessResponse,
  WorkflowUpsertRequest
} from '@@/types/workflow'
import type { RadioGroupItem } from '@nuxt/ui'

type TriggerType = 'schedule' | 'interval'

const toast = useToast()

const { data, pending, refresh } = await useFetch<WorkflowListResponse>('/api/workflows', {
  cache: 'no-store'
})

const workflows = computed(() => data.value?.workflows ?? [])
const availableSkills = computed(() => data.value?.availableSkills ?? [])

const isCreateModalOpen = ref(false)
const currentStep = ref(1)
const isCreating = ref(false)
const isEnhancing = ref(false)
const isParsingTrigger = ref(false)
const deletingWorkflowSlug = ref<string | null>(null)
const runningWorkflowSlug = ref<string | null>(null)

const stepItems = [
  {
    title: '내용 입력',
    description: '워크플로 지시문'
  },
  {
    title: '실행 조건',
    description: '트리거와 스킬'
  }
]

const triggerItems: RadioGroupItem[] = [
  {
    value: 'schedule',
    label: '크론',
    description: 'cron 문법으로 실행 스케줄을 지정합니다.'
  },
  {
    value: 'interval',
    label: '주기적',
    description: '120s, 60m, 2h 형식으로 실행 간격을 지정합니다.'
  }
]

const form = reactive({
  requestText: '',
  triggerType: 'schedule' as TriggerType,
  triggerValue: '',
  workflowDispatch: false,
  skills: [] as string[]
})

const resetCreateForm = () => {
  form.requestText = ''
  form.triggerType = 'schedule'
  form.triggerValue = ''
  form.workflowDispatch = false
  form.skills = []
  currentStep.value = 1
}

const openCreateModal = () => {
  resetCreateForm()
  isCreateModalOpen.value = true
}

const closeCreateModal = () => {
  if (isCreating.value || isEnhancing.value || isParsingTrigger.value) {
    return
  }
  isCreateModalOpen.value = false
}

const deriveWorkflowName = (value: string) => {
  const singleLine = value
    .replace(/\s+/g, ' ')
    .replace(/[.?!]$/, '')
    .trim()
  if (!singleLine) {
    return 'New Workflow'
  }
  return singleLine.length > 64 ? singleLine.slice(0, 64).trim() : singleLine
}

const deriveWorkflowDescription = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) {
    return 'Workflow created from UI'
  }
  return trimmed.length > 280 ? `${trimmed.slice(0, 280).trim()}...` : trimmed
}

const canProceedFromStepOne = computed(() => form.requestText.trim().length > 0)
const triggerValuePlaceholder = computed(() =>
  form.triggerType === 'schedule' ? '0 18 * * *' : '2h'
)

const requestTriggerSuggestion = async () => {
  const source = form.requestText.trim()
  if (!source) {
    return
  }

  try {
    isParsingTrigger.value = true
    const guessed = await $fetch<WorkflowTriggerGuessResponse>('/api/workflows/parse-trigger', {
      method: 'POST',
      body: { text: source }
    })

    if (guessed.triggerType) {
      form.triggerType = guessed.triggerType
    }
    if (guessed.triggerValue) {
      form.triggerValue = guessed.triggerValue
    }
  } catch (error) {
    console.error(error)
  } finally {
    isParsingTrigger.value = false
  }
}

const goToStepTwo = async () => {
  if (!canProceedFromStepOne.value) {
    toast.add({
      title: '내용을 입력해 주세요.',
      color: 'warning'
    })
    return
  }
  await requestTriggerSuggestion()
  currentStep.value = 2
}

const goToStepOne = () => {
  currentStep.value = 1
}

const enhanceInstruction = async () => {
  const source = form.requestText.trim()
  if (!source) {
    return
  }

  try {
    isEnhancing.value = true
    const response = await $fetch<WorkflowEnhanceResponse>('/api/workflows/enhance', {
      method: 'POST',
      body: { text: source }
    })
    form.requestText = response.text
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Enhance failed.'
    toast.add({
      title: 'Enhance 실패',
      description: message,
      color: 'error'
    })
  } finally {
    isEnhancing.value = false
  }
}

const saveWorkflow = async () => {
  const instruction = form.requestText.trim()
  const triggerValue = form.triggerValue.trim()
  const hasTrigger = triggerValue.length > 0

  const payload: WorkflowUpsertRequest = {
    name: deriveWorkflowName(instruction),
    description: deriveWorkflowDescription(instruction),
    instruction,
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
    isCreating.value = true
    await $fetch('/api/workflows', {
      method: 'POST',
      body: payload
    })
    await refresh()
    isCreateModalOpen.value = false
    resetCreateForm()
    toast.add({
      title: '워크플로 등록 완료',
      color: 'success'
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to register workflow.'
    toast.add({
      title: '등록 실패',
      description: message,
      color: 'error'
    })
  } finally {
    isCreating.value = false
  }
}

const deleteWorkflow = async (workflow: WorkflowDefinition) => {
  if (!import.meta.client) {
    return
  }

  const confirmed = window.confirm(`Delete workflow "${workflow.frontmatter.name}"?`)
  if (!confirmed) {
    return
  }

  try {
    deletingWorkflowSlug.value = workflow.fileSlug
    await $fetch(`/api/workflows/${encodeURIComponent(workflow.fileSlug)}`, {
      method: 'DELETE'
    })
    await refresh()
    toast.add({
      title: '삭제 완료',
      color: 'success'
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete workflow.'
    toast.add({
      title: '삭제 실패',
      description: message,
      color: 'error'
    })
  } finally {
    deletingWorkflowSlug.value = null
  }
}

const runWorkflowNow = async (workflow: WorkflowDefinition) => {
  if (!workflow.frontmatter.on['workflow-dispatch']) {
    return
  }

  try {
    runningWorkflowSlug.value = workflow.fileSlug
    await $fetch(`/api/workflows/${encodeURIComponent(workflow.fileSlug)}/run`, {
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
    runningWorkflowSlug.value = null
  }
}

const triggerSummary = (workflow: WorkflowDefinition) => {
  if (workflow.frontmatter.on.schedule) {
    return `cron: ${workflow.frontmatter.on.schedule}`
  }
  if (workflow.frontmatter.on.interval) {
    return `interval: ${workflow.frontmatter.on.interval}`
  }
  return 'no schedule'
}
</script>

<template>
  <UDashboardPanel id="workflows-panel">
    <template #header>
      <UDashboardNavbar title="Workflows">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <div class="flex items-center gap-2">
            <UButton
              color="neutral"
              variant="outline"
              icon="i-lucide-refresh-cw"
              :loading="pending"
              @click="() => refresh()"
            >
              Refresh
            </UButton>
            <UButton
              icon="i-lucide-plus"
              @click="openCreateModal"
            >
              Add workflow
            </UButton>
          </div>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UContainer class="py-6 sm:py-8">
        <div class="mx-auto flex w-full max-w-5xl flex-col gap-4">
          <UAlert
            v-if="workflows.length === 0"
            color="neutral"
            variant="soft"
            icon="i-lucide-info"
            title="등록된 워크플로가 없습니다."
            description="Add workflow 버튼으로 새 워크플로를 등록하세요."
          />

          <UCard
            v-for="workflow in workflows"
            :key="workflow.fileSlug"
            :ui="{ body: 'space-y-3' }"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0 space-y-1">
                <div class="flex items-center gap-2">
                  <p class="truncate text-base font-semibold">
                    {{ workflow.frontmatter.name }}
                  </p>
                  <UBadge
                    v-if="!workflow.isValid"
                    color="error"
                    variant="soft"
                    label="Invalid"
                  />
                </div>
                <p class="truncate text-xs text-muted-foreground">
                  {{ workflow.filePath }}
                </p>
              </div>
              <div class="flex items-center gap-2">
                <UButton
                  :to="`/workflows/${workflow.fileSlug}/runs`"
                  color="neutral"
                  variant="outline"
                  icon="i-lucide-history"
                >
                  Runs
                </UButton>
                <UButton
                  v-if="workflow.frontmatter.on['workflow-dispatch']"
                  color="neutral"
                  variant="outline"
                  icon="i-lucide-play"
                  :loading="runningWorkflowSlug === workflow.fileSlug"
                  :disabled="!workflow.isValid"
                  @click="runWorkflowNow(workflow)"
                >
                  Run
                </UButton>
                <UButton
                  :to="`/workflows/${workflow.fileSlug}`"
                  color="neutral"
                  variant="outline"
                  icon="i-lucide-square-pen"
                >
                  Edit
                </UButton>
                <UButton
                  color="error"
                  variant="ghost"
                  icon="i-lucide-trash-2"
                  :loading="deletingWorkflowSlug === workflow.fileSlug"
                  @click="deleteWorkflow(workflow)"
                >
                  Delete
                </UButton>
              </div>
            </div>

            <p class="text-sm text-muted-foreground">
              {{ workflow.frontmatter.description }}
            </p>

            <div class="flex flex-wrap items-center gap-2">
              <UBadge
                color="neutral"
                variant="soft"
              >
                {{ triggerSummary(workflow) }}
              </UBadge>
              <UBadge
                color="neutral"
                variant="soft"
              >
                dispatch: {{ workflow.frontmatter.on['workflow-dispatch'] ? 'on' : 'off' }}
              </UBadge>
              <UBadge
                v-for="skill in workflow.frontmatter.skills"
                :key="`${workflow.fileSlug}-${skill}`"
                color="primary"
                variant="subtle"
              >
                {{ skill }}
              </UBadge>
            </div>

            <UAlert
              v-if="!workflow.isValid && workflow.parseError"
              color="error"
              variant="soft"
              :title="workflow.parseError"
            />
          </UCard>
        </div>
      </UContainer>

      <UModal
        v-model:open="isCreateModalOpen"
        title="새 워크플로 등록"
        :ui="{ body: 'space-y-4', footer: 'justify-between' }"
      >
        <template #body>
          <UStepper
            :items="stepItems"
            :model-value="currentStep"
            class="w-full"
          />

          <div
            v-if="currentStep === 1"
            class="space-y-3"
          >
            <UTextarea
              v-model="form.requestText"
              :rows="8"
              autoresize
              :maxrows="14"
              placeholder="예) 매일 오후 6시에 오늘 작업 내용을 정리해서 이메일로 보내줘."
            />
            <div class="flex justify-end">
              <UButton
                icon="i-lucide-wand-sparkles"
                color="neutral"
                variant="outline"
                :loading="isEnhancing"
                @click="enhanceInstruction"
              >
                Enhance
              </UButton>
            </div>
          </div>

          <div
            v-else
            class="space-y-4"
          >
            <URadioGroup
              v-model="form.triggerType"
              legend="트리거"
              :items="triggerItems"
              variant="card"
            />

            <UInput
              v-model="form.triggerValue"
              :placeholder="triggerValuePlaceholder"
              :icon="form.triggerType === 'schedule' ? 'i-lucide-calendar-clock' : 'i-lucide-repeat'"
            />

            <USwitch
              v-model="form.workflowDispatch"
              label="직접 실행 허용"
              description="workflow-dispatch 트리거를 함께 활성화합니다."
            />

            <UCheckboxGroup
              v-model="form.skills"
              legend="허용 스킬"
              :items="availableSkills"
              variant="list"
            />
          </div>
        </template>

        <template #footer>
          <div class="flex w-full items-center justify-between gap-2">
            <UButton
              color="neutral"
              variant="outline"
              :disabled="isCreating || isEnhancing || isParsingTrigger"
              @click="closeCreateModal"
            >
              취소
            </UButton>

            <div class="flex items-center gap-2">
              <UButton
                v-if="currentStep === 2"
                color="neutral"
                variant="outline"
                :disabled="isCreating"
                @click="goToStepOne"
              >
                이전
              </UButton>
              <UButton
                v-if="currentStep === 1"
                :loading="isParsingTrigger"
                :disabled="!canProceedFromStepOne"
                @click="goToStepTwo"
              >
                다음
              </UButton>
              <UButton
                v-else
                :loading="isCreating"
                @click="saveWorkflow"
              >
                등록
              </UButton>
            </div>
          </div>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
