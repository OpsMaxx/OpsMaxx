import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The built CLI entry that the integration tests spawn as a real MCP server.
 *
 * It is a build artifact, not source: `npm run build` produces it, and CI runs
 * that before `npm run test`. A fresh checkout or a git worktree has no `out/`,
 * so the spawn succeeds, the child exits immediately, and the MCP client
 * reports `Connection closed` — which reads like the config writer is broken
 * when nothing is wrong with it at all.
 *
 * Tests that need it should skip on `hasBuiltCli` rather than fail, and say so.
 */
export const BUILT_CLI = fileURLToPath(new URL('../../out/cli/index.js', import.meta.url))

export const hasBuiltCli = existsSync(BUILT_CLI)

/**
 * Says why, once per file, so a skipped integration test is never silent — a
 * quiet skip is how a suite ends up green while proving nothing.
 */
export function warnIfUnbuilt(): void {
  if (hasBuiltCli) return
  console.warn(
    `[integration] skipping tests that spawn the built CLI: ${BUILT_CLI} does not exist. ` +
      'Run `npm run build` first; CI does this before `npm run test`.'
  )
}
