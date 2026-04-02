import { basename } from 'node:path'
import { readFile } from 'node:fs/promises'

const OPENAI_TRANSCRIPTION_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions'
const OPENAI_TRANSCRIPTION_MODEL = 'whisper-1'

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

const stripFileUrl = (value: string) => value.replace(/^file:\/\//, '')

export const isAudioAttachment = (mediaType?: string | null) =>
  typeof mediaType === 'string' && mediaType.toLowerCase().startsWith('audio/')

const requireOpenAiApiKey = () => {
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) {
    throw new Error('Audio transcription requires OPENAI_API_KEY.')
  }
  return apiKey
}

const normalizeTranscript = (value: unknown) =>
  typeof value === 'string' ? value.trim() : ''

const extractTranscriptText = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') {
    return ''
  }

  const text = normalizeTranscript(Reflect.get(payload, 'text'))
  if (text) {
    return text
  }

  const fallback = normalizeTranscript(Reflect.get(payload, 'transcript'))
  return fallback
}

export const transcribeAudioAttachment = async (input: {
  url: string
  filename?: string
  mediaType?: string | null
}) => {
  if (!isNonEmptyString(input.url) || !input.url.startsWith('file://')) {
    throw new Error('Audio transcription requires a local file attachment.')
  }

  const filePath = stripFileUrl(input.url)
  const fileBuffer = await readFile(filePath)
  const fileName = isNonEmptyString(input.filename)
    ? input.filename.trim()
    : basename(filePath)
  const fileType = isNonEmptyString(input.mediaType)
    ? input.mediaType.trim()
    : 'application/octet-stream'

  const formData = new FormData()
  formData.set('model', OPENAI_TRANSCRIPTION_MODEL)
  formData.set('file', new File([fileBuffer], fileName, { type: fileType }))

  const response = await fetch(OPENAI_TRANSCRIPTION_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${requireOpenAiApiKey()}`
    },
    body: formData
  })

  if (!response.ok) {
    const errorText = (await response.text()).trim()
    throw new Error(
      `Audio transcription failed for ${fileName}: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ''}`
    )
  }

  const payload = await response.json()
  const transcript = extractTranscriptText(payload)
  if (!transcript) {
    throw new Error(`Audio transcription returned an empty transcript for ${fileName}.`)
  }

  return transcript
}
