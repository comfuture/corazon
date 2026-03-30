#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs'

const parseArgs = (argv) => {
  const options = {
    reportFile: '',
    previousStatus: ''
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--report-file') {
      options.reportFile = argv[index + 1] ?? ''
      index += 1
      continue
    }
    if (arg.startsWith('--report-file=')) {
      options.reportFile = arg.split('=', 2)[1] ?? ''
      continue
    }
    if (arg === '--previous-status') {
      options.previousStatus = argv[index + 1] ?? ''
      index += 1
      continue
    }
    if (arg.startsWith('--previous-status=')) {
      options.previousStatus = arg.split('=', 2)[1] ?? ''
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  if (!options.reportFile) {
    throw new Error('`--report-file` is required.')
  }

  return options
}

const setOutput = (key, value) => {
  if (!process.env.GITHUB_OUTPUT) {
    return
  }
  const text = `${key}=${value}\n`
  appendFileSync(process.env.GITHUB_OUTPUT, text)
}

const main = () => {
  const options = parseArgs(process.argv.slice(2))
  const report = JSON.parse(readFileSync(options.reportFile, 'utf8'))
  const status = String(report?.summary?.status ?? 'unknown')
  const previousStatus = options.previousStatus.trim()

  let gate = 'pass'
  let followUpRequired = 'false'
  let reason = 'post-deploy recovery checks are healthy'

  if (status === 'down') {
    gate = 'fail'
    followUpRequired = 'true'
    reason = 'recovery status is down'
    console.log('::error title=Post-deploy recovery failed::status=down. Check deployment logs and rollback path immediately.')
  } else if (status === 'degraded' && previousStatus === 'degraded') {
    gate = 'warn'
    followUpRequired = 'true'
    reason = 'recovery status degraded in consecutive runs'
    console.log('::warning title=Post-deploy recovery repeated degraded::Consecutive degraded status detected. Operator follow-up is required.')
  } else if (status === 'degraded') {
    gate = 'warn'
    reason = 'recovery status degraded'
    console.log('::warning title=Post-deploy recovery degraded::Status is degraded. Monitor and validate before the next rollout.')
  }

  console.log(`Recovery status: ${status}`)
  console.log(`Previous status: ${previousStatus || 'none'}`)
  console.log(`Gate: ${gate}`)
  console.log(`Reason: ${reason}`)

  setOutput('status', status)
  setOutput('gate', gate)
  setOutput('follow_up_required', followUpRequired)
  setOutput('reason', reason)
}

main()
