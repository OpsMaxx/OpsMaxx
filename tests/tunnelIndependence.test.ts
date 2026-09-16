import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sshHopFor } from '../src/renderer/src/lib/ssh'
import type { Server } from '../src/renderer/src/types'

/**
 * A tunnel owns its connection, and owns every hop of it.
 *
 * This is the opposite decision from the ephemeral forward a database dials
 * through, and both are deliberate. A database forward is a means to an end
 * that lives and dies with one query session, so it rides the shared pool and
 * costs no extra authentication. A tunnel is a long-lived thing an operator
 * started and expects to outlive whatever else happens to be open: on the pool,
 * a terminal closing — or the pool's own idle rules — would decide when a
 * published port stopped answering.
 *
 * Independence has to survive jump boxes, which is where it was broken:
 *
 *  - the bastion's own chain was dropped crossing the bridge, so a tunnel
 *    through a server that is itself behind another server dialled a private
 *    address from this laptop;
 *  - only the LAST client in the chain was watched, so a bastion going away
 *    left the tunnel reporting `active` over a dead path;
 *  - and an agent could start one, raising a dialog nobody had asked for.
 */

const read = (p: string): string => readFileSync(resolve(__dirname, '..', p), 'utf8')

const TUNNEL = read('src/main/services/tunnel.ts')
const START = TUNNEL.slice(
  TUNNEL.indexOf('export async function tunnelStart'),
  TUNNEL.indexOf('export async function tunnelStop')
)

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

describe('the connection a tunnel opens', () => {
  it('is its own, not one from the pool', () => {
    expect(START).toContain('openChain(ssh, undefined, allowPrompt)')
    expect(START).not.toContain('acquire(')
  })

  // Every hop it dialled, in reverse. Independence is only real if the teardown
  // is complete: a chain that failed on hop three still opened one and two.
  it('is given back in full when the tunnel stops', () => {
    // Bounded: the ephemeral forward below releases a POOLED connection, which
    // is the opposite decision and must not be read as this one.
    const from = TUNNEL.indexOf('export async function tunnelStop')
    const stop = TUNNEL.slice(from, TUNNEL.indexOf('export function tunnelList', from))
    expect(stop).toContain('for (const c of [...t.clients].reverse())')
    expect(stop).toContain('c.end()')
    // Never released: nothing else is holding these, so ending them is right.
    expect(stop).not.toContain('release(')
  })
})

describe('a tunnel that relies on jump boxes', () => {
  it('is handed the bastion’s own chain', () => {
    const hop = sshHopFor(
      server({
        route: [
          { host: '172.30.11.62', port: 22, username: 'ali', auth: 'key', serverId: 'srv-jump-auth' }
        ] as never
      })
    )
    expect(hop.hops).toHaveLength(1)
    expect(hop.hops[0]).toMatchObject({ serverId: 'srv-jump-auth', host: '172.30.11.62' })
  })

  /**
   * Hops 1..n ride channels opened on the hop before, so a bastion going away
   * kills the chain in fact — but only the client whose own socket closed is
   * guaranteed to say so. Watching the last one alone is what left a multi-hop
   * tunnel green over a path that had been dead for minutes.
   */
  it('notices any hop going away, not only the last', () => {
    expect(START).toContain('for (const c of chain.clients) {')
    expect(START).toContain("c.on('close', () => {")
    expect(START).toContain("c.on('error', (err: Error) => {")
    // The old shape: the final client, and nothing else.
    expect(START).not.toMatch(/client\.on\('close'/)
  })

  // Idempotent by construction: several hops closing at once is one stop.
  it('stops once however many hops report it', () => {
    expect(START).toContain('if (tunnels.get(cfg.id) === t && t.state === \'active\')')
  })
})

describe('who may be asked for a second factor', () => {
  it('defaults to asking nobody', () => {
    expect(START).toMatch(/allowPrompt = false/)
  })

  // A person pressed Start.
  it('is lifted by the IPC handler', () => {
    expect(read('src/main/index.ts')).toContain(
      'tunnelStart(e.sender, cfg, preparedSshTarget(ssh), true)'
    )
  })

  /**
   * And not by `set_tunnel`. An agent starting a tunnel through a bastion must
   * not raise a verification-code dialog, nor a trust-on-first-use dialog for
   * an unknown host — answering that would record a trust decision as a side
   * effect of something the agent asked for.
   */
  it('is not lifted by the agent bridge', () => {
    const mcp = read('src/main/services/mcpServer.ts')
    const i = mcp.indexOf('const result = await tunnelStart(')
    expect(i).toBeGreaterThan(-1)
    expect(mcp.slice(i, i + 220)).not.toContain('true')
  })
})

describe('the one unpooled caller that does prompt', () => {
  /**
   * `sshOpenFresh` proves an independent authentication for an access commit.
   * The operator has just confirmed a key change on their own servers and is
   * watching it land, so a second factor asked for there is the answer to that
   * — and refusing would make access commits impossible on exactly the hosts
   * most likely to require one.
   *
   * Safe only because the access write path is not exposed to the MCP bridge.
   * If that ever changes, this is the line that has to change with it.
   */
  it('says so at the call site rather than inheriting a default', () => {
    const ssh = read('src/main/services/ssh.ts')
    const i = ssh.indexOf('export async function sshOpenFresh')
    expect(i).toBeGreaterThan(-1)
    expect(ssh.slice(i, i + 2500)).toContain('openChain(cfg, undefined, true)')
  })

  it('is still the only access-commit implementation main wires up', () => {
    expect(read('src/main/index.ts')).toContain('openFresh: (cfg, timeoutMs) =>')
    expect(read('src/main/index.ts')).toContain('sshOpenFresh(preparedSshTarget(cfg as SshConnectConfig), timeoutMs)')
  })
})
