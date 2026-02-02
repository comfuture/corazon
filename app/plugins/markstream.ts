import { enableKatex } from 'markstream-vue'

export default defineNuxtPlugin(() => {
  enableKatex()

  if (import.meta.client) {
    void import('stream-monaco')
      .then(async (monaco) => {
        await monaco.preloadMonacoWorkers?.()
        if (typeof monaco.getOrCreateHighlighter === 'function') {
          await monaco.getOrCreateHighlighter(
            ['vitesse-dark', 'vitesse-light'],
            ['plaintext', 'text', 'javascript', 'typescript', 'tsx', 'jsx', 'json', 'bash', 'shell', 'html', 'css', 'vue']
          )
        }
      })
      .catch(() => {})
  }
})
