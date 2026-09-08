// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, waitFor } from '@testing-library/react'
import { stubBridge } from './setup/renderer'
import { PosturePanel } from '../src/renderer/src/components/monitor/PosturePanel'
import { DriftPanel } from '../src/renderer/src/components/monitor/DriftPanel'
import type { Server } from '../src/renderer/src/types'

/**
 * "This machine" in the two panels the fleet sweep feeds.
 *
 * Posture and drift are the only local targets that do NOT go through the
 * sampler, and that is the thing worth pinning. The sweep persists what it
 * finds — posture facts and per-file drift hashes into the durable history
 * store, keyed by host — and this machine's firewall state and configuration
 * hashes do not belong in the estate's permanent record. It is also one
 * `fleetCached(id)` lookup from the MCP bridge, and an entry that does not
 * exist is a stronger guarantee than an id that happens not to resolve.
 *
 * So the local row is read on demand, through a handler that takes no target
 * at all.
 */

const SERVER: Server = {
  id: 'srv-a',
  workspaceId: 'ws-default',
  folderId: null,
  name: 'alpha',
  host: 'alpha.example.internal',
  port: 22,
  username: 'ops',
  auth: 'key',
  status: 'online',
  tags: [],
  favorite: false,
  os: 'linux',
  route: [],
  vpnProfileId: null
}


/** A collection that succeeded but found nothing notable. */
const POSTURE = {
  firewall: null,
  mandatoryAccess: { kind: 'none' as const },
  sshd: null,
  failedLogins: null,
  oomKills: null,
  certificates: null,
  errorRate: null,
  collectedAt: Date.now(),
  sources: []
}

describe('security posture, on this machine', () => {
  it('reads it on demand and shows it as a row', async () => {
    const postureLocal = vi.fn(async () => ({ ok: true as const, posture: POSTURE }))
    // The sampler's cached reads answer for the SERVER, and must not be asked
    // about this machine.
    const posture = vi.fn(async () => ({ intervalMs: 3_600_000 }))
    stubBridge({ fleet: { posture, postureLocal, facts: vi.fn(async () => ({ intervalMs: 0 })) } })

    render(<PosturePanel servers={[SERVER]} />)

    await waitFor(() => expect(postureLocal).toHaveBeenCalled())
    expect(await screen.findByText('This machine')).toBeTruthy()
    // Taken now, and taken without a target: a handler that accepted a
    // connection config would be a second way to probe a server outside the
    // sampler's cadence.
    expect(postureLocal.mock.calls[0]).toEqual([])
    // The estate still comes from the sweep.
    expect(posture).toHaveBeenCalledWith(SERVER.id)
  })

  // The word matters because one of the rows is not a server, and
  // summarisePosture has always counted "hosts".
  it('counts hosts rather than servers', async () => {
    stubBridge({
      fleet: {
        posture: vi.fn(async () => ({ intervalMs: 0 })),
        postureLocal: vi.fn(async () => ({ ok: true as const, posture: POSTURE })),
        facts: vi.fn(async () => ({ intervalMs: 0 }))
      }
    })
    render(<PosturePanel servers={[SERVER]} />)
    expect(await screen.findByText(/2 hosts/)).toBeTruthy()
  })

  // A local read that failed is a gap, not an absence, and the row has to say
  // so beside the servers that answered — the same rule the panel already
  // applies to a server whose collection failed.
  it('still shows the row when the local read failed', async () => {
    stubBridge({
      fleet: {
        // One server HAS a posture, so the table renders rather than the
        // "nothing collected anywhere" empty state.
        posture: vi.fn(async () => ({ posture: POSTURE, at: Date.now(), intervalMs: 0 })),
        postureLocal: vi.fn(async () => ({
          ok: false as const,
          reason: 'no-tool',
          detail: 'this machine has no firewall tool'
        })),
        facts: vi.fn(async () => ({ intervalMs: 0 }))
      }
    })
    render(<PosturePanel servers={[SERVER]} />)
    expect(await screen.findByText('This machine')).toBeTruthy()
  })
})

describe('configuration drift, on this machine', () => {
  it('reads it on demand and includes it in the comparison', async () => {
    const driftLocal = vi.fn(async () => ({
      ok: true as const,
      drift: { at: Date.now(), readings: [] }
    }))
    const drift = vi.fn(async () => ({ intervalMs: 3_600_000 }))
    stubBridge({ fleet: { drift, driftLocal } })

    render(<DriftPanel servers={[SERVER]} />)

    await waitFor(() => expect(driftLocal).toHaveBeenCalled())
    expect(await screen.findByText('This machine')).toBeTruthy()
    expect(drift).toHaveBeenCalledWith(SERVER.id)
  })
})

describe('what the local reads are wired to', () => {
  const main = readFileSync(join(__dirname, '..', 'src/main/index.ts'), 'utf8')

  /**
   * The handlers take no target, and that is the whole guarantee.
   *
   * `fleet:posture` and `fleet:drift` are cache reads precisely because one
   * thing decides how often a host is asked for its firewall ruleset, and it is
   * the sampler. A handler that accepted a connection config would quietly be a
   * second one. Taking nothing makes that structural instead of a rule someone
   * has to remember.
   */
  it('cannot be pointed at a server', () => {
    expect(main).toMatch(/ipcMain\.handle\('fleet:posture-local', \(\) =>/)
    // Drift takes only a normalisation context — names for substitution, never
    // a target.
    expect(main).toMatch(/ipcMain\.handle\('fleet:drift-local', \(_e, ctx: unknown\) =>/)
    expect(main).not.toMatch(/fleet:posture-local'[\s\S]{0,200}resolveChainSecrets/)
  })

  it('reads this machine, not a config the renderer supplied', () => {
    const block = main.slice(
      main.indexOf("ipcMain.handle('fleet:posture-local'"),
      main.indexOf("ipcMain.handle('fleet:drift-local'") + 300
    )
    expect(block).toMatch(/postureReader\.read\(LOCAL_TARGET/)
    expect(block).toMatch(/driftReader\.read\(LOCAL_TARGET/)
  })

  /**
   * Firewall rules fail closed. The grant is an AI-access capability and this
   * machine has no access group to carry one, so the rules are not collected
   * rather than collected by default — the same direction a server with no
   * group is wrong in.
   */
  it('does not collect firewall rules without a grant', () => {
    const block = main.slice(
      main.indexOf("ipcMain.handle('fleet:posture-local'"),
      main.indexOf("ipcMain.handle('fleet:drift-local'")
    )
    expect(block).toMatch(/firewallRules: false/)
  })
})
