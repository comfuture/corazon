<script setup lang="ts">
import type { CodexItemData } from '@@/types/codex-ui'

type FileChangeItem = Extract<CodexItemData, { kind: 'file_change' }>['item']

defineProps<{
  item: FileChangeItem
}>()

const statusColor = (status?: string) => {
  switch (status) {
    case 'completed':
      return 'success'
    case 'failed':
      return 'error'
    case 'in_progress':
      return 'warning'
    default:
      return 'neutral'
  }
}

const changeKindColor = (kind?: string) => {
  switch (kind) {
    case 'add':
      return 'success'
    case 'delete':
      return 'error'
    case 'update':
      return 'warning'
    default:
      return 'neutral'
  }
}
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex flex-wrap items-center gap-2">
        <UBadge
          color="primary"
          variant="subtle"
        >
          File changes
        </UBadge>
        <UBadge
          :color="statusColor(item.status)"
          variant="soft"
        >
          {{ item.status }}
        </UBadge>
      </div>
    </template>

    <ul class="space-y-2 text-sm">
      <li
        v-for="(change, changeIndex) in item.changes ?? []"
        :key="`${item.id}-${change?.path}-${changeIndex}`"
        class="flex items-center gap-2"
      >
        <UBadge
          :color="changeKindColor(change?.kind)"
          variant="soft"
        >
          {{ change?.kind }}
        </UBadge>
        <span class="font-mono text-xs break-all">{{ change?.path }}</span>
      </li>
    </ul>
  </UCard>
</template>
