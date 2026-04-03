import '#nitro-internal-pollyfills'
import { Server as HttpServer } from 'node:http'
import { Server as HttpsServer } from 'node:https'
import wsAdapter from 'crossws/adapters/node'
import destr from 'destr'
import { toNodeListener } from 'h3'
import { useNitroApp, useRuntimeConfig } from 'nitropack/runtime'
import {
  setupGracefulShutdown,
  startScheduleRunner,
  trapUnhandledNodeErrors
} from 'nitropack/runtime/internal'
import { initializeServerStartupAlert } from '../utils/server-startup-alert.ts'

const cert = process.env.NITRO_SSL_CERT
const key = process.env.NITRO_SSL_KEY
const nitroApp = useNitroApp()
export const localFetch = nitroApp.localFetch
export const closePrerenderer = () => nitroApp.hooks.callHook('close')
const server = cert && key
  ? new HttpsServer({ key, cert }, toNodeListener(nitroApp.h3App))
  : new HttpServer(toNodeListener(nitroApp.h3App))
const port = destr(process.env.NITRO_PORT || process.env.PORT) || 3e3
const host = process.env.NITRO_HOST || process.env.HOST
const path = process.env.NITRO_UNIX_SOCKET

const listener = server.listen(path ? { path } : { port, host }, (err) => {
  if (err) {
    console.error(err)
    process.exit(1)
  }

  const protocol = cert && key ? 'https' : 'http'
  const addressInfo = listener.address()
  if (typeof addressInfo === 'string') {
    console.log(`Listening on unix socket ${addressInfo}`)
    initializeServerStartupAlert()
    return
  }

  const baseURL = (useRuntimeConfig().app.baseURL || '').replace(/\/$/, '')
  const url = `${protocol}://${addressInfo.family === 'IPv6' ? `[${addressInfo.address}]` : addressInfo.address}:${addressInfo.port}${baseURL}`
  console.log(`Listening on ${url}`)
  initializeServerStartupAlert()
})

trapUnhandledNodeErrors()
setupGracefulShutdown(listener, nitroApp)

if (import.meta._websocket) {
  const { handleUpgrade } = wsAdapter(nitroApp.h3App.websocket)
  server.on('upgrade', handleUpgrade)
}

if (import.meta._tasks) {
  startScheduleRunner()
}

export default {}
