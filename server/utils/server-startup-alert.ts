import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import {
  createSimpleChatgptCodexInput,
  formatChatgptCodexResponsesError,
  runChatgptCodexTextResponse
} from '@@/lib/chatgpt-codex-responses.ts'
import { buildStartupAlertPayload } from '@@/lib/startup-alert-payload.ts'

const STARTUP_ALERT_MODEL = 'gpt-5.4-mini'

let startupAlertInitialized = false

const resolveRepositoryRoot = () => process.cwd()

const readPackageVersion = () => {
  try {
    const raw = readFileSync(`${resolveRepositoryRoot()}/package.json`, 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version.trim() : ''
  } catch {
    return ''
  }
}

const runGitCommand = (args: string[]) => {
  try {
    return execFileSync('git', args, {
      cwd: resolveRepositoryRoot(),
      encoding: 'utf8',
      timeout: 5000
    }).trim()
  } catch {
    return ''
  }
}

const resolveGitContext = () => ({
  branch: runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD']),
  commit: runGitCommand(['rev-parse', '--short', 'HEAD'])
})

const buildBootFacts = () => {
  const hostname = process.env.HOSTNAME?.trim() || 'unknown-host'
  const startedAtIso = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString()
  const version = readPackageVersion()
  const git = resolveGitContext()

  const facts = [
    `Corazon server restarted successfully.`,
    `Host: ${hostname}`,
    `PID: ${process.pid}`,
    `Started at: ${startedAtIso}`
  ]

  if (version) {
    facts.push(`Version: ${version}`)
  }
  if (git.branch) {
    facts.push(`Branch: ${git.branch}`)
  }
  if (git.commit) {
    facts.push(`Commit: ${git.commit}`)
  }

  return {
    facts,
    hostname,
    branch: git.branch || null,
    commit: git.commit || null
  }
}

const runStartupCodexProbe = async (facts: string[]) => {
  const prompt = [
    'Generate one short operator-facing startup confirmation line.',
    'Keep it under 18 words.',
    'Mention that Codex responded during startup health verification.',
    'Do not use bullets, emojis, quotes, markdown, or greetings.',
    '',
    ...facts
  ].join('\n')

  const response = await runChatgptCodexTextResponse({
    model: STARTUP_ALERT_MODEL,
    instructions: [
      'You are writing a terse health-check confirmation for a server startup alert.',
      'Return exactly one plain-text sentence.',
      'Do not add labels or multiple lines.'
    ].join('\n'),
    input: createSimpleChatgptCodexInput(prompt),
    reasoningEffort: 'low',
    textVerbosity: 'low'
  })

  const message = response.outputText.replace(/\s+/g, ' ').trim()
  if (!message) {
    throw new Error('Startup Codex probe returned an empty message.')
  }

  return message
}

const sendStartupAlert = async () => {
  const boot = buildBootFacts()
  const payload = await buildStartupAlertPayload({
    telegramEnabled: readTelegramSettings().enabled,
    facts: boot.facts,
    branch: boot.branch,
    runCodexProbe: runStartupCodexProbe,
    formatProbeError: formatChatgptCodexResponsesError
  })
  if (!payload) {
    return
  }

  const result = await sendOperatorNotification({
    ...payload,
    source: 'system'
  })

  if (!result.delivered) {
    throw new Error(result.skippedReason || 'Failed to deliver startup alert.')
  }
}

export const initializeServerStartupAlert = () => {
  if (startupAlertInitialized) {
    return
  }

  startupAlertInitialized = true
  void sendStartupAlert().catch((error) => {
    console.error('[startup-alert] failed to send startup Telegram alert:', error)
  })
}
