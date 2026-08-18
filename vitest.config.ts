import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // Measurement tests shell out to real builds — they need room.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
