<script setup lang="ts">
import type { CodexItemData } from '@@/types/chat-ui'
import CzMessageItemChatTool from './chat-tool.vue'
import CzMessageItemUnifiedDiffViewer from './unified-diff-viewer.vue'

type FileChangeItem = Extract<CodexItemData, { kind: 'file_change' }>['item']

const props = defineProps<{
  item: FileChangeItem
}>()

const changes = computed(() => props.item.changes ?? [])

const hasDiff = (diff?: string | null) => typeof diff === 'string' && diff.trim().length > 0

const hasAnyDiff = computed(() => changes.value.some(change => hasDiff(change?.diff)))

const hasDetails = computed(() => changes.value.length > 1 || hasAnyDiff.value)

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

const title = computed(() => {
  switch (props.item.status) {
    case 'in_progress':
      return '파일 변경 적용 중'
    case 'completed':
      return '파일 변경'
    case 'failed':
      return '파일 변경 실패'
    default:
      return '파일 변경'
  }
})

const icon = computed(() =>
  props.item.status === 'failed' ? 'i-lucide-triangle-alert' : 'i-lucide-file-pen-line'
)

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
</script>

<template>
  <CzMessageItemChatTool
    v-if="hasDetails"
    :text="title"
    :suffix="filePreview"
    :icon="icon"
    :status="item.status"
    variant="card"
    :default-open="item.status === 'failed'"
    :ui="{
      label: 'min-w-0 truncate',
      suffix: 'truncate font-mono text-xs',
      trigger: 'px-2 py-1.5',
      body: 'max-h-[320px] overflow-y-auto border-default p-2'
    }"
  >
    <ul class="space-y-2">
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
  </CzMessageItemChatTool>

  <CzMessageItemChatTool
    v-else
    :text="title"
    :suffix="filePreview"
    :icon="icon"
    :status="item.status"
    :ui="{
      label: 'min-w-0 truncate',
      suffix: 'truncate font-mono text-xs'
    }"
  />
</template>
