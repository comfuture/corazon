#!/usr/bin/env node

import { spawnSync } from 'node:child_process'

const SCRIPT_PATH = 'scripts/deploy-disk-pressure-decision.mjs'
const MIN_REQUIRED_KB = 3 * 1024 * 1024

const scenarios = [
  {
    name: 'root pressure triggers remediation when enabled',
    args: {
      root: 1_000_000,
      docker: 8_000_000,
      dockerRootDir: '/var/lib/docker',
      remediationEnabled: true,
      remediationAttempted: false
    },
    expect: {
      pressureTarget: '/',
      shouldRemediate: true,
      shouldFail: false
    }
  },
  {
    name: 'docker pressure triggers remediation when docker mount is tighter',
    args: {
      root: 9_000_000,
      docker: 512_000,
      dockerRootDir: '/mnt/docker-data',
      remediationEnabled: true,
      remediationAttempted: false
    },
    expect: {
      pressureTarget: '/mnt/docker-data',
      shouldRemediate: true,
      shouldFail: false
    }
  },
  {
    name: 'below threshold without remediation flag fails fast',
    args: {
      root: 2_000_000,
      docker: 2_200_000,
      dockerRootDir: '/var/lib/docker',
      remediationEnabled: false,
      remediationAttempted: false
    },
    expect: {
      pressureTarget: '/',
      shouldRemediate: false,
      shouldFail: true
    }
  },
  {
    name: 'after remediation with recovered space passes',
    args: {
      root: 3_300_000,
      docker: 3_600_000,
      dockerRootDir: '/var/lib/docker',
      remediationEnabled: true,
      remediationAttempted: true
    },
    expect: {
      pressureTarget: '/',
      shouldRemediate: false,
      shouldFail: false
    }
  },
  {
    name: 'after remediation still below threshold fails',
    args: {
      root: 2_200_000,
      docker: 2_100_000,
      dockerRootDir: '/var/lib/docker',
      remediationEnabled: true,
      remediationAttempted: true
    },
    expect: {
      pressureTarget: '/var/lib/docker',
      shouldRemediate: false,
      shouldFail: true
    }
  },
  {
    name: 'equal values choose root filesystem deterministically',
    args: {
      root: 4_000_000,
      docker: 4_000_000,
      dockerRootDir: '/var/lib/docker',
      remediationEnabled: true,
      remediationAttempted: false
    },
    expect: {
      pressureTarget: '/',
      shouldRemediate: false,
      shouldFail: false
    }
  }
]

function runDecisionScenario(scenario) {
  const result = spawnSync(
    process.execPath,
    [
      SCRIPT_PATH,
      '--root-avail-kb',
      String(scenario.args.root),
      '--docker-avail-kb',
      String(scenario.args.docker),
      '--docker-root-dir',
      scenario.args.dockerRootDir,
      '--min-required-kb',
      String(MIN_REQUIRED_KB),
      '--remediation-enabled',
      String(scenario.args.remediationEnabled),
      '--remediation-attempted',
      String(scenario.args.remediationAttempted)
    ],
    { encoding: 'utf8' }
  )

  if (result.status !== 0) {
    throw new Error(
      `[${scenario.name}] command failed (exit=${String(result.status)}): ${result.stderr || result.stdout}`
    )
  }

  const payload = JSON.parse(result.stdout)
  const actual = payload.decision
  for (const [key, expectedValue] of Object.entries(scenario.expect)) {
    if (actual[key] !== expectedValue) {
      throw new Error(
        `[${scenario.name}] expected ${key}=${String(expectedValue)} but got ${String(actual[key])}`
      )
    }
  }
}

for (const scenario of scenarios) {
  runDecisionScenario(scenario)
}

console.log(`Verified deploy disk-pressure decision matrix (${scenarios.length} scenarios).`)
