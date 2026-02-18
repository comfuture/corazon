export default defineNitroPlugin(() => {
  ensureAgentBootstrap()
  if (!process.env.WORKFLOW_LOCAL_DATA_DIR?.trim()) {
    process.env.WORKFLOW_LOCAL_DATA_DIR = resolveWorkflowLocalDataDir()
  }
  initializeDatabase()
})
