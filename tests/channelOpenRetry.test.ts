import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isChannelOpenFailure } from '../src/main/services/ssh'

const SSH = readFileSync(
  fileURLToPath(new URL('../src/main/services/ssh.ts', import.meta.url)),
  'utf8'
)

/**
 * "(SSH) Channel open failure: open failed", four times in eighteen seconds.
 *
 * Reported as an agent whose connection "closes intermittently", and the MCP
 * connection was never the problem: it delivered every request and carried
 * every answer back. sshd was refusing to open another CHANNEL on a connection
 * the pool kept handing out -- most often because MaxSessions (10 by default)
 * was used up, sometimes because the connection was half-dead and only the
 * server knew.
 *
 * The app treated that as a fact about the command rather than about the
 * connection, so the failed connection went back into the pool and the next
 * command drew it again.
 */

describe('telling a refused channel from a failed command', () => {
  it('recognises what sshd actually says', () => {
    expect(isChannelOpenFailure('Channel open failure: open failed')).toBe(true)
    expect(isChannelOpenFailure('(SSH) Channel open failure: open failed')).toBe(true)
    expect(isChannelOpenFailure('Channel open failure: administratively prohibited')).toBe(true)
  })

  it('does not mistake an ordinary command failure for one', () => {
    // These are commands that RAN. Retrying them would run them twice.
    expect(isChannelOpenFailure('bash: line 1: foo: command not found')).toBe(false)
    expect(isChannelOpenFailure('Permission denied (publickey)')).toBe(false)
    expect(isChannelOpenFailure('Command timed out after 30000ms')).toBe(false)
    expect(isChannelOpenFailure(undefined)).toBe(false)
    expect(isChannelOpenFailure('')).toBe(false)
  })
})

describe('what happens when one is seen', () => {
  it('takes the connection out of the pool before acquiring another', () => {
    // Otherwise the fresh acquire is handed back the same bad connection and
    // the retry is not a retry at all.
    const exec = SSH.slice(SSH.indexOf('const first = await execOn'))
    const body = exec.slice(0, exec.indexOf('const second = await execOn'))
    expect(body.indexOf('invalidate(conn)')).toBeGreaterThan(-1)
    expect(body.indexOf('invalidate(conn)')).toBeLessThan(body.indexOf('acquire(cfg'))
  })

  it('retries exactly once', () => {
    const exec = SSH.slice(SSH.indexOf('const first = await execOn'))
    expect(exec.slice(0, 2000).match(/await execOn\(/g)?.length).toBe(2)
  })

  it('only retries a command that provably did not run', () => {
    // The whole safety argument: the channel was never opened, so nothing
    // executed. A retry after a failure that MIGHT have executed is how an
    // agent installs a package twice.
    expect(SSH).toMatch(/channel was never opened, so the command did not run/)
  })

  it('says what a second failure means instead of repeating "open failed"', () => {
    expect(SSH).toMatch(/MaxSessions limit is reached/)
  })
})
