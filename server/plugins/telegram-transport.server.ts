import { initializeTelegramTransport } from '../utils/telegram-transport.ts'

export default defineNitroPlugin(() => {
  initializeTelegramTransport()
})
