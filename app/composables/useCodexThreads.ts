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

type CodexThreadCursor = {
  updatedAt: number
  id: string
}

type CodexThreadPageResponse = {
  items: CodexThreadSummary[]
  nextCursor: CodexThreadCursor | null
}

const THREAD_PAGE_SIZE = 50

const sortThreads = (items: CodexThreadSummary[]) =>
  items.slice().sort((a, b) => {
    if (b.updatedAt !== a.updatedAt) {
      return b.updatedAt - a.updatedAt
    }
    return b.id.localeCompare(a.id)
  })

const withPreservedTitle = (
  thread: CodexThreadSummary,
  existingById: Map<string, CodexThreadSummary>
) => {
  if (thread.title) {
    return thread
  }
  const existing = existingById.get(thread.id)
  if (!existing?.title) {
    return thread
  }
  return {
    ...thread,
    title: existing.title
  }
}

const mergeThreadLists = (
  existingItems: CodexThreadSummary[],
  incomingItems: CodexThreadSummary[]
) => {
  const mergedById = new Map(existingItems.map(thread => [thread.id, thread]))
  for (const incoming of incomingItems) {
    const current = mergedById.get(incoming.id)
    if (!current) {
      mergedById.set(incoming.id, incoming)
      continue
    }

    const title = incoming.title ?? current.title ?? null
    if (incoming.updatedAt > current.updatedAt) {
      mergedById.set(incoming.id, { ...incoming, title })
      continue
    }

    if (incoming.updatedAt < current.updatedAt) {
      mergedById.set(incoming.id, { ...current, title })
      continue
    }

    mergedById.set(incoming.id, { ...incoming, title })
  }
  return sortThreads([...mergedById.values()])
}

export const useCodexThreads = () => {
  const threads = useState<CodexThreadSummary[]>('codex-thread-list', () => [])
  const loaded = useState('codex-thread-list-loaded', () => false)
  const nextCursor = useState<CodexThreadCursor | null>('codex-thread-list-next-cursor', () => null)
  const hasMore = useState('codex-thread-list-has-more', () => true)
  const isRefreshing = useState('codex-thread-list-refreshing', () => false)
  const isLoadingMore = useState('codex-thread-list-loading-more', () => false)

  const fetchThreadPage = async (cursor: CodexThreadCursor | null) => {
    const query: Record<string, string | number> = {
      limit: THREAD_PAGE_SIZE
    }
    if (cursor) {
      query.cursorUpdatedAt = cursor.updatedAt
      query.cursorId = cursor.id
    }

    const response = await $fetch<CodexThreadPageResponse>('/api/chat/threads', {
      cache: 'no-store',
      query
    })

    return response
  }

  const refreshThreads = async () => {
    if (isRefreshing.value) {
      return
    }
    isRefreshing.value = true
    try {
      const page = await fetchThreadPage(null)
      const existingById = new Map(threads.value.map(thread => [thread.id, thread]))
      const items = page.items.map(thread => withPreservedTitle(thread, existingById))

      threads.value = sortThreads(items)
      nextCursor.value = page.nextCursor
      hasMore.value = page.nextCursor != null
      loaded.value = true
    } catch (error) {
      console.error(error)
    } finally {
      isRefreshing.value = false
    }
  }

  const loadMoreThreads = async () => {
    if (isLoadingMore.value || isRefreshing.value || !hasMore.value || !nextCursor.value) {
      return
    }

    isLoadingMore.value = true
    try {
      const page = await fetchThreadPage(nextCursor.value)
      const existingById = new Map(threads.value.map(thread => [thread.id, thread]))
      const normalizedIncoming = page.items.map(thread => withPreservedTitle(thread, existingById))
      threads.value = mergeThreadLists(threads.value, normalizedIncoming)
      nextCursor.value = page.nextCursor
      hasMore.value = page.nextCursor != null
    } catch (error) {
      console.error(error)
    } finally {
      isLoadingMore.value = false
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
    hasMore,
    isRefreshing,
    isLoadingMore,
    refreshThreads,
    loadMoreThreads,
    upsertThread,
    setThreadTitle,
    applyTurnUsage
  }
}
