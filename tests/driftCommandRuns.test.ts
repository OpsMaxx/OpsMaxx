import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDriftCommand, type DriftWatch } from '../src/shared/drift'

/**
 * The drift collector, RUN rather than string-matched.
 *
 * Every other test of this command asserts on the text it generates. That is
 * worth having and it is not enough: the escalation branch added here shipped
 * with `fi; fi; fi;` where two were needed, which closed the outer `if` and
 * left the following `elif` orphaned. Every one of the 140 existing tests
 * passed against a script `sh` refuses to parse.
 *
 * So this executes it, against real files with real permission bits, and
 * checks the four answers it can give. `sh -n` alone would have caught the
 * syntax error; running it also pins the CLASSIFICATION, which is where this
 * feature's one serious failure mode lives — reporting a file as absent when
 * the truth is that a permission bit hid it.
 */

let dir: string
const watch = (path: string): DriftWatch => ({
  id: 'w',
  path,
  label: 'w',
  comment: '#',
  rules: [],
  note: 'a temporary file, for this test only'
})

const run = (path: string): string =>
  execFileSync('sh', ['-c', buildDriftCommand({ watches: [watch(path)] })], { encoding: 'utf8' })

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'opsmaxx-drift-'))
  mkdirSync(join(dir, 'ok'))
  mkdirSync(join(dir, 'noread'))
  mkdirSync(join(dir, 'notrav'))
  writeFileSync(join(dir, 'ok', 'f'), 'PermitRootLogin no\n')
  writeFileSync(join(dir, 'noread', 'f'), 'secret\n')
  chmodSync(join(dir, 'noread', 'f'), 0o000)
  writeFileSync(join(dir, 'notrav', 'f'), 'hidden\n')
  chmodSync(join(dir, 'notrav'), 0o000)
})

afterAll(() => {
  chmodSync(join(dir, 'notrav'), 0o755)
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('the generated collector is a script sh will run', () => {
  it('parses, with escalation off', () => {
    expect(() =>
      execFileSync('sh', ['-n'], { input: buildDriftCommand(), encoding: 'utf8' })
    ).not.toThrow()
  })

  it('parses, with escalation on', () => {
    // The branch that had the unbalanced `fi`. Nothing here runs `sudo` — `sh
    // -n` parses without executing — so this is safe in CI and on a laptop.
    expect(() =>
      execFileSync('sh', ['-n'], { input: buildDriftCommand({ sudo: true }), encoding: 'utf8' })
    ).not.toThrow()
  })
})

describe('what it says about a file it cannot read', () => {
  it('reads one it can', () => {
    expect(run(join(dir, 'ok', 'f'))).toMatch(/F w ok /)
  })

  it('says denied for a file whose bits refuse it', () => {
    expect(run(join(dir, 'noread', 'f'))).toMatch(/F w denied/)
  })

  it('says denied — never absent — inside a directory it cannot traverse', () => {
    // The lie this feature must not tell. `[ -e ]` is false either way, so
    // classifying on it alone reports a hardened /etc/ssh as a host with no
    // sshd_config at all.
    const out = run(join(dir, 'notrav', 'f'))
    expect(out).toMatch(/F w denied/)
    expect(out).not.toMatch(/absent/)
  })

  it('says absent when the file really is not there', () => {
    expect(run(join(dir, 'ok', 'nothing-here'))).toMatch(/F w absent/)
  })
})
