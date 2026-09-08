import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { toDiagnose } from '../src/main/services/vpn/drivers/wireguard'
import type { VpnDiagnoseCheck, VpnDiagnoseResult } from '../src/shared/vpn'

// The parent's half of the connectivity checklist.
//
// The PROBE is tested in `sidecar/netd/diagnose_test.go`, against two real
// wireguard-go devices with a DNS server and an echo service living inside the
// far netstack -- there is no way to fake a handshake, so it is not faked. What
// is under test HERE is the narrowing: which of the sidecar's rows are allowed
// through, and what this side refuses to render.

const src = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')

const reply = (over: Record<string, unknown> = {}): Parameters<typeof toDiagnose>[1] =>
  ({
    tunnelId: 't1',
    checks: [
      { name: 'handshake', status: 'ok', detail: 'the peer completed a handshake recently', elapsed: 12 },
      { name: 'dns', status: 'skipped', detail: 'the target is already an address' },
      { name: 'tcp', status: 'ok', detail: 'a TCP connection was accepted', elapsed: 41 }
    ],
    latencyMs: 41,
    sampledAt: 1_700_000_000_000,
    ...over
  }) as Parameters<typeof toDiagnose>[1]

const by = (r: VpnDiagnoseResult, n: string): VpnDiagnoseCheck | undefined =>
  r.checks.find((c) => c.name === n)

describe('narrowing the sidecar’s checklist', () => {
  it('carries every row through with its own sentence', () => {
    const r = toDiagnose('t1', reply())
    expect(r.checks).toHaveLength(3)
    for (const c of r.checks) expect(c.detail).not.toBe('')
  })

  // The renderer switches on the status to pick a colour. A word it has no case
  // for renders as neither pass nor fail, which is the one outcome a checklist
  // may not have.
  it('drops a status outside the vocabulary rather than passing it on', () => {
    const r = toDiagnose(
      't1',
      reply({ checks: [{ name: 'tcp', status: 'probably-fine', detail: 'x' }] })
    )
    expect(r.checks).toEqual([])
  })

  it('drops a check name this side has no row for', () => {
    const r = toDiagnose('t1', reply({ checks: [{ name: 'mtu', status: 'ok', detail: 'x' }] }))
    expect(r.checks).toEqual([])
  })

  // Absent and zero are different answers: nothing was timed, against something
  // that took no time.
  it('leaves elapsed absent rather than zero when nothing was timed', () => {
    const r = toDiagnose('t1', reply({ checks: [{ name: 'dns', status: 'skipped', detail: 'x' }] }))
    expect('elapsed' in r.checks[0]).toBe(false)
  })

  it('keeps a real zero elapsed apart from a missing one', () => {
    const r = toDiagnose(
      't1',
      reply({ checks: [{ name: 'tcp', status: 'ok', detail: 'x', elapsed: 0 }] })
    )
    expect(r.checks[0].elapsed).toBe(0)
  })

  it('keeps the skip reason, because a skip without one is a tick over an unasked question', () => {
    const r = toDiagnose('t1', reply())
    expect(by(r, 'dns')?.status).toBe('skipped')
    expect(by(r, 'dns')?.detail).toContain('already an address')
  })
})

describe('the latency', () => {
  it('is carried when a connect succeeded', () => {
    expect(toDiagnose('t1', reply()).latencyMs).toBe(41)
  })

  // A latency of nothing and a latency nobody measured are different, and the
  // second one must not render as a fast connection.
  it('is absent rather than zero when no connect succeeded', () => {
    expect('latencyMs' in toDiagnose('t1', reply({ latencyMs: 0 }))).toBe(false)
    expect('latencyMs' in toDiagnose('t1', reply({ latencyMs: undefined }))).toBe(false)
  })

  it('is named for what was measured rather than called a ping', () => {
    const go = src('../sidecar/netd/diagnose.go')
    expect(go).toContain('NOT A PING')
    // Nothing in the probe shells out to the host's own ping.
    expect(go).not.toMatch(/exec\.Command|"ping"/)
  })
})

describe('what the agent cannot reach', () => {
  // The target is an arbitrary host and port. An agent able to call this
  // repeatedly would have a port scanner pointed through the operator's VPN,
  // which is a different tool from the one `list_vpns` describes.
  it('registers no MCP tool that probes a tunnel', () => {
    const mcp = src('../src/main/services/mcpServer.ts')
    // Scoped to the two things that would make it reachable -- the channel and
    // the function. A bare search for the word matches the prose in that file
    // explaining why an agent is not the one who diagnoses a host, which is the
    // opposite of a violation.
    expect(mcp).not.toContain('vpn:diagnose')
    expect(mcp).not.toMatch(/\bvpnDiagnose\b/)
  })

  it('is a renderer channel, and says why in the file that registers it', () => {
    const main = src('../src/main/index.ts')
    expect(main).toContain("ipcMain.handle('vpn:diagnose'")
    expect(main).toContain('port scanner')
  })
})

describe('a driver that cannot be probed', () => {
  // An empty checklist and "everything passed" render the same. The refusal is
  // a sentence for exactly that reason.
  it('is reported in words by the manager rather than as an empty result', () => {
    const mgr = src('../src/main/services/vpn/manager.ts')
    expect(mgr).toContain('if (!driver.diagnose)')
    expect(mgr).toContain('unsupported')
    expect(mgr).toContain('measures a different route')
  })

  it('says a stopped profile was not asked, rather than blaming the far side', () => {
    const mgr = src('../src/main/services/vpn/manager.ts')
    expect(mgr).toContain('is not running, so nothing was sent')
  })
})
