import { describe, it, expect } from 'vitest'

import {
  TOKEN_FULLY_MASKED,
  TOKEN_VISIBLE_CHARS,
  containsBearerToken,
  maskBearerTokens,
  maskToken
} from '../src/shared/tokenDisplay'

// A real 64-hex bridge token, of the shape the page used to print in full.
const TOKEN = '104162926be3692f3e60f75e56e1c126fd41c55f69c4e9fe4710ef76e482e5c0'
const CLI = `claude mcp add -s user --transport http opsmaxx http://127.0.0.1:5177/mcp --header "Authorization: Bearer ${TOKEN}"`
const JSON_SNIPPET = `{"mcpServers":{"opsmaxx":{"url":"http://127.0.0.1:5177/mcp","headers":{"Authorization":"Bearer ${TOKEN}"}}}}`

describe('the token stops being readable', () => {
  it('keeps only the head and tail', () => {
    expect(maskToken(TOKEN)).toBe('1041…e5c0')
  })

  // The load-bearing assertion: no run of the secret long enough to be useful
  // survives. Written as "the middle is gone" rather than as an equality, so a
  // future change to the visible-character count still has to satisfy it.
  it('leaves nothing usable in the middle', () => {
    const masked = maskToken(TOKEN)
    expect(masked).not.toContain(TOKEN.slice(TOKEN_VISIBLE_CHARS, -TOKEN_VISIBLE_CHARS))
    expect(masked.replace('…', '').length).toBe(TOKEN_VISIBLE_CHARS * 2)
  })

  // Enough survives to tell one session from another — that is the whole reason
  // this is a mask and not a redaction.
  it('keeps enough to identify which session it is', () => {
    expect(maskToken(TOKEN).startsWith(TOKEN.slice(0, 4))).toBe(true)
    expect(maskToken(TOKEN).endsWith(TOKEN.slice(-4))).toBe(true)
    expect(maskToken(TOKEN)).not.toBe(maskToken(`aaaa${TOKEN.slice(4)}`))
  })

  // Below the threshold `abcd…wxyz` would leak most of the value while looking
  // as though it had hidden it, which is worse than saying nothing.
  it('replaces a value too short to abbreviate rather than half-showing it', () => {
    for (const s of ['abc', 'abcdefgh', 'abcdefghijk']) {
      expect(maskToken(s)).toBe(TOKEN_FULLY_MASKED)
      expect(maskToken(s)).not.toContain(s.slice(0, 2))
    }
  })

  it('has nothing to say about an empty value', () => {
    expect(maskToken('')).toBe('')
    expect(maskToken('   ')).toBe('')
  })
})

describe('masking inside a command the user still has to be able to read', () => {
  // Masking the whole line would defeat the purpose of showing it: the user is
  // meant to check what they are about to paste into a terminal.
  it('hides the credential and leaves the command legible', () => {
    const out = maskBearerTokens(CLI)
    expect(out).not.toContain(TOKEN)
    expect(out).toContain('claude mcp add')
    expect(out).toContain('http://127.0.0.1:5177/mcp')
    expect(out).toContain('Bearer 1041…e5c0')
  })

  // Anchoring the match on a closing quote would miss the shell form; anchoring
  // it on whitespace alone would swallow the trailing quote and leave the JSON
  // malformed on screen.
  it('handles the JSON form as well as the shell form', () => {
    const out = maskBearerTokens(JSON_SNIPPET)
    expect(out).not.toContain(TOKEN)
    expect(out).toContain('"Bearer 1041…e5c0"')
    expect(() => JSON.parse(out) as unknown).not.toThrow()
  })

  it('masks every occurrence, not only the first', () => {
    const out = maskBearerTokens(`${CLI}\n${JSON_SNIPPET}`)
    expect(out).not.toContain(TOKEN)
    expect(out.match(/1041…e5c0/g)).toHaveLength(2)
  })

  it('leaves text with no token in it exactly as it was', () => {
    const plain = 'claude mcp list'
    expect(maskBearerTokens(plain)).toBe(plain)
    expect(containsBearerToken(plain)).toBe(false)
  })

  it('recognises a token is present before offering to reveal one', () => {
    expect(containsBearerToken(CLI)).toBe(true)
    expect(containsBearerToken(JSON_SNIPPET)).toBe(true)
  })

  // The placeholder the security page prints as documentation is not a secret,
  // and masking it into `<tok…ken>` would make the example unreadable.
  it('leaves the documentation placeholder alone', () => {
    const doc = 'curl -H "Authorization: Bearer <token>"'
    expect(maskBearerTokens(doc)).toBe(doc)
  })
})

describe('a mask that fails open is not a mask', () => {
  // Whatever the shape, the full secret must not survive. Base64 with padding,
  // JWT-style dots, url-safe alphabet — all of them are things a bearer token
  // is in the wild, and a regex tuned only to hex would print them in full.
  it.each([
    ['hex', '104162926be3692f3e60f75e56e1c126'],
    ['base64 padded', 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo='],
    ['url-safe base64', 'abc-def_ghi.jkl~mno+pqr/stu'],
    ['jwt-ish', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def456']
  ])('masks a %s token', (_label, tok) => {
    const out = maskBearerTokens(`Authorization: Bearer ${tok}`)
    expect(out).not.toContain(tok)
  })
})
