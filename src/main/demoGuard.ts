import { resolve } from 'node:path'

/**
 * Where the synthetic-data demo profile lives, or null when this launch is not
 * a demo launch.
 *
 * The demo mode fills the app with invented servers, workspaces, a vault and
 * audit rows so the site's screenshots can be taken without a real fleet. It
 * is for a development checkout and nothing else, and it has two guards:
 *
 *   * runtime, here: a packaged app never answers anything but null, whatever
 *     the environment says;
 *   * build time, in index.ts: the demo module is loaded behind
 *     `import.meta.env.DEV`, so a production build does not contain it at all.
 *
 * AND IT MUST NEVER BE THE REAL PROFILE. A dev run's userData is the same
 * folder an installed release uses -- productName is OpsMaxx either way -- and
 * seeding writes the data file, the policy, the vault and the audit chain. A
 * demo dir that resolves to the default userData would overwrite somebody's
 * servers and vault with fixtures, so that is refused rather than honoured.
 */
export function demoProfileDir(
  env: Record<string, string | undefined>,
  packaged: boolean,
  defaultUserData: string
): string | null {
  if (packaged) return null
  const dir = env.OPSMAXX_DEMO_PROFILE?.trim()
  if (!dir) return null
  const wanted = resolve(dir)
  if (wanted === resolve(defaultUserData)) {
    throw new Error(
      `OPSMAXX_DEMO_PROFILE is the real profile (${wanted}). The demo seeds fixtures over it, so it has to be a separate directory.`
    )
  }
  return wanted
}
