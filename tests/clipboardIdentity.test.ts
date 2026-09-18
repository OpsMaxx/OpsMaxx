import { describe, it, expect } from 'vitest'
import {
  EchoSuppressor,
  HASH_PREFIX_BYTES,
  identifyFiles,
  identifyText,
  truncateOnCodePoint
} from '../src/shared/clipboardIdentity'

/**
 * What makes two clipboard entries the same thing.
 *
 * Both fixes to the ported spec are cross-platform bugs, which is exactly
 * where a clipboard lives: the whole feature is one machine's clipboard
 * arriving on another machine running a different operating system.
 */

describe('text', () => {
  it('is the same thing on both sides', () => {
    expect(identifyText('hello').hash).toBe(identifyText('hello').hash)
  })

  it('distinguishes documents that share an opening', () => {
    // The length goes into the hash first and separately. Without it, a prefix
    // hash makes every document sharing a first paragraph one clipboard entry.
    const shared = 'x'.repeat(HASH_PREFIX_BYTES)
    expect(identifyText(shared).hash).not.toBe(identifyText(shared + 'more').hash)
  })

  it('measures size in bytes, not characters', () => {
    // A four-byte emoji is one character. A clipboard that reported 1 would be
    // reporting something no transfer or quota can use.
    expect(identifyText('😀').size).toBe(4)
    expect(identifyText('abcd').size).toBe(4)
  })
})

describe('truncating for the hash', () => {
  it('never splits a character', () => {
    // Hashing a prefix cut at an arbitrary byte can split a multi-byte
    // character, and the two halves of one character are not the same content
    // as either.
    const text = 'a' + '😀'.repeat(10)
    for (let limit = 0; limit < 20; limit++) {
      const cut = truncateOnCodePoint(text, limit)
      expect(cut.length).toBeLessThanOrEqual(limit)
      // Decodes cleanly: a split character round-trips as U+FFFD.
      expect(cut.toString('utf8')).not.toContain('�')
    }
  })

  it('leaves short text alone', () => {
    expect(truncateOnCodePoint('hello', 1000).toString('utf8')).toBe('hello')
  })
})

describe('files', () => {
  it('normalises the name before hashing', () => {
    // THE FIRST DEFECT IN THE PORTED SPEC. macOS hands back decomposed
    // Unicode and Linux and Windows hand back composed, so the same file
    // copied on a Mac and received on Linux hashed differently -- and echo
    // suppression built on that hash then fails to suppress, which is a loop.
    const composed = 'café.txt'.normalize('NFC')
    const decomposed = 'café.txt'.normalize('NFD')
    expect(composed).not.toBe(decomposed) // the platforms really do differ
    expect(identifyFiles([decomposed]).hash).toBe(identifyFiles([composed]).hash)
  })

  it('does not care what order a multi-selection came back in', () => {
    // The platforms do not agree, and the user did not choose one.
    expect(identifyFiles(['b.txt', 'a.txt']).hash).toBe(identifyFiles(['a.txt', 'b.txt']).hash)
  })

  it('cannot be confused by where one name ends and the next begins', () => {
    // Length-prefixed, so these two are different.
    expect(identifyFiles(['ab', 'c']).hash).not.toBe(identifyFiles(['a', 'bc']).hash)
  })

  it('is not the same as text with the same content', () => {
    expect(identifyFiles(['a.txt']).hash).not.toBe(identifyText('a.txt').hash)
  })
})

describe('echo suppression', () => {
  it('ignores our own write coming back', () => {
    const echo = new EchoSuppressor()
    const { hash } = identifyText('pasted from the other machine')
    echo.arm(hash)
    expect(echo.shouldIgnore(hash)).toBe(true)
  })

  it('does NOT swallow the user copying the same thing twice', () => {
    // The obvious design -- compare against the last hash seen -- gets this
    // wrong, and gets it wrong invisibly: the second copy simply never
    // arrives on the other machine.
    const echo = new EchoSuppressor()
    const { hash } = identifyText('hello')
    echo.arm(hash)
    expect(echo.shouldIgnore(hash)).toBe(true) // ours
    expect(echo.shouldIgnore(hash)).toBe(false) // theirs, again, deliberately
  })

  it('stops suppressing once the window passes', () => {
    // The platform's clipboard notification is neither instant nor ordered, so
    // the window cannot be zero -- and it must not be long, or a genuine
    // re-copy inside it is swallowed.
    let now = 1_000_000
    const echo = new EchoSuppressor(2000, () => now)
    const { hash } = identifyText('hello')
    echo.arm(hash)
    now += 5000
    expect(echo.shouldIgnore(hash)).toBe(false)
  })

  it('does not suppress something else that arrives while armed', () => {
    const echo = new EchoSuppressor()
    echo.arm(identifyText('what we wrote').hash)
    // The user copied something of their own in between. It must still be
    // sent, and the arming must survive for the write it was for.
    expect(echo.shouldIgnore(identifyText('what they copied').hash)).toBe(false)
    expect(echo.shouldIgnore(identifyText('what we wrote').hash)).toBe(true)
  })
})
