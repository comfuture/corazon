#!/usr/bin/env node

function required(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required env: ${name}`)
  }
  return value
}

const state = required('DEPLOY_EVIDENCE_STATE')
const branch = required('DEPLOY_EVIDENCE_BRANCH')
const headSha = required('DEPLOY_EVIDENCE_HEAD_SHA')
const runNumber = required('DEPLOY_EVIDENCE_RUN_NUMBER')
const runAttempt = required('DEPLOY_EVIDENCE_RUN_ATTEMPT')
const runUrl = required('DEPLOY_EVIDENCE_RUN_URL')
const conclusion = required('DEPLOY_EVIDENCE_CONCLUSION')
const previousState = process.env.DEPLOY_EVIDENCE_PREVIOUS_STATE || ''

const headShort = headSha.slice(0, 12)

let resultLine = 'Deploy verification status: success'
let nextAction = 'None'

if (conclusion === 'failure') {
  resultLine = 'Deploy verification status: failure after auto-retry'
  nextAction = 'Inspect failing steps and diagnostics artifact from the linked deploy run; then fix forward in the next PR.'
} else if (conclusion !== 'success') {
  resultLine = `Deploy verification status: ${conclusion}`
  nextAction = 'Review deploy run details and decide whether a manual rerun or follow-up fix is needed.'
}

let transitionLine = 'First tracked state in this issue.'
if (previousState) {
  transitionLine = `\`${previousState}\` -> \`${state}\``
}

const lines = [
  '## Deploy verification evidence',
  `- Result: ${resultLine}`,
  `- State transition: ${transitionLine}`,
  `- Branch: \`${branch}\``,
  `- Commit: \`${headShort}\``,
  `- Run: [deploy #${runNumber} attempt ${runAttempt}](${runUrl})`,
  '- Trigger: `push` to `main`',
  `- Next action: ${nextAction}`,
  `<!-- deploy-evidence-state:${state} -->`
]

process.stdout.write(`${lines.join('\n')}\n`)
