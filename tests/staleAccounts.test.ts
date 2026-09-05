import { describe, it, expect } from 'vitest'

import { staleAccounts, summariseStaleAccounts } from '../src/shared/staleAccounts'
import type { AccessAccount } from '../src/shared/access'

// Item 45. The finding this produces is "nobody has used this key"; the failure
// it is written against is calling an account stale because the HOST could not
// answer.
//
// `lastlog` is absent on a growing number of distributions, so "no login
// recorded" is what a perfectly healthy server with no lastlog says -- and it
// is byte-identical to what it says about an account nobody has touched since
// 2019. Reading the first as the second would have somebody revoke a key that
// was used this morning.

const T0 = Date.UTC(2026, 0, 1)
const DAY = 86_400_000

const account = (over: Partial<AccessAccount> = {}): AccessAccount =>
  ({
    user: 'deploy',
    uid: 1001,
    shell: '/bin/bash',
    home: '/home/deploy',
    keys: [{ type: 'ssh-ed25519', comment: 'laptop', fingerprint: 'SHA256:x' }],
    keysStatus: 'ok',
    keyPath: '/home/deploy/.ssh/authorized_keys',
    hasLegacyKeyFile: false,
    passwordLocked: false,
    accountStatus: 'ok',
    expiresText: null,
    expired: false,
    adminGroups: [],
    lastLoginText: 'Mon Dec 1 09:00',
    lastLoginAt: T0 - 30 * DAY,
    neverLoggedIn: false,
    ...over
  }) as AccessAccount

const on = (accounts: AccessAccount[] | null): { serverId: string; serverName: string; accounts: AccessAccount[] | null }[] => [
  { serverId: 's1', serverName: 'web-1', accounts }
]

const verdicts = (accounts: AccessAccount[] | null, days = 90): string[] =>
  staleAccounts(on(accounts), days, T0).map((f) => f.verdict)

describe('what counts as a way in', () => {
  it('ignores an account with no keys and a readable key file', () => {
    // Not a way in, so not a finding. Listing it would bury the ones that are.
    expect(verdicts([account({ keys: [], keysStatus: 'ok' })])).toEqual([])
  })

  it('ignores an account whose expiry has already passed, because sshd already refuses it', () => {
    expect(verdicts([account({ expired: true, lastLoginAt: T0 - 900 * DAY })])).toEqual([])
  })

  it('does NOT treat an unparseable expiry as an expired one', () => {
    // A date nobody could read is not a date in the past.
    expect(verdicts([account({ expired: null, lastLoginAt: T0 - 900 * DAY })])).toEqual(['stale'])
  })

  it('reports an account whose keys could not be read, rather than passing over it', () => {
    for (const s of ['denied', 'unknown', 'no-tool', 'partial'] as const) {
      expect(verdicts([account({ keys: null, keysStatus: s })]), s).toEqual(['unknown'])
    }
  })
})

describe('idle, never used, and could not tell', () => {
  it('calls a key idle past the window and active inside it', () => {
    expect(verdicts([account({ lastLoginAt: T0 - 91 * DAY })], 90)).toEqual(['stale'])
    expect(verdicts([account({ lastLoginAt: T0 - 89 * DAY })], 90)).toEqual(['active'])
  })

  it('separates "never used" from "used a long time ago"', () => {
    // The stronger finding of the two: a key nobody has ever used is a key
    // nobody will miss.
    expect(verdicts([account({ neverLoggedIn: true, lastLoginAt: null })])).toEqual(['never-used'])
  })

  // THE test. A server without lastlog answers this way about every account,
  // including the one somebody logged into a minute ago.
  it('does not call an account stale because the server could not say', () => {
    const v = verdicts([account({ lastLoginAt: null, lastLoginText: null, neverLoggedIn: false })])
    expect(v).toEqual(['unknown'])
  })

  it('says out loud that a missing lastlog looks like this', () => {
    const f = staleAccounts(on([account({ lastLoginAt: null, lastLoginText: null })]), 90, T0)[0]
    expect(f.because).toContain('lastlog')
    expect(f.because).toContain('daily use')
  })

  it('counts whole days since the login, floored', () => {
    const f = staleAccounts(on([account({ lastLoginAt: T0 - 100 * DAY - 3600_000 })]), 90, T0)[0]
    expect(f.daysSinceLogin).toBe(100)
  })

  it('reads nothing at all from a server that was never asked', () => {
    // null accounts is a server that was not read, not a server with none.
    expect(verdicts(null)).toEqual([])
  })
})

describe('the headline an operator decides on', () => {
  it('carries the unknowns, so the number does not shrink as the estate gets harder to read', () => {
    const s = summariseStaleAccounts(
      staleAccounts(
        on([
          account({ user: 'a', lastLoginAt: T0 - 200 * DAY }),
          account({ user: 'b', neverLoggedIn: true, lastLoginAt: null }),
          account({ user: 'c', keys: null, keysStatus: 'denied' })
        ]),
        90,
        T0
      )
    )
    expect(s).toMatchObject({ stale: 1, neverUsed: 1, unknown: 1 })
    expect(s.headline).toContain('never used')
    expect(s.headline).toContain('could not be answered')
  })

  it('says so plainly when there is nothing to do', () => {
    expect(summariseStaleAccounts([]).headline).toContain('used recently')
  })
})
