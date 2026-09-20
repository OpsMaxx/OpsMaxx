import { describe, it, expect } from 'vitest'
import { parseAddyLink, addyInviteLink, ADDY_LINK_SCHEME } from '../src/shared/addyLink'

/**
 * A link arrives from outside the product and names a server to talk to while
 * carrying a bearer token to spend there. So these are the tests of a trust
 * boundary, and the refusals matter more than the acceptance.
 */
describe('opsmaxx:// links', () => {
  const ok = 'opsmaxx://sync?relay=https%3A%2F%2Faddy.opsmaxx.dev&invite=' + 'a'.repeat(43)

  it('carries the relay and the invite, which is the whole point', () => {
    const r = parseAddyLink(ok)
    expect('link' in r).toBe(true)
    if (!('link' in r)) return
    expect(r.link.action).toBe('sync')
    expect(r.link.relay).toBe('https://addy.opsmaxx.dev')
    expect(r.link.invite).toBe('a'.repeat(43))
  })

  it('round-trips what the console hands out', () => {
    const built = addyInviteLink('https://addy.opsmaxx.dev/', 'b'.repeat(43))
    const r = parseAddyLink(built)
    expect('link' in r, built).toBe(true)
    if (!('link' in r)) return
    expect(r.link.relay).toBe('https://addy.opsmaxx.dev')
    expect(r.link.invite).toBe('b'.repeat(43))
  })

  // THE REFUSALS. Each names the attack it is refusing.
  const refused: [string, string][] = [
    ['https://addy.opsmaxx.dev/console', 'an ordinary web link is not a sync link'],
    ['opsmaxx://sync?invite=' + 'a'.repeat(43), 'no relay: nothing to join'],
    ['opsmaxx://sync?relay=https%3A%2F%2Faddy.opsmaxx.dev', 'no invite'],
    [
      'opsmaxx://sync?relay=http%3A%2F%2Faddy.opsmaxx.dev&invite=' + 'a'.repeat(43),
      'plain http off-loopback: the invite is readable on the wire'
    ],
    [
      'opsmaxx://sync?relay=https%3A%2F%2Faddy.opsmaxx.dev%40evil.example&invite=' + 'a'.repeat(43),
      'userinfo hiding a different host behind a familiar one'
    ],
    [
      'opsmaxx://sync?relay=https%3A%2F%2Fevil.example%2Faddy.opsmaxx.dev&invite=' + 'a'.repeat(43),
      'a path dressed up to read as the host'
    ],
    ['opsmaxx://drop?relay=https%3A%2F%2Faddy.opsmaxx.dev&invite=x', 'an action this app cannot do'],
    [
      'opsmaxx://sync?relay=https%3A%2F%2Faddy.opsmaxx.dev&invite=' + 'a'.repeat(4000),
      'a token longer than any token'
    ],
    [
      'opsmaxx://sync?relay=https%3A%2F%2Faddy.opsmaxx.dev&invite=a%20b%3Brm%20-rf',
      'anything that is not the token alphabet'
    ]
  ]

  for (const [raw, why] of refused) {
    it(`refuses: ${why}`, () => {
      const r = parseAddyLink(raw)
      expect('reason' in r, `accepted a link it should refuse — ${why}`).toBe(true)
      if ('reason' in r) expect(r.reason.length, 'refused without saying why').toBeGreaterThan(10)
    })
  }

  it('allows a loopback relay over http, because a dev relay is self-signed there', () => {
    const r = parseAddyLink('opsmaxx://sync?relay=http%3A%2F%2F127.0.0.1%3A8443&invite=' + 'c'.repeat(43))
    expect('link' in r).toBe(true)
    if ('link' in r) expect(r.link.relay).toBe('http://127.0.0.1:8443')
  })

  it('takes a pairing link only with both halves', () => {
    const both =
      'opsmaxx://pair?relay=https%3A%2F%2Faddy.opsmaxx.dev&code=' + 'd'.repeat(12) + '&id=' + 'e'.repeat(16)
    expect('link' in parseAddyLink(both)).toBe(true)
    expect('reason' in parseAddyLink('opsmaxx://pair?relay=https%3A%2F%2Fa.example&code=' + 'd'.repeat(12))).toBe(
      true
    )
  })

  it('the scheme is one lowercase word, because the OS registers it verbatim', () => {
    expect(ADDY_LINK_SCHEME).toMatch(/^[a-z][a-z0-9]*$/)
  })
})
