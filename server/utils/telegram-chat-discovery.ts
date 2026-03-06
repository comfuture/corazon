import type { TelegramChatCandidate } from '@@/types/settings'
import type { TelegramRecentChat } from './db.ts'
import {
  isTelegramBotMessage,
  type TelegramChat,
  type TelegramMessage,
  type TelegramUpdate
} from './telegram-bot.ts'

const compactWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim()

const truncate = (value: string, max = 120) => {
  const normalized = compactWhitespace(value)
  if (normalized.length <= max) {
    return normalized
  }
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

export const getTelegramChatTitle = (chat: TelegramChat) => {
  const directName = [chat.first_name, chat.last_name].filter(Boolean).join(' ').trim()
  if (directName) {
    return directName
  }

  if (typeof chat.title === 'string' && chat.title.trim()) {
    return chat.title.trim()
  }

  if (typeof chat.username === 'string' && chat.username.trim()) {
    return `@${chat.username.trim()}`
  }

  return String(chat.id)
}

export const getTelegramChatSubtitle = (chat: TelegramChat) => {
  const details: string[] = [chat.type]
  if (typeof chat.username === 'string' && chat.username.trim()) {
    details.push(`@${chat.username.trim()}`)
  }
  const subtitle = details.join(' • ').trim()
  return subtitle || null
}

export const toTelegramChatCandidateFromMessage = (
  updateId: number,
  message: TelegramMessage
): TelegramChatCandidate => ({
  chatId: String(message.chat.id),
  type: message.chat.type,
  title: getTelegramChatTitle(message.chat),
  subtitle: getTelegramChatSubtitle(message.chat),
  lastMessageText: typeof message.text === 'string' ? truncate(message.text, 160) : null,
  lastMessageAt: typeof message.date === 'number' ? message.date * 1000 : null,
  updateId
})

export const collectTelegramChatCandidatesFromUpdates = (updates: TelegramUpdate[]) => {
  const byChatId = new Map<string, TelegramChatCandidate>()

  for (const update of updates) {
    const message = update.message ?? update.edited_message
    if (!message || isTelegramBotMessage(message)) {
      continue
    }

    const candidate = toTelegramChatCandidateFromMessage(update.update_id, message)
    const existing = byChatId.get(candidate.chatId)
    if (!existing || candidate.updateId > existing.updateId) {
      byChatId.set(candidate.chatId, candidate)
    }
  }

  return Array.from(byChatId.values())
    .sort((left, right) =>
      (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0) || right.updateId - left.updateId
    )
}

export const mergeTelegramChatCandidates = (
  primary: TelegramChatCandidate[],
  secondary: TelegramRecentChat[]
) => {
  const merged = new Map<string, TelegramChatCandidate>()

  for (const candidate of primary) {
    merged.set(candidate.chatId, candidate)
  }

  for (const chat of secondary) {
    if (merged.has(chat.chatId)) {
      continue
    }

    merged.set(chat.chatId, {
      chatId: chat.chatId,
      type: chat.type,
      title: chat.title,
      subtitle: chat.subtitle,
      lastMessageText: chat.lastMessageText,
      lastMessageAt: chat.lastMessageAt,
      updateId: chat.lastUpdateId
    })
  }

  return Array.from(merged.values())
    .sort((left, right) =>
      (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0) || right.updateId - left.updateId
    )
}
