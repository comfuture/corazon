#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptPath = new URL('./build-deploy-evidence-comment.mjs', import.meta.url)
const scriptFilePath = fileURLToPath(scriptPath)
const contractScriptPath = new URL('./verify-comment-rendering-contract.mjs', import.meta.url)
const contractScriptFilePath = fileURLToPath(contractScriptPath)

function runCase(overrides = {}) {
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('DEPLOY_EVIDENCE_'))
  )

  const env = {
    ...baseEnv,
    DEPLOY_EVIDENCE_STATE: 'success',
    DEPLOY_EVIDENCE_BRANCH: 'main',
    DEPLOY_EVIDENCE_HEAD_SHA: '0123456789abcdef0123456789abcdef01234567',
    DEPLOY_EVIDENCE_RUN_NUMBER: '77',
    DEPLOY_EVIDENCE_RUN_ATTEMPT: '2',
    DEPLOY_EVIDENCE_RUN_URL: 'https://example.test/run/77',
    DEPLOY_EVIDENCE_CONCLUSION: 'success',
    ...overrides
  }

  const result = spawnSync(process.execPath, [scriptFilePath], {
    env,
    encoding: 'utf8'
  })

  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

const successBody = runCase({
  DEPLOY_EVIDENCE_PREVIOUS_STATE: 'failure-after-retry'
})
assert.match(successBody, /## Deploy verification evidence/)
assert.match(successBody, /- State transition: `failure-after-retry` -> `success`/)
assert.match(successBody, /- Commit: `0123456789ab`/)
assert.match(successBody, /<!-- deploy-evidence-state:success -->/)

const failureBody = runCase({
  DEPLOY_EVIDENCE_STATE: 'failure-after-retry',
  DEPLOY_EVIDENCE_CONCLUSION: 'failure'
})
assert.match(failureBody, /Deploy verification status: failure after auto-retry/)
assert.match(failureBody, /Inspect failing steps and diagnostics artifact/)
assert.match(failureBody, /<!-- deploy-evidence-state:failure-after-retry -->/)

const neutralBody = runCase({
  DEPLOY_EVIDENCE_STATE: 'cancelled',
  DEPLOY_EVIDENCE_CONCLUSION: 'cancelled',
  DEPLOY_EVIDENCE_PREVIOUS_STATE: ''
})
assert.match(neutralBody, /Deploy verification status: cancelled/)
assert.match(neutralBody, /First tracked state in this issue\./)

const markdownStressBody = runCase({
  DEPLOY_EVIDENCE_STATE: 'failure-after-retry-->',
  DEPLOY_EVIDENCE_PREVIOUS_STATE: '`old-state',
  DEPLOY_EVIDENCE_BRANCH: 'release/`hotfix`\n${{ github.sha }}',
  DEPLOY_EVIDENCE_CONCLUSION: 'failure',
  DEPLOY_EVIDENCE_RUN_NUMBER: '88',
  DEPLOY_EVIDENCE_RUN_ATTEMPT: '3',
  DEPLOY_EVIDENCE_RUN_URL: 'https://example.test/run/88_(retry)'
})
assert.match(markdownStressBody, /- Branch: ``release\/`hotfix` \$\{\{ github\.sha \}\}``/)
assert.match(markdownStressBody, /- Trigger: `push` to ``release\/`hotfix` \$\{\{ github\.sha \}\}``/)
assert.match(markdownStressBody, /- State transition: `` `old-state `` -> `failure-after-retry-->`/)
assert.match(markdownStressBody, /- Run: \[deploy #88 attempt 3\]\(https:\/\/example\.test\/run\/88_\(retry%29\)/)
assert.match(markdownStressBody, /<!-- deploy-evidence-state:failure-after-retry-- > -->/)

const contractResult = spawnSync(process.execPath, [contractScriptFilePath], {
  env: process.env,
  encoding: 'utf8'
})
assert.equal(contractResult.status, 0, contractResult.stderr)
assert.match(contractResult.stdout, /comment rendering contract checks passed/)

console.log('deploy evidence comment regression checks passed')
