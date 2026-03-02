export default defineNitroPlugin(() => {
  initializeWorkflowRunner()
  ensureWorkflowSchedulerInitialized()
})
