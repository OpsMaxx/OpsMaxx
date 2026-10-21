import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every SSH target rides the VPN its server is assigned.
 *
 * Credentials and the VPN both have to be resolved in main, on every target,
 * and they were paired BY HAND at each call site. The note at the top of
 * services/vpn/transport.ts predicted what happens: "every caller would have
 * to remember to". Six remembered. Twenty-two did not.
 *
 * The ones that did not were not obscure — `metrics:sample`, the fleet sampler
 * and all four of its probes, broadcast, jobs, Docker, Kubernetes, cron, the
 * log tail, the access committer's staged write, and `tunnel:start`. On a
 * directly routable host the omission is invisible, because the dial works
 * either way. On a host reachable ONLY through a VPN it is total: the feature
 * dials the address itself, and a tailnet address is not routed on this
 * machine.
 *
 * So there is one helper now, and this is what stops the pairing coming apart
 * again.
 */

const MAIN = readFileSync(join(__dirname, '..', 'src/main/index.ts'), 'utf8')

/** Comments say the name constantly; only a call counts. */
const stripped = MAIN.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('main resolves credentials and the VPN together', () => {
  it('never calls resolveChainSecrets on its own', () => {
    // The bare call is the bug: it resolves the credential and leaves the
    // connection pointed at an address nothing routes.
    expect(stripped).not.toMatch(/\bresolveChainSecrets\s*\(/)
  })

  it('uses the one helper that does both', () => {
    const uses = stripped.match(/\bpreparedSshTarget\s*\(/g) ?? []
    // Not a threshold for its own sake: every SSH entry point in main goes
    // through this, so a number that collapses means they stopped.
    expect(uses.length).toBeGreaterThan(20)
  })

  it('covers the paths that were missing it', () => {
    // Named individually because each is a feature that silently could not
    // reach a VPN-only host, and a count would not notice one regressing.
    for (const call of [
      'tunnelStart(e.sender, cfg, preparedSshTarget(ssh), true)',
      'return metricsSample(key, preparedSshTarget(cfg), interactive === true)'
    ]) {
      expect(stripped).toContain(call)
    }
  })
})

describe('the MCP server resolves them together too', () => {
  // The same pairing, in the file this test did not read. execute_command,
  // list_files and every other agent tool built its target with a bare
  // resolveChainSecrets, so a server behind OpsMaxx's own Tailscale node
  // worked in the app's terminal and failed for an agent with
  // `getaddrinfo ENOTFOUND <machine-name>` — the MagicDNS name only resolves
  // inside the node. Only test_connection had the helper.
  // Raw, not comment-stripped: this file has strings the stripping regexes
  // mistake for comments, and they swallow real calls. Neither pattern below
  // appears in a comment here.
  const MCP = readFileSync(join(__dirname, '..', 'src/main/services/mcpServer.ts'), 'utf8')

  it('never calls resolveChainSecrets on its own', () => {
    expect(MCP).not.toMatch(/\bresolveChainSecrets\s*\(/)
  })

  it('prepares every server it dials', () => {
    expect((MCP.match(/\bpreparedSshTarget\(serverToSshConfig\(/g) ?? []).length).toBeGreaterThanOrEqual(18)
  })
})

describe('the helper itself', () => {
  const SRC = readFileSync(
    join(__dirname, '..', 'src/main/services/vpn/transport.ts'),
    'utf8'
  )

  it('applies the credential resolution and the VPN annotation', () => {
    expect(SRC).toMatch(/preparedSshTarget[\s\S]*withVpnTransport\(resolveChainSecrets\(/)
  })

  it('leaves a server with no VPN untouched', () => {
    // What makes applying it everywhere safe rather than a shortcut: the
    // annotation is a no-op unless the saved record names a profile.
    expect(SRC).toMatch(/if \(!vpnProfileId\) return cfg/)
    expect(SRC).toMatch(/if \(!cfg\.serverId\) return cfg/)
  })
})
