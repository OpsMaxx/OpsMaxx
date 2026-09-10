import { describe, expect, it } from 'vitest'

/**
 * A Tailscale node that has not been authorised yet.
 *
 * A tsnet node is OpsMaxx's own device on the tailnet, separate from any
 * Tailscale client the machine may also run, so it has to be approved once in
 * a browser. Everything about that was reported broken at the same time: the
 * link reached the user only as engine log output, reprinted every five
 * seconds, wrapped across two lines and not selectable; and a server routed
 * through the node failed with "Timed out" rather than saying the node was
 * unauthorised.
 */

// The engine's own reminder, printed on a five-second loop while unauthorised.
const REMINDER =
  'To start this tsnet server, restart with TS_AUTHKEY set, or go to: https://login.tailscale.com/a/c01c4a3019247'

type Line = { at: number; stream: 'stdout' | 'stderr' | 'ctl' | 'app'; text: string }
type Collapsed = Line & { repeats: number }

/** The drawer's rule, kept here so it can be tested without a DOM. */
function collapse(lines: Line[]): Collapsed[] {
  const out: Collapsed[] = []
  for (const l of lines) {
    const prev = out[out.length - 1]
    if (prev && prev.text === l.text && prev.stream === l.stream) prev.repeats++
    else out.push({ ...l, repeats: 1 })
  }
  return out
}

describe('collapsing a log that repeats itself', () => {
  it('turns a five-second reminder into one row with a count', () => {
    // Forty minutes of the same sentence is what the drawer held: the log
    // became unreadable exactly while carrying the one line somebody needed.
    const lines: Line[] = Array.from({ length: 480 }, (_, i) => ({
      at: 1000 + i * 5000,
      stream: 'stderr' as const,
      text: REMINDER
    }))
    const out = collapse(lines)
    expect(out).toHaveLength(1)
    expect(out[0].repeats).toBe(480)
  })

  it('keeps the first timestamp of a run, not the last', () => {
    // What a repeated line answers is when it STARTED. That it is still going
    // is what the count says.
    const out = collapse([
      { at: 1000, stream: 'stderr', text: REMINDER },
      { at: 6000, stream: 'stderr', text: REMINDER },
      { at: 11_000, stream: 'stderr', text: REMINDER }
    ])
    expect(out[0].at).toBe(1000)
  })

  it('collapses only consecutive runs, and never merges across other output', () => {
    const out = collapse([
      { at: 1, stream: 'stderr', text: REMINDER },
      { at: 2, stream: 'stderr', text: REMINDER },
      { at: 3, stream: 'ctl', text: 'peer added' },
      { at: 4, stream: 'stderr', text: REMINDER }
    ])
    expect(out.map((l) => l.repeats)).toEqual([2, 1, 1])
    // Nothing is discarded — the same output, counted.
    expect(out.reduce((n, l) => n + l.repeats, 0)).toBe(4)
  })

  it('does not merge identical text arriving on different streams', () => {
    const out = collapse([
      { at: 1, stream: 'stderr', text: 'same' },
      { at: 2, stream: 'app', text: 'same' }
    ])
    expect(out).toHaveLength(2)
  })
})

describe('the status a node reports while it waits', () => {
  // Mirrors drivers/tailscale.ts: the link is a FIELD, and it is cleared the
  // moment the node stops waiting. A link that outlives its state invites
  // authorising twice.
  const authUrlFor = (state: string, replyUrl?: string): string | undefined =>
    state === 'authenticating' ? replyUrl : undefined

  it('carries the link while the node is authenticating', () => {
    expect(authUrlFor('authenticating', 'https://login.tailscale.com/a/abc')).toBe(
      'https://login.tailscale.com/a/abc'
    )
  })

  it('drops the link once the node is connected', () => {
    // The engine keeps handing back the last URL it minted; the card must not
    // keep offering it after the node has joined the tailnet.
    expect(authUrlFor('connected', 'https://login.tailscale.com/a/abc')).toBeUndefined()
  })
})
