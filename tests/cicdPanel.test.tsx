// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import { useApp } from '../src/renderer/src/store/app'
import { useVaultPrompt } from '../src/renderer/src/store/vaultPrompt'
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
    getConfig: vi.fn(async () => ({ kind: 'xml' as const, text: '<flow-definition/>' })),
    recentRuns: vi.fn(async () => []),
    queue: vi.fn(async () => ({
      items: [],
      capacity: { busyExecutors: 0, totalExecutors: 0, agents: [] }
    })),
    setJobEnabled: vi.fn(async () => ({ note: '' })),
    cancelQueueItem: vi.fn(async () => ({ note: '' })),
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
    // A pipeline that exists and has not run. `pipelines: []` would be a
    // different statement -- see the two tests below.
    render(
      <CicdPanel
        connections={[CONN]}
        bridge={bridge({ snapshot: async () => [state({ pipelines: [pipeline()] })] })}
      />
    )
    expect(await screen.findByText('Nothing has run in the last 24 hours')).toBeTruthy()
  })

  // The panel said "Every connected account answered" for all three of these.
  // The first is the one that cost real time: Jenkins had run three jobs
  // thirteen hours earlier, the panel reported a successful empty read it had
  // never performed, and the reader went looking for a fault in Jenkins.
  it('does not claim an account answered when it has never been read', async () => {
    render(
      <CicdPanel
        connections={[CONN]}
        bridge={bridge({ snapshot: async () => [state({ readAt: undefined, pipelines: [] })] })}
      />
    )
    expect(await screen.findByText('Not read yet')).toBeTruthy()
    expect(screen.queryByText(/Every connected account answered/)).toBeNull()
    // Names the account, so a reader with four of them knows which.
    expect(screen.getByText(new RegExp(`${CONN.name} has not answered yet`))).toBeTruthy()
  })

  it('says so when an account answered with no pipelines at all', async () => {
    // What a Jenkins credential that cannot see the jobs looks like: an empty
    // list, HTTP 200, no error anywhere.
    render(
      <CicdPanel
        connections={[CONN]}
        bridge={bridge({ snapshot: async () => [state({ pipelines: [] })] })}
      />
    )
    expect(await screen.findByText('No pipelines to show')).toBeTruthy()
    expect(screen.getByText(/listed no pipelines at all/)).toBeTruthy()
    expect(screen.queryByText(/Every connected account answered/)).toBeNull()
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

  /**
   * The way out of the run view.
   *
   * This view REPLACES the list it was opened from rather than sitting over it,
   * so until now the only exit was a 16px × in the corner -- which reads as
   * "close this" rather than "go back to the runs", and which somebody looking
   * at a log for the first time does not find.
   */
  it('offers a labelled way back, not only the ×', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <CicdRunWorkbench
        connection={CONN}
        pipeline={pipeline()}
        run={run()}
        bridge={bridge()}
        onClose={onClose}
      />
    )
    const back = screen.getByTestId('cicd-run-back')
    // The destination is named. A bare arrow beside a job name does not say
    // which of the two lists it returns to.
    expect(back.textContent).toContain('Back to runs')
    await user.click(back)
    expect(onClose).toHaveBeenCalled()
    // The × is the same action and stays; people reach for both.
    expect(screen.getByLabelText('Close the run')).toBeTruthy()
  })

  it('shows a Jenkins log with the console notes already gone', async () => {
    // The adapter strips them, so by the time the pane has text there is
    // nothing to render. Asserted at the pane because that is where the
    // operator saw the base64.
    render(
      <CicdRunWorkbench
        connection={{ ...CONN, provider: 'jenkins' }}
        pipeline={pipeline()}
        run={run()}
        bridge={bridge({
          getLog: vi.fn(
            async (): Promise<CicdLogChunk> => ({
              mode: 'live',
              text: 'Started by user Zeeshan\n',
              more: false
            })
          )
        })}
        onClose={vi.fn()}
      />
    )
    expect(await screen.findByText(/Started by user Zeeshan/)).toBeTruthy()
    expect(screen.queryByText(/ha:\/\/\/\//)).toBeNull()
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

/**
 * The navigation, and the reading state.
 *
 * Both are reports from a live install: the strips scrolled away under a long
 * pipeline tree, and a freshly connected GitHub account rendered as a rejected
 * token for the tens of seconds its first discovery took.
 */
describe('the CI/CD navigation stays put', () => {
  it('keeps the account tabs and the sub-tabs in one pinned block', async () => {
    const { container } = render(<CicdPanel connections={[CONN]} bridge={bridge()} />)
    await screen.findByText('deploy')
    const nav = container.querySelector('.cicd-nav')
    expect(nav).toBeTruthy()
    // Both strips inside it, so they pin together rather than one at a time.
    expect(nav?.querySelector('.cicd-accounts-strip')).toBeTruthy()
    expect(nav?.querySelector('.cicd-tabs')).toBeTruthy()
  })

  it('leaves the freshness banners outside it', async () => {
    // An account with a failure renders two or three lines of banner, and a
    // nav bar that grows to four lines is not a nav bar.
    const { container } = render(
      <CicdPanel
        connections={[CONN]}
        bridge={bridge({ snapshot: vi.fn(async () => [state({ error: 'gone', failures: 2 })]) })}
      />
    )
    await screen.findByText('deploy')
    expect(container.querySelector('.cicd-nav .cicd-freshness')).toBeNull()
    expect(container.querySelector('.cicd-freshness')).toBeTruthy()
  })
})

describe('a read in flight is not a rejected token', () => {
  const reading = (): CicdPanelState =>
    state({ readAt: undefined, reading: true, pipelines: [] })

  it('says it is reading rather than accusing the account of not being polled', async () => {
    render(
      <CicdPanel
        connections={[CONN]}
        bridge={bridge({ snapshot: vi.fn(async () => [reading()]) })}
      />
    )
    // The indicator itself, not a sentence: a read in flight has to be
    // distinguishable from a read that has hung, and only something that moves
    // does that. `role="status"` is what a screen reader gets instead.
    const status = await screen.findByRole('status')
    expect(status.textContent).toMatch(/Reading/)
    expect(status.querySelector('.spin')).toBeTruthy()
    // The sentence that made a working token look refused.
    expect(screen.queryByText(/the account is not being polled/)).toBeNull()
  })

  it('says reading now on the freshness line, not never read', async () => {
    render(
      <CicdPanel
        connections={[CONN]}
        bridge={bridge({ snapshot: vi.fn(async () => [reading()]) })}
      />
    )
    const line = await screen.findByTestId('cicd-read-c1')
    expect(line.textContent).toContain('reading now')
    expect(line.textContent).not.toContain('never read')
  })

  it('still says never read for an account that genuinely is not being read', async () => {
    render(
      <CicdPanel
        connections={[CONN]}
        bridge={bridge({
          snapshot: vi.fn(async () => [state({ readAt: undefined, pipelines: [] })])
        })}
      />
    )
    const line = await screen.findByTestId('cicd-read-c1')
    expect(line.textContent).toContain('never read')
    expect(await screen.findByText(/have not answered yet|has not answered yet/)).toBeTruthy()
  })

  it('tells the pipeline browser too, so an empty tree is not called empty', async () => {
    const user = userEvent.setup()
    render(
      <CicdPanel
        connections={[CONN]}
        bridge={bridge({ snapshot: vi.fn(async () => [reading()]) })}
      />
    )
    await user.click(await screen.findByRole('button', { name: /^Pipelines/ }))
    const status = await screen.findByRole('status')
    expect(status.textContent).toMatch(/Reading the job list/)
    expect(status.querySelector('.spin')).toBeTruthy()
  })
})

describe('the URL a provider already has for everyone', () => {
  it('prefills github.com so the standard case needs no typing', () => {
    render(<CicdConnectModal onClose={vi.fn()} onSave={vi.fn()} bridge={bridge()} />)
    const url = screen.getByLabelText(/URL/) as HTMLInputElement
    expect(url.value).toBe('https://github.com')
  })

  it('swaps the prefill with the provider', async () => {
    const user = userEvent.setup()
    render(<CicdConnectModal onClose={vi.fn()} onSave={vi.fn()} bridge={bridge()} />)
    await user.click(screen.getByRole('button', { name: 'GitLab CI' }))
    expect((screen.getByLabelText(/URL/) as HTMLInputElement).value).toBe('https://gitlab.com')
  })

  it('leaves Jenkins empty, because every one of them is somewhere different', async () => {
    const user = userEvent.setup()
    render(<CicdConnectModal onClose={vi.fn()} onSave={vi.fn()} bridge={bridge()} />)
    await user.click(screen.getByRole('button', { name: 'Jenkins' }))
    expect((screen.getByLabelText(/URL/) as HTMLInputElement).value).toBe('')
  })

  it('never overwrites a URL the user typed', async () => {
    const user = userEvent.setup()
    render(<CicdConnectModal onClose={vi.fn()} onSave={vi.fn()} bridge={bridge()} />)
    const url = screen.getByLabelText(/URL/) as HTMLInputElement
    await user.clear(url)
    await user.type(url, 'https://ghe.corp.example')
    // A misclick on the provider strip must not eat a GitHub Enterprise host.
    await user.click(screen.getByRole('button', { name: 'GitLab CI' }))
    expect((screen.getByLabelText(/URL/) as HTMLInputElement).value).toBe('https://ghe.corp.example')
  })

  it('keeps an edited account on its own URL', () => {
    render(
      <CicdConnectModal
        onClose={vi.fn()}
        onSave={vi.fn()}
        bridge={bridge()}
        editing={{ ...CONN, baseUrl: 'https://ghe.corp.example' }}
      />
    )
    expect((screen.getByLabelText(/URL/) as HTMLInputElement).value).toBe(
      'https://ghe.corp.example'
    )
  })
})

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

  // Connect appeared to do NOTHING. Verify said the credential reached Jenkins,
  // the button was enabled, it went in and the modal just sat there -- because
  // the handler was `.then(onClose)` with no `.catch`, and the likeliest
  // rejection is the most invisible one: `createSecret` refuses a locked vault
  // by design. An unhandled rejection is not a UI.
  it('says why the save failed instead of sitting there', async () => {
    const b = bridge()
    b.createSecret = vi.fn(async () => {
      throw new Error('The vault refused the change.')
    })
    useApp.setState({ cicdConnections: [] })
    render(<CicdPanel bridge={b} />)
    await fillConnectForm()
    await userEvent.click(screen.getByRole('button', { name: /^connect$/i }))

    expect(await screen.findByText(/The vault refused the change\./)).toBeTruthy()
    // Still open, and nothing half-saved.
    expect(screen.getByRole('button', { name: /^connect$/i })).toBeTruthy()
    expect(useApp.getState().cicdConnections).toHaveLength(0)
  })

  it('offers to unlock when that is the only thing wrong, then saves', async () => {
    const b = bridge()
    let calls = 0
    b.createSecret = vi.fn(async () => {
      calls++
      if (calls === 1) throw new Error('OPSMAXX_VAULT_LOCKED: the vault is locked.')
      return 'vault-after-unlock'
    })
    const request = vi.fn(async () => true)
    useVaultPrompt.setState({ request })
    useApp.setState({ cicdConnections: [] })
    render(<CicdPanel bridge={b} />)
    await fillConnectForm()
    await userEvent.click(screen.getByRole('button', { name: /^connect$/i }))

    await waitFor(() => expect(useApp.getState().cicdConnections).toHaveLength(1))
    expect(request).toHaveBeenCalledTimes(1)
    expect(useApp.getState().cicdConnections[0].vaultEntryId).toBe('vault-after-unlock')
  })

  it('never shows the user the marker it recognises a locked vault by', async () => {
    const b = bridge()
    b.createSecret = vi.fn(async () => {
      throw new Error('OPSMAXX_VAULT_LOCKED: the vault is locked.')
    })
    useVaultPrompt.setState({ request: vi.fn(async () => false) })
    useApp.setState({ cicdConnections: [] })
    render(<CicdPanel bridge={b} />)
    await fillConnectForm()
    await userEvent.click(screen.getByRole('button', { name: /^connect$/i }))

    expect(await screen.findByText(/the vault is locked\./)).toBeTruthy()
    expect(screen.queryByText(/OPSMAXX_VAULT_LOCKED/)).toBeNull()
  })
})

/** The shortest path to a Connect button that is enabled. */
async function fillConnectForm(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: /connect an account/i }))
  await userEvent.type(screen.getByLabelText(/^name/i), 'Platform')
  await userEvent.type(screen.getByLabelText(/url/i), 'https://github.com')
  await userEvent.type(screen.getByLabelText(/token/i), 'ghp_secret')
}

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

// ---------------------------------------------------------------------------
// One tab per account, and the two verbs the panel never had
// ---------------------------------------------------------------------------

/** A saved account in the ACTIVE workspace, which is what the panel lists. */
function saved(over: Partial<CicdConnection> = {}): CicdConnection {
  return { ...CONN, workspaceId: useApp.getState().activeWorkspaceId, ...over }
}

describe('the account strip', () => {
  it('gives every connected account a tab beside the cross-account one', async () => {
    useApp.setState({
      cicdConnections: [
        saved({ id: 'c1', name: 'Platform' }),
        saved({ id: 'c2', name: 'Tooling' })
      ]
    })
    render(<CicdPanel bridge={bridge({ snapshot: async () => [] })} />)
    const strip = await screen.findByRole('tablist', { name: /CI\/CD account tabs/i })
    expect(within(strip).getByRole('tab', { name: /All accounts/ })).toBeTruthy()
    expect(within(strip).getByRole('tab', { name: /Platform/ })).toBeTruthy()
    expect(within(strip).getByRole('tab', { name: /Tooling/ })).toBeTruthy()
  })

  // The strip is derived from the saved accounts, so a `×` could only mean
  // disconnecting one -- which belongs behind a confirm, not behind a glyph
  // that appears on hover.
  it('offers no close affordance, because closing a tab is not a thing here', async () => {
    useApp.setState({ cicdConnections: [saved()] })
    const { container } = render(<CicdPanel bridge={bridge({ snapshot: async () => [] })} />)
    await screen.findByRole('tablist', { name: /CI\/CD account tabs/i })
    expect(container.querySelector('.tabbar .tab .close')).toBeNull()
  })

  it('narrows the feed to the account whose tab is selected', async () => {
    useApp.setState({
      cicdConnections: [
        saved({ id: 'c1', name: 'Platform' }),
        saved({ id: 'c2', name: 'Tooling' })
      ]
    })
    render(
      <CicdPanel
        bridge={bridge({
          snapshot: async () => [
            state({ connectionId: 'c1', pipelines: [pipeline({ name: 'deploy', last: run() })] }),
            state({
              connectionId: 'c2',
              pipelines: [
                pipeline({ connectionId: 'c2', ref: 'p2', name: 'publish', last: run({ connectionId: 'c2', pipelineRef: 'p2', id: 'r2' }) })
              ]
            })
          ]
        })}
      />
    )
    // Both accounts on the cross-account tab.
    expect(await screen.findByText('deploy')).toBeTruthy()
    expect(screen.getByText('publish')).toBeTruthy()

    await userEvent.click(screen.getByRole('tab', { name: /Tooling/ }))
    await waitFor(() => expect(screen.queryByText('deploy')).toBeNull())
    expect(screen.getByText('publish')).toBeTruthy()
  })
})

describe('a sub-tab the provider has no answer for', () => {
  // main's `getQueue` refuses every provider but Jenkins BY NAME. Offering the
  // tab anyway meant selecting it read, threw, and printed that refusal in red.
  it('is absent for GitHub rather than present and broken', async () => {
    useApp.setState({ cicdConnections: [saved({ provider: 'github' })] })
    render(<CicdPanel bridge={bridge({ snapshot: async () => [] })} />)
    await screen.findByRole('tablist', { name: /CI\/CD account tabs/i })
    expect(screen.queryByRole('button', { name: /queue & capacity/i })).toBeNull()
  })

  it('is offered for Jenkins, which does have one', async () => {
    useApp.setState({ cicdConnections: [saved({ provider: 'jenkins' })] })
    render(<CicdPanel bridge={bridge({ snapshot: async () => [] })} />)
    expect(await screen.findByRole('button', { name: /queue & capacity/i })).toBeTruthy()
  })

  // Selected on a Jenkins tab, then the reader switches to a GitHub one. The
  // body must not stay on a screen that no longer exists.
  it('falls back to Activity when the selected account loses it', async () => {
    useApp.setState({
      cicdConnections: [
        saved({ id: 'c1', name: 'Builds', provider: 'jenkins' }),
        saved({ id: 'c2', name: 'Actions', provider: 'github' })
      ]
    })
    render(<CicdPanel bridge={bridge({ snapshot: async () => [] })} />)
    await userEvent.click(screen.getByRole('tab', { name: /Builds/ }))
    await userEvent.click(screen.getByRole('button', { name: /queue & capacity/i }))
    await userEvent.click(screen.getByRole('tab', { name: /Actions/ }))

    expect(screen.queryByRole('button', { name: /queue & capacity/i })).toBeNull()
    expect(
      (screen.getByRole('button', { name: /^activity$/i }) as HTMLElement).getAttribute(
        'aria-pressed'
      )
    ).toBe('true')
  })
})

describe('updating an expired token', () => {
  /** A connection whose last read was refused, which is what raises the button. */
  function expired(): CicdBridge {
    return bridge({
      snapshot: async () => [state({ error: '401 Unauthorized' })]
    })
  }

  // THE BUG. "Update token" rendered a blank NEW-connection form, so pressing
  // it minted a fresh id and saved a SECOND account beside the one whose token
  // had expired -- same name, same URL, both polling, both failing. And because
  // an agent addresses an account by name, a duplicate name makes BOTH of them
  // unreachable from every CI tool.
  it('replaces the account rather than saving a second one beside it', async () => {
    useApp.setState({ cicdConnections: [saved({ id: 'c1', name: 'Platform' })] })
    const b = expired()
    b.createSecret = vi.fn(async () => 'vault-rotated')
    render(<CicdPanel bridge={b} />)

    await userEvent.click(await screen.findByRole('button', { name: /update token/i }))
    // The form opens on THIS account, already filled in.
    expect(screen.getByText(/Edit Platform/)).toBeTruthy()
    await userEvent.type(screen.getByLabelText(/token/i), 'ghp_rotated')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(b.createSecret).toHaveBeenCalledTimes(1))
    const after = useApp.getState().cicdConnections
    expect(after).toHaveLength(1)
    expect(after[0].id).toBe('c1')
    expect(after[0].vaultEntryId).toBe('vault-rotated')
  })

  // The old entry is a stored credential nothing points at any more. Nothing
  // would ever have surfaced it.
  it('releases the vault entry the old token lived in', async () => {
    useApp.setState({ cicdConnections: [saved({ id: 'c1', vaultEntryId: 'vault-old' })] })
    const b = expired()
    b.createSecret = vi.fn(async () => 'vault-rotated')
    render(<CicdPanel bridge={b} />)

    await userEvent.click(await screen.findByRole('button', { name: /update token/i }))
    await userEvent.type(screen.getByLabelText(/token/i), 'ghp_rotated')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(b.deleteSecrets).toHaveBeenCalledWith('vault-old'))
  })
})

describe('two accounts of the same provider', () => {
  // Storable has never been the problem -- every layer is keyed by id. Being
  // ADDRESSABLE is: `resolveCicdOrError` in main matches on the lowercased name
  // and refuses when more than one matches, so a duplicate name silently makes
  // both accounts unreachable from every agent tool.
  it('refuses a name another account already has', async () => {
    useApp.setState({ cicdConnections: [saved({ id: 'c1', name: 'Platform' })] })
    render(<CicdPanel bridge={bridge({ snapshot: async () => [] })} />)
    await userEvent.click(await screen.findByRole('button', { name: /connect a CI account/i }))
    await userEvent.type(screen.getByLabelText(/^name/i), 'platform')

    expect(screen.getByText(/already called that/i)).toBeTruthy()
    expect((screen.getByRole('button', { name: /^connect$/i }) as HTMLButtonElement).disabled).toBe(
      true
    )
  })

  it('accepts a second account of the same provider under its own name', async () => {
    useApp.setState({ cicdConnections: [saved({ id: 'c1', name: 'Platform' })] })
    const b = bridge({ snapshot: async () => [] })
    b.createSecret = vi.fn(async () => 'vault-2')
    render(<CicdPanel bridge={b} />)
    await userEvent.click(await screen.findByRole('button', { name: /connect a CI account/i }))
    await userEvent.type(screen.getByLabelText(/^name/i), 'Tooling')
    await userEvent.type(screen.getByLabelText(/url/i), 'https://github.com')
    await userEvent.type(screen.getByLabelText(/token/i), 'ghp_second')
    await userEvent.click(screen.getByRole('button', { name: /^connect$/i }))

    await waitFor(() => expect(useApp.getState().cicdConnections).toHaveLength(2))
    const [a, c] = useApp.getState().cicdConnections
    expect(a.provider).toBe(c.provider)
    expect(a.id).not.toBe(c.id)
  })
})

describe('removing an account', () => {
  it('drops it from the store and releases its stored token', async () => {
    useApp.setState({
      cicdConnections: [saved({ id: 'c1', name: 'Platform', vaultEntryId: 'vault-1' })]
    })
    const deleteSecrets = vi.fn(async () => undefined)
    stubBridge({ cicd: { deleteSecrets } })
    render(<CicdPanel bridge={bridge({ snapshot: async () => [] })} />)

    await userEvent.click(await screen.findByRole('button', { name: /manage CI accounts/i }))
    await userEvent.click(await screen.findByRole('button', { name: /^remove$/i }))
    // The confirm names what else goes: a row leaving a list reads as
    // reversible, and the credential it takes with it is not.
    expect(screen.getByText(/Remove Platform\?/)).toBeTruthy()
    expect(screen.getByText(/cannot be recovered/i)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /^remove$/i }))

    await waitFor(() => expect(useApp.getState().cicdConnections).toHaveLength(0))
    expect(deleteSecrets).toHaveBeenCalledWith('vault-1')
  })

  // Right-clicking the tab has already named the account. Landing the reader in
  // the full list would make them find it again among rows that all look alike.
  it('confirms the account the tab menu named, without a detour through the list', async () => {
    useApp.setState({
      cicdConnections: [
        saved({ id: 'c1', name: 'Platform', vaultEntryId: 'vault-1' }),
        saved({ id: 'c2', name: 'Tooling', vaultEntryId: 'vault-2' })
      ]
    })
    stubBridge({ cicd: { deleteSecrets: vi.fn(async () => undefined) } })
    render(<CicdPanel bridge={bridge({ snapshot: async () => [] })} />)

    await userEvent.pointer({
      keys: '[MouseRight]',
      target: await screen.findByRole('tab', { name: /Tooling/ })
    })
    await userEvent.click(await screen.findByRole('button', { name: /^remove…$/i }))
    expect(screen.getByText(/Remove Tooling\?/)).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: /^remove$/i }))
    await waitFor(() => expect(useApp.getState().cicdConnections).toHaveLength(1))
    expect(useApp.getState().cicdConnections[0].name).toBe('Platform')
  })
})

// ---------------------------------------------------------------------------
// The banner that survived the unlock, and the loader that did not move.
//
// Reported together, from a live install: "even after unlocking the vault the
// vault messge is sticky, the loader isn't animated, it's just 'Reading...'".
//
// Both are the same class of defect — the screen stating something that is no
// longer, or not yet, true — so both are pinned by driving the real transitions
// through `onState`, which is the channel main actually uses. Asserting that
// `configure` was called would pass against a panel that then rendered the red
// bar forever, which is precisely the bug.
// ---------------------------------------------------------------------------

const VAULT_LOCKED_ERROR = 'OPSMAXX_VAULT_LOCKED: the vault is locked.'

/** A connection whose first discovery died on the lock: no pipelines, no read. */
const locked = (): CicdPanelState =>
  state({ readAt: undefined, pipelines: [], error: VAULT_LOCKED_ERROR, failures: 1 })

/** What main emits when it starts a read: the previous error is KEPT (see
 *  `discoverOne` in cicd/wiring.ts) and only `reading` is added. */
const rereading = (): CicdPanelState => ({ ...locked(), reading: true })

/** A read that got through. The error is gone and the rows are there. */
const succeeded = (): CicdPanelState => state()

const BANNER = /authenticates with a credential in the vault/

/** Renders the panel and hands back main's own push channel. */
function mounted(first: CicdPanelState, over: Partial<CicdBridge> = {}) {
  let push: ((s: CicdPanelState) => void) | undefined
  const b = bridge({
    snapshot: vi.fn(async () => [first]),
    onState: vi.fn((h: (s: CicdPanelState) => void) => {
      push = h
      return () => undefined
    }),
    ...over
  })
  const { container } = render(<CicdPanel connections={[CONN]} bridge={b} />)
  return {
    bridge: b,
    container,
    emit: (s: CicdPanelState) => act(() => push?.(s)),
    /** The indicator whose label matches, because an account being re-read and
     *  a feed with nothing in it yet both raise one and they are different
     *  statements about different parts of the screen. */
    status: (re: RegExp): HTMLElement | undefined =>
      screen.queryAllByRole('status').find((el) => re.test(el.textContent ?? ''))
  }
}

describe('the locked-vault banner goes when the lock does', () => {
  it('is replaced by a live indicator the moment the re-read starts, and gone when it lands', async () => {
    const { emit, status } = mounted(locked(), {
      // Unlocking is what makes the account readable again; main is told so
      // immediately rather than at the next poll, and reports the read.
      configure: vi.fn(async () => undefined)
    })
    expect(await screen.findByText(BANNER)).toBeTruthy()

    useVaultPrompt.setState({ request: vi.fn(async () => true) })
    await userEvent.click(screen.getByRole('button', { name: /unlock vault/i }))

    // Main answers the re-read request the way it really does.
    emit(rereading())
    await waitFor(() => expect(screen.queryByText(BANNER)).toBeNull())
    const spinner = status(/Reading Platform now/)
    expect(spinner).toBeTruthy()
    expect(spinner?.querySelector('.spin')).toBeTruthy()

    emit(succeeded())
    await waitFor(() => expect(screen.queryAllByRole('status')).toHaveLength(0))
    expect(screen.queryByText(BANNER)).toBeNull()
    expect(await screen.findByText('deploy')).toBeTruthy()
  })

  it('keeps the banner when the unlock is cancelled — nothing changed', async () => {
    mounted(locked())
    expect(await screen.findByText(BANNER)).toBeTruthy()

    useVaultPrompt.setState({ request: vi.fn(async () => false) })
    await userEvent.click(screen.getByRole('button', { name: /unlock vault/i }))

    // Still there, and still offering the one control that helps. A panel that
    // cleared the error on the press alone would look identical to a
    // successful unlock, which is the state a reader cannot recover from.
    await waitFor(() => expect(screen.getByText(BANNER)).toBeTruthy())
    expect(screen.getByRole('button', { name: /unlock vault/i })).toBeTruthy()
  })

  it('brings the banner back when the vault re-locks on idle', async () => {
    const { emit } = mounted(succeeded())
    await screen.findByText('deploy')
    expect(screen.queryByText(BANNER)).toBeNull()

    // The idle timer fires somewhere else; the next poll fails on the lock.
    emit({ ...succeeded(), error: VAULT_LOCKED_ERROR, failures: 1 })
    expect(await screen.findByText(BANNER)).toBeTruthy()
  })

  it('never shows the marker it recognises the lock by', async () => {
    mounted(locked())
    await screen.findByText(BANNER)
    expect(screen.queryByText(/OPSMAXX_VAULT_LOCKED/)).toBeNull()
  })
})

describe('a first read states no answer it does not have', () => {
  it('prints no run count while the first read is still in flight', async () => {
    const { emit } = mounted(rereading())
    // "0 of 0 runs in the last 24 hours" is an answer, and there is none yet.
    await waitFor(() => expect(screen.queryByTestId('cicd-counts')).toBeNull())
    expect(screen.queryByText(/in the last 24 hours/)).toBeNull()

    emit(succeeded())
    const counts = await screen.findByTestId('cicd-counts')
    expect(counts.textContent).toContain('1 of 1 run in the last 24 hours')
  })

  it('keeps the count over rows that already exist while a re-read runs', async () => {
    // A re-read changes nothing about what is on screen: the rows are the last
    // true answer and the count describes them.
    const { emit } = mounted(succeeded())
    await screen.findByText('deploy')
    emit({ ...succeeded(), reading: true })
    await waitFor(() =>
      expect(screen.getByTestId('cicd-counts').textContent).toContain('1 of 1 run')
    )
  })

  it('shows a moving indicator rather than a heading over a paragraph', async () => {
    const { status } = mounted(rereading())
    await waitFor(() => expect(status(/GitHub in particular/)).toBeTruthy())
    const feed = status(/GitHub in particular/)
    // The explanation is kept — it is what stops somebody concluding the token
    // is broken — but it is subordinate to the indicator, not standing in for
    // it, so it lives inside the same status block.
    expect(feed?.querySelector('.spin')).toBeTruthy()
    expect(feed?.textContent).toMatch(/^Reading Platform/)
  })
})

/**
 * Refresh, Retry and the unlock all promise the same thing: read this now.
 *
 * For the account in the report none of them delivered it. `refresh` nudges the
 * poller, the poller's targets are built from the pipelines main already holds,
 * and an account whose first discovery died on the locked vault holds none — so
 * every "read now" control on the screen was a no-op for exactly the account
 * that needed one, and there is no timer behind discovery to fix it later.
 *
 * Driven through main's own channel rather than asserted on call counts: a
 * panel that called `configure` and then rendered nothing new is the bug.
 */
describe('read now actually reads', () => {
  it('reads the job list first for an account that has none', async () => {
    let push: ((s: CicdPanelState) => void) | undefined
    const b = bridge({
      snapshot: vi.fn(async () => [
        state({ readAt: undefined, pipelines: [], error: 'dial tcp: timed out', failures: 2 })
      ]),
      onState: vi.fn((h: (s: CicdPanelState) => void) => {
        push = h
        return () => undefined
      }),
      // The poller has no target for this account, so this reads nothing.
      refresh: vi.fn(async () => undefined),
      // Discovery is the only thing that can get it off the ground.
      configure: vi.fn(async () => {
        push?.(state())
      })
    })
    render(<CicdPanel connections={[CONN]} bridge={b} />)
    await screen.findByText(/could not be read/)

    await userEvent.click(screen.getByRole('button', { name: /^Refresh$/ }))
    expect(await screen.findByText('deploy')).toBeTruthy()
  })

  it('does not re-walk the estate for an account whose job list is already known', async () => {
    let push: ((s: CicdPanelState) => void) | undefined
    const b = bridge({
      snapshot: vi.fn(async () => [state({ error: 'dial tcp: timed out', failures: 2 })]),
      onState: vi.fn((h: (s: CicdPanelState) => void) => {
        push = h
        return () => undefined
      }),
      // Targets exist, so polling them is the whole job — and rediscovery here
      // would be a folder walk of every controller for a button press.
      refresh: vi.fn(async () => {
        push?.(state({ pipelines: [pipeline({ name: 'release', last: run() })] }))
      }),
      configure: vi.fn(async () => undefined)
    })
    render(<CicdPanel connections={[CONN]} bridge={b} />)
    await screen.findByText('deploy')

    await userEvent.click(screen.getByRole('button', { name: /^Retry$/ }))
    expect(await screen.findByText('release')).toBeTruthy()
    expect(screen.queryByText(/could not be read/)).toBeNull()
  })
})
