export default defineNitroPlugin(() => {
  if (import.meta.prerender) {
    return
  }

  initializeMemorySyncWorkflow()
})
