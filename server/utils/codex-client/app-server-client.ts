import type { ServerNotification } from '@@/types/codex-app-server/ServerNotification'
import type { ThreadStartResponse } from '@@/types/codex-app-server/v2/ThreadStartResponse'
import type { ThreadResumeResponse } from '@@/types/codex-app-server/v2/ThreadResumeResponse'
import type { ThreadItem as AppServerThreadItem } from '@@/types/codex-app-server/v2/ThreadItem'
import type { TurnSteerResponse } from '@@/types/codex-app-server/v2/TurnSteerResponse'
import type { TurnStartResponse } from '@@/types/codex-app-server/v2/TurnStartResponse'
import type { UserInput as AppServerUserInput } from '@@/types/codex-app-server/v2/UserInput'
import type { AppServerProtocol } from './app-server-protocol.ts'
import { getSharedAppServerProtocol } from './app-server-protocol.ts'
import { getNativeDynamicToolSpecs } from './native-tools.ts'
import type {
  CodexClient,
  CodexClientInitOptions,
  CodexInput,
  CodexThreadClient,
  CodexThreadControlResult,
  CodexThreadEvent,
  CodexThreadItem,
  CodexThreadOptions,
  CodexTurn,
  CodexTurnOptions,
  CodexUsage
} from './types.ts'

type QueueResolver<T> = (value: IteratorResult<T>) => void
type QueueRejecter = (error: unknown) => void

const emptyUsage = (): CodexUsage => ({
  input_tokens: 0,
  cached_input_tokens: 0,
  output_tokens: 0
})

class AsyncEventQueue<T> {
  private values: T[] = []

  private resolvers: Array<{ resolve: QueueResolver<T>, reject: QueueRejecter }> = []

  private closed = false

  private error: Error | null = null

  push(value: T) {
    if (this.closed || this.error) {
      return
    }

    const resolver = this.resolvers.shift()
    if (resolver) {
      resolver.resolve({ value, done: false })
      return
    }

    this.values.push(value)
  }

  close() {
    if (this.closed || this.error) {
      return
    }

    this.closed = true
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()
      resolver?.resolve({ value: undefined as T, done: true })
    }
  }

  fail(error: unknown) {
    if (this.closed || this.error) {
      return
    }

    this.error = error instanceof Error ? error : new Error(String(error))
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()
      resolver?.reject(this.error)
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.error) {
      throw this.error
    }

    if (this.values.length > 0) {
      const value = this.values.shift() as T
      return { value, done: false }
    }

    if (this.closed) {
      return { value: undefined as T, done: true }
    }

    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.resolvers.push({
        resolve: (result) => {
          if (this.error) {
            reject(this.error)
            return
          }
          resolve(result)
        },
        reject
      })
    })
  }

  async return(): Promise<IteratorResult<T>> {
    this.close()
    return { value: undefined as T, done: true }
  }

  async throw(error?: unknown): Promise<IteratorResult<T>> {
    this.fail(error ?? new Error('Async queue was interrupted.'))
    throw this.error
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this
  }
}

const toEventStream = async function* <T>(
  source: AsyncEventQueue<T>,
  onFinally?: () => void
): AsyncGenerator<T> {
  try {
    for await (const event of source) {
      yield event
    }
  } finally {
    onFinally?.()
  }
}

const toSandboxMode = (mode: CodexThreadOptions['sandboxMode']) => mode ?? null

const toApprovalPolicy = (policy: CodexThreadOptions['approvalPolicy']) => policy ?? null

const NATIVE_TOOL_PRIORITY_DEVELOPER_INSTRUCTIONS = [
  '[Corazon native tool priority]',
  '- Assume Corazon dynamic tools are available in the current thread.',
  '- For Corazon built-ins, use dynamic tools first and do not use skills unless a dynamic tool call fails.',
  '- Treat recurring or automated requests (for example: daily, weekly, monthly, recurring, or scheduled work) as workflow operations.',
  '- For workflow operations, prefer dynamic tool `manageWorkflow` before the `manage-workflows` skill.',
  '- Prefer explicit workflow commands: `list`, `inspect`, `create`, `update`, `delete`.',
  '- Use `apply-text` only for natural-language workflow authoring and draft extraction.',
  '- When authoring workflows, capture the user intent as a detailed execution brief.',
  '- Include the goal, required context/resources, concrete execution steps, and expected output or completion criteria in the workflow instruction.',
  '- If needed capability is missing, create/prepare supporting skills/tools first and include them in workflow skills.',
  '- For long-term memory operations, prefer dynamic tool `sharedMemory` with `search` and `upsert` directly before the `shared-memory` skill.',
  '- Do not call `manage-workflows` or `shared-memory` skills preemptively. Use them only as explicit fallback after a dynamic tool failure.'
].join('\n')

const mergeDeveloperInstructions = (value?: string | null) => {
  const custom = typeof value === 'string' ? value.trim() : ''
  return custom
    ? `${NATIVE_TOOL_PRIORITY_DEVELOPER_INSTRUCTIONS}\n\n${custom}`
    : NATIVE_TOOL_PRIORITY_DEVELOPER_INSTRUCTIONS
}

const toThreadConfig = (options: CodexThreadOptions) => {
  const config: Record<string, unknown> = {}

  if (options.skipGitRepoCheck) {
    config.skip_git_repo_check = true
  }

  if (options.modelReasoningEffort) {
    config.model_reasoning_effort = options.modelReasoningEffort
  }

  if (options.networkAccessEnabled !== undefined) {
    config.sandbox_workspace_write = {
      network_access: options.networkAccessEnabled
    }
  }

  if (options.webSearchMode) {
    config.web_search = options.webSearchMode
  } else if (options.webSearchEnabled === true) {
    config.web_search = 'live'
  } else if (options.webSearchEnabled === false) {
    config.web_search = 'disabled'
  }

  if (options.additionalDirectories && options.additionalDirectories.length > 0) {
    config.additional_directories = options.additionalDirectories
  }

  return Object.keys(config).length > 0 ? config : null
}

const toTurnInput = (input: CodexInput): AppServerUserInput[] => {
  if (typeof input === 'string') {
    return [{
      type: 'text',
      text: input,
      text_elements: []
    }]
  }

  const mapped: AppServerUserInput[] = []

  for (const part of input) {
    if (part.type === 'text') {
      mapped.push({
        type: 'text',
        text: part.text,
        text_elements: []
      })
      continue
    }

    if (part.type === 'local_image') {
      mapped.push({
        type: 'localImage',
        path: part.path
      })
    }
  }

  return mapped
}

const normalizeCommandStatus = (status: string): Extract<CodexThreadItem, { type: 'command_execution' }>['status'] => {
  if (status === 'inProgress') {
    return 'in_progress'
  }
  if (status === 'completed') {
    return 'completed'
  }
  return 'failed'
}

const normalizeMcpStatus = (status: string): Extract<CodexThreadItem, { type: 'mcp_tool_call' }>['status'] => {
  if (status === 'inProgress') {
    return 'in_progress'
  }
  if (status === 'completed') {
    return 'completed'
  }
  return 'failed'
}

const normalizeFileChangeStatus = (status: string): Extract<CodexThreadItem, { type: 'file_change' }>['status'] => {
  if (status === 'inProgress') {
    // The app-server reports non-terminal patch state before the SDK file-change types catch up.
    return 'in_progress' as Extract<CodexThreadItem, { type: 'file_change' }>['status']
  }
  if (status === 'completed') {
    return 'completed'
  }
  return 'failed'
}

const normalizePatchChangeKind = (
  kind: unknown
): Extract<CodexThreadItem, { type: 'file_change' }>['changes'][number]['kind'] => {
  if (typeof kind === 'object' && kind && 'type' in kind) {
    const value = (kind as { type?: unknown }).type
    if (value === 'add' || value === 'delete' || value === 'update') {
      return value
    }
  }
  return 'update'
}

const normalizeDynamicStatus = (status: string): Extract<CodexThreadItem, { type: 'command_execution' }>['status'] => {
  if (status === 'inProgress') {
    return 'in_progress'
  }
  if (status === 'completed') {
    return 'completed'
  }
  return 'failed'
}

const normalizeDynamicPatchStatus = (
  status: string,
  success: boolean | null
): Extract<CodexThreadItem, { type: 'file_change' }>['status'] => {
  if (status === 'failed' || success === false) {
    return 'failed'
  }
  return 'completed'
}

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const getStringField = (value: unknown, key: string): string | null => {
  if (!isObjectRecord(value)) {
    return null
  }

  const field = value[key]
  return typeof field === 'string' ? field : null
}

const isExecCommandTool = (tool: string) => {
  const value = tool.trim().toLowerCase()
  return value === 'exec_command' || value === 'command/exec' || value.endsWith('/exec_command')
}

const isApplyPatchTool = (tool: string) => {
  const value = tool.trim().toLowerCase()
  return value === 'apply_patch' || value.endsWith('/apply_patch')
}

const toDynamicContentText = (
  contentItems: Array<{ type: 'inputText', text: string } | { type: 'inputImage', imageUrl: string }> | null
) =>
  (contentItems ?? [])
    .map(item => item.type === 'inputText' ? item.text : `[image] ${item.imageUrl}`)
    .join('\n')
    .trim()

const toUsage = (notification: ServerNotification): CodexUsage | null => {
  if (notification.method !== 'thread/tokenUsage/updated') {
    return null
  }

  return {
    input_tokens: notification.params.tokenUsage.last.inputTokens,
    cached_input_tokens: notification.params.tokenUsage.last.cachedInputTokens,
    output_tokens: notification.params.tokenUsage.last.outputTokens
  }
}

const toThreadItem = (
  raw: AppServerThreadItem,
  previous?: CodexThreadItem | null
): CodexThreadItem | null => {
  switch (raw.type) {
    case 'agentMessage':
      return {
        id: raw.id,
        type: 'agent_message',
        text: raw.text
      }
    case 'reasoning': {
      const summaryText = raw.summary.join('\n')
      const contentText = raw.content.join('\n')
      const text = [summaryText, contentText].filter(Boolean).join('\n').trim()
      const previousText = previous?.type === 'reasoning' ? previous.text : ''
      return {
        id: raw.id,
        type: 'reasoning',
        text: text || previousText
      }
    }
    case 'commandExecution':
      return {
        id: raw.id,
        type: 'command_execution',
        command: raw.command,
        aggregated_output: raw.aggregatedOutput ?? (previous?.type === 'command_execution' ? previous.aggregated_output : ''),
        exit_code: typeof raw.exitCode === 'number' ? raw.exitCode : undefined,
        status: normalizeCommandStatus(raw.status)
      }
    case 'fileChange':
      return {
        id: raw.id,
        type: 'file_change',
        changes: (raw.changes ?? []).map(change => ({
          path: change.path,
          kind: normalizePatchChangeKind(change.kind),
          diff: typeof change.diff === 'string' ? change.diff : undefined
        })),
        status: normalizeFileChangeStatus(raw.status)
      }
    case 'mcpToolCall':
      return {
        id: raw.id,
        type: 'mcp_tool_call',
        server: raw.server,
        tool: raw.tool,
        arguments: raw.arguments,
        result: raw.result
          ? {
              content: raw.result.content as unknown[],
              structured_content: raw.result.structuredContent
            }
          : undefined,
        error: raw.error ? { message: raw.error.message } : undefined,
        status: normalizeMcpStatus(raw.status)
      }
    case 'dynamicToolCall': {
      if (isExecCommandTool(raw.tool)) {
        return {
          id: raw.id,
          type: 'command_execution',
          command: getStringField(raw.arguments, 'command')
            ?? getStringField(raw.arguments, 'cmd')
            ?? raw.tool,
          aggregated_output: toDynamicContentText(raw.contentItems)
            || (previous?.type === 'command_execution' ? previous.aggregated_output : ''),
          status: normalizeDynamicStatus(raw.status)
        }
      }

      if (isApplyPatchTool(raw.tool)) {
        return {
          id: raw.id,
          type: 'file_change',
          changes: previous?.type === 'file_change' ? previous.changes : [],
          status: normalizeDynamicPatchStatus(raw.status, raw.success)
        }
      }

      return {
        id: raw.id,
        type: 'mcp_tool_call',
        server: 'dynamic',
        tool: raw.tool,
        arguments: raw.arguments,
        result: raw.contentItems
          ? {
              content: [],
              structured_content: {
                success: raw.success,
                contentItems: raw.contentItems
              }
            }
          : undefined,
        error: raw.success === false ? { message: 'Dynamic tool call failed.' } : undefined,
        status: normalizeMcpStatus(raw.status)
      }
    }
    case 'collabAgentToolCall':
      return {
        id: raw.id,
        type: 'mcp_tool_call',
        server: 'collab',
        tool: raw.tool,
        arguments: {
          senderThreadId: raw.senderThreadId,
          receiverThreadIds: raw.receiverThreadIds,
          prompt: raw.prompt
        },
        result: {
          content: [],
          structured_content: {
            agentsStates: raw.agentsStates
          }
        },
        status: normalizeMcpStatus(raw.status)
      }
    case 'webSearch':
      return {
        id: raw.id,
        type: 'web_search',
        query: raw.query
      }
    default:
      return null
  }
}

const appendItemDelta = (previous: CodexThreadItem, delta: string): CodexThreadItem => {
  if (previous.type === 'agent_message') {
    return {
      ...previous,
      text: `${previous.text}${delta}`
    }
  }

  if (previous.type === 'reasoning') {
    return {
      ...previous,
      text: `${previous.text}${delta}`
    }
  }

  if (previous.type === 'command_execution') {
    return {
      ...previous,
      aggregated_output: `${previous.aggregated_output}${delta}`
    }
  }

  return previous
}

const notificationTurnId = (notification: ServerNotification): string | null => {
  const params = notification.params as { turnId?: unknown, turn?: { id?: unknown } } | undefined
  const direct = params?.turnId
  if (typeof direct === 'string') {
    return direct
  }

  const fromTurn = params?.turn?.id
  if (typeof fromTurn === 'string') {
    return fromTurn
  }

  return null
}

const notificationThreadId = (notification: ServerNotification): string | null => {
  const params = notification.params as { threadId?: unknown } | undefined
  return typeof params?.threadId === 'string' ? params.threadId : null
}

class AppServerThreadClient implements CodexThreadClient {
  readonly mode = 'app-server' as const

  private threadId: string | null

  private readonly options: CodexThreadOptions

  private readonly protocol: AppServerProtocol

  private activeTurnId: string | null = null

  private turnState: 'idle' | 'starting' | 'active' = 'idle'

  private pendingInterrupt = false

  private pendingSteers: CodexInput[] = []

  constructor(protocol: AppServerProtocol, threadId: string | null, options: CodexThreadOptions) {
    this.protocol = protocol
    this.threadId = threadId
    this.options = options
  }

  get id() {
    return this.threadId
  }

  async interruptActiveTurn(): Promise<CodexThreadControlResult> {
    if (this.turnState === 'starting') {
      this.pendingInterrupt = true
      this.pendingSteers = []
      return {
        ok: true,
        queued: true
      }
    }

    if (!this.threadId || !this.activeTurnId || this.turnState !== 'active') {
      return {
        ok: false,
        reason: 'no_active_turn'
      }
    }

    await this.protocol.request('turn/interrupt', {
      threadId: this.threadId,
      turnId: this.activeTurnId
    })
    return {
      ok: true,
      turnId: this.activeTurnId
    }
  }

  async steerActiveTurn(input: CodexInput): Promise<CodexThreadControlResult> {
    if (this.turnState === 'starting') {
      this.pendingInterrupt = false
      this.pendingSteers.push(input)
      return {
        ok: true,
        queued: true
      }
    }

    if (!this.threadId || !this.activeTurnId || this.turnState !== 'active') {
      return {
        ok: false,
        reason: 'no_active_turn'
      }
    }

    const response = await this.protocol.request<TurnSteerResponse>('turn/steer', {
      threadId: this.threadId,
      input: toTurnInput(input),
      expectedTurnId: this.activeTurnId
    })
    this.activeTurnId = response.turnId
    return {
      ok: true,
      turnId: response.turnId
    }
  }

  private clearActiveTurnState() {
    this.activeTurnId = null
    this.turnState = 'idle'
    this.pendingInterrupt = false
    this.pendingSteers = []
  }

  private async flushPendingTurnControls() {
    if (this.turnState !== 'active') {
      return
    }

    if (this.pendingInterrupt) {
      this.pendingInterrupt = false
      this.pendingSteers = []
      await this.interruptActiveTurn()
      return
    }

    while (this.pendingSteers.length > 0) {
      const nextInput = this.pendingSteers.shift()
      if (!nextInput) {
        continue
      }
      const result = await this.steerActiveTurn(nextInput)
      if (!result.ok) {
        break
      }
    }
  }

  private async ensureThread(queue: AsyncEventQueue<CodexThreadEvent>) {
    if (!this.threadId) {
      const started = await this.protocol.request<ThreadStartResponse>('thread/start', {
        model: this.options.model ?? null,
        cwd: this.options.workingDirectory ?? null,
        approvalPolicy: toApprovalPolicy(this.options.approvalPolicy),
        sandbox: toSandboxMode(this.options.sandboxMode),
        config: toThreadConfig(this.options),
        developerInstructions: mergeDeveloperInstructions(this.options.developerInstructions),
        dynamicTools: getNativeDynamicToolSpecs(),
        experimentalRawEvents: false,
        persistExtendedHistory: false
      })
      this.threadId = started.thread.id
      queue.push({
        type: 'thread.started',
        thread_id: this.threadId
      })
      return
    }

    await this.protocol.request<ThreadResumeResponse>('thread/resume', {
      threadId: this.threadId,
      model: this.options.model ?? null,
      cwd: this.options.workingDirectory ?? null,
      approvalPolicy: toApprovalPolicy(this.options.approvalPolicy),
      sandbox: toSandboxMode(this.options.sandboxMode),
      config: toThreadConfig(this.options),
      developerInstructions: mergeDeveloperInstructions(this.options.developerInstructions),
      persistExtendedHistory: false
    })
  }

  async runStreamed(
    input: CodexInput,
    turnOptions: CodexTurnOptions = {}
  ): Promise<{ events: AsyncGenerator<CodexThreadEvent> }> {
    const queue = new AsyncEventQueue<CodexThreadEvent>()
    const itemState = new Map<string, CodexThreadItem>()
    let lastUsage = emptyUsage()
    const bufferedNotifications: ServerNotification[] = []
    let abortHandler: (() => void) | null = null
    this.turnState = 'starting'
    this.activeTurnId = null
    this.pendingInterrupt = false
    this.pendingSteers = []

    try {
      await this.ensureThread(queue)
    } catch (error) {
      this.clearActiveTurnState()
      queue.fail(error)
      return { events: toEventStream(queue) }
    }

    const currentThreadId = this.threadId
    if (!currentThreadId) {
      this.clearActiveTurnState()
      queue.fail(new Error('Failed to resolve thread id for app-server turn.'))
      return { events: toEventStream(queue) }
    }

    const processNotification = (notification: ServerNotification) => {
      if (notificationThreadId(notification) !== currentThreadId) {
        return
      }

      if (!this.activeTurnId) {
        bufferedNotifications.push(notification)
        return
      }

      const turnId = notificationTurnId(notification)
      if (turnId && turnId !== this.activeTurnId) {
        return
      }

      const usage = toUsage(notification)
      if (usage) {
        lastUsage = usage
        return
      }

      switch (notification.method) {
        case 'item/started': {
          const item = toThreadItem(notification.params.item)
          if (!item) {
            return
          }
          itemState.set(item.id, item)
          queue.push({ type: 'item.started', item })
          return
        }
        case 'item/completed': {
          const previous = itemState.get(notification.params.item.id) ?? null
          const item = toThreadItem(notification.params.item, previous)
          if (!item) {
            return
          }
          itemState.set(item.id, item)
          queue.push({ type: 'item.completed', item })
          return
        }
        case 'item/agentMessage/delta':
        case 'item/reasoning/summaryTextDelta':
        case 'item/reasoning/textDelta':
        case 'item/commandExecution/outputDelta':
        case 'item/fileChange/outputDelta':
        case 'item/mcpToolCall/progress': {
          const itemId = notification.params.itemId
          const previous = itemState.get(itemId)
          const seed = previous ?? (() => {
            switch (notification.method) {
              case 'item/agentMessage/delta':
                return {
                  id: itemId,
                  type: 'agent_message',
                  text: ''
                } as CodexThreadItem
              case 'item/reasoning/summaryTextDelta':
              case 'item/reasoning/textDelta':
                return {
                  id: itemId,
                  type: 'reasoning',
                  text: ''
                } as CodexThreadItem
              case 'item/commandExecution/outputDelta':
                return {
                  id: itemId,
                  type: 'command_execution',
                  command: 'command',
                  aggregated_output: '',
                  status: 'in_progress'
                } as CodexThreadItem
              case 'item/mcpToolCall/progress':
                return {
                  id: itemId,
                  type: 'mcp_tool_call',
                  server: 'mcp',
                  tool: 'tool',
                  arguments: {},
                  status: 'in_progress'
                } as CodexThreadItem
              default:
                return null
            }
          })()

          if (seed && !previous) {
            itemState.set(seed.id, seed)
            queue.push({ type: 'item.started', item: seed })
          }

          const base = itemState.get(itemId)
          if (!base) {
            return
          }

          if (notification.method === 'item/fileChange/outputDelta') {
            if (base.type !== 'file_change') {
              return
            }
            queue.push({ type: 'item.updated', item: base })
            return
          }

          if (notification.method === 'item/mcpToolCall/progress') {
            if (base.type !== 'mcp_tool_call') {
              return
            }

            const structured = isObjectRecord(base.result?.structured_content)
              ? base.result.structured_content
              : {}
            const progressLines = Array.isArray(structured.progress) ? structured.progress : []
            const next: CodexThreadItem = {
              ...base,
              result: {
                content: [],
                structured_content: {
                  ...structured,
                  progress: [...progressLines, notification.params.message]
                }
              }
            }

            itemState.set(next.id, next)
            queue.push({ type: 'item.updated', item: next })
            return
          }

          const delta = notification.params.delta
          const next = appendItemDelta(base, delta)
          itemState.set(next.id, next)
          queue.push({ type: 'item.updated', item: next })
          return
        }
        case 'error':
          this.clearActiveTurnState()
          queue.push({
            type: 'error',
            message: notification.params.error.message
          })
          return
        case 'turn/completed':
          this.clearActiveTurnState()
          if (notification.params.turn.status === 'failed' || notification.params.turn.status === 'interrupted') {
            queue.push({
              type: 'turn.failed',
              error: {
                message: notification.params.turn.error?.message
                  ?? (notification.params.turn.status === 'interrupted'
                    ? 'Codex turn was interrupted.'
                    : 'Codex turn failed.')
              }
            })
          } else {
            queue.push({
              type: 'turn.completed',
              usage: lastUsage
            })
          }
          queue.close()
      }
    }

    const unsubscribe = this.protocol.subscribe((notification) => {
      processNotification(notification)
    })
    const unsubscribeClose = this.protocol.onClose((error) => {
      this.clearActiveTurnState()
      queue.fail(error)
    })

    try {
      const turnStart = await this.protocol.request<TurnStartResponse>('turn/start', {
        threadId: currentThreadId,
        input: toTurnInput(input),
        outputSchema: turnOptions.outputSchema,
        model: this.options.model ?? null,
        cwd: this.options.workingDirectory ?? null,
        approvalPolicy: toApprovalPolicy(this.options.approvalPolicy),
        effort: this.options.modelReasoningEffort ?? null
      })

      this.activeTurnId = turnStart.turn.id
      this.turnState = 'active'
      queue.push({ type: 'turn.started' })

      await this.flushPendingTurnControls()

      if (bufferedNotifications.length > 0) {
        for (const notification of bufferedNotifications.splice(0, bufferedNotifications.length)) {
          processNotification(notification)
        }
      }

      if (turnOptions.signal) {
        abortHandler = () => {
          void this.interruptActiveTurn().catch(() => {})
        }

        if (turnOptions.signal.aborted) {
          abortHandler()
        } else {
          turnOptions.signal.addEventListener('abort', abortHandler, { once: true })
        }
      }
    } catch (error) {
      this.clearActiveTurnState()
      unsubscribe()
      unsubscribeClose()
      queue.fail(error)
      return { events: toEventStream(queue) }
    }

    const events = toEventStream(queue, () => {
      this.clearActiveTurnState()
      if (turnOptions.signal && abortHandler) {
        turnOptions.signal.removeEventListener('abort', abortHandler)
      }
      unsubscribe()
      unsubscribeClose()
    })

    return { events }
  }

  async run(input: CodexInput, turnOptions: CodexTurnOptions = {}): Promise<CodexTurn> {
    const { events } = await this.runStreamed(input, turnOptions)
    const items: CodexThreadItem[] = []
    let finalResponse = ''
    let usage: CodexUsage | null = null
    let turnFailure: string | null = null

    for await (const event of events) {
      if (event.type === 'item.completed') {
        items.push(event.item)
        if (event.item.type === 'agent_message') {
          finalResponse = event.item.text
        }
      }

      if (event.type === 'turn.completed') {
        usage = event.usage
      }

      if (event.type === 'turn.failed') {
        turnFailure = event.error.message
        break
      }
    }

    if (turnFailure) {
      throw new Error(turnFailure)
    }

    return {
      items,
      finalResponse,
      usage
    }
  }
}

export const createAppServerCodexClient = (options: CodexClientInitOptions): CodexClient => {
  const protocol = getSharedAppServerProtocol({
    env: options.env,
    config: options.config
  })

  return {
    mode: 'app-server',
    startThread(threadOptions: CodexThreadOptions = {}) {
      return new AppServerThreadClient(protocol, null, threadOptions)
    },
    resumeThread(threadId: string, threadOptions: CodexThreadOptions = {}) {
      return new AppServerThreadClient(protocol, threadId, threadOptions)
    }
  }
}
