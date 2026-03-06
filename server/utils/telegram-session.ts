import type { TelegramSession } from './db.ts'

export type TelegramSessionRouteDecision = {
  kind: 'new'
  reason: string
} | {
  kind: 'reuse'
  session: TelegramSession
  reason: string
  confidence?: number | null
} | {
  kind: 'carryover'
  previousSession: TelegramSession
  reason: string
  confidence?: number | null
}

const CONTINUATION_HINT_PATTERN = /(?:\b(continue|continued|continuing|resume|resuming|again|follow[-\s]?up)\b|이어서|계속|이어서 진행|계속 진행|아까|방금|전의|이전|그거|그것|그 파일|그 에러|그 작업|방금 그거|아까 그거)/i

export const toTelegramIdleTimeoutMs = (idleTimeoutMinutes: number) => {
  const minutes = Number.isFinite(idleTimeoutMinutes) && idleTimeoutMinutes > 0
    ? Math.floor(idleTimeoutMinutes)
    : 15
  return minutes * 60 * 1000
}

export const getTelegramSessionLastActivityAt = (session: TelegramSession) =>
  session.lastCompletedAt ?? session.lastInboundAt

export const isTelegramSessionWithinTimeout = (
  session: TelegramSession,
  idleTimeoutMinutes: number,
  now = Date.now()
) => now - getTelegramSessionLastActivityAt(session) <= toTelegramIdleTimeoutMs(idleTimeoutMinutes)

export const isTelegramSessionImmediatelyReusable = (
  session: TelegramSession,
  idleTimeoutMinutes: number,
  now = Date.now()
) => Boolean(session.activeRunId) || isTelegramSessionWithinTimeout(session, idleTimeoutMinutes, now)

export const hasTelegramContinuationHint = (messageText: string) =>
  CONTINUATION_HINT_PATTERN.test(messageText.trim())
