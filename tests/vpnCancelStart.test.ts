import { describe, it, expect, vi } from 'vitest'

/**
 * Cancelling a start that has not finished.
 *
 * Reported as the Cancel button doing nothing during the connecting phase. It
 * was not doing nothing — it was queued. `vpnStop` runs through the
 * per-profile queue, which exists so a start and a stop can never run
 * alongside each other (see `enqueue`, E50), and a Tailscale start blocks
 * until the node's backend settles: up to a minute on a network that is not
 * answering. The button had no effect for as long as that took, which is
 * exactly the window somebody presses it in.
 *
 * The fix does NOT jump the queue — that guarantee is load-bearing. It
 * shortens what the queue is waiting for: `abortStart` runs first, outside the
 * queue, and makes the in-flight start finish promptly; the stop behind it
 * then runs in order.
 */

/** The manager's rule, in the shape it is written. */
function stopSequence(opts: { force?: boolean } | undefined, hasDriverHook: boolean): string[] {
  const steps: string[] = []
  if (opts?.force && hasDriverHook) steps.push('abortStart')
  steps.push('enqueue')
  steps.push('doStop')
  return steps
}

describe('what a cancel does before it queues', () => {
  it('aborts the in-flight start first, then queues the stop', () => {
    expect(stopSequence({ force: true }, true)).toEqual(['abortStart', 'enqueue', 'doStop'])
  })

  it('still queues — the abort replaces nothing', () => {
    // If this ever stops containing `enqueue`, a stop can run alongside a
    // start, which is the two-engines-one-port failure E50 is about.
    expect(stopSequence({ force: true }, true)).toContain('enqueue')
  })

  it('leaves an ordinary stop exactly as it was', () => {
    // Only Cancel sends `force`. A normal stop has nothing to interrupt.
    expect(stopSequence(undefined, true)).toEqual(['enqueue', 'doStop'])
    expect(stopSequence({}, true)).toEqual(['enqueue', 'doStop'])
  })

  it('works against a driver with no hook at all', () => {
    // `abortStart` is optional: a driver whose start cannot block has nothing
    // to abort, and a cancel must still stop it.
    expect(stopSequence({ force: true }, false)).toEqual(['enqueue', 'doStop'])
  })
})

describe('the abort itself', () => {
  /** The driver's rule: only a live session belonging to an unfinished start. */
  function abort(
    starting: Map<string, { alive: () => boolean; send: (m: string, p: unknown) => Promise<void> }>,
    id: string
  ): boolean {
    const session = starting.get(id)
    if (!session || !session.alive()) return false
    void session.send('ts.down', { tunnelId: id })
    return true
  }

  it('sends ts.down on the session the start is blocked on', () => {
    const send = vi.fn(async () => undefined)
    const starting = new Map([['p1', { alive: () => true, send }]])
    expect(abort(starting, 'p1')).toBe(true)
    expect(send).toHaveBeenCalledWith('ts.down', { tunnelId: 'p1' })
  })

  it('does nothing when no start is in flight', () => {
    // The ordinary case for every other driver and for a profile that is
    // simply running. It must be silent, not an error.
    expect(abort(new Map(), 'p1')).toBe(false)
  })

  it('does nothing when the session has already gone', () => {
    const send = vi.fn(async () => undefined)
    const starting = new Map([['p1', { alive: () => false, send }]])
    expect(abort(starting, 'p1')).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
})
