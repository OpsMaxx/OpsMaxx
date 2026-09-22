import { describe, expect, it } from 'vitest'
import type { SshHop } from '../src/shared/ssh'
import { hopKey, keyOwnsServer } from '../src/main/services/ssh'

/**
 * A server you edited is the server you connect to.
 *
 * The pool is a ControlMaster: one authenticated connection per server, shared
 * by every terminal, the file browser and the metrics sampler. Its key was
 * `srv:<serverId>` and nothing else — so editing a server's host, port,
 * username or auth changed the record and left the key identical, and the next
 * connect was handed the socket already authenticated to the old machine.
 *
 * Reported as: edited a server's SSH credentials, saved, clicked it in the
 * sidebar, still landed on the previous host. Closing the tab and reopening it
 * did not help, because the entry survives for `sshMasterIdleMinutes` and the
 * metrics sampler keeps re-referencing it so the idle timer rarely fires.
 *
 * `hopKey` had already made this argument once for a different field — its own
 * comment says `vpnProfileId` is in the key so a server whose profile changed
 * cannot reuse a connection riding the old tunnel — and the reasoning was
 * never carried one field further.
 */

function hop(over: Partial<SshHop & { serverId: string; rev: number }> = {}): SshHop & {
  serverId: string
  rev?: number
} {
  return {
    serverId: 's1',
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    auth: 'password',
    ...over
  }
}

describe('hopKey carries the record revision', () => {
  it('separates two revisions of the same server', () => {
    expect(hopKey(hop({ rev: 1 }))).not.toBe(hopKey(hop({ rev: 2 })))
  })

  it('is stable for an unchanged record, so the pool still hits', () => {
    expect(hopKey(hop({ rev: 4 }))).toBe(hopKey(hop({ rev: 4 })))
  })

  it('keeps today’s exact key for a record that was never edited', () => {
    // Every server saved before `rev` existed has none, and must not be
    // re-authenticated on upgrade just because this field arrived.
    expect(hopKey(hop())).toBe('srv:s1')
  })

  it('separates an edited host once the revision moves with it', () => {
    // The edit that motivated all of this: same saved server, different box.
    const before = hopKey(hop({ host: '10.0.0.1', rev: 1 }))
    const after = hopKey(hop({ host: '10.0.0.2', rev: 2 }))
    expect(before).not.toBe(after)
  })
})

describe('keyOwnsServer still recognises its own keys', () => {
  it('matches a key carrying every optional segment', () => {
    // The regression guard for appending `rev` as its own `|` segment rather
    // than folding it into `srv:<id>`. Folding it in would leave this false,
    // which silently breaks `poolEvictServer` — and therefore the reconnect
    // after a reboot, which is the one caller that existed before this change.
    expect(keyOwnsServer('srv:s1|vpn:v1|fwd:v1|rev:4', 's1')).toBe(true)
  })

  it('reaches a bastion in the middle of a chain', () => {
    // A chain is only as live as the bastion carrying it. The old test looked
    // at the last segment only, so evicting a jump host left every chain
    // across it sitting in the pool looking usable.
    expect(keyOwnsServer('srv:bastion>srv:target', 'bastion')).toBe(true)
  })

  it('still reaches the far end of a chain', () => {
    expect(keyOwnsServer('srv:bastion>srv:target', 'target')).toBe(true)
  })

  it('does not match an unrelated server', () => {
    expect(keyOwnsServer('srv:bastion>srv:target', 's1')).toBe(false)
  })

  it('does not match on a shared id prefix', () => {
    expect(keyOwnsServer('srv:s1a', 's1')).toBe(false)
  })
})
