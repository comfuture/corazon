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

const compactWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim()

const normalizeMultilineText = (value: string) =>
  value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

const truncate = (value: string, max: number) => {
  if (value.length <= max) {
    return value
  }
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`
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
    lines.push(`Workflow: ${compactWhitespace(context.workflowName)}`)
  }
  if (context.workflowFileSlug) {
    lines.push(`Workflow slug: ${compactWhitespace(context.workflowFileSlug)}`)
  }
  if (context.taskName) {
    lines.push(`Task: ${compactWhitespace(context.taskName)}`)
  }
  if (context.runId) {
    lines.push(`Run: ${compactWhitespace(context.runId)}`)
  }
  if (context.triggerType) {
    lines.push(`Trigger: ${context.triggerType}${context.triggerValue ? ` (${compactWhitespace(context.triggerValue)})` : ''}`)
  }
  if (context.sessionThreadId) {
    lines.push(`Session thread: ${compactWhitespace(context.sessionThreadId)}`)
  }
  if (context.branch) {
    lines.push(`Branch: ${compactWhitespace(context.branch)}`)
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
    lines.push('', escapeTelegramHtml(truncate(message, 3000)))
  }

  const contextLines = formatContextLines(input.context)
  if (contextLines.length > 0) {
    lines.push('', ...contextLines.map(line => escapeTelegramHtml(line)))
  }

  const nextAction = compactWhitespace(input.nextAction ?? '')
  if (nextAction) {
    lines.push('', `<b>Next:</b> ${escapeTelegramHtml(truncate(nextAction, 400))}`)
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
