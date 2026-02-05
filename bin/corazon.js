#!/usr/bin/env node
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const [, , command, ...rest] = process.argv

const usage = () => {
  console.log(`corazon

Usage:
  corazon setup [options]
  corazon --help
`)
}

if (!command || command === '--help' || command === '-h') {
  usage()
  process.exit(0)
}

if (command !== 'setup') {
  console.error(`Unknown command: ${command}`)
  usage()
  process.exit(1)
}

const here = dirname(fileURLToPath(import.meta.url))
const setupPath = resolve(here, '../scripts/corazon-setup.mjs')
const { run } = await import(setupPath)
run(rest)
