type StartupAlertRuntimeInput = {
  argv: string[]
  env: NodeJS.ProcessEnv
  dev: boolean
  prerender: boolean
}

const normalizeArg = (value: string) => value.replace(/\\/g, '/').toLowerCase()

const NUXI_COMMANDS = new Set([
  'build',
  'dev',
  'preview',
  'prepare',
  'typecheck'
])

export const shouldSendStartupAlertForRuntime = (
  input: StartupAlertRuntimeInput
) => {
  if (input.prerender || input.dev) {
    return false
  }

  const normalizedArgs = input.argv
    .map(arg => arg.trim())
    .filter(Boolean)
    .map(normalizeArg)

  if (normalizedArgs.some(arg => arg.includes('/nuxi') || arg.endsWith('/nuxi.mjs'))) {
    return false
  }

  if (normalizedArgs.some(arg => NUXI_COMMANDS.has(arg))) {
    return false
  }

  const lifecycleEvent = input.env.npm_lifecycle_event?.trim().toLowerCase()
  if (lifecycleEvent && NUXI_COMMANDS.has(lifecycleEvent)) {
    return false
  }

  return input.env.NODE_ENV === 'production'
}
