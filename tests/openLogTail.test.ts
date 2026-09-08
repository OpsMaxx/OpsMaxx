// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'

import { stubBridge } from './setup/renderer'
import { openLogTail, useNav } from '../src/renderer/src/store/nav'

// The jump itself. Driven through the store rather than read out of the source,
// because what matters is the request that lands in state.

beforeEach(() => {
  stubBridge({})
  useNav.setState({ logTailJump: null })
})

const jump = (): Record<string, unknown> =>
  useNav.getState().logTailJump as unknown as Record<string, unknown>

describe('openLogTail', () => {
  // Both panels ignore a jump whose nonce matches the last one they honoured,
  // so that asking twice re-fills rather than being swallowed. This used to be
  // `Date.now()` on both jump kinds, and two clicks inside one millisecond
  // produced the same value -- so the second did nothing, which is precisely
  // the case the nonce exists to handle.
  it('gives every jump a distinct nonce, even in the same millisecond', () => {
    const seen = new Set<number>()
    for (let i = 0; i < 50; i++) {
      openLogTail('srv-1', 'nginx.service')
      seen.add(jump().nonce as number)
    }
    expect(seen.size).toBe(50)
  })


  it('carries journald filters on a unit jump', () => {
    openLogTail('srv-1', 'nginx.service', 'unit', { priority: 'err', since: '2026-09-06 12:00:00 UTC' })
    expect(jump()).toMatchObject({
      kind: 'unit',
      target: 'nginx.service',
      serverId: 'srv-1',
      priority: 'err',
      since: '2026-09-06 12:00:00 UTC'
    })
  })

  // A jump with no filter must not CLEAR one the operator set by hand, so the
  // keys are absent rather than undefined.
  it('leaves the keys absent when it has no filters', () => {
    openLogTail('srv-1', 'nginx.service')
    expect('priority' in jump()).toBe(false)
    expect('since' in jump()).toBe(false)
  })

  // `priority` and `since` are journald filters. `validateLogSource` refuses
  // them on a container outright, so a jump that carried them there would build
  // a source the tailer rejects -- a dead end reached by clicking a button.
  it('does not put journald filters on a file or container jump', () => {
    openLogTail('srv-1', '/var/log/syslog', 'file', { priority: 'err', since: 'yesterday' })
    expect('priority' in jump()).toBe(false)
    expect('since' in jump()).toBe(false)

    openLogTail('srv-1', 'web', 'container', { priority: 'err', since: 'yesterday' })
    expect('priority' in jump()).toBe(false)
    expect('since' in jump()).toBe(false)
  })
})
