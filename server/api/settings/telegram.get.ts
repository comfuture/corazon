import type { TelegramSettingsResponse } from '@@/types/settings'

export default defineEventHandler((): TelegramSettingsResponse => {
  return {
    telegram: readTelegramSettings()
  }
})
