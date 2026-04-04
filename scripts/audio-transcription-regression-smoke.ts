import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isAudioAttachment,
  transcribeAudioAttachment
} from '../server/utils/audio-transcription.ts'
import { transcribeAudioAttachmentsInLatestUserMessage } from '../server/utils/chat-turn-audio.ts'
import type { CodexUIMessage } from '../types/chat-ui.ts'

type MockResponse = {
  ok: boolean
  status: number
  statusText: string
  json: () => Promise<unknown>
  text: () => Promise<string>
}

const run = async () => {
  assert.equal(isAudioAttachment('audio/ogg'), true, 'audio/* should be treated as audio attachment')
  assert.equal(isAudioAttachment('text/plain'), false, 'non-audio media type should not be treated as audio attachment')
  assert.equal(isAudioAttachment(undefined), false, 'undefined media type should not be treated as audio attachment')

  const tempDir = await mkdtemp(join(tmpdir(), 'corazon-audio-regression-'))
  const audioPath = join(tempDir, 'voice.ogg')
  await writeFile(audioPath, Buffer.from('fake audio payload'))

  const originalFetch = globalThis.fetch
  const originalApiKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = 'test-api-key'

  try {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ text: '  transcript from text field  ' }),
      text: async () => ''
    } satisfies MockResponse)) as typeof fetch
    const transcriptFromText = await transcribeAudioAttachment({
      url: `file://${audioPath}`,
      filename: 'voice.ogg',
      mediaType: 'audio/ogg'
    })
    assert.equal(transcriptFromText, 'transcript from text field')

    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ transcript: 'transcript from fallback field' }),
      text: async () => ''
    } satisfies MockResponse)) as typeof fetch
    const transcriptFromFallback = await transcribeAudioAttachment({
      url: `file://${audioPath}`,
      filename: 'voice.ogg',
      mediaType: 'audio/ogg'
    })
    assert.equal(transcriptFromFallback, 'transcript from fallback field')

    globalThis.fetch = (async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({}),
      text: async () => JSON.stringify({ error: { message: 'invalid api key' } })
    } satisfies MockResponse)) as typeof fetch
    await assert.rejects(
      () => transcribeAudioAttachment({
        url: `file://${audioPath}`,
        filename: 'voice.ogg',
        mediaType: 'audio/ogg'
      }),
      /Audio transcription failed.*invalid api key/i,
      'failed transcription response should bubble parsed error details'
    )

    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ text: '   ' }),
      text: async () => ''
    } satisfies MockResponse)) as typeof fetch
    await assert.rejects(
      () => transcribeAudioAttachment({
        url: `file://${audioPath}`,
        filename: 'voice.ogg',
        mediaType: 'audio/ogg'
      }),
      /empty transcript/i,
      'empty transcript should raise a regression guard error'
    )

    const baseMessages = [
      {
        id: 'm1',
        role: 'user',
        parts: [{ type: 'text', text: 'Earlier prompt' }]
      },
      {
        id: 'm2',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Ack' }]
      },
      {
        id: 'm3',
        role: 'user',
        parts: [
          { type: 'text', text: 'Please transcribe this' },
          { type: 'file', url: `file://${audioPath}`, filename: 'voice.ogg', mediaType: 'audio/ogg' },
          { type: 'file', url: 'file:///tmp/note.txt', filename: 'note.txt', mediaType: 'text/plain' }
        ]
      }
    ] as CodexUIMessage[]

    const merged = await transcribeAudioAttachmentsInLatestUserMessage(baseMessages, {
      transcribeAudio: async () => 'deterministic transcript'
    })
    assert.equal(merged.length, baseMessages.length, 'message count should stay stable')
    const mergedLatestParts = merged.at(-1)?.parts ?? []
    assert.equal(mergedLatestParts.length, 4, 'latest user message should append exactly one transcript part')
    assert.deepEqual(mergedLatestParts.at(-1), {
      type: 'text',
      text: '[Audio transcript: voice.ogg]\ndeterministic transcript'
    })
    assert.deepEqual(
      mergedLatestParts.filter(part => part.type === 'file').map(part => part.filename),
      ['voice.ogg', 'note.txt'],
      'existing file parts must remain intact after transcript append'
    )

    await assert.rejects(
      () => transcribeAudioAttachmentsInLatestUserMessage(baseMessages, {
        transcribeAudio: async () => {
          throw new Error('simulated transcription failure')
        }
      }),
      /simulated transcription failure/,
      'chat-turn audio integration should propagate transcription failures'
    )
  } finally {
    if (originalFetch) {
      globalThis.fetch = originalFetch
    }
    if (typeof originalApiKey === 'string') {
      process.env.OPENAI_API_KEY = originalApiKey
    } else {
      delete process.env.OPENAI_API_KEY
    }
    await rm(tempDir, { recursive: true, force: true })
  }

  console.log('audio transcription regression smoke checks passed')
}

void run()
