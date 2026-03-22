import type { WorkflowRunSummary, WorkflowTriggerType } from '@@/types/workflow'
import { sendTelegramMessage } from './telegram-bot.ts'
import { readTelegramSettings } from './settings-config.ts'

export type OperatorNotificationSeverity = 'info' | 'warning' | 'blocker'
export type OperatorNotificationSource = 'workflow' | 'background-task' | 'system'

type OperatorNotificationContext = {
  workflowName?: string | null
  workflowFileSlug?: string | null
  runId?: string | null
  triggerType?: WorkflowTriggerType | null
  triggerValue?: string | null
  sessionThreadId?: string | null
  taskName?: string | null
  branch?: string | null
  prNumber?: number | null
  issueNumber?: number | null
}

export type OperatorNotificationInput = {
  severity?: OperatorNotificationSeverity
  source?: OperatorNotificationSource
  title: string
  message?: string | null
  nextAction?: string | null
  context?: OperatorNotificationContext
}

export type OperatorNotificationResult = {
  delivered: boolean
  skippedReason: string | null
  messageId: number | null
}

const MAX_MESSAGE_ESCAPED_LENGTH = 2400
const MAX_NEXT_ACTION_ESCAPED_LENGTH = 300
const MAX_CONTEXT_VALUE_ESCAPED_LENGTH = 180

const compactWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim()

const normalizeMultilineText = (value: string) =>
  value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

const escapedLength = (value: string) => {
  let length = 0
  for (const char of value) {
    if (char === '&') {
      length += 5
      continue
    }
    if (char === '<' || char === '>') {
      length += 4
      continue
    }
    length += char.length
  }
  return length
}

const truncateByEscapedLength = (value: string, maxEscapedLength: number) => {
  if (escapedLength(value) <= maxEscapedLength) {
    return value
  }

  const suffix = '…'
  const suffixLength = escapedLength(suffix)
  let budget = maxEscapedLength
  if (suffixLength < budget) {
    budget -= suffixLength
  }

  let result = ''
  let used = 0
  for (const char of value) {
    const delta = escapedLength(char)
    if (used + delta > budget) {
      break
    }
    result += char
    used += delta
  }

  return `${result.trimEnd()}${suffix}`
}

const escapeTelegramHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

const toSeverityLabel = (severity: OperatorNotificationSeverity) => {
  switch (severity) {
    case 'blocker':
      return 'BLOCKER'
    case 'warning':
      return 'WARNING'
    default:
      return 'INFO'
  }
}

const toSourceLabel = (source: OperatorNotificationSource) => {
  switch (source) {
    case 'background-task':
      return 'Background task'
    case 'system':
      return 'System'
    default:
      return 'Workflow'
  }
}

const formatContextLines = (context?: OperatorNotificationContext | null) => {
  if (!context) {
    return []
  }

  const lines: string[] = []
  if (context.workflowName) {
    lines.push(`Workflow: ${truncateByEscapedLength(compactWhitespace(context.workflowName), MAX_CONTEXT_VALUE_ESCAPED_LENGTH)}`)
  }
  if (context.workflowFileSlug) {
    lines.push(`Workflow slug: ${truncateByEscapedLength(compactWhitespace(context.workflowFileSlug), MAX_CONTEXT_VALUE_ESCAPED_LENGTH)}`)
  }
  if (context.taskName) {
    lines.push(`Task: ${truncateByEscapedLength(compactWhitespace(context.taskName), MAX_CONTEXT_VALUE_ESCAPED_LENGTH)}`)
  }
  if (context.runId) {
    lines.push(`Run: ${truncateByEscapedLength(compactWhitespace(context.runId), MAX_CONTEXT_VALUE_ESCAPED_LENGTH)}`)
  }
  if (context.triggerType) {
    lines.push(`Trigger: ${context.triggerType}${context.triggerValue ? ` (${truncateByEscapedLength(compactWhitespace(context.triggerValue), MAX_CONTEXT_VALUE_ESCAPED_LENGTH)})` : ''}`)
  }
  if (context.sessionThreadId) {
    lines.push(`Session thread: ${truncateByEscapedLength(compactWhitespace(context.sessionThreadId), MAX_CONTEXT_VALUE_ESCAPED_LENGTH)}`)
  }
  if (context.branch) {
    lines.push(`Branch: ${truncateByEscapedLength(compactWhitespace(context.branch), MAX_CONTEXT_VALUE_ESCAPED_LENGTH)}`)
  }
  if (typeof context.prNumber === 'number') {
    lines.push(`PR: #${context.prNumber}`)
  }
  if (typeof context.issueNumber === 'number') {
    lines.push(`Issue: #${context.issueNumber}`)
  }
  return lines
}

const buildOperatorNotificationHtml = (input: OperatorNotificationInput) => {
  const severity = input.severity ?? 'info'
  const source = input.source ?? 'system'
  const lines: string[] = [
    `<b>[${toSeverityLabel(severity)}]</b> ${escapeTelegramHtml(compactWhitespace(input.title))}`,
    escapeTelegramHtml(toSourceLabel(source))
  ]

  const message = normalizeMultilineText(input.message ?? '')
  if (message) {
    lines.push('', escapeTelegramHtml(truncateByEscapedLength(message, MAX_MESSAGE_ESCAPED_LENGTH)))
  }

  const contextLines = formatContextLines(input.context)
  if (contextLines.length > 0) {
    lines.push('', ...contextLines.map(line => escapeTelegramHtml(line)))
  }

  const nextAction = compactWhitespace(input.nextAction ?? '')
  if (nextAction) {
    lines.push('', `<b>Next:</b> ${escapeTelegramHtml(truncateByEscapedLength(nextAction, MAX_NEXT_ACTION_ESCAPED_LENGTH))}`)
  }

  return lines.join('\n').trim()
}

export const sendOperatorNotification = async (
  input: OperatorNotificationInput
): Promise<OperatorNotificationResult> => {
  const title = compactWhitespace(input.title)
  if (!title) {
    return {
      delivered: false,
      skippedReason: 'Missing title.',
      messageId: null
    }
  }

  const telegram = readTelegramSettings()
  if (!telegram.enabled) {
    return {
      delivered: false,
      skippedReason: 'Telegram settings are not configured.',
      messageId: null
    }
  }

  const result = await sendTelegramMessage({
    botToken: telegram.botToken,
    chatId: telegram.chatId,
    text: buildOperatorNotificationHtml({
      ...input,
      title
    }),
    parseMode: 'HTML',
    disableWebPagePreview: true
  })

  return {
    delivered: true,
    skippedReason: null,
    messageId: result.message_id
  }
}

export const sendWorkflowRunOperatorNotification = async (input: {
  definition: {
    frontmatter: {
      name: string
    }
    fileSlug: string
  }
  summary: WorkflowRunSummary
  title: string
  severity: OperatorNotificationSeverity
  message: string
  nextAction?: string | null
}) => {
  return sendOperatorNotification({
    severity: input.severity,
    source: 'workflow',
    title: input.title,
    message: input.message,
    nextAction: input.nextAction,
    context: {
      workflowName: input.definition.frontmatter.name,
      workflowFileSlug: input.definition.fileSlug,
      runId: input.summary.id,
      triggerType: input.summary.triggerType,
      triggerValue: input.summary.triggerValue,
      sessionThreadId: input.summary.sessionThreadId
    }
  })
}
