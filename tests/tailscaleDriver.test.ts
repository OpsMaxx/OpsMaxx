import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { tailscaleDriver } from '../src/main/services/vpn/drivers/tailscale'
import { isEngineBundledOn } from '../src/shared/vpnEngines'
import { VPN_ERROR_HINT, VPN_ERROR_MESSAGE } from '../src/main/services/vpn/errors'

/**
 * Tailscale, which this app attaches to rather than runs.
 *
 * Two things here are worth pinning against regression, and neither is
 * observable from a unit test of behaviour — they are properties of the source
 * and of the contract, so they are asserted as such.
 *
 * The first is the macOS GUI trap. The App Store build is a single executable
 * that decides between opening its window and behaving as a CLI by sniffing
 * SHLVL/TERM/TERM_PROGRAM/PS1, none of which an Electron app inherits. So
 * spawning it without `TAILSCALE_BE_CLI=1` opens a window instead of returning
 * JSON — and it does that ONLY in a packaged app, because `electron-vite dev`
 * started from a terminal inherits those variables and works. No runtime test
 * can catch that: the machine running CI has no Tailscale, and the dev machine
 * is the one where the bug is invisible.
 *
 * The second is that it must never stop the daemon. `tailscaled` is machine-wide
 * and other software depends on it.
 */

const SOURCE = readFileSync(
  resolve(__dirname, '../src/main/services/vpn/drivers/tailscale.ts'),
  'utf8'
)

/**
 * The source with comments removed.
 *
 * Needed because this file's own prose says things like "a detach, not
 * `tailscale down`" — so an assertion that greps the raw text for a forbidden
 * command matches the sentence promising not to run it. Asserting on CODE means
 * the comments can keep explaining themselves.
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

describe('the macOS GUI-launch trap', () => {
  it('forces CLI mode on every invocation', () => {
    expect(SOURCE).toContain('TAILSCALE_BE_CLI')
  })

  /**
   * The version probe spawns the binary too, during resolution — so the window
   * would open inside probe(), before the driver ran anything at all. Passing
   * the env only to the driver's own calls would leave that hole open.
   */
  it('forces it for the version probe as well, not just the driver calls', () => {
    expect(SOURCE).toContain('probeEnv: CLI_ENV')
  })

  // The App Store client keeps its CLI inside the app bundle, which the
  // standard binary allowlist excludes — so without this the variant half the
  // macOS install base has is simply unreachable.
  it('allows the app bundle path, scoped to darwin', () => {
    expect(SOURCE).toContain("'/Applications'")
    expect(SOURCE).toMatch(/platform === 'darwin'/)
  })

  /**
   * A `/usr/local/bin/tailscale` that is a symlink into the App Store bundle
   * hangs with no output (tailscale#3805). Resolution follows realpath, so the
   * link resolves to the bundle and is invoked directly — but a hang is still a
   * plausible outcome, which is why every call is bounded.
   */
  it('bounds every invocation with a timeout', () => {
    expect(SOURCE).toMatch(/timeout/)
  })
})

describe('attach, not supervise', () => {
  // The daemon was running before this profile started, and other things on
  // the machine are using it.
  it('never brings the tailnet down', () => {
    // The only subcommand this driver may run is a read.
    expect(CODE).not.toContain("'down'")
    expect(CODE).not.toContain("'up'")
    expect(CODE).not.toContain("'logout'")
    expect(CODE).toContain("'status'")
  })

  // Nothing of ours was spawned, so there are no orphans of ours to sweep.
  it('claims no supervisor and no reaping', () => {
    expect(tailscaleDriver.reap).toBeUndefined()
    expect(CODE).not.toContain('ctx.supervisor')
  })

  // A mesh has no single tunnel, and collapsing per-peer counters into one
  // rx/tx pair would be inventing a number.
  it('reports no stats rather than a fabricated pair', async () => {
    await expect(tailscaleDriver.stats('anything')).resolves.toBeNull()
  })

  it('has no status for a profile it is not watching', () => {
    expect(tailscaleDriver.status('not-running')).toBeNull()
  })

  // Stopping a profile we never started must be a no-op, not a throw.
  it('detaches quietly from a profile it does not hold', async () => {
    await expect(tailscaleDriver.stop('not-running')).resolves.toBeUndefined()
  })
})

describe('validateConfig', () => {
  it('accepts a profile with nothing configured, which is the normal case', () => {
    // There is genuinely nothing to set: the daemon holds its own state.
    expect(tailscaleDriver.validateConfig({ kind: 'tailscale' }).ok).toBe(true)
  })

  // The same rule every binaryPath in this app is behind: a path nobody
  // confirmed is not executed.
  it('refuses an unconfirmed program path', () => {
    const v = tailscaleDriver.validateConfig({ kind: 'tailscale', binaryPath: '/tmp/tailscale' })
    expect(v.ok).toBe(false)
    expect(v.issues[0].code).toBe('unconfirmed-path')
  })

  it('accepts a confirmed one', () => {
    expect(
      tailscaleDriver.validateConfig({
        kind: 'tailscale',
        binaryPath: '/opt/homebrew/bin/tailscale',
        confirmed: true
      }).ok
    ).toBe(true)
  })
})

describe('bundling', () => {
  /**
   * An ABSENT entry in BUNDLED_PLATFORMS means "shipped everywhere", so
   * forgetting this would make the app claim it provides Tailscale — and then
   * offer to reinstall itself when the binary was missing, instead of telling
   * the user to install the client.
   */
  it('is never claimed as bundled, on any platform', () => {
    for (const p of ['darwin', 'linux', 'win32'] as NodeJS.Platform[]) {
      expect(isEngineBundledOn('tailscale', p), p).toBe(false)
    }
  })
})

describe('the engine-stopped error code', () => {
  // Added rather than reusing a code that means something else: an installed
  // daemon that is not running is not a missing binary, a network failure or a
  // rejected credential, and reporting it as any of those sends someone to fix
  // the wrong thing.
  it('has a message and a hint that point at the engine own client', () => {
    expect(VPN_ERROR_MESSAGE['engine-stopped']).toBeTruthy()
    expect(VPN_ERROR_HINT['engine-stopped']).toMatch(/own app|service/i)
  })
})
