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
import {
  createSimpleChatgptCodexInput,
  runChatgptCodexTextResponse
} from '../../lib/chatgpt-codex-responses.ts'
import { ensureAgentBootstrap } from './agent-bootstrap.ts'
import { createCodexClient, resolveCodexClientMode } from './codex-client/index.ts'
import { getSharedAppServerProtocol } from './codex-client/app-server-protocol.ts'
import type { CodexClient, CodexInput } from './codex-client/types.ts'
import { createCodexAssistantBuilder } from './message-builder.ts'
import {
  clearThreadActiveRun,
  ensureThread,
  ensureThreadAttachmentsDirectory,
  ensureThreadRootDirectory,
  ensureThreadWorkingDirectory,
  getThreadOrigin,
  getPendingAttachmentsDirectory,
  getThreadConfig,
  getThreadTitle,
  recordThreadUsage,
  saveThreadMessages,
  setThreadActiveRunResumeIndex,
  setThreadOrigin,
  setThreadActiveRun,
  setThreadModel,
  setThreadTitle
} from './db.ts'
import {
  deleteRuntimeTurnControl,
  getRuntimeThread,
  getRuntimeTurnSteeringMessages,
  hasRuntimeThread,
  setRuntimeThread,
  setRuntimeTurnControl,
  updateRuntimeTurnControlThreadId
} from './runtime.ts'
import { buildCodexInput, createThreadEventHandler } from './stream.ts'
import { createSubagentPanelManager } from './subagent-panels.ts'
import { isAudioAttachment, transcribeAudioAttachment } from './audio-transcription.ts'

const TITLE_MODEL = 'gpt-5.4-mini'
const TITLE_REASONING_EFFORT = 'low'
const TITLE_MAX_LENGTH = 80
const DEFAULT_MODEL = 'gpt-5.4'
const MODEL_OPTIONS = new Set([
  'gpt-5.4',
  'gpt-5.3-codex',
  'gpt-5.2-codex',
  'gpt-5.2',
  'gpt-5.1-codex-mini'
])
const WORKFLOW_ROUTING_INTENT_PATTERN = /(?:\bworkflow\b|워크플로우|workflow[-\s]?dispatch|스케줄|schedule|cron|rrule|interval|자동화|자동 실행|정기 실행|반복 실행|run every|every\s+\d+\s*(?:sec|secs|second|seconds|min|mins|minute|minutes|hour|hours|day|days|week|weeks|month|months)|매(일|주|월|년|시간|분)|[0-9]+\s*(초|분|시간|일|주|개월)\s*마다)/i
const WORKFLOW_MANAGEMENT_ACTION_PATTERN = /(?:생성|만들|작성|추가|등록|수정|업데이트|편집|삭제|지워|목록|리스트|조회|보여줘|실행|보내|알려|요약|리포트|create|add|update|edit|delete|remove|list|show|inspect|write|run|send|notify|remind|summarize|report)/i
const WORKFLOW_NATIVE_TOOL = 'manageWorkflow'
const SHARED_MEMORY_NATIVE_TOOL = 'sharedMemory'
const WORKFLOW_ROUTING_MODE = resolveCodexClientMode(process.env.CORAZON_CODEX_CLIENT_MODE)
const APP_SERVER_NATIVE_TOOL_PREAMBLE = [
  '[Corazon native tool priority]',
  '- In this thread, assume Corazon dynamic tools are available.',
  '- For Corazon built-ins, use dynamic tools first and do not use skills unless a dynamic tool call fails.',
  '- Treat recurring or automated requests (for example: daily, weekly, monthly, recurring, or scheduled work) as workflow operations.',
  `- For workflow operations, use dynamic tool \`${WORKFLOW_NATIVE_TOOL}\` before skills.`,
  `- Prefer explicit \`${WORKFLOW_NATIVE_TOOL}\` commands: list/inspect/create/update/delete/dispatch.`,
  `- Use \`${WORKFLOW_NATIVE_TOOL}\` apply-text only for natural-language workflow authoring and draft extraction.`,
  '- Author workflow instructions as a detailed execution brief that fulfills user intent.',
  '- Include the goal, required context/resources, concrete execution steps, and expected output or completion criteria in the workflow instruction.',
  '- When the workflow deliverable has no fixed language requirement, follow the user\'s prompt language.',
  '- If reusable helper code, a custom executable, or long-lived operating guidance is required, create/update a supporting skill under `${CODEX_HOME}/skills` with `skill-creator` before finalizing the workflow, then include that skill in workflow skills.',
  '- If a standalone script is still necessary, place reusable scripts under `${CODEX_HOME}/scripts`.',
  '- Use `${CORAZON_THREADS_DIR}/<threadId>/...` only for thread-local artifacts when the concrete thread directory is known.',
  '- Never place scripts in `${CORAZON_THREADS_DIR}` itself or in shared directories such as `${CORAZON_THREADS_DIR}/scripts`.',
  `- For long-term memory operations, use dynamic tool \`${SHARED_MEMORY_NATIVE_TOOL}\` with \`search\` and \`upsert\` directly.`,
  '- Do not call `manage-workflows` or `shared-memory` skills preemptively. Use them only as explicit fallback after a dynamic tool failure.'
].join('\n')
const SDK_WORKFLOW_ROUTING_PREAMBLE = [
  '[Corazon workflow routing policy]',
  '- Treat recurring or automated requests (for example: daily, weekly, monthly, recurring, or scheduled work) as workflow-management requests.',
  '- For Corazon workflow management, use the `manage-workflows` skill.',
  '- For natural-language workflow authoring, extract a draft first and then apply explicit create/update/delete/list operations.',
  '- Author workflow instructions as a detailed execution brief that fulfills user intent, not meta instructions.',
  '- Include the goal, required context/resources, concrete execution steps, and expected output or completion criteria in the workflow instruction.',
  '- When the workflow deliverable has no fixed language requirement, follow the user\'s prompt language.',
  '- If reusable helper code, a custom executable, or long-lived operating guidance is required, create/update a supporting skill under `${CODEX_HOME}/skills` with `skill-creator` before finalizing the workflow, then include that skill in workflow skills.',
  '- If a standalone script is still necessary, place reusable scripts under `${CODEX_HOME}/scripts`.',
  '- Use `${CORAZON_THREADS_DIR}/<threadId>/...` only for thread-local artifacts when the concrete thread directory is known.',
  '- Never place scripts in `${CORAZON_THREADS_DIR}` itself or in shared directories such as `${CORAZON_THREADS_DIR}/scripts`.',
  '- Never use OS-level schedulers or external scheduler files (`crontab`, `systemd`, `launchd`) for Corazon workflow requests.',
  '- Apply workflow changes through Corazon workflow definitions (`workflows/*.md`) via Corazon workflow tooling.'
].join('\n')

const CODEX_CLIENT_CONFIG = {
  show_raw_agent_reasoning: true,
  approval_policy: 'never',
  sandbox_mode: 'danger-full-access'
} as const

let codexInstance: CodexClient | null = null

const getCodexEnv = () => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value
    }
  }
  env.CODEX_HOME = ensureAgentBootstrap()
  const runtimePaths = ensureCorazonRuntimeEnvironment()
  env.CORAZON_RUNTIME_ROOT_DIR = runtimePaths.runtimeRootDir
  env.CORAZON_THREADS_DIR = runtimePaths.threadsDir
  env.WORKFLOW_LOCAL_DATA_DIR = runtimePaths.workflowLocalDataDir
  return env
}

const getCodex = () => {
  if (codexInstance) {
    return codexInstance
  }

  codexInstance = createCodexClient({
    env: getCodexEnv(),
    config: CODEX_CLIENT_CONFIG
  })

  return codexInstance
}

const getAppServerProtocol = () =>
  getSharedAppServerProtocol({
    env: getCodexEnv(),
    config: CODEX_CLIENT_CONFIG
  })

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
  if (WORKFLOW_ROUTING_INTENT_PATTERN.test(source)) {
    return true
  }
  return /(?:\bworkflow\b|워크플로우)/i.test(source) && WORKFLOW_MANAGEMENT_ACTION_PATTERN.test(source)
}

const prependTextHint = (input: CodexInput, preamble: string, userText: string): CodexInput => {
  const normalizedUserText = userText.trim()
  const prefixedText = normalizedUserText
    ? `${preamble}\n\nUser request:\n${normalizedUserText}`
    : preamble
  if (typeof input === 'string') {
    return prefixedText
  }

  if (Array.isArray(input)) {
    return [
      { type: 'text', text: `${preamble}\n\nUser request follows:` },
      ...input
    ]
  }

  return input
}

const prependRoutingHint = (input: CodexInput, userText: string): CodexInput => {
  if (WORKFLOW_ROUTING_MODE === 'app-server') {
    return prependTextHint(input, APP_SERVER_NATIVE_TOOL_PREAMBLE, userText)
  }

  if (isWorkflowManagementIntent(userText)) {
    return prependTextHint(input, SDK_WORKFLOW_ROUTING_PREAMBLE, userText)
  }

  return input
}

const prependInputPrefix = (input: CodexInput, prefix: string): CodexInput => {
  const normalizedPrefix = prefix.trim()
  if (!normalizedPrefix) {
    return input
  }

  if (typeof input === 'string') {
    return `${normalizedPrefix}\n\n${input}`
  }

  if (Array.isArray(input)) {
    return [
      { type: 'text', text: `${normalizedPrefix}\n\nCurrent user message follows:` },
      ...input
    ]
  }

  return input
}

const mergeInputPrefixes = (...prefixes: Array<string | null | undefined>) =>
  prefixes
    .map(prefix => prefix?.trim() ?? '')
    .filter(Boolean)
    .join('\n\n')

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

const transcribeAudioAttachmentsInLatestUserMessage = async (messages: CodexUIMessage[]) => {
  if (!messages.length) {
    return messages
  }

  const latestUserIndex = [...messages].findLastIndex(message => message?.role === 'user')
  if (latestUserIndex < 0) {
    return messages
  }

  const latestUserMessage = messages[latestUserIndex]
  const parts = Array.isArray(latestUserMessage?.parts) ? latestUserMessage.parts : []
  if (!parts.length) {
    return messages
  }

  const transcriptParts = await Promise.all(parts.map(async (part) => {
    if (
      part?.type !== 'file'
      || typeof part.url !== 'string'
      || !isFileUrl(part.url)
      || !isAudioAttachment(part.mediaType)
    ) {
      return null
    }

    const transcript = await transcribeAudioAttachment({
      url: part.url,
      filename: part.filename,
      mediaType: part.mediaType
    })
    const filename = part.filename?.trim()

    return {
      type: 'text' as const,
      text: filename
        ? `[Audio transcript: ${filename}]\n${transcript}`
        : transcript
    }
  }))

  const resolvedTranscriptParts = transcriptParts.filter(part => part != null)
  if (resolvedTranscriptParts.length === 0) {
    return messages
  }

  const nextMessages = [...messages]
  nextMessages[latestUserIndex] = {
    ...latestUserMessage,
    parts: [...parts, ...resolvedTranscriptParts]
  } as CodexUIMessage
  return nextMessages
}

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
  userText: string,
  assistantText: string
) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await runChatgptCodexTextResponse({
      model: TITLE_MODEL,
      instructions: [
        'You are a concise title generator for chat threads.',
        'Create a short title based on the first user message and first assistant response.',
        'Use the same language as the user.',
        'Return only the title, with no quotes, bullets, or extra text.'
      ].join('\n'),
      input: createSimpleChatgptCodexInput(buildTitlePrompt(userText, assistantText)),
      reasoningEffort: TITLE_REASONING_EFFORT
    })
    const title = normalizeTitle(result.outputText ?? '')
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
  const inputPrefix = typeof input.inputPrefix === 'string' ? input.inputPrefix : ''
  const harnessInstructions = typeof input.harnessInstructions === 'string'
    ? input.harnessInstructions.trim()
    : ''
  const origin = input.origin === 'telegram' || input.origin === 'web' ? input.origin : null
  const originChannelId = typeof input.originChannelId === 'string' && input.originChannelId.trim()
    ? input.originChannelId.trim()
    : null
  const streamMode = input.streamMode === 'telegram' ? 'telegram' : 'web'
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
      const appServerProtocol = codex.mode === 'app-server' ? getAppServerProtocol() : null
      const subagentPanelManager = appServerProtocol
        ? createSubagentPanelManager({
            protocol: appServerProtocol,
            writer
          })
        : null
      const unsubscribeSubagentNotifications = subagentPanelManager?.subscribe() ?? null
      let resolvedThreadId: string | null = threadId
      const baseMessages = await transcribeAudioAttachmentsInLatestUserMessage(messages)
      let firstAssistantText = ''
      const executeStartedAt = Date.now()
      let turnStartedAt: number | null = null
      let turnDurationMs: number | null = null
      const reasoningDurations = new Map<string, number>()
      let reasoningWindowStartedAt = executeStartedAt
      let waitingForNextReasoningWindowStart = false
      let emittedChunkIndex = 0
      let lastPersistedChunkIndex = -1
      let persistSnapshotTimer: ReturnType<typeof setTimeout> | null = null
      let persistSnapshotChain = Promise.resolve()
      let hasSavedFinalMessages = false

      if (resolvedThreadId && workflowRunId) {
        setThreadActiveRun(resolvedThreadId, workflowRunId)
      }

      const buildCurrentMessagesSnapshot = () => {
        const steeringMessages = workflowRunId ? getRuntimeTurnSteeringMessages(workflowRunId) : []
        const assistantMessage = assistantBuilder.build()
        return assistantMessage
          ? [...baseMessages, ...steeringMessages, assistantMessage]
          : [...baseMessages, ...steeringMessages]
      }

      const persistActiveSnapshot = async () => {
        if (!resolvedThreadId || !workflowRunId) {
          return
        }

        const snapshotChunkIndex = emittedChunkIndex
        if (snapshotChunkIndex <= lastPersistedChunkIndex) {
          return
        }

        saveThreadMessages(resolvedThreadId, buildCurrentMessagesSnapshot())
        setThreadActiveRunResumeIndex(resolvedThreadId, workflowRunId, snapshotChunkIndex)
        lastPersistedChunkIndex = snapshotChunkIndex
      }

      const queuePersistActiveSnapshot = () => {
        if (!resolvedThreadId || !workflowRunId) {
          return
        }

        if (persistSnapshotTimer) {
          return
        }

        persistSnapshotTimer = setTimeout(() => {
          persistSnapshotTimer = null
          persistSnapshotChain = persistSnapshotChain
            .then(() => persistActiveSnapshot())
            .catch((error) => {
              console.error(error)
            })
        }, 120)
      }

      const originalWrite = writer.write.bind(writer)
      const writeChunk: typeof writer.write = (chunk) => {
        assistantBuilder.apply(chunk as InferUIMessageChunk<CodexUIMessage>)
        const result = originalWrite(chunk)
        emittedChunkIndex += 1
        queuePersistActiveSnapshot()
        return result
      }
      writer.write = writeChunk

      try {
        const thread = (() => {
          const developerInstructions = harnessInstructions || undefined
          if (threadId && hasRuntimeThread(threadId)) {
            return getRuntimeThread(threadId)!
          }
          if (threadId && shouldResume) {
            const resumed = codex.resumeThread(threadId, {
              workingDirectory: existingWorkdir ?? baseWorkdir,
              model: effectiveModel,
              skipGitRepoCheck,
              developerInstructions
            })
            setRuntimeThread(threadId, resumed)
            return resumed
          }
          return codex.startThread({
            workingDirectory: baseWorkdir,
            model: requestedModel,
            skipGitRepoCheck,
            developerInstructions
          })
        })()

        if (workflowRunId) {
          setRuntimeTurnControl({
            runId: workflowRunId,
            threadId: resolvedThreadId ?? thread.id,
            thread
          })
        }

        const effectiveInputPrefix = codex.mode === 'sdk'
          ? mergeInputPrefixes(harnessInstructions, inputPrefix)
          : inputPrefix

        const inputMessage = prependRoutingHint(
          prependInputPrefix(buildCodexInput(messages), effectiveInputPrefix),
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
            const existingOrigin = getThreadOrigin(startedThreadId)
            if (origin === 'telegram') {
              setThreadOrigin(startedThreadId, 'telegram', originChannelId)
            } else if (origin === 'web' && !existingOrigin?.origin) {
              setThreadOrigin(startedThreadId, 'web')
            }
            if (workflowRunId) {
              updateRuntimeTurnControlThreadId(workflowRunId, startedThreadId)
              setThreadActiveRun(startedThreadId, workflowRunId)
            }
            const resumed = codex.resumeThread(startedThreadId, {
              workingDirectory,
              model: requestedModel,
              skipGitRepoCheck,
              developerInstructions: harnessInstructions || undefined
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
          },
          emitProgressItems: streamMode !== 'telegram'
        })

        const { events } = await thread.runStreamed(inputMessage)
        for await (const threadEvent of events) {
          const now = Date.now()

          if (
            (threadEvent.type === 'item.started'
              || threadEvent.type === 'item.updated'
              || threadEvent.type === 'item.completed')
            && threadEvent.item.type === 'subagent_activity'
          ) {
            subagentPanelManager?.observeParentItem(threadEvent.item)
          }

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
          const steeringMessages = workflowRunId ? getRuntimeTurnSteeringMessages(workflowRunId) : []
          let nextMessages = assistantMessage
            ? [...baseMessages, ...steeringMessages, assistantMessage]
            : [...baseMessages, ...steeringMessages]

          if (assistantMessage && !hasAssistantMessages(baseMessages)) {
            const existingTitle = getThreadTitle(resolvedThreadId)
            if (!existingTitle) {
              const userText = getFirstUserText(baseMessages)
              const assistantText = extractTextFromMessage(assistantMessage) || firstAssistantText
              if (userText && assistantText) {
                try {
                  const title = await generateThreadTitle(userText, assistantText)
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
                    nextMessages = [...baseMessages, ...steeringMessages, assistantMessage]
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
          hasSavedFinalMessages = true
        }
      } finally {
        if (persistSnapshotTimer) {
          clearTimeout(persistSnapshotTimer)
          persistSnapshotTimer = null
        }
        await persistSnapshotChain
        if (!hasSavedFinalMessages) {
          await persistActiveSnapshot()
        }

        unsubscribeSubagentNotifications?.()
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
        if (workflowRunId) {
          deleteRuntimeTurnControl(workflowRunId)
        }
      }
    }
  })
}
