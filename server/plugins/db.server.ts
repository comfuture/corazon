export default defineNitroPlugin(() => {
  ensureAgentBootstrap()
  initializeDatabase()
})
