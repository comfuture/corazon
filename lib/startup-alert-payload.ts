export type StartupAlertPayload = {
  severity: 'info' | 'warning'
  title: string
  message: string
  nextAction: string | null
  context: {
    branch: string | null
  }
}

type BuildStartupAlertPayloadInput = {
  telegramEnabled: boolean
  facts: string[]
  branch: string | null
  runCodexProbe: (facts: string[]) => Promise<string>
  formatProbeError: (error: unknown) => string
}

const MAX_PROBE_LINE_LENGTH = 220
const MAX_PROBE_ERROR_LENGTH = 260
const PROBE_FAILURE_NEXT_ACTION
  = 'Check ChatGPT/Codex auth and app-server runtime health before trusting this deploy.'

const compactWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim()

const truncate = (value: string, maxLength: number) => {
  if (value.length <= maxLength) {
    return value
  }
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

export const buildStartupAlertPayload = async (
  input: BuildStartupAlertPayloadInput
): Promise<StartupAlertPayload | null> => {
  if (!input.telegramEnabled) {
    return null
  }

  let severity: StartupAlertPayload['severity'] = 'info'
  let codexLine = ''
  let nextAction: string | null = null

  try {
    codexLine = truncate(compactWhitespace(await input.runCodexProbe(input.facts)), MAX_PROBE_LINE_LENGTH)
    if (!codexLine) {
      throw new Error('Startup Codex probe returned an empty message.')
    }
  } catch (error) {
    severity = 'warning'
    codexLine = `Codex startup probe failed: ${truncate(compactWhitespace(input.formatProbeError(error)), MAX_PROBE_ERROR_LENGTH)}`
    nextAction = PROBE_FAILURE_NEXT_ACTION
  }

  return {
    severity,
    title: 'Corazon server restarted',
    message: [...input.facts, '', `Codex probe: ${codexLine}`].join('\n'),
    nextAction,
    context: {
      branch: input.branch
    }
  }
}
