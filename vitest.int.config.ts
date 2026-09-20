import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Integration suite: needs `npm run test:int` (spins up Postgres + PostgREST locally).
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { environment: 'node', include: ['tests/integration/**/*.itest.ts'], testTimeout: 30_000, fileParallelism: false },
})
