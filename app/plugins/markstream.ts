import { enableKatex } from 'markstream-vue'

export default defineNuxtPlugin(() => {
  enableKatex()

  if (import.meta.client) {
    let preloadPromise: Promise<void> | null = null

    const preloadStreamMonaco = () => {
      if (preloadPromise) {
        return preloadPromise
      }

      preloadPromise = import('stream-monaco')
        .then(async (monaco) => {
          if (!import.meta.dev) {
            await monaco.preloadMonacoWorkers?.()
          }
          if (typeof monaco.getOrCreateHighlighter === 'function') {
            await monaco.getOrCreateHighlighter(
              ['vitesse-dark', 'vitesse-light'],
              ['plaintext', 'text', 'javascript', 'typescript', 'tsx', 'jsx', 'json', 'bash', 'shell', 'html', 'css', 'vue']
            )
          }
        })
        .catch(() => {})

      return preloadPromise
    }

    onNuxtReady(() => {
      const run = () => {
        void preloadStreamMonaco()
      }

      const requestIdleCallback = globalThis.requestIdleCallback?.bind(globalThis)
      if (requestIdleCallback) {
        requestIdleCallback(run, { timeout: 1500 })
        return
      }

      globalThis.setTimeout(run, 0)
    })
  }
})
