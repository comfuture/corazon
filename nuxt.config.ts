// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: [
    'workflow/nuxt',
    '@nuxt/eslint',
    '@nuxt/ui'
  ],

  devtools: {
    enabled: true
  },

  css: [
    '~/assets/css/main.css',
    'katex/dist/katex.min.css'
  ],

  routeRules: {
    '/': { prerender: true }
  },

  compatibilityDate: '2025-01-15',

  nitro: {
    typescript: {
      tsConfig: {
        compilerOptions: {
          allowImportingTsExtensions: true
        }
      }
    }
  },

  vite: {
    optimizeDeps: {
      include: [
        'monaco-editor/esm/vs/editor/editor.worker',
        'monaco-editor/esm/vs/language/json/json.worker',
        'monaco-editor/esm/vs/language/css/css.worker',
        'monaco-editor/esm/vs/language/html/html.worker',
        'monaco-editor/esm/vs/language/typescript/ts.worker'
      ]
    }
  },

  typescript: {
    tsConfig: {
      compilerOptions: {
        allowImportingTsExtensions: true
      }
    }
  },

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  }
})
