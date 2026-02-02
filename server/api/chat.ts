import { Codex } from '@openai/codex-sdk'
import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { Thread } from '@openai/codex-sdk'
import {
  CODEX_EVENT_PART,
  type CodexThreadEventData,
  type CodexUIMessage
} from '@@/types/codex-ui'
import type { InferUIMessageChunk } from 'ai'
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai'
import type { H3Event } from 'h3'

const TITLE_MODEL = 'gpt-5.1-codex-mini'
const TITLE_REASONING_EFFORT = 'low'
const TITLE_MAX_LENGTH = 80
const TITLE_WORKDIR = '/tmp'
const DEFAULT_MODEL = 'gpt-5.2-codex'
const MODEL_OPTIONS = new Set([
  'gpt-5.2-codex',
  'gpt-5.2',
  'gpt-5.1-codex-mini'
])

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

const hasAssistantMessages = (messages: CodexUIMessage[]) =>
  messages.some(message => message?.role === 'assistant')

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
  codex: Codex,
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

export default defineLazyEventHandler(async () => {
  const threads = new Map<string, Thread>()
  const codex = new Codex({
    env: {
      PATH: '/tmp'
    },
    config: {
      show_raw_agent_reasoning: true,
      sandbox_workspace_write: { network_access: true }
    }
  })

  return defineEventHandler(async (event: H3Event) => {
    const body = await readBody(event)
    const threadId = body?.threadId as string | undefined
    const shouldResume = body?.resume === true
    const attachmentUploadId = typeof body?.attachmentUploadId === 'string'
      ? body.attachmentUploadId
      : null
    const skipGitRepoCheck = body?.skipGitRepoCheck === true
    const requestedModel = resolveModel(body?.model)
    const messages = (body?.messages ?? []) as CodexUIMessage[]
    const threadConfig = threadId ? getThreadConfig(threadId) : null
    const effectiveModel = threadConfig?.model ?? requestedModel
    const baseWorkdir = ensureThreadRootDirectory()
    const existingWorkdir = threadId ? ensureThreadWorkingDirectory(threadId) : null

    const stream = createUIMessageStream<CodexUIMessage>({
      async execute({ writer }) {
        const assistantBuilder = createCodexAssistantBuilder()
        let resolvedThreadId: string | null = threadId ?? null
        const baseMessages = messages
        let firstAssistantText = ''
        const executeStartedAt = Date.now()
        let turnStartedAt: number | null = null
        let turnDurationMs: number | null = null
        const reasoningStartedAt = new Map<string, number>()
        const reasoningDurations = new Map<string, number>()

        const originalWrite = writer.write.bind(writer)
        const writeChunk: typeof writer.write = (chunk) => {
          assistantBuilder.apply(chunk as InferUIMessageChunk<CodexUIMessage>)
          return originalWrite(chunk)
        }
        writer.write = writeChunk

        const thread = (() => {
          if (threadId && threads.has(threadId)) {
            return threads.get(threadId)!
          }
          if (threadId && shouldResume) {
            const resumed = codex.resumeThread(threadId, {
              workingDirectory: existingWorkdir ?? baseWorkdir,
              model: effectiveModel,
              skipGitRepoCheck
            })
            threads.set(threadId, resumed)
            return resumed
          }
          return codex.startThread({
            workingDirectory: baseWorkdir,
            model: requestedModel,
            skipGitRepoCheck
          })
        })()

        const input = buildCodexInput(messages)

        if (!input || (Array.isArray(input) && input.length === 0)) {
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
            const resumed = codex.resumeThread(startedThreadId, {
              workingDirectory,
              model: requestedModel,
              skipGitRepoCheck
            })
            threads.set(startedThreadId, resumed)
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
          }
        })
        const { events } = await thread.runStreamed(input)
        for await (const threadEvent of events) {
          if (threadEvent.type === 'item.started' && threadEvent.item?.type === 'reasoning') {
            reasoningStartedAt.set(threadEvent.item.id, Date.now())
          }
          if (threadEvent.type === 'item.completed' && threadEvent.item?.type === 'reasoning') {
            const startedAt = reasoningStartedAt.get(threadEvent.item.id)
            const endedAt = Date.now()
            if (startedAt) {
              reasoningDurations.set(threadEvent.item.id, Math.max(0, endedAt - startedAt))
            }
          }
          if (threadEvent.type === 'turn.started') {
            turnStartedAt = Date.now()
          }
          if (threadEvent.type === 'turn.completed') {
            const endedAt = Date.now()
            const startedAt = turnStartedAt ?? executeStartedAt
            turnDurationMs = endedAt - startedAt
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
              const metadata = part.providerMetadata as { reasoningId?: string } | undefined
              const reasoningId = metadata?.reasoningId
              if (!reasoningId) {
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
      }
    })

    return createUIMessageStreamResponse({
      stream,
      status: 200
    })
  })
})
