import type { TelegramSession } from './db.ts'

export type TelegramSessionRouteDecision
  = { kind: 'new' }
    | { kind: 'reuse', session: TelegramSession }
    | { kind: 'rollover', previousSession: TelegramSession }

const toIdleTimeoutMs = (idleTimeoutMinutes: number) => {
  const minutes = Number.isFinite(idleTimeoutMinutes) && idleTimeoutMinutes > 0
    ? Math.floor(idleTimeoutMinutes)
    : 15
  return minutes * 60 * 1000
}

export const isTelegramSessionReusable = (
  session: TelegramSession,
  idleTimeoutMinutes: number,
  now = Date.now()
) => {
  if (session.activeRunId) {
    return true
  }

  const lastActivityAt = session.lastCompletedAt ?? session.lastInboundAt
  return now - lastActivityAt <= toIdleTimeoutMs(idleTimeoutMinutes)
}

export const resolveTelegramSessionRoute = (
  latestSession: TelegramSession | null,
  idleTimeoutMinutes: number,
  now = Date.now()
): TelegramSessionRouteDecision => {
  if (!latestSession) {
    return { kind: 'new' }
  }

  if (isTelegramSessionReusable(latestSession, idleTimeoutMinutes, now)) {
    return { kind: 'reuse', session: latestSession }
  }

  return {
    kind: 'rollover',
    previousSession: latestSession
  }
}
