import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import {
  chmodSync,
  chownSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendLogLine } from '../src/main/services/logAppend'
import { appendCredProxyAudit } from '../src/main/services/credProxy'
import type { CredProxyCall } from '../src/shared/credproxy'

// The two gaps `appendFileSync(file, line, { mode: 0o600 })` left, and the one
// place the app's four append-only logs now close them.
//
// Both cases are ones the obvious test never reached: a mode assertion on a file
// the test itself just created is green in the only situation that was never at
// risk, and a log that has only ever been written by this process is a log
// nobody pre-created anything at.

const dir = mkdtempSync(join(tmpdir(), 'logappend-'))
const FILE = join(dir, 'log.jsonl')
const ELSEWHERE = join(dir, 'somewhere-else.jsonl')

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(FILE, { force: true })
  rmSync(ELSEWHERE, { force: true })
})

const modeOf = (f: string): number => statSync(f).mode & 0o777

describe('the append itself', () => {
  it('creates the file and the rows read back', () => {
    appendLogLine(FILE, 'one\n')
    appendLogLine(FILE, 'two\n')
    expect(readFileSync(FILE, 'utf8')).toBe('one\ntwo\n')
  })

  it('lands every byte of a large row, which reads back as one JSON object', () => {
    // `writeSync` is a SINGLE write(2) and its return value was ignored, so a
    // short write — ENOSPC on a nearly full volume, an interrupting signal, a
    // network-mounted userData — truncated a record mid-JSON and the next append
    // glued onto the fragment. Readers tolerate that per line and retention KEEPS
    // an unparseable line, so the row was lost and the damaged line outlived
    // every prune. `writeFileSync` loops until the buffer is out.
    //
    // A regular file does not short-write on demand, so what this pins is the
    // observable half: the whole row arrives, byte for byte, and parses.
    const row = JSON.stringify({ id: 'big', blob: 'x'.repeat(512 * 1024) })
    appendLogLine(FILE, `${row}\n`)
    const raw = readFileSync(FILE, 'utf8')
    expect(raw.length).toBe(row.length + 1)
    expect(raw.split('\n').filter(Boolean)).toHaveLength(1)
    expect((JSON.parse(raw) as { blob: string }).blob.length).toBe(512 * 1024)
  })

  it('appends rather than replacing — the history is the point', () => {
    writeFileSync(FILE, 'already here\n')
    appendLogLine(FILE, 'new\n')
    expect(readFileSync(FILE, 'utf8')).toBe('already here\nnew\n')
  })
})

describe.skipIf(process.platform === 'win32')('the mode of a file that already existed', () => {
  it('tightens a 0666 file to 0600, keeping what was in it', () => {
    // The whole of gap one. `mode:` applies when the file is CREATED, so a log
    // written before that argument existed, restored from a tarball, or
    // pre-created by anything else running as this user stayed world-readable
    // for the rest of its life with nothing anywhere to say so.
    writeFileSync(FILE, 'old row\n')
    // chmod rather than writeFileSync's `mode`, and for the same reason this
    // whole file exists: the creation mode is masked by the umask, so on a
    // normal machine the precondition would quietly be 0644 and the test would
    // be asserting something weaker than it claims.
    chmodSync(FILE, 0o666)
    expect(modeOf(FILE)).toBe(0o666)
    appendLogLine(FILE, 'new row\n')
    expect(modeOf(FILE)).toBe(0o600)
    expect(readFileSync(FILE, 'utf8')).toBe('old row\nnew row\n')
  })

  it('creates a new file 0600', () => {
    appendLogLine(FILE, 'row\n')
    expect(modeOf(FILE)).toBe(0o600)
  })
})

describe.skipIf(process.platform === 'win32')('a symlink at the log path', () => {
  it('is refused, and nothing is written through it', () => {
    writeFileSync(ELSEWHERE, 'not ours\n')
    symlinkSync(ELSEWHERE, FILE)
    expect(() => appendLogLine(FILE, 'a row about a real action\n')).toThrow(/symlink/)
    expect(readFileSync(ELSEWHERE, 'utf8')).toBe('not ours\n')
    // The link is left where it is rather than cleared: this function declines,
    // it does not delete things at the path a log lives at. jsonlPrune.ts clears
    // its path because nothing should ever be there; here something should.
    expect(lstatSync(FILE).isSymbolicLink()).toBe(true)
  })

  it('is refused when it dangles, which is what lstat buys over stat', () => {
    // stat() follows the link, so a link to a file that does not exist yet
    // reports "nothing here" — and the append would then CREATE the target, at
    // a path somebody else chose, 0600 and full of rows.
    symlinkSync(ELSEWHERE, FILE)
    expect(() => appendLogLine(FILE, 'a row about a real action\n')).toThrow(/symlink/)
    expect(existsSync(ELSEWHERE)).toBe(false)
  })
})

describe.skipIf(process.platform === 'win32')('a log file this process does not own', () => {
  // The gap the swallowed fchmod left open. Swallowing is right for a filesystem
  // with no POSIX modes — exFAT on a stick, portable mode's likely home — and it
  // is ALSO what happens when the file belongs to somebody else: the fchmod
  // fails EPERM, the failure is swallowed, and the rows are then appended into
  // their file, at this app's own predictable path, forever. The symlink guard
  // does not cover it; neither O_NOFOLLOW nor lstat asks who owns the file.

  it('refuses a file reached by a HARD link, which no symlink check sees', () => {
    // The same outcome as the foreign-uid case, and the one half of it a test
    // can stage without being root: two names, one inode, so whoever holds the
    // other name reads every row. O_NOFOLLOW does not see a hard link and there
    // is no link for lstat to find — the fstat on the open descriptor is what
    // catches it.
    writeFileSync(ELSEWHERE, 'theirs\n')
    linkSync(ELSEWHERE, FILE)
    expect(statSync(FILE).nlink).toBe(2)
    expect(() => appendLogLine(FILE, 'a row about a real action\n')).toThrow(/hard link/)
    expect(readFileSync(ELSEWHERE, 'utf8')).toBe('theirs\n')
  })

  it('is happy with the ordinary one-name, one-owner file', () => {
    // The precondition for the above being a refusal rather than a breakage:
    // every real log has exactly one link and this process's uid.
    appendLogLine(FILE, 'row\n')
    const st = statSync(FILE)
    expect(st.nlink).toBe(1)
    expect(st.uid).toBe(process.getuid?.())
    expect(readFileSync(FILE, 'utf8')).toBe('row\n')
  })

  // The uid half cannot be staged without root: chown to another user needs it,
  // and CI runs as an unprivileged user. So it runs only where it CAN be staged
  // rather than being faked green somewhere it cannot.
  it.skipIf(process.getuid?.() !== 0)('refuses a file owned by another uid', () => {
    writeFileSync(FILE, 'pre-created\n')
    // 1/1 is daemon on macOS and daemon/daemon on Linux; any uid that is not 0
    // makes the point.
    chownSync(FILE, 1, 1)
    expect(() => appendLogLine(FILE, 'a row about a real action\n')).toThrow(/owned by uid 1/)
    expect(readFileSync(FILE, 'utf8')).toBe('pre-created\n')
  })
})

describe('failure is raised, because every caller catches', () => {
  it('throws rather than failing quietly when the path cannot be opened', () => {
    // Each of the four writers wraps its append in a try/catch that does nothing
    // but console.error, so a log that cannot be written does not take down the
    // action the row was about. That contract only holds if this function is
    // honest about failing.
    expect(() => appendLogLine(join(dir, 'no-such-dir', 'log.jsonl'), 'row\n')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// The credential proxy's audit: the one of the four writers that takes its path
// as an argument, because that module may not import electron and so cannot
// resolve userData for itself. Its integration case lives here rather than in
// credProxyServer.test.ts for the same reason — no listener is needed to write
// a row.
// ---------------------------------------------------------------------------
describe('appendCredProxyAudit', () => {
  const call = (id: string): CredProxyCall => ({
    id,
    at: '2026-01-01T00:00:00.000Z',
    method: 'GET',
    origin: 'https://api.example.com',
    path: '/v1/models',
    ruleId: 'r1',
    ruleName: 'Example',
    outcome: 'forwarded',
    status: 200,
    ms: 12
  })

  it('writes a readable row', () => {
    appendCredProxyAudit(FILE, call('c1'))
    const rows = readFileSync(FILE, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as CredProxyCall)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('c1')
    expect(rows[0].origin).toBe('https://api.example.com')
  })

  it.skipIf(process.platform === 'win32')('tightens a pre-existing 0666 file to 0600', () => {
    writeFileSync(FILE, '')
    chmodSync(FILE, 0o666)
    appendCredProxyAudit(FILE, call('c2'))
    expect(modeOf(FILE)).toBe(0o600)
  })

  it.skipIf(process.platform === 'win32')('refuses a symlink without throwing', () => {
    // This file says which credential went to which host, which makes it the
    // one of the four that most rewards being redirected. It is also written
    // from inside a live request, so a throw here would surface as a proxy
    // failure on a call that actually succeeded.
    writeFileSync(ELSEWHERE, 'not ours\n')
    symlinkSync(ELSEWHERE, FILE)
    expect(() => appendCredProxyAudit(FILE, call('c3'))).not.toThrow()
    expect(readFileSync(ELSEWHERE, 'utf8')).toBe('not ours\n')
  })
})
