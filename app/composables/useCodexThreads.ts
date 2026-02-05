export type CodexThreadSummary = {
  id: string
  title: string | null
  model: string | null
  workingDirectory: string | null
  createdAt: number
  updatedAt: number
  turnCount: number
  totalInputTokens: number
  totalCachedInputTokens: number
  totalOutputTokens: number
}

const sortThreads = (items: CodexThreadSummary[]) =>
  items.slice().sort((a, b) => b.updatedAt - a.updatedAt)

export const useCodexThreads = () => {
  const threads = useState<CodexThreadSummary[]>('codex-thread-list', () => [])
  const loaded = useState('codex-thread-list-loaded', () => false)

  const refreshThreads = async () => {
    try {
      const data = await $fetch<CodexThreadSummary[]>('/api/chat/threads', {
        cache: 'no-store'
      })
      if (Array.isArray(data)) {
        threads.value = sortThreads(data)
        loaded.value = true
      }
    } catch (error) {
      console.error(error)
    }
  }

  const upsertThread = (thread: Partial<CodexThreadSummary> & { id: string }) => {
    const existing = threads.value.find(item => item.id === thread.id)
    const now = Date.now()
    const next: CodexThreadSummary = {
      id: thread.id,
      title: thread.title ?? existing?.title ?? null,
      model: thread.model ?? existing?.model ?? null,
      workingDirectory: thread.workingDirectory ?? existing?.workingDirectory ?? null,
      createdAt: thread.createdAt ?? existing?.createdAt ?? now,
      updatedAt: thread.updatedAt ?? existing?.updatedAt ?? now,
      turnCount: thread.turnCount ?? existing?.turnCount ?? 0,
      totalInputTokens: thread.totalInputTokens ?? existing?.totalInputTokens ?? 0,
      totalCachedInputTokens: thread.totalCachedInputTokens ?? existing?.totalCachedInputTokens ?? 0,
      totalOutputTokens: thread.totalOutputTokens ?? existing?.totalOutputTokens ?? 0
    }

    const filtered = threads.value.filter(item => item.id !== thread.id)
    threads.value = sortThreads([next, ...filtered])
  }

  const setThreadTitle = (threadId: string, title: string, updatedAt?: number) => {
    upsertThread({ id: threadId, title, updatedAt })
  }

  const applyTurnUsage = (threadId: string, usage: {
    input_tokens: number
    cached_input_tokens: number
    output_tokens: number
  }) => {
    const existing = threads.value.find(thread => thread.id === threadId)
    const now = Date.now()
    const next: CodexThreadSummary = {
      id: threadId,
      title: existing?.title ?? null,
      model: existing?.model ?? null,
      workingDirectory: existing?.workingDirectory ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      turnCount: (existing?.turnCount ?? 0) + 1,
      totalInputTokens: (existing?.totalInputTokens ?? 0) + usage.input_tokens,
      totalCachedInputTokens: (existing?.totalCachedInputTokens ?? 0) + usage.cached_input_tokens,
      totalOutputTokens: (existing?.totalOutputTokens ?? 0) + usage.output_tokens
    }

    const filtered = threads.value.filter(thread => thread.id !== threadId)
    threads.value = sortThreads([next, ...filtered])
  }

  return {
    threads,
    loaded,
    refreshThreads,
    upsertThread,
    setThreadTitle,
    applyTurnUsage
  }
}
