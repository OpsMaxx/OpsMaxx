import { describe, it, expect, beforeEach, vi } from 'vitest'

// macOS certificate trust, which is the one platform where "the command
// succeeded" and "the machine trusts the certificate" are different facts.
//
// The bug this file exists for: on a managed Mac (macOS 15.7.3, Mosyle),
// `security add-trusted-cert -d …` run through ShellPilot's osascript elevator
// imported the CA into the system keychain, wrote NO trust setting, and exited
// 0. The identical command under `sudo` in Terminal worked. The panel then
// looped — "installed but not trusted, install it again" — and pressing the
// button repeated the attempt that had already been refused.
//
// So the assertions here are about the three things that make that
// unrecoverable state recoverable: the elevated command verifies its own work,
// there is a second route that does not need the elevator at all, and the
// third outcome is a printed command rather than another button. Nothing here
// runs `security` or raises a prompt; the seam is child_process and the
// elevator, both mocked.

const hoisted = vi.hoisted(() => ({
  /** Every `security` invocation, in order, as [cmd, ...args]. */
  execCalls: [] as string[][],
  /** Elevated requests: what would have gone through osascript. */
  elevated: [] as { command: string; args: string[] }[],
  elevatorAvailable: true,
  elevatedExit: { code: 0 as number | null, declined: false },
  /** Does the elevated admin-domain write actually produce trust? False
   *  reproduces the incident. */
  adminWritesTrust: true,
  /** Does the unelevated user-domain write produce trust? */
  userWritesTrust: true,
  /** Is there a user-domain trust setting to clean up on removal? */
  userTrustPresent: false,
  trusted: false
}))

vi.mock('node:child_process', () => {
  const execFile = (
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void
  ): void => {
    hoisted.execCalls.push([cmd, ...args])
    const ok = (stdout: string): void => cb(null, { stdout, stderr: '' })
    const fail = (stdout = ''): void => {
      const e = Object.assign(new Error(`${cmd} failed`), { stdout, code: 1 })
      cb(e)
    }
    if (args[0] === 'find-certificate') return ok(`SHA-256 hash: ${FINGERPRINT.toUpperCase()}\n`)
    if (args[0] === 'verify-cert') return hoisted.trusted ? ok('...certificate verification successful.\n') : fail()
    if (args[0] === 'add-trusted-cert') {
      // Only the unelevated (user-domain) form reaches child_process; the
      // admin form goes through the elevator.
      if (hoisted.userWritesTrust) hoisted.trusted = true
      return ok('')
    }
    if (args[0] === 'dump-trust-settings') {
      return hoisted.userTrustPresent ? ok(`Cert 0: ${COMMON_NAME}\n`) : fail()
    }
    return ok('')
  }
  return { execFile, default: { execFile } }
})

vi.mock('../src/main/services/vpn/elevation', () => ({
  elevatorForPlatform: () => ({
    method: 'osascript',
    carriesStdin: false,
    probe: async () => ({ available: hoisted.elevatorAvailable, method: 'osascript', reason: 'no osascript' }),
    run: async (req: { command: string; args: string[] }) => {
      hoisted.elevated.push({ command: req.command, args: req.args })
      if (hoisted.adminWritesTrust && !hoisted.elevatedExit.declined) hoisted.trusted = true
      return { pid: 1, wait: async () => hoisted.elevatedExit, kill: async () => undefined }
    }
  })
}))

import {
  darwinAdminTrustScript,
  darwinManualTrustCommand,
  darwinUserTrustArgs,
  installSystemTrust,
  invalidateTrustCache,
  removeSystemTrust,
  sha256Hex
} from '../src/main/services/inspectTrust'
import type { TrustContext } from '../src/main/services/inspectTrust'

const COMMON_NAME = 'ShellPilot Traffic Inspector CA'
// A path with a space, because that is the common case on macOS — and the
// reason every one of these commands is quoted.
const CERT_PATH = '/Users/x/Library/Application Support/ShellPilot/inspect/ca.crt'
const CERT_PEM =
  '-----BEGIN CERTIFICATE-----\nTUlJQmt6Q0NBVGtDRkE9PQ==\n-----END CERTIFICATE-----\n'
const FINGERPRINT = sha256Hex(CERT_PEM)

const ctx: TrustContext = {
  platform: 'darwin',
  certPath: CERT_PATH,
  certPem: CERT_PEM,
  commonName: COMMON_NAME
}

const securityCalls = (verb: string): string[][] =>
  hoisted.execCalls.filter((c) => c[0] === 'security' && c[1] === verb)

beforeEach(() => {
  hoisted.execCalls.length = 0
  hoisted.elevated.length = 0
  hoisted.elevatorAvailable = true
  hoisted.elevatedExit = { code: 0, declined: false }
  hoisted.adminWritesTrust = true
  hoisted.userWritesTrust = true
  hoisted.userTrustPresent = false
  hoisted.trusted = false
  invalidateTrustCache()
})

describe('the macOS commands themselves', () => {
  it('sends the admin write and a verification through one elevated shell', () => {
    // The verification is inside the elevated context on purpose: the incident
    // was an add-trusted-cert that exited 0 having written no trust setting,
    // and `&&` turns that partial success into a failure we can act on.
    const script = darwinAdminTrustScript(CERT_PATH)
    expect(script).toContain('security add-trusted-cert -d -r trustRoot -p ssl')
    expect(script).toContain("-k '/Library/Keychains/System.keychain'")
    expect(script).toContain(`'${CERT_PATH}'`)
    expect(script).toMatch(/&&\s*security verify-cert -c '.*' -p ssl$/)
  })

  it('quotes a path containing a quote instead of letting it run', () => {
    // The payload survives as literal text inside single quotes — every quote
    // it tried to close is escaped — so /bin/sh sees one argument and not two
    // commands.
    const script = darwinAdminTrustScript(`/tmp/'; rm -rf /; echo '`)
    expect(script).toContain(`'/tmp/'\\''; rm -rf /; echo '\\'''`)
    expect(script.split("'").length % 2).toBe(1) // quotes balance
  })

  it('asks for the user domain with no -d and no -k', () => {
    // -d is the admin domain and needs root. Omitting it — and omitting -k, so
    // `security` picks the login keychain itself — is what makes this route
    // usable from the app's own session with no elevation at all.
    const args = darwinUserTrustArgs(CERT_PATH)
    expect(args).toEqual(['add-trusted-cert', '-r', 'trustRoot', '-p', 'ssl', CERT_PATH])
    expect(args).not.toContain('-d')
    expect(args).not.toContain('-k')
  })

  it('prints the command that was proven to work on the affected machine', () => {
    const cmd = darwinManualTrustCommand(CERT_PATH)
    expect(cmd).toBe(
      `sudo security add-trusted-cert -d -r trustRoot -p ssl -k /Library/Keychains/System.keychain '${CERT_PATH}'`
    )
  })
})

describe('installing macOS trust', () => {
  it('stops at the elevated admin write when that produces trust', async () => {
    const res = await installSystemTrust(ctx)
    expect(res.ok).toBe(true)
    expect(hoisted.elevated).toHaveLength(1)
    expect(hoisted.elevated[0].command).toBe('sh')
    expect(hoisted.elevated[0].args[1]).toContain('add-trusted-cert -d')
    // No second prompt when the first one did the job.
    expect(securityCalls('add-trusted-cert')).toHaveLength(0)
  })

  it('falls back to the user domain when the elevated write exits 0 and changes nothing', async () => {
    // The reported incident, exactly: elevation succeeds, trust does not.
    hoisted.adminWritesTrust = false
    hoisted.userWritesTrust = true

    const res = await installSystemTrust(ctx)

    expect(res.ok).toBe(true)
    expect(securityCalls('add-trusted-cert')).toHaveLength(1)
    expect(securityCalls('add-trusted-cert')[0]).not.toContain('-d')
    // Success is told honestly: this is narrower than machine-wide trust.
    expect(res.message).toMatch(/user account/i)
    expect(res.manualCommand).toBeUndefined()
  })

  it('reaches the user domain even when the machine cannot elevate at all', async () => {
    hoisted.elevatorAvailable = false
    hoisted.adminWritesTrust = false

    const res = await installSystemTrust(ctx)

    expect(hoisted.elevated).toHaveLength(0)
    expect(res.ok).toBe(true)
    expect(securityCalls('add-trusted-cert')).toHaveLength(1)
  })

  it('hands back the sudo command when both routes are refused, never another install', async () => {
    hoisted.adminWritesTrust = false
    hoisted.userWritesTrust = false

    const res = await installSystemTrust(ctx)

    expect(res.ok).toBe(false)
    expect(res.declined).toBeFalsy()
    expect(res.manualCommand).toBe(darwinManualTrustCommand(CERT_PATH))
    // The old copy — "install it again" — was the loop. Whatever this says, it
    // must not be that.
    expect(res.message ?? '').not.toMatch(/install it again/i)
    expect(res.message ?? '').toMatch(/terminal/i)
  })

  it('treats a declined password prompt as an answer, not as a reason to prompt again', async () => {
    hoisted.elevatedExit = { code: null, declined: true }

    const res = await installSystemTrust(ctx)

    expect(res).toMatchObject({ ok: false, declined: true })
    expect(securityCalls('add-trusted-cert')).toHaveLength(0)
    // Nothing to copy: the user did not fail, they said no.
    expect(res.manualCommand).toBeUndefined()
  })

  it('never reports success without asking verify-cert', async () => {
    await installSystemTrust(ctx)
    expect(securityCalls('verify-cert').length).toBeGreaterThan(0)
  })
})

describe('removing macOS trust', () => {
  it('clears the admin trust setting before deleting the certificate', async () => {
    const res = await removeSystemTrust(ctx)
    expect(res.ok).toBe(true)
    const script = hoisted.elevated[0].args[1]
    expect(script.indexOf('remove-trusted-cert -d')).toBeLessThan(script.indexOf('delete-certificate'))
    // `;` not `&&`: the trust setting is often the thing that was never
    // written, and the certificate still has to go.
    expect(script).toContain(' ; ')
  })

  it('also clears a user-domain trust setting it finds', async () => {
    hoisted.userTrustPresent = true
    await removeSystemTrust(ctx)
    expect(securityCalls('remove-trusted-cert')).toHaveLength(1)
    expect(securityCalls('remove-trusted-cert')[0]).toContain(CERT_PATH)
  })

  it('does not raise a prompt to undo a user-domain setting that was never made', async () => {
    hoisted.userTrustPresent = false
    await removeSystemTrust(ctx)
    expect(securityCalls('remove-trusted-cert')).toHaveLength(0)
  })
})
