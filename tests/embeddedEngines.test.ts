import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { tailscaleDriver, stateFor } from '../src/main/services/vpn/drivers/tailscale'
import { ngrokDriver } from '../src/main/services/vpn/drivers/ngrok'
import { isEngineBundledOn } from '../src/shared/vpnEngines'
import { scrubSecrets } from '../src/main/services/vpn/netdSession'
import { isReverseProxyKind } from '../src/shared/vpn'
import type { NgrokSpec } from '../src/shared/vpn'

/**
 * Tailscale and ngrok, embedded rather than shelled out to.
 *
 * Both run inside `opsmaxx-netd`, the Go sidecar this repo already builds,
 * signs and checksums. The invariant worth guarding is that it stays that way:
 * the earlier version of both drivers spawned a client the user had to install,
 * which meant a PATH search, a version nobody chose, an install step first, and
 * on Windows — where PATH is never searched — going to find the file by hand.
 *
 * The licences are what make embedding legitimate, and they are worth writing
 * down because getting this wrong in a public repository is a real error:
 * tailscale.com is BSD-3-Clause, and golang.ngrok.com/ngrok/v2 is MIT. The
 * ngrok AGENT is closed-source and could not be shipped — which is true, and is
 * a different question from whether ngrok can be embedded.
 */

const src = (p: string): string => readFileSync(resolve(__dirname, '..', p), 'utf8')
const strip = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const TS_DRIVER = strip(src('src/main/services/vpn/drivers/tailscale.ts'))
const NGROK_DRIVER = strip(src('src/main/services/vpn/drivers/ngrok.ts'))
const SESSION = strip(src('src/main/services/vpn/netdSession.ts'))

describe('nothing is executed from the host', () => {
  /**
   * The point of the rewrite. A driver that reaches for a binary by name is a
   * driver that depends on something this app cannot ship, verify or version.
   */
  it('neither driver names a host client', () => {
    for (const [name, code] of [
      ['tailscale', TS_DRIVER],
      ['ngrok', NGROK_DRIVER]
    ] as const) {
      expect(code, `${name} still resolves a system binary`).not.toContain('resolveSystem')
      expect(code, `${name} still spawns something itself`).not.toContain('execFile')
      expect(code, `${name} still spawns something itself`).not.toContain('spawn(')
    }
  })

  // Both go through the bundled sidecar, which is the one thing the installer
  // ships and the manifest hashes.
  it('both resolve the bundled sidecar and nothing else', () => {
    expect(TS_DRIVER).toContain("resolveBundled('opsmaxx-netd')")
    expect(NGROK_DRIVER).toContain("resolveBundled('opsmaxx-netd')")
    expect(SESSION).toContain("const NETD = 'opsmaxx-netd'")
  })

  /**
   * The App Store Tailscale bundle sniffs the environment to decide between
   * opening its GUI and behaving as a CLI, and returns exit code 0 while
   * failing to do either. That whole class of problem is gone with the binary
   * it belonged to — so the workaround should be gone as well, rather than
   * lingering as cargo.
   */
  it('carries none of the host-client workarounds', () => {
    for (const code of [TS_DRIVER, NGROK_DRIVER]) {
      expect(code).not.toContain('TAILSCALE_BE_CLI')
      expect(code).not.toContain('/Applications')
      expect(code).not.toContain('extraRoots')
      expect(code).not.toContain('probeEnv')
    }
  })

  it('the binary allowlist no longer knows either engine', () => {
    const binaries = src('src/main/services/vpn/binaries.ts')
    expect(binaries).not.toContain('tailscale')
    expect(binaries).not.toContain('ngrok')
  })
})

describe('bundling and classification', () => {
  /**
   * `isEngineBundledOn` answers whether OpsMaxx SHIPS an engine, and it is what
   * the UI asks before offering to install one. Both are shipped now — inside
   * the sidecar — so neither should ever tell a user to go and install it.
   */
  it('reports both as shipped on every platform', () => {
    for (const p of ['darwin', 'linux', 'win32'] as NodeJS.Platform[]) {
      expect(isEngineBundledOn('tailscale', p), `tailscale on ${p}`).toBe(true)
      expect(isEngineBundledOn('ngrok', p), `ngrok on ${p}`).toBe(true)
    }
  })

  // ngrok publishes outward, so it belongs with frp; Tailscale makes the other
  // side reachable here, so it belongs with the VPNs.
  it('classifies each on the right side of the tabs', () => {
    expect(isReverseProxyKind('ngrok')).toBe(true)
    expect(isReverseProxyKind('tailscale')).toBe(false)
  })
})

describe('tailscale state mapping', () => {
  it('maps a running backend to connected', () => {
    expect(stateFor('Running').state).toBe('connected')
  })

  /**
   * Waiting on a person is not a failure. Reporting it as one makes the UI
   * offer a retry, and the retry re-runs the same wait — while the thing the
   * user actually needs, the authorisation URL, is somewhere else entirely.
   */
  it('treats a node awaiting authorisation as authenticating, not failed', () => {
    expect(stateFor('NeedsLogin').state).toBe('authenticating')
    expect(stateFor('NeedsMachineAuth').state).toBe('authenticating')
  })

  it('has a real state for every documented backend, and for none at all', () => {
    for (const b of ['Running', 'Starting', 'NeedsLogin', 'NeedsMachineAuth', 'Stopped']) {
      expect(stateFor(b).state, b).not.toBe('error')
    }
    expect(stateFor(undefined).state).toBe('error')
    expect(stateFor('SomethingNew').state).toBe('error')
  })

  it('accepts a profile with nothing configured, which is the normal case', () => {
    expect(tailscaleDriver.validateConfig({ kind: 'tailscale' }).ok).toBe(true)
  })

  // It becomes a device name on the user's tailnet, so it has to be one.
  it('refuses a device name a tailnet would not take', () => {
    for (const hostname of ['has space', 'under_score', '-leading', 'a'.repeat(80)]) {
      expect(
        tailscaleDriver.validateConfig({ kind: 'tailscale', hostname }).ok,
        hostname
      ).toBe(false)
    }
    expect(tailscaleDriver.validateConfig({ kind: 'tailscale', hostname: 'my-laptop' }).ok).toBe(true)
  })
})

describe('ngrok validation and the exposure gate', () => {
  const TUNNEL = { name: 'web', proto: 'http' as const, localPort: 3000, acknowledgedExposure: true }
  const SPEC: NgrokSpec = {
    kind: 'ngrok',
    authtokenRef: { vaultEntryId: 'v1', field: 'token' } as never,
    tunnels: [TUNNEL]
  }

  it('accepts a complete profile', () => {
    expect(ngrokDriver.validateConfig(SPEC).ok).toBe(true)
  })

  it('needs an authtoken and at least one endpoint', () => {
    expect(ngrokDriver.validateConfig({ ...SPEC, authtokenRef: undefined }).ok).toBe(false)
    expect(ngrokDriver.validateConfig({ ...SPEC, tunnels: [] }).ok).toBe(false)
  })

  /**
   * The gate, and the reason it is an error rather than a warning: this makes a
   * port on the user's machine reachable from the whole internet, immediately,
   * by anyone with the URL. Stronger than anything else in this app claims.
   */
  it('refuses an endpoint whose exposure was never acknowledged', () => {
    const v = ngrokDriver.validateConfig({
      ...SPEC,
      tunnels: [{ ...TUNNEL, acknowledgedExposure: false }]
    })
    expect(v.ok).toBe(false)
    expect(v.issues.find((i) => i.code === 'exposure-unacknowledged')?.message).toContain('3000')
  })

  /**
   * And again at start, because validation runs while somebody types while
   * start reads a stored profile — which can arrive from a restored backup or
   * a file edited by hand, having never passed validation at all.
   */
  it('refuses again at start, before anything is spawned', async () => {
    const r = await ngrokDriver.start(
      {
        id: 'p1',
        workspaceId: 'w1',
        name: 'test',
        autoStart: false,
        spec: { ...SPEC, tunnels: [{ ...TUNNEL, acknowledgedExposure: false }] }
      },
      // Never reached: the refusal happens before the sidecar is touched.
      {} as never
    )
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('exposure-unacknowledged')
  })

  /**
   * A name or a domain that could carry a newline used to be able to inject
   * configuration, because the driver wrote a YAML file. There is no file now —
   * parameters cross as JSON — but the shapes are still checked on both sides,
   * because the sidecar must never be handed something its own validation has
   * to be the only thing standing between.
   */
  it('refuses a malformed name or domain before spawning anything', async () => {
    for (const tunnels of [
      [{ ...TUNNEL, name: 'a:\n  b' }],
      [{ ...TUNNEL, domain: 'ok.example\nlog: /tmp/x' }]
    ]) {
      const r = await ngrokDriver.start(
        { id: 'p', workspaceId: 'w', name: 'n', autoStart: false, spec: { ...SPEC, tunnels } },
        {} as never
      )
      expect(r.ok).toBe(false)
      expect(r.errorCode).toBe('config-invalid')
    }
  })

  it('warns per endpoint that an unreserved URL changes every run', () => {
    const v = ngrokDriver.validateConfig({
      ...SPEC,
      tunnels: [TUNNEL, { ...TUNNEL, name: 'api', localPort: 4000 }]
    })
    // Both, not just the first — the second is the one somebody adds later
    // without re-reading the first one's caveats.
    expect(v.issues.filter((i) => i.code === 'ephemeral-url')).toHaveLength(2)
  })
})

describe('the authtoken never touches disk or a command line', () => {
  // It crosses as a JSON parameter to the sidecar, from the vault, per call.
  it('is sent as a parameter and written nowhere', () => {
    expect(NGROK_DRIVER).toContain('authtoken')
    expect(NGROK_DRIVER).not.toContain('writeFile')
    expect(NGROK_DRIVER).not.toContain('NGROK_AUTHTOKEN')
    // And the spawn carries no arguments at all, so nothing can ride in argv.
    expect(SESSION).toContain('args: []')
  })

  // The supervisor's log ring is rendered in the UI.
  it('is redacted from captured output', () => {
    expect(SESSION).toMatch(/redact: \[\.\.\.ctx\.secrets\.all\]/)
  })
})

describe('what the sidecar reports actually reaches the screen', () => {
  const CARD = strip(src('src/renderer/src/components/vpn/VpnStatusCard.tsx'))

  /**
   * The gap this closes, and the reason it is worth a test rather than a
   * glance: the driver collected peers into a module-level accessor that no
   * component ever called. Everything typechecked, every test passed, and
   * `showPeers` was a switch the user could turn on to no effect.
   *
   * Both engines now travel the same road — `stats()`, which the card already
   * reads — so the guard is that the card reads both.
   */
  it('renders the device list and the public URLs from stats', () => {
    expect(CARD).toContain('stats?.tailnetPeers')
    expect(CARD).toContain('stats?.endpoints')
  })

  // An accessor nothing calls is indistinguishable from a feature that works.
  it('leaves no accessor that only the driver can see', () => {
    expect(TS_DRIVER).not.toContain('export function tailscalePeers')
  })
})

describe('a credential never rides out on an error message', () => {
  /**
   * Found by running the real sidecar, not by reading it: ngrok answers a bad
   * authtoken with "Your authtoken: <the token>".
   *
   * That message is a RETURN VALUE. It travels send() → VpnError →
   * VpnStartResult.error → the profile card, and is persisted with the status.
   * The supervisor's `redact` option covers the captured log ring and nothing
   * else — so the one path a secret was guaranteed to take was the one path
   * nothing was scrubbing.
   */
  it('takes the token out of the message ngrok sends back', () => {
    const token = '2abcdefghijklmnopqrstuvwxyz_0123456789ABCDEF'
    const real =
      `could not reach ngrok: The authtoken you specified does not look like a proper ngrok authtoken.\n` +
      `Your authtoken: ${token}\n`
    const scrubbed = scrubSecrets(real, [token])
    expect(scrubbed).not.toContain(token)
    // The rest of the sentence survives: the user still has to be told what
    // went wrong, and "[redacted] is not a valid authtoken" is the useful half.
    expect(scrubbed).toContain('does not look like a proper ngrok authtoken')
  })

  it('scrubs every secret it was given, not just the first', () => {
    const out = scrubSecrets('key=AAAAAAAAAAAA and pass=BBBBBBBBBBBB', [
      'AAAAAAAAAAAA',
      'BBBBBBBBBBBB'
    ])
    expect(out).toBe('key=[redacted] and pass=[redacted]')
  })

  /**
   * A short "secret" would redact half the alphabet out of every message —
   * an empty string worst of all, which would match at every position.
   */
  it('ignores values too short to be a credential', () => {
    const msg = 'connection refused on port 80'
    expect(scrubSecrets(msg, ['', '80', 'on'])).toBe(msg)
  })

  it('is applied to the reply path, not only exported', () => {
    expect(SESSION).toContain('scrubSecrets(frame.error?.message')
  })
})
