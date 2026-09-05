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
