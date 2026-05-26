#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildDeployEvidenceCommentBody } from './lib/deploy-evidence-comment-body.mjs'

const seedsPath = new URL('./fixtures/deploy-evidence-fuzz-seeds.json', import.meta.url)
const configuredSeeds = JSON.parse(readFileSync(fileURLToPath(seedsPath), 'utf8'))

const forcedSeed = process.env.DEPLOY_EVIDENCE_FUZZ_SEED
const forcedIterations = Number(process.env.DEPLOY_EVIDENCE_FUZZ_ITERATIONS || 0)

const runs = forcedSeed
  ? [{ name: 'manual-seed', seed: Number(forcedSeed), iterations: forcedIterations || 120 }]
  : configuredSeeds

let totalCases = 0

for (const run of runs) {
  verifyRun(run)
}

console.log(
  `deploy evidence fuzz/property checks passed (${totalCases} generated cases across ${runs.length} seed run(s))`
)

function verifyRun({ name, seed, iterations }) {
  assert.ok(Number.isInteger(seed), `${name}: seed must be an integer`)
  assert.ok(Number.isInteger(iterations) && iterations > 0, `${name}: iterations must be > 0`)

  const rng = makeRng(seed)
  for (let i = 0; i < iterations; i++) {
    const input = generateInput(rng, i)
    const body = buildDeployEvidenceCommentBody(input)
    assertInvariants({ body, input, name, seed, index: i })
    totalCases += 1
  }
}

function makeRng(seed) {
  let state = seed >>> 0
  return function next() {
    state = (1664525 * state + 1013904223) >>> 0
    return state / 4294967296
  }
}

function pick(rng, items) {
  return items[Math.floor(rng() * items.length)]
}

function randomInt(rng, maxExclusive) {
  return Math.floor(rng() * maxExclusive)
}

function randomToken(rng, maxTokens = 6) {
  const lexicon = [
    'main',
    'release',
    'hotfix',
    'staging',
    'prod',
    'workflow',
    '```',
    '`inline`',
    '${{ github.sha }}',
    '$(rm -rf /)',
    'EOF',
    '<<EOF',
    '-->',
    'retry)',
    'line\nbreak'
  ]
  const count = 1 + randomInt(rng, maxTokens)
  let value = ''
  for (let i = 0; i < count; i++) {
    value += (i > 0 ? pick(rng, [' ', '  ', '\n', '\t']) : '') + pick(rng, lexicon)
  }
  return value
}

function randomSha(rng) {
  const hex = '0123456789abcdef'
  let value = ''
  for (let i = 0; i < 40; i++) {
    value += hex[randomInt(rng, hex.length)]
  }
  return value
}

function generateInput(rng, index) {
  const state = randomToken(rng, 4)
  const previousState = rng() < 0.5 ? '' : randomToken(rng, 4)
  const branch = randomToken(rng, 5)
  const headSha = randomSha(rng)
  const runNumber = String(1 + randomInt(rng, 5000))
  const runAttempt = String(1 + randomInt(rng, 5))
  const conclusion = pick(rng, ['success', 'failure', 'cancelled', 'timed_out', randomToken(rng, 2)])
  const runUrl = `https://example.test/run/${runNumber}_${randomToken(rng, 3)}/${index}(retry)`

  return {
    state,
    previousState,
    branch,
    headSha,
    runNumber,
    runAttempt,
    runUrl,
    conclusion
  }
}

function assertInvariants({ body, input, name, seed, index }) {
  const context = `${name} seed=${seed} case=${index}`

  assert.ok(body.endsWith('\n'), `${context}: output must end with newline`)
  assert.equal(body.split('\n').length, 10, `${context}: output must stay 9-line body + trailing newline`)
  assert.match(body, /^## Deploy verification evidence\n/m, `${context}: header missing`)
  assert.match(body, /<!-- deploy-evidence-state:[\s\S]* -->\n$/, `${context}: sentinel comment missing`)
  assert.ok(!body.includes('<!-- deploy-evidence-state:-->'), `${context}: empty sentinel state`)
  assert.ok(!body.includes('<!-- deploy-evidence-state:-->\n'), `${context}: raw terminator leaked into sentinel`)
  assert.ok(!body.includes('\r'), `${context}: carriage return should not appear`)

  const triggerLine = body.split('\n').find((line) => line.startsWith('- Trigger: ')) || ''
  assert.ok(!triggerLine.includes('\n'), `${context}: trigger line must be single-line`)

  const runLine = body.split('\n').find((line) => line.startsWith('- Run: ')) || ''
  assert.ok(runLine.includes('%29'), `${context}: run link should escape closing parenthesis`)
  assert.ok(!runLine.includes('\n'), `${context}: run line must be single-line`)

  const expectedCommitSnippet = `- Commit: \`${String(input.headSha).slice(0, 12)}\``
  assert.ok(body.includes(expectedCommitSnippet), `${context}: commit short SHA invariant violated`)
}
