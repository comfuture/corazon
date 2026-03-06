import type {
  TelegramSettingsResponse,
  TelegramSettingsUpdateRequest
} from '@@/types/settings'

export default defineEventHandler(async (event): Promise<TelegramSettingsResponse> => {
  const body = await readBody<TelegramSettingsUpdateRequest>(event)
  const telegram = body?.telegram

  if (!telegram || typeof telegram !== 'object' || Array.isArray(telegram)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid payload: telegram settings are required.'
    })
  }

  const botToken = typeof telegram.botToken === 'string' ? telegram.botToken.trim() : ''
  const chatId = typeof telegram.chatId === 'string' ? telegram.chatId.trim() : ''
  const idleTimeoutMinutes = typeof telegram.idleTimeoutMinutes === 'number'
    ? Math.floor(telegram.idleTimeoutMinutes)
    : Number.NaN

  if (!Number.isFinite(idleTimeoutMinutes) || idleTimeoutMinutes < 1) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Idle timeout must be an integer greater than or equal to 1.'
    })
  }

  writeTelegramSettings({
    botToken,
    chatId,
    idleTimeoutMinutes
  })

  return {
    telegram: readTelegramSettings()
  }
})
