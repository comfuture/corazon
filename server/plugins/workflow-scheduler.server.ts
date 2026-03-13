export default defineNitroPlugin(() => {
  if (import.meta.prerender) {
    return
  }

  initializeWorkflowRunner()
  ensureWorkflowSchedulerInitialized()
})
