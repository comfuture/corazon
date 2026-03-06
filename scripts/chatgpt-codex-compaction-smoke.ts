import {
  compactChatgptCodexInputWindow,
  createSimpleChatgptCodexAssistantOutput,
  createSimpleChatgptCodexInput,
  formatChatgptCodexResponsesError,
  runChatgptCodexTextResponse
} from '../lib/chatgpt-codex-responses.ts'

const run = async () => {
  const priorWindow = [
    ...createSimpleChatgptCodexInput('Remember that the launch code is ALPHA-17.'),
    createSimpleChatgptCodexAssistantOutput('I will remember that the launch code is ALPHA-17.'),
    ...createSimpleChatgptCodexInput('Also remember that the fallback site is Busan.'),
    createSimpleChatgptCodexAssistantOutput('Understood. The fallback site is Busan.')
  ]

  try {
    const compactStartedAt = Date.now()
    const compaction = await compactChatgptCodexInputWindow({
      model: 'gpt-5.1-codex-mini',
      instructions: 'Compact prior context for reuse.',
      input: priorWindow
    })

    const compactCompletedAt = Date.now()

    const response = await runChatgptCodexTextResponse({
      model: 'gpt-5.1-codex-mini',
      instructions: 'Answer user questions briefly and accurately.',
      input: [
        ...compaction.output,
        ...createSimpleChatgptCodexInput('What are the launch code and fallback site? Reply in one sentence.')
      ],
      reasoningEffort: 'low'
    })

    console.log(JSON.stringify({
      compactionId: compaction.id,
      compactionObject: compaction.object,
      compactionOutputTypes: compaction.output.map(item => item.type),
      compactLatencyMs: compactCompletedAt - compactStartedAt,
      responseId: response.responseId,
      responseLatencyMs: response.completedAt - response.startedAt,
      outputText: response.outputText
    }, null, 2))
  } catch (error) {
    process.exitCode = 1
    console.error(JSON.stringify({
      error: formatChatgptCodexResponsesError(error)
    }, null, 2))
  }
}

void run()
