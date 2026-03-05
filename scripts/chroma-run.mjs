#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { config as loadDotEnv } from 'dotenv'

const DEFAULT_CHROMA_URL = 'http://127.0.0.1:8000'
const DEFAULT_CHROMA_PATH = '.data/chroma'

const loadLocalEnv = () => {
  const envPath = resolve(process.cwd(), '.env')
  if (!existsSync(envPath)) {
    return
  }

  const result = loadDotEnv({
    path: envPath,
    override: false
  })

  if (result.error) {
    console.error(`[chroma:run] failed to load .env: ${result.error.message}`)
  }
}

const resolveChromaUrl = () =>
  process.env.CORAZON_MEMORY_CHROMA_URL?.trim()
  || process.env.CHROMA_URL?.trim()
  || DEFAULT_CHROMA_URL

const resolveStoragePath = () =>
  process.env.CORAZON_MEMORY_CHROMA_PATH?.trim()
  || DEFAULT_CHROMA_PATH

const parseTarget = (rawUrl) => {
  let target
  try {
    target = new URL(rawUrl)
  } catch {
    throw new Error(`Invalid CORAZON_MEMORY_CHROMA_URL: ${rawUrl}`)
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`Unsupported protocol in CORAZON_MEMORY_CHROMA_URL: ${target.protocol}`)
  }

  const defaultPort = target.protocol === 'https:'
    ? 443
    : 80
  const port = Number(target.port || defaultPort)
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port in CORAZON_MEMORY_CHROMA_URL: ${target.port || '(empty)'}`)
  }

  return {
    host: target.hostname,
    port: String(Math.floor(port))
  }
}

const run = async () => {
  loadLocalEnv()

  const chromaUrl = resolveChromaUrl()
  const storagePath = resolve(process.cwd(), resolveStoragePath())
  mkdirSync(storagePath, { recursive: true })

  const { host, port } = parseTarget(chromaUrl)

  const args = [
    'exec',
    'chroma',
    'run',
    '--host',
    host,
    '--port',
    port,
    '--path',
    storagePath
  ]

  process.stdout.write(
    `[chroma:run] starting local chroma on ${host}:${port} with path ${storagePath}\n`
  )

  const child = spawn('pnpm', args, {
    stdio: 'inherit',
    env: process.env
  })

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    process.exit(code ?? 1)
  })

  child.on('error', (error) => {
    console.error(`[chroma:run] failed to launch chroma: ${error.message}`)
    process.exit(1)
  })
}

run().catch((error) => {
  const message = error instanceof Error
    ? error.message
    : String(error)
  console.error(`[chroma:run] ${message}`)
  process.exit(1)
})
