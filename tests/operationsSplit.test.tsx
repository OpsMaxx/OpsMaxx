// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { useApp } from '../src/renderer/src/store/app'
import { useNav } from '../src/renderer/src/store/nav'
import { AccessPanel } from '../src/renderer/src/components/monitor/AccessPanel'
import { CronPanel } from '../src/renderer/src/components/monitor/CronPanel'
import { ServicesPanel } from '../src/renderer/src/components/monitor/ServicesPanel'
import { KeyRevokePanel } from '../src/renderer/src/components/operations/KeyRevokePanel'
import { CronEditPanel } from '../src/renderer/src/components/operations/CronEditPanel'
import { UnitInstallPanel } from '../src/renderer/src/components/operations/UnitInstallPanel'
import { buildCronWriteCommand } from '../src/shared/cron'
import type { CronEntry, CronSourceReport } from '../src/shared/cron'
import type { HostAccess } from '../src/shared/access'
import type { Server } from '../src/renderer/src/types'

// The three writes that used to live on the read surface, and where they went.
//
// `surface: 'read'` claims that nothing on Monitoring writes to a server.
// `access`, `cron` and `services` each broke it with one control bolted onto a
// large read, and each was SPLIT rather than reclassified: the read stayed, the
// write moved to Operations, and the place the control used to be became a
// pointer at where it went.
//
// tests/monitorSurfaces.test.ts pins the registry half of that — the exception
// list is empty and the operate set is exactly four. This file is the half a
// registry cannot state: that the read panels really stopped writing, that the
// pointers land where they claim, and that every check the moved flows carried
// came with them. A split that dropped a confirmation would pass every
// assertion in the other file.

const SERVER: Server = {
  id: 'srv-1',
  workspaceId: 'ws-default',
  folderId: null,
  name: 'db-01',
  host: 'db-01.example.internal',
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

const OTHER: Server = { ...SERVER, id: 'srv-2', name: 'web-1' }

const FP = 'SHA256:4vTVjhtHpQmZ0y0mS0T3hqQ0mV4G0R0m3l8y3n5r0aE'

/** One host's authorized_keys reading. Only `accounts` is read by either panel,
 *  and spelling out the twenty other fields of HostAccess would be twenty more
 *  things to keep true about a fixture rather than about the code. */
const access = (over: Partial<HostAccess> = {}): HostAccess =>
  ({
    accounts: [
      {
        user: 'ops',
        uid: 1000,
        shell: '/bin/bash',
        home: '/home/ops',
        keys: [
          {
            fingerprint: FP,
            type: 'ssh-ed25519',
            bits: 256,
            comment: 'ops@laptop',
            problem: null,
            restricted: false,
            broadened: false,
            certificate: false
          }
        ],
        keysStatus: 'ok',
        keyPath: '/home/ops/.ssh/authorized_keys'
      }
    ],
    authorizedKeysFile: [],
    ...over
  }) as unknown as HostAccess

const PREVIEW = {
  token: '1800000000000',
  command: 'SP_F="$HOME/.ssh/authorized_keys"\ngrep -v -F',
  hosts: [{ serverId: SERVER.id, serverName: SERVER.name, user: 'ops' }],
  blocks: [],
  refusals: [],
  rollbackSeconds: 300
}

/** The opt-in the write half is gated behind, on top of the build ceiling. */
const allowKeyWrites = (on: boolean): void => {
  useApp.setState({ settings: { ...useApp.getState().settings, accessWriteEnabled: on } })
}

const ok = (id: CronSourceReport['id']): CronSourceReport => ({ id, label: id, status: 'ok' })

const userJob: CronEntry = {
  kind: 'user-crontab',
  origin: 'crontab -l',
  schedule: '0 3 * * *',
  description: 'at 03:00 every day',
  user: null,
  command: '/usr/bin/backup --all',
  line: '0 3 * * * /usr/bin/backup --all',
  input: 'stdin for the job'
}

const crondJob: CronEntry = {
  kind: 'cron.d',
  origin: '/etc/cron.d/certbot',
  schedule: '0 */12 * * *',
  description: null,
  user: 'root',
  command: 'certbot -q renew',
  line: '0 */12 * * * root certbot -q renew'
}

const cronRows = (sources: CronSourceReport[] = [ok('user-crontab')]): unknown[] => [
  {
    serverId: SERVER.id,
    serverName: SERVER.name,
    entries: [userJob, crondJob],
    unparsed: 0,
    sources
  }
]

const TOKEN = '20260903T101112Z-a1b2c3'
const CRON_COMMAND = buildCronWriteCommand({
  before: '0 3 * * * /usr/bin/backup --all\n',
  after: '0 3 * * * /usr/bin/backup --nightly\n',
  token: TOKEN
})

const cronBridge = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  cron: {
    collect: vi.fn(async () => cronRows()),
    planEdit: vi.fn(async () => ({
      ok: true,
      before: '0 3 * * * /usr/bin/backup --all\n',
      after: '0 3 * * * /usr/bin/backup --nightly\n',
      summary: 'change `0 3 * * * /usr/bin/backup --all` to `0 3 * * * /usr/bin/backup --nightly`',
      addedFinalNewline: false,
      token: TOKEN,
      command: CRON_COMMAND
    })),
    write: vi.fn(async () => ({
      ok: true,
      serverId: SERVER.id,
      serverName: SERVER.name,
      outcome: 'written',
      backupPath: '/home/ops/.opsmaxx-crontab-20260903T101112Z-a1b2c3.bak',
      detail: 'the crontab was replaced and read back identical'
    })),
    ...over
  }
})

beforeEach(() => {
  useNav.setState({ operationsJump: null, operationsTab: 'broadcast', fleetRail: 'monitor' })
})

// ---------------------------------------------------------------------------
// The read panels stopped writing, and say where the write went
// ---------------------------------------------------------------------------

describe('the Monitoring panels that used to write', () => {
  it('sends the key table to the revoker instead of planning a revocation from it', async () => {
    // The pointer is the whole point. It must move the user AND write nothing:
    // a "pointer" that also kicked off a plan against the estate would have
    // left the write on the read surface with an extra click in front of it.
    allowKeyWrites(true)
    const accessPlan = vi.fn()
    stubBridge({
      fleet: {
        access: async () => ({ access: access(), at: 1 }),
        sampleNow: async () => undefined,
        accessPlan,
        accessRun: vi.fn()
      }
    })
    render(<AccessPanel servers={[SERVER]} />)

    await userEvent.click(await screen.findByTestId(`revoke-${FP}`))
    expect(useNav.getState().fleetRail).toBe('operations')
    expect(useNav.getState().operationsTab).toBe('keyRevoke')
    expect(useNav.getState().operationsJump).toMatchObject({ kind: 'revoke-key', fingerprint: FP })
    expect(accessPlan).not.toHaveBeenCalled()
  })

  it('sends the schedule list to the editor carrying the line AND the stdin', async () => {
    // `input` is the field a careless jump drops. It is the text after an
    // unescaped `%`, it is not editable in the form, and an update that lost it
    // would change what a job is fed while every visible character stayed the
    // same — a silent rewrite of the one thing nobody was looking at.
    const stub = cronBridge()
    stubBridge(stub)
    render(<CronPanel servers={[SERVER]} />)
    await userEvent.click(screen.getByRole('button', { name: /read schedules/i }))
    await screen.findByText(/db-01/)

    await userEvent.click(await screen.findByTestId(`edit-${SERVER.id}`))
    expect(useNav.getState().operationsTab).toBe('jobs')
    expect(useNav.getState().operationsJump).toMatchObject({
      kind: 'cron-edit',
      serverId: SERVER.id,
      line: '0 3 * * * /usr/bin/backup --all',
      input: 'stdin for the job'
    })
    expect((stub.cron as { write: ReturnType<typeof vi.fn> }).write).not.toHaveBeenCalled()
  })

  it('offers no pointer at all for a host whose own crontab was only partly read', async () => {
    // A pointer that lands on a refusal is worse than no pointer: the user
    // learns the button is broken rather than that the file cannot be written.
    // The editor WOULD refuse — a write replaces the whole crontab, so the part
    // nobody could read is the part it would delete.
    stubBridge(
      cronBridge({
        collect: vi.fn(async () => cronRows([{ id: 'user-crontab', label: 'crontab', status: 'partial' }]))
      })
    )
    render(<CronPanel servers={[SERVER]} />)
    await userEvent.click(screen.getByRole('button', { name: /read schedules/i }))
    await screen.findByText(/db-01/)

    expect(screen.queryByTestId(`edit-${SERVER.id}`)).toBeNull()
    expect(screen.queryByTestId(`add-${SERVER.id}`)).toBeNull()
    expect(screen.getByText(/not read in full/)).toBeTruthy()
  })

  it('sends the service list to the installer and writes no unit on the way', async () => {
    const write = vi.fn()
    stubBridge({
      services: {
        collect: async () => [
          {
            serverId: SERVER.id,
            serverName: SERVER.name,
            reading: {
              status: 'ok',
              linger: 'lingering',
              units: [
                {
                  name: 'api.service',
                  load: 'loaded',
                  active: 'active',
                  sub: 'running',
                  description: 'Demo API'
                }
              ]
            }
          }
        ],
        write
      }
    })
    render(<ServicesPanel servers={[SERVER]} />)
    await userEvent.click(await screen.findByRole('button', { name: /read services/i }))

    await userEvent.click(await screen.findByTestId(`install-on-${SERVER.id}`))
    expect(useNav.getState().fleetRail).toBe('operations')
    expect(useNav.getState().operationsTab).toBe('jobs')
    expect(useNav.getState().operationsJump).toMatchObject({
      kind: 'unit-install',
      serverId: SERVER.id
    })
    expect(write).not.toHaveBeenCalled()
  })

  it('gives two presses two different nonces, so asking twice is not swallowed', async () => {
    // The counter rather than Date.now(), stated over the pointer that a person
    // is most likely to press twice: two clicks inside one millisecond used to
    // produce the same id, and the second was ignored as a repeat of the first.
    stubBridge(cronBridge())
    render(<CronPanel servers={[SERVER]} />)
    await userEvent.click(screen.getByRole('button', { name: /read schedules/i }))
    await screen.findByText(/db-01/)

    await userEvent.click(await screen.findByTestId(`add-${SERVER.id}`))
    const first = useNav.getState().operationsJump!.nonce
    await userEvent.click(await screen.findByTestId(`add-${SERVER.id}`))
    expect(useNav.getState().operationsJump!.nonce).toBeGreaterThan(first)
  })
})

// ---------------------------------------------------------------------------
// The moved flows kept every check they arrived with
// ---------------------------------------------------------------------------

describe('revoking a key, now that it lives in Operations', () => {
  it('will not plan anything while the write half is switched off, and says why', async () => {
    allowKeyWrites(false)
    stubBridge({
      fleet: { access: async () => ({ access: access(), at: 1 }), accessPlan: vi.fn() }
    })
    render(<KeyRevokePanel servers={[SERVER]} />)

    const note = await screen.findByTestId('write-gated')
    expect(note.textContent).toMatch(/not enabled in this build/i)
    expect((await screen.findByTestId('revoke-plan')).hasAttribute('disabled')).toBe(true)
  })

  it('says how many servers were never read, so the list is not mistaken for the estate', async () => {
    // The governing rule, on the one screen where believing a lower bound is an
    // answer has a consequence: "revoked from the fleet" is a claim this panel
    // is not allowed to make about hosts nobody could read.
    allowKeyWrites(true)
    stubBridge({
      fleet: {
        access: async (id: string) => (id === SERVER.id ? { access: access(), at: 1 } : { error: 'refused' }),
        accessPlan: vi.fn(),
        accessRun: vi.fn()
      }
    })
    render(<KeyRevokePanel servers={[SERVER, OTHER]} />)

    const note = await screen.findByTestId('revoke-unchecked')
    expect(note.textContent).toContain('web-1')
    expect(note.textContent).toMatch(/may also be on/)
  })

  it('names the accounts before the button, not after it', async () => {
    allowKeyWrites(true)
    stubBridge({
      fleet: {
        access: async () => ({ access: access(), at: 1 }),
        accessPlan: vi.fn(async () => PREVIEW),
        accessRun: vi.fn()
      }
    })
    render(<KeyRevokePanel servers={[SERVER]} />)
    await userEvent.click(await screen.findByTestId(`pick-${FP}`))

    expect((await screen.findByTestId('revoke-targets')).textContent).toContain('db-01')
  })

  it('stages rather than applies, and sends back the command it displayed', async () => {
    // Both halves of the check that survived the move: the operator is told the
    // server arms its own rollback, and main is handed the command text as it
    // was SHOWN so it can refuse a change nobody agreed to.
    allowKeyWrites(true)
    // The request is typed into the mock rather than cast at the assertion: it
    // is the thing under test, and `vi.fn(async () => ...)` records a call with
    // no arguments as far as TypeScript is concerned.
    const accessRun = vi.fn(async (_req: Record<string, unknown>) => ({
      blocks: [],
      refusals: [],
      notStaged: [],
      reports: []
    }))
    stubBridge({
      fleet: { access: async () => ({ access: access(), at: 1 }), accessPlan: async () => PREVIEW, accessRun }
    })
    render(<KeyRevokePanel servers={[SERVER]} />)

    await userEvent.click(await screen.findByTestId(`pick-${FP}`))
    await userEvent.click(await screen.findByTestId('revoke-plan'))
    const confirm = await screen.findByTestId('revoke-confirm')
    expect(confirm.textContent).toContain('This is staged, not applied')
    expect(confirm.textContent).toContain('arms its OWN rollback')
    expect(accessRun).not.toHaveBeenCalled()

    await userEvent.click(await screen.findByTestId('revoke-go'))
    await waitFor(() => expect(accessRun).toHaveBeenCalled())
    expect(accessRun.mock.calls[0][0]).toMatchObject({
      kind: 'revoke',
      fingerprint: FP,
      token: PREVIEW.token,
      confirmedCommand: PREVIEW.command
    })
  })
})

describe('changing a schedule, now that it lives in Operations', () => {
  it('arrives filled in from a jump, and plans nothing until asked', async () => {
    const stub = cronBridge()
    stubBridge(stub)
    render(<CronEditPanel servers={[SERVER]} />)
    useNav.setState({
      operationsJump: {
        kind: 'cron-edit',
        serverId: SERVER.id,
        line: userJob.line,
        schedule: userJob.schedule,
        command: userJob.command,
        input: userJob.input,
        nonce: 99
      }
    })

    expect(await screen.findByDisplayValue('/usr/bin/backup --all')).toBeTruthy()
    expect((stub.cron as { planEdit: ReturnType<typeof vi.fn> }).planEdit).not.toHaveBeenCalled()
  })

  it('will not write until the word is typed, and then sends main’s own bytes', async () => {
    const stub = cronBridge()
    stubBridge(stub)
    render(<CronEditPanel servers={[SERVER]} />)
    useNav.setState({
      operationsJump: {
        kind: 'cron-edit',
        serverId: SERVER.id,
        line: userJob.line,
        schedule: userJob.schedule,
        command: userJob.command,
        input: userJob.input,
        nonce: 101
      }
    })
    await screen.findByDisplayValue('/usr/bin/backup --all')
    await userEvent.click(await screen.findByRole('button', { name: /review change/i }))
    await screen.findByText(/change `0 3 \* \* \* \/usr\/bin\/backup --all`/)

    const apply = await screen.findByTestId('cron-apply')
    expect(apply.hasAttribute('disabled')).toBe(true)
    expect((stub.cron as { write: ReturnType<typeof vi.fn> }).write).not.toHaveBeenCalled()

    await userEvent.type(await screen.findByPlaceholderText('Type RUN'), 'RUN')
    await userEvent.click(apply)
    await waitFor(() =>
      expect((stub.cron as { write: ReturnType<typeof vi.fn> }).write).toHaveBeenCalled()
    )
    const [target, req] = (stub.cron as { write: ReturnType<typeof vi.fn> }).write.mock.calls[0]
    expect(target.serverId).toBe(SERVER.id)
    expect(req.before).toBe('0 3 * * * /usr/bin/backup --all\n')
    expect(req.token).toBe(TOKEN)
    // The record is what a human was asked and what they answered. The command
    // in it is main's, so an edited command is a command that does not match.
    expect(req.approval.commands).toEqual([CRON_COMMAND])
    expect(req.approval.phrase).toBe('RUN')
  })

  it('carries the stdin through an update rather than dropping it', async () => {
    const stub = cronBridge()
    stubBridge(stub)
    render(<CronEditPanel servers={[SERVER]} />)
    useNav.setState({
      operationsJump: {
        kind: 'cron-edit',
        serverId: SERVER.id,
        line: userJob.line,
        schedule: userJob.schedule,
        command: userJob.command,
        input: userJob.input,
        nonce: 103
      }
    })
    await screen.findByDisplayValue('/usr/bin/backup --all')
    await userEvent.click(await screen.findByRole('button', { name: /review change/i }))

    await waitFor(() =>
      expect((stub.cron as { planEdit: ReturnType<typeof vi.fn> }).planEdit).toHaveBeenCalled()
    )
    const [, req] = (stub.cron as { planEdit: ReturnType<typeof vi.fn> }).planEdit.mock.calls[0]
    expect(req).toMatchObject({ op: 'update', line: userJob.line, input: 'stdin for the job' })
  })

  it('warns when a missing final newline is about to be added for it', async () => {
    // Without it the new job would be glued onto the end of the previous one,
    // which is a change to a line nobody edited. Main reports it; the panel has
    // to say it rather than quietly benefiting from it.
    stubBridge(
      cronBridge({
        planEdit: vi.fn(async () => ({
          ok: true,
          before: '0 3 * * * /usr/bin/backup --all',
          after: '0 3 * * * /usr/bin/backup --all\n0 4 * * * /usr/bin/tidy\n',
          summary: 'add `0 4 * * * /usr/bin/tidy`',
          addedFinalNewline: true,
          token: TOKEN,
          command: CRON_COMMAND
        }))
      })
    )
    render(<CronEditPanel servers={[SERVER]} />)
    await userEvent.selectOptions(await screen.findByLabelText('Server'), SERVER.id)
    await userEvent.click(await screen.findByRole('button', { name: /read this server/i }))
    await userEvent.click(await screen.findByRole('button', { name: /add job/i }))
    await userEvent.type(screen.getByLabelText('Command'), '/usr/bin/tidy')
    await userEvent.click(screen.getByRole('button', { name: /review change/i }))

    expect((await screen.findByText(/no newline at the end/)).textContent).toContain('glued onto')
  })

  it('tells the operator where the previous crontab is, and re-reads the server', async () => {
    const stub = cronBridge()
    stubBridge(stub)
    render(<CronEditPanel servers={[SERVER]} />)
    useNav.setState({
      operationsJump: {
        kind: 'cron-edit',
        serverId: SERVER.id,
        line: userJob.line,
        schedule: userJob.schedule,
        command: userJob.command,
        nonce: 107
      }
    })
    await screen.findByDisplayValue('/usr/bin/backup --all')
    await userEvent.click(await screen.findByRole('button', { name: /review change/i }))
    await userEvent.type(await screen.findByPlaceholderText('Type RUN'), 'RUN')
    await userEvent.click(await screen.findByTestId('cron-apply'))

    await screen.findByText(/\.opsmaxx-crontab-20260903T101112Z-a1b2c3\.bak/)
    // Read again rather than patched from what we sent: the host is the only
    // thing that knows what its crontab says now.
    await waitFor(() =>
      expect((stub.cron as { collect: ReturnType<typeof vi.fn> }).collect).toHaveBeenCalledTimes(2)
    )
  })

  it('shows main’s refusal rather than a generic failure', async () => {
    stubBridge(
      cronBridge({
        planEdit: vi.fn(async () => ({
          ok: false,
          reason: '`0 3 * * * /usr/bin/backup --all` is not in this crontab any more.'
        }))
      })
    )
    render(<CronEditPanel servers={[SERVER]} />)
    useNav.setState({
      operationsJump: {
        kind: 'cron-edit',
        serverId: SERVER.id,
        line: userJob.line,
        schedule: userJob.schedule,
        command: userJob.command,
        nonce: 109
      }
    })
    await screen.findByDisplayValue('/usr/bin/backup --all')
    await userEvent.click(await screen.findByRole('button', { name: /review change/i }))

    expect(await screen.findByText(/not in this crontab any more/)).toBeTruthy()
  })

  it('refuses a host whose own crontab was only partly read, and says what a write would do', async () => {
    stubBridge(
      cronBridge({
        collect: vi.fn(async () => cronRows([{ id: 'user-crontab', label: 'crontab', status: 'denied' }]))
      })
    )
    render(<CronEditPanel servers={[SERVER]} />)
    useNav.setState({
      operationsJump: { kind: 'unit-install', serverId: SERVER.id, nonce: 105 }
    })
    // Chosen by hand rather than by a jump, because this is the case where
    // there is nothing to jump to.
    await userEvent.selectOptions(await screen.findByLabelText('Server'), SERVER.id)
    await userEvent.click(await screen.findByRole('button', { name: /read this server/i }))

    const note = await screen.findByTestId('cron-unreadable')
    expect(note.textContent).toMatch(/replaces the whole file/)
    expect(screen.queryByRole('button', { name: /add job/i })).toBeNull()
  })
})

describe('installing a unit, now that it lives in Operations', () => {
  it('does not write when the question is answered no', async () => {
    const write = vi.fn()
    stubBridge({ services: { write } })
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<UnitInstallPanel servers={[SERVER]} />)

    await userEvent.selectOptions(await screen.findByLabelText('Server'), SERVER.id)
    await userEvent.type(screen.getByLabelText('Unit name'), 'worker.service')
    await userEvent.type(screen.getByLabelText('Description'), 'The worker')
    await userEvent.type(screen.getByLabelText('ExecStart'), '/usr/local/bin/worker')
    await userEvent.click(screen.getByTestId('install-go'))

    expect(window.confirm).toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    vi.mocked(window.confirm).mockRestore()
  })

  it('asks with the unit and the host in the question, then writes', async () => {
    const write = vi.fn(async () => ({ ok: true, output: 'Created worker.service' }))
    stubBridge({ services: { write } })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<UnitInstallPanel servers={[SERVER]} />)

    await userEvent.selectOptions(await screen.findByLabelText('Server'), SERVER.id)
    await userEvent.type(screen.getByLabelText('Unit name'), 'worker.service')
    await userEvent.type(screen.getByLabelText('Description'), 'The worker')
    await userEvent.type(screen.getByLabelText('ExecStart'), '/usr/local/bin/worker')
    await userEvent.click(screen.getByTestId('install-go'))

    // `confirm` is typed with an optional argument, so its recorded call is an
    // empty tuple as far as TypeScript is concerned. The string is what the
    // operator was asked, and asserting on it is the point of the test.
    const asked = (vi.mocked(window.confirm).mock.calls[0] as unknown as string[])[0]
    expect(asked).toContain('worker.service')
    expect(asked).toContain('db-01')
    await waitFor(() => expect(write).toHaveBeenCalled())
    vi.mocked(window.confirm).mockRestore()
  })

  it('shows the exact file, and offers nothing to press for a draft the server would reject', async () => {
    stubBridge({ services: { write: vi.fn() } })
    render(<UnitInstallPanel servers={[SERVER]} />)
    await userEvent.selectOptions(await screen.findByLabelText('Server'), SERVER.id)

    // A name with no ExecStart is not installable, and the panel says which
    // rule it broke rather than disabling a button silently.
    await userEvent.type(screen.getByLabelText('Unit name'), 'worker.service')
    expect(screen.getByTestId('install-go').hasAttribute('disabled')).toBe(true)

    await userEvent.type(screen.getByLabelText('Description'), 'The worker')
    await userEvent.type(screen.getByLabelText('ExecStart'), '/usr/local/bin/worker')
    expect(screen.getByTestId('install-go').hasAttribute('disabled')).toBe(false)
    expect(screen.getByText(/ExecStart=\/usr\/local\/bin\/worker/)).toBeTruthy()
  })
})
