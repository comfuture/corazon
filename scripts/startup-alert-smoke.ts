import assert from 'node:assert/strict'
import { buildStartupAlertPayload } from '../lib/startup-alert-payload.ts'
import { shouldSendStartupAlertForRuntime } from '../lib/startup-alert-runtime.ts'

const facts = [
  'Corazon server restarted successfully.',
  'Host: test-host',
  'PID: 1234',
  'Started at: 2026-04-01T00:00:00.000Z'
]

const run = async () => {
  const disabled = await buildStartupAlertPayload({
    telegramEnabled: false,
    facts,
    branch: 'main',
    runCodexProbe: async () => 'probe should not run',
    formatProbeError: error => String(error)
  })
  assert.equal(disabled, null, 'Telegram disabled should skip startup alert payload')

  const success = await buildStartupAlertPayload({
    telegramEnabled: true,
    facts,
    branch: 'main',
    runCodexProbe: async () => 'Codex responded normally during startup health verification.',
    formatProbeError: error => String(error)
  })
  assert.ok(success, 'Telegram enabled should produce payload')
  assert.equal(success?.severity, 'info')
  assert.equal(success?.nextAction, null)
  assert.match(success?.message ?? '', /Codex probe: Codex responded normally/)

  const failed = await buildStartupAlertPayload({
    telegramEnabled: true,
    facts,
    branch: 'main',
    runCodexProbe: async () => {
      throw new Error('simulated codex auth failure')
    },
    formatProbeError: error =>
      error instanceof Error ? error.message : String(error)
  })
  assert.ok(failed, 'Probe failure should still produce payload')
  assert.equal(failed?.severity, 'warning')
  assert.match(failed?.message ?? '', /Codex startup probe failed:/)
  assert.match(failed?.nextAction ?? '', /Check ChatGPT\/Codex auth/)

  assert.equal(shouldSendStartupAlertForRuntime({
    argv: ['node', '/workspace/node_modules/.bin/nuxi', 'build'],
    env: {
      NODE_ENV: 'production',
      npm_lifecycle_event: 'build'
    },
    dev: false,
    prerender: false
  }), false, 'nuxi build should not send startup alerts')

  assert.equal(shouldSendStartupAlertForRuntime({
    argv: ['node', '/workspace/scripts/start-server.mjs'],
    env: {
      NODE_ENV: 'production'
    },
    dev: false,
    prerender: false
  }), true, 'production server launcher should send startup alerts')

  console.log('startup alert smoke checks passed')
}

void run()
