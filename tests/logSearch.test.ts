import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  LOG_SEARCH_FAILURE_HELP,
  LOG_SEARCH_MAX_LINES,
  LOG_SEARCH_MAX_PATTERN,
  buildLogSearchCommand,
  parseLogSearch,
  validateSearchPattern
} from '../src/shared/logSearch'

// Searching the journal over history, across hosts. Every case below was
// recorded from a real host: a match, a bad regex, an empty result, and a
// container with no journald at all.

const fx = (n: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/host/logsearch/${n}`, import.meta.url)), 'utf8')

const build = (r: Parameters<typeof buildLogSearchCommand>[0]): string => {
  const b = buildLogSearchCommand(r)
  if (!b.ok) throw new Error(b.reason)
  return b.command
}

describe('the case trap, which is the reason this module exists', () => {
  // MEASURED on systemd 255 against one day of a real journal:
  //   -g session -> 1135 matches   -g SESSION -> 1
  // `journalctl -g` is smart-case, so which answer an operator gets depends on
  // how they happened to type the word. "I searched for ERROR and it said none"
  // is the failure nobody catches.
  it('always sends --case-sensitive rather than letting the spelling decide', () => {
    expect(build({ pattern: 'error' })).toContain('--case-sensitive=false')
    expect(build({ pattern: 'ERROR' })).toContain('--case-sensitive=false')
    expect(build({ pattern: 'ERROR', caseSensitive: true })).toContain('--case-sensitive=true')
  })

  // The recording proves the flag works: an UPPERCASE pattern, which journald's
  // own default would have matched once, returned real lines.
  it('found matches for an uppercase pattern, which the default would not', () => {
    const p = parseLogSearch(fx('match-forced-insensitive.txt'))
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.lines.length).toBeGreaterThan(0)
    expect(p.lines.join(' ').toLowerCase()).toContain('session')
  })
})

describe('the pattern, which reaches a shell', () => {
  // A regex needs `[ ] . * + ( ) | ^ $`, so an allow-list would refuse the
  // feature itself. Inside single quotes a shell expands none of them.
  it('passes regular expression syntax through untouched', () => {
    for (const p of ['^ERROR', 'a.*b', 'foo|bar', '[0-9]{3}', 'a$', '$HOME', 'x`y`']) {
      expect(validateSearchPattern(p), p).toBe(true)
      expect(build({ pattern: p })).toContain(`-g '${p}'`)
    }
  })

  // The single quote is the only character that can end the quoted word.
  it('refuses a single quote, and nothing else needs refusing', () => {
    expect(validateSearchPattern("it's")).toBe(false)
    expect(buildLogSearchCommand({ pattern: "'; rm -rf /; '" }).ok).toBe(false)
  })

  // Written with fromCharCode rather than as literals: a control character
  // pasted into a source file is invisible to whoever reads it next.
  it('refuses a control character, which would split the command', () => {
    for (const code of [10, 13, 9, 0, 27]) {
      expect(validateSearchPattern(`a${String.fromCharCode(code)}b`), String(code)).toBe(false)
    }
  })

  it('refuses an empty or absurd pattern', () => {
    expect(validateSearchPattern('')).toBe(false)
    expect(validateSearchPattern('   ')).toBe(false)
    expect(validateSearchPattern('x'.repeat(LOG_SEARCH_MAX_PATTERN + 1))).toBe(false)
    expect(validateSearchPattern('x'.repeat(LOG_SEARCH_MAX_PATTERN))).toBe(true)
  })
})

describe('the rest of the request', () => {
  it('validates the times the way the tailer does', () => {
    expect(buildLogSearchCommand({ pattern: 'x', since: "'; id" }).ok).toBe(false)
    expect(buildLogSearchCommand({ pattern: 'x', until: 'not a $(time)' }).ok).toBe(false)
    expect(build({ pattern: 'x', since: '2 hours ago' })).toContain("--since '2 hours ago'")
  })

  it('validates the unit and the priority', () => {
    expect(buildLogSearchCommand({ pattern: 'x', unit: 'a b' }).ok).toBe(false)
    expect(buildLogSearchCommand({ pattern: 'x', priority: 'loud' as never }).ok).toBe(false)
    expect(build({ pattern: 'x', unit: 'nginx.service', priority: 'err' })).toContain(
      "-u 'nginx.service' -p err"
    )
  })

  // Every line crosses the wire, from several hosts at once.
  it('caps the line count, and cannot be argued out of it', () => {
    expect(build({ pattern: 'x' })).toContain(`-n ${LOG_SEARCH_MAX_LINES}`)
    expect(build({ pattern: 'x', limit: 99_999 })).toContain(`-n ${LOG_SEARCH_MAX_LINES}`)
    expect(build({ pattern: 'x', limit: 0 })).toContain('-n 1')
    expect(build({ pattern: 'x', limit: 10 })).toContain('-n 10')
  })
})

describe('reading one host answer', () => {
  // A host with no journald must SAY so. An empty result there would read as
  // "nothing matched", which is a different and confident claim.
  it('separates no journald from no matches', () => {
    const none = parseLogSearch(fx('no-journal.txt'))
    expect(none.ok).toBe(false)
    expect(none.ok === false && none.reason).toBe('no-journal')
    expect(LOG_SEARCH_FAILURE_HELP['no-journal']).toContain('readable as files')

    // journald looked and found nothing. That IS a result.
    const empty = parseLogSearch(fx('no-entries.txt'))
    expect(empty.ok).toBe(true)
    expect(empty.ok && empty.lines).toEqual([])
  })

  it('reports a refused regex in journald own words', () => {
    const bad = parseLogSearch(fx('bad-pattern.txt'))
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.reason).toBe('bad-pattern')
    expect(bad.detail).toContain('missing terminating ]')
  })

  it('names a journal it may not read', () => {
    const p = parseLogSearch('===SP-LOGSEARCH===\nFailed to open journal: Permission denied\n')
    expect(p.ok === false && p.reason).toBe('denied')
  })

  it('says when the cap bit rather than presenting a partial answer as whole', () => {
    const body = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n')
    expect(parseLogSearch(`===SP-LOGSEARCH===\n${body}`, 10)).toMatchObject({ truncated: true })
    expect(parseLogSearch(`===SP-LOGSEARCH===\n${body}`, 50)).toMatchObject({ truncated: false })
  })
})
