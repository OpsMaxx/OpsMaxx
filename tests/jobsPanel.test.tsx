// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { JobsPanel } from '../src/renderer/src/components/monitor/JobsPanel'
import type { Server } from '../src/renderer/src/types'

// Item 33. Rendered rather than read, because the rule this panel has to keep
// is not visible in a source regex: it must ask for the confirmation `planJob`
// demands and not one it picked for itself. ComposePanel decided for itself and
// item 35 had to fix it.

const server = (i: number): Server => ({
  id: `s${i}`,
  workspaceId: 'ws-default',
  folderId: null,
  name: `web-${i}`,
  host: `web-${i}.internal`,
  port: 22,
  username: 'ops',
  auth: 'key',
  status: 'online',
  tags: [],
  favorite: false,
  os: 'linux',
  route: [],
  vpnProfileId: null
})

function jobsStub(): Record<string, unknown> {
  return {
    jobs: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
      run: vi.fn(async () => ({ id: 'job-1' })),
      cancel: vi.fn(async () => true),
      onProgress: vi.fn(() => () => {}),
      onOutput: vi.fn(() => () => {})
    }
  }
}

async function compose(
  stub: Record<string, unknown>,
  servers: Server[],
  fields: { title: string; steps: string; pick: number[]; wave?: number }
): Promise<void> {
  stubBridge(stub)
  render(<JobsPanel servers={servers} />)
  await userEvent.click(screen.getByRole('button', { name: /New job/ }))
  await userEvent.type(screen.getByLabelText('Job title'), fields.title)
  await userEvent.type(screen.getByLabelText('Steps'), fields.steps)
  for (const i of fields.pick) await userEvent.click(screen.getByRole('button', { name: `web-${i}` }))
  if (fields.wave !== undefined) {
    const w = screen.getByLabelText('Servers per wave')
    await userEvent.clear(w)
    await userEvent.type(w, String(fields.wave))
  }
}

const runOf = (stub: Record<string, unknown>): ReturnType<typeof vi.fn> =>
  (stub.jobs as { run: ReturnType<typeof vi.fn> }).run

describe('the composer asks for the confirmation the plan demands', () => {
  const twelve = Array.from({ length: 12 }, (_, i) => server(i))

  it('makes twelve servers at once be typed out, and runs nothing until it is', async () => {
    const stub = jobsStub()
    await compose(stub, twelve, {
      title: 'Restart nginx',
      steps: 'systemctl restart nginx',
      pick: [...twelve.keys()]
    })
    await userEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => screen.getByRole('button', { name: 'Run' }))
    // The dialog is up, the phrase is not typed, and nothing has started.
    expect(runOf(stub)).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(true)

    await userEvent.type(screen.getByLabelText(/Type RUN to confirm/), 'RUN')
    await userEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(runOf(stub)).toHaveBeenCalled())
  })

  it('asks for less when waves make the blast radius smaller, because that is what a wave is', async () => {
    const stub = jobsStub()
    await compose(stub, twelve, {
      title: 'Restart nginx',
      steps: 'systemctl restart nginx',
      pick: [...twelve.keys()],
      wave: 3
    })
    await userEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => screen.getByRole('button', { name: 'Run' }))
    // Twelve servers three at a time is a blast radius of three, so no phrase.
    expect(screen.queryByLabelText(/Type RUN to confirm/)).toBeNull()
    expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('carries the wave labels into the targets, which is what sized the confirmation', async () => {
    const stub = jobsStub()
    await compose(stub, twelve, {
      title: 'Restart nginx',
      steps: 'systemctl restart nginx',
      pick: [...twelve.keys()],
      wave: 3
    })
    await userEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => screen.getByRole('button', { name: 'Run' }))
    await userEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(runOf(stub)).toHaveBeenCalled())
    const req = runOf(stub).mock.calls[0][0] as {
      targets: { cohort?: string }[]
      approval: { confirmedAt: number }
    }
    expect(new Set(req.targets.map((t) => t.cohort)).size).toBe(4)
    // An approval record minted over this spec and this target list, which main
    // re-derives and refuses if it disagrees.
    expect(req.approval.confirmedAt).toBeGreaterThan(0)
  })

  it('runs nothing when the operator goes back instead of confirming', async () => {
    const stub = jobsStub()
    await compose(stub, twelve, {
      title: 'Restart nginx',
      steps: 'systemctl restart nginx',
      pick: [0, 1]
    })
    await userEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => screen.getByRole('button', { name: 'Back' }))
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(runOf(stub)).not.toHaveBeenCalled()
  })
})

describe('what it refuses to compose, out loud', () => {
  it('says why rather than greying a button with no explanation', async () => {
    const stub = jobsStub()
    stubBridge(stub)
    render(<JobsPanel servers={[server(0)]} />)
    await userEvent.click(screen.getByRole('button', { name: /New job/ }))
    // Nothing typed yet: the reason is on screen, and Review is not available.
    expect(document.body.textContent).toContain('Give the job a title')
    expect((screen.getByRole('button', { name: 'Review' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('refuses a health gate that would never gate anything', async () => {
    // The operator who ticked it believes they are protected. That is the
    // failure worth a sentence.
    const stub = jobsStub()
    const two = [server(0), server(1)]
    await compose(stub, two, { title: 'Patch', steps: 'dnf -y update', pick: [0, 1] })
    await userEvent.click(screen.getByLabelText(/Hold each wave/))
    expect(document.body.textContent).toContain('needs more than one wave')
    expect((screen.getByRole('button', { name: 'Review' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('declares a reboot on the step rather than leaving it to be sniffed', async () => {
    const stub = jobsStub()
    await compose(stub, [server(0)], {
      title: 'Patch and restart',
      steps: 'dnf -y update\nreboot',
      pick: [0]
    })
    await userEvent.click(screen.getByLabelText(/last step restarts the machine/))
    await userEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => screen.getByRole('button', { name: 'Run' }))
    // Said on screen before it is agreed to.
    expect(document.body.textContent).toContain('declared: restarts the machine')
    // And a declared reboot is destructive, so it has to be typed out.
    expect(screen.getByLabelText(/Type RUN to confirm/)).toBeTruthy()
  })
})

describe('the list', () => {
  it('does not draw an empty list as "you have never run a job" before asking', async () => {
    stubBridge(jobsStub())
    render(<JobsPanel servers={[server(0)]} />)
    expect(document.body.textContent).toContain('Nothing read yet')
    expect(document.body.textContent).not.toContain('No jobs have run')
  })

  it('offers to stop a job that is still running, and not one that has finished', async () => {
    const stub = jobsStub()
    ;(stub.jobs as { list: ReturnType<typeof vi.fn> }).list = vi.fn(async () => [
      { id: 'j1', title: 'Running one', state: 'running', risk: 'ordinary', spec: { steps: [] } },
      { id: 'j2', title: 'Finished one', state: 'done', risk: 'ordinary', spec: { steps: [] } }
    ])
    stubBridge(stub)
    render(<JobsPanel servers={[server(0)]} />)
    await userEvent.click(screen.getByRole('button', { name: /Read jobs/ }))
    await waitFor(() => screen.getByText(/Running one/))
    const stops = screen.getAllByTitle(/Stop this job/)
    expect(stops).toHaveLength(1)
    await userEvent.click(stops[0])
    expect((stub.jobs as { cancel: ReturnType<typeof vi.fn> }).cancel).toHaveBeenCalledWith('j1')
  })
})

// Item 34a, through the panel. The unit test covers the vocabulary; this
// covers that the composer actually uses it -- a builder nothing calls is the
// shape this whole gap audit is about.
describe('the typed service step', () => {
  async function serviceMode(stub: Record<string, unknown>, servers: Server[]): Promise<void> {
    stubBridge(stub)
    render(<JobsPanel servers={servers} />)
    await userEvent.click(screen.getByRole('button', { name: /New job/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Service action' }))
  }

  it('builds the command from an action and a unit, and verifies afterwards', async () => {
    const stub = jobsStub()
    await serviceMode(stub, [server(0)])
    await userEvent.click(screen.getByRole('button', { name: 'web-0' }))
    await userEvent.type(screen.getByLabelText('Unit'), 'nginx')
    await userEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => screen.getByRole('button', { name: 'Run' }))
    // `restart` on one server is elevated, which asks for a click and not a
    // typed phrase. The panel asks for what the plan demands, no more.
    expect(screen.queryByLabelText(/Type RUN to confirm/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(runOf(stub)).toHaveBeenCalled())
    const spec = (runOf(stub).mock.calls[0][0] as { spec: { steps: { command: string }[]; title: string } }).spec
    expect(spec.title).toBe('Restart nginx.service')
    expect(spec.steps[0].command).toBe("sudo -n systemctl restart 'nginx.service'")
    // `systemctl restart` exits 0 having asked. The second step is the answer.
    expect(spec.steps[1].command).toContain("is-active 'nginx.service'")
  })

  it('will not build a restart of the service it reaches the server through', async () => {
    const stub = jobsStub()
    await serviceMode(stub, [server(0)])
    await userEvent.click(screen.getByRole('button', { name: 'web-0' }))
    await userEvent.type(screen.getByLabelText('Unit'), 'sshd')
    expect(document.body.textContent).toContain('cut the connection')
    expect((screen.getByRole('button', { name: 'Review' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('checks the unit against what the picked servers reported, when they have', async () => {
    const { useFleet } = await import('../src/renderer/src/store/fleet')
    useFleet.setState({
      hosts: {
        s0: {
          services: [{ name: 'nginx.service', active: 'active', sub: 'running' }]
        } as never
      }
    })
    const stub = jobsStub()
    await serviceMode(stub, [server(0)])
    await userEvent.click(screen.getByRole('button', { name: 'web-0' }))
    await userEvent.type(screen.getByLabelText('Unit'), 'ngnix')
    // A misspelt unit is a job that fails on every server at once, and the
    // failure reads as an outage rather than a typo.
    expect(document.body.textContent).toContain('has reported a unit called')
    expect((screen.getByRole('button', { name: 'Review' }) as HTMLButtonElement).disabled).toBe(true)
    useFleet.setState({ hosts: {} })
  })

  it('does not treat "never sampled" as "runs no units"', async () => {
    const { useFleet } = await import('../src/renderer/src/store/fleet')
    useFleet.setState({ hosts: {} })
    const stub = jobsStub()
    await serviceMode(stub, [server(0)])
    await userEvent.click(screen.getByRole('button', { name: 'web-0' }))
    await userEvent.type(screen.getByLabelText('Unit'), 'anything')
    expect(document.body.textContent).toContain('not checked against anything')
    expect((screen.getByRole('button', { name: 'Review' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

// Item 44, through the panel.
describe('rolling a job back', () => {
  const withRollback = {
    id: 'j9',
    title: 'Restart nginx',
    state: 'done',
    risk: 'elevated',
    spec: { steps: [{ command: 'systemctl restart nginx' }], rollback: [{ command: 'systemctl stop nginx' }] }
  }

  async function listing(stub: Record<string, unknown>, rows: unknown[]): Promise<void> {
    ;(stub.jobs as { list: ReturnType<typeof vi.fn> }).list = vi.fn(async () => rows)
    stubBridge(stub)
    render(<JobsPanel servers={[server(0)]} />)
    await userEvent.click(screen.getByRole('button', { name: /Read jobs/ }))
    await waitFor(() => screen.getByText(/Restart nginx/))
  }

  it('offers it only on a job that has one, and only once that job has stopped', async () => {
    const stub = jobsStub()
    await listing(stub, [
      withRollback,
      { ...withRollback, id: 'j8', title: 'Still going', state: 'running' },
      { id: 'j7', title: 'No undo', state: 'done', risk: 'ordinary', spec: { steps: [] } }
    ])
    // Rolling back underneath a run that is still going is two jobs racing on
    // one server.
    expect(screen.getAllByRole('button', { name: /Roll back/ })).toHaveLength(1)
  })

  it('asks again before running it, and never runs it from the click alone', async () => {
    const stub = jobsStub()
    await listing(stub, [withRollback])
    await userEvent.click(screen.getByRole('button', { name: /Roll back/ }))
    await waitFor(() => screen.getByRole('button', { name: 'Run' }))
    expect(runOf(stub)).not.toHaveBeenCalled()
    // Graded on the ROLLBACK's own commands: undoing a start with a stop is
    // still a stop, and `systemctl stop` is destructive.
    expect(screen.getByLabelText(/Type RUN to confirm/)).toBeTruthy()
  })

  it('runs the rollback steps as their own job once confirmed', async () => {
    const stub = jobsStub()
    await listing(stub, [withRollback])
    await userEvent.click(screen.getByRole('button', { name: /Roll back/ }))
    await waitFor(() => screen.getByRole('button', { name: 'Run' }))
    await userEvent.type(screen.getByLabelText(/Type RUN to confirm/), 'RUN')
    await userEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(runOf(stub)).toHaveBeenCalled())
    const req = runOf(stub).mock.calls[0][0] as { spec: { steps: { command: string }[]; title: string } }
    expect(req.spec.steps.map((s) => s.command)).toEqual(['systemctl stop nginx'])
    expect(req.spec.title).toContain('Roll back')
  })
})

// Item 34b, through the panel.
describe('the typed package step', () => {
  async function packageMode(stub: Record<string, unknown>): Promise<void> {
    stubBridge(stub)
    render(<JobsPanel servers={[server(0)]} />)
    await userEvent.click(screen.getByRole('button', { name: /New job/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Package' }))
    await userEvent.click(screen.getByRole('button', { name: 'web-0' }))
  }

  it('builds the command for the chosen manager, and verifies afterwards', async () => {
    const stub = jobsStub()
    await packageMode(stub)
    await userEvent.type(screen.getByLabelText('Packages'), 'nginx')
    await userEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => screen.getByRole('button', { name: 'Run' }))
    await userEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(runOf(stub)).toHaveBeenCalled())
    const spec = (runOf(stub).mock.calls[0][0] as { spec: { steps: { command: string }[] } }).spec
    expect(spec.steps[0].command).toContain("apt-get -y -o Dpkg::Options::=--force-confdef")
    expect(spec.steps[0].command).toContain("'nginx'")
    // `apt-get install` exits 0 having installed nothing when the name matched
    // a virtual package, so the second step asks what is actually there.
    expect(spec.steps[1].command).toContain('dpkg-query')
  })

  it('says a manager cannot hold rather than building a command that does nothing', async () => {
    const stub = jobsStub()
    await packageMode(stub)
    await userEvent.selectOptions(screen.getByLabelText('Package action'), 'hold')
    await userEvent.selectOptions(screen.getByLabelText('Package manager'), 'apk')
    await userEvent.type(screen.getByLabelText('Packages'), 'nginx')
    expect(document.body.textContent).toContain('no way to hold a package')
    expect((screen.getByRole('button', { name: 'Review' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('refuses a package name that is not one', async () => {
    const stub = jobsStub()
    await packageMode(stub)
    await userEvent.type(screen.getByLabelText('Packages'), 'nginx;')
    expect(document.body.textContent).toContain('is not a package name')
  })

  it('warns that the command is the same on every server picked', async () => {
    // A job is one step list for every server in it, and the approval covers
    // that exact text.
    const stub = jobsStub()
    await packageMode(stub)
    expect(document.body.textContent).toContain('different package manager')
  })
})

// Item 34d, through the panel.
describe('the typed account step', () => {
  async function userMode(stub: Record<string, unknown>): Promise<void> {
    stubBridge(stub)
    render(<JobsPanel servers={[server(0)]} />)
    await userEvent.click(screen.getByRole('button', { name: /New job/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Account' }))
    await userEvent.click(screen.getByRole('button', { name: 'web-0' }))
  }

  it('offers no password field, and says where one would have gone', async () => {
    const stub = jobsStub()
    await userMode(stub)
    expect(screen.queryByLabelText(/password/i)).toBeNull()
    expect(document.body.textContent).toContain('outlives the job')
  })

  it('refuses root, and says it can take away the way back in', async () => {
    const stub = jobsStub()
    await userMode(stub)
    await userEvent.type(screen.getByLabelText('Account'), 'root')
    expect(document.body.textContent).toContain('only way back into a server')
    expect((screen.getByRole('button', { name: 'Review' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('locks the password AND expires the account, because -L alone leaves keys working', async () => {
    const stub = jobsStub()
    await userMode(stub)
    await userEvent.type(screen.getByLabelText('Account'), 'deploy')
    await userEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => screen.getByRole('button', { name: 'Run' }))
    await userEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(runOf(stub)).toHaveBeenCalled())
    const spec = (runOf(stub).mock.calls[0][0] as { spec: { steps: { command: string }[] } }).spec
    expect(spec.steps[0].command).toContain('-L')
    expect(spec.steps[0].command).toContain('-e 1')
  })

  it('asks separately about the home directory, and only for a delete', async () => {
    const stub = jobsStub()
    await userMode(stub)
    expect(screen.queryByLabelText(/remove the home directory/)).toBeNull()
    await userEvent.selectOptions(screen.getByLabelText('Account action'), 'delete')
    expect(screen.getByLabelText(/remove the home directory/)).toBeTruthy()
    expect(document.body.textContent).toContain('nothing puts back')
  })
})

// Item 34c, through the panel.
describe('the typed file push', () => {
  async function fileMode(stub: Record<string, unknown>): Promise<void> {
    stubBridge(stub)
    render(<JobsPanel servers={[server(0)]} />)
    await userEvent.click(screen.getByRole('button', { name: /New job/ }))
    await userEvent.click(screen.getByRole('button', { name: 'File' }))
    await userEvent.click(screen.getByRole('button', { name: 'web-0' }))
  }

  it('carries the bytes and the checksum the server will check them against', async () => {
    const stub = jobsStub()
    await fileMode(stub)
    await userEvent.type(screen.getByLabelText('File path'), '/etc/myapp.conf')
    await userEvent.type(screen.getByLabelText('File contents'), 'hello')
    // sha256("hello")
    const sha = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    await waitFor(() => expect(document.body.textContent).toContain(sha))
    await userEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => screen.getByRole('button', { name: 'Run' }))
    await userEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(runOf(stub)).toHaveBeenCalled())
    const cmd = (runOf(stub).mock.calls[0][0] as { spec: { steps: { command: string }[] } }).spec
      .steps[0].command
    // The bytes, as base64, and the hash the host compares against.
    expect(cmd).toContain(Buffer.from('hello', 'utf8').toString('base64'))
    expect(cmd).toContain(sha)
  })

  it('refuses authorized_keys and points at the screen with a rollback', async () => {
    const stub = jobsStub()
    await fileMode(stub)
    await userEvent.type(screen.getByLabelText('File path'), '/root/.ssh/authorized_keys')
    await userEvent.type(screen.getByLabelText('File contents'), 'x')
    await waitFor(() => expect(document.body.textContent).toContain('puts it back if that fails'))
    expect((screen.getByRole('button', { name: 'Review' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('says it writes a new file only, rather than implying it can replace one', async () => {
    const stub = jobsStub()
    await fileMode(stub)
    expect(document.body.textContent).toContain('Writes a NEW file only')
  })
})
