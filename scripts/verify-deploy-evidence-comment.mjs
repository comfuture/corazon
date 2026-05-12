#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptPath = new URL('./build-deploy-evidence-comment.mjs', import.meta.url)
const scriptFilePath = fileURLToPath(scriptPath)
const contractScriptPath = new URL('./verify-comment-rendering-contract.mjs', import.meta.url)
const contractScriptFilePath = fileURLToPath(contractScriptPath)
const fixturePath = new URL('./fixtures/deploy-evidence-comment-cases.json', import.meta.url)

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

const fixtures = JSON.parse(readFileSync(fileURLToPath(fixturePath), 'utf8'))
for (const fixture of fixtures) {
  const body = runCase(fixture.env)
  for (const expectedSnippet of fixture.patterns) {
    assert.ok(body.includes(expectedSnippet), `${fixture.name} missing snippet: ${expectedSnippet}`)
  }
}

const contractResult = spawnSync(process.execPath, [contractScriptFilePath], {
  env: process.env,
  encoding: 'utf8'
})
assert.equal(contractResult.status, 0, contractResult.stderr)
assert.match(contractResult.stdout, /comment rendering contract checks passed/)

console.log(`deploy evidence comment regression checks passed (${fixtures.length} fixture cases)`)
