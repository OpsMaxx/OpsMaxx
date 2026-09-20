import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

/**
 * The live flow probe, which is NOT part of the suite.
 *
 * It needs a relay on 8490, an operator cookie jar and a built addyd, so it
 * cannot run in CI — and a probe that turns `main` red when none of those are
 * present is a probe people delete. The files are `*.probe.ts` so the root
 * config's `tests/**\/*.test.ts` glob cannot pick them up by accident; this
 * config is the only thing that runs them. See README.md here for the setup.
 */
const ROOT = resolve(__dirname, '../..')

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/probe/**/*.probe.ts'],
    root: ROOT,
    testTimeout: 300_000
  },
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { electron: resolve(ROOT, 'tests/mocks/electron.ts') } }
})
