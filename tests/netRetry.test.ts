import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const LIB = fileURLToPath(new URL('../scripts/lib/net-retry.sh', import.meta.url))

/**
 * `instant` shadows the real `sleep` with a shell function, so the schedule can
 * be read out of the script without waiting sixty-five seconds for it. The
 * arithmetic under test is the delay sequence, not the sleeping.
 */
const sh = (script: string, env: Record<string, string> = {}, instant = false): string =>
  execFileSync('bash', ['-c', `. ${JSON.stringify(LIB)}\n${instant ? 'sleep() { :; }\n' : ''}${script}`], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  }).trim()

/**
 * The release build that was lost to somebody else's certificate server.
 *
 *   curl: (35) schannel: CRYPT_E_REVOCATION_OFFLINE
 *     - The revocation function was unable to check revocation because the
 *       revocation server was offline
 *
 * Not a bad certificate: curl refusing to proceed because it could not ASK
 * whether the certificate was revoked. Three attempts five and ten seconds
 * apart all fell inside the same outage, so the retry -- which exists precisely
 * to outlast a wobble somewhere else -- outlasted nothing.
 *
 * Run against the real script rather than a copy of its logic, for the reason
 * driftCommandRuns.test.ts exists: a shell script that is only ever
 * string-matched can be asserted about at length and still not run.
 */

describe('curl flags for a revocation server that is down', () => {
  it('adds nothing on this platform', () => {
    // The flag exists only in schannel builds and is REJECTED by a curl built
    // against OpenSSL, so a stray one breaks macOS and Linux outright.
    expect(sh('curl_tls_flags')).toBe('')
  })

  it('adds nothing even on Windows when curl is not schannel', () => {
    // Both conditions, not either: Git-for-Windows ships schannel curl, but a
    // runner with an OpenSSL curl on PATH must not be handed the flag.
    const out = sh('curl_tls_flags', { OS: 'Windows_NT' })
    expect(out === '' || out === '--ssl-revoke-best-effort').toBe(true)
    if (out !== '') {
      const schannel = sh('curl --version | grep -ci schannel || true')
      expect(Number(schannel)).toBeGreaterThan(0)
    }
  })
})

describe('how long a retry waits', () => {
  it('makes four attempts, not three', () => {
    const out = sh('retry_network "probe" false 2>&1 || true', {}, true)
    expect(out).toContain('attempt 1 of 4')
    expect(out).toContain('attempt 3 of 4')
    expect(out).toContain('failed four times')
  })

  it('backs off far enough to outlast a short outage', () => {
    // 5 + 10 spanned fifteen seconds and lost a release. The delays are read
    // from the script's own output rather than assumed.
    const out = sh('retry_network "probe" false 2>&1 || true', {}, true)
    const waits = [...out.matchAll(/retrying in (\d+)s/g)].map((m) => Number(m[1]))
    expect(waits).toEqual([5, 15, 45])
    expect(waits.reduce((a, b) => a + b, 0)).toBeGreaterThan(60)
  })

  it('still succeeds without waiting when the command works', () => {
    expect(sh('retry_network "probe" true && echo OK')).toBe('OK')
  })
})
