// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { CapacityPanel } from '../src/renderer/src/components/monitor/CapacityPanel'
import { PatchPanel } from '../src/renderer/src/components/monitor/PatchPanel'
import { CronPanel } from '../src/renderer/src/components/monitor/CronPanel'
import { sshTargetFor } from '../src/renderer/src/lib/ssh'
import { useFleet } from '../src/renderer/src/store/fleet'
import { useApp } from '../src/renderer/src/store/app'
import {
  CAPACITY_THRESHOLDS,
  buildCapacityReport,
  type CapacityReport,
  type TrendPoint
} from '../src/shared/capacity'
import {
  FACT_SOURCE_IDS,
  FACT_SOURCE_LABEL,
  type FactSourceReport,
  type HostFacts
} from '../src/shared/hostFacts'
import type { Server } from '../src/renderer/src/types'
import type { OnDemandTarget } from '../src/shared/ssh'

// The SHAPE the four on-demand host reads put on the wire.
//
// Not a rendering test. Every assertion below is about the object that reaches
// the preload bridge, because that object is precisely what broke:
//
//   The filesystems could not be read: connect ETIMEDOUT 192.168.19.7:1051
//
// on a host the background sampler was reading perfectly one panel over. The
// renderer's `Server` names its jump chain `route`; main's resolveChainSecrets
// and openChain read `hops`. The four IPC handlers take `cfg: unknown`, so
// passing the raw Server type-checked, crossed the bridge intact, and silently
// dropped the bastion — the read then dialled the private address from the
// laptop.
//
// v0.27.0 shipped HALF the fix: the handlers were wrapped in
// resolveChainSecrets + withVpnTransport, which repaired the credential and
// VPN halves and left the chain broken, because the shape being handed over
// was still a Server. That is why these tests assert on `hops` and on the
// ABSENCE of `route` rather than on anything visible: a panel that drops the
// chain renders exactly like one that does not, right up until the timeout.

const HOUR = 3_600_000
const DAY = 86_400_000
const T0 = 1_700_000_000_000

/** A bastion, named as a saved server — the case in the bug report. Main
 *  resolves the hop's credentials from that id, which it can only do if the
 *  hop survives the trip at all. */
const BASTION = {
  id: 'hop-1',
  label: 'bastion',
  host: 'bastion.example.com',
  port: 22,
  username: 'ops',
  auth: 'key' as const,
  serverId: 'srv-bastion'
}

function server(id: string, name: string, route: Server['route'] = [BASTION]): Server {
  return {
    id,
    workspaceId: 'ws-default',
    folderId: null,
    name,
    // A private address, reachable only through the hop above. Dialling it
    // directly is the failure this file guards.
    host: '192.168.19.7',
    port: 1051,
    username: 'ops',
    auth: 'key',
    status: 'online',
    tags: [],
    favorite: false,
    os: 'linux',
    route,
    vpnProfileId: null
  }
}

const ALPHA = server('srv-alpha', 'alpha')

/** What every one of these four calls must hand to main. Written out rather
 *  than compared against `sshTargetFor` alone so that a change to the builder
 *  cannot quietly redefine what "correct" means for all four call sites. */
const EXPECTED_TARGET = {
  serverId: 'srv-alpha',
  host: '192.168.19.7',
  port: 1051,
  username: 'ops',
  auth: 'key',
  hops: [
    {
      host: 'bastion.example.com',
      port: 22,
      username: 'ops',
      auth: 'key',
      serverId: 'srv-bastion',
      keyPath: undefined
    }
  ]
}

/** The assertion every case shares: a hop chain arrived, it is the one the
 *  server has, and the object is a connection target rather than the app's
 *  own `Server` record smuggled across the bridge. */
function expectCarriesChain(cfg: unknown): void {
  expect(cfg).toEqual(EXPECTED_TARGET)
  // `route` reaching main is the bug itself, not a harmless extra field: it is
  // the chain sitting in a key nothing on that side reads.
  expect(cfg).not.toHaveProperty('route')
}

// --------------------------------------------------------------- the builder

describe('sshTargetFor', () => {
  it('renames route to hops, which is the whole of this bug', () => {
    const target = sshTargetFor(ALPHA)
    expect(target.hops).toHaveLength(1)
    expect(target.hops[0].host).toBe('bastion.example.com')
    expect(target).not.toHaveProperty('route')
  })

  it('carries the hop serverId, so main can resolve that hop credential', () => {
    // Without it the hop authenticates with nothing AND changes its
    // connection-pool identity — see the note on sshHopsFor.
    expect(sshTargetFor(ALPHA).hops[0]).toHaveProperty('serverId', 'srv-bastion')
  })

  it('leaves vpnProfileId and serverName to main', () => {
    // withVpnTransport fills both from the saved record keyed on serverId.
    // Main deliberately does not trust a caller for the VPN profile, so a
    // renderer that sent one would be asserting something it is not allowed
    // to decide.
    expect(sshTargetFor(ALPHA)).not.toHaveProperty('vpnProfileId')
    expect(sshTargetFor(ALPHA)).not.toHaveProperty('serverName')
  })

  it('has no chain for a server reached directly', () => {
    expect(sshTargetFor(server('srv-direct', 'direct', [])).hops).toEqual([])
  })
})

// ------------------------------------------------------ fleet:storage

function points(count: number, step: number, value: (i: number) => number): TrendPoint[] {
  const start = T0 - (count - 1) * step
  return Array.from({ length: count }, (_, i) => ({ ts: start + i * step, v: value(i), res: 'hourly' as const }))
}

function report(): CapacityReport {
  return buildCapacityReport(
    'srv-alpha',
    { cpu: [], memPct: [], diskPct: points(145, HOUR, (i) => 64.5 + (i / 24) * 1.5) },
    {
      now: T0,
      from: T0 - 7 * DAY,
      to: T0,
      thresholds: CAPACITY_THRESHOLDS,
      fullResolutionDays: 7,
      retainedDays: 90
    }
  )
}

describe('Read filesystems (fleet:storage)', () => {
  it('sends a target carrying the jump chain, not the Server record', async () => {
    const storage = vi.fn(async (_cfg: unknown) => ({ error: 'stubbed' }))
    stubBridge({
      capacity: { trends: () => Promise.resolve(report()) },
      fleet: { storage }
    })
    render(<CapacityPanel servers={[ALPHA]} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Read filesystems' }))
    await waitFor(() => expect(storage).toHaveBeenCalled())
    expectCarriesChain(storage.mock.calls[0][0])
  })
})

// --------------------------------------------- fleet:kernel, fleet:security-list

const sources = (): FactSourceReport[] =>
  FACT_SOURCE_IDS.map((id) => ({ id, label: FACT_SOURCE_LABEL[id], status: 'ok' as const }))

const facts = (over: Partial<HostFacts> = {}): HostFacts => ({
  distroId: 'ubuntu',
  distroVersion: '24.04',
  prettyName: 'Ubuntu 24.04.1 LTS',
  arch: 'x86_64',
  cpuModel: 'AMD EPYC',
  packageManager: 'apt',
  pendingUpdates: 3,
  securityUpdates: 2,
  rebootRequired: false,
  rebootReason: null,
  virtualisation: 'kvm',
  metadataAt: T0,
  collectedAt: T0,
  sources: sources(),
  ...over
})

describe('the Patches on-demand reads', () => {
  beforeEach(() => {
    useFleet.setState({ facts: {}, errors: {} })
    useApp.setState({ databases: [] })
  })

  it('kernel sends a target carrying the jump chain', async () => {
    const kernel = vi.fn(async (_cfg: unknown) => ({ error: 'stubbed' }))
    stubBridge({ jobs: { onProgress: () => () => {}, run: vi.fn() }, fleet: { kernel } })
    useFleet.getState().reportFacts('srv-alpha', facts(), T0)
    render(<PatchPanel servers={[ALPHA]} />)
    await userEvent.click(await screen.findByRole('button', { name: 'kernel' }))
    await waitFor(() => expect(kernel).toHaveBeenCalled())
    expectCarriesChain(kernel.mock.calls[0][0])
  })

  it('the security-update list sends a target carrying the jump chain', async () => {
    const securityList = vi.fn(async (_cfg: unknown) => ({ ok: false, detail: 'stubbed' }))
    stubBridge({ jobs: { onProgress: () => () => {}, run: vi.fn() }, fleet: { securityList } })
    useFleet.getState().reportFacts('srv-alpha', facts(), T0)
    render(<PatchPanel servers={[ALPHA]} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Which packages on alpha' }))
    await waitFor(() => expect(securityList).toHaveBeenCalled())
    expectCarriesChain(securityList.mock.calls[0][0])
  })
})

// -------------------------------------------------------------- fleet:timer

describe('"did it run?" (fleet:timer)', () => {
  it('sends a target carrying the jump chain, and still names the units', async () => {
    const timer = vi.fn(async (_cfg: unknown, _t: string, _s: string) => ({ error: 'stubbed' }))
    const collect = vi.fn(async () => [
      {
        serverId: 'srv-alpha',
        serverName: 'alpha',
        unparsed: 0,
        sources: [],
        entries: [
          {
            kind: 'systemd-timer' as const,
            origin: 'certbot.timer',
            schedule: 'daily',
            description: null,
            user: null,
            command: 'certbot renew'
          }
        ]
      }
    ])
    stubBridge({ cron: { collect }, fleet: { timer } })
    render(<CronPanel servers={[ALPHA]} />)
    await userEvent.click(screen.getByRole('button', { name: /Read schedules/ }))
    await userEvent.click(await screen.findByRole('button', { name: 'did it run?' }))
    await waitFor(() => expect(timer).toHaveBeenCalled())
    expectCarriesChain(timer.mock.calls[0][0])
    // The unit arguments ride behind the config; a fix that moved the target
    // into the wrong position would still "carry hops" somewhere.
    expect(timer.mock.calls[0].slice(1)).toEqual(['certbot.timer', 'certbot.service'])
  })
})

// ---------------------------------------------------------------------------
// The compile-time half.
//
// Every test above asserts the VALUE reaching the bridge. This asserts the
// TYPE, because the value tests only cover the call sites someone remembered to
// write a test for — and the bug was four call sites nobody had.
//
// `@ts-expect-error` fails the build if the error stops happening, so this is
// the assertion that a raw Server can never be passed again. It works because
// SshAuth is 'password' | 'key' | 'agent' while the renderer's AuthMethod also
// carries 'certificate', so a Server is not assignable to OnDemandTarget.
// ---------------------------------------------------------------------------
describe('the type that makes the mistake impossible', () => {
  it('refuses a raw Server where an on-demand target is required', () => {
    const server: Server = {
      id: 's', workspaceId: 'w', name: 'n', host: 'h', port: 22, username: 'u',
      auth: 'key', route: [], color: 'blue', tags: []
    } as unknown as Server
    const accept = (_t: OnDemandTarget): void => undefined
    // @ts-expect-error a Server carries `route`, not `hops` — this is the bug
    accept(server)
    // …and the built target is accepted.
    accept(sshTargetFor(server))
    expect(true).toBe(true)
  })
})
