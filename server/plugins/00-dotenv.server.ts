import { resolve } from 'node:path'
import { config as loadDotEnv } from 'dotenv'

const loadResult = loadDotEnv({
  path: resolve(process.cwd(), '.env'),
  quiet: true,
  override: false
})

if (loadResult.error) {
  const code = (loadResult.error as NodeJS.ErrnoException).code
  if (code !== 'ENOENT') {
    console.error(`[dotenv] failed to load .env: ${loadResult.error.message}`)
  }
}

if (typeof process.env.MEM0_TELEMETRY === 'undefined') {
  process.env.MEM0_TELEMETRY = 'false'
}

export default defineNitroPlugin(() => {})
