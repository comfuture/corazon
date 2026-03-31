<script setup lang="ts">
import type { CodexItemData } from '@@/types/chat-ui'
import CzMessageItemChatTool from './chat-tool.vue'

type InternalToolCallItem = Extract<CodexItemData, { kind: 'mcp_tool_call' }>['item']

const props = defineProps<{
  item: InternalToolCallItem
}>()

type JsonRecord = Record<string, unknown>

const asRecord = (value: unknown): JsonRecord | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null

const asString = (value: unknown) =>
  typeof value === 'string' ? value.trim() : ''

const normalizeToolName = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .split('/')
    .filter(Boolean)
    .at(-1)
    ?.replace(/[_\-\s]/g, '') ?? ''

const argumentsRecord = computed(() => asRecord(props.item.arguments))

const parsedPayload = computed<JsonRecord | null>(() => {
  const structured = asRecord(props.item.result?.structured_content)
  if (!structured) {
    return null
  }

  const contentItems = structured.contentItems
  if (!Array.isArray(contentItems)) {
    return null
  }

  const textItem = contentItems.find((entry) => {
    const record = asRecord(entry)
    return record?.type === 'inputText' && typeof record.text === 'string'
  })

  const source = asRecord(textItem)?.text
  if (typeof source !== 'string') {
    return null
  }

  try {
    return asRecord(JSON.parse(source))
  } catch {
    return null
  }
})

const normalizedTool = computed(() => normalizeToolName(props.item.tool ?? ''))

const toolKind = computed<'memory' | 'workflow' | 'tool'>(() => {
  if (['sharedmemory', 'corazonsharedmemory'].includes(normalizedTool.value)) {
    return 'memory'
  }
  if (['manageworkflow', 'corazonmanageworkflow'].includes(normalizedTool.value)) {
    return 'workflow'
  }
  return 'tool'
})

const memoryAction = computed(() =>
  asString(parsedPayload.value?.command) || asString(argumentsRecord.value?.command)
)

const workflowAction = computed(() =>
  asString(parsedPayload.value?.action) || asString(argumentsRecord.value?.command)
)

const workflowRecord = computed(() => asRecord(parsedPayload.value?.workflow))
const parsedRecord = computed(() => asRecord(parsedPayload.value?.parsed))
const parsedDraftRecord = computed(() => asRecord(parsedRecord.value?.draft))

const workflowName = computed(() =>
  asString(workflowRecord.value?.name)
  || asString(workflowRecord.value?.fileSlug)
  || asString(parsedPayload.value?.name)
  || asString(parsedDraftRecord.value?.name)
  || asString(argumentsRecord.value?.name)
  || asString(argumentsRecord.value?.fileSlug)
  || asString(argumentsRecord.value?.slug)
  || asString(argumentsRecord.value?.query)
)

const summaryText = computed(() => {
  if (toolKind.value === 'memory') {
    switch (memoryAction.value.toLowerCase()) {
      case 'search':
        return '메모리 읽음'
      case 'upsert':
        return '메모리 기록'
      default:
        return '메모리 작업'
    }
  }

  if (toolKind.value === 'workflow') {
    let actionLabel = '워크플로우 작업'
    switch (workflowAction.value.toLowerCase()) {
      case 'create':
        actionLabel = '워크플로우 생성'
        break
      case 'update':
        actionLabel = '워크플로우 수정'
        break
      case 'delete':
        actionLabel = '워크플로우 삭제'
        break
      case 'inspect':
        actionLabel = '워크플로우 조회'
        break
      case 'list':
        actionLabel = '워크플로우 목록 조회'
        break
      case 'from-text':
        actionLabel = '워크플로우 초안 생성'
        break
      case 'apply-text':
        actionLabel = '워크플로우 적용'
        break
    }

    return workflowName.value ? `${actionLabel} ${workflowName.value}` : actionLabel
  }

  return `[tool call] ${props.item.tool?.trim() || 'tool'}`
})

const icon = computed(() => {
  if (props.item.status === 'failed') {
    return 'i-lucide-triangle-alert'
  }

  switch (toolKind.value) {
    case 'memory':
      return 'i-lucide-database'
    case 'workflow':
      return 'i-lucide-workflow'
    default:
      return 'i-lucide-wrench'
  }
})
</script>

<template>
  <CzMessageItemChatTool
    :text="summaryText"
    :icon="icon"
    :status="item.status"
    :ui="{ label: 'whitespace-pre-wrap break-all text-xs text-default' }"
  />
</template>
