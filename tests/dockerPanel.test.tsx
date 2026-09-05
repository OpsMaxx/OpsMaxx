// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { useFleet } from '../src/renderer/src/store/fleet'
import { DockerPanel } from '../src/renderer/src/components/docker/DockerPanel'
import type {
  DockerDiskDetailProbe,
  DockerDiskProbe,
  DockerProbe,
  DockerReclaimItem,
  DockerReclaimResult
} from '../src/shared/docker'
import type { Server } from '../src/renderer/src/types'

// The two defects that shipped out of the itemised disk view, rendered rather
// than read.
//
// Both were found by review, not by a test, because there was no way to run a
// component at all — the existing docker panel suites `readFileSync` the .tsx
// and assert regexes against the source, which can see that a generation
// counter is mentioned and cannot see whether it is consulted before the
// setState that matters.
//
//  1. A `diskDetail` read still in flight when the operator changes server
//     landed under the NEW server's heading: one host's image, volume and
//     container names presented as another host's. That is a cross-server data
//     leak, and the itemise button hides itself once a listing exists, so there
//     was no way to notice or correct it on screen.
//
//  2. A FAILED itemise read was a dead end. The button gated on
//     `diskItems === null`, so the most likely failure — an SSH timeout, and
//     the most transient one — removed the only control that could retry it.
//
// Both fixes are in DockerPanel.tsx today. These tests fail if either is
// reverted; see docs/plans/roadmap-execution.md for the proof.

function server(id: string, name: string): Server {
  return {
    id,
    workspaceId: 'ws-default',
    folderId: null,
    name,
    host: `${id}.example.internal`,
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
}

const ALPHA = server('srv-alpha', 'alpha')
const BRAVO = server('srv-bravo', 'bravo')

function listing(prefix: string): DockerProbe {
  return {
    ok: true,
    version: '24.0.7',
    composeLabels: 'read',
    containers: [
      {
        id: `${prefix}0123456789ab`,
        shortId: `${prefix}012345`,
        name: `${prefix}-api`,
        image: `${prefix}/api:latest`,
        state: 'running',
        status: 'Up 3 hours',
        ports: '',
        createdAt: '2026-01-01 00:00:00 +0000 UTC'
      }
    ]
  }
}

const DISK: DockerDiskProbe = {
  ok: true,
  rows: [
    {
      type: 'Images',
      total: 4,
      active: 2,
      size: '2.0GB',
      sizeBytes: 2_000_000_000,
      reclaimable: '1.0GB',
      reclaimableBytes: 1_000_000_000,
      reclaimablePercent: 50
    }
  ]
}

/** An itemised listing whose image name says which host it came from. That
 *  name is the whole assertion: it must never appear under the other host. */
function detail(prefix: string): DockerDiskDetailProbe {
  return {
    ok: true,
    engine: null,
    disk: {
      images: [
        {
          repository: `${prefix}-only/leaked-image`,
          tag: 'v1',
          id: `${prefix}aaa111`,
          created: '3 weeks ago',
          size: '1.2GB',
          sizeBytes: 1_200_000_000,
          sharedSize: '0B',
          sharedSizeBytes: 0,
          uniqueSize: '1.2GB',
          uniqueSizeBytes: 1_200_000_000,
          containers: 0,
          dangling: false
        }
      ],
      containers: [],
      volumes: [],
      buildCache: [],
      sections: { images: true, containers: true, volumes: true, buildCache: true },
      unreadable: 0
    }
  }
}

interface Cfg {
  serverId: string
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Reassigned per phase of a test, so a read can be left in the air. */
let diskDetailImpl: (cfg: Cfg) => Promise<DockerDiskDetailProbe>

beforeEach(() => {
  diskDetailImpl = (cfg) => Promise.resolve(detail(cfg.serverId.replace('srv-', '')))
  stubBridge({
    docker: {
      list: (cfg: Cfg) => Promise.resolve(listing(cfg.serverId.replace('srv-', ''))),
      disk: () => Promise.resolve(DISK),
      diskDetail: (cfg: Cfg) => diskDetailImpl(cfg)
    }
  })
})

const btn = (name: RegExp): HTMLElement => screen.getByRole('button', { name })

/** Read containers, then open the disk card. Every itemise assertion needs
 *  both: the itemise control only exists inside a successful disk card. */
async function openDiskCard(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(btn(/Read containers/))
  await screen.findByText(/Disk usage/)
  await user.click(btn(/Disk usage/))
  await screen.findByText(/reclaimable/)
}

describe('DockerPanel — itemised disk view', () => {
  it('renders the itemised listing for the server that asked for it', async () => {
    const user = userEvent.setup()
    render(<DockerPanel servers={[ALPHA, BRAVO]} />)
    await openDiskCard(user)

    await user.click(btn(/Itemise/))

    await waitFor(() => {
      expect(document.body.textContent).toContain('alpha-only/leaked-image')
    })
  })

  // The leak. This is the test that would have caught it.
  it('drops a diskDetail read that lands after the operator changed server', async () => {
    const user = userEvent.setup()
    render(<DockerPanel servers={[ALPHA, BRAVO]} />)
    await openDiskCard(user)

    // Alpha's itemise goes out and stays out. `docker system df -v` walks every
    // image and volume on the host and is allowed sixty seconds, so this window
    // is not hypothetical.
    const inFlight = deferred<DockerDiskDetailProbe>()
    diskDetailImpl = () => inFlight.promise
    await user.click(btn(/Itemise/))

    // The operator moves on.
    await user.selectOptions(screen.getByRole('combobox'), 'srv-bravo')
    diskDetailImpl = (cfg) => Promise.resolve(detail(cfg.serverId.replace('srv-', '')))
    await openDiskCard(user)
    expect(document.body.textContent).toContain('bravo-api')

    // ...and alpha's answer finally arrives.
    await act(async () => {
      inFlight.resolve(detail('alpha'))
    })

    expect(document.body.textContent).not.toContain('alpha-only/leaked-image')
    // Not merely invisible: no listing was adopted at all, so the control that
    // offers one is still the first-time "Itemise" rather than "Try again".
    expect(btn(/Itemise/)).toBeTruthy()
  })

  // The dead end. A failed read must leave a way out.
  it('offers "Try again" after a failed itemise read, and it works', async () => {
    const user = userEvent.setup()
    render(<DockerPanel servers={[ALPHA, BRAVO]} />)
    await openDiskCard(user)

    diskDetailImpl = () =>
      Promise.resolve({
        ok: false,
        reason: 'unknown',
        detail: 'ssh: connection timed out after 60s'
      })
    await user.click(btn(/Itemise/))
    await screen.findByText(/connection timed out/)

    // The way out exists...
    const retry = btn(/Try again/)
    expect(retry.hasAttribute('disabled')).toBe(false)

    // ...and it is a real retry, not a label.
    diskDetailImpl = (cfg) => Promise.resolve(detail(cfg.serverId.replace('srv-', '')))
    await user.click(retry)

    await waitFor(() => {
      expect(document.body.textContent).toContain('alpha-only/leaked-image')
    })
    expect(document.body.textContent).not.toContain('connection timed out')
  })
})

// ---------------------------------------------------------------------------
// Reclaim by id — roadmap 21b
// ---------------------------------------------------------------------------
//
// These render the thing, because the claims 21b makes are claims about a UI:
// "nothing is pre-selected", "there is no select-all", "a volume with links is
// never offered", "the disk is read again before anything runs and the removal
// is abandoned if it disagrees". Not one of those is visible to a parser test,
// and the last one is a sequence — read, compare, refuse — that only a rendered
// click can walk.

/** A host with something of every kind, including the ones that must NOT be offered. */
function reclaimable(): DockerDiskDetailProbe {
  return {
    ok: true,
    engine: null,
    disk: {
      images: [
        {
          repository: '<none>',
          tag: '<none>',
          id: 'cfa60c5d01ea',
          created: '3 weeks ago',
          size: '1.2GB',
          sizeBytes: 1_200_000_000,
          sharedSize: '0B',
          sharedSizeBytes: 0,
          uniqueSize: '1.2GB',
          uniqueSizeBytes: 1_200_000_000,
          containers: 0,
          dangling: true
        },
        {
          repository: 'postgres',
          tag: '16-alpine',
          id: 'c05eced0bdb4',
          created: '2 weeks ago',
          size: '288MB',
          sizeBytes: 288_000_000,
          sharedSize: '8.658MB',
          sharedSizeBytes: 8_658_000,
          uniqueSize: '279.5MB',
          uniqueSizeBytes: 279_500_000,
          containers: 1,
          dangling: false
        }
      ],
      containers: [
        {
          id: '9b2c7e4d1a08',
          image: 'app-frontend:latest',
          command: '"npm run start"',
          localVolumes: 0,
          size: '412MB',
          sizeBytes: 412_000_000,
          created: '3 days ago',
          status: 'Exited (137) 2 days ago',
          state: 'exited',
          name: 'old-frontend'
        },
        {
          id: 'aaaaaaaaaaaa',
          image: 'redis:7',
          command: '"redis-server"',
          localVolumes: 0,
          size: '1kB',
          sizeBytes: 1000,
          created: '3 days ago',
          status: 'Up 3 days (Paused)',
          state: 'paused',
          name: 'held-open'
        }
      ],
      volumes: [
        { name: 'stack_pgdata', links: 0, size: '2.41GB', sizeBytes: 2_410_000_000, anonymous: false },
        { name: 'busy_cache', links: 1, size: '1.386GB', sizeBytes: 1_386_000_000, anonymous: false }
      ],
      buildCache: [],
      sections: { images: true, containers: true, volumes: true, buildCache: true },
      unreadable: 0
    }
  }
}

/** The same host, minus one selected volume's eligibility: something linked it. */
function volumeNowBusy(): DockerDiskDetailProbe {
  const d = reclaimable()
  if (!d.ok) throw new Error('unreachable')
  d.disk.volumes = [
    { name: 'stack_pgdata', links: 1, size: '2.41GB', sizeBytes: 2_410_000_000, anonymous: false },
    { name: 'busy_cache', links: 1, size: '1.386GB', sizeBytes: 1_386_000_000, anonymous: false }
  ]
  return d
}

const boxes = (): HTMLInputElement[] =>
  Array.from(document.querySelectorAll('input[type="checkbox"]'))

const boxFor = (label: RegExp): HTMLInputElement => {
  const found = boxes().find((b) => label.test(b.getAttribute('aria-label') ?? ''))
  if (!found) throw new Error(`no checkbox for ${label}`)
  return found
}

async function openItems(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await openDiskCard(user)
  await user.click(btn(/Itemise/))
  await screen.findByText(/old-frontend/)
}

describe('DockerPanel — reclaim by id', () => {
  it('pre-selects nothing and offers no select-all', async () => {
    // The rule `shared/docker.ts` states for lifecycle and this inherits:
    // targets are explicit. A select-all box is `prune` reached by a click
    // instead of a flag, so its absence is the feature.
    const user = userEvent.setup()
    diskDetailImpl = () => Promise.resolve(reclaimable())
    render(<DockerPanel servers={[ALPHA]} />)
    await openItems(user)

    expect(boxes().length).toBeGreaterThan(0)
    expect(boxes().every((b) => !b.checked)).toBe(true)
    // No control that ticks the lot, under any of its usual names.
    expect(document.body.textContent ?? '').not.toMatch(/select all|all of them|everything/i)
    for (const b of boxes()) {
      expect(b.getAttribute('aria-label') ?? '').not.toMatch(/\ball\b/i)
    }
    // And the button that would act on a selection is dead until there is one.
    expect(btn(/Remove selected/).hasAttribute('disabled')).toBe(true)
  })

  it('gives no checkbox to a linked volume or a paused container', async () => {
    const user = userEvent.setup()
    diskDetailImpl = () => Promise.resolve(reclaimable())
    render(<DockerPanel servers={[ALPHA]} />)
    await openItems(user)

    const labels = boxes().map((b) => b.getAttribute('aria-label') ?? '')
    // Both rows are on screen — they are the biggest things on this host and
    // hiding them would be worse than not offering them...
    expect(document.body.textContent).toContain('busy_cache')
    expect(document.body.textContent).toContain('held-open')
    // ...but neither can be ticked, and neither can `postgres:16-alpine`,
    // which a container still references.
    expect(labels.join(' ')).not.toContain('busy_cache')
    expect(labels.join(' ')).not.toContain('held-open')
    expect(labels.join(' ')).not.toContain('postgres:16-alpine')
    expect(labels.join(' ')).toContain('stack_pgdata')
  })

  it('refuses, and removes nothing, when the re-read disagrees with the list', async () => {
    // THE test. Something linked `stack_pgdata` between the operator ticking
    // it and confirming. A build that skipped the re-read passes every parser
    // test in the repository and deletes a live database here.
    const user = userEvent.setup()
    let reclaimCalls = 0
    let reads = 0
    diskDetailImpl = () => {
      reads++
      return Promise.resolve(reads === 1 ? reclaimable() : volumeNowBusy())
    }
    stubBridge({
      docker: {
        list: (cfg: Cfg) => Promise.resolve(listing(cfg.serverId.replace('srv-', ''))),
        disk: () => Promise.resolve(DISK),
        diskDetail: (cfg: Cfg) => diskDetailImpl(cfg),
        reclaim: (): Promise<DockerReclaimResult> => {
          reclaimCalls++
          return Promise.resolve({ ok: true, outcomes: [], unattributed: [] })
        }
      }
    })
    render(<DockerPanel servers={[ALPHA]} />)
    await openItems(user)

    await user.click(boxFor(/stack_pgdata/))
    await user.click(btn(/Remove 1 selected/))
    // A volume is typed-confirm on its own, whatever the count.
    await screen.findByPlaceholderText(/Type REMOVE to continue/)
    await user.type(screen.getByPlaceholderText(/Type REMOVE to continue/), 'REMOVE')
    await user.click(btn(/^Remove$/))

    await screen.findByText(/This server is not what the list said it was/)
    expect(document.body.textContent).toContain('1 container linked to it')
    expect(reclaimCalls).toBe(0)
  })

  it('removes exactly the ticked ids when the re-read agrees', async () => {
    const user = userEvent.setup()
    let sent: DockerReclaimItem[] | null = null
    diskDetailImpl = () => Promise.resolve(reclaimable())
    stubBridge({
      docker: {
        list: (cfg: Cfg) => Promise.resolve(listing(cfg.serverId.replace('srv-', ''))),
        disk: () => Promise.resolve(DISK),
        diskDetail: (cfg: Cfg) => diskDetailImpl(cfg),
        reclaim: (_cfg: Cfg, items: DockerReclaimItem[]): Promise<DockerReclaimResult> => {
          sent = items
          return Promise.resolve({
            ok: true,
            outcomes: items.map((i) => ({ item: i, ok: true })),
            unattributed: []
          })
        }
      }
    })
    render(<DockerPanel servers={[ALPHA]} />)
    await openItems(user)

    await user.click(boxFor(/old-frontend/))
    await user.click(btn(/Remove 1 selected/))
    // No volume in this selection, so a plain confirm — the risk is shaped by
    // what is going, not by how many.
    expect(screen.queryByPlaceholderText(/Type REMOVE/)).toBeNull()
    await user.click(btn(/^Remove$/))

    await waitFor(() => expect(sent).not.toBeNull())
    expect(sent).toEqual([
      expect.objectContaining({ kind: 'container', id: '9b2c7e4d1a08', label: 'old-frontend' })
    ])
    await screen.findByText(/Removed 1 of 1/)
  })

  it('removes nothing when the disk cannot be re-read at all', async () => {
    // "The check failed, so we went ahead on the old list" is precisely the
    // sentence this step exists to make impossible.
    const user = userEvent.setup()
    let reclaimCalls = 0
    let reads = 0
    diskDetailImpl = () => {
      reads++
      return reads === 1
        ? Promise.resolve(reclaimable())
        : Promise.resolve({ ok: false as const, reason: 'unknown' as const, detail: 'ssh: connection timed out' })
    }
    stubBridge({
      docker: {
        list: (cfg: Cfg) => Promise.resolve(listing(cfg.serverId.replace('srv-', ''))),
        disk: () => Promise.resolve(DISK),
        diskDetail: (cfg: Cfg) => diskDetailImpl(cfg),
        reclaim: (): Promise<DockerReclaimResult> => {
          reclaimCalls++
          return Promise.resolve({ ok: true, outcomes: [], unattributed: [] })
        }
      }
    })
    render(<DockerPanel servers={[ALPHA]} />)
    await openItems(user)

    await user.click(boxFor(/old-frontend/))
    await user.click(btn(/Remove 1 selected/))
    await user.click(btn(/^Remove$/))

    await screen.findByText(/Nothing was removed: the disk could not be read again/)
    expect(reclaimCalls).toBe(0)
  })

  it('shows no byte total for the selection, because the rows do not add up', async () => {
    // Image SIZE counts layers shared with other images. "3.6GB selected" is a
    // number this app would have invented, and it looks right in any fixture.
    const user = userEvent.setup()
    diskDetailImpl = () => Promise.resolve(reclaimable())
    render(<DockerPanel servers={[ALPHA]} />)
    await openItems(user)
    await user.click(boxFor(/stack_pgdata/))
    await user.click(boxFor(/<none>:<none>/))

    expect(btn(/Remove 2 selected/)).toBeTruthy()
    // 2.41GB + 1.2GB. Neither the sum nor any rounding of it appears.
    for (const invented of ['3.61GB', '3.6GB', '3.61', '3610000000']) {
      expect(document.body.textContent).not.toContain(invented)
    }
  })
})

// ---------------------------------------------------------------------------
// Healthchecks, worst first. Item 42's row, rendered.
// ---------------------------------------------------------------------------

const HEALTH_LOGS = {
  ok: true as const,
  logs: [
    {
      container: 'alpha-good',
      status: 'healthy',
      failingStreak: 0,
      entries: [{ start: '2026-09-05T20:14:09Z', end: '2026-09-05T20:14:09Z', exitCode: 0, output: 'ok\n' }],
      sampled: false
    },
    {
      // Measured shape: inside a start period, every check failing, status
      // still the hopeful word and the streak still zero.
      container: 'alpha-slowstart',
      status: 'starting',
      failingStreak: 0,
      entries: [{ start: '2026-09-05T20:14:11Z', end: '2026-09-05T20:14:11Z', exitCode: 1, output: '' }],
      sampled: false
    },
    {
      container: 'alpha-plain',
      status: null,
      failingStreak: null,
      entries: [],
      sampled: false
    },
    {
      container: 'alpha-sick',
      status: 'unhealthy',
      failingStreak: 24,
      entries: [
        {
          start: '2026-09-05T20:14:03Z',
          end: '2026-09-05T20:14:03Z',
          exitCode: 1,
          output: 'probing https://user:[REDACTED]@api.example.com/health?token=[REDACTED]\n'
        }
      ],
      sampled: true
    }
  ]
}

describe('DockerPanel — healthchecks', () => {
  const openHealth = async (
    user: ReturnType<typeof userEvent.setup>,
    probe: unknown = HEALTH_LOGS
  ): Promise<{ calls: unknown[][] }> => {
    const calls: unknown[][] = []
    stubBridge({
      docker: {
        list: (cfg: Cfg) => {
          // A STOPPED container alongside the running one. Without it the
          // running-only filter is unfalsifiable, and a stopped container's
          // health is whatever it was when it stopped.
          const base = listing(cfg.serverId.replace('srv-', ''))
          if (!base.ok) return Promise.resolve(base)
          return Promise.resolve({
            ...base,
            containers: [
              ...base.containers,
              { ...base.containers[0], id: 'stopped01234', shortId: 'stopped0', name: 'alpha-old', state: 'exited', status: 'Exited (0) 2 days ago' }
            ]
          })
        },
        disk: () => Promise.resolve(DISK),
        diskDetail: (cfg: Cfg) => diskDetailImpl(cfg),
        healthLogs: (...args: unknown[]) => {
          calls.push(args)
          return Promise.resolve(probe)
        }
      }
    })
    render(<DockerPanel servers={[ALPHA, BRAVO]} />)
    await user.click(btn(/Read containers/))
    await screen.findByText(/Read healthchecks/)
    await user.click(btn(/Read healthchecks/))
    return { calls }
  }

  it('reads healthchecks only when asked, and only for running containers', async () => {
    const user = userEvent.setup()
    const { calls } = await openHealth(user)
    await waitFor(() => expect(calls.length).toBe(1))
    // A stopped container's health is whatever it was when it stopped; shown
    // beside live answers it reads as current.
    expect(calls[0][1]).toEqual(['alpha0123456789ab'])
  })

  it('puts the unhealthy first and the failing starter above the healthy one', async () => {
    const user = userEvent.setup()
    await openHealth(user)
    await screen.findByText(/is unhealthy/)
    const order = ['alpha-sick', 'alpha-slowstart', 'alpha-good', 'alpha-plain']
    const positions = order.map((n) => document.body.textContent!.indexOf(n))
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(positions.every((p) => p >= 0)).toBe(true)
  })

  it('says the start period is hiding a container that has never passed', async () => {
    const user = userEvent.setup()
    await openHealth(user)
    await screen.findByText(/start period is hiding that/)
  })

  it('says how long the streak is and that the log is only part of it', async () => {
    const user = userEvent.setup()
    await openHealth(user)
    await screen.findByText(/failed 24 checks in a row/)
    expect(screen.getByText(/keeps only the last 1/)).toBeTruthy()
  })

  it('does not call a container with no healthcheck healthy', async () => {
    const user = userEvent.setup()
    await openHealth(user)
    await screen.findByText(/no healthcheck, so nothing is checking it/)
    expect(screen.getByText('no healthcheck')).toBeTruthy()
  })

  it('says a silent check printed nothing rather than showing an empty cell', async () => {
    const user = userEvent.setup()
    await openHealth(user)
    await screen.findByText('printed nothing')
  })

  it('shows what main redacted, and never a secret', async () => {
    const user = userEvent.setup()
    await openHealth(user)
    await screen.findByText(/is unhealthy/)
    expect(document.body.textContent).toContain('[REDACTED]')
    expect(document.body.textContent).not.toContain('s3cr3t')
  })

  it('reports a failed read instead of an empty list', async () => {
    const user = userEvent.setup()
    await openHealth(user, { ok: false, reason: 'no-docker', detail: 'docker: command not found' })
    await screen.findByText(/docker: command not found/)
  })
})

// ---------------------------------------------------------------------------
// Networks in the reclaim preview. `system df -v` lists none, so they come from
// their own read and meet the disk listing in `mergeNetworks`.
// ---------------------------------------------------------------------------

const NETWORKS = {
  ok: true as const,
  networks: [
    { id: 'e742a9db8c51', name: 'bridge', driver: 'bridge', scope: 'local' },
    { id: '1a48ad199a4f', name: 'sp-orphan', driver: 'bridge', scope: 'local' },
    { id: '9330583d766b', name: 'sp-free', driver: 'bridge', scope: 'local' }
  ],
  use: [
    // Stopped, and still holding sp-orphan. This is the case the whole module
    // exists for: `docker network inspect` would report zero here.
    { containerId: '2eaf0cebaa73', name: 'alpha-old', state: 'exited', networks: ['sp-orphan'] }
  ]
}

describe('DockerPanel — networks in the preview', () => {
  const itemiseWith = async (
    user: ReturnType<typeof userEvent.setup>,
    nets: unknown = NETWORKS
  ): Promise<void> => {
    stubBridge({
      docker: {
        list: (cfg: Cfg) => Promise.resolve(listing(cfg.serverId.replace('srv-', ''))),
        disk: () => Promise.resolve(DISK),
        diskDetail: (cfg: Cfg) => diskDetailImpl(cfg),
        networks: () => Promise.resolve(nets)
      }
    })
    render(<DockerPanel servers={[ALPHA, BRAVO]} />)
    await openDiskCard(user)
    await user.click(btn(/Itemise/))
  }

  it('offers the network nothing is attached to', async () => {
    const user = userEvent.setup()
    await itemiseWith(user)
    await waitFor(() => expect(document.body.textContent).toContain('sp-free'))
  })

  it('does not offer one a STOPPED container is still on', async () => {
    const user = userEvent.setup()
    await itemiseWith(user)
    await waitFor(() => expect(screen.getByText('sp-free')).toBeTruthy())
    // Listed, with the reason -- what it must never be is offered.
    expect(document.body.textContent).toContain('sp-orphan')
    expect(document.body.textContent).toContain('stopped and still attached')
    expect(screen.queryByLabelText(/sp-orphan/)).toBeNull()
    // ...while the free one IS selectable.
    expect(screen.getByLabelText(/sp-free/)).toBeTruthy()
  })

  it('says networks were not read rather than showing a complete-looking list', async () => {
    const user = userEvent.setup()
    await itemiseWith(user, { ok: false, reason: 'no-docker', detail: 'network ls exploded' })
    // A silently network-free preview is indistinguishable from a host with no
    // removable networks, and only one of those is true.
    await waitFor(() => expect(document.body.textContent).toContain('network ls exploded'))
  })
})

// ---------------------------------------------------------------------------
// The image scan, on screen. Item 42's scanner row.
// ---------------------------------------------------------------------------

const INSPECT = {
  ok: true as const,
  inspect: {
    id: 'a'.repeat(64),
    name: 'alpha-api',
    image: 'alpine:3.18',
    imageId: 'sha256:' + 'b'.repeat(64),
    status: 'running',
    exitCode: null,
    startedAt: 'now',
    createdAt: 'now',
    restartPolicy: 'always',
    restartMaxRetries: null,
    restartCount: 0,
    health: null,
    envCount: 3,
    ports: [],
    mounts: [],
    networks: [],
    logDriver: 'json-file'
  }
}

const EOSL_SCAN = {
  ok: true as const,
  scannerPresent: true,
  reading: {
    rows: [],
    endOfSupport: true,
    warnings: ['The vulnerability detection may be insufficient because security updates are not provided'],
    failure: null
  }
}

async function openScan(
  user: ReturnType<typeof userEvent.setup>,
  scanImage: unknown
): Promise<void> {
  stubBridge({
    docker: {
      list: (cfg: Cfg) => Promise.resolve(listing(cfg.serverId.replace('srv-', ''))),
      disk: () => Promise.resolve(DISK),
      diskDetail: (cfg: Cfg) => diskDetailImpl(cfg),
      inspect: () => Promise.resolve(INSPECT),
      scanImage: () => Promise.resolve(scanImage)
    }
  })
  render(<DockerPanel servers={[ALPHA, BRAVO]} />)
  await user.click(btn(/Read containers/))
  await user.click(btn(/Ports, mounts/))
  await screen.findByText(/Scan this image/)
  await user.click(btn(/Scan this image/))
}

describe('DockerPanel — image scan', () => {
  // Measured: alpine:3.18 reports ZERO vulnerabilities and is past its
  // distribution's end of support. Zero there means nobody is issuing
  // advisories, not that nothing is wrong.
  it('does not render zero findings on an unsupported image as clean', async () => {
    const user = userEvent.setup()
    await openScan(user, EOSL_SCAN)
    const note = await screen.findByText(/nobody is issuing advisories for it any more/)
    // The TONE comes from the level, not the count. This case is zero findings
    // and an alarm, so anything deriving the colour from the number renders it
    // as calm.
    expect(note.className).toContain('is-alarm')
  })

  it('shows the scanner’s own warning under the headline', async () => {
    const user = userEvent.setup()
    await openScan(user, EOSL_SCAN)
    await screen.findByText(/security updates are not provided/)
  })

  it('puts the fixable count on every severity, not just the total', async () => {
    const user = userEvent.setup()
    await openScan(user, {
      ok: true,
      scannerPresent: true,
      reading: {
        rows: [
          { severity: 'CRITICAL', fixed: false, id: 'CVE-1', pkg: 'perl-base' },
          { severity: 'UNKNOWN', fixed: true, id: 'CVE-2', pkg: 'zlib1g' }
        ],
        endOfSupport: false,
        warnings: [],
        failure: null
      }
    })
    await screen.findByText('critical 1 (0 fixable)')
    expect(screen.getByText('unknown 1 (1 fixable)')).toBeTruthy()
  })

  // A host with no scanner looks identical to a clean one from here, and only
  // one of those is true.
  it('does not report a host with no scanner as clean', async () => {
    const user = userEvent.setup()
    await openScan(user, { ok: true, scannerPresent: false, reading: null })
    await screen.findByText(/Nothing here installs one/)
    expect(document.body.textContent).toContain('grype')
  })

  it('reports a scan that could not run', async () => {
    const user = userEvent.setup()
    await openScan(user, { ok: false, detail: 'trivy: command exploded' })
    await screen.findByText(/trivy: command exploded/)
  })
})

// ---------------------------------------------------------------------------
// The engine upgrade. Item 42.
// ---------------------------------------------------------------------------

describe('DockerPanel — engine upgrade', () => {
  const PRECHECK = {
    ok: true as const,
    precheck: {
      liveRestore: false,
      packagesText: 'docker-ce 5:27.0.3-1~debian.12~bookworm install ok installed',
      running: 4
    }
  }

  const open = async (
    user: ReturnType<typeof userEvent.setup>,
    facts: unknown,
    probe: unknown = PRECHECK
  ): Promise<void> => {
    useFleet.setState({ facts: facts as never, errors: {} })
    stubBridge({
      docker: {
        list: (cfg: Cfg) => Promise.resolve(listing(cfg.serverId.replace('srv-', ''))),
        disk: () => Promise.resolve(DISK),
        diskDetail: (cfg: Cfg) => diskDetailImpl(cfg),
        enginePrecheck: () => Promise.resolve(probe)
      }
    })
    render(<DockerPanel servers={[ALPHA, BRAVO]} />)
    await user.click(btn(/Read containers/))
    await screen.findByText(/Check the engine/)
  }

  const withManager = (m: string): unknown => ({
    'srv-alpha': { facts: { packageManager: m }, at: 1 }
  })

  // A server whose facts have not been collected gets the refusal rather than a
  // read built on a guess about its distribution.
  it('refuses before the facts say which package manager this server has', async () => {
    const user = userEvent.setup()
    await open(user, {})
    await screen.findByText(/Run the precheck first/)
  })

  // Distinguishes the refusal from a guess: with a precheck already read, a
  // build that fell back to apt would plan the upgrade here.
  it('still refuses once a precheck has been read but the manager is unknown', async () => {
    const user = userEvent.setup()
    await open(user, {})
    await user.click(btn(/Check the engine/))
    await screen.findByText(/docker-ce 5:27\.0\.3/)
    await user.click(screen.getByLabelText('I have read the package list'))
    expect(screen.queryByText(/Upgrade the engine/)).toBeNull()
    await screen.findByText(/Run the precheck first/)
  })

  // A confirmation is about the list that was on screen when it was given.
  it('drops the confirmation when the precheck is read again', async () => {
    const user = userEvent.setup()
    await open(user, withManager('apt'))
    await user.click(btn(/Check the engine/))
    await user.click(await screen.findByLabelText('I have read the package list'))
    await screen.findByText(/Upgrade the engine/)
    await user.click(btn(/Check again/))
    await waitFor(() => expect(screen.queryByText(/Upgrade the engine/)).toBeNull())
  })

  it('refuses a package manager Docker publishes no repository for', async () => {
    const user = userEvent.setup()
    await open(user, withManager('apk'))
    await screen.findByText(/publishes no repository/)
  })

  // The package block is SHOWN, not parsed, and the operator is the check.
  it('shows the package output and will not plan until it is confirmed', async () => {
    const user = userEvent.setup()
    await open(user, withManager('apt'))
    await user.click(btn(/Check the engine/))
    await screen.findByText(/docker-ce 5:27\.0\.3/)
    expect(screen.queryByText(/Upgrade the engine/)).toBeNull()
    await user.click(screen.getByLabelText('I have read the package list'))
    await screen.findByText(/Upgrade the engine/)
  })

  // The first caveat is what happens to the containers.
  it('leads with the containers stopping', async () => {
    const user = userEvent.setup()
    await open(user, withManager('apt'))
    await user.click(btn(/Check the engine/))
    await user.click(await screen.findByLabelText('I have read the package list'))
    await screen.findByText(/stops all 4 running container\(s\)/)
  })

  it('reports a precheck that could not run', async () => {
    const user = userEvent.setup()
    await open(user, withManager('apt'), { ok: false, detail: 'ssh said no' })
    await user.click(btn(/Check the engine/))
    await screen.findByText(/ssh said no/)
  })
})
