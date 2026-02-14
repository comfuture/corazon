<script setup lang="ts">
import type { CodexItemData } from '@@/types/codex-ui'

type TodoListItem = Extract<CodexItemData, { kind: 'todo_list' }>['item']

defineProps<{
  item: TodoListItem
}>()
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center gap-2">
        <UBadge
          color="primary"
          variant="subtle"
        >
          Todo list
        </UBadge>
        <UBadge
          color="neutral"
          variant="subtle"
        >
          {{ item.items?.length ?? 0 }} items
        </UBadge>
      </div>
    </template>

    <ul class="space-y-2">
      <li
        v-for="(todo, todoIndex) in item.items ?? []"
        :key="`${item.id}-${todoIndex}`"
        class="flex items-start gap-2"
      >
        <UCheckbox
          :model-value="todo?.completed ?? false"
          disabled
        />
        <span :class="todo?.completed ? 'text-muted line-through' : 'text-sm'">
          {{ todo?.text }}
        </span>
      </li>
    </ul>
  </UCard>
</template>
