import { defineConfig } from 'vitest/config'

// Dedicated test config so the app's Vite plugins (React, Tailwind) are NOT
// loaded during unit tests. The Phase 2 suites exercise the pure modules in
// src/lib/ (week, selection, tickets), which import no Firebase and no JSX —
// a plain Node environment is all they need.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.js'],
  },
})
