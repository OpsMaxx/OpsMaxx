// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stubBridge } from './setup/renderer'
import { useToasts } from '../src/renderer/src/store/toast'
import { AddyPanel } from '../src/renderer/src/components/addy/AddyPanel'
import { addyJourney, ago, type AddyStatus, type AddySync } from '../src/renderer/src/components/addy/addyStatus'
import { duration } from '../src/renderer/src/lib/format'
import { useApp } from '../src/renderer/src/store/app'
import { PROMOTED_MODULE_IDS, MODULES } from '../src/shared/modules'

/**
 * The panel behind the new rail button, and the one rule it is built on.
 *
 * A PANEL THAT LIES IS WORSE THAN THE ONE WE HAD. addy's sync engine, login and
 * persistence are being written in parallel with this screen, and today the
 * bridge answers pairing, conflicts and revocation and nothing about state. The
 * failure mode that matters is therefore not an ugly screen — it is a green
 * dashboard over a dead engine: "0 devices" for an account with four, "last
 * sync: never" printed as though sync had run and found nothing, a tick beside
 * a step nobody can observe.
 *
 * So these tests are mostly about what the panel does NOT say. They pin:
 *
 *  1. that an unanswerable question renders as an em dash and a sentence, never
 *     as a zero;
 *  2. that the journey marks an unobservable step `unknown` rather than done;
 *  3. that `null` last-seen is "never" rather than "0s ago";
 *  4. that the account-creation form is not on screen beside an account that
 *     already exists;
 *  5. that every piece of this is reachable — the module is promoted, the rail
 *     has an icon and a tooltip for it, and FleetMonitor mounts the panel.
 */

const ROOT = join(__dirname, '..')

/** A sync that is up, for the contrast with everything this build cannot say. */
function working(): AddySync {
  return { running: true, connected: true, lastSyncAt: Date.now() - 30_000, conflicts: 0 }
}

/** A status with everything working. */
function healthy(): AddyStatus {
  return {
    enrolled: true,
    relayURL: 'https://relay.example',
    accountId: 'acct-1',
    devices: [
      { id: 'a', label: 'work laptop', self: true, lastSeen: Date.now() - 60_000, addedAt: null },
      { id: 'b', label: 'desktop', self: false, lastSeen: null, addedAt: null }
    ],
    sync: working()
  }
}

beforeEach(() => {
  stubBridge({})
  useApp.setState((st) => ({ settings: { ...st.settings, addyRelayURL: undefined } }))
})

describe('the journey', () => {
  it('never claims a step it cannot observe', () => {
    // The whole of today's build: no `status` call, so nothing after step one
    // is knowable. None of those steps may be ticked.
    const steps = addyJourney(null, false, undefined)
    expect(steps.map((s) => s.key)).toEqual(['account', 'device', 'pair', 'sync', 'current'])
    for (const s of steps.slice(1)) {
      expect(s.state, `${s.key} claims ${s.state} on a build that cannot tell`).toBe('unknown')
    }
  })

  it('starts a person who has never seen it on step one', () => {
    expect(addyJourney(null, false, undefined)[0].state).toBe('now')
  })

  it('says what a remembered relay does and does not prove', () => {
    // `settings.addyRelayURL` survives a restart and an enrolment currently
    // does not, so the relay address is evidence that an account was made here
    // and evidence of nothing else. Saying more would be the lie.
    const step = addyJourney(null, false, 'https://relay.example')[0]
    expect(step.detail).toContain('relay.example')
    expect(step.detail).toMatch(/cannot tell whether that enrolment is still in place/)
  })

  it('ticks the whole journey when everything really is working', () => {
    const steps = addyJourney(healthy(), true, undefined)
    for (const s of steps) expect(s.state, s.key).toBe('done')
  })

  it('stops at pairing while one device is on the account', () => {
    const one = healthy()
    one.devices = [one.devices![0]]
    const steps = addyJourney(one, true, undefined)
    expect(steps.find((s) => s.key === 'pair')!.state).toBe('now')
  })

  it('puts a conflict on the last step rather than reporting agreement', () => {
    const conflicted = healthy()
    conflicted.sync.conflicts = 2
    const steps = addyJourney(conflicted, true, undefined)
    expect(steps.find((s) => s.key === 'current')!.state).toBe('now')
    expect(steps.find((s) => s.key === 'current')!.detail).toContain('2 changes')
  })

  it('does not tick "in sync" over a pass that failed', () => {
    // `lastSyncAt` is set when a pass STARTS, so a failed pass still leaves a
    // non-null timestamp. The last step rendered a green tick and "Everything
    // this device knows about has been carried" directly above a band saying
    // the last sync failed and why — two contradictory statements on one
    // screen, with the tick on the reassuring one.
    const broken = healthy()
    broken.sync = {
      running: true,
      connected: true,
      lastSyncAt: Date.now(),
      conflicts: 0,
      error: { message: 'servers: the relay refused the token', at: Date.now() }
    }
    const steps = addyJourney(broken, true, undefined)
    const last = steps.find((s) => s.key === 'current')!
    expect(last.state).not.toBe('done')
    expect(last.detail).toMatch(/failed/)
  })

  it('does not tick "in sync" off an engine that is not running', () => {
    const stopped = healthy()
    stopped.sync = { running: false, connected: false, lastSyncAt: null, conflicts: 0 }
    const steps = addyJourney(stopped, true, undefined)
    expect(steps.find((s) => s.key === 'sync')!.state).toBe('unknown')
    expect(steps.find((s) => s.key === 'current')!.state).toBe('unknown')
  })
})

describe('how long ago', () => {
  const at = (ms: number): number => Date.now() - ms
  const DAY = 86_400_000

  it('defers to the app-wide helper below a day', () => {
    // So a device seen this morning and a server sampled this morning are
    // described the same way on the two screens.
    expect(ago(at(90_000))).toBe(duration(at(90_000)))
  })

  it('does not report last spring in hours', () => {
    // The reason this function exists: `duration()` stops at hours, so a
    // device that paired a year ago reads "8760h 0m".
    expect(ago(at(3 * DAY))).toBe('3d')
    expect(ago(at(60 * DAY))).toBe('2mo')
    expect(ago(at(400 * DAY))).toBe('1y')
    expect(ago(at(365 * DAY))).not.toMatch(/h/)
  })
})

describe('what the panel says on a build with no sync', () => {
  it('says so, in the first thing on the page', () => {
    render(<AddyPanel />)
    expect(screen.getByText(/Sync is not running on this build/)).toBeTruthy()
  })

  it('prints no number it was not given', () => {
    // The defect this catches: `?? 0` anywhere in the band. A zero here is a
    // claim about an account, and there is no account to make a claim about.
    const { container } = render(<AddyPanel />)
    const values = [...container.querySelectorAll('.kpi-value')].map((e) => e.textContent)
    expect(values).not.toContain('0')
    expect(values.filter((v) => v === '—').length).toBeGreaterThanOrEqual(2)
  })

  it('names the question each tile cannot answer', () => {
    const { container } = render(<AddyPanel />)
    const subs = [...container.querySelectorAll('.kpi-sub')].map((e) => e.textContent ?? '')
    expect(subs.some((s) => /not reported by this build/.test(s))).toBe(true)
  })

  it('offers no Refresh button it cannot honour', () => {
    render(<AddyPanel />)
    expect(screen.queryByRole('button', { name: /Refresh/ })).toBeNull()
  })

  it('tells the reader the roster is unread rather than empty', () => {
    render(<AddyPanel />)
    expect(screen.getByText(/cannot read the device roster/)).toBeTruthy()
  })

  it('still shows the way in', () => {
    // The other half of the report: there was no way in at all. The setup flow
    // is embedded rather than copied — AddySetup owns the recovery phrase, and
    // a second implementation of a screen shown once is how somebody ends up
    // with an account nobody can recover.
    render(<AddyPanel />)
    expect(screen.getByText(/Create an account on this relay/)).toBeTruthy()
  })
})

describe('what it says once main can answer', () => {
  const stubStatus = (s: AddyStatus): void =>
    stubBridge({ addy: { status: vi.fn().mockResolvedValue(s) } })

  it('counts the devices and marks this one', async () => {
    stubStatus(healthy())
    render(<AddyPanel />)
    expect(await screen.findByText('work laptop')).toBeTruthy()
    expect(screen.getByText('This device')).toBeTruthy()
    expect(screen.getByText('desktop')).toBeTruthy()
  })

  it('does not claim to know when a device was last seen', async () => {
    // This used to assert the opposite, and the opposite was a falsehood on
    // every row of every account. `lastSeen` is `null` because the RELAY does
    // not report it — the shared contract says so — and null is "unknown", not
    // "never". Rendering it as "never" told a sysadmin that the machine they
    // were looking at had never been seen, in the one column they scan to spot
    // a device that should not be there.
    stubStatus(healthy())
    render(<AddyPanel />)
    await screen.findByText(/does not report when each device was last seen/)
    expect(screen.queryByText('never')).toBeNull()
    // The note under the table is where it is said, once.
  })

  it('does not offer to create a second account beside the one that exists', async () => {
    stubStatus(healthy())
    render(<AddyPanel />)
    await screen.findByText('work laptop')
    expect(screen.queryByText(/Create an account on this relay/)).toBeNull()
  })

  it('raises an attention tile only when something is actually wrong', async () => {
    const bad = healthy()
    bad.sync.error = { message: 'relay refused the token', at: Date.now() - 5000 }
    stubStatus(bad)
    const { container } = render(<AddyPanel />)
    expect(await screen.findByText(/relay refused the token/)).toBeTruthy()
    expect(container.querySelector('.kpi.danger')).toBeTruthy()
  })

  it('shows no attention tile on a healthy account', async () => {
    stubStatus(healthy())
    const { container } = render(<AddyPanel />)
    await screen.findByText('work laptop')
    expect(container.querySelector('.kpi.danger')).toBeNull()
  })
})

describe('every part of this is reachable', () => {
  it('registers the module and promotes it', () => {
    expect(MODULES.find((m) => m.id === 'addy')).toBeTruthy()
    expect(PROMOTED_MODULE_IDS).toContain('addy')
  })

  it('ships on, because a nav entry nobody can find is the defect being fixed', () => {
    expect(MODULES.find((m) => m.id === 'addy')!.defaultEnabled).toBe(true)
  })

  it('is mounted by FleetMonitor, gated on the module switch', () => {
    // A promoted module is still a monitorTab in FleetMonitor's one tree. The
    // rail button opens `addy`; if nothing renders it, that is a pointer at
    // nothing — which is the failure mode this repo has hit repeatedly.
    const fm = readFileSync(
      join(ROOT, 'src/renderer/src/components/monitor/FleetMonitor.tsx'),
      'utf8'
    )
    expect(fm).toContain("show('addy')")
    expect(fm).toContain('<AddyPanel />')
    expect(fm).toContain("moduleEnabled(modules, 'addy')")
  })

  it('has a rail icon and a tooltip, so the button is neither blank nor mute', () => {
    const bar = readFileSync(
      join(ROOT, 'src/renderer/src/components/layout/ActivityBar.tsx'),
      'utf8'
    )
    expect(bar).toMatch(/addy: </)
    expect(bar).toMatch(/addy: '/)
  })

  it('exports nothing that nothing uses', () => {
    // The reachability rule applied to this change's own files. Something that
    // is exported and referenced only by its own declaration is dead — the
    // failure this repo has hit five times recently, where a component was
    // written, reviewed and merged with no call site.
    //
    // Counted across everything this change touches rather than in the panel
    // alone, because a type can legitimately be used by another type in the
    // same file: what is being caught is ONE occurrence, not the absence of a
    // React call site.
    const files = [
      'src/renderer/src/components/addy/addyStatus.ts',
      'src/renderer/src/components/addy/AddyPanel.tsx',
      'src/renderer/src/components/monitor/FleetMonitor.tsx',
      'src/renderer/src/components/layout/ActivityBar.tsx'
    ].map((f) => readFileSync(join(ROOT, f), 'utf8'))
    const all = [...files, readFileSync(join(__dirname, 'addyPanel.test.tsx'), 'utf8')].join('\n')

    const exported = [...files[0].matchAll(/export (?:function|interface|type|const) (\w+)/g)].map(
      (m) => m[1]
    )
    expect(exported.length).toBeGreaterThan(4)
    for (const name of exported) {
      const uses = all.split(new RegExp(`\\b${name}\\b`)).length - 1
      expect(uses, `${name} is exported and nothing refers to it`).toBeGreaterThan(1)
    }
    // And the panel itself, which is the export the whole change exists for.
    expect(all).toContain('<AddyPanel />')
  })
})

describe('the Sync now button', () => {
  const enrolled = (over: Partial<AddyStatus> = {}): AddyStatus => ({
    enrolled: true,
    relayURL: 'https://relay.example',
    accountId: 'aad42aad5b51c8d31d31b3f529a312e2',
    devices: [{ id: 'aa', label: 'laptop', self: true, lastSeen: null, addedAt: null }],
    sync: { running: true, connected: true, lastSyncAt: Date.now(), conflicts: 0 },
    ...over
  })

  it('runs a pass and re-reads the status afterwards', async () => {
    // Both halves. A pass that is not followed by a read leaves the screen
    // showing the numbers from before it — which is the one thing somebody
    // pressing this button is trying to find out.
    const syncNow = vi.fn().mockResolvedValue({ carried: 3 })
    const status = vi.fn().mockResolvedValue(enrolled())
    stubBridge({ addy: { status, syncNow } })

    render(<AddyPanel />)
    const button = await screen.findByRole('button', { name: /Sync now/ })
    fireEvent.click(button)

    await waitFor(() => expect(syncNow).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(status.mock.calls.length).toBeGreaterThan(1))
  })

  it('is not offered to a machine that is not on an account', async () => {
    // Its only possible outcome there is an error, and the journey below
    // already says what to do instead.
    stubBridge({
      addy: {
        status: vi.fn().mockResolvedValue({
          enrolled: false,
          sync: { running: false, connected: false, lastSyncAt: null, conflicts: 0 }
        })
      }
    })
    render(<AddyPanel />)
    await waitFor(() => expect(screen.queryByRole('button', { name: /Refresh/ })).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Sync now/ })).toBeNull()
  })

  it('says so when a pass could not run at all', async () => {
    // Main returns null when this device is enrolled but not logged in —
    // offline, an expired token, a sidecar that did not start. The button
    // blinked and changed nothing, and the screen was identical afterwards.
    const syncNow = vi.fn().mockResolvedValue(null)
    stubBridge({ addy: { status: vi.fn().mockResolvedValue(enrolled()), syncNow } })

    render(<AddyPanel />)
    fireEvent.click(await screen.findByRole('button', { name: /Sync now/ }))

    // The toast store, because the toast host is not mounted in this test —
    // asserting on the DOM here would be asserting on the harness.
    await waitFor(() =>
      expect(useToasts.getState().toasts.some((t) => /not connected to the relay/.test(t.message))).toBe(true)
    )
  })

  it('says what went wrong when a pass threw', async () => {
    const syncNow = vi.fn().mockRejectedValue(new Error('the relay refused the token'))
    stubBridge({ addy: { status: vi.fn().mockResolvedValue(enrolled()), syncNow } })

    render(<AddyPanel />)
    fireEvent.click(await screen.findByRole('button', { name: /Sync now/ }))

    await waitFor(() =>
      expect(useToasts.getState().toasts.some((t) => /refused the token/.test(t.message))).toBe(true)
    )
  })

  it('re-reads even when the pass failed', async () => {
    // A failed pass changed the status too, and the error band is what has to
    // say so — not a button that silently went back to normal.
    const syncNow = vi.fn().mockRejectedValue(new Error('the relay hated it'))
    const status = vi.fn().mockResolvedValue(enrolled())
    stubBridge({ addy: { status, syncNow } })

    render(<AddyPanel />)
    fireEvent.click(await screen.findByRole('button', { name: /Sync now/ }))
    await waitFor(() => expect(status.mock.calls.length).toBeGreaterThan(1))
  })
})
