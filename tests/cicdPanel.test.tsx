// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { useApp } from '../src/renderer/src/store/app'
import userEvent from '@testing-library/user-event'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { stubBridge } from './setup/renderer'
import { CicdPanel } from '../src/renderer/src/components/cicd/CicdPanel'
import { CicdConnectModal } from '../src/renderer/src/components/cicd/CicdConnectModal'
import { CicdRunWorkbench } from '../src/renderer/src/components/cicd/CicdRunWorkbench'
import { CicdTriggerPanel } from '../src/renderer/src/components/cicd/CicdTriggerPanel'
import type {
  CicdBridge,
  CicdConnection,
  CicdPanelState,
  CicdLogChunk,
  CicdPipeline,
  CicdRun
} from '../src/shared/cicd'

// Rendered, not read.
//
// Every defect this suite exists to catch is a defect of PRESENTATION, and in
// this module those are the expensive ones:
//
//  1. A provider we could not reach rendering as green or as red. CI has four
//     native outcomes including "we did not read it", and `src/shared/cicd.ts`
//     calls `unknown` load-bearing for exactly that reason.
//  2. A failed poll emptying the list. Stale rows are the last good answer;
//     no rows at all is a different and wrong claim.
//  3. A trigger that returns no run id rendering as a build. Jenkins hands
//     back a queue item that may never become one.
//  4. A Follow control that disappears on a provider that cannot tail, which
//     teaches the user the product cannot do something.
//
// A source-regex test can see the words exist somewhere in the file. It cannot
// see whether they reach the screen for the case that matters.

const CONN: CicdConnection = {
  id: 'c1',
  workspaceId: 'w1',
  name: 'Platform',
  provider: 'github',
  baseUrl: 'https://github.example.com',
  vaultEntryId: 'v1',
  route: { kind: 'direct' },
  enabled: true
}

function run(over: Partial<CicdRun> = {}): CicdRun {
  return {
    connectionId: 'c1',
    pipelineRef: 'p1',
    id: 'r1',
    attempt: 1,
    label: '#4821',
    outcome: { status: 'success' },
    startedAt: Date.now() - 60_000,
    ...over
  }
}

function pipeline(over: Partial<CicdPipeline> = {}): CicdPipeline {
  return {
    connectionId: 'c1',
    ref: 'p1',
    name: 'deploy',
    groupPath: [{ id: 'g', label: 'acme' }],
    triggerable: true,
    ...over
  }
}

function state(over: Partial<CicdPanelState> = {}): CicdPanelState {
  return {
    connectionId: 'c1',
    readAt: Date.now() - 5_000,
    failures: 0,
    intervalSec: 20,
    pipelines: [pipeline({ last: run() })],
    ...over
  }
}

function bridge(over: Partial<CicdBridge> = {}): CicdBridge {
  return {
    configure: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => [state()]),
    agentRuns: vi.fn(async () => []),
    refresh: vi.fn(async () => undefined),
    getRun: vi.fn(async () => ({ run: {}, steps: [] })),
    createSecret: vi.fn(async () => 'vault-new'),
    verify: vi.fn(async () => ({ ok: true as const, identity: 'octocat' })),
    listParams: vi.fn(async () => []),
    getLog: vi.fn(
      async (): Promise<CicdLogChunk> => ({ mode: 'snapshot', text: 'done\n', more: false })
    ),
    trigger: vi.fn(async () => ({ note: 'queued' })),
    cancel: vi.fn(async () => ({ note: '' })),
    rerun: vi.fn(async () => ({ note: '' })),
    deleteSecrets: vi.fn(async () => undefined),
    onState: vi.fn(() => () => undefined),
    ...over
  }
}

beforeEach(() => {
  stubBridge({})
})

// ---------------------------------------------------------------------------

describe('status is never carried by colour alone', () => {
  it('gives an unreadable provider the hollow ring and the word UNKNOWN', async () => {
    render(
      <CicdPanel
        connections={[CONN]}
        intervalSec={20}
        bridge={bridge({
          snapshot: async () => [
            state({ pipelines: [pipeline({ last: run({ outcome: { status: 'unknown' } }) })] })
          ]
        })}
      />
    )
    const word = await screen.findByText('UNKNOWN')
    // The word is the signal for a reader who sees none of the four colours.
    expect(word.className).toContain('state-unknown')
    // The ring is the signal for one who sees no text. Neither green nor red.
    expect(word.querySelector('.state-dot.is-unknown')).not.toBeNull()
    expect(word.querySelector('.state-dot.is-ok')).toBeNull()
    expect(word.querySelector('.state-dot.is-alarm')).toBeNull()
  })

  it('shows UNSTABLE for the warning flag rather than calling it ok', async () => {
    render(
      <CicdPanel
        connections={[CONN]}
        bridge={bridge({
          snapshot: async () => [
            state({
              pipelines: [pipeline({ last: run({ outcome: { status: 'success', warning: true } }) })]
            })
          ]
        })}
      />
    )
    const word = await screen.findByText('UNSTABLE')
    expect(word.className).toContain('state-watch')
    expect(screen.queryByText('ok')).toBeNull()
  })

  it('shouts FAILED and whispers ok, so the two are not one glance apart', async () => {
    render(
      <CicdPanel
        connections={[CONN]}
        bridge={bridge({
          snapshot: async () => [
            state({
              pipelines: [
                pipeline({ ref: 'a', name: 'build', last: run({ outcome: { status: 'failed' } }) }),
                pipeline({ ref: 'b', name: 'test', last: run({ id: 'r2' }) })
              ]
            })
          ]
        })}
      />
    )
    expect((await screen.findByText('FAILED')).className).toContain('state-alarm')
    expect(screen.getByText('ok').className).toContain('state-ok')
  })
})

describe('what needs me, not every pipeline', () => {
  it('ranks failures above running above green, and counts what it shows', async () => {
    render(
      <CicdPanel
        connections={[CONN]}
        bridge={bridge({
          snapshot: async () => [
            state({
              pipelines: [
                pipeline({ ref: 'a', name: 'green', last: run({ id: 'r1' }) }),
                pipeline({
                  ref: 'b',
                  name: 'broken',
                  last: run({ id: 'r2', outcome: { status: 'failed' } })
                }),
                pipeline({
                  ref: 'c',
                  name: 'going',
                  last: run({ id: 'r3', outcome: { status: 'running' } })
                })
              ]
            })
          ]
        })}
      />
    )
    await screen.findByText('broken')
    const order = [...document.querySelectorAll('.cicd-row')].map((e) => e.textContent ?? '')
    expect(order.findIndex((t) => t.includes('broken'))).toBe(0)
    expect(order.findIndex((t) => t.includes('going'))).toBe(1)
    expect(order.findIndex((t) => t.includes('green'))).toBe(2)
    expect(screen.getByTestId('cicd-counts').textContent).toContain('3 of 3 runs in the last 24 hours')
  })

  it('says how many pipelines the 24-hour window left out rather than dropping them', async () => {
    render(
      <CicdPanel
        connections={[CONN]}
        bridge={bridge({
          snapshot: async () => [
            state({
              pipelines: [
                pipeline({ ref: 'a', last: run({ startedAt: Date.now() - 40 * 60 * 60 * 1000 }) }),
                pipeline({ ref: 'b', name: 'never', last: undefined })
              ]
            })
          ]
        })}
      />
    )
    const counts = await screen.findByTestId('cicd-counts')
    expect(counts.textContent).toContain('1 last ran longer ago than that')
    expect(counts.textContent).toContain('1 have never run')
  })

  it('filters the rows and says so in the count', async () => {
    render(
      <CicdPanel
        connections={[CONN]}
        bridge={bridge({
          snapshot: async () => [
            state({
              pipelines: [
                pipeline({ ref: 'a', name: 'deploy-web' }),
                pipeline({ ref: 'b', name: 'deploy-api', last: run({ id: 'r2' }) })
              ]
            })
          ]
        })}
      />
    )
    await screen.findByText('deploy-api')
    await userEvent.type(screen.getByLabelText('Filter runs'), 'api')
    await waitFor(() =>
      expect(screen.getByTestId('cicd-counts').textContent).toContain('1 of 1 run')
    )
  })
})

describe('freshness is stated, never implied', () => {
  it('names the last successful read and the interval together', async () => {
    render(<CicdPanel connections={[CONN]} intervalSec={20} bridge={bridge()} />)
    const read = await screen.findByTestId('cicd-read-c1')
    expect(read.textContent).toMatch(/Read \d+s ago/)
    expect(read.textContent).toContain('every 20s')
    expect(read.className).not.toContain('state-unknown')
  })

  it('lets the timestamp itself go unknown past three intervals', async () => {
    render(
      <CicdPanel
        connections={[CONN]}
        intervalSec={20}
        bridge={bridge({ snapshot: async () => [state({ readAt: Date.now() - 100_000 })] })}
      />
    )
    const read = await screen.findByTestId('cicd-read-c1')
    // 100s against a 20s interval is five intervals: the number has stopped
    // being a claim about now, and it says so achromatically.
    expect(read.className).toContain('state-unknown')
  })

  it('says never read rather than showing a zero', async () => {
    render(
      <CicdPanel
        connections={[CONN]}
        bridge={bridge({ snapshot: async () => [state({ readAt: undefined })] })}
      />
    )
    expect((await screen.findByTestId('cicd-read-c1')).textContent).toContain('never read')
  })

  it('shows the rate budget when the provider reports one', async () => {
    render(
      <CicdPanel
        connections={[CONN]}
        bridge={bridge({
          snapshot: async () => [state({ budget: { remaining: 4123, limit: 5000 } })]
        })}
      />
    )
    expect(await screen.findByText(/4123 of 5000 requests left/)).toBeTruthy()
  })
})

describe('a failed poll ages the rows, it never clears them', () => {
  const failing = state({
    error: 'connect ETIMEDOUT',
    failures: 3,
    readAt: Date.now() - 300_000
  })

  it('keeps the last good rows on screen', async () => {
    render(<CicdPanel connections={[CONN]} bridge={bridge({ snapshot: async () => [failing] })} />)
    expect(await screen.findByText('deploy')).toBeTruthy()
    expect(screen.getByText('not re-read')).toBeTruthy()
  })

  it('names the host and the failure count, and offers a retry that refreshes that one', async () => {
    const b = bridge({ snapshot: async () => [failing] })
    render(<CicdPanel connections={[CONN]} bridge={b} />)
    const note = await screen.findByText(/github\.example\.com could not be read/)
    expect(note.textContent).toContain('3 attempts')
    expect(note.textContent).toContain('ageing, not gone')
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(b.refresh).toHaveBeenCalledWith('c1')
  })

  it('calls a rate limit a watch, not an unknown — we know the data, we cannot refresh it', async () => {
    render(
      <CicdPanel
        connections={[CONN]}
        bridge={bridge({
          snapshot: async () => [
            state({ error: '429 rate limit exceeded', failures: 1, budget: { remaining: 0, limit: 5000 } })
          ]
        })}
      />
    )
    const note = await screen.findByText(/has run out of request budget/)
    expect(note.className).toContain('is-watch')
    expect(note.className).not.toContain('is-unknown')
    expect(note.textContent).toContain('Nothing is wrong with the runs below')
  })
})

describe('a token that expired mid-session', () => {
  const expired = state({ error: '401 Unauthorized: bad credentials', failures: 2 })

  it('leaves the rows alone and stands a note with the one action that fixes it', async () => {
    render(
      <CicdPanel
        connections={[CONN]}
        onSaveConnection={vi.fn()}
        bridge={bridge({ snapshot: async () => [expired] })}
      />
    )
    expect(await screen.findByText('deploy')).toBeTruthy()
    expect(
      screen.getByText(/refused the token/).closest('.panel-note')?.className
    ).toContain('is-alarm')
  })

  it('reopens the modal with the token field empty and everything else kept', async () => {
    render(
      <CicdPanel
        connections={[CONN]}
        onSaveConnection={vi.fn()}
        bridge={bridge({ snapshot: async () => [expired] })}
      />
    )
    await userEvent.click(await screen.findByRole('button', { name: 'Update token' }))
    const dialog = await screen.findByRole('dialog')
    // The rows are still there behind it — updating a credential is not a
    // reason to throw away what was last read.
    expect(screen.getByText('deploy')).toBeTruthy()
    expect(within(dialog).getByLabelText(/Token/).getAttribute('value')).not.toBe('secret')
  })
})

describe('the empty state', () => {
  it('says no account is connected and offers the one thing to press', async () => {
    render(<CicdPanel connections={[]} bridge={bridge()} />)
    expect(await screen.findByText('No CI account is connected')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connect an account' })).toBeTruthy()
    // No Refresh while there is nothing to refresh.
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull()
  })

  it('distinguishes nothing ran from nothing matched', async () => {
    render(
      <CicdPanel
        connections={[CONN]}
        bridge={bridge({ snapshot: async () => [state({ pipelines: [] })] })}
      />
    )
    expect(await screen.findByText('Nothing has run in the last 24 hours')).toBeTruthy()
  })
})

describe('a preload half older than this panel', () => {
  it('greys Refresh with the reason on it rather than throwing into the console', async () => {
    // `CicdBridge` is the declaration all three sides import, but a packaged
    // build can carry a preload that predates a member of it. A control with
    // nothing behind it says so; it does not call undefined.
    const partial = bridge()
    delete (partial as unknown as Record<string, unknown>).refresh
    render(<CicdPanel connections={[CONN]} bridge={partial} />)
    const refresh = await screen.findByRole('button', { name: 'Refresh' })
    expect(refresh.hasAttribute('disabled')).toBe(true)
    expect(refresh.getAttribute('title')).toContain('cannot read on demand')
  })
})

// ---------------------------------------------------------------------------
// Connect modal
// ---------------------------------------------------------------------------

describe('the connect modal is one modal, not a wizard', () => {
  it('changes the URL placeholder with the provider and nothing else about the form', async () => {
    render(<CicdConnectModal onClose={vi.fn()} onSave={vi.fn()} bridge={bridge()} />)
    expect(screen.getByPlaceholderText('https://github.com')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Jenkins' }))
    expect(screen.getByPlaceholderText('https://jenkins.example.internal')).toBeTruthy()
    // Still one dialog, still one set of fields.
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
  })

  it('asks Jenkins for a username and the other two not at all', async () => {
    render(<CicdConnectModal onClose={vi.fn()} onSave={vi.fn()} bridge={bridge()} />)
    expect(screen.queryByLabelText(/Username/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Jenkins' }))
    expect(screen.getByLabelText(/Username/)).toBeTruthy()
  })

  it('says Jenkins has no scopes instead of inventing a checklist', async () => {
    render(<CicdConnectModal onClose={vi.fn()} onSave={vi.fn()} bridge={bridge()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Jenkins' }))
    const note = screen.getByText(/Jenkins API tokens have no scopes at all/)
    expect(note.textContent).toContain('carries your whole account')
    expect(screen.queryByText('read_api')).toBeNull()
  })

  it('admits a fine-grained GitHub token takes no scope parameters', () => {
    render(<CicdConnectModal onClose={vi.fn()} onSave={vi.fn()} bridge={bridge()} />)
    expect(screen.getByText('repo', { selector: '.cicd-scope-list .mono' })).toBeTruthy()
    expect(screen.getByText(/the link cannot do the work/)).toBeTruthy()
  })

  it('pre-ticks the GitLab scope in the deep link it offers', async () => {
    render(<CicdConnectModal onClose={vi.fn()} onSave={vi.fn()} bridge={bridge()} />)
    await userEvent.click(screen.getByRole('button', { name: 'GitLab CI' }))
    const link = screen.getByRole('link', { name: 'Create a personal access token' })
    expect(link.getAttribute('href')).toContain('scopes=read_api')
  })

  it('offers the three routes and asks which server only when one is needed', async () => {
    render(<CicdConnectModal onClose={vi.fn()} onSave={vi.fn()} bridge={bridge()} />)
    expect(screen.queryByLabelText(/^Server/)).toBeNull()
    await userEvent.selectOptions(screen.getByLabelText(/Send from/), 'server')
    expect(screen.getByLabelText(/^Server/)).toBeTruthy()
    await userEvent.selectOptions(screen.getByLabelText(/Send from/), 'vpn')
    expect(screen.getByLabelText(/VPN profile/)).toBeTruthy()
  })
})

describe('Verify dials, reports, and saves nothing', () => {
  async function fill(): Promise<void> {
    await userEvent.type(screen.getByPlaceholderText('Platform'), 'Platform')
    await userEvent.type(screen.getByPlaceholderText('https://github.com'), 'https://github.com')
    await userEvent.type(screen.getByLabelText(/Token/), 'ghp_abcdefghijklmnop')
  }

  it('reports a read-only token as a partial success, not a failure', async () => {
    const onSave = vi.fn()
    const b = bridge({
      verify: vi.fn(async () => ({ ok: true as const, identity: 'octocat', scopes: ['repo'] }))
    })
    render(<CicdConnectModal onClose={vi.fn()} onSave={onSave} bridge={b} />)
    await fill()
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }))
    const note = await screen.findByText(/Read-only/)
    expect(note.className).toContain('state-watch')
    expect(note.className).not.toContain('danger')
    expect(note.textContent).toContain('That is a fine way to use it')
    // Nothing was saved and nothing was handed to main.
    expect(onSave).not.toHaveBeenCalled()
    expect(b.configure).not.toHaveBeenCalled()
  })

  it('calls a token with both scopes a plain success', async () => {
    render(
      <CicdConnectModal
        onClose={vi.fn()}
        onSave={vi.fn()}
        bridge={bridge({
          verify: vi.fn(async () => ({
            ok: true as const,
            identity: 'octocat',
            scopes: ['repo', 'workflow']
          }))
        })}
      />
    )
    await fill()
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }))
    expect((await screen.findByText(/can read runs and start them/)).className).toContain('state-ok')
  })

  it('does not read a missing Jenkins scope list as a missing permission', async () => {
    render(<CicdConnectModal onClose={vi.fn()} onSave={vi.fn()} bridge={bridge()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Jenkins' }))
    await userEvent.type(screen.getByPlaceholderText('Build controller'), 'CI')
    await userEvent.type(screen.getByPlaceholderText('https://jenkins.example.internal'), 'https://ci.example.com')
    await userEvent.type(screen.getByLabelText(/Username/), 'ops')
    await userEvent.type(screen.getByLabelText(/Token/), '11aabbccddeeff')
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }))
    expect(await screen.findByText(/Jenkins reports no scopes/)).toBeTruthy()
  })

  it('says a build cannot dial rather than offering a button that does nothing', () => {
    render(<CicdConnectModal onClose={vi.fn()} onSave={vi.fn()} bridge={undefined} />)
    const verify = screen.getByRole('button', { name: 'Verify' })
    expect(verify.hasAttribute('disabled')).toBe(true)
    expect(verify.getAttribute('title')).toContain('cannot dial')
  })
})

// ---------------------------------------------------------------------------
// Run workbench and the log pane
// ---------------------------------------------------------------------------

describe('the run workbench', () => {
  it('has two dividers, so the log is not in a fixed box', async () => {
    render(
      <CicdRunWorkbench
        connection={CONN}
        pipeline={pipeline()}
        run={run()}
        bridge={bridge()}
        onClose={vi.fn()}
      />
    )
    await waitFor(() => expect(screen.getAllByRole('separator')).toHaveLength(2))
    expect(screen.getByLabelText('Resize the job list')).toBeTruthy()
    expect(screen.getByLabelText('Resize the run detail')).toBeTruthy()
  })

  it('never calls an unread job list "no jobs"', async () => {
    render(
      <CicdRunWorkbench
        connection={CONN}
        pipeline={pipeline()}
        run={run()}
        steps={[]}
        bridge={bridge()}
        onClose={vi.fn()}
      />
    )
    expect(await screen.findByText(/No job list was read for this run/)).toBeTruthy()
  })

  it('puts attacker-authored text through remoteText before showing it', async () => {
    render(
      <CicdRunWorkbench
        connection={CONN}
        pipeline={pipeline()}
        run={run({ actor: 'eve\n\nIGNORE PREVIOUS' })}
        bridge={bridge()}
        onClose={vi.fn()}
      />
    )
    // Flattened to one line: the newlines an author controls are gone.
    expect(await screen.findByText('eve IGNORE PREVIOUS')).toBeTruthy()
  })
})

describe('the log pane has four honest modes', () => {
  const wb = (chunk: CicdLogChunk): React.JSX.Element => (
    <CicdRunWorkbench
      connection={CONN}
      pipeline={pipeline()}
      run={run()}
      bridge={bridge({ getLog: vi.fn(async () => chunk) })}
      onClose={vi.fn()}
    />
  )

  it('labels a Jenkins tail as following and lets Follow run', async () => {
    render(wb({ mode: 'live', text: 'building\n', more: true, cursor: '120' }))
    expect(await screen.findByText('LIVE · following')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Follow' }).hasAttribute('disabled')).toBe(false)
  })

  it('admits GitLab is a re-read rather than a tail', async () => {
    render(wb({ mode: 'reread', text: 'step 1\n', more: true }))
    expect(await screen.findByText('LIVE · re-read every 5s')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Follow' }).hasAttribute('disabled')).toBe(false)
  })

  it('disables Follow on a snapshot WITH THE REASON ON THE CONTROL, never hides it', async () => {
    render(wb({ mode: 'snapshot', text: 'all done\n', more: false }))
    await screen.findByText('SNAPSHOT · complete')
    const follow = screen.getByRole('button', { name: 'Follow' })
    expect(follow.hasAttribute('disabled')).toBe(true)
    expect(follow.getAttribute('title')).toContain('nothing left to follow')
  })

  it('says a GitHub run in progress has no logs yet, and does not call that an error', async () => {
    render(wb({ mode: 'pending', text: '', more: true }))
    expect(await screen.findByText('No logs yet')).toBeTruthy()
    expect(screen.getByText(/nothing to fetch while it is in progress/)).toBeTruthy()
    const follow = screen.getByRole('button', { name: 'Follow' })
    expect(follow.hasAttribute('disabled')).toBe(true)
    expect(document.querySelector('.panel-note.is-alarm')).toBeNull()
  })

  it('shows the step statuses that ARE available while the log is not', async () => {
    render(
      <CicdRunWorkbench
        connection={CONN}
        pipeline={pipeline()}
        run={run({ outcome: { status: 'running' } })}
        steps={[
          { name: 'build', outcome: { status: 'success' } },
          { name: 'deploy', outcome: { status: 'running' } }
        ]}
        bridge={bridge({ getLog: vi.fn(async () => ({ mode: 'pending' as const, text: '', more: true })) })}
        onClose={vi.fn()}
      />
    )
    await screen.findByText('No logs yet')
    expect(screen.getAllByText('build').length).toBeGreaterThan(0)
    expect(screen.getAllByText('deploy').length).toBeGreaterThan(0)
  })

  it('says how much a cap withheld rather than showing a silently short log', async () => {
    render(wb({ mode: 'snapshot', text: 'tail\n', more: false, withheldBytes: 4096 }))
    expect(await screen.findByText(/4,096 bytes were left out/)).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

describe('starting a run', () => {
  const TRIGGERABLE = state({
    pipelines: [pipeline({ triggerable: true, last: run() }), pipeline({ ref: 'p2', name: 'nope', triggerable: false })]
  })

  it('lists only pipelines that can actually be started', async () => {
    render(<CicdTriggerPanel connections={[CONN]} bridge={bridge({ snapshot: async () => [TRIGGERABLE] })} />)
    expect(await screen.findByText('deploy')).toBeTruthy()
    expect(screen.queryByText('nope')).toBeNull()
    expect(screen.getByTestId('cicd-trigger-counts').textContent).toContain('1 of 1 pipeline')
  })

  it('names the blast radius in the user’s terms', async () => {
    render(<CicdTriggerPanel connections={[CONN]} bridge={bridge({ snapshot: async () => [TRIGGERABLE] })} />)
    await userEvent.click(await screen.findByText('deploy'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/cannot stop the run once it has been accepted/)).toBeTruthy()
  })

  it('gives a pipeline with no parameters a short confirm and no manufactured form', async () => {
    render(<CicdTriggerPanel connections={[CONN]} bridge={bridge({ snapshot: async () => [TRIGGERABLE] })} />)
    await userEvent.click(await screen.findByText('deploy'))
    expect(await screen.findByText('This pipeline takes no parameters.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Start the run' })).toBeTruthy()
  })

  it('renders the parameters the provider declares', async () => {
    render(
      <CicdTriggerPanel
        connections={[CONN]}
        bridge={bridge({
          snapshot: async () => [TRIGGERABLE],
          listParams: vi.fn(async () => [
            { key: 'env', label: 'Environment', type: 'choice' as const, required: true, choices: ['stage', 'prod'] }
          ])
        })}
      />
    )
    await userEvent.click(await screen.findByText('deploy'))
    expect(await screen.findByText('Environment')).toBeTruthy()
    expect(screen.getByRole('option', { name: 'prod' })).toBeTruthy()
  })

  it('shows REQUESTED in the unknown state when the provider hands back no run', async () => {
    render(
      <CicdTriggerPanel
        connections={[CONN]}
        bridge={bridge({
          snapshot: async () => [TRIGGERABLE],
          trigger: vi.fn(async () => ({
            note: 'Jenkins has queued it; a build number appears when an executor picks it up.',
            queueRef: '17',
            webUrl: 'https://ci.example.com/queue/17'
          }))
        })}
      />
    )
    await userEvent.click(await screen.findByText('deploy'))
    await userEvent.type(await screen.findByLabelText(/Run against/), 'main')
    await userEvent.click(screen.getByRole('button', { name: 'Start the run' }))

    const requested = await screen.findByText(/REQUESTED · no run id yet/)
    // Never green, and never a fabricated run number.
    expect(requested.className).toContain('state-unknown')
    expect(requested.querySelector('.state-dot.is-unknown')).not.toBeNull()
    expect(screen.getByText(/a build number appears when an executor picks it up/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open in the provider' }).getAttribute('href')).toBe(
      'https://ci.example.com/queue/17'
    )
  })

  it('passes the ref and the parameters through to the bridge unchanged', async () => {
    const b = bridge({
      snapshot: async () => [TRIGGERABLE],
      listParams: vi.fn(async () => [
        { key: 'env', label: 'Environment', type: 'string' as const, required: false, default: 'stage' }
      ])
    })
    render(<CicdTriggerPanel connections={[CONN]} bridge={b} />)
    await userEvent.click(await screen.findByText('deploy'))
    await userEvent.type(await screen.findByLabelText(/Run against/), 'release/1.2')
    await userEvent.click(screen.getByRole('button', { name: 'Start the run' }))
    await waitFor(() =>
      expect(b.trigger).toHaveBeenCalledWith('c1', 'p1', 'release/1.2', { env: 'stage' })
    )
  })
})

// ---------------------------------------------------------------------------
// Naming discipline
// ---------------------------------------------------------------------------

describe('the vocabulary this module fixed', () => {
  const DIR = resolve(__dirname, '../src/renderer/src/components/cicd')
  const sources = readdirSync(DIR)
    .filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
    .map((f) => ({ f, text: readFileSync(join(DIR, f), 'utf8') }))

  it('finds the module to check', () => {
    expect(sources.length).toBeGreaterThan(3)
  })

  it('says Refresh everywhere and never Check now', () => {
    // `panel-audit.md` §5: seven names for one act across fifteen panels. This
    // module starts with one.
    for (const { f, text } of sources) {
      expect(text, f).not.toContain('Check now')
      // "Read runs" as a scope DESCRIPTION is fine; as a button label it would
      // be the seventh name for Refresh. Only the control is policed.
      expect(text, f).not.toMatch(/>\s*Read (runs|pipelines|builds)\s*</)
    }
    expect(sources.some((s) => s.text.includes('Refresh'))).toBe(true)
  })

  it('adds no inline font sizes, which tests/inlineTypeScale.test.ts ratchets to an exact count', () => {
    for (const { f, text } of sources) {
      expect(text.match(/fontSize: [0-9]+/g) ?? [], f).toEqual([])
    }
  })
})

describe('the operator can stop a run without the agent', () => {
  // `cancel_run` existed as an MCP tool and a bridge method before any human
  // could press it, so the only party able to stop a run from inside OpsMaxx
  // was the AI — and STOP ALL AI ACCESS revokes the agent's session, which
  // meant pressing the panic button guaranteed the deploy finished. This path
  // is not gated by the AI policy, because it is not the AI doing it.
  const runningRun = (): CicdRun => ({ ...run(), outcome: { status: 'running' } })

  it('offers a stop button while a run is going', () => {
    const b = bridge()
    render(
      <CicdRunWorkbench
        connection={CONN}
        pipeline={pipeline()}
        run={runningRun()}
        bridge={b}
        onClose={() => {}}
      />
    )
    expect((screen.getByRole('button', { name: /stop this run/i }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('does not offer it for a run that already finished', () => {
    render(
      <CicdRunWorkbench
        connection={CONN}
        pipeline={pipeline()}
        run={{ ...run(), outcome: { status: 'success' } }}
        bridge={bridge()}
        onClose={() => {}}
      />
    )
    expect(screen.queryByRole('button', { name: /stop this run/i })).toBeNull()
  })

  it('reports the provider\'s own words rather than claiming it stopped', async () => {
    // Jenkins will not say whether the build was still running, GitLab says
    // cancelling not cancelled, GitHub answers 202 to a request it has
    // accepted but not acted on. "Cancelled" is the one claim none of them made.
    const b = bridge()
    b.cancel = vi.fn(async () => ({
      note: 'Asked Jenkins to stop the build. Jenkins does not report whether it was still running.'
    }))
    render(
      <CicdRunWorkbench
        connection={CONN}
        pipeline={pipeline()}
        run={runningRun()}
        bridge={b}
        onClose={() => {}}
      />
    )
    screen.getByRole('button', { name: /stop this run/i }).click()
    expect(await screen.findByText(/does not report whether it was still running/i)).toBeTruthy()
    expect(b.cancel).toHaveBeenCalledTimes(1)
  })
})

describe('the run workbench fetches its own jobs', () => {
  // `getRun` reached the contract, the preload bridge, the IPC layer and the
  // wiring — and nothing in the UI called it, so the job list was permanently
  // empty while the code around it claimed the bridge had no such method.
  it('asks the bridge when it was given no steps', async () => {
    const b = bridge()
    b.getRun = vi.fn(async () => ({
      run: {},
      steps: [{ name: 'unit tests', outcome: { status: 'failed' as const } }]
    }))
    render(
      <CicdRunWorkbench
        connection={CONN}
        pipeline={pipeline()}
        run={run()}
        bridge={b}
        onClose={vi.fn()}
      />
    )
    expect(await screen.findByText('unit tests')).toBeTruthy()
    expect(b.getRun).toHaveBeenCalledTimes(1)
  })

  it('does not ask when a caller already supplied them', () => {
    const b = bridge()
    b.getRun = vi.fn(async () => ({ run: {}, steps: [] }))
    render(
      <CicdRunWorkbench
        connection={CONN}
        pipeline={pipeline()}
        run={run()}
        steps={[{ name: 'given', outcome: { status: 'success' } }]}
        bridge={b}
        onClose={vi.fn()}
      />
    )
    // The name appears in both the job list and the log pane's step summary.
    expect(screen.getAllByText('given').length).toBeGreaterThan(0)
    expect(b.getRun).not.toHaveBeenCalled()
  })

  it('says the list was not read when the fetch fails, not that there were no jobs', async () => {
    // A startup_failure genuinely has zero jobs. "Could not read" and "had
    // none" must never render the same.
    const b = bridge()
    b.getRun = vi.fn(async () => {
      throw new Error('nope')
    })
    render(
      <CicdRunWorkbench
        connection={CONN}
        pipeline={pipeline()}
        run={run()}
        bridge={b}
        onClose={vi.fn()}
      />
    )
    await waitFor(() => expect(b.getRun).toHaveBeenCalled())
    expect(screen.getByText(/no job list was read/i)).toBeTruthy()
  })
})

describe('a user can actually create a connection', () => {
  // The whole feature hung on this and it did not work: the modal's `onSave`
  // was gated on an optional `onSaveConnection` prop that nothing in the app
  // supplied, so Connect was permanently disabled. Verify worked, the form
  // worked, and the button could never be pressed.
  it('reaches a Connect button that is not disabled by missing wiring', async () => {
    render(<CicdPanel connections={[]} bridge={bridge()} />)
    await userEvent.click(screen.getByRole('button', { name: /connect an account/i }))
    const connect = screen.getByRole('button', { name: /^connect$/i }) as HTMLButtonElement
    // Disabled here is FIELD validation on an empty form — the honest reason.
    // The regression this pins is the other one: disabled because no handler
    // existed, which no amount of typing could fix.
    expect(connect.disabled).toBe(true)
    await userEvent.type(screen.getByLabelText(/^name/i), 'Platform')
    await userEvent.type(screen.getByLabelText(/url/i), 'https://github.com')
    await userEvent.type(screen.getByLabelText(/token/i), 'ghp_secret')
    expect((screen.getByRole('button', { name: /^connect$/i }) as HTMLButtonElement).disabled).toBe(
      false
    )
  })

  it('stores the token through the bridge and keeps it out of the saved record', async () => {
    const b = bridge()
    b.createSecret = vi.fn(async () => 'vault-xyz')
    useApp.setState({ cicdConnections: [] })
    render(<CicdPanel bridge={b} />)
    await userEvent.click(screen.getByRole('button', { name: /connect an account/i }))
    await userEvent.type(screen.getByLabelText(/^name/i), 'Platform')
    await userEvent.type(screen.getByLabelText(/url/i), 'https://github.com')
    await userEvent.type(screen.getByLabelText(/token/i), 'ghp_secret')
    await userEvent.click(screen.getByRole('button', { name: /^connect$/i }))

    await waitFor(() => expect(b.createSecret).toHaveBeenCalledTimes(1))
    const saved = useApp.getState().cicdConnections
    expect(saved).toHaveLength(1)
    expect(saved[0].vaultEntryId).toBe('vault-xyz')
    // `opsmaxx-data.json` is documented as carrying no credentials. The record
    // that reaches the store is the record that reaches that file.
    expect(JSON.stringify(saved)).not.toContain('ghp_secret')
  })
})

describe('re-running a finished run', () => {
  // `rerun` reached the contract, preload, IPC, wiring and the GitHub adapter,
  // and no UI called it. Found by the bridge-wiring sweep, not by hand.
  it('offers it on a finished run and calls the bridge', async () => {
    const b = bridge()
    b.rerun = vi.fn(async () => ({ note: 'Re-running 4821 as attempt 2.' }))
    render(
      <CicdRunWorkbench
        connection={CONN}
        pipeline={pipeline()}
        run={{ ...run(), outcome: { status: 'failed' } }}
        bridge={b}
        onClose={vi.fn()}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: /^re-run$/i }))
    expect(b.rerun).toHaveBeenCalledTimes(1)
    expect(await screen.findByText(/attempt 2/i)).toBeTruthy()
  })

  it('is disabled with the reason on a provider that has no such concept', () => {
    // Disabled-with-reason, never hidden. Jenkins starts a new build from the
    // job and GitLab retries a pipeline; folding those into one verb is the
    // shared abstraction this module refuses.
    render(
      <CicdRunWorkbench
        connection={{ ...CONN, provider: 'jenkins' }}
        pipeline={pipeline()}
        run={{ ...run(), outcome: { status: 'failed' } }}
        bridge={bridge()}
        onClose={vi.fn()}
      />
    )
    const btn = screen.getByRole('button', { name: /^re-run$/i }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.title).toMatch(/GitHub Actions concept/)
  })

  it('is not offered while the run is still going', () => {
    render(
      <CicdRunWorkbench
        connection={CONN}
        pipeline={pipeline()}
        run={{ ...run(), outcome: { status: 'running' } }}
        bridge={bridge()}
        onClose={vi.fn()}
      />
    )
    expect(screen.queryByRole('button', { name: /^re-run$/i })).toBeNull()
  })
})
