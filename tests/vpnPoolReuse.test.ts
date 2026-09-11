import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SSH = readFileSync(
  fileURLToPath(new URL('../src/main/services/ssh.ts', import.meta.url)),
  'utf8'
)

/**
 * A pool key that never repeats is not a pool.
 *
 * The tag for a hop dialled through a VPN forward was `fwd:<vpnId>:<port>`, and
 * that port is freshly allocated on every call. So for any server reached over
 * a VPN the pool never hit once: every command opened a new forward, a new TCP
 * connection and a full new SSH authentication, and the connection it replaced
 * stayed in the pool under a key nothing would ever compute again until the
 * idle timer reaped it fifteen minutes later.
 *
 * A dozen commands in a row therefore meant a dozen live authenticated sessions
 * to one host. That is what exhausts sshd's MaxSessions, and "Channel open
 * failure: open failed" is what it says when it has had enough -- reported here
 * as an agent whose connection kept dropping.
 */

describe('the pool key for a tunnelled hop', () => {
  it('names the VPN and not the forward’s port', () => {
    expect(SSH).toMatch(/poolTag: `fwd:\$\{vpnId\}`/)
    expect(SSH).not.toMatch(/poolTag: `fwd:\$\{vpnId\}:\$\{fwd\.port\}`/)
  })

  it('still separates a tunnelled connection from a direct one', () => {
    // Dropping the tag entirely would let a direct connection and a tunnelled
    // one to the same server share a key, which is the bug this tag was added
    // for in the first place.
    const key = SSH.slice(SSH.indexOf('function hopKey'), SSH.indexOf('function destroy'))
    expect(key).toMatch(/const tag = hop\.poolTag \? `\|\$\{hop\.poolTag\}` : ''/)
  })
})

describe('why dropping the port is safe', () => {
  it('the forward belongs to the connection, not to the acquire', () => {
    // The original comment feared reusing a connection whose forward had since
    // closed. It cannot: the forward is closed when the CONNECTION is
    // destroyed.
    expect(SSH).toMatch(/conn\.vpnRelease = dial\.release/)
    expect(SSH).toMatch(/vpnRelease/)
  })

  it('a pool hit releases the forward it opened rather than leaking it', () => {
    expect(SSH).toMatch(/if \(conn\.vpnRelease\) dial\.release\(\)/)
  })
})
