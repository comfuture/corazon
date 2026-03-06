import type {
  TelegramChatCandidate,
  TelegramChatDiscoveryRequest,
  TelegramChatDiscoveryResponse
} from '@@/types/settings'

export default defineEventHandler(async (event): Promise<TelegramChatDiscoveryResponse> => {
  const body = await readBody<TelegramChatDiscoveryRequest | null>(event)
  const configured = readTelegramSettings()
  const botToken = typeof body?.botToken === 'string' && body.botToken.trim()
    ? body.botToken.trim()
    : configured.botToken.trim()

  if (!botToken) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Telegram bot token is required to discover chats.'
    })
  }

  const updates = await getTelegramUpdates(botToken, {
    timeoutSeconds: 0
  })
  const liveChats = collectTelegramChatCandidatesFromUpdates(updates)

  for (const chat of liveChats) {
    upsertTelegramRecentChat({
      chatId: chat.chatId,
      type: chat.type,
      title: chat.title,
      subtitle: chat.subtitle,
      lastMessageText: chat.lastMessageText,
      lastMessageAt: chat.lastMessageAt,
      lastUpdateId: chat.updateId
    })
  }

  const chats = mergeTelegramChatCandidates(
    liveChats,
    loadTelegramRecentChats(20)
  )

  return {
    chats: chats.map((chat): TelegramChatCandidate => ({
      chatId: chat.chatId,
      type: chat.type,
      title: chat.title,
      subtitle: chat.subtitle,
      lastMessageText: chat.lastMessageText,
      lastMessageAt: chat.lastMessageAt,
      updateId: chat.updateId
    }))
  }
})
