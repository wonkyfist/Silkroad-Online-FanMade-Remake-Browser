import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // Corpus tests walk thousands of real client files.
    testTimeout: 180_000,
  },
})
