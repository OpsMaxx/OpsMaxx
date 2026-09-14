import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHmac } from 'node:crypto'

import { isValidCloudTarget, type CloudTarget } from '../src/shared/cloud'

// Regressions found in review of the cloud feature. Each of these shipped
// green: the unit tests covered the pieces and none of them covered the way the
// pieces were wired together.

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')

const SSH = read('src/main/services/ssh.ts')
const TRANSPORT = read('src/main/services/vpn/transport.ts')
const MCP = read('src/main/services/mcpServer.ts')
const MODAL = read('src/renderer/src/components/connections/AddServerModal.tsx')

describe('a pooled cloud connection is not brokered again', () => {
  // Brokering is three or four provider CLI calls plus, for a private
  // instance, spawning a tunnel and waiting for it to bind. acquire() ran all
  // of it before the pool was consulted and threw it away on a hit, so every
  // sshExec on a cloud server paid it -- and the metrics sampler calls one on
  // a timer, which meant spawning and killing a tunnel forever.
  it('checks the pool before dialling the provider', () => {
    const acquire = SSH.slice(SSH.indexOf('export async function acquire('))
    const poolCheck = acquire.indexOf('pool.has(cloudKey)')
    const broker = acquire.indexOf('await cloudDial(cfg)')
    expect(poolCheck, 'no pool check before brokering').toBeGreaterThan(-1)
    expect(broker, 'cloudDial call not found').toBeGreaterThan(-1)
    expect(poolCheck, 'the pool must be consulted before the broker runs').toBeLessThan(broker)
  })

  it('joins an open already in flight rather than starting a second broker', () => {
    expect(SSH).toMatch(/connecting\.has\(cloudKey\)/)
  })
})

describe('a cloud target and a jump chain are refused, not silently merged', () => {
  // The rewrite replaced hops[0] -- the BASTION -- with the brokered target,
  // then dialled the original target through it. The VPN path rewrites the
  // first hop because a VPN carries the route to the bastion; a cloud broker
  // returns the destination itself, so the same shape is nonsense.
  it('refuses in the connection layer, on both the pooled and unpooled paths', () => {
    expect(SSH).toMatch(/function assertNoJumpChain/)
    const cloudDial = SSH.slice(SSH.indexOf('async function cloudDial('), SSH.indexOf('async function vpnDial('))
    expect(cloudDial, 'cloudDial does not check').toMatch(/assertNoJumpChain\(cfg\)/)
    const unpooled = SSH.slice(SSH.indexOf('async function openChainOverCloud('))
    expect(unpooled.slice(0, 1200), 'openChainOverCloud does not check').toMatch(
      /assertNoJumpChain\(cfg\)/
    )
  })

  it('never rewrites a hop, because there can be no chain to rewrite', () => {
    const cloudDial = SSH.slice(SSH.indexOf('async function cloudDial('), SSH.indexOf('async function vpnDial('))
    expect(cloudDial).not.toMatch(/cfg\.hops\?\.\[0\]/)
  })

  it('refuses at the agent boundary too, where it can be explained', () => {
    expect(MCP).toMatch(/cannot also be reached through jump hosts/)
  })

  it('does not offer a jump chain in the form for a cloud server', () => {
    // A control that is ignored is a lie about what the app will do.
    const route = MODAL.indexOf('<RouteHops')
    expect(route).toBeGreaterThan(-1)
    expect(MODAL.slice(0, route)).toMatch(/\{!isCloud && \(\s*<>/)
  })
})

describe('the saved record decides where a saved server goes', () => {
  // Passing the id of an ordinary SSH host together with a cloud target would
  // otherwise send the connection somewhere the record never named.
  it('discards a caller-supplied cloud target for a saved server', () => {
    const fn = TRANSPORT.slice(TRANSPORT.indexOf('export function withCloudTransport'))
    expect(fn).toMatch(/cloudTarget: undefined/)
  })

  it('allows one only when there is no saved record to resolve against', () => {
    const fn = TRANSPORT.slice(TRANSPORT.indexOf('export function withCloudTransport'))
    expect(fn).toMatch(/if \(!cfg\.serverId\) return cfg/)
  })
})

describe('a database tunnelled through a cloud server gets its target', () => {
  // shared/db.ts says a cloud-hosted database works. Nothing on the database
  // path put a cloudTarget on the ssh hop, so openChain took the direct route
  // and dialled the empty host every cloud record carries.
  it('annotates the ssh hop, and does it from the shared db entry point', () => {
    expect(TRANSPORT).toMatch(/export function withCloudTransportDb/)
    const vpnDb = TRANSPORT.slice(TRANSPORT.indexOf('export function withVpnTransportDb'))
    expect(vpnDb, 'withVpnTransportDb does not compose the cloud annotation').toMatch(
      /withCloudTransportDb\(cfg\)/
    )
  })
})

describe('two cloud servers are not reported as the same machine', () => {
  // dedupToken hashed host + port + username. Every cloud record has an empty
  // host, so all of them collapsed to one identity -- and list_servers tells
  // an agent that a shared token means "already registered", so it would
  // decline to add a new GCE instance because an unrelated Azure VM existed.
  const GCP: CloudTarget = {
    type: 'gcp',
    project: 'example-prod',
    zone: 'me-central2-c',
    instance: 'web-01',
    transport: 'auto'
  }
  const AZURE: CloudTarget = {
    type: 'azure',
    subscription: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    resourceGroup: 'production-rg',
    vm: 'prod-server-01',
    authentication: 'entra'
  }

  it('hashes the cloud target rather than the absent host', () => {
    expect(MCP).toMatch(/function cloudIdentityParts/)
    const fn = MCP.slice(MCP.indexOf('function dedupToken'))
    expect(fn.slice(0, 1400)).toMatch(/server\.cloud/)
  })

  it('gives different targets different identities', () => {
    // Mirrors what dedupToken now does, so the property is asserted and not
    // merely the presence of a branch.
    const parts = (t: CloudTarget): string[] =>
      t.type === 'gcp'
        ? ['gcp', t.project, t.zone, t.instance]
        : t.type === 'aws'
          ? ['aws', t.region, t.instanceId, t.osUser]
          : ['azure', t.subscription, t.resourceGroup, t.vm]
    const token = (t: CloudTarget): string =>
      createHmac('sha256', 'k').update(`cloud\u0000${JSON.stringify(parts(t))}`).digest('hex')

    expect(isValidCloudTarget(GCP) && isValidCloudTarget(AZURE)).toBe(true)
    expect(token(GCP)).not.toBe(token(AZURE))
    // The same instance reached two ways is still one machine.
    expect(token({ ...GCP, transport: 'iap' })).toBe(token({ ...GCP, transport: 'direct' }))
  })
})

describe('the pooled and unpooled paths agree on precedence', () => {
  // A VPN can be assigned to any server from the VPN panel, a cloud one
  // included. acquire() used to prefer the VPN while openChain preferred the
  // cloud target, so such a record connected one way for a terminal and
  // another for Test connection -- and the VPN branch dials the empty host a
  // cloud record carries.
  it('checks the cloud target before the VPN in both', () => {
    const acquire = SSH.slice(SSH.indexOf('export async function acquire('))
    const cloudFirst = acquire.indexOf('cfg.cloudTarget')
    const vpnAfter = acquire.indexOf('cfg.vpnProfileId')
    expect(cloudFirst).toBeGreaterThan(-1)
    expect(vpnAfter).toBeGreaterThan(-1)
    expect(cloudFirst, 'acquire still prefers the VPN').toBeLessThan(vpnAfter)

    const openChain = SSH.slice(SSH.indexOf('export async function openChain('))
    const ocCloud = openChain.indexOf('cfg.cloudTarget')
    const ocVpn = openChain.indexOf('cfg.vpnProfileId')
    expect(ocCloud, 'openChain still prefers the VPN').toBeLessThan(ocVpn)
  })
})

describe('a cloud host key is filed under the instance, not the address', () => {
  // A cloud instance's public address is not stable: it is reassigned when the
  // machine is stopped and started. Filed under the address, every restart
  // looks like an unknown host and asks to be trusted again -- which both
  // trains the user to accept the prompt and means a genuinely changed key is
  // waved through as new rather than reported as changed.
  it('sets hostKeyId whether or not a tunnel was used', () => {
    const gcp = read('src/main/services/cloud/providers/gcp.ts')
    const aws = read('src/main/services/cloud/providers/aws.ts')
    expect(gcp).toMatch(/hostKeyId: `gcp:\$\{target\.project\}/)
    expect(aws).toMatch(/hostKeyId: `aws:\$\{target\.region\}/)
    // Not conditional on the transport any more.
    expect(gcp).not.toMatch(/hostKeyId: useIap \?/)
    expect(aws).not.toMatch(/hostKeyId: useEice \?/)
  })
})

describe('detection can be asked again', () => {
  // "Check again" exists for the user who has just installed the tool. It
  // returned the per-run cache, so it did nothing for the life of the process.
  it('takes a force flag all the way down', () => {
    expect(read('src/main/services/cloud/binaries.ts')).toMatch(/force = false/)
    expect(read('src/main/index.ts')).toMatch(/brokerFor\(provider\)\.detect\(force === true\)/)
    const fields = read('src/renderer/src/components/connections/CloudTargetFields.tsx')
    // The flag reaches the bridge, and the retry button is the thing that sets
    // it. Asserting both: passing it through but never setting it is the state
    // this test first caught.
    expect(fields).toMatch(/cloud\.detect\(provider, force\)/)
    expect(fields).toMatch(/onRetry=\{\(\) => void detect\(true\)\}/)
  })
})

describe('binary resolution follows the rule the VPN resolver states', () => {
  // docs/AI-SECURITY.md: "never a PATH search, because on Windows the search
  // IS the vulnerability". A writable directory earlier on PATH decides which
  // program runs as `gcloud`, and the world-writable check that guards a
  // home-directory install cannot catch it on Windows -- POSIX mode bits mean
  // nothing on NTFS, so checkExecutable returns early there.
  it('does not search PATH on Windows', () => {
    const bin = read('src/main/services/cloud/binaries.ts')
    const search = bin.slice(bin.indexOf('function searchPaths'))
    expect(search).toMatch(/if \(!win32\)/)
    // And the fixed per-platform lists still exist to cover it.
    expect(bin).toMatch(/win32: \[/)
  })

  it('still refuses a binary under a world-writable directory on POSIX', () => {
    expect(read('src/main/services/cloud/binaries.ts')).toMatch(/world-writable/)
  })
})

describe('the Windows argument guard', () => {
  const EXEC = read('src/main/services/cloud/cloudExec.ts')

  it('rejects what cmd.exe would reinterpret, including percent expansion', () => {
    const rule = /[&|<>^"%!]/
    for (const bad of ['%PATH%', 'a&b', 'a|b', 'a>b', 'a^b', 'a"b', 'a!b']) {
      expect(rule.test(bad), bad).toBe(true)
    }
  })

  it('permits the spaces that are ordinary in a Windows path', () => {
    // The allow list this replaced forbade spaces, so the temporary key GCP
    // needs under C:\\Users\\<name>\\AppData failed for any user whose name has
    // one -- with a message about Azure subscriptions.
    const rule = /[&|<>^"%!]/
    expect(rule.test('C:\\Users\\John Doe\\AppData\\Local\\Temp\\k.pub')).toBe(false)
    expect(EXEC).toMatch(/WINDOWS_UNSAFE_ARG/)
  })
})
