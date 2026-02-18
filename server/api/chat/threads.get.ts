export default defineEventHandler((event) => {
  setHeader(event, 'cache-control', 'no-store')

  const query = getQuery(event)
  const rawLimit = Number.parseInt(String(query.limit ?? ''), 10)
  const limit = Number.isFinite(rawLimit) ? rawLimit : 50
  const rawCursorUpdatedAt = Number.parseInt(String(query.cursorUpdatedAt ?? ''), 10)
  const cursorUpdatedAt = Number.isFinite(rawCursorUpdatedAt) ? rawCursorUpdatedAt : null
  const cursorId = typeof query.cursorId === 'string' && query.cursorId.trim()
    ? query.cursorId.trim()
    : null

  const cursor = cursorUpdatedAt != null && cursorId
    ? { updatedAt: cursorUpdatedAt, id: cursorId }
    : null

  return loadThreadSummaries(limit, cursor)
})
