import { defineConfig } from 'vitest/config'

// Separate config so the emulator rules suite (test/**) never runs during the
// normal `npm test` (which is scoped to src/**/*.test.js). Node env; no JSX.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    testTimeout: 15000,
  },
})
