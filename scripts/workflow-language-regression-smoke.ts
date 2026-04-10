import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { parseWorkflowSource, serializeWorkflowSource } from '../server/utils/workflow-definitions.ts'
import { executeScriptWorkflowInSandbox } from '../server/utils/workflow-script-sandbox.ts'
import type { WorkflowFrontmatter } from '../types/workflow.ts'

const baseFrontmatter = (language: WorkflowFrontmatter['language']): WorkflowFrontmatter => ({
  name: 'Daily Summary',
  description: 'Summarize the latest activity.',
  language,
  on: { 'workflow-dispatch': true },
  skills: []
})

const run = async () => {
  const markdownSource = serializeWorkflowSource(
    {
      ...baseFrontmatter('markdown'),
      on: {
        'schedule': '13 * * * *',
        'workflow-dispatch': true
      }
    },
    '  Every day run this task.  \n\n   Send a concise report.  '
  )

  const markdown = parseWorkflowSource({
    fileSlug: 'daily-summary',
    filePath: '/tmp/daily-summary.md',
    source: markdownSource,
    updatedAt: Date.now()
  })

  assert.equal(markdown.isValid, true)
  assert.equal(markdown.frontmatter.language, 'markdown')
  assert.equal(markdown.frontmatter.on.schedule, '13 * * * *')
  assert.equal(markdown.instruction.includes('<goal>'), true)
  assert.equal(markdown.instruction.includes('Send a concise report.'), true)

  const pythonSource = serializeWorkflowSource(
    baseFrontmatter('python'),
    'for item in [1, 2]:\n    print(item)\n'
  )

  const python = parseWorkflowSource({
    fileSlug: 'python-dispatch',
    filePath: '/tmp/python-dispatch.md',
    source: pythonSource,
    updatedAt: Date.now()
  })

  assert.equal(python.isValid, true)
  assert.equal(python.frontmatter.language, 'python')
  assert.equal(python.frontmatter.on['workflow-dispatch'], true)
  assert.equal(python.frontmatter.on.schedule, undefined)
  assert.equal(python.frontmatter.on.interval, undefined)
  assert.equal(python.frontmatter.on.rrule, undefined)
  assert.equal(
    python.instruction,
    'for item in [1, 2]:\n    print(item)',
    'script workflows should preserve code body except leading/trailing whitespace trim'
  )

  const pythonScheduledSource = serializeWorkflowSource(
    {
      ...baseFrontmatter('python'),
      on: {
        'schedule': '*/5 * * * *',
        'workflow-dispatch': false
      }
    },
    'print("scheduled python")'
  )
  const pythonScheduled = parseWorkflowSource({
    fileSlug: 'python-scheduled',
    filePath: '/tmp/python-scheduled.md',
    source: pythonScheduledSource,
    updatedAt: Date.now()
  })
  assert.equal(pythonScheduled.isValid, true)
  assert.equal(pythonScheduled.frontmatter.on.schedule, '*/5 * * * *')
  assert.equal(pythonScheduled.frontmatter.on['workflow-dispatch'], false)

  const invalidLanguage = parseWorkflowSource({
    fileSlug: 'invalid-language',
    filePath: '/tmp/invalid-language.md',
    source: [
      '---',
      'name: Invalid Language',
      'description: should fail',
      'language: javascript',
      'on:',
      '  workflow-dispatch: true',
      'skills: []',
      '---',
      'do work'
    ].join('\n'),
    updatedAt: Date.now()
  })

  assert.equal(invalidLanguage.isValid, false)
  assert.match(invalidLanguage.parseError ?? '', /Frontmatter must include name, description, language, on, skills\./)

  const typescriptSource = serializeWorkflowSource(
    baseFrontmatter('typescript'),
    'console.log("ok")'
  )
  const typescript = parseWorkflowSource({
    fileSlug: 'typescript-dispatch',
    filePath: '/tmp/typescript-dispatch.md',
    source: typescriptSource,
    updatedAt: Date.now()
  })

  assert.equal(typescript.isValid, true)
  assert.equal(typescript.frontmatter.language, 'typescript')
  assert.equal(typescript.frontmatter.on['workflow-dispatch'], true)
  assert.equal(typescript.frontmatter.on.schedule, undefined)
  assert.equal(typescript.frontmatter.on.interval, undefined)
  assert.equal(typescript.frontmatter.on.rrule, undefined)

  const completedScriptRun = await executeScriptWorkflowInSandbox({
    definition: typescript,
    triggerType: 'workflow-dispatch',
    triggerValue: 'manual'
  })
  assert.equal(completedScriptRun.status, 'completed')
  assert.equal(completedScriptRun.metadata.providerId, 'local')
  assert.equal(completedScriptRun.metadata.language, 'typescript')
  assert.equal(completedScriptRun.metadata.runtimeCommand, 'node')
  assert.deepEqual(completedScriptRun.metadata.runtimeArgs, ['script.mjs'])
  assert.equal(completedScriptRun.metadata.policyTriggered, 'none')
  assert.equal(completedScriptRun.metadata.containmentModeRequested, 'host')
  assert.equal(completedScriptRun.metadata.containmentModeApplied, 'host')
  assert.equal(completedScriptRun.metadata.containmentEnforced, false)
  assert.equal(completedScriptRun.metadata.containmentFallbackReason, null)
  assert.equal(completedScriptRun.metadata.terminationScope, 'none')
  assert.equal(completedScriptRun.metadata.outputTruncated, false)
  assert.equal(completedScriptRun.metadata.executionDurationMs, completedScriptRun.durationMs)
  assert.equal(completedScriptRun.metadata.prepareDurationMs >= 0, true)
  assert.equal(completedScriptRun.metadata.executeDurationMs >= 0, true)
  assert.equal(completedScriptRun.metadata.teardownDurationMs >= 0, true)

  const pythonExecuted = await executeScriptWorkflowInSandbox({
    definition: python,
    triggerType: 'workflow-dispatch',
    triggerValue: 'manual'
  })
  assert.equal(pythonExecuted.status, 'completed')
  assert.match(pythonExecuted.stdout, /1/)
  assert.match(pythonExecuted.stdout, /2/)
  assert.equal(pythonExecuted.metadata.runtimeCommand, 'python3')
  assert.deepEqual(pythonExecuted.metadata.runtimeArgs, ['script.py'])

  const pythonScheduledExecuted = await executeScriptWorkflowInSandbox({
    definition: pythonScheduled,
    triggerType: 'schedule',
    triggerValue: '*/5 * * * *'
  })
  assert.equal(pythonScheduledExecuted.status, 'completed')
  assert.match(pythonScheduledExecuted.stdout, /scheduled python/)

  const previousPythonBin = process.env.CORAZON_WORKFLOW_PYTHON_BIN
  process.env.CORAZON_WORKFLOW_PYTHON_BIN = 'corazon-missing-python-bin'
  const providerFailureRun = await executeScriptWorkflowInSandbox({
    definition: python,
    triggerType: 'workflow-dispatch',
    triggerValue: 'manual'
  })
  if (typeof previousPythonBin === 'string') {
    process.env.CORAZON_WORKFLOW_PYTHON_BIN = previousPythonBin
  } else {
    delete process.env.CORAZON_WORKFLOW_PYTHON_BIN
  }
  assert.equal(providerFailureRun.status, 'failed')
  assert.equal(providerFailureRun.errorCode, 'provider-error')
  assert.equal(providerFailureRun.metadata.failurePhase, 'execute')
  assert.equal(providerFailureRun.metadata.executionDurationMs, providerFailureRun.durationMs)
  assert.equal(providerFailureRun.metadata.prepareDurationMs >= 0, true)
  assert.equal(providerFailureRun.metadata.executeDurationMs >= 0, true)
  assert.equal(providerFailureRun.metadata.teardownDurationMs >= 0, true)
  assert.match(providerFailureRun.errorMessage, /Failed to start script runtime/)

  const previousProvider = process.env.CORAZON_WORKFLOW_SCRIPT_SANDBOX_PROVIDER
  process.env.CORAZON_WORKFLOW_SCRIPT_SANDBOX_PROVIDER = ''
  const pythonWithBlankProvider = await executeScriptWorkflowInSandbox({
    definition: python,
    triggerType: 'workflow-dispatch',
    triggerValue: 'manual'
  })
  if (typeof previousProvider === 'string') {
    process.env.CORAZON_WORKFLOW_SCRIPT_SANDBOX_PROVIDER = previousProvider
  } else {
    delete process.env.CORAZON_WORKFLOW_SCRIPT_SANDBOX_PROVIDER
  }
  assert.equal(
    pythonWithBlankProvider.status,
    'completed',
    'empty sandbox provider env should fall back to local provider'
  )

  const previousContainmentMode = process.env.CORAZON_WORKFLOW_SCRIPT_CONTAINMENT_MODE
  process.env.CORAZON_WORKFLOW_SCRIPT_CONTAINMENT_MODE = 'auto'
  const autoContainmentRun = await executeScriptWorkflowInSandbox({
    definition: python,
    triggerType: 'workflow-dispatch',
    triggerValue: 'manual'
  })
  assert.equal(autoContainmentRun.status, 'completed')
  assert.equal(autoContainmentRun.metadata.containmentModeRequested, 'auto')
  assert.equal(autoContainmentRun.metadata.containmentModeApplied, 'host')
  assert.equal(autoContainmentRun.metadata.containmentEnforced, false)
  assert.match(
    autoContainmentRun.metadata.containmentFallbackReason ?? '',
    /OS-level containment adapter is not configured/
  )

  process.env.CORAZON_WORKFLOW_SCRIPT_CONTAINMENT_MODE = 'linux-strict'
  const strictContainmentRun = await executeScriptWorkflowInSandbox({
    definition: python,
    triggerType: 'workflow-dispatch',
    triggerValue: 'manual'
  })
  if (typeof previousContainmentMode === 'string') {
    process.env.CORAZON_WORKFLOW_SCRIPT_CONTAINMENT_MODE = previousContainmentMode
  } else {
    delete process.env.CORAZON_WORKFLOW_SCRIPT_CONTAINMENT_MODE
  }
  assert.equal(strictContainmentRun.status, 'failed')
  assert.equal(strictContainmentRun.errorCode, 'provider-error')
  assert.equal(strictContainmentRun.metadata.failurePhase, 'prepare')
  assert.equal(strictContainmentRun.metadata.containmentModeRequested, 'linux-strict')
  assert.equal(strictContainmentRun.metadata.containmentModeApplied, 'linux-strict')
  assert.equal(strictContainmentRun.metadata.containmentEnforced, false)
  assert.equal(strictContainmentRun.metadata.containmentFallbackReason, null)
  assert.match(strictContainmentRun.errorMessage, /not yet supported/)

  const envPolicySource = serializeWorkflowSource(
    baseFrontmatter('python'),
    'import os\n'
    + 'print(f"ALLOWED={os.environ.get(\'CORAZON_TEST_ALLOWED_ENV\', \'missing\')}")\n'
    + 'print(f"BLOCKED={os.environ.get(\'CORAZON_TEST_BLOCKED_ENV\', \'missing\')}")\n'
    + 'print(f"HOME={os.environ.get(\'HOME\', \'missing\')}")\n'
    + 'print(f"TMPDIR={os.environ.get(\'TMPDIR\', \'missing\')}")'
  )
  const envPolicyWorkflow = parseWorkflowSource({
    fileSlug: 'python-env-policy',
    filePath: '/tmp/python-env-policy.md',
    source: envPolicySource,
    updatedAt: Date.now()
  })
  const previousAllowlist = process.env.CORAZON_WORKFLOW_SCRIPT_ENV_ALLOWLIST
  const previousAllowedEnv = process.env.CORAZON_TEST_ALLOWED_ENV
  const previousBlockedEnv = process.env.CORAZON_TEST_BLOCKED_ENV
  process.env.CORAZON_WORKFLOW_SCRIPT_ENV_ALLOWLIST = 'CORAZON_TEST_ALLOWED_ENV'
  process.env.CORAZON_TEST_ALLOWED_ENV = 'allowed'
  process.env.CORAZON_TEST_BLOCKED_ENV = 'blocked'
  const envPolicyRun = await executeScriptWorkflowInSandbox({
    definition: envPolicyWorkflow,
    triggerType: 'workflow-dispatch',
    triggerValue: 'manual'
  })
  if (typeof previousAllowlist === 'string') {
    process.env.CORAZON_WORKFLOW_SCRIPT_ENV_ALLOWLIST = previousAllowlist
  } else {
    delete process.env.CORAZON_WORKFLOW_SCRIPT_ENV_ALLOWLIST
  }
  if (typeof previousAllowedEnv === 'string') {
    process.env.CORAZON_TEST_ALLOWED_ENV = previousAllowedEnv
  } else {
    delete process.env.CORAZON_TEST_ALLOWED_ENV
  }
  if (typeof previousBlockedEnv === 'string') {
    process.env.CORAZON_TEST_BLOCKED_ENV = previousBlockedEnv
  } else {
    delete process.env.CORAZON_TEST_BLOCKED_ENV
  }
  assert.equal(envPolicyRun.status, 'completed')
  assert.match(envPolicyRun.stdout, /ALLOWED=allowed/)
  assert.match(envPolicyRun.stdout, /BLOCKED=missing/)
  const sandboxHome = envPolicyRun.stdout.match(/^HOME=(.+)$/m)?.[1] ?? null
  const sandboxTmpDir = envPolicyRun.stdout.match(/^TMPDIR=(.+)$/m)?.[1] ?? null
  assert.equal(typeof sandboxHome, 'string')
  assert.equal(typeof sandboxTmpDir, 'string')
  assert.equal(sandboxHome?.startsWith('/tmp/corazon-workflow-script-') ?? false, true)
  assert.equal(sandboxTmpDir?.startsWith('/tmp/corazon-workflow-script-') ?? false, true)
  assert.deepEqual(envPolicyRun.metadata.allowedEnvKeys, ['CORAZON_TEST_ALLOWED_ENV'])

  const previousHostHome = process.env.HOME
  const previousHostTmpDir = process.env.TMPDIR
  const previousAllowedEnvForReserved = process.env.CORAZON_TEST_ALLOWED_ENV
  await mkdir('/tmp/corazon-host-home', { recursive: true })
  await mkdir('/tmp/corazon-host-tmp', { recursive: true })
  process.env.CORAZON_WORKFLOW_SCRIPT_ENV_ALLOWLIST = 'CORAZON_TEST_ALLOWED_ENV,HOME,TMPDIR'
  process.env.CORAZON_TEST_ALLOWED_ENV = 'allowed'
  process.env.HOME = '/tmp/corazon-host-home'
  process.env.TMPDIR = '/tmp/corazon-host-tmp'
  const reservedEnvPolicyRun = await executeScriptWorkflowInSandbox({
    definition: envPolicyWorkflow,
    triggerType: 'workflow-dispatch',
    triggerValue: 'manual'
  })
  if (typeof previousAllowlist === 'string') {
    process.env.CORAZON_WORKFLOW_SCRIPT_ENV_ALLOWLIST = previousAllowlist
  } else {
    delete process.env.CORAZON_WORKFLOW_SCRIPT_ENV_ALLOWLIST
  }
  if (typeof previousHostHome === 'string') {
    process.env.HOME = previousHostHome
  } else {
    delete process.env.HOME
  }
  if (typeof previousHostTmpDir === 'string') {
    process.env.TMPDIR = previousHostTmpDir
  } else {
    delete process.env.TMPDIR
  }
  if (typeof previousAllowedEnvForReserved === 'string') {
    process.env.CORAZON_TEST_ALLOWED_ENV = previousAllowedEnvForReserved
  } else {
    delete process.env.CORAZON_TEST_ALLOWED_ENV
  }
  assert.equal(reservedEnvPolicyRun.status, 'completed')
  assert.match(reservedEnvPolicyRun.stdout, /ALLOWED=allowed/)
  const reservedSandboxHome = reservedEnvPolicyRun.stdout.match(/^HOME=(.+)$/m)?.[1] ?? null
  const reservedSandboxTmpDir = reservedEnvPolicyRun.stdout.match(/^TMPDIR=(.+)$/m)?.[1] ?? null
  assert.equal(typeof reservedSandboxHome, 'string')
  assert.equal(typeof reservedSandboxTmpDir, 'string')
  assert.equal(reservedSandboxHome === '/tmp/corazon-host-home', false)
  assert.equal(reservedSandboxTmpDir === '/tmp/corazon-host-tmp', false)
  assert.equal(reservedSandboxHome?.includes('corazon-workflow-script-') ?? false, true)
  assert.equal(reservedSandboxTmpDir?.includes('corazon-workflow-script-') ?? false, true)

  const failedScriptSource = serializeWorkflowSource(
    baseFrontmatter('typescript'),
    'console.error("boom"); process.exit(7)'
  )
  const failedScriptWorkflow = parseWorkflowSource({
    fileSlug: 'typescript-failure',
    filePath: '/tmp/typescript-failure.md',
    source: failedScriptSource,
    updatedAt: Date.now()
  })
  const failedScriptRun = await executeScriptWorkflowInSandbox({
    definition: failedScriptWorkflow,
    triggerType: 'workflow-dispatch',
    triggerValue: 'manual'
  })
  assert.equal(failedScriptRun.status, 'failed')
  assert.equal(failedScriptRun.errorCode, 'execution-failed')
  assert.equal(failedScriptRun.exitCode, 7)

  const timeoutSource = serializeWorkflowSource(
    baseFrontmatter('typescript'),
    'await new Promise(resolve => setTimeout(resolve, 120));\nconsole.log("done")'
  )
  const timeoutWorkflow = parseWorkflowSource({
    fileSlug: 'typescript-timeout',
    filePath: '/tmp/typescript-timeout.md',
    source: timeoutSource,
    updatedAt: Date.now()
  })
  const previousTimeout = process.env.CORAZON_WORKFLOW_SCRIPT_TIMEOUT_MS
  process.env.CORAZON_WORKFLOW_SCRIPT_TIMEOUT_MS = '50'
  const timedOutScriptRun = await executeScriptWorkflowInSandbox({
    definition: timeoutWorkflow,
    triggerType: 'workflow-dispatch',
    triggerValue: 'manual'
  })
  if (typeof previousTimeout === 'string') {
    process.env.CORAZON_WORKFLOW_SCRIPT_TIMEOUT_MS = previousTimeout
  } else {
    delete process.env.CORAZON_WORKFLOW_SCRIPT_TIMEOUT_MS
  }
  assert.equal(timedOutScriptRun.status, 'failed')
  assert.equal(timedOutScriptRun.errorCode, 'execution-timeout')
  assert.equal(
    ['process-group', 'process'].includes(timedOutScriptRun.metadata.terminationScope),
    true
  )

  const outputPolicySource = serializeWorkflowSource(
    baseFrontmatter('python'),
    'print("x" * 2000)'
  )
  const outputPolicyWorkflow = parseWorkflowSource({
    fileSlug: 'python-output-policy',
    filePath: '/tmp/python-output-policy.md',
    source: outputPolicySource,
    updatedAt: Date.now()
  })
  const previousMaxOutput = process.env.CORAZON_WORKFLOW_SCRIPT_MAX_OUTPUT_BYTES
  process.env.CORAZON_WORKFLOW_SCRIPT_MAX_OUTPUT_BYTES = '1024'
  const outputPolicyRun = await executeScriptWorkflowInSandbox({
    definition: outputPolicyWorkflow,
    triggerType: 'workflow-dispatch',
    triggerValue: 'manual'
  })
  if (typeof previousMaxOutput === 'string') {
    process.env.CORAZON_WORKFLOW_SCRIPT_MAX_OUTPUT_BYTES = previousMaxOutput
  } else {
    delete process.env.CORAZON_WORKFLOW_SCRIPT_MAX_OUTPUT_BYTES
  }
  assert.equal(outputPolicyRun.status, 'failed')
  assert.equal(outputPolicyRun.errorCode, 'policy-violation')
  assert.match(outputPolicyRun.errorMessage, /exceeded 1024 bytes/)
  assert.equal(outputPolicyRun.metadata.policyTriggered, 'output-size')
  assert.equal(outputPolicyRun.metadata.outputTruncated, true)
  assert.equal(outputPolicyRun.metadata.executionDurationMs, outputPolicyRun.durationMs)
  assert.equal(outputPolicyRun.metadata.prepareDurationMs >= 0, true)
  assert.equal(outputPolicyRun.metadata.executeDurationMs >= 0, true)
  assert.equal(outputPolicyRun.metadata.teardownDurationMs >= 0, true)
  assert.equal(outputPolicyRun.metadata.totalOutputBytes > 1024, true)
  assert.equal(
    ['process-group', 'process'].includes(outputPolicyRun.metadata.terminationScope),
    true
  )

  const runnerArtifactExcludeSource = serializeWorkflowSource(
    baseFrontmatter('typescript'),
    `const payload = "${'x'.repeat(9000)}";\nconsole.log(payload.length)`
  )
  const runnerArtifactExcludeWorkflow = parseWorkflowSource({
    fileSlug: 'typescript-tmp-runner-artifact-exclude',
    filePath: '/tmp/typescript-tmp-runner-artifact-exclude.md',
    source: runnerArtifactExcludeSource,
    updatedAt: Date.now()
  })
  const previousMaxTmpForRunnerArtifact = process.env.CORAZON_WORKFLOW_SCRIPT_MAX_TMP_BYTES
  process.env.CORAZON_WORKFLOW_SCRIPT_MAX_TMP_BYTES = '4096'
  const runnerArtifactExcludeRun = await executeScriptWorkflowInSandbox({
    definition: runnerArtifactExcludeWorkflow,
    triggerType: 'workflow-dispatch',
    triggerValue: 'manual'
  })
  if (typeof previousMaxTmpForRunnerArtifact === 'string') {
    process.env.CORAZON_WORKFLOW_SCRIPT_MAX_TMP_BYTES = previousMaxTmpForRunnerArtifact
  } else {
    delete process.env.CORAZON_WORKFLOW_SCRIPT_MAX_TMP_BYTES
  }
  assert.equal(
    runnerArtifactExcludeRun.status,
    'completed',
    'runner-generated script artifacts should not count against tmp usage policy'
  )
  assert.equal(runnerArtifactExcludeRun.metadata.policyTriggered, 'none')

  const tmpPolicySource = serializeWorkflowSource(
    baseFrontmatter('python'),
    'from pathlib import Path\n'
    + 'Path("payload.bin").write_bytes(b"x" * 6144)\n'
    + 'print("tmp payload written")'
  )
  const tmpPolicyWorkflow = parseWorkflowSource({
    fileSlug: 'python-tmp-policy',
    filePath: '/tmp/python-tmp-policy.md',
    source: tmpPolicySource,
    updatedAt: Date.now()
  })
  const previousMaxTmp = process.env.CORAZON_WORKFLOW_SCRIPT_MAX_TMP_BYTES
  process.env.CORAZON_WORKFLOW_SCRIPT_MAX_TMP_BYTES = '4096'
  const tmpPolicyRun = await executeScriptWorkflowInSandbox({
    definition: tmpPolicyWorkflow,
    triggerType: 'workflow-dispatch',
    triggerValue: 'manual'
  })
  if (typeof previousMaxTmp === 'string') {
    process.env.CORAZON_WORKFLOW_SCRIPT_MAX_TMP_BYTES = previousMaxTmp
  } else {
    delete process.env.CORAZON_WORKFLOW_SCRIPT_MAX_TMP_BYTES
  }
  assert.equal(tmpPolicyRun.status, 'failed')
  assert.equal(tmpPolicyRun.errorCode, 'policy-violation')
  assert.match(tmpPolicyRun.errorMessage, /temporary workspace exceeded 4096 bytes/)
  assert.equal(tmpPolicyRun.metadata.policyTriggered, 'tmp-size')
  assert.equal(tmpPolicyRun.metadata.maxTmpBytes, 4096)
  assert.equal(tmpPolicyRun.metadata.tmpBytes > 4096, true)

  const sourcePolicySource = serializeWorkflowSource(
    baseFrontmatter('python'),
    `print("${'x'.repeat(400)}")`
  )
  const sourcePolicyWorkflow = parseWorkflowSource({
    fileSlug: 'python-source-policy',
    filePath: '/tmp/python-source-policy.md',
    source: sourcePolicySource,
    updatedAt: Date.now()
  })
  const previousMaxSource = process.env.CORAZON_WORKFLOW_SCRIPT_MAX_SOURCE_BYTES
  process.env.CORAZON_WORKFLOW_SCRIPT_MAX_SOURCE_BYTES = '256'
  const sourcePolicyRun = await executeScriptWorkflowInSandbox({
    definition: sourcePolicyWorkflow,
    triggerType: 'workflow-dispatch',
    triggerValue: 'manual'
  })
  if (typeof previousMaxSource === 'string') {
    process.env.CORAZON_WORKFLOW_SCRIPT_MAX_SOURCE_BYTES = previousMaxSource
  } else {
    delete process.env.CORAZON_WORKFLOW_SCRIPT_MAX_SOURCE_BYTES
  }
  assert.equal(sourcePolicyRun.status, 'failed')
  assert.equal(sourcePolicyRun.errorCode, 'policy-violation')
  assert.match(sourcePolicyRun.errorMessage, /source exceeded 256 bytes/)
  assert.equal(sourcePolicyRun.metadata.policyTriggered, 'source-size')
  assert.equal(sourcePolicyRun.metadata.executionDurationMs, sourcePolicyRun.durationMs)
  assert.equal(sourcePolicyRun.metadata.prepareDurationMs, 0)
  assert.equal(sourcePolicyRun.metadata.executeDurationMs, 0)
  assert.equal(sourcePolicyRun.metadata.teardownDurationMs, 0)

  console.log('workflow language regression smoke checks passed')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
