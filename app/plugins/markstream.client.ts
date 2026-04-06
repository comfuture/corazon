import { enableKatex } from 'markstream-vue'
import { getOrCreateHighlighter, preloadMonacoWorkers } from 'stream-monaco'

export default defineNuxtPlugin(() => {
  enableKatex()

  let preloadPromise: Promise<void> | null = null

  const preloadStreamMonaco = () => {
    if (preloadPromise) {
      return preloadPromise
    }

    preloadPromise = Promise.resolve()
      .then(async () => {
        if (!import.meta.dev) {
          await preloadMonacoWorkers?.()
        }
        await getOrCreateHighlighter?.(
          ['vitesse-dark', 'vitesse-light'],
          ['plaintext', 'text', 'javascript', 'typescript', 'tsx', 'jsx', 'json', 'bash', 'shell', 'html', 'css', 'vue']
        )
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
})
