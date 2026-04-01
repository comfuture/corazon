#!/usr/bin/env node
import { existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000'
const DEFAULT_TIMEOUT_MS = 8000
const DEFAULT_AGENT_HOME = resolve(
  process.env.CORAZON_ROOT_DIR?.trim() || join(process.env.HOME ?? '/root', '.corazon')
)

const getDefaultRuntimeRoot = (agentHome) => {
  const currentName = basename(agentHome) || '.corazon'
  const runtimeName = currentName.startsWith('.') || currentName === currentName.toLowerCase()
    ? `${currentName}-runtime`
    : `${currentName}Runtime`
  return join(dirname(agentHome), runtimeName)
}

const DEFAULT_RUNTIME_ROOT = resolve(
  process.env.CORAZON_RUNTIME_ROOT_DIR?.trim() || getDefaultRuntimeRoot(DEFAULT_AGENT_HOME)
)
const DEFAULT_THREADS_ROOT = resolve(
  process.env.CORAZON_THREADS_DIR?.trim() || join(DEFAULT_RUNTIME_ROOT, 'threads')
)
const DEFAULT_WORKFLOW_LOCAL_DATA_DIR = resolve(
  process.env.WORKFLOW_LOCAL_DATA_DIR?.trim() || join(DEFAULT_RUNTIME_ROOT, 'workflow-data')
)

const printHelp = () => {
  console.log(`Usage: node scripts/post-deploy-recovery.mjs [options]

Options:
  --base-url <url>           Target Corazon base URL (default: ${DEFAULT_BASE_URL})
  --agent-home <path>        Corazon agent home for config/auth checks (default: ${DEFAULT_AGENT_HOME})
  --runtime-root <path>      Runtime root for local checks (default: ${DEFAULT_RUNTIME_ROOT})
  --threads-root <path>      Thread workspace root (default: ${DEFAULT_THREADS_ROOT})
  --workflow-local-data-dir <path>  Workflow local data directory (default: ${DEFAULT_WORKFLOW_LOCAL_DATA_DIR})
  --timeout-ms <ms>          HTTP timeout per check (default: ${DEFAULT_TIMEOUT_MS})
  --apply-safe-fixes         Apply narrow safe local fixes (directory bootstrap only)
  --probe-agent              Add lightweight /api/chat stream probe
  --json                     Print machine-readable JSON report
  --help                     Show this help
`)
}

const parseArgs = (argv) => {
  const options = {
    baseUrl: DEFAULT_BASE_URL,
    agentHome: DEFAULT_AGENT_HOME,
    runtimeRoot: DEFAULT_RUNTIME_ROOT,
    threadsRoot: DEFAULT_THREADS_ROOT,
    workflowLocalDataDir: DEFAULT_WORKFLOW_LOCAL_DATA_DIR,
    agentHomeExplicit: false,
    runtimeRootExplicit: false,
    threadsRootExplicit: false,
    workflowLocalDataDirExplicit: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    applySafeFixes: false,
    probeAgent: false,
    json: false,
    help: false
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg === '--json') {
      options.json = true
      continue
    }
    if (arg === '--apply-safe-fixes') {
      options.applySafeFixes = true
      continue
    }
    if (arg === '--probe-agent') {
      options.probeAgent = true
      continue
    }
    if (arg === '--base-url') {
      options.baseUrl = argv[index + 1] ?? ''
      index += 1
      continue
    }
    if (arg.startsWith('--base-url=')) {
      options.baseUrl = arg.split('=', 2)[1] ?? ''
      continue
    }
    if (arg === '--agent-home') {
      options.agentHome = argv[index + 1] ?? ''
      options.agentHomeExplicit = true
      index += 1
      continue
    }
    if (arg.startsWith('--agent-home=')) {
      options.agentHome = arg.split('=', 2)[1] ?? ''
      options.agentHomeExplicit = true
      continue
    }
    if (arg === '--runtime-root') {
      options.runtimeRoot = argv[index + 1] ?? ''
      options.runtimeRootExplicit = true
      index += 1
      continue
    }
    if (arg.startsWith('--runtime-root=')) {
      options.runtimeRoot = arg.split('=', 2)[1] ?? ''
      options.runtimeRootExplicit = true
      continue
    }
    if (arg === '--threads-root') {
      options.threadsRoot = argv[index + 1] ?? ''
      options.threadsRootExplicit = true
      index += 1
      continue
    }
    if (arg.startsWith('--threads-root=')) {
      options.threadsRoot = arg.split('=', 2)[1] ?? ''
      options.threadsRootExplicit = true
      continue
    }
    if (arg === '--workflow-local-data-dir') {
      options.workflowLocalDataDir = argv[index + 1] ?? ''
      options.workflowLocalDataDirExplicit = true
      index += 1
      continue
    }
    if (arg.startsWith('--workflow-local-data-dir=')) {
      options.workflowLocalDataDir = arg.split('=', 2)[1] ?? ''
      options.workflowLocalDataDirExplicit = true
      continue
    }
    if (arg === '--timeout-ms') {
      options.timeoutMs = Number.parseInt(argv[index + 1] ?? '', 10)
      index += 1
      continue
    }
    if (arg.startsWith('--timeout-ms=')) {
      options.timeoutMs = Number.parseInt(arg.split('=', 2)[1] ?? '', 10)
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('`--timeout-ms` must be a positive integer.')
  }

  if (!options.baseUrl || !/^https?:\/\//i.test(options.baseUrl)) {
    throw new Error('`--base-url` must include http:// or https://')
  }

  if (!options.agentHome.trim()) {
    throw new Error('`--agent-home` must not be empty.')
  }
  if (!options.runtimeRoot.trim()) {
    throw new Error('`--runtime-root` must not be empty.')
  }
  if (!options.threadsRoot.trim()) {
    throw new Error('`--threads-root` must not be empty.')
  }
  if (!options.workflowLocalDataDir.trim()) {
    throw new Error('`--workflow-local-data-dir` must not be empty.')
  }

  options.baseUrl = options.baseUrl.replace(/\/+$/, '')
  options.agentHome = resolve(options.agentHome.trim())
  options.runtimeRoot = resolve(options.runtimeRoot.trim())
  if (options.runtimeRootExplicit) {
    if (!options.threadsRootExplicit) {
      options.threadsRoot = join(options.runtimeRoot, 'threads')
    }
    if (!options.workflowLocalDataDirExplicit) {
      options.workflowLocalDataDir = join(options.runtimeRoot, 'workflow-data')
    }
  }
  options.threadsRoot = resolve(options.threadsRoot.trim())
  options.workflowLocalDataDir = resolve(options.workflowLocalDataDir.trim())
  return options
}

const nowIso = () => new Date().toISOString()

const checkHttpJson = async ({
  method = 'GET',
  url,
  timeoutMs,
  body = null,
  name,
  critical = true,
  readBody = 'json'
}) => {
  const startedAt = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, timeoutMs)

  try {
    const response = await fetch(url, {
      method,
      headers: body
        ? {
            'content-type': 'application/json'
          }
        : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    })
    const durationMs = Date.now() - startedAt
    let parsed = null
    if (readBody !== 'none') {
      const text = await response.text()
      if (text.trim().length > 0) {
        if (readBody === 'json') {
          try {
            parsed = JSON.parse(text)
          } catch {
            parsed = null
          }
        } else {
          parsed = text
        }
      }
    }
    return {
      name,
      url,
      method,
      critical,
      ok: response.ok,
      status: response.status,
      durationMs,
      error: response.ok ? null : `HTTP ${response.status}`,
      payload: parsed
    }
  } catch (error) {
    const durationMs = Date.now() - startedAt
    return {
      name,
      url,
      method,
      critical,
      ok: false,
      status: null,
      durationMs,
      error: error instanceof Error ? error.message : 'Unknown request failure',
      payload: null
    }
  } finally {
    clearTimeout(timeout)
  }
}

const runAgentProbe = async ({ baseUrl, timeoutMs }) => {
  const probeMessage = {
    id: `post-deploy-probe-${Date.now()}`,
    role: 'user',
    parts: [
      {
        type: 'text',
        text: 'post-deploy functional probe'
      }
    ]
  }

  const result = await checkHttpJson({
    method: 'POST',
    url: `${baseUrl}/api/chat`,
    timeoutMs,
    name: 'chat-stream-probe',
    critical: false,
    body: {
      threadId: null,
      resume: false,
      attachmentUploadId: null,
      skipGitRepoCheck: true,
      model: null,
      origin: 'web',
      streamMode: 'web',
      messages: [probeMessage]
    },
    readBody: 'none'
  })

  return {
    ...result,
    note: result.ok
      ? 'chat stream endpoint accepted a probe payload'
      : 'chat stream probe failed (non-agent checks may still pass)'
  }
}

const collectLocalChecks = (agentHome, runtimeRoot, threadsRoot, workflowLocalDataDir) => {
  const checks = [
    { name: 'agent-home', path: agentHome, required: true },
    { name: 'runtime-root', path: runtimeRoot, required: true },
    { name: 'config.toml', path: join(agentHome, 'config.toml'), required: true },
    { name: 'workflow-data', path: workflowLocalDataDir, required: true },
    { name: 'threads', path: threadsRoot, required: true },
    { name: 'auth.json', path: join(agentHome, 'auth.json'), required: false }
  ]

  return checks.map(check => ({
    ...check,
    exists: existsSync(check.path)
  }))
}

const applySafeFixes = (localChecks) => {
  const actions = []
  for (const check of localChecks) {
    if (check.exists || !check.required) {
      continue
    }
    if (check.name === 'runtime-root' || check.name === 'workflow-data' || check.name === 'threads') {
      mkdirSync(check.path, { recursive: true })
      actions.push({
        action: `mkdir -p ${check.path}`,
        outcome: 'applied'
      })
    }
  }
  return actions
}

const classify = ({ probes, localChecks, agentProbe }) => {
  const serviceUp = probes.find(probe => probe.name === 'workflows-index')?.ok ?? false
  const nonAgentCritical = probes.filter(probe => probe.critical)
  const functionalHealthy = nonAgentCritical.length > 0 && nonAgentCritical.every(probe => probe.ok)
  const localRequiredMissing = localChecks.filter(check => check.required && !check.exists)
  const symptoms = []

  if (!serviceUp) {
    symptoms.push('service endpoint not reachable or workflows API failing')
  }
  if (!functionalHealthy) {
    symptoms.push('one or more non-agent functional checks failed')
  }
  if (localRequiredMissing.length > 0) {
    symptoms.push(`missing required runtime assets: ${localRequiredMissing.map(item => item.name).join(', ')}`)
  }
  if (agentProbe && !agentProbe.ok) {
    symptoms.push('agent stream probe failed while non-agent path may still be alive')
  }

  let suspectedRootCause = 'no critical failure detected'
  if (!serviceUp) {
    suspectedRootCause = 'transport/startup failure'
  } else if (localRequiredMissing.length > 0) {
    suspectedRootCause = 'runtime bootstrap/configuration regression'
  } else if (!functionalHealthy) {
    suspectedRootCause = 'core dependency regression (memory/settings/workflow state)'
  } else if (agentProbe && !agentProbe.ok) {
    suspectedRootCause = 'agent runtime path degraded'
  }

  let confidence = 'high'
  if (!serviceUp) {
    confidence = 'high'
  } else if (!functionalHealthy || localRequiredMissing.length > 0) {
    confidence = 'medium'
  } else if (agentProbe && !agentProbe.ok) {
    confidence = 'medium'
  }

  const proposedActions = []
  if (!serviceUp) {
    proposedActions.push('verify container/process startup logs and port binding')
    proposedActions.push('redeploy last known-good image if startup regression is confirmed')
  }
  if (localRequiredMissing.length > 0) {
    proposedActions.push('restore missing runtime assets under runtime root or rerun setup/bootstrap')
  }
  if (!functionalHealthy && serviceUp) {
    proposedActions.push('inspect failing API route logs and dependency wiring (memory/config/db)')
  }
  if (agentProbe && !agentProbe.ok && functionalHealthy) {
    proposedActions.push('treat as agent-path-only degradation and restart codex runtime path')
  }
  if (proposedActions.length === 0) {
    proposedActions.push('no immediate recovery action required')
  }

  const rollbackRecommendation = (!serviceUp || (!functionalHealthy && serviceUp))
    ? 'prepare rollback to last known-good deploy if remediation does not restore checks quickly'
    : 'rollback not required at this time'

  const status = (serviceUp && functionalHealthy && localRequiredMissing.length === 0 && (!agentProbe || agentProbe.ok))
    ? 'healthy'
    : (serviceUp ? 'degraded' : 'down')

  return {
    status,
    serviceUp,
    functionalHealthy,
    suspectedRootCause,
    confidence,
    symptoms,
    proposedActions,
    rollbackRecommendation
  }
}

const printTextReport = (report) => {
  const lines = []
  lines.push('Post-deploy recovery report')
  lines.push(`Timestamp: ${report.timestamp}`)
  lines.push(`Status: ${report.summary.status}`)
  lines.push(`Service up: ${report.summary.serviceUp ? 'yes' : 'no'}`)
  lines.push(`Functional health (non-agent): ${report.summary.functionalHealthy ? 'pass' : 'fail'}`)
  lines.push(`Suspected root cause: ${report.summary.suspectedRootCause}`)
  lines.push(`Confidence: ${report.summary.confidence}`)
  lines.push('Symptoms:')
  if (report.summary.symptoms.length === 0) {
    lines.push('- none')
  } else {
    for (const symptom of report.summary.symptoms) {
      lines.push(`- ${symptom}`)
    }
  }
  lines.push('Proposed actions:')
  for (const action of report.summary.proposedActions) {
    lines.push(`- ${action}`)
  }
  lines.push(`Rollback recommendation: ${report.summary.rollbackRecommendation}`)
  lines.push('Attempted actions:')
  if (report.attemptedActions.length === 0) {
    lines.push('- none')
  } else {
    for (const action of report.attemptedActions) {
      lines.push(`- ${action.action} (${action.outcome})`)
    }
  }
  console.log(lines.join('\n'))
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }

  const probes = []
  probes.push(await checkHttpJson({
    method: 'GET',
    url: `${options.baseUrl}/api/workflows`,
    timeoutMs: options.timeoutMs,
    name: 'workflows-index',
    critical: true
  }))
  probes.push(await checkHttpJson({
    method: 'GET',
    url: `${options.baseUrl}/api/memory/health`,
    timeoutMs: options.timeoutMs,
    name: 'memory-health',
    critical: true
  }))
  probes.push(await checkHttpJson({
    method: 'GET',
    url: `${options.baseUrl}/api/settings/mcp`,
    timeoutMs: options.timeoutMs,
    name: 'settings-mcp',
    critical: true
  }))
  probes.push(await checkHttpJson({
    method: 'GET',
    url: `${options.baseUrl}/api/chat/threads?limit=1`,
    timeoutMs: options.timeoutMs,
    name: 'chat-threads',
    critical: false
  }))

  const localChecks = collectLocalChecks(
    options.agentHome,
    options.runtimeRoot,
    options.threadsRoot,
    options.workflowLocalDataDir
  )
  const attemptedActions = options.applySafeFixes
    ? applySafeFixes(localChecks)
    : []

  if (options.applySafeFixes) {
    for (const check of localChecks) {
      if (
        (check.name === 'runtime-root' || check.name === 'workflow-data' || check.name === 'threads')
        && existsSync(check.path)
      ) {
        check.exists = true
      }
    }
  }

  const agentProbe = options.probeAgent
    ? await runAgentProbe({
        baseUrl: options.baseUrl,
        timeoutMs: options.timeoutMs
      })
    : null

  const summary = classify({
    probes,
    localChecks,
    agentProbe
  })

  const report = {
    timestamp: nowIso(),
    target: {
      baseUrl: options.baseUrl,
      runtimeRoot: options.runtimeRoot
    },
    summary,
    checks: {
      http: probes,
      local: localChecks,
      agentProbe
    },
    attemptedActions
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  printTextReport(report)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
