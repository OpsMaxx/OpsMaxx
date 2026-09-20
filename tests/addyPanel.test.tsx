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
    // `settings.addyRelayURL` survives a restart, so the relay address is
    // evidence that an account was made from this machine and evidence of
    // nothing else.
    //
    // It used to say "this build cannot tell whether that enrolment is still
    // in place" — reached only when main reported `enrolled: false`, which is
    // authoritative and works offline because it reads a note on disk. The
    // build knew; it said no. Blaming the build sent people looking for an
    // update.
    const step = addyJourney(null, false, 'https://relay.example')[0]
    expect(step.detail).toContain('relay.example')
    expect(step.detail).toMatch(/not on an account/)
    expect(step.detail).not.toMatch(/this build/i)
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

  it('tells the reader the device list is unread rather than empty', () => {
    render(<AddyPanel />)
    expect(screen.getByText(/cannot read the device list/)).toBeTruthy()
  })

  it('still shows the way in, and it is a fork rather than one door', () => {
    // The other half of the report: there was no way in at all. The setup flow
    // is embedded rather than copied — AddySetup owns the recovery phrase, and
    // a second implementation of a screen shown once is how somebody ends up
    // with an account nobody can recover.
    //
    // ASSERTED AS THREE DOORS, not as three sentences. The wording will be
    // edited again; what must not go missing is that a machine with no account
    // can say it already has one somewhere else. This screen used to offer
    // "create an account" and "I have a recovery phrase" and nothing between
    // them, so the owner of this product went looking for an invite to mint
    // for his second laptop — which is the one thing that must never be done.
    const { container } = render(<AddyPanel />)
    expect(container.querySelectorAll('.addy-choice').length).toBe(3)
  })

  it('preselects none of them, because the preselected one was the invite', () => {
    // An invite field on screen by default answers "how do I get my data onto
    // this machine" with the answer that is right for exactly one machine in
    // an account and wrong for every one after it.
    render(<AddyPanel />)
    expect(screen.queryByText(/Create an account on this relay/)).toBeNull()
    expect(screen.queryByText(/Start on the machine you already use/)).toBeNull()
    expect(screen.queryByText(/Recover this account/)).toBeNull()
  })

  it('opens the first-device path when that is what this machine is', () => {
    render(<AddyPanel />)
    fireEvent.click(screen.getByRole('button', { name: /first device/i }))
    expect(screen.getByText(/Create an account on this relay/)).toBeTruthy()
  })

  it('lets a machine with no account say it already has one elsewhere', () => {
    // THE DOOR THAT DID NOT EXIST. Every device after the first joins by
    // pairing, and nothing on this screen used to admit that pairing was a
    // thing a person with no account could do.
    render(<AddyPanel />)
    fireEvent.click(
      screen.getByRole('button', { name: /already use OpsMaxx on another machine/i })
    )
    expect(screen.getByText(/Start on the machine you already use/)).toBeTruthy()
    // And it does not ask for an invite on the way, which is the whole point.
    expect(screen.queryByText(/Create an account on this relay/)).toBeNull()
  })

  it('offers recovery to a machine whose other devices are gone', () => {
    // The path people reach for in a panic. It must be on the first screen,
    // not behind the one they would only find after setting something up.
    render(<AddyPanel />)
    fireEvent.click(screen.getByRole('button', { name: /devices are gone/i }))
    expect(screen.getByText(/Recover this account/)).toBeTruthy()
  })
})

describe('what it says once main can answer', () => {
  const stubStatus = (s: AddyStatus): void =>
    stubBridge({ addy: { status: vi.fn().mockResolvedValue(s) } })

  it('counts the devices and marks this one', async () => {
    stubStatus(healthy())
    render(<AddyPanel />)
    expect(await screen.findByText('work laptop')).toBeTruthy()
    // The CHIP, specifically. The note under the table names the chip too, in
    // the sentence that tells somebody to go and read the same fingerprint on
    // the other machine, so a bare text match now finds two.
    expect(screen.getByText('This device', { selector: '.chip' })).toBeTruthy()
    expect(screen.getByText('desktop')).toBeTruthy()
  })

  it('shows a key fingerprint on every device, because the names need not differ', async () => {
    // A device's label is sealed into its roster entry when it is paired, and
    // `completePairing` seals a constant: `confirmation.self?.label` is set by
    // nothing in either process, so every device this build pairs is called
    // "a paired device". Two of them make two identical rows, one of which
    // carries a button that wipes a laptop.
    const same = healthy()
    same.devices = [
      { id: 'aa11bb22cc33', label: 'a paired device', self: true, lastSeen: null, addedAt: null },
      { id: 'dd44ee55ff66', label: 'a paired device', self: false, lastSeen: null, addedAt: null }
    ]
    stubStatus(same)
    render(<AddyPanel />)
    expect(await screen.findByText('aa11bb22')).toBeTruthy()
    expect(screen.getByText('dd44ee55')).toBeTruthy()
  })

  it('names the key in the confirmation that wipes a machine', async () => {
    // "Remove a paired device?" names nothing when two rows say that.
    const same = healthy()
    same.devices = [
      { id: 'aa11bb22cc33', label: 'a paired device', self: true, lastSeen: null, addedAt: null },
      { id: 'dd44ee55ff66', label: 'a paired device', self: false, lastSeen: null, addedAt: null }
    ]
    stubStatus(same)
    render(<AddyPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    expect(screen.getByText('dd44ee55', { selector: 'code' })).toBeTruthy()
  })

  it('answers "which device is the main one" rather than offering a picker', async () => {
    // Every device holds the same account key and any of them can show a
    // pairing code, so a primary would be a single point of failure that the
    // recovery phrase already replaces. The list is where somebody goes
    // looking for the setting, so the list is where the answer belongs.
    stubStatus(healthy())
    render(<AddyPanel />)
    expect(await screen.findByText(/There is no main device to choose/)).toBeTruthy()
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

  it('gives a machine that HAS an account a way to add the next one', async () => {
    // THE REGRESSION THIS ROUND CAME FROM, and nothing tested it.
    //
    // `AddySetup` is the renderer's ONLY mount of `PairingPanel`, and it used
    // to return null the moment a device was enrolled. Pairing was therefore
    // reachable for exactly as long as the screen shown immediately after an
    // account was created stayed open — close it or restart, and no screen
    // anywhere in the app could show a pairing code again. The only thing the
    // product still offered was another invite, which does not add a device:
    // it starts a second sync group with its own key that cannot see the
    // first. That is why the owner asked how to mint one for machine B.
    //
    // The button is the assertion, not the prose around it: a door that is
    // described and not rendered is the defect, twice over now.
    stubStatus(healthy())
    const { container } = render(<AddyPanel />)
    await screen.findByText('work laptop')
    expect(await screen.findByRole('button', { name: /Show a code on this device/ })).toBeTruthy()
    // And the relay address it has to hand the other machine, which nothing
    // else in the product tells that machine.
    expect(container.textContent).toContain('https://relay.example')
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

describe('the clipboard shortcut switch', () => {
  const enrolledStatus = (): AddyStatus => ({
    enrolled: true,
    relayURL: 'https://relay.example',
    accountId: 'aad42aad5b51c8d31d31b3f529a312e2',
    devices: [{ id: 'aa', label: 'laptop', self: true, lastSeen: null, addedAt: null }],
    sync: { running: true, connected: true, lastSyncAt: Date.now(), conflicts: 0 }
  })

  it('says so when another application already holds the combination', async () => {
    // `register` returns false when something else has it, and both callers
    // threw that answer away — so a switch reading "on" over two shortcuts
    // nothing held looked exactly like one that worked. Cmd/Ctrl+Shift+C is
    // the developer tools in every browser, so this is the common case.
    const { useApp } = await import('../src/renderer/src/store/app')
    useApp.getState().setSettings({ addyClipboardShortcuts: true })
    stubBridge({
      addy: {
        status: vi.fn().mockResolvedValue(enrolledStatus()),
        clipboardShortcutState: vi
          .fn()
          .mockResolvedValue({ held: true, blocked: ['CommandOrControl+Shift+C'], attached: true })
      }
    })

    render(<AddyPanel />)

    await waitFor(() =>
      expect(screen.getByText(/Another application already holds/)).toBeTruthy()
    )
  })

  it('says nothing when they are held', async () => {
    const { useApp } = await import('../src/renderer/src/store/app')
    useApp.getState().setSettings({ addyClipboardShortcuts: true })
    stubBridge({
      addy: {
        status: vi.fn().mockResolvedValue(enrolledStatus()),
        clipboardShortcutState: vi.fn().mockResolvedValue({ held: true, blocked: [], attached: true })
      }
    })

    render(<AddyPanel />)
    await screen.findByText(/Send and receive the clipboard/)
    expect(screen.queryByText(/Another application already holds/)).toBeNull()
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
