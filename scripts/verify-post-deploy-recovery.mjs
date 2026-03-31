#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const readWorkflow = () => readFileSync('.github/workflows/deploy.yml', 'utf8')

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message)
  }
}

const parseOutputFile = (file) => {
  const raw = readFileSync(file, 'utf8').trim()
  const outputs = {}
  if (!raw) {
    return outputs
  }
  for (const line of raw.split('\n')) {
    const separator = line.indexOf('=')
    if (separator <= 0) {
      continue
    }
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    outputs[key] = value
  }
  return outputs
}

const runEvaluateCase = ({ status, previousStatus }) => {
  const tempDir = mkdtempSync(join(tmpdir(), 'corazon-recovery-verify-'))
  const reportFile = join(tempDir, 'report.json')
  const outputFile = join(tempDir, 'github-output.txt')
  writeFileSync(reportFile, JSON.stringify({ summary: { status } }), 'utf8')
  writeFileSync(outputFile, '', 'utf8')

  const run = spawnSync(
    'node',
    ['scripts/evaluate-post-deploy-recovery.mjs', '--report-file', reportFile, '--previous-status', previousStatus],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputFile
      },
      encoding: 'utf8'
    }
  )
  const outputs = parseOutputFile(outputFile)
  rmSync(tempDir, { recursive: true, force: true })

  if (run.status !== 0) {
    const errorText = [run.stdout, run.stderr].filter(Boolean).join('\n')
    throw new Error(`evaluate-post-deploy-recovery failed for status=${status}: ${errorText}`)
  }

  return outputs
}

const verifyWorkflowGuards = () => {
  const workflow = readWorkflow()
  assert(
    workflow.includes('deploy-production-check-only')
    && workflow.includes('deploy-production')
    && workflow.includes('inputs.post_deploy_check_only == true'),
    'deploy workflow must keep dedicated concurrency group for post_deploy_check_only dispatches'
  )
  assert(
    workflow.includes('if: always() && steps.recovery_gate.outputs.status != \'\''),
    'deploy workflow must skip persistence when recovery gate status output is empty'
  )
}

const verifyGatePolicy = () => {
  const down = runEvaluateCase({ status: 'down', previousStatus: '' })
  assert(down.status === 'down', 'down case must keep status=down')
  assert(down.gate === 'fail', 'down case must fail the gate')
  assert(down.follow_up_required === 'true', 'down case must request follow-up')

  const repeatedDegraded = runEvaluateCase({ status: 'degraded', previousStatus: 'degraded' })
  assert(repeatedDegraded.gate === 'warn', 'repeated degraded case must warn')
  assert(repeatedDegraded.follow_up_required === 'true', 'repeated degraded case must request follow-up')

  const singleDegraded = runEvaluateCase({ status: 'degraded', previousStatus: 'pass' })
  assert(singleDegraded.gate === 'warn', 'single degraded case must warn')
  assert(singleDegraded.follow_up_required === 'false', 'single degraded case must not force follow-up')

  const healthy = runEvaluateCase({ status: 'healthy', previousStatus: 'degraded' })
  assert(healthy.gate === 'pass', 'healthy case must pass the gate')
  assert(healthy.follow_up_required === 'false', 'healthy case must not request follow-up')
}

const main = () => {
  verifyWorkflowGuards()
  verifyGatePolicy()
  console.log('Post-deploy recovery regression checks passed.')
}

main()
