import {
  createSimpleChatgptCodexInput,
  formatChatgptCodexResponsesError,
  runChatgptCodexTextResponse
} from '../lib/chatgpt-codex-responses.ts'

const experiments = [
  {
    name: 'ok-default',
    model: 'gpt-5.1-codex-mini',
    instructions: 'You are a terse assistant. Reply with exactly OK.',
    inputText: 'Say OK.'
  },
  {
    name: 'ok-low',
    model: 'gpt-5.1-codex-mini',
    reasoningEffort: 'low' as const,
    instructions: 'You are a terse assistant. Reply with exactly OK.',
    inputText: 'Say OK.'
  },
  {
    name: 'ko-brief',
    model: 'gpt-5.1-codex-mini',
    reasoningEffort: 'low' as const,
    instructions: 'You are a concise Korean assistant. Answer in Korean in one sentence.',
    inputText: '코루틴이 무엇인지 한 문장으로 설명해줘.'
  },
  {
    name: 'classification',
    model: 'gpt-5.1-codex-mini',
    reasoningEffort: 'low' as const,
    instructions: 'Classify the request as resume, carryover, or new. Reply with the label only.',
    inputText: '이전에 하던 텔레그램 스레드 분기 작업 계속해줘.'
  }
]

const run = async () => {
  for (const experiment of experiments) {
    const startedAt = Date.now()
    try {
      const result = await runChatgptCodexTextResponse({
        model: experiment.model,
        instructions: experiment.instructions,
        input: createSimpleChatgptCodexInput(experiment.inputText),
        reasoningEffort: experiment.reasoningEffort
      })

      const firstEventMs = result.firstEventAt == null ? null : result.firstEventAt - startedAt
      const firstTextMs = result.firstTextAt == null ? null : result.firstTextAt - startedAt
      const completedMs = result.completedAt - startedAt

      console.log(JSON.stringify({
        name: experiment.name,
        model: experiment.model,
        reasoningEffort: experiment.reasoningEffort,
        responseId: result.responseId,
        eventCount: result.events.length,
        firstEventMs,
        firstTextMs,
        completedMs,
        outputText: result.outputText
      }, null, 2))
    } catch (error) {
      process.exitCode = 1
      console.error(JSON.stringify({
        name: experiment.name,
        error: formatChatgptCodexResponsesError(error)
      }, null, 2))
    }
  }
}

void run()
