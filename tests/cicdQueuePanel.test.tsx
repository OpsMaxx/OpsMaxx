// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueuePanel } from '../src/renderer/src/components/cicd/QueuePanel'
import type { CicdBridge, CicdCapacity, CicdConnection } from '../src/shared/cicd'

/**
 * "Why is nothing running."
 *
 * The run feed answers "did it pass", which is a different question and the only
 * one this module used to answer. A queue of four against zero idle executors is
 * a different morning from an empty queue, and the distinction was only
 * available in the provider's own UI.
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

const capacity = (over: Partial<CicdCapacity> = {}): CicdCapacity => ({
  busyExecutors: 0,
  totalExecutors: 2,
  agents: [
    { name: 'Built-In Node', offline: false, temporarilyOffline: false, executors: 2, idle: true, diskFreeBytes: 66_113_196_032 }
  ],
  ...over
})

function bridge(over: Partial<CicdBridge> = {}): CicdBridge {
  return {
    queue: vi.fn(async () => ({ items: [], capacity: capacity() })),
    cancelQueueItem: vi.fn(async () => ({ note: 'Asked Jenkins to drop the queued item.' })),
    ...over
  } as unknown as CicdBridge
}

beforeEach(() => vi.clearAllMocks())

describe('an empty queue', () => {
  it('says nothing is queued, having actually asked', async () => {
    render(<QueuePanel connections={[CONN]} bridge={bridge()} />)
    expect(await screen.findByText('Nothing is queued')).toBeTruthy()
    expect(await screen.findByText(/0 of 2 executors busy/)).toBeTruthy()
  })
})

describe('a queue that is not moving', () => {
  it('shows the provider reason, which is the useful part', async () => {
    const b = bridge({
      queue: vi.fn(async () => ({
        items: [
          { id: 1, name: 'trivy', why: 'Waiting for next available executor', stuck: false, blocked: true, since: Date.now() - 20 * 60_000 }
        ],
        capacity: capacity({ busyExecutors: 2 })
      }))
    })
    render(<QueuePanel connections={[CONN]} bridge={b} />)
    expect(await screen.findByText(/Waiting for next available executor/)).toBeTruthy()
    expect(screen.getByText('BLOCKED')).toBeTruthy()
    expect(screen.getByText(/waiting 20m/)).toBeTruthy()
  })

  it('names capacity as the cause when nothing is free', async () => {
    // The distinction worth drawing: waiting on an executor is not a fault.
    const b = bridge({
      queue: vi.fn(async () => ({
        items: [{ id: 1, name: 'trivy', stuck: false, blocked: false }],
        capacity: capacity({ busyExecutors: 2, totalExecutors: 2 })
      }))
    })
    render(<QueuePanel connections={[CONN]} bridge={b} />)
    expect(await screen.findByText(/waiting on capacity rather than on a fault/)).toBeTruthy()
  })

  it('calls a stuck item stuck, in a word and not only a colour', async () => {
    const b = bridge({
      queue: vi.fn(async () => ({
        items: [{ id: 1, name: 'trivy', stuck: true, blocked: true }],
        capacity: capacity()
      }))
    })
    render(<QueuePanel connections={[CONN]} bridge={b} />)
    expect(await screen.findByText('STUCK')).toBeTruthy()
  })
})

describe('the agents', () => {
  it('separates taken-offline from gone, and gives the reason', async () => {
    const b = bridge({
      queue: vi.fn(async () => ({
        items: [],
        capacity: capacity({
          agents: [
            { name: 'builder-2', offline: true, temporarilyOffline: true, offlineReason: 'Disconnected by admin', executors: 4, idle: false }
          ]
        })
      }))
    })
    render(<QueuePanel connections={[CONN]} bridge={b} />)
    expect(await screen.findByText('TAKEN OFFLINE')).toBeTruthy()
    expect(screen.getByText(/Disconnected by admin/)).toBeTruthy()
  })

  it('shows free disk where the controller reports it', async () => {
    render(<QueuePanel connections={[CONN]} bridge={bridge()} />)
    expect(await screen.findByText(/61\.6 GiB free/)).toBeTruthy()
  })
})

describe('a provider with no queue', () => {
  it('says which provider, instead of showing an empty table', async () => {
    // An empty table reads as "nothing is queued". That is a claim, and for a
    // provider nothing asked it would be a claim nothing had checked.
    const b = bridge({
      queue: vi.fn(async () => {
        throw new Error('github has no build queue OpsMaxx can read, so there is nothing to show here.')
      })
    })
    render(<QueuePanel connections={[CONN]} bridge={b} />)
    expect(await screen.findByText(/github has no build queue/)).toBeTruthy()
    expect(screen.queryByText('Nothing is queued')).toBeNull()
  })

  it('greys the control with its reason when the preload half is older', async () => {
    const partial = bridge()
    delete (partial as unknown as Record<string, unknown>).queue
    render(<QueuePanel connections={[CONN]} bridge={partial} />)
    const btn = await screen.findByRole('button', { name: /read now/i })
    expect(btn.hasAttribute('disabled')).toBe(true)
    expect(btn.getAttribute('title')).toContain('cannot read a queue')
  })
})

describe('reading it again', () => {
  it('re-reads on demand rather than on a timer', async () => {
    const user = userEvent.setup()
    const b = bridge()
    render(<QueuePanel connections={[CONN]} bridge={b} />)
    await screen.findByText('Nothing is queued')
    expect(b.queue).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: /read now/i }))
    expect(b.queue).toHaveBeenCalledTimes(2)
  })
})

describe('dropping a queued item', () => {
  const queued = {
    items: [{ id: 7, name: 'trivy', stuck: false, blocked: true }],
    capacity: capacity()
  }

  it('offers nothing when cicdTrigger is off', async () => {
    const b = bridge({ queue: vi.fn(async () => queued) })
    render(<QueuePanel connections={[CONN]} bridge={b} />)
    await screen.findByText('BLOCKED')
    expect(screen.queryByRole('button', { name: /drop/i })).toBeNull()
  })

  it('drops it when it is on, and says what that does not promise', async () => {
    const user = userEvent.setup()
    const b = bridge({ queue: vi.fn(async () => queued) })
    render(<QueuePanel connections={[CONN]} bridge={b} canTrigger />)
    const drop = await screen.findByRole('button', { name: /drop/i })
    // An item that has already started is a running build, and this does not
    // stop one. The control says so rather than implying otherwise.
    expect(drop.getAttribute('title')).toContain('will not stop it')
    await user.click(drop)
    expect(b.cancelQueueItem).toHaveBeenCalledWith('c1', 7)
  })

  it('re-reads afterwards, so the row does not linger after it is gone', async () => {
    const user = userEvent.setup()
    const b = bridge({ queue: vi.fn(async () => queued) })
    render(<QueuePanel connections={[CONN]} bridge={b} canTrigger />)
    await user.click(await screen.findByRole('button', { name: /drop/i }))
    await waitFor(() => expect((b.queue as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(1))
  })
})

/**
 * A read in flight, shown as something that moves.
 *
 * This panel printed `Reading...` as a static line, which is indistinguishable
 * from a read that has hung — and a Jenkins controller under load is exactly
 * when somebody opens this tab.
 */
describe('reading the queue', () => {
  it('shows a moving indicator while the read is in flight, and drops it when it lands', async () => {
    let settle: ((r: { items: never[]; capacity: CicdCapacity }) => void) | undefined
    const b = bridge({
      queue: vi.fn(
        () =>
          new Promise<{ items: never[]; capacity: CicdCapacity }>((res) => {
            settle = res
          })
      )
    })
    render(<QueuePanel connections={[CONN]} bridge={b} />)

    const status = await screen.findByRole('status')
    expect(status.textContent).toMatch(/Reading the queue/)
    // The part that answers "working or hung". A full stop cannot.
    expect(status.querySelector('.spin')).toBeTruthy()

    await act(async () => {
      settle?.({ items: [], capacity: capacity() })
    })
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    expect(await screen.findByText('Nothing is queued')).toBeTruthy()
  })
})
