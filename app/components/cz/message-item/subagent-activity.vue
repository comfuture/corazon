<script setup lang="ts">
import type { CodexItemData, CodexSubagentAgentState } from '@@/types/chat-ui'

type SubagentActivityItem = Extract<CodexItemData, { kind: 'subagent_activity' }>['item']

const props = defineProps<{
  item: SubagentActivityItem
}>()

const open = ref(false)
const hiddenActions = new Set<SubagentActivityItem['action']>([
  'wait',
  'closeAgent'
])

const stateEntries = computed<CodexSubagentAgentState[]>(() => props.item.agentsStates ?? [])
const isHidden = computed(() => hiddenActions.has(props.item.action))

const shortThreadId = (value: string) => value.slice(0, 8)

const actionLabel = computed(() => {
  switch (props.item.action) {
    case 'spawnAgent':
      return '서브에이전트 생성'
    case 'sendInput':
      return '서브에이전트에 메시지 전달'
    case 'resumeAgent':
      return '서브에이전트 재개'
    case 'wait':
      return '서브에이전트 대기'
    case 'closeAgent':
      return '서브에이전트 종료'
    default:
      return '서브에이전트 작업'
  }
})

const targetSummary = computed(() => {
  if (props.item.receiverThreadIds.length === 0) {
    return ''
  }

  if (props.item.receiverThreadIds.length === 1) {
    return shortThreadId(props.item.receiverThreadIds[0] ?? '')
  }

  return `${props.item.receiverThreadIds.length} agents`
})

const summaryText = computed(() =>
  targetSummary.value ? `${actionLabel.value} ${targetSummary.value}` : actionLabel.value
)

const hasDetails = computed(() =>
  !!props.item.prompt
  || !!props.item.model
  || !!props.item.reasoningEffort
  || props.item.receiverThreadIds.length > 0
  || stateEntries.value.length > 0
)

const toggleOpen = () => {
  if (!hasDetails.value) {
    return
  }

  open.value = !open.value
}

const statusIconName = computed(() => {
  switch (props.item.status) {
    case 'in_progress':
      return 'i-lucide-loader-2'
    case 'completed':
      return 'i-lucide-check'
    case 'failed':
      return 'i-lucide-x'
    default:
      return 'i-lucide-circle'
  }
})

const statusIconClass = computed(() => {
  switch (props.item.status) {
    case 'in_progress':
      return 'h-3.5 w-3.5 animate-spin text-amber-500'
    case 'completed':
      return 'h-3.5 w-3.5 text-emerald-500'
    case 'failed':
      return 'h-3.5 w-3.5 text-rose-500'
    default:
      return 'h-3.5 w-3.5 text-muted'
  }
})

const agentStatusColor = (status: CodexSubagentAgentState['status']) => {
  switch (status) {
    case 'running':
      return 'info'
    case 'completed':
      return 'success'
    case 'interrupted':
      return 'warning'
    case 'errored':
      return 'error'
    case 'shutdown':
      return 'neutral'
    case 'pendingInit':
      return 'primary'
    case 'notFound':
      return 'neutral'
    default:
      return 'neutral'
  }
}

const agentStatusLabel = (status: CodexSubagentAgentState['status']) => {
  switch (status) {
    case 'pendingInit':
      return 'pending'
    case 'running':
      return 'running'
    case 'interrupted':
      return 'interrupted'
    case 'completed':
      return 'completed'
    case 'errored':
      return 'errored'
    case 'shutdown':
      return 'shutdown'
    case 'notFound':
      return 'not found'
    default:
      return 'unknown'
  }
}
</script>

<template>
  <div
    v-if="!isHidden"
    class="space-y-1.5"
  >
    <UButton
      v-if="hasDetails"
      color="neutral"
      variant="ghost"
      size="sm"
      class="w-full justify-between px-0 py-0.5 text-muted"
      @click="toggleOpen"
    >
      <span class="min-w-0 flex flex-1 items-center gap-2 text-left">
        <UBadge
          color="primary"
          variant="subtle"
          size="xs"
        >
          subagent
        </UBadge>
        <span class="block whitespace-pre-wrap break-all text-xs text-default">{{ summaryText }}</span>
      </span>

      <template #trailing>
        <div class="flex items-center gap-2">
          <UIcon
            :name="statusIconName"
            :class="statusIconClass"
          />
          <UIcon
            name="i-lucide-chevron-right"
            class="size-3.5 text-muted transition-transform"
            :class="open ? 'rotate-90' : ''"
          />
        </div>
      </template>
    </UButton>

    <div
      v-else
      class="flex min-w-0 items-center gap-2 py-0.5 text-muted"
    >
      <UBadge
        color="primary"
        variant="subtle"
        size="xs"
      >
        subagent
      </UBadge>
      <span class="min-w-0 flex-1 whitespace-pre-wrap break-all text-xs text-default">{{ summaryText }}</span>
      <UIcon
        :name="statusIconName"
        :class="statusIconClass"
      />
    </div>

    <div
      v-if="hasDetails && open"
      class="space-y-2"
    >
      <div class="rounded-md border border-muted/60 bg-muted/10 px-3 py-2">
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <span class="font-medium text-default">from</span>
          <span class="font-mono text-muted-foreground">{{ shortThreadId(item.senderThreadId) }}</span>
          <span class="font-medium text-default">to</span>
          <span class="font-mono text-muted-foreground">{{ item.receiverThreadIds.map(shortThreadId).join(', ') || '-' }}</span>
        </div>

        <div
          v-if="item.model || item.reasoningEffort"
          class="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
        >
          <span v-if="item.model">model: <span class="font-mono">{{ item.model }}</span></span>
          <span v-if="item.reasoningEffort">reasoning: <span class="font-mono">{{ item.reasoningEffort }}</span></span>
        </div>
      </div>

      <div
        v-if="item.prompt"
        class="rounded-md bg-muted/10 px-3 py-2"
      >
        <p class="mb-2 text-xs font-medium text-default">
          Prompt
        </p>
        <pre class="whitespace-pre-wrap break-words text-xs text-muted-foreground">{{ item.prompt }}</pre>
      </div>

      <div
        v-if="stateEntries.length > 0"
        class="rounded-md border border-muted/60 bg-muted/10 px-3 py-2"
      >
        <p class="mb-2 text-xs font-medium text-default">
          Agent states
        </p>

        <ul class="space-y-2">
          <li
            v-for="entry in stateEntries"
            :key="`${item.id}-${entry.threadId}`"
            class="space-y-1"
          >
            <div class="flex flex-wrap items-center gap-2 text-xs">
              <span class="font-mono text-default">{{ shortThreadId(entry.threadId) }}</span>
              <UBadge
                :color="agentStatusColor(entry.status)"
                variant="subtle"
                size="xs"
              >
                {{ agentStatusLabel(entry.status) }}
              </UBadge>
            </div>
            <p
              v-if="entry.message"
              class="text-xs text-muted-foreground"
            >
              {{ entry.message }}
            </p>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
