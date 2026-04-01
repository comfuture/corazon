export default defineNitroPlugin(() => {
  if (import.meta.prerender) {
    return
  }

  ensureAgentBootstrap()
  ensureCorazonRuntimeEnvironment()
  initializeDatabase()
})
