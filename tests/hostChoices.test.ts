import { describe, it, expect } from 'vitest'
import { hostChoices, defaultHostId, anyConnected } from '../src/renderer/src/lib/hostChoices'
import type { Server } from '../src/renderer/src/types'

// A server with a live shell open was missing from the Docker dropdown.
//
// Six panels shared `servers.filter((s) => s.status !== 'offline')`, and that
// line did two jobs: it chose the default AND it decided what existed. The
// second job was wrong, because `status` is written from exactly one place —
// the terminal transport's lifecycle callback, on the edge of a connect — and
// nothing re-asserts it. A host this session has not opened reads `offline`
// whether or not it is reachable.
//
// It also answers the wrong question. These panels run docker/kubectl over
// SSH, which dials on demand, so an existing connection is convenient and
// never a precondition. Hiding the row removed the one action that would have
// corrected the field.

const srv = (id: string, status: Server['status']): Server =>
  ({ id, name: id.toUpperCase(), status }) as Server

describe('which hosts a panel offers', () => {
  it('offers every saved host, including ones this session has not dialled', () => {
    const list = hostChoices([srv('a', 'offline'), srv('b', 'online')])
    expect(list.map((h) => h.id)).toEqual(['a', 'b'])
  })

  it('says which are not connected instead of removing them', () => {
    const [a, b] = hostChoices([srv('a', 'offline'), srv('b', 'online')])
    expect(a.note).toBe('not connected')
    expect(b.note, 'nothing to say about the ordinary case').toBe(null)
  })

  it('counts connecting and idle as connected, the way the dropdown always did', () => {
    // The old filter was `!== 'offline'`, so these two were always included.
    // Narrowing that here would be a second bug wearing the fix's clothes.
    for (const s of ['online', 'idle', 'connecting'] as const) {
      expect(hostChoices([srv('x', s)])[0].note, s).toBe(null)
    }
    expect(hostChoices([srv('x', 'offline')])[0].note).toBe('not connected')
  })
})

describe('which host a panel starts on', () => {
  it('prefers one that is already dialled', () => {
    // The defensible half of the old filter: opening a panel on a host already
    // connected is a better first guess than the first one in the list.
    expect(defaultHostId([srv('a', 'offline'), srv('b', 'online')])).toBe('b')
  })

  it('falls back to the first host rather than to nothing', () => {
    // The whole point. With every host "offline" the panel used to have no
    // server to select at all, and silently re-targeted the local daemon.
    expect(defaultHostId([srv('a', 'offline'), srv('b', 'offline')])).toBe('a')
  })

  it('answers null only when there are no hosts', () => {
    expect(defaultHostId([])).toBe(null)
  })
})

describe('what the empty state is allowed to claim', () => {
  it('is about what is dialled, not about what exists', () => {
    expect(anyConnected([srv('a', 'offline')])).toBe(false)
    expect(anyConnected([srv('a', 'offline'), srv('b', 'idle')])).toBe(true)
    expect(anyConnected([])).toBe(false)
  })
})
