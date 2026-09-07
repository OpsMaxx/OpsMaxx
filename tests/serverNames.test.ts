import { describe, it, expect } from 'vitest'

import { disambiguateServerNames, serverLabel } from '../src/shared/serverNames'
import type { NameableServer } from '../src/shared/serverNames'

const s = (over: Partial<NameableServer> & { id: string }): NameableServer => ({
  name: 'demo-box-01',
  host: '127.0.0.1',
  port: 22,
  username: 'root',
  ...over
})

// Two servers called `demo-box-01` rendered identically in the sidebar, on the
// overview cards, in the alert list, in the capacity forecast — and in the row
// you tick to install packages and reboot. The app had the distinguishing data
// all along: its own error messages printed `:22` against `:2222`.

describe('a name that is already unique is left alone', () => {
  // The obvious fix — always append `user@host:port` — is worse than the bug on
  // an estate where every name is unique. A label that is always noisy is one
  // people stop reading, which is how the detail gets missed on the row where
  // it counted.
  it('adds nothing when there is nothing to disambiguate', () => {
    const list = [s({ id: 'a', name: 'web-01' }), s({ id: 'b', name: 'db-01' })]
    const m = disambiguateServerNames(list)
    expect(m.get('a')).toBe('web-01')
    expect(m.get('b')).toBe('db-01')
  })

  it('leaves a whole estate of unique names untouched', () => {
    const list = Array.from({ length: 20 }, (_, i) => s({ id: `s${i}`, name: `host-${i}` }))
    for (const x of list) expect(disambiguateServerNames(list).get(x.id)).toBe(x.name)
  })
})

describe('the shortest suffix that actually separates them', () => {
  it('uses the host when the hosts differ', () => {
    const list = [s({ id: 'a', host: '10.0.0.1' }), s({ id: 'b', host: '10.0.0.2' })]
    const m = disambiguateServerNames(list)
    expect(m.get('a')).toBe('demo-box-01 (10.0.0.1)')
    expect(m.get('b')).toBe('demo-box-01 (10.0.0.2)')
  })

  // The real case from the estate that produced this: same name, same loopback
  // host, two containers on two ports.
  it('falls through to the port when only the port differs', () => {
    const list = [s({ id: 'a', port: 22 }), s({ id: 'b', port: 2222 })]
    const m = disambiguateServerNames(list)
    expect(m.get('a')).toBe('demo-box-01 (127.0.0.1:22)')
    expect(m.get('b')).toBe('demo-box-01 (127.0.0.1:2222)')
  })

  it('falls through to the username when only the account differs', () => {
    const list = [s({ id: 'a', username: 'root' }), s({ id: 'b', username: 'deploy' })]
    const m = disambiguateServerNames(list)
    expect(m.get('a')).toBe('demo-box-01 (root@127.0.0.1:22)')
    expect(m.get('b')).toBe('demo-box-01 (deploy@127.0.0.1:22)')
  })

  // Stops at the first rung that works, rather than always spending the longest
  // one — otherwise two hosts differing only by port would read
  // `root@127.0.0.1:2222` where `:2222` said everything.
  it('does not spend a longer suffix than the ambiguity needs', () => {
    const m = disambiguateServerNames([s({ id: 'a', host: '10.0.0.1' }), s({ id: 'b', host: '10.0.0.2' })])
    expect(m.get('a')).not.toContain('root@')
    expect(m.get('a')).not.toContain(':22')
  })
})

describe('nothing is left ambiguous, whatever the input', () => {
  // THE guarantee. Everything else in this file is a statement about how much
  // noise is added; this is the one that says the defect is gone.
  it.each([
    ['identical hosts and ports', [s({ id: 'a' }), s({ id: 'b' })]],
    ['three the same', [s({ id: 'a' }), s({ id: 'b' }), s({ id: 'c' })]],
    [
      'a mixed estate',
      [
        s({ id: 'a', name: 'web-01' }),
        s({ id: 'b', port: 22 }),
        s({ id: 'c', port: 2222 }),
        s({ id: 'd', name: 'db-01', host: '10.0.0.9' })
      ]
    ]
  ])('produces distinct labels for %s', (_label, list) => {
    const labels = [...disambiguateServerNames(list).values()]
    expect(labels).toHaveLength(list.length)
    expect(new Set(labels).size).toBe(list.length)
  })

  // Two records identical in name, user, host AND port are two entries for one
  // machine. The id suffix always separates, and reads as broken on purpose.
  it('separates records that are identical in every field', () => {
    const m = disambiguateServerNames([s({ id: 'aaaaaaaa-1' }), s({ id: 'bbbbbbbb-2' })])
    expect(m.get('aaaaaaaa-1')).not.toBe(m.get('bbbbbbbb-2'))
    expect(m.get('aaaaaaaa-1')).toContain('aaaaaa')
  })

  // A rung that separates three of five is not enough: leaving two ambiguous is
  // the same defect at a smaller scale.
  it('rejects a rung that separates only some of the group', () => {
    const list = [
      s({ id: 'a', host: '10.0.0.1' }),
      s({ id: 'b', host: '10.0.0.2' }),
      s({ id: 'c', host: '10.0.0.2', port: 2222 })
    ]
    const labels = [...disambiguateServerNames(list).values()]
    expect(new Set(labels).size).toBe(3)
    // host alone cannot separate b from c, so the whole group moves up a rung.
    expect(labels.every((l) => l.includes(':'))).toBe(true)
  })
})

describe('edges', () => {
  it('groups on the trimmed name, so stray whitespace is still a collision', () => {
    const m = disambiguateServerNames([s({ id: 'a', name: 'box' }), s({ id: 'b', name: ' box ' })])
    expect(new Set([...m.values()]).size).toBe(2)
  })

  it('handles an empty list and a single server', () => {
    expect(disambiguateServerNames([]).size).toBe(0)
    expect(disambiguateServerNames([s({ id: 'a' })]).get('a')).toBe('demo-box-01')
  })

  // Callers render `labels.get(id) ?? server.name`, and this mirrors it: a
  // server that is not in the comparison set still gets a name, never ''.
  it('names a server that is not in the list it was compared against', () => {
    expect(serverLabel(s({ id: 'x', name: 'orphan' }), [])).toBe('orphan')
  })

  it('gives one server its label in the context of the rest', () => {
    const a = s({ id: 'a', port: 22 })
    const list = [a, s({ id: 'b', port: 2222 })]
    expect(serverLabel(a, list)).toBe('demo-box-01 (127.0.0.1:22)')
  })
})
