import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { rdpSecretId } from '../src/shared/rdp'

/**
 * RDP's login, which used to be SSH's login.
 *
 * Reported as "RDP and SSH should be mutually exclusive not codependent in
 * the UI". Hiding the SSH fields for an RDP-only machine was only half of it:
 * the desktop resolved its account from `Server.username` and its password
 * from `getSecret(serverId)` — the ONE secret per server. So a Windows box
 * reached as Administrator over RDP and as root over SSH had to agree on a
 * single password, which on Windows they never do. That is codependence in
 * the data, not just in the form.
 */

const src = (p: string): string => readFileSync(resolve(__dirname, '..', p), 'utf8')
const RELAY = src('src/main/services/rdpRelay.ts')
const MODAL = src('src/renderer/src/components/connections/AddServerModal.tsx')

describe('where an RDP password lives', () => {
  it('is a different id from the server\'s own', () => {
    expect(rdpSecretId('srv-1')).toBe('srv-1:rdp')
    expect(rdpSecretId('srv-1')).not.toBe('srv-1')
  })

  it('is derived, so nothing has to be migrated', () => {
    // Two servers cannot collide, and the id is a pure function of the
    // server's — a record saved before this simply has nothing stored there.
    expect(rdpSecretId('a')).not.toBe(rdpSecretId('b'))
    expect(rdpSecretId('a')).toBe(rdpSecretId('a'))
  })

  // Written under its own id rather than merged into the SSH blob, which is
  // the whole point: one blob is one password.
  it('is stored separately by the form', () => {
    expect(MODAL).toContain('storeSecret(rdpSecretId(id)')
    expect(MODAL).toMatch(/speaks !== 'ssh' && rdpPassword/)
  })

  /**
   * A credential for a machine the app no longer knows about is worse than a
   * missing one: nothing in the UI can reach it to remove it.
   */
  it('is deleted with the server, from both delete paths', () => {
    expect(src('src/renderer/src/components/connections/ConnectionTree.tsx')).toContain(
      'secrets.delete(rdpSecretId(s.id))'
    )
    expect(src('src/renderer/src/components/workspace/WorkspaceManager.tsx')).toContain(
      'secrets.delete(rdpSecretId(d.id))'
    )
  })
})

describe('which account the desktop signs in as', () => {
  it('prefers RDP\'s own, and falls back to the server\'s', () => {
    // The fallback is what keeps every record saved before this working.
    expect(RELAY).toContain("server.rdp.username?.trim() || server.username")
  })

  it('signs the ticket in as that account, not as the SSH one', () => {
    // The bug this prevents: resolving the right user and then handing the
    // relay `server.username` anyway.
    const ticket = RELAY.slice(RELAY.indexOf('const ticket: RdpTicket'))
    expect(ticket).toContain('username: rdpUser')
    expect(ticket).not.toContain('username: server.username')
  })

  /**
   * Tried under RDP's id first, then the server's. The order matters: reading
   * the shared secret first would mean a box with both set keeps using the
   * SSH password forever, and the new field would appear to do nothing.
   */
  it('reads its own secret before the shared one', () => {
    const own = RELAY.indexOf('serverId: rdpSecretId(server.id)')
    const shared = RELAY.indexOf('serverId: server.id', own)
    expect(own).toBeGreaterThan(-1)
    expect(shared, 'the shared secret must be the fallback, not the first try').toBeGreaterThan(own)
  })

  // The refusal names the account, because "no password is stored for this
  // server" is ambiguous once a server has two logins.
  it('names the account when no password is stored', () => {
    expect(RELAY).toContain('No password is stored for ${rdpUser}')
  })
})
