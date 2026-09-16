import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sshHopFor } from '../src/renderer/src/lib/ssh'
import type { Server } from '../src/renderer/src/types'

/**
 * Reaching a database through a bastion, reliably.
 *
 * Three separate defects made this unreliable, and the one that was obvious —
 * that a background read could raise a verification-code dialog — was the least
 * of them. Threading a flag would only have chosen between asking constantly
 * and always failing.
 *
 *  1. The jump host's OWN chain was dropped on the way across the bridge, so a
 *     database behind a two-hop chain dialled the second bastion's private
 *     address from this laptop and timed out naming an address nobody typed.
 *  2. The forward opened its own SSH connection through the unpooled walker, so
 *     every database connection authenticated the bastion again from scratch —
 *     one verification code per connection, and `openTransient` (which the
 *     Operations panel uses deliberately) opens one every time it runs. None of
 *     those codes could be spent on the connection the user's own terminal had
 *     already authenticated to the same machine.
 *  3. The bastion was never annotated with its own VPN, so one only routable
 *     over a tunnel was dialled directly.
 */

const read = (p: string): string => readFileSync(resolve(__dirname, '..', p), 'utf8')

const TUNNEL = read('src/main/services/tunnel.ts')
const DB = read('src/main/services/db.ts')
const MAIN = read('src/main/index.ts')

const FORWARD = TUNNEL.slice(TUNNEL.indexOf('export async function openEphemeralForward'))

const server = (over: Partial<Server> = {}): Server =>
  ({
    id: 'srv-jump-ssh',
    name: 'Jump SSH',
    host: '172.30.11.9',
    port: 22,
    username: 'ali',
    auth: 'key',
    route: [],
    ...over
  }) as Server

describe('the jump host a database is tunnelled through', () => {
  it('carries its own chain, so a bastion behind a bastion is reachable', () => {
    const hop = sshHopFor(
      server({
        route: [{ host: '172.30.11.62', port: 22, username: 'ali', auth: 'key', serverId: 'srv-jump-auth' }] as never
      })
    )
    expect(hop.hops).toHaveLength(1)
    expect(hop.hops[0]).toMatchObject({ host: '172.30.11.62', serverId: 'srv-jump-auth' })
  })

  it('carries an empty chain for a bastion reached directly', () => {
    expect(sshHopFor(server()).hops).toEqual([])
  })

  /**
   * Not merely cosmetic: `hopKey` includes the parent, so a hop with no parent
   * is a different pool entry from the same hop reached through its chain. Drop
   * the chain and the database cannot share the bastion the terminal
   * authenticated even once the forward is pooled.
   */
  it('keeps the identity main pools on', () => {
    expect(sshHopFor(server()).serverId).toBe('srv-jump-ssh')
  })
})

describe('the forward itself', () => {
  it('takes its connection from the pool every other feature shares', () => {
    expect(FORWARD).toContain('await acquire(ssh, undefined, allowPrompt)')
    // The unpooled walker is what made every database connection its own
    // authentication. `tunnelStart` above still uses it; this no longer does.
    expect(FORWARD).not.toContain('openChain(')
  })

  it('hands the connection back instead of ending it', () => {
    // Ending it would tear down the terminal sitting on the same connection.
    expect(FORWARD).toContain('release(conn)')
    expect(FORWARD).not.toMatch(/c\.end\(\)/)
  })

  /**
   * A shared connection going away has to close the listener.
   *
   * Otherwise the local port stays bound over a dead channel: the driver's next
   * connection hangs until its own timeout instead of being refused, and the
   * caller's close() releases a connection that is already gone.
   */
  it('closes the listener when the shared connection goes', () => {
    expect(FORWARD).toContain("client.once('close', onConnectionLost)")
    expect(FORWARD).toContain("client.removeListener('close', onConnectionLost)")
  })

  it('closes once, however many ways it is asked', () => {
    expect(FORWARD).toContain('if (closed) return')
  })
})

describe('a bastion reached through the database’s own VPN', () => {
  /**
   * The pool keys a hop with a `serverId` on that id alone, and this one has
   * been rewritten to a loopback port. Without a tag it would share an entry
   * with a DIRECT connection to the same bastion, and whichever was dialled
   * first would decide which network the other one's bytes went over.
   *
   * The tag names the VPN and never the ephemeral port: a key that changes on
   * every call is a pool that never hits.
   */
  it('is tagged apart from a direct connection to the same bastion', () => {
    expect(DB).toContain('poolTag: `fwd:${vpnId}`')
  })

  it('does not then open the bastion’s own tunnel underneath it', () => {
    const i = DB.indexOf('poolTag: `fwd:${vpnId}`')
    expect(DB.slice(i, i + 200)).toContain('vpnProfileId: undefined')
  })
})

describe('who may raise a dialog', () => {
  // Default false through the whole chain: the callers that are not a person
  // are the ones a wrong default harms.
  it('defaults to asking nobody', () => {
    for (const sig of [
      'async function build(cfg: DbConnectConfig, allowPrompt = false)',
      'async function buildOverVpn(cfg: DbConnectConfig, allowPrompt = false)',
      'export async function ensure(cfg: DbConnectConfig, allowPrompt = false)',
      'export async function openTransient(cfg: DbConnectConfig, allowPrompt = false)'
    ]) {
      expect(DB, sig).toContain(sig)
    }
    expect(FORWARD).toContain('allowPrompt = false')
  })

  it('reaches the forward rather than stopping at the driver', () => {
    expect(DB).toContain('openEphemeralForward(cfg.ssh, targetHost, targetPort, allowPrompt)')
  })

  // Somebody clicked. These are the only callers that opt in.
  it('is lifted by the handlers a person drives', () => {
    expect(MAIN).toContain('dbQuery(withVpnTransportDb(resolveDbSecrets(cfg)), text, true)')
    expect(MAIN).toContain('dbOps(withVpnTransportDb(resolveDbSecrets(cfg)), true)')
    expect(DB).toContain('const conn = await build(cfg, true)')
  })

  /**
   * And not by the two that run on their own. The MCP bridge's `query_database`
   * and the hourly size sampler both take the default; a dialog out of either
   * is attached to nothing anybody did, and unanswered it costs the host a
   * failed authentication.
   */
  it('is not lifted by the agent bridge', () => {
    expect(read('src/main/services/mcpServer.ts')).toContain(
      'dbQuery(resolveDbSecrets(databaseConfig(db)), statement)'
    )
  })

  it('is not lifted by the size sampler', () => {
    const i = MAIN.indexOf('const dbSampler = new DbSampler({')
    expect(MAIN.slice(i, i + 400)).toContain('dbOps(withVpnTransportDb(resolveDbSecrets(cfg)))')
  })
})
