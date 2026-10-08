import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Les tests d'intégration lancent de vrais serveurs HTTP et de faux binaires
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
