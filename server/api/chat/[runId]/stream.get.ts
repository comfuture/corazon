import { createUIMessageStreamResponse } from 'ai'
import type { H3Event } from 'h3'
import { getRun } from 'workflow/api'
import type { UIMessageChunk } from 'ai'

const createTerminalFinishStream = () =>
  new ReadableStream<UIMessageChunk>({
    start(controller) {
      controller.enqueue({ type: 'finish' })
      controller.close()
    }
  })

export default defineEventHandler(async (event: H3Event) => {
  const runId = getRouterParam(event, 'runId')
  if (!runId) {
    throw createError({ statusCode: 400, statusMessage: 'Missing run id.' })
  }

  const startIndexParam = getQuery(event).startIndex
  let startIndex: number | undefined

  if (typeof startIndexParam === 'string' && startIndexParam.length > 0) {
    const parsed = Number.parseInt(startIndexParam, 10)
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid startIndex.' })
    }
    startIndex = parsed
  }

  const run = getRun(runId)
  let runStatus = ''
  try {
    runStatus = await run.status
  } catch {
    return createUIMessageStreamResponse({
      stream: createTerminalFinishStream(),
      status: 200
    })
  }

  const readable = run.getReadable<UIMessageChunk>({ startIndex })
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      const reader = readable.getReader()
      let hasFinishChunk = false

      void (async () => {
        const terminalStatuses = new Set(['completed', 'failed', 'cancelled'])
        const useIdleTimeout = terminalStatuses.has(runStatus)
        const IDLE_TIMEOUT_MS = 1000
        const IDLE = Symbol('idle')

        const readNext = async () => {
          if (!useIdleTimeout) {
            return reader.read()
          }

          const result = await Promise.race([
            reader.read(),
            new Promise<typeof IDLE>((resolve) => {
              setTimeout(() => resolve(IDLE), IDLE_TIMEOUT_MS)
            })
          ])

          return result
        }

        try {
          while (true) {
            const next = await readNext()
            if (next === IDLE) {
              break
            }
            const { done, value } = next
            if (done) {
              break
            }
            if (value?.type === 'finish') {
              hasFinishChunk = true
            }
            controller.enqueue(value)
          }

          // Ensure reconnecting clients can terminate instead of retry-looping forever.
          if (!hasFinishChunk) {
            controller.enqueue({ type: 'finish' })
          }
          controller.close()
        } catch (error) {
          controller.error(error)
        } finally {
          reader.releaseLock()
        }
      })()
    }
  })

  return createUIMessageStreamResponse({
    stream,
    status: 200
  })
})
