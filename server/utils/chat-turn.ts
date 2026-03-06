import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import {
  CODEX_EVENT_PART,
  type CodexChatWorkflowInput,
  type CodexThreadEventData,
  type CodexUIMessage
} from '../../types/chat-ui.ts'
import type { InferUIMessageChunk } from 'ai'
import { createUIMessageStream } from 'ai'
import { ensureAgentBootstrap } from './agent-bootstrap.ts'
import { createCodexClient, resolveCodexClientMode } from './codex-client/index.ts'
import type { CodexClient, CodexInput } from './codex-client/types.ts'
import { createCodexAssistantBuilder } from './message-builder.ts'
import {
  clearThreadActiveRun,
  ensureThread,
  ensureThreadAttachmentsDirectory,
  ensureThreadRootDirectory,
  ensureThreadWorkingDirectory,
  getPendingAttachmentsDirectory,
  getThreadConfig,
  getThreadTitle,
  recordThreadUsage,
  saveThreadMessages,
  setThreadActiveRun,
  setThreadModel,
  setThreadTitle
} from './db.ts'
import { getRuntimeThread, hasRuntimeThread, setRuntimeThread } from './runtime.ts'
import { buildCodexInput, createThreadEventHandler } from './stream.ts'

const TITLE_MODEL = 'gpt-5.1-codex-mini'
const TITLE_REASONING_EFFORT = 'low'
const TITLE_MAX_LENGTH = 80
const TITLE_WORKDIR = '/tmp'
const DEFAULT_MODEL = 'gpt-5.3-codex'
const MODEL_OPTIONS = new Set([
  'gpt-5.3-codex',
  'gpt-5.2-codex',
  'gpt-5.2',
  'gpt-5.1-codex-mini'
])
const WORKFLOW_ROUTING_INTENT_PATTERN = /(?:\bworkflow\b|워크플로우|workflow[-\s]?dispatch|스케줄|schedule|cron|rrule|interval|자동화|자동 실행|정기 실행|run every|every\s+\d+\s*(?:sec|min|hour|day|week|month))/i
const WORKFLOW_MANAGEMENT_ACTION_PATTERN = /(?:생성|만들|작성|추가|등록|수정|업데이트|편집|삭제|지워|목록|리스트|조회|보여줘|create|add|update|edit|delete|remove|list|show|inspect|write)/i
const WORKFLOW_NATIVE_TOOL = 'corazon/manageWorkflow'
const WORKFLOW_ROUTING_MODE = resolveCodexClientMode(process.env.CORAZON_CODEX_CLIENT_MODE)
const WORKFLOW_ROUTING_PREAMBLE = [
  '[Corazon workflow routing policy]',
  ...(WORKFLOW_ROUTING_MODE === 'app-server'
    ? [
        `- If this request is about Corazon workflow management, use dynamic tool \`${WORKFLOW_NATIVE_TOOL}\`.`,
        `- For natural-language workflow requests, prefer \`${WORKFLOW_NATIVE_TOOL}\` command \`apply-text\` (or \`from-text\` first when uncertain).`
      ]
    : [
        '- If this request is about Corazon workflow management, use the `manage-workflows` skill.',
        '- For natural-language workflow requests, prefer `manage-workflows` -> `apply-text` (or `from-text` first when uncertain).'
      ]),
  '- Never use OS-level schedulers or external scheduler files (`crontab`, `systemd`, `launchd`) for Corazon workflow requests.',
  '- Apply workflow changes through Corazon workflow definitions (`workflows/*.md`) via Corazon workflow tooling.'
].join('\n')

let codexInstance: CodexClient | null = null

const getCodexEnv = () => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value
    }
  }
  env.CODEX_HOME = ensureAgentBootstrap()
  return env
}

const getCodex = () => {
  if (codexInstance) {
    return codexInstance
  }

  codexInstance = createCodexClient({
    env: getCodexEnv(),
    config: {
      show_raw_agent_reasoning: true,
      approval_policy: 'never',
      sandbox_mode: 'danger-full-access'
    }
  })

  return codexInstance
}

const resolveModel = (value: unknown) => {
  if (typeof value !== 'string') {
    return DEFAULT_MODEL
  }
  return MODEL_OPTIONS.has(value) ? value : DEFAULT_MODEL
}

const extractTextFromMessage = (message?: CodexUIMessage | null) => {
  if (!message) {
    return ''
  }
  return (message.parts ?? [])
    .filter(part => part?.type === 'text')
    .map(part => part.text ?? '')
    .join('\n')
    .trim()
}

const getFirstUserText = (messages: CodexUIMessage[]) => {
  const firstUser = messages.find(message => message?.role === 'user')
  return extractTextFromMessage(firstUser)
}

const getLatestUserText = (messages: CodexUIMessage[]) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user') {
      return extractTextFromMessage(message)
    }
  }
  return ''
}

const hasAssistantMessages = (messages: CodexUIMessage[]) =>
  messages.some(message => message?.role === 'assistant')

const isWorkflowManagementIntent = (text: string) => {
  const source = text.trim()
  if (!source) {
    return false
  }
  return WORKFLOW_ROUTING_INTENT_PATTERN.test(source) && WORKFLOW_MANAGEMENT_ACTION_PATTERN.test(source)
}

const prependWorkflowRoutingHint = (input: CodexInput, userText: string): CodexInput => {
  if (!isWorkflowManagementIntent(userText)) {
    return input
  }

  const prefixedText = `${WORKFLOW_ROUTING_PREAMBLE}\n\nUser request:\n${userText.trim()}`
  if (typeof input === 'string') {
    return prefixedText
  }

  if (Array.isArray(input)) {
    return [
      { type: 'text', text: `${WORKFLOW_ROUTING_PREAMBLE}\n\nUser request follows:` },
      ...input
    ]
  }

  return input
}

const isFileUrl = (value: string) => value.startsWith('file://')

const stripFileUrl = (value: string) => value.replace(/^file:\/\//, '')

const ensureUniqueFilePath = (dir: string, filename: string) => {
  const extension = extname(filename)
  const base = extension ? filename.slice(0, -extension.length) : filename
  let candidate = join(dir, filename)
  let index = 1

  while (existsSync(candidate)) {
    candidate = join(dir, `${base}-${index}${extension}`)
    index += 1
  }

  return candidate
}

const movePendingAttachments = (uploadId: string, threadId: string) => {
  const pendingDir = getPendingAttachmentsDirectory(uploadId)
  if (!existsSync(pendingDir)) {
    return null
  }

  const targetDir = ensureThreadAttachmentsDirectory(threadId)
  const entries = readdirSync(pendingDir, { withFileTypes: true })
  const pathMap = new Map<string, string>()

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue
    }
    const fromPath = join(pendingDir, entry.name)
    const toPath = ensureUniqueFilePath(targetDir, entry.name)
    renameSync(fromPath, toPath)
    pathMap.set(fromPath, toPath)
  }

  rmSync(pendingDir, { recursive: true, force: true })

  return pathMap
}

const rewriteAttachmentUrls = (messages: CodexUIMessage[], pathMap: Map<string, string>) =>
  messages.map((message) => {
    if (!Array.isArray(message?.parts) || message.parts.length === 0) {
      return message
    }

    let changed = false
    const nextParts = message.parts.map((part) => {
      if (part?.type !== 'file' || typeof part.url !== 'string' || !isFileUrl(part.url)) {
        return part
      }
      const originalPath = stripFileUrl(part.url)
      const nextPath = pathMap.get(originalPath)
      if (!nextPath) {
        return part
      }
      changed = true
      return {
        ...part,
        url: `file://${nextPath}`,
        filename: part.filename ?? basename(nextPath)
      }
    })

    return changed ? { ...message, parts: nextParts } : message
  })

const buildTitlePrompt = (userText: string, assistantText: string) => [
  'You are a concise title generator for chat threads.',
  'Create a short title based on the first user message and first assistant response.',
  'Use the same language as the user.',
  'Return only the title, no quotes, no bullet points, no extra text.',
  '',
  'User:',
  userText,
  '',
  'Assistant:',
  assistantText
].join('\n')

const normalizeTitle = (value: string) => {
  const singleLine = value.replace(/\s+/g, ' ').trim()
  const withoutPrefix = singleLine.replace(/^title\s*[:：]\s*/i, '')
  const withoutQuotes = withoutPrefix.replace(/^["'“”]+|["'“”]+$/g, '').trim()
  if (!withoutQuotes) {
    return ''
  }
  if (withoutQuotes.length > TITLE_MAX_LENGTH) {
    return withoutQuotes.slice(0, TITLE_MAX_LENGTH).trim()
  }
  return withoutQuotes
}

const generateThreadTitle = async (
  codex: CodexClient,
  userText: string,
  assistantText: string,
  skipGitRepoCheck: boolean
) => {
  const prompt = buildTitlePrompt(userText, assistantText)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const titleThread = codex.startThread({
      model: TITLE_MODEL,
      modelReasoningEffort: TITLE_REASONING_EFFORT,
      workingDirectory: TITLE_WORKDIR,
      skipGitRepoCheck
    })
    const result = await titleThread.run(prompt)
    const title = normalizeTitle(result.finalResponse ?? '')
    if (title) {
      return title
    }
  }
  return null
}

export const createCodexChatTurnStream = (input: CodexChatWorkflowInput) => {
  const codex = getCodex()
  const threadId = typeof input.threadId === 'string' && input.threadId.length > 0
    ? input.threadId
    : null
  const shouldResume = input.resume === true
  const attachmentUploadId = typeof input.attachmentUploadId === 'string'
    ? input.attachmentUploadId
    : null
  const skipGitRepoCheck = input.skipGitRepoCheck === true
  const requestedModel = resolveModel(input.model)
  const messages = Array.isArray(input.messages) ? input.messages : []
  const workflowRunId = typeof input.workflowRunId === 'string' && input.workflowRunId.length > 0
    ? input.workflowRunId
    : null
  const threadConfig = threadId ? getThreadConfig(threadId) : null
  const effectiveModel = threadConfig?.model ?? requestedModel
  const baseWorkdir = ensureThreadRootDirectory()
  const existingWorkdir = threadId ? ensureThreadWorkingDirectory(threadId) : null

  return createUIMessageStream<CodexUIMessage>({
    async execute({ writer }) {
      const assistantBuilder = createCodexAssistantBuilder()
      let resolvedThreadId: string | null = threadId
      const baseMessages = messages
      let firstAssistantText = ''
      const executeStartedAt = Date.now()
      let turnStartedAt: number | null = null
      let turnDurationMs: number | null = null
      const reasoningDurations = new Map<string, number>()
      let reasoningWindowStartedAt = executeStartedAt
      let waitingForNextReasoningWindowStart = false

      if (resolvedThreadId && workflowRunId) {
        setThreadActiveRun(resolvedThreadId, workflowRunId)
      }

      const originalWrite = writer.write.bind(writer)
      const writeChunk: typeof writer.write = (chunk) => {
        assistantBuilder.apply(chunk as InferUIMessageChunk<CodexUIMessage>)
        return originalWrite(chunk)
      }
      writer.write = writeChunk

      try {
        const thread = (() => {
          if (threadId && hasRuntimeThread(threadId)) {
            return getRuntimeThread(threadId)!
          }
          if (threadId && shouldResume) {
            const resumed = codex.resumeThread(threadId, {
              workingDirectory: existingWorkdir ?? baseWorkdir,
              model: effectiveModel,
              skipGitRepoCheck
            })
            setRuntimeThread(threadId, resumed)
            return resumed
          }
          return codex.startThread({
            workingDirectory: baseWorkdir,
            model: requestedModel,
            skipGitRepoCheck
          })
        })()

        const inputMessage = prependWorkflowRoutingHint(
          buildCodexInput(messages),
          getLatestUserText(messages)
        )

        if (!inputMessage || (Array.isArray(inputMessage) && inputMessage.length === 0)) {
          writer.write({
            type: 'error',
            errorText: 'No user input found to send to Codex.'
          })
          return
        }

        const handleEvent = createThreadEventHandler(writer, {
          onThreadStarted(startedThreadId) {
            resolvedThreadId = startedThreadId
            ensureThread(startedThreadId)
            const workingDirectory = ensureThreadWorkingDirectory(startedThreadId)
            setThreadModel(startedThreadId, requestedModel)
            if (workflowRunId) {
              setThreadActiveRun(startedThreadId, workflowRunId)
            }
            const resumed = codex.resumeThread(startedThreadId, {
              workingDirectory,
              model: requestedModel,
              skipGitRepoCheck
            })
            setRuntimeThread(startedThreadId, resumed)
          },
          onItemCompleted(item) {
            if (!firstAssistantText && item.type === 'agent_message' && item.text) {
              firstAssistantText = item.text.trim()
            }
          },
          onTurnCompleted(usage) {
            if (!resolvedThreadId) {
              return
            }
            recordThreadUsage(resolvedThreadId, usage)
          },
          buildTurnCompletedData(usage) {
            const durations = Object.fromEntries(reasoningDurations)
            return {
              kind: 'turn.completed',
              usage,
              durationMs: turnDurationMs ?? undefined,
              reasoningDurations: Object.keys(durations).length > 0 ? durations : undefined
            }
          },
          getReasoningEndMetadata(reasoningId) {
            const duration = reasoningDurations.get(reasoningId)
            if (typeof duration !== 'number') {
              return undefined
            }
            return {
              thinkingDurationMs: { value: duration }
            }
          }
        })

        const { events } = await thread.runStreamed(inputMessage)
        for await (const threadEvent of events) {
          const now = Date.now()

          if (threadEvent.type === 'turn.started') {
            turnStartedAt = now
          }

          if (threadEvent.type === 'item.completed' && threadEvent.item?.type === 'reasoning') {
            const duration = Math.max(0, now - reasoningWindowStartedAt)
            reasoningDurations.set(threadEvent.item.id, duration)
            // Fallback window start for consecutive reasoning items without an interleaving non-reasoning item.
            reasoningWindowStartedAt = now
            waitingForNextReasoningWindowStart = true
          }

          if (
            threadEvent.type === 'item.completed'
            && threadEvent.item?.type !== 'reasoning'
            && waitingForNextReasoningWindowStart
          ) {
            // Start next reasoning window right after the first non-reasoning item completes.
            reasoningWindowStartedAt = now
            waitingForNextReasoningWindowStart = false
          }

          if (threadEvent.type === 'turn.completed') {
            const startedAt = turnStartedAt ?? executeStartedAt
            turnDurationMs = now - startedAt
          }

          handleEvent(threadEvent)
        }

        if (turnDurationMs == null && turnStartedAt) {
          turnDurationMs = Math.max(0, Date.now() - turnStartedAt)
        }

        if (resolvedThreadId) {
          const assistantMessage = assistantBuilder.build()
          if (assistantMessage && reasoningDurations.size > 0) {
            for (const part of assistantMessage.parts) {
              if (part.type !== 'reasoning') {
                continue
              }
              const metadata = part.providerMetadata as { reasoningId?: unknown } | undefined
              const rawReasoningId = metadata?.reasoningId
              const reasoningId = typeof rawReasoningId === 'string'
                ? rawReasoningId
                : rawReasoningId && typeof rawReasoningId === 'object' && 'value' in rawReasoningId
                  ? (rawReasoningId as { value?: unknown }).value
                  : null
              if (typeof reasoningId !== 'string') {
                continue
              }
              const duration = reasoningDurations.get(reasoningId)
              if (duration == null) {
                continue
              }
              part.providerMetadata = {
                ...(part.providerMetadata ?? {}),
                thinkingDurationMs: { value: duration }
              }
            }
          }
          let nextMessages = assistantMessage ? [...baseMessages, assistantMessage] : baseMessages

          if (assistantMessage && !hasAssistantMessages(baseMessages)) {
            const existingTitle = getThreadTitle(resolvedThreadId)
            if (!existingTitle) {
              const userText = getFirstUserText(baseMessages)
              const assistantText = extractTextFromMessage(assistantMessage) || firstAssistantText
              if (userText && assistantText) {
                try {
                  const title = await generateThreadTitle(codex, userText, assistantText, skipGitRepoCheck)
                  if (title) {
                    const updatedAt = setThreadTitle(resolvedThreadId, title)
                    const titleEvent: CodexThreadEventData = {
                      kind: 'thread.title',
                      threadId: resolvedThreadId,
                      title,
                      updatedAt
                    }
                    const eventId = `event-title-${updatedAt}`
                    writer.write({
                      type: CODEX_EVENT_PART,
                      id: eventId,
                      data: titleEvent
                    })
                    assistantMessage.parts.push({
                      type: CODEX_EVENT_PART,
                      id: eventId,
                      data: titleEvent
                    })
                    nextMessages = [...baseMessages, assistantMessage]
                  }
                } catch (error) {
                  console.error(error)
                }
              }
            }
          }

          let finalMessages = nextMessages
          if (attachmentUploadId) {
            const moved = movePendingAttachments(attachmentUploadId, resolvedThreadId)
            if (moved && moved.size > 0) {
              finalMessages = rewriteAttachmentUrls(nextMessages, moved)
            }
          }

          saveThreadMessages(resolvedThreadId, finalMessages)
        }
      } finally {
        if (resolvedThreadId) {
          const endedAt = Date.now()
          const endedEvent: CodexThreadEventData = {
            kind: 'thread.ended',
            threadId: resolvedThreadId,
            endedAt
          }
          writer.write({
            type: CODEX_EVENT_PART,
            id: `event-ended-${endedAt}`,
            data: endedEvent,
            transient: true
          })
        }
        if (resolvedThreadId && workflowRunId) {
          clearThreadActiveRun(resolvedThreadId, workflowRunId)
        }
      }
    }
  })
}
