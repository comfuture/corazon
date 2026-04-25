#!/usr/bin/env node

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      continue
    }

    const key = token.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      args[key] = 'true'
      continue
    }

    args[key] = next
    i += 1
  }
  return args
}

function parsePositiveInteger(rawValue, field) {
  const value = Number(rawValue)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer, received: ${rawValue ?? '<undefined>'}`)
  }
  return value
}

function parseBoolean(rawValue) {
  if (!rawValue) {
    return false
  }
  return TRUE_VALUES.has(String(rawValue).trim().toLowerCase())
}

function choosePressureTarget({ rootAvailKb, dockerAvailKb, dockerRootDir }) {
  if (dockerAvailKb < rootAvailKb) {
    return {
      pressureTarget: dockerRootDir,
      pressureAvailableKb: dockerAvailKb
    }
  }

  return {
    pressureTarget: '/',
    pressureAvailableKb: rootAvailKb
  }
}

function decide(params) {
  const { pressureTarget, pressureAvailableKb } = choosePressureTarget(params)
  const belowThreshold = pressureAvailableKb < params.minRequiredKb
  const shouldRemediate = belowThreshold && params.remediationEnabled && !params.remediationAttempted
  const shouldFail = belowThreshold && (!params.remediationEnabled || params.remediationAttempted)

  return {
    pressureTarget,
    pressureAvailableKb,
    shouldRemediate,
    shouldFail
  }
}

function toEnvLine(key, value) {
  return `${key}=${String(value)}`
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  const params = {
    rootAvailKb: parsePositiveInteger(args['root-avail-kb'], 'root-avail-kb'),
    dockerAvailKb: parsePositiveInteger(args['docker-avail-kb'], 'docker-avail-kb'),
    dockerRootDir: args['docker-root-dir'] || '/var/lib/docker',
    minRequiredKb: parsePositiveInteger(args['min-required-kb'] ?? '3145728', 'min-required-kb'),
    remediationEnabled: parseBoolean(args['remediation-enabled']),
    remediationAttempted: parseBoolean(args['remediation-attempted']),
    format: (args.format || 'json').toLowerCase()
  }

  const decision = decide(params)

  if (params.format === 'env') {
    process.stdout.write(`${toEnvLine('PRESSURE_TARGET', decision.pressureTarget)}\n`)
    process.stdout.write(`${toEnvLine('PRESSURE_AVAILABLE_KB', decision.pressureAvailableKb)}\n`)
    process.stdout.write(`${toEnvLine('SHOULD_REMEDIATE', decision.shouldRemediate)}\n`)
    process.stdout.write(`${toEnvLine('SHOULD_FAIL', decision.shouldFail)}\n`)
    return
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        input: {
          rootAvailKb: params.rootAvailKb,
          dockerAvailKb: params.dockerAvailKb,
          dockerRootDir: params.dockerRootDir,
          minRequiredKb: params.minRequiredKb,
          remediationEnabled: params.remediationEnabled,
          remediationAttempted: params.remediationAttempted
        },
        decision
      },
      null,
      2
    )}\n`
  )
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[deploy-disk-pressure-decision] ${message}`)
  process.exitCode = 1
}
