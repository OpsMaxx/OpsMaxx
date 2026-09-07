import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  ENV_WRITE_DISCLOSURE,
  applyEnvWrite,
  escapeEnvValue,
  planEnvWrite,
  validateEnvName
} from '../src/shared/envWrite'

// Writing one variable into a `.env`, with the value from the vault.
//
// The escaping half is checked against a RECORDED MEASUREMENT, not against what
// the documentation says compose does: `env-escaping.env` is the file that was
// written, `env-escaping-values.json` is what was intended, and
// `env-escaping-container-env.b64` is `env -0 | base64` taken from inside a
// container that compose started from that file. Eleven values including an
// apostrophe, a `#`, trailing spaces, an empty string, a newline and a literal
// `${NOPE}` came back byte-identical.

const fx = (n: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/compose/${n}`, import.meta.url)), 'utf8')

describe('the escaping, against what a container actually received', () => {
  const intended = JSON.parse(fx('env-escaping-values.json')) as Record<string, string>

  it('produces the exact bytes that were measured', () => {
    // The fixture `.env` was written by this same rule. Re-deriving it here is
    // what ties the function to the measurement: change the escaper and this
    // stops matching the file a real compose read.
    const rebuilt = Object.entries(intended)
      .map(([k, v]) => `${k}=${escapeEnvValue(v)}`)
      .join('\n')
    expect(`${rebuilt}\n`).toBe(fx('env-escaping.env'))
  })

  it('round-trips every measured value through the container’s own environment', () => {
    const raw = Buffer.from(fx('env-escaping-container-env.b64').trim(), 'base64').toString('utf8')
    const seen = new Map<string, string>()
    for (const item of raw.split('\0')) {
      if (item === '') continue
      const i = item.indexOf('=')
      seen.set(item.slice(0, i), item.slice(i + 1))
    }
    for (const [k, v] of Object.entries(intended)) expect(seen.get(k)).toBe(v)
  })

  // Escaping `\` after `"` would also escape the backslashes just added,
  // turning an escaped quote back into a literal one.
  it('escapes the backslash first', () => {
    expect(escapeEnvValue('a"b')).toBe('"a\\"b"')
    expect(escapeEnvValue('a\\b')).toBe('"a\\\\b"')
    expect(escapeEnvValue('a\\"b')).toBe('"a\\\\\\"b"')
  })

  // Measured: inside double quotes compose interpolates `$`.
  it('doubles a dollar so the value is not interpolated', () => {
    expect(escapeEnvValue('${NOPE}')).toBe('"$${NOPE}"')
    expect(escapeEnvValue('pa$$word')).toBe('"pa$$$$word"')
  })

  // Measured: an unquoted value is truncated at an inline `#`, and trailing
  // whitespace is stripped. Quoting is what stops both.
  it('quotes a value with a hash or trailing space', () => {
    expect(escapeEnvValue('abc # def')).toBe('"abc # def"')
    expect(escapeEnvValue('trail   ')).toBe('"trail   "')
  })

  // The shell's `'"'"'` trick is a compose PARSE ERROR, so single quotes were
  // not an option and apostrophes are common in passwords.
  it('carries an apostrophe', () => {
    expect(escapeEnvValue("it's")).toBe('"it\'s"')
  })
})

describe('names', () => {
  it('accepts what compose accepts', () => {
    for (const n of ['A', '_x', 'REDIS_PASSWORD', 'a1_B2']) expect(validateEnvName(n)).toBe(true)
  })
  it('refuses a name that is not one', () => {
    for (const n of ['1A', 'a-b', 'a b', '', 'a=b', 'a.b', null, 42]) {
      expect(validateEnvName(n)).toBe(false)
    }
  })
})

describe('planning', () => {
  const FILE = ['# comment', 'FOO=one', '', 'BAR=two', 'export BAZ=three'].join('\n')

  it('finds the line a name is on', () => {
    expect(planEnvWrite(FILE, 'BAR')).toEqual({ ok: true, name: 'BAR', line: 4, action: 'replace' })
  })

  // Measured: `export FOO=v` is honoured by compose, so it is an occurrence.
  it('counts an export line', () => {
    expect(planEnvWrite(FILE, 'BAZ')).toMatchObject({ action: 'replace', line: 5 })
  })

  it('appends a name that is not there', () => {
    expect(planEnvWrite(FILE, 'NEW')).toEqual({ ok: true, name: 'NEW', line: null, action: 'append' })
  })

  // A `#` cannot start a variable name, so this is the name pattern doing the
  // work rather than a separate comment guard -- which is why there is no
  // separate comment guard.
  it('ignores a commented-out assignment', () => {
    expect(planEnvWrite('# FOO=old\nBAR=x', 'FOO')).toMatchObject({ action: 'append' })
  })

  // Measured: compose takes the LAST occurrence. Writing to the first would
  // leave a changed file and a stack still using the old value.
  it('refuses a duplicate rather than picking one', () => {
    const p = planEnvWrite('FOO=a\nFOO=b', 'FOO')
    expect(p.ok).toBe(false)
    expect(p.ok ? '' : p.reason).toContain('lines 1, 2')
    expect(p.ok ? '' : p.reason).toContain('uses the last one')
  })

  it('refuses a name that is not valid', () => {
    expect(planEnvWrite('A=1', 'not-a-name').ok).toBe(false)
  })

  it('does not match a name that is a prefix of another', () => {
    expect(planEnvWrite('FOOBAR=x', 'FOO')).toMatchObject({ action: 'append' })
  })
})

describe('applying', () => {
  it('replaces only the one line', () => {
    const out = applyEnvWrite('A=1\nB=2\nC=3', planEnvWrite('A=1\nB=2\nC=3', 'B'), 'new')
    expect(out).toBe('A=1\nB="new"\nC=3')
  })

  it('appends with a newline when the file has none', () => {
    expect(applyEnvWrite('A=1', planEnvWrite('A=1', 'B'), 'v')).toBe('A=1\nB="v"\n')
  })

  it('does not add a blank line when the file already ends in one', () => {
    expect(applyEnvWrite('A=1\n', planEnvWrite('A=1\n', 'B'), 'v')).toBe('A=1\nB="v"\n')
  })

  it('writes into an empty file', () => {
    expect(applyEnvWrite('', planEnvWrite('', 'B'), 'v')).toBe('B="v"\n')
  })

  it('keeps comments and blank lines exactly as they were', () => {
    const src = '# keep me\n\nA=1\n# and me\nB=2\n'
    expect(applyEnvWrite(src, planEnvWrite(src, 'A'), 'x')).toBe('# keep me\n\nA="x"\n# and me\nB=2\n')
  })

  it('refuses to apply a plan that failed', () => {
    expect(() => applyEnvWrite('A=1', { ok: false, reason: 'no' }, 'v')).toThrow(/not planned/)
  })

  // The plan is made and used inside one main-process operation, so a
  // disagreement is a bug rather than a race -- and it still refuses.
  //
  // The line has to EXIST and hold something else, or the bounds check catches
  // it first and the re-check is never exercised.
  it('refuses when line 2 is no longer the variable that was planned', () => {
    const plan = planEnvWrite('A=1\nB=2\nC=3', 'B')
    expect(plan).toMatchObject({ line: 2 })
    expect(() => applyEnvWrite('A=1\nZ=9\nC=3', plan, 'v')).toThrow(/no longer matches/)
  })

  it('refuses a plan whose line is past the end of the file', () => {
    const plan = planEnvWrite('A=1\nB=2', 'B')
    expect(() => applyEnvWrite('A=1', plan, 'v')).toThrow(/past the end/)
  })

  it('refuses a value that is not a string', () => {
    expect(() => applyEnvWrite('A=1', planEnvWrite('A=1', 'A'), 42 as unknown as string)).toThrow(
      /non-string/
    )
  })
})

describe('what this module will not do', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/shared/envWrite.ts', import.meta.url)), 'utf8')

  // There is no "already correct, skip" case, because knowing that would mean
  // reading the existing value to compare it.
  it('has no branch that reads an existing value', () => {
    // Comments stripped first. The header EXPLAINS why there is no
    // already-correct case, so a bare search of the file matches the prose
    // saying the branch is absent -- the same trap the mcpServer scan hit.
    const code = src
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')
    // The name is matched up to the first `=`, with no capture for what follows.
    expect(code).toContain('/^\\s*(?:export\\s+)?([A-Za-z_][A-Za-z0-9_]*)\\s*=/')
    expect(code).not.toMatch(/unchanged|alreadySame|skipWrite/i)
  })

  it('says on screen that it cannot tell you the value is already the same', () => {
    expect(ENV_WRITE_DISCLOSURE).toContain('never read this file’s values')
    expect(ENV_WRITE_DISCLOSURE).toContain('cannot tell you whether the value is already the same')
  })
})
