import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ngrokDriver } from '../src/main/services/vpn/drivers/ngrok'
import { isEngineBundledOn } from '../src/shared/vpnEngines'
import { isReverseProxyKind } from '../src/shared/vpn'
import type { NgrokSpec } from '../src/shared/vpn'

/**
 * ngrok, which publishes a local port to the public internet.
 *
 * The stakes are higher than frp's and the tests follow that. An frp proxy is
 * reachable from one server the user runs; an ngrok endpoint is reachable from
 * everywhere the moment it comes up, by anyone with the URL. So the exposure
 * gate is asserted twice — in validation and at start — and the authtoken's
 * channel is asserted as a property of the source, because the failure mode is
 * a credential ending up somewhere `ps` can read it.
 */

const SOURCE = readFileSync(resolve(__dirname, '../src/main/services/vpn/drivers/ngrok.ts'), 'utf8')
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const TUNNEL = {
  name: 'web',
  proto: 'http' as const,
  localPort: 3000,
  acknowledgedExposure: true
}

const SPEC: NgrokSpec = {
  kind: 'ngrok',
  authtokenRef: { vaultEntryId: 'v1', fieldKey: 'token' } as never,
  tunnels: [TUNNEL]
}

describe('validateConfig', () => {
  it('accepts a complete profile', () => {
    expect(ngrokDriver.validateConfig(SPEC).ok).toBe(true)
  })

  it('needs an authtoken', () => {
    const v = ngrokDriver.validateConfig({ ...SPEC, authtokenRef: undefined })
    expect(v.ok).toBe(false)
    expect(v.issues.some((i) => i.code === 'authtoken-missing')).toBe(true)
  })

  it('needs at least one port to publish', () => {
    const v = ngrokDriver.validateConfig({ ...SPEC, tunnels: [] })
    expect(v.ok).toBe(false)
    expect(v.issues.some((i) => i.code === 'no-tunnels')).toBe(true)
  })

  /**
   * The gate. Not a preference, and the reason it is a hard error rather than a
   * warning: the user is about to make a port on their machine reachable from
   * the whole internet, and the app should not do that because a form was
   * submitted quickly.
   */
  it('refuses a tunnel whose exposure has not been acknowledged', () => {
    const v = ngrokDriver.validateConfig({
      ...SPEC,
      tunnels: [{ ...TUNNEL, acknowledgedExposure: false }]
    })
    expect(v.ok).toBe(false)
    const issue = v.issues.find((i) => i.code === 'exposure-unacknowledged')
    // And it says which port, because "confirm the exposure" alone is not
    // something a person can check.
    expect(issue?.message).toContain('3000')
  })

  it('rejects a name that is not usable as a config key', () => {
    for (const name of ['', 'has space', 'semi;colon', '-leading']) {
      const v = ngrokDriver.validateConfig({ ...SPEC, tunnels: [{ ...TUNNEL, name }] })
      expect(v.issues.some((i) => i.code === 'name-invalid'), name).toBe(true)
    }
  })

  it('rejects two tunnels with the same name', () => {
    const v = ngrokDriver.validateConfig({ ...SPEC, tunnels: [TUNNEL, { ...TUNNEL, localPort: 4000 }] })
    expect(v.issues.some((i) => i.code === 'name-duplicate')).toBe(true)
  })

  it('rejects an impossible port', () => {
    for (const localPort of [0, -1, 70000, 1.5]) {
      const v = ngrokDriver.validateConfig({ ...SPEC, tunnels: [{ ...TUNNEL, localPort }] })
      expect(v.issues.some((i) => i.code === 'port-invalid'), String(localPort)).toBe(true)
    }
  })

  /**
   * Warnings, not errors: this app does not know which ngrok plan the user has,
   * and refusing a second tunnel because the free tier allows one would be
   * refusing something that works on a paid account.
   */
  it('warns about the account limits it cannot check, without blocking', () => {
    const v = ngrokDriver.validateConfig({
      ...SPEC,
      tunnels: [TUNNEL, { ...TUNNEL, name: 'api', localPort: 4000 }]
    })
    expect(v.ok).toBe(true)
    expect(v.issues.some((i) => i.code === 'multiple-tunnels' && i.severity === 'warning')).toBe(true)
  })

  // Worth saying up front: without a reserved domain the URL changes on every
  // restart, so anything pointing at the old one silently stops working.
  it('warns that an unreserved URL is ephemeral', () => {
    const v = ngrokDriver.validateConfig(SPEC)
    expect(v.issues.some((i) => i.code === 'ephemeral-url' && i.severity === 'warning')).toBe(true)
    expect(ngrokDriver.validateConfig({ ...SPEC, tunnels: [{ ...TUNNEL, domain: 'x.ngrok.app' }] }).issues.some((i) => i.code === 'ephemeral-url')).toBe(false)
  })

  it('refuses an unconfirmed program path', () => {
    const v = ngrokDriver.validateConfig({ ...SPEC, binaryPath: '/tmp/ngrok' })
    expect(v.issues.some((i) => i.code === 'unconfirmed-path')).toBe(true)
  })
})

describe('the authtoken channel', () => {
  /**
   * argv is world-readable through `ps`, which SupervisedSpec says in as many
   * words. A token in `args` would be readable by every process on the machine.
   */
  it('passes the token in the environment and never in argv', () => {
    expect(CODE).toContain('NGROK_AUTHTOKEN: token')
    // The args array is a literal in this file; assert the token is not in it.
    const args = /args: \[([^\]]*)\]/.exec(CODE)?.[1] ?? ''
    expect(args).not.toContain('token')
    expect(args).not.toContain('authtoken')
  })

  // The generated config sits in the run directory, so it must not be a
  // credential — which is what lets it be written at all.
  it('keeps the token out of the generated config file', () => {
    const configFn = /function configYaml[\s\S]*?\n}/.exec(CODE)?.[0] ?? ''
    expect(configFn).toBeTruthy()
    expect(configFn).not.toContain('token')
    expect(configFn).not.toContain('authtoken')
  })

  // So it can never reach the log ring the UI renders.
  it('redacts the token from captured output', () => {
    expect(CODE).toMatch(/redact: \[[^\]]*token/)
  })
})

describe('start refuses before it publishes', () => {
  /**
   * Validation runs while the user types; start() reads the saved profile. A
   * gate that lived only in validation could be satisfied by a form and then
   * bypassed by a profile that was saved before the field existed.
   */
  it('checks the exposure gate again at start', async () => {
    const r = await ngrokDriver.start(
      {
        id: 'p1',
        workspaceId: 'w1',
        name: 'test',
        autoStart: false,
        spec: { ...SPEC, tunnels: [{ ...TUNNEL, acknowledgedExposure: false }] }
      },
      // Never reached: the refusal happens before anything is resolved or run.
      {} as never
    )
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('exposure-unacknowledged')
    expect(r.error).toContain('web')
  })
})

describe('bundling and classification', () => {
  /**
   * The agent is closed-source and not redistributable, so it cannot be
   * bundled — and must not be auto-downloaded either, because a binary fetched
   * at runtime bypasses the malware scanning every shipped artifact goes
   * through. An ABSENT entry would make the app claim it ships it.
   */
  it('is never claimed as bundled', () => {
    for (const p of ['darwin', 'linux', 'win32'] as NodeJS.Platform[]) {
      expect(isEngineBundledOn('ngrok', p), p).toBe(false)
    }
  })

  it('does not download the agent', () => {
    expect(CODE).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/)
  })

  // Publishing outward, so it belongs with frp rather than in the VPN tab —
  // and one predicate decides that for the tab counts and both panels.
  it('is classified as a reverse proxy', () => {
    expect(isReverseProxyKind('ngrok')).toBe(true)
    expect(isReverseProxyKind('frp')).toBe(true)
    expect(isReverseProxyKind('tailscale')).toBe(false)
    expect(isReverseProxyKind('wireguard')).toBe(false)
  })
})

/**
 * YAML injection through the generated config.
 *
 * The config is line-oriented, so a newline in any interpolated value writes
 * new configuration. Two of these were real: a `domain` carrying a newline
 * appended a whole second tunnel that `spec.tunnels` never held — and therefore
 * one with no `acknowledgedExposure` behind it — and a `region` could inject a
 * top-level `authtoken:` or redirect `log:` to a file.
 *
 * The check has to live in the GENERATOR, not only in `validateConfig`, because
 * validateConfig is not on the start path: `start()` reads a stored profile,
 * which can arrive from a restored backup or a hand-edited file without
 * validation ever having run. These assertions go through `start()` for exactly
 * that reason.
 */
describe('config generation refuses what it cannot render safely', () => {
  const hostile = async (spec: Partial<NgrokSpec> & { tunnels: NgrokSpec['tunnels'] }) =>
    ngrokDriver.start(
      { id: 'p', workspaceId: 'w', name: 'n', autoStart: false, spec: { ...SPEC, ...spec } },
      {
        runDir: '/tmp',
        secrets: { all: [], token: 't' },
        emit: () => {},
        log: () => {},
        dropped: () => {},
        askUser: async () => null,
        supervisor: {} as never
      } as never
    )

  it('refuses a domain that would inject another tunnel', async () => {
    const r = await hostile({
      tunnels: [{ ...TUNNEL, domain: 'ok.example\n  evil:\n    proto: tcp\n    addr: 22' }]
    })
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('config-invalid')
  })

  it('refuses a region that would inject a top-level key', async () => {
    const r = await hostile({ tunnels: [TUNNEL], region: 'us\nauthtoken: stolen' })
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('config-invalid')
  })

  it('refuses a name that would inject a key', async () => {
    const r = await hostile({ tunnels: [{ ...TUNNEL, name: 'a:\n  b' }] })
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('config-invalid')
  })

  // The exposure gate still runs first, so an unacknowledged tunnel is refused
  // for that reason rather than reaching the generator at all.
  it('still refuses an unacknowledged tunnel before any of this', async () => {
    const r = await hostile({ tunnels: [{ ...TUNNEL, acknowledgedExposure: false }] })
    expect(r.errorCode).toBe('exposure-unacknowledged')
  })
})
