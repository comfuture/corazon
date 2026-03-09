<script setup lang="ts">
import type { CodexItemData } from '@@/types/chat-ui'
import CzMessageItemUnifiedDiffViewer from './unified-diff-viewer.vue'

type FileChangeItem = Extract<CodexItemData, { kind: 'file_change' }>['item']

const props = defineProps<{
  item: FileChangeItem
}>()

const open = ref(false)

const changes = computed(() => props.item.changes ?? [])

const hasDiff = (diff?: string | null) => typeof diff === 'string' && diff.trim().length > 0

const hasAnyDiff = computed(() => changes.value.some(change => hasDiff(change?.diff)))

const hasAnyChangeKind = computed(() => changes.value.some(change => typeof change?.kind === 'string' && change.kind.length > 0))

const hasDetails = computed(() => changes.value.length > 1 || hasAnyDiff.value)

const itemStatus = computed(() => String(props.item.status ?? ''))

const badgeLabel = computed(() => (hasAnyDiff.value || hasAnyChangeKind.value ? 'file' : 'file change'))

const filePreview = computed(() => {
  const [firstChange] = changes.value
  if (!firstChange?.path) {
    return 'file change'
  }

  if (changes.value.length === 1) {
    return firstChange.path
  }

  return `${firstChange.path} +${changes.value.length - 1} more`
})

const statusIconName = computed(() => {
  switch (itemStatus.value) {
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
  switch (itemStatus.value) {
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

const changeKindIcon = (kind?: string) => {
  switch (kind) {
    case 'add':
      return 'i-lucide-plus'
    case 'delete':
      return 'i-lucide-minus'
    case 'update':
      return 'i-lucide-pencil'
    default:
      return 'i-lucide-file'
  }
}

const changeKindClass = (kind?: string) => {
  switch (kind) {
    case 'add':
      return 'text-emerald-500'
    case 'delete':
      return 'text-rose-500'
    case 'update':
      return 'text-amber-500'
    default:
      return 'text-muted'
  }
}

const toggleOpen = () => {
  if (!hasDetails.value) {
    return
  }

  open.value = !open.value
}
</script>

<template>
  <div class="space-y-1.5">
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
          {{ badgeLabel }}
        </UBadge>
        <span class="block whitespace-pre-wrap break-all font-mono text-xs text-default">{{ filePreview }}</span>
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
        {{ badgeLabel }}
      </UBadge>
      <span class="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-xs text-default">{{ filePreview }}</span>
      <UIcon
        :name="statusIconName"
        :class="statusIconClass"
      />
    </div>

    <ul
      v-if="hasDetails && open"
      class="space-y-1 pl-1"
    >
      <li
        v-for="(change, changeIndex) in changes"
        :key="`${item.id}-${change?.path}-${changeIndex}`"
        class="space-y-1.5"
      >
        <div class="flex items-start gap-2 text-xs">
          <UIcon
            :name="changeKindIcon(change?.kind)"
            class="mt-0.5 h-3.5 w-3.5 shrink-0"
            :class="changeKindClass(change?.kind)"
          />
          <span class="font-mono break-all text-default">{{ change?.path }}</span>
        </div>

        <div
          v-if="hasDiff(change?.diff)"
          class="rounded-md"
        >
          <CzMessageItemUnifiedDiffViewer :diff="change?.diff ?? ''" />
        </div>
      </li>
    </ul>
  </div>
</template>
