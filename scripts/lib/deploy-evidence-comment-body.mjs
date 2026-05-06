function required(input, key) {
  const value = input[key]
  if (!value) {
    throw new Error(`Missing required value: ${key}`)
  }
  return value
}

function toSingleLine(value) {
  return String(value).replace(/\r?\n/g, ' ').replace(/[ \t]+/g, ' ').trim()
}

function inlineCode(value) {
  const normalized = toSingleLine(value)
  if (normalized === '') {
    return '``'
  }
  const runs = normalized.match(/`+/g) || []
  const maxRun = runs.reduce((max, run) => Math.max(max, run.length), 0)
  const fence = '`'.repeat(maxRun + 1)
  const needsPadding = normalized.startsWith('`') || normalized.endsWith('`')
  const padded = needsPadding ? ` ${normalized} ` : normalized
  return `${fence}${padded}${fence}`
}

function escapeMarkdownLinkDestination(url) {
  return toSingleLine(url).replace(/\)/g, '%29')
}

function escapeHtmlCommentBody(value) {
  return toSingleLine(value).replace(/-->/g, '-- >')
}

export function buildDeployEvidenceCommentBody(input) {
  const state = required(input, 'state')
  const branch = required(input, 'branch')
  const headSha = required(input, 'headSha')
  const runNumber = required(input, 'runNumber')
  const runAttempt = required(input, 'runAttempt')
  const runUrl = required(input, 'runUrl')
  const conclusion = required(input, 'conclusion')
  const previousState = String(input.previousState || '')

  const headShort = toSingleLine(headSha).slice(0, 12)

  let resultLine = 'Deploy verification status: success'
  let nextAction = 'None'

  if (conclusion === 'failure') {
    resultLine = 'Deploy verification status: failure after auto-retry'
    nextAction = 'Inspect failing steps and diagnostics artifact from the linked deploy run; then fix forward in the next PR.'
  } else if (conclusion !== 'success') {
    resultLine = `Deploy verification status: ${toSingleLine(conclusion)}`
    nextAction = 'Review deploy run details and decide whether a manual rerun or follow-up fix is needed.'
  }

  const transitionLine = previousState
    ? `${inlineCode(previousState)} -> ${inlineCode(state)}`
    : 'First tracked state in this issue.'

  const lines = [
    '## Deploy verification evidence',
    `- Result: ${resultLine}`,
    `- State transition: ${transitionLine}`,
    `- Branch: ${inlineCode(branch)}`,
    `- Commit: ${inlineCode(headShort)}`,
    `- Run: [deploy #${toSingleLine(runNumber)} attempt ${toSingleLine(runAttempt)}](${escapeMarkdownLinkDestination(runUrl)})`,
    `- Trigger: ${inlineCode('push')} to ${inlineCode(branch)}`,
    `- Next action: ${nextAction}`,
    `<!-- deploy-evidence-state:${escapeHtmlCommentBody(state)} -->`
  ]

  return `${lines.join('\n')}\n`
}
