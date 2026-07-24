import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Explicit imports (describe/it/expect) are used in the tests, so globals
    // stay off. Determinism means no retries or randomized ordering are needed.
    environment: 'node',
  },
})
