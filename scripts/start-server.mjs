const NITRO_CHUNK_URL = new URL('../.output/server/chunks/nitro/nitro.mjs', import.meta.url)
const NITRO_ENTRY_URL = new URL('../.output/server/index.mjs', import.meta.url)

const { initializeServerStartupAlert } = await import(NITRO_CHUNK_URL)

const originalConsoleLog = console.log.bind(console)
let startupAlertQueued = false

const queueStartupAlert = () => {
  if (startupAlertQueued) {
    return
  }

  startupAlertQueued = true
  queueMicrotask(() => {
    initializeServerStartupAlert()
  })
}

console.log = (...args) => {
  originalConsoleLog(...args)

  if (startupAlertQueued) {
    return
  }

  const message = args
    .map(arg => typeof arg === 'string' ? arg : String(arg))
    .join(' ')

  if (message.startsWith('Listening on ')) {
    queueStartupAlert()
  }
}

await import(NITRO_ENTRY_URL)
