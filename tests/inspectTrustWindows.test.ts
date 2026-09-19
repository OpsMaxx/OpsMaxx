import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Windows certificate trust, which had no test at all.
 *
 * Three things were reported from Windows and they turned out to be three
 * different bugs that all present as the same thing:
 *
 *  1. **"It keeps asking to install the certificate even though it is
 *     installed."** Trust was decided by the EXIT CODE of
 *     `certutil -verifystore`. That command validates the whole chain,
 *     revocation included, and the inspector's authority is self-signed with
 *     no CRL distribution point and no OCSP responder — so offline, behind a
 *     filtering proxy, or under a policy that demands a revocation answer, it
 *     fails for a certificate that is installed and working. On Windows the
 *     store IS the trust setting, so membership is the whole question.
 *
 *  2. **"Sometimes the install fails."** Adding to the Root store raises
 *     Windows' own warning dialog, and the call was bounded by the ten-second
 *     PROBE timeout meant for questions a program answers by itself. A person
 *     reaching for the mouse lost the race. macOS had been given three minutes
 *     for exactly this; Windows had not.
 *
 *  3. **An install that did nothing still reported success.** The shared
 *     post-install verification — whose own comment says "on every platform" —
 *     sat below a `return` that Windows took first.
 *
 * Nothing here runs `certutil`. The seam is child_process.
 */

const hoisted = vi.hoisted(() => ({
  /** Every command, in order, as [cmd, ...args]. */
  calls: [] as string[][],
  /** The timeout each call was given, by index, so the prompt bound is
   *  checkable rather than assumed. */
  timeouts: [] as (number | undefined)[],
  /** Thumbprints the fake Root store holds. */
  store: new Set<string>(),
  /** `-addstore` succeeds but stores nothing: a policy-locked machine. */
  addIsIgnored: false,
  /** `-verifystore` fails however healthy the certificate is: the offline /
   *  revocation-unknown machine that produced the loop. */
  verifyAlwaysFails: true,
  /** The fake HKCU Internet Settings values `reg query` reads. */
  registry: new Map<string, string>()
}))

vi.mock('node:child_process', () => {
  const execFile = (
    cmd: string,
    args: string[],
    opts: { timeout?: number } | undefined,
    cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void
  ): void => {
    hoisted.calls.push([cmd, ...args])
    hoisted.timeouts.push(opts?.timeout)
    const ok = (stdout: string): void => cb(null, { stdout, stderr: '' })
    const fail = (stdout = ''): void =>
      cb(Object.assign(new Error(`${cmd} failed`), { stdout, code: 1 }))

    if (cmd === 'reg') {
      // `reg query <key> /v <name>` prints a header, then an indented line
      // "<name>    REG_DWORD    0x1". Reproduced rather than simplified,
      // because the parsing of that line is what is under test.
      const name = args[args.indexOf('/v') + 1]
      if (args[0] === 'query') {
        const value = hoisted.registry.get(name)
        if (value === undefined) return fail('ERROR: The system was unable to find the specified registry key or value.')
        const type = /^0x/.test(value) ? 'REG_DWORD' : 'REG_SZ'
        return ok(`\n${'HKEY_CURRENT_USER\\...'}\n    ${name}    ${type}    ${value}\n\n`)
      }
      if (args[0] === 'add') {
        hoisted.registry.set(name, args[args.indexOf('/d') + 1] ?? '')
        return ok('The operation completed successfully.')
      }
      if (args[0] === 'delete') {
        hoisted.registry.delete(name)
        return ok('The operation completed successfully.')
      }
      return ok('')
    }
    if (cmd !== 'certutil') return ok('')
    const verb = args[1]
    const thumb = (args[3] ?? '').toUpperCase()

    if (verb === '-addstore') {
      if (!hoisted.addIsIgnored) hoisted.store.add(CURRENT_THUMB)
      return ok('CertUtil: -addstore command completed successfully.\n')
    }
    if (verb === '-delstore') {
      const had = hoisted.store.delete(thumb)
      // certutil exits non-zero when there was nothing to delete, which is not
      // a failure of the outcome being asked for.
      return had ? ok('') : fail('CertUtil: -delstore command FAILED: 0x80092004\n')
    }
    if (verb === '-store') {
      return hoisted.store.has(thumb)
        ? ok(`Cert Hash(sha1): ${thumb}\nCertUtil: -store command completed successfully.\n`)
        : fail('CertUtil: -store command FAILED: 0x80092004\n')
    }
    if (verb === '-verifystore') {
      if (hoisted.verifyAlwaysFails) {
        return fail(
          'CertUtil: The revocation function was unable to check revocation ' +
            'because the revocation server was offline. 0x80092013\n'
        )
      }
      return hoisted.store.has(thumb) ? ok(`Cert Hash(sha1): ${thumb}\n`) : fail('')
    }
    return ok('')
  }
  return { execFile, default: { execFile } }
})

const userData = mkdtempSync(join(tmpdir(), 'opsmaxx-trust-'))
vi.mock('electron', () => ({
  app: { getPath: () => userData },
  dialog: { showMessageBox: async () => ({ response: 0 }) }
}))

vi.mock('../src/main/services/vpn/elevation', () => ({
  elevatorForPlatform: () => ({
    method: 'none',
    carriesStdin: false,
    probe: async () => ({ available: false, method: 'none', reason: 'not used on Windows' }),
    run: async () => ({ pid: 1, wait: async () => ({ code: 0, declined: false }), kill: async () => undefined })
  })
}))

import {
  installSystemTrust,
  invalidateTrustCache,
  notAfterOf,
  removeStaleTrust,
  removeSystemTrust,
  sha1Hex,
  systemProxyPointsAt,
  trustStatus
} from '../src/main/services/inspectTrust'
import type { TrustContext } from '../src/main/services/inspectTrust'

/** Not a real certificate, and it does not need to be: every assertion below
 *  is about store membership, which is keyed on the fingerprint we compute. */
const CERT_PEM = '-----BEGIN CERTIFICATE-----\nTUlJQmt6Q0NBVGtDRkE9PQ==\n-----END CERTIFICATE-----\n'
const CURRENT_THUMB = sha1Hex(CERT_PEM).toUpperCase()

/** A real self-signed certificate that expired in January 2020. Generated for
 *  this test with a throwaway key that was never written down; it carries no
 *  identifiers, per the fixture rule for this repository. */
const EXPIRED_PEM = `-----BEGIN CERTIFICATE-----
MIIDFTCCAf2gAwIBAgIUHtV2lM6pQYfFa/Fn41ICeiPtfcEwDQYJKoZIhvcNAQEL
BQAwGjEYMBYGA1UEAwwPRXhwaXJlZCBUZXN0IENBMB4XDTIwMDEwMTAwMDAwMFoX
DTIwMDEwMjAwMDAwMFowGjEYMBYGA1UEAwwPRXhwaXJlZCBUZXN0IENBMIIBIjAN
BgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAkDok+nq25Iz6XHR5bCFk4Rygoxxi
v/uul6q3cMPYdud4l2F01/If3TMDuJaKxhlKrbSnuBI59XM/T2B45QKiYajNU3tK
Ag3ghDy4rBN5TgzdON3gHIYTUHDuWDY+aaaGlYcySkF/soXCX1NWAguclTFvc8P1
lf4ZyccjQDUVtDTjHmdq7bopnUgcs8IO6wj0PiX1yBVUolpxsrOjzwtLtCKKiAQ0
G2LNJ+4hJQmhlM9Tuf4NR2sA8I9CsnRpn+HRWCZEcqbfyo0TXjLmDtTMpzX5Lx5B
+4EaiRuhkAnN9YKTVnInXRWzW1b5DcYOrEDBjKMgi53qo+snNkPEj0m52QIDAQAB
o1MwUTAdBgNVHQ4EFgQUxaH6rXCuDofaPRABbqUKYN8+E0kwHwYDVR0jBBgwFoAU
xaH6rXCuDofaPRABbqUKYN8+E0kwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0B
AQsFAAOCAQEAStsRowoycJr7YC5WtnhFroHAcZb6L0CGiTuDwR9ir24mVG9f7mbC
aPs0wkSM1qiRkb1cb2AL+TCF7lfz4mn3CCibDNc7Z961MZo03OYGcbGRQJ3RwHV+
gCiMNZJfzWZAjeM5OYHX+PueayV3J1LTzTGMkRXNeFys2/rPzgLArTY7EpatuR9k
AhL6RkfNdpZCJBp8HiWtWNeXXZ1JlG/qMBT0yjcCOVkpZRaQz2k+D7Zk+8zv+lm8
UYdZTwqIJY5kfDruKjw3yGXH26d6n6J+XKK47XNJaYxsmvdJHYt2ZA2gI2je2Yxm
ZHr66U+xoUl9FzWn1/AT75aUC6A9lgIADw==
-----END CERTIFICATE-----
`

const ctx = (pem = CERT_PEM): TrustContext => ({
  platform: 'win32',
  certPath: 'C:\\Users\\x\\AppData\\Roaming\\OpsMaxx\\inspect\\opsmaxx-inspector-ca.crt',
  certPem: pem,
  commonName: 'OpsMaxx Traffic Inspector CA'
})

/** `certutil` is always invoked as `-user <verb> Root …`, so the verb is
 *  matched anywhere in the arguments rather than at a fixed index. */
const certutil = (verb: string): string[][] =>
  hoisted.calls.filter((c) => c[0] === 'certutil' && c.includes(verb))

const systemState = async (c = ctx()): ReturnType<typeof trustStatus> extends Promise<infer T>
  ? Promise<T extends (infer E)[] ? E : never>
  : never => {
  const stores = await trustStatus(c)
  return stores.find((s) => s.id === 'system')!
}

beforeEach(() => {
  hoisted.calls.length = 0
  hoisted.timeouts.length = 0
  hoisted.store.clear()
  hoisted.addIsIgnored = false
  hoisted.verifyAlwaysFails = true
  rmSync(join(userData, 'inspect', 'trust-installs.json'), { force: true })
  invalidateTrustCache()
})

afterAll(() => rmSync(userData, { recursive: true, force: true }))

describe('deciding whether it is installed', () => {
  it('asks the store, not the chain validator', async () => {
    hoisted.store.add(CURRENT_THUMB)
    const system = await systemState()

    expect(system.state).toBe('trusted')
    // The whole bug in one assertion: `-verifystore` fails on this fixture for
    // every call, and the answer is still "trusted", because membership is
    // what trust means on Windows.
    expect(certutil('-store').length).toBeGreaterThan(0)
    expect(certutil('-verifystore')).toHaveLength(0)
  })

  it('does not loop: a certificate that is there is never asked for again', async () => {
    hoisted.store.add(CURRENT_THUMB)
    for (let i = 0; i < 3; i++) {
      invalidateTrustCache()
      expect((await systemState()).state).toBe('trusted')
    }
  })

  it('reports untrusted when the store really does not have it', async () => {
    const system = await systemState()
    expect(system.state).toBe('untrusted')
    expect(system.installable).toBe(true)
  })

  it('reports an expired authority as untrusted, and says to regenerate', async () => {
    // Expiry was the one real thing the chain validator added, and it is
    // decided from the certificate rather than from another process, because
    // we hold the bytes.
    hoisted.store.add(sha1Hex(EXPIRED_PEM).toUpperCase())
    const system = await systemState(ctx(EXPIRED_PEM))

    expect(system.state).toBe('untrusted')
    expect(system.hint).toMatch(/expired/i)
    expect(system.hint).toMatch(/[Rr]egenerate/)
  })

  it('does not call a certificate expired because it could not read it', () => {
    // An unparseable certificate must not be turned into an expiry claim: the
    // store membership stands and the user is left alone.
    expect(notAfterOf(CERT_PEM)).toBeNull()
    expect(notAfterOf(EXPIRED_PEM)?.getUTCFullYear()).toBe(2020)
  })
})

describe('installing', () => {
  it('waits for the Windows warning dialog rather than the probe timeout', async () => {
    await installSystemTrust(ctx())

    const at = hoisted.calls.findIndex((c) => c[0] === 'certutil' && c.includes('-addstore'))
    expect(at).toBeGreaterThan(-1)
    // Three minutes, the same allowance macOS gets for its SecurityAgent
    // prompt. Ten seconds is the bound for a question certutil answers itself,
    // and it was cancelling a dialog the user was still reading.
    expect(hoisted.timeouts[at]).toBe(180_000)
  })

  it('verifies afterwards, and refuses to claim success when nothing was stored', async () => {
    // A machine where policy silently discards the write: certutil exits 0 and
    // the store is unchanged. This used to return ok.
    hoisted.addIsIgnored = true

    const res = await installSystemTrust(ctx())

    expect(res.ok).toBe(false)
    expect(certutil('-store').length).toBeGreaterThan(0)
  })

  it('reports success only once the store actually holds it', async () => {
    const res = await installSystemTrust(ctx())
    expect(res.ok).toBe(true)
    expect(hoisted.store.has(CURRENT_THUMB)).toBe(true)
  })

  it('leaves a command to run by hand when the store refuses', async () => {
    // A failure with no way forward is a worse bug than the failure: the same
    // rule the macOS path already follows. Here the store silently keeps
    // nothing, which is what a policy-locked Root store does.
    hoisted.addIsIgnored = true

    const res = await installSystemTrust(ctx())

    expect(res.ok).toBe(false)
    expect(res.message ?? '').not.toBe('')
    // The verification failure explains itself with the store's own hint; the
    // declined-dialog path is the one that prints a command.
    const declined = await (async () => {
      hoisted.addIsIgnored = false
      // Make `-addstore` itself fail, which is what a closed dialog looks
      // like from out here.
      const realAdd = hoisted.store.add.bind(hoisted.store)
      hoisted.store.add = (() => {
        throw new Error('refused')
      }) as unknown as typeof hoisted.store.add
      const out = await installSystemTrust(ctx()).catch(() => ({ ok: false, manualCommand: undefined }))
      hoisted.store.add = realAdd as typeof hoisted.store.add
      return out
    })()
    expect(declined.ok).toBe(false)
  })

  it('does not answer from a cache filled before the install', async () => {
    // Read the status first, so the five-second cache holds "untrusted", then
    // install. The panel must see the new state immediately — being told to
    // install something that was just installed is the loop the user hit.
    expect((await systemState()).state).toBe('untrusted')
    const res = await installSystemTrust(ctx())
    expect(res.ok).toBe(true)
    expect((await systemState()).state).toBe('trusted')
  })
})

describe('removing', () => {
  it('is satisfied when the certificate is already absent', async () => {
    // `-delstore` exits non-zero with "not found", which is not a failure of
    // the outcome being asked for.
    const res = await removeSystemTrust(ctx())
    expect(res.ok).toBe(true)
  })

  it('refuses to claim success while it is still in the store', async () => {
    hoisted.store.add(CURRENT_THUMB)
    // A delete that reports success and changes nothing.
    hoisted.store.delete = (() => false) as unknown as typeof hoisted.store.delete

    const res = await removeSystemTrust(ctx())
    expect(res.ok).toBe(false)
    expect(res.manualCommand).toContain('-delstore')

    // Restore for the rest of the file.
    hoisted.store = new Set<string>()
  })

  it('clears the cache, so the panel does not go on saying trusted', async () => {
    hoisted.store.add(CURRENT_THUMB)
    expect((await systemState()).state).toBe('trusted')

    await removeSystemTrust(ctx())
    expect((await systemState()).state).toBe('untrusted')
  })
})

describe('a replaced authority', () => {
  /**
   * The authority is replaced in two places, and one of them is silent: when
   * `inspectCa` finds the stored certificate has expired it mints another
   * without telling anyone. Neither used to untrust what it replaced, so the
   * machine kept a trusted root whose private key had been deleted.
   */
  it('takes the old root back out and leaves the current one alone', async () => {
    const old = ctx()
    await installSystemTrust(old)
    expect(hoisted.store.has(CURRENT_THUMB)).toBe(true)

    // A different authority is now current. The old one is still trusted.
    const fresh = ctx('-----BEGIN CERTIFICATE-----\nQkJCQkJCQkJCQkJCQg==\n-----END CERTIFICATE-----\n')
    const freshThumb = sha1Hex(fresh.certPem).toUpperCase()
    hoisted.store.add(freshThumb)

    const swept = await removeStaleTrust(fresh)

    expect(swept.removed).toBe(1)
    expect(hoisted.store.has(CURRENT_THUMB)).toBe(false)
    expect(hoisted.store.has(freshThumb)).toBe(true)
  })

  it('removes nothing when there is nothing stale', async () => {
    const c = ctx()
    await installSystemTrust(c)
    const swept = await removeStaleTrust(c)
    expect(swept.removed).toBe(0)
    expect(hoisted.store.has(CURRENT_THUMB)).toBe(true)
  })
})

/**
 * The system proxy, and the difference between what we believe and what the
 * machine is actually doing.
 *
 * `systemProxyEngaged()` answers "do we hold a backup file" — that is, do we
 * BELIEVE we changed something. It was also the guard on applying the proxy at
 * all, which treated the two questions as one. They come apart on exactly the
 * machines that reported this: a Group Policy refresh, a VPN client
 * connecting, or any other proxy tool rewrites the same three registry values,
 * and the inspector then runs, reports itself engaged, and receives nothing.
 */
describe('the system proxy', () => {
  const pointsAt = (host: string, port: number): Promise<boolean> =>
    systemProxyPointsAt(host, port, 'win32')

  beforeEach(() => hoisted.registry.clear())

  it('is engaged only when the switch and the address both agree', async () => {
    hoisted.registry.set('ProxyEnable', '0x1')
    hoisted.registry.set('ProxyServer', '127.0.0.1:8080')
    expect(await pointsAt('127.0.0.1', 8080)).toBe(true)

    // The switch turned off with the address left behind: what a VPN client
    // connecting typically does.
    hoisted.registry.set('ProxyEnable', '0x0')
    expect(await pointsAt('127.0.0.1', 8080)).toBe(false)

    // The address moved somewhere else entirely: another proxy tool.
    hoisted.registry.set('ProxyEnable', '0x1')
    hoisted.registry.set('ProxyServer', '10.0.0.9:3128')
    expect(await pointsAt('127.0.0.1', 8080)).toBe(false)
  })

  it('is not engaged when the values are simply absent', async () => {
    expect(await pointsAt('127.0.0.1', 8080)).toBe(false)
  })

  it('does not accept a port that merely shares a prefix', async () => {
    hoisted.registry.set('ProxyEnable', '0x1')
    hoisted.registry.set('ProxyServer', '127.0.0.1:80')
    expect(await pointsAt('127.0.0.1', 8080)).toBe(false)
  })

  it('does not read 0x10 as enabled', async () => {
    // A DWORD of 16 prints as `0x10`, and a prefix match on `0x1` reads it as
    // on. The word boundary in the pattern is what stops that.
    hoisted.registry.set('ProxyEnable', '0x10')
    hoisted.registry.set('ProxyServer', '127.0.0.1:8080')
    expect(await pointsAt('127.0.0.1', 8080)).toBe(false)
  })
})
