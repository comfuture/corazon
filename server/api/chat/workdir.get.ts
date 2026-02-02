export default defineEventHandler(() => {
  const root = ensureThreadRootDirectory()
  return { root }
})
