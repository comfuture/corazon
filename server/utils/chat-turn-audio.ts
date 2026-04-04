import type { CodexUIMessage } from '../../types/chat-ui.ts'
import { isAudioAttachment, transcribeAudioAttachment } from './audio-transcription.ts'

const isFileUrl = (value: string) => value.startsWith('file://')

type AudioTranscriber = typeof transcribeAudioAttachment

export const transcribeAudioAttachmentsInLatestUserMessage = async (
  messages: CodexUIMessage[],
  options?: {
    transcribeAudio?: AudioTranscriber
  }
) => {
  if (!messages.length) {
    return messages
  }

  const latestUserIndex = messages.findLastIndex(message => message?.role === 'user')
  if (latestUserIndex < 0) {
    return messages
  }

  const latestUserMessage = messages[latestUserIndex]
  const parts = Array.isArray(latestUserMessage?.parts) ? latestUserMessage.parts : []
  if (!parts.length) {
    return messages
  }

  const transcribeAudio = options?.transcribeAudio ?? transcribeAudioAttachment
  const transcriptParts = await Promise.all(parts.map(async (part) => {
    if (
      part?.type !== 'file'
      || typeof part.url !== 'string'
      || !isFileUrl(part.url)
      || !isAudioAttachment(part.mediaType)
    ) {
      return null
    }

    const transcript = await transcribeAudio({
      url: part.url,
      filename: part.filename,
      mediaType: part.mediaType
    })
    const filename = part.filename?.trim()

    return {
      type: 'text' as const,
      text: filename
        ? `[Audio transcript: ${filename}]\n${transcript}`
        : transcript
    }
  }))

  const resolvedTranscriptParts = transcriptParts.filter(part => part != null)
  if (resolvedTranscriptParts.length === 0) {
    return messages
  }

  const nextMessages = [...messages]
  nextMessages[latestUserIndex] = {
    ...latestUserMessage,
    parts: [...parts, ...resolvedTranscriptParts]
  } as CodexUIMessage
  return nextMessages
}
