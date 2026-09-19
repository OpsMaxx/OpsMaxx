// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  PipelineBrowser,
  groupPipelines
} from '../src/renderer/src/components/cicd/PipelineBrowser'
import type { CicdBridge, CicdConnection, CicdPipeline, CicdRun } from '../src/shared/cicd'

/**
 * The inventory half of the module.
 *
 * The Activity feed answers "is anything broken" over a 24-hour window, which
 * means a job that last ran a month ago is invisible on it. Pointed at a real
 * Jenkins with four jobs -- three built 13 hours earlier, one 35 days earlier --
 * the panel was blank and there was no screen anywhere in OpsMaxx that would
 * name those jobs. These pin the screen that fixes that.
 */

const CONN: CicdConnection = {
  id: 'c1',
  workspaceId: 'w1',
  name: 'Jenkins',
  provider: 'jenkins',
  baseUrl: 'https://ci.example.com',
  vaultEntryId: 'v1',
  route: { kind: 'direct' },
  enabled: true
}

function pipeline(over: Partial<CicdPipeline> = {}): CicdPipeline {
  return { connectionId: 'c1', ref: 'job/trivy', name: 'trivy', groupPath: [], triggerable: true, ...over }
}

function run(over: Partial<CicdRun> = {}): CicdRun {
  return {
    connectionId: 'c1',
    pipelineRef: 'job/trivy',
    id: '17',
    attempt: 1,
    label: '#17',
    outcome: { status: 'success' as const },
    startedAt: Date.now() - 13 * 3_600_000,
    ...over
  }
}

function bridge(over: Partial<CicdBridge> = {}): CicdBridge {
  return {
    recentRuns: vi.fn(async () => [run()]),
    getConfig: vi.fn(async () => ({ kind: 'xml' as const, text: '<flow-definition/>', path: 'job/trivy/config.xml' })),
    setJobEnabled: vi.fn(async () => ({ note: 'Asked Jenkins to disable the job.' })),
    listParams: vi.fn(async () => []),
    trigger: vi.fn(async () => ({ note: 'Jenkins has queued it.' })),
    ...over
  } as unknown as CicdBridge
}

const noop = (): void => {}

beforeEach(() => vi.clearAllMocks())

describe('grouping the flat list', () => {
  it('nests by groupPath without asking a provider for anything', () => {
    const tree = groupPipelines([
      pipeline({ ref: 'a', name: 'a', groupPath: [{ id: 'f', label: 'folder' }] }),
      pipeline({ ref: 'b', name: 'b', groupPath: [{ id: 'f', label: 'folder' }] }),
      pipeline({ ref: 'c', name: 'c', groupPath: [] })
    ])
    expect(tree.pipelines.map((p) => p.name)).toEqual(['c'])
    expect(tree.children).toHaveLength(1)
    expect(tree.children[0].pipelines.map((p) => p.name)).toEqual(['a', 'b'])
  })

  it('carries the ghost flag through', () => {
    const tree = groupPipelines([
      pipeline({ groupPath: [{ id: 'g', label: 'acme', ghost: true }] })
    ])
    expect(tree.children[0].ghost).toBe(true)
  })
})

describe('what the browser shows', () => {
  it('lists a pipeline that has never run', async () => {
    // The whole point. `last` is absent until a run has been read, and the
    // Activity feed drops it entirely; here it is a row with a word on it.
    render(
      <PipelineBrowser
        connections={[CONN]}
        pipelines={[pipeline({ ref: 'job/dso', name: 'dso-scanner-update' })]}
        bridge={bridge()}
        onOpenRun={noop}
      />
    )
    expect(await screen.findByText('dso-scanner-update')).toBeTruthy()
    expect(screen.getByText('never run')).toBeTruthy()
  })

  it('lists every job, not only the recently active ones', () => {
    const names = ['dso-scanner-update', 'semgrep', 'trivy', 'trufflehog']
    render(
      <PipelineBrowser
        connections={[CONN]}
        pipelines={names.map((n, i) => pipeline({ ref: `job/${n}`, name: n, last: i === 0 ? undefined : run() }))}
        bridge={bridge()}
        onOpenRun={noop}
      />
    )
    for (const n of names) expect(screen.getByText(n)).toBeTruthy()
  })

  it('renders a ghost level as something you cannot press', () => {
    // A ghost segment is a level whose name is visible and whose contents are
    // not. Making it a button is a link to a 403.
    render(
      <PipelineBrowser
        connections={[CONN]}
        pipelines={[pipeline({ groupPath: [{ id: 'g', label: 'acme', ghost: true }] })]}
        bridge={bridge()}
        onOpenRun={noop}
      />
    )
    const ghost = screen.getByText('acme')
    expect(ghost.closest('button')).toBeNull()
    // And its children are not reachable through it either.
    expect(screen.queryByText('trivy')).toBeNull()
  })

  it('filters by name and by path', async () => {
    const user = userEvent.setup()
    render(
      <PipelineBrowser
        connections={[CONN]}
        pipelines={[pipeline({ ref: 'a', name: 'trivy' }), pipeline({ ref: 'b', name: 'semgrep' })]}
        bridge={bridge()}
        onOpenRun={noop}
      />
    )
    await user.type(screen.getByLabelText('Filter pipelines'), 'sem')
    expect(screen.queryByText('trivy')).toBeNull()
    expect(screen.getByText('semgrep')).toBeTruthy()
  })
})

describe('the detail pane', () => {
  it('shows build history and opens a run when one is clicked', async () => {
    const user = userEvent.setup()
    const onOpenRun = vi.fn()
    render(
      <PipelineBrowser
        connections={[CONN]}
        pipelines={[pipeline()]}
        bridge={bridge()}
        onOpenRun={onOpenRun}
      />
    )
    await user.click(screen.getByText('trivy'))
    await user.click(await screen.findByText('#17'))
    expect(onOpenRun).toHaveBeenCalledWith('c1', 'job/trivy', expect.objectContaining({ id: '17' }))
  })

  it('reads the definition only when asked, and says it is read-only', async () => {
    const user = userEvent.setup()
    const b = bridge()
    render(
      <PipelineBrowser connections={[CONN]} pipelines={[pipeline()]} bridge={b} onOpenRun={noop} />
    )
    await user.click(screen.getByText('trivy'))
    // Opening a job to look at its last build must not pull a whole file.
    expect(b.getConfig).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: /show/i }))
    await waitFor(() => expect(b.getConfig).toHaveBeenCalledWith('c1', 'job/trivy'))
    expect(await screen.findByText(/Read-only, as the provider stores it/)).toBeTruthy()
  })

  it('greys the definition with its reason when the provider has none', async () => {
    const user = userEvent.setup()
    const partial = bridge()
    delete (partial as unknown as Record<string, unknown>).getConfig
    render(
      <PipelineBrowser
        connections={[CONN]}
        pipelines={[pipeline()]}
        bridge={partial}
        onOpenRun={noop}
      />
    )
    await user.click(screen.getByText('trivy'))
    const show = screen.getByRole('button', { name: /show/i })
    expect(show.hasAttribute('disabled')).toBe(true)
    expect(show.getAttribute('title')).toContain('cannot read a pipeline definition')
  })

  it('says why when reading the definition fails, rather than showing an empty box', async () => {
    const user = userEvent.setup()
    const b = bridge({
      getConfig: vi.fn(async () => {
        throw new Error('Jenkins redirected to a login page, so it did not accept the API token.')
      })
    })
    render(
      <PipelineBrowser connections={[CONN]} pipelines={[pipeline()]} bridge={b} onOpenRun={noop} />
    )
    await user.click(screen.getByText('trivy'))
    await user.click(screen.getByRole('button', { name: /show/i }))
    expect(await screen.findByText(/did not accept the API token/)).toBeTruthy()
  })

  it('degrades when the preload half is older than this panel', async () => {
    const user = userEvent.setup()
    const partial = bridge()
    delete (partial as unknown as Record<string, unknown>).recentRuns
    render(
      <PipelineBrowser
        connections={[CONN]}
        pipelines={[pipeline()]}
        bridge={partial}
        onOpenRun={noop}
      />
    )
    await user.click(screen.getByText('trivy'))
    expect(await screen.findByText(/cannot read build history/)).toBeTruthy()
  })
})

describe('the write half, which is a separate grant', () => {
  const open = async (
    canTrigger: boolean,
    b = bridge(),
    over: Partial<CicdPipeline> = {},
    connection: CicdConnection = CONN
  ): Promise<void> => {
    const user = userEvent.setup()
    render(
      <PipelineBrowser
        connections={[connection]}
        pipelines={[pipeline(over)]}
        bridge={b}
        canTrigger={canTrigger}
        onOpenRun={noop}
      />
    )
    await user.click(screen.getByText('trivy'))
  }

  const toggle = (): HTMLElement => screen.getByTestId('cicd-job-toggle')

  it('shows no write control at all when cicdTrigger is off', async () => {
    // Not greyed -- absent. A disabled Disable button on a screen the user has
    // read access to is an invitation to go looking for the switch.
    await open(false)
    expect(screen.queryByTestId('cicd-job-toggle')).toBeNull()
    expect(screen.queryByRole('button', { name: /build/i })).toBeNull()
    // The read half is unaffected.
    expect(screen.getByRole('button', { name: /show/i })).toBeTruthy()
  })

  /**
   * The label, and the whole reason this control was rewritten.
   *
   * Two always-present buttons called "Disable" and "Enable" said nothing about
   * WHAT they enabled -- the operator read them as switches on the OpsMaxx side
   * -- and nothing about which state the job was actually in. One button whose
   * text is the verb it is about to perform answers both.
   */
  it('names the job and the controller, not just the verb', async () => {
    await open(true)
    expect(toggle().textContent).toContain('Disable this job in Jenkins')
  })

  it('offers Enable, not Disable, for a job Jenkins reports as not buildable', async () => {
    // `triggerable` IS `buildable` for Jenkins. A control that reads the state
    // is the only thing that can show the write landed.
    await open(true, bridge(), { triggerable: false })
    expect(toggle().textContent).toContain('Enable this job in Jenkins')
    expect(screen.getByTestId('cicd-job-state').textContent).toContain('disabled')
  })

  it('states the job state in words beside the button', async () => {
    await open(true)
    expect(screen.getByTestId('cicd-job-state').textContent).toContain('buildable')
  })

  it('is absent for a provider that has no such verb', async () => {
    // `setJobEnabled` in main refuses GitHub and GitLab BY NAME, so offering
    // the control is offering a screen that can only fail.
    await open(true, bridge(), {}, { ...CONN, provider: 'github' })
    expect(screen.queryByTestId('cicd-job-toggle')).toBeNull()
    expect(screen.queryByTestId('cicd-job-state')).toBeNull()
    // Starting a run is not Jenkins-only and stays.
    expect(screen.getByRole('button', { name: /build/i })).toBeTruthy()
  })

  it('will not disable a job on one press', async () => {
    // Disabling is the quiet destructive one: no failure, no alert, the next
    // commit simply never builds.
    const user = userEvent.setup()
    const b = bridge()
    await open(true, b)
    await user.click(toggle())
    expect(b.setJobEnabled).not.toHaveBeenCalled()
    expect(screen.getByText(/produces no failure and no alert/)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: /disable it/i }))
    expect(b.setJobEnabled).toHaveBeenCalledWith('c1', 'job/trivy', false)
  })

  it('lets the confirm be backed out of', async () => {
    const user = userEvent.setup()
    const b = bridge()
    await open(true, b)
    await user.click(toggle())
    await user.click(screen.getByRole('button', { name: /keep it on/i }))
    expect(b.setJobEnabled).not.toHaveBeenCalled()
  })

  it('enables without a confirm, because turning it back on breaks nothing', async () => {
    const user = userEvent.setup()
    const b = bridge()
    await open(true, b, { triggerable: false })
    await user.click(toggle())
    expect(b.setJobEnabled).toHaveBeenCalledWith('c1', 'job/trivy', true)
  })

  it('reports the provider note verbatim, including a failure', async () => {
    const user = userEvent.setup()
    const b = bridge({
      setJobEnabled: vi.fn(async () => {
        throw new Error('Jenkins returned 403.')
      })
    })
    await open(true, b, { triggerable: false })
    await user.click(toggle())
    expect(await screen.findByText(/Jenkins returned 403/)).toBeTruthy()
  })

  it('greys the controls when the preload half cannot do it', async () => {
    const partial = bridge()
    delete (partial as unknown as Record<string, unknown>).setJobEnabled
    await open(true, partial)
    expect(toggle().hasAttribute('disabled')).toBe(true)
    expect(toggle().getAttribute('title')).toContain('cannot enable or disable a job')
  })

  /**
   * Build with parameters, on the pipeline it belongs to.
   *
   * The Operations rail already had this dialog; what it did not have was a way
   * to reach it from the job you were looking at. Same modal, same module gate.
   */
  it('opens the parameter form for the pipeline in view', async () => {
    const user = userEvent.setup()
    const b = bridge({
      listParams: vi.fn(async () => [
        { key: 'RELEASE_NOTES', label: 'RELEASE_NOTES', type: 'text' as const, required: false },
        { key: 'DRY_RUN', label: 'DRY_RUN', type: 'boolean' as const, required: false, default: 'true' }
      ])
    })
    await open(true, b)
    await user.click(screen.getByRole('button', { name: /build/i }))
    expect(b.listParams).toHaveBeenCalledWith('c1', 'job/trivy')
    expect(await screen.findByText(/RELEASE_NOTES/)).toBeTruthy()
    // Jenkins has no ref, so the dialog must not demand one before it will
    // start -- that block made every Jenkins build unreachable from here.
    expect(screen.queryByText(/Name the branch, tag or commit/)).toBeNull()
    expect(screen.queryByText(/Run against/)).toBeNull()
  })

  it('will not offer to build a job Jenkins has disabled', async () => {
    await open(true, bridge(), { triggerable: false })
    const build = screen.getByRole('button', { name: /build/i })
    expect(build.hasAttribute('disabled')).toBe(true)
    expect(build.getAttribute('title')).toContain('disabled')
  })
})
