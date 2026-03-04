<script setup lang="ts">
import type {
  WorkflowDetailResponse,
  WorkflowListResponse,
  WorkflowRunSummary,
  WorkflowUpsertRequest
} from '@@/types/workflow'
import type { RadioGroupItem } from '@nuxt/ui'

type TriggerType = 'schedule' | 'interval' | 'rrule'

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
  },
  {
    value: 'rrule',
    label: 'RRULE',
    description: 'RFC 5545 RRULE 문법으로 반복 규칙을 지정합니다.'
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

const isSaving = ref(false)
const isDeleting = ref(false)
const isRunning = ref(false)

const canRunNow = computed(() => workflow.value?.frontmatter.on['workflow-dispatch'] === true)

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
  } else if (workflow.value.frontmatter.on.rrule) {
    form.triggerType = 'rrule'
    form.triggerValue = workflow.value.frontmatter.on.rrule
  } else {
    form.triggerType = 'schedule'
    form.triggerValue = ''
  }
}

watch(workflow, () => {
  syncFormFromWorkflow()
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
  if (!canRunNow.value) {
    return
  }

  try {
    isRunning.value = true
    const response = await $fetch<{ run: WorkflowRunSummary }>(`/api/workflows/${encodeURIComponent(workflowSlug.value)}/run`, {
      method: 'POST'
    })
    await refresh()

    if (response.run.status === 'failed') {
      toast.add({
        title: '실행 실패',
        description: response.run.errorMessage ?? 'Workflow run failed.',
        color: 'error'
      })
      return
    }

    if (response.run.status === 'running') {
      toast.add({
        title: '실행 시작',
        description: '워크플로 실행이 진행 중입니다.',
        color: 'warning'
      })
      return
    }

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
</script>

<template>
  <div class="flex h-full w-full flex-col gap-6">
    <UAlert
      v-if="workflow && !workflow.isValid && workflow.parseError"
      color="error"
      variant="soft"
      :title="workflow.parseError"
    />

    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <h2 class="text-base font-semibold">
        Workflow Definition
      </h2>
      <div class="flex flex-wrap items-center gap-2">
        <UButton
          v-if="canRunNow"
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
    </div>

    <UForm
      :state="form"
      class="w-full space-y-4"
    >
      <div class="flex flex-col gap-4">
        <UFormField
          name="name"
          label="Name"
          required
        >
          <UInput
            v-model="form.name"
            class="w-full"
            placeholder="workflow name"
          />
        </UFormField>

        <UFormField
          name="description"
          label="Description"
          required
        >
          <UTextarea
            v-model="form.description"
            class="w-full"
            :rows="3"
            autoresize
            :maxrows="10"
            placeholder="workflow description"
          />
        </UFormField>
      </div>

      <UFormField
        name="instruction"
        label="Instruction"
        required
      >
        <UTextarea
          v-model="form.instruction"
          class="w-full"
          :rows="16"
          autoresize
          :maxrows="28"
          placeholder="워크플로 지시문"
        />
      </UFormField>
    </UForm>

    <USeparator />

    <section class="space-y-4">
      <div class="space-y-1">
        <h3 class="text-sm font-semibold">
          Execution Options
        </h3>
        <p class="text-xs text-muted-foreground">
          실행 트리거와 허용 스킬을 설정합니다.
        </p>
      </div>

      <URadioGroup
        v-model="form.triggerType"
        legend="trigger type"
        :items="triggerItems"
        variant="table"
      />

      <UFormField
        name="triggerValue"
        :label="form.triggerType === 'schedule' ? 'Cron Expression' : form.triggerType === 'interval' ? 'Interval' : 'RRULE'"
      >
        <UInput
          v-model="form.triggerValue"
          class="w-full"
          :placeholder="form.triggerType === 'schedule' ? '0 18 * * *' : form.triggerType === 'interval' ? '2h' : 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0'"
          :icon="form.triggerType === 'schedule' ? 'i-lucide-calendar-clock' : form.triggerType === 'interval' ? 'i-lucide-repeat' : 'i-lucide-calendar-range'"
        />
      </UFormField>

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
    </section>
  </div>
</template>
