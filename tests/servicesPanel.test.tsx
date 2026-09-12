// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { useNav } from '../src/renderer/src/store/nav'
import { useApp } from '../src/renderer/src/store/app'
import { ServicesPanel } from '../src/renderer/src/components/monitor/ServicesPanel'
import { UnitInstallPanel } from '../src/renderer/src/components/operations/UnitInstallPanel'
import type { Server } from '../src/renderer/src/types'

// `route` is not optional padding. The panel builds its targets with
// sshTargetFor, which reads `server.route` — a fixture without it throws where
// a real server never would, because every path that creates or hydrates one
// normalises `route` to at least []. Omitting it here made this suite assert
// against a shape the app cannot produce.
const server = (id: string, name: string): Server =>
  ({ id, name, host: 'h', port: 22, username: 'u', auth: 'key', route: [] }) as unknown as Server

const reading = (over: Record<string, unknown> = {}) => ({
  status: 'ok',
  linger: 'lingering',
  units: [
    { name: 'api.service', load: 'loaded', active: 'active', sub: 'running', description: 'Demo API' }
  ],
  ...over
})

describe('the services panel', () => {
  it('does not claim anything is supervised before it has asked', async () => {
    // The list starts null, not empty. "Nothing is supervised" is a claim about
    // a server, and it must not be made about one nobody has spoken to.
    stubBridge({ services: { collect: async () => [] } } as never)
    render(<ServicesPanel servers={[server('a', 'web-1')]} />)

    expect(await screen.findByText(/Nothing read yet/)).toBeTruthy()
    expect(screen.queryByText(/No servers to ask/)).toBeNull()
  })

  it('leads with what will happen, not with the unit list', async () => {
    // A server whose units are running but whose account is not lingering.
    // Those units stop when the session ends, and the panel has to say so
    // ABOVE the list that shows them cheerfully running.
    stubBridge({
      services: {
        collect: async () => [
          { serverId: 'a', serverName: 'web-1', reading: reading({ linger: 'not-lingering' }) }
        ]
      }
    } as never)
    render(<ServicesPanel servers={[server('a', 'web-1')]} />)
    await userEvent.click(await screen.findByRole('button', { name: /Read services/ }))

    expect(await screen.findByText(/stop when your last session ends/)).toBeTruthy()
    expect(screen.getByText('api.service')).toBeTruthy()
  })

  it('does not raise that when the account is lingering', async () => {
    stubBridge({
      services: {
        collect: async () => [{ serverId: 'a', serverName: 'web-1', reading: reading() }]
      }
    } as never)
    render(<ServicesPanel servers={[server('a', 'web-1')]} />)
    await userEvent.click(await screen.findByRole('button', { name: /Read services/ }))

    expect(await screen.findByText(/supervised by the server/)).toBeTruthy()
    expect(screen.queryByText(/stop when your last session ends/)).toBeNull()
  })

  it('says the capability is missing rather than reporting no services', async () => {
    stubBridge({})
    render(<ServicesPanel servers={[server('a', 'web-1')]} />)
    await userEvent.click(await screen.findByRole('button', { name: /Read services/ }))

    expect(await screen.findByText(/does not expose server services/)).toBeTruthy()
    // What this test has always been named for. The missing-preload path sets
    // the row list to `[]` to leave the loading state, and the empty state used
    // to hang off THAT — so a workspace full of servers was told it had none,
    // and told to add one, on the one failure that has nothing to do with how
    // many servers there are.
    expect(screen.queryByText(/No servers to ask/)).toBeNull()
  })

  it('offers nothing to press when the workspace has no servers', async () => {
    stubBridge({ services: { collect: vi.fn() } } as never)
    render(<ServicesPanel servers={[]} />)
    expect(
      ((await screen.findByRole('button', { name: /Read services/ })) as HTMLButtonElement).disabled
    ).toBe(true)
    // ...and does not then tell the operator to press it. The read button is
    // disabled with no servers, so "Press Read services" is an instruction to
    // press a control that cannot be pressed.
    expect(screen.queryByText(/Nothing read yet/)).toBeNull()
    expect(screen.getByText(/No servers to ask/)).toBeTruthy()
  })

  it('does not send anyone to Settings to find out which servers are in the workspace', async () => {
    // `servers` is the ACTIVE WORKSPACE's servers, so "which are in it" is a
    // question about workspace membership. Settings › Modules switches optional
    // subsystems on and off and has no server list anywhere on it, and there is
    // no settings page for membership at all — so no `openSettings(...)` target
    // could have been right. The empty state therefore points at something the
    // operator can SEE (the workspace picker in the title bar) and offers no
    // button of its own.
    stubBridge({ services: { collect: vi.fn() } } as never)
    const before = useNav.getState().settingsSection
    render(<ServicesPanel servers={[]} />)

    expect(await screen.findByText(/workspace/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Settings/i })).toBeNull()
    // The shell's ⓘ and the read button are the whole of this state. Anything
    // else here is a button to a page that cannot answer the question.
    expect(
      screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim())
    ).toEqual(['About Server services', 'Read services'])
    // Nothing has navigated: the destination is a place, not a click.
    expect(useNav.getState().settingsSection).toBe(before)
    expect(useApp.getState().activity).not.toBe('settings')
  })
})

// The install moved to its own panel on the Operations rail when the fleet
// destination was split by surface: Server services reads what a machine
// supervises, and Monitoring's contract is that nothing in it writes. The
// behaviours are unchanged, so they are asserted against the panel that owns
// them now — the split moved where the write lives, not whether it is checked.
//
// The installer picks ONE server rather than reading the estate, because it
// writes to one machine; there is no fleet read in front of it.
describe('installing a unit', () => {
  const rows = async () => [
    { serverId: 'a', serverName: 'web-1', reading: reading() }
  ]

  it('shows the exact file before it writes it', async () => {
    // A file is about to appear on a machine nobody is looking at. "Trust me"
    // is not a preview, so the rendered unit is on screen before Install is
    // pressable.
    stubBridge({ services: { collect: rows, write: vi.fn() } } as never)
    render(<UnitInstallPanel servers={[server('a', 'web-1')]} />)
    await userEvent.selectOptions(screen.getByLabelText('Server'), 'a')

    await userEvent.type(screen.getByLabelText('Unit name'), 'worker.service')
    await userEvent.type(screen.getByLabelText('Description'), 'Queue worker')
    await userEvent.type(screen.getByLabelText('ExecStart'), '/usr/local/bin/worker')

    expect(screen.getByText(/ExecStart=\/usr\/local\/bin\/worker/)).toBeTruthy()
    expect(screen.getByText(/WantedBy=default.target/)).toBeTruthy()
  })

  it('will not offer Install for a draft the server would reject', async () => {
    // The same refusal main enforces, said here so nobody types a unit name
    // and learns it was wrong from a server round trip.
    stubBridge({ services: { collect: rows, write: vi.fn() } } as never)
    render(<UnitInstallPanel servers={[server('a', 'web-1')]} />)
    await userEvent.selectOptions(screen.getByLabelText('Server'), 'a')

    await userEvent.type(screen.getByLabelText('Unit name'), 'worker')
    expect(((await screen.findByRole('button', { name: 'Install' })) as HTMLButtonElement).disabled).toBe(true)
    // getAllBy: the installer states the naming rule twice on purpose — once as
    // a standing note beside the field, and again as the refusal once a draft
    // breaks it. Both are the same sentence, which is the point.
    expect(screen.getAllByText(/has to end in .service/).length).toBeGreaterThan(0)
  })

  it('asks before writing, and does not write when the answer is no', async () => {
    const write = vi.fn(async () => ({ ok: true, output: 'WROTE: x' }))
    stubBridge({ services: { collect: rows, write } } as never)
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<UnitInstallPanel servers={[server('a', 'web-1')]} />)
    await userEvent.selectOptions(screen.getByLabelText('Server'), 'a')
    await userEvent.type(screen.getByLabelText('Unit name'), 'worker.service')
    await userEvent.type(screen.getByLabelText('Description'), 'w')
    await userEvent.type(screen.getByLabelText('ExecStart'), '/bin/true')
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))

    expect(write).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('shows the server’s own refusal rather than the word failed', async () => {
    // The useful sentence is the server's: "not lingering, run loginctl
    // enable-linger" is the whole answer, and replacing it with "failed" throws
    // away the fix.
    const write = vi.fn(async () => ({
      ok: false,
      error: 'this account is not lingering... Run: loginctl enable-linger ops'
    }))
    stubBridge({ services: { collect: rows, write } } as never)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<UnitInstallPanel servers={[server('a', 'web-1')]} />)
    await userEvent.selectOptions(screen.getByLabelText('Server'), 'a')
    await userEvent.type(screen.getByLabelText('Unit name'), 'worker.service')
    await userEvent.type(screen.getByLabelText('Description'), 'w')
    await userEvent.type(screen.getByLabelText('ExecStart'), '/bin/true')
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))

    expect(await screen.findByText(/loginctl enable-linger/)).toBeTruthy()
    vi.restoreAllMocks()
  })
})
