import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, dialog } from 'electron'
import { atomicWriteFileSync } from '../src/main/services/atomicWrite'
import { knownHostList, verifyHostKey } from '../src/main/services/knownhosts'
import { writeCredProxyFile } from '../src/main/services/credProxy'
import { writeClaudeDesktopConfigTo } from '../src/main/services/clientConfig'

// The two gaps `writeFileSync(tmp, data, { mode: 0o600 })` + `renameSync` left,
// and the one place the app's thirteen temp-then-rename writers now close them.
//
// Both are gaps the obvious test never reached: a mode assertion on a temp file
// the test itself just created is green in the only situation that was never at
// risk, and a temp path nothing has ever pre-created is a temp path no symlink
// was ever planted at.
//
// NOTE on the preconditions below: `writeFileSync(f, x, { mode: 0o666 })` is
// masked by the umask, so a wide-mode precondition set that way silently asserts
// nothing. Every one here is set with an explicit chmodSync.

const dir = mkdtempSync(join(tmpdir(), 'atomicwrite-'))
const FILE = join(dir, 'data.json')
const TMP = `${FILE}.tmp`
const VICTIM = join(dir, 'victim.txt')

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(FILE, { force: true })
  rmSync(TMP, { force: true })
  rmSync(VICTIM, { force: true })
})

const modeOf = (f: string): number => statSync(f).mode & 0o777

describe('the write itself', () => {
  it('lands the contents and removes the temp file', () => {
    atomicWriteFileSync(FILE, 'hello')
    expect(readFileSync(FILE, 'utf8')).toBe('hello')
    expect(existsSync(TMP)).toBe(false)
  })

  it('replaces the previous contents whole', () => {
    atomicWriteFileSync(FILE, 'first')
    atomicWriteFileSync(FILE, 'second')
    expect(readFileSync(FILE, 'utf8')).toBe('second')
  })

  it('honours a custom temp path, because two suffixes are in use', () => {
    const tmp = `${FILE}.opsmaxx-tmp`
    atomicWriteFileSync(FILE, 'x', 0o600, tmp)
    expect(readFileSync(FILE, 'utf8')).toBe('x')
    expect(existsSync(tmp)).toBe(false)
  })

  it('refuses a temp path that IS the file, instead of deleting it', () => {
    // The sequence opens by clearing the temp path, so the same path for both
    // would unlink the real file before the open — the caller's data gone, and
    // gone before anything could fail loudly. No current caller can get here;
    // this is the guard that keeps a future one from defaulting the argument
    // wrong. Both textual variants of the one path, because the check resolves.
    writeFileSync(FILE, 'precious')
    expect(() => atomicWriteFileSync(FILE, 'x', 0o600, FILE)).toThrow(/tmpPath/)
    expect(() => atomicWriteFileSync(FILE, 'x', 0o600, `${dir}/./data.json`)).toThrow(/tmpPath/)
    expect(readFileSync(FILE, 'utf8')).toBe('precious')
  })
})

describe('GAP ONE — the mode the real file ends up with', () => {
  it.skipIf(process.platform === 'win32')('creates the real file 0600', () => {
    atomicWriteFileSync(FILE, 'x')
    expect(modeOf(FILE)).toBe(0o600)
  })

  it.skipIf(process.platform === 'win32')(
    'is 0600 even when a WIDE temp file was already sitting at the temp path',
    () => {
      // The gap itself: `mode` applies only on creation, so the old form kept
      // this 0644 and the rename carried it onto the real file.
      writeFileSync(TMP, 'stale')
      chmodSync(TMP, 0o666)
      expect(modeOf(TMP)).toBe(0o666)

      atomicWriteFileSync(FILE, 'fresh')
      expect(readFileSync(FILE, 'utf8')).toBe('fresh')
      expect(modeOf(FILE)).toBe(0o600)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'narrows a real file that was already there at 0644, because rename replaces the inode',
    () => {
      writeFileSync(FILE, 'old')
      chmodSync(FILE, 0o644)
      atomicWriteFileSync(FILE, 'new')
      expect(modeOf(FILE)).toBe(0o600)
    }
  )

  it.skipIf(process.platform === 'win32')('uses the mode it is given, not a hardcoded one', () => {
    // `openSync(path, 'wx', mode)` is MASKED by the process umask, so a WIDE
    // mode is a request and not a guarantee: 0644 lands 0640 under `umask 027`,
    // 0600 under `umask 077` and 0444 under `umask 0200`, all three measured. A
    // bare `toBe(0o644)` was therefore green only on a permissive machine and
    // red on a hardened developer box or CI runner — and 027 is an ordinary
    // corporate default, not an exotic one. So the expectation is masked the
    // same way the kernel masks it, and asserts what the call guarantees.
    const umask = process.umask()
    atomicWriteFileSync(FILE, 'x', 0o644)
    expect(modeOf(FILE)).toBe(0o644 & ~umask)

    // Masking alone would let this test go vacuous exactly where it was failing:
    // under `umask 077` the expectation above collapses onto 0600, which is also
    // the default, so it would stop proving the argument is used at all. 0400 is
    // NARROWER than the default, so no umask that leaves the owner readable can
    // disturb it, and seeing it is proof the parameter was honoured.
    atomicWriteFileSync(FILE, 'x', 0o400)
    expect(modeOf(FILE)).toBe(0o400 & ~umask)
  })
})

describe('GAP TWO — a symlink planted at the predictable temp path', () => {
  it('writes the real file and does not touch the symlink target', () => {
    writeFileSync(VICTIM, 'precious')
    symlinkSync(VICTIM, TMP)

    atomicWriteFileSync(FILE, 'mine')

    // Both halves. The old form wrote THROUGH the link — so the victim held
    // `mine` and the rename then installed the victim's inode as the real file.
    expect(readFileSync(VICTIM, 'utf8')).toBe('precious')
    expect(readFileSync(FILE, 'utf8')).toBe('mine')
    expect(existsSync(TMP)).toBe(false)
  })

  it('creates nothing at the far end of a DANGLING symlink', () => {
    const nowhere = join(dir, 'does-not-exist-yet')
    symlinkSync(nowhere, TMP)

    atomicWriteFileSync(FILE, 'mine')

    // The case an existsSync guard would have missed entirely: existsSync stats
    // THROUGH the link, so a dangling one reads as "nothing here".
    expect(existsSync(nowhere)).toBe(false)
    expect(readFileSync(FILE, 'utf8')).toBe('mine')
  })

  it.skipIf(process.platform === 'win32')('gives the real file 0600 even via a wide-linked temp path', () => {
    writeFileSync(VICTIM, 'precious')
    chmodSync(VICTIM, 0o666)
    symlinkSync(VICTIM, TMP)

    atomicWriteFileSync(FILE, 'mine')
    expect(modeOf(FILE)).toBe(0o600)
  })

  it('leaves a planted DIRECTORY at the temp path no way to stop the write', () => {
    // Why the rmSync carries `recursive` as well as `force`: without it this
    // throws EISDIR, and for the callers that swallow their write failure the
    // file would then never save again for the life of the install.
    mkdirSync(join(TMP, 'deep'), { recursive: true })
    writeFileSync(join(TMP, 'deep', 'junk'), 'junk')

    atomicWriteFileSync(FILE, 'mine')
    expect(readFileSync(FILE, 'utf8')).toBe('mine')
  })
})

describe('two callers at the same path', () => {
  it.skipIf(process.platform === 'win32')('refuses to adopt a temp file it did not create', () => {
    // What losing the race looks like from the loser's side: the temp path is
    // already claimed and cannot be cleared, so the write FAILS rather than
    // quietly landing somewhere somebody else chose, and the real file keeps
    // the contents it had.
    const locked = join(dir, 'locked')
    mkdirSync(locked, { recursive: true })
    const real = join(locked, 'data.json')
    writeFileSync(real, 'old')
    writeFileSync(`${real}.tmp`, 'someone else')
    chmodSync(locked, 0o500) // no write bit: the rmSync cannot clear the path

    try {
      expect(() => atomicWriteFileSync(real, 'mine')).toThrow()
      expect(readFileSync(real, 'utf8')).toBe('old')
      expect(readFileSync(`${real}.tmp`, 'utf8')).toBe('someone else')
    } finally {
      chmodSync(locked, 0o700)
      rmSync(locked, { recursive: true, force: true })
    }
  })

  it('never lets the second write land half of the first', () => {
    // Reenacted rather than raced: the sequence is synchronous and cannot be
    // preempted in-process, and a real race here is sub-microsecond, so a test
    // that only sometimes reaches it only sometimes means anything.
    //
    // A claims the temp path, then B runs start to finish — B's own rmSync
    // unlinks A's temp file, B claims the path, writes, renames. A is then
    // holding a descriptor with no name, and the one thing that must be true is
    // that its rename cannot put a partial file where B's complete one is.
    rmSync(TMP, { force: true })
    const fdA = openSync(TMP, 'wx', 0o600)
    try {
      atomicWriteFileSync(FILE, 'B')
      writeSync(fdA, 'A')
    } finally {
      closeSync(fdA)
    }
    expect(() => renameSync(TMP, FILE)).toThrow(/ENOENT/)
    expect(readFileSync(FILE, 'utf8')).toBe('B')
  })
})

describe('a crash between the write and the rename', () => {
  it.skipIf(process.platform === 'win32')('cannot truncate or half-write the real file', () => {
    // A real helper call that fails AFTER the temp file is written and at the
    // rename: the temp lives in a writable directory and the real file in one
    // with no write bit, so rename(2) is the syscall that refuses. That is the
    // same window a power loss lands in, and the property CONTRIBUTING.md rule 4
    // exists for — the real file is the previous good copy or the complete new
    // one, never half of either.
    const locked = join(dir, 'crash')
    mkdirSync(locked, { recursive: true })
    const real = join(locked, 'data.json')
    const tmp = join(dir, 'crash.tmp')
    writeFileSync(real, 'the previous good copy')
    chmodSync(locked, 0o500)

    try {
      expect(() => atomicWriteFileSync(real, 'x'.repeat(4096), 0o600, tmp)).toThrow()
      expect(readFileSync(real, 'utf8')).toBe('the previous good copy')
      // The interrupted attempt is all that is left behind, and it is 0600 —
      // which is what makes the NEXT write safe to clear it and start over.
      expect(modeOf(tmp)).toBe(0o600)
    } finally {
      chmodSync(locked, 0o700)
      rmSync(locked, { recursive: true, force: true })
    }

    // And the leftover does not jam the next save.
    atomicWriteFileSync(FILE, 'after the crash', 0o600, tmp)
    expect(readFileSync(FILE, 'utf8')).toBe('after the crash')
  })
})

// --------------------------------------------------------------------------
// Three sites end to end, chosen because they are the ones where the write IS
// the security decision: the SSH host-key pins (what stops a
// machine-in-the-middle), the credential proxy's rule file (where the user's
// API keys are allowed to go), and the MCP client config (a live bearer token,
// written OUTSIDE userData — so the 0700 directory that covers the rest of
// these does not reach it, and it was also the one writer that passed no mode
// at all). The other ten are preference and state files behind the same helper.
// --------------------------------------------------------------------------

describe('the SSH host-key store refuses a symlink at its temp path', () => {
  const file = join(app.getPath('userData'), 'opsmaxx-known-hosts.json')

  it('pins the host without writing through the link', async () => {
    const victim = join(dir, 'knownhosts-victim')
    writeFileSync(victim, 'precious')
    rmSync(`${file}.tmp`, { force: true })
    symlinkSync(victim, `${file}.tmp`)

    // The mock answers Cancel by default, and Cancel is the branch that never
    // writes — so the pin has to be the one under test.
    const trust = vi
      .spyOn(dialog, 'showMessageBox')
      .mockResolvedValue({ response: 0 } as unknown as Electron.MessageBoxReturnValue)
    try {
      expect(await verifyHostKey('example.test', 2222, Buffer.from('a host key'))).toBe(true)
    } finally {
      trust.mockRestore()
    }

    expect(readFileSync(victim, 'utf8')).toBe('precious')
    expect(knownHostList().some((h) => h.id === 'example.test:2222')).toBe(true)
    expect(lstatSync(file).isSymbolicLink()).toBe(false)
  })
})

describe('the credential proxy rule file refuses a symlink at its temp path', () => {
  it('writes the rules where it was told to', () => {
    const victim = join(dir, 'credproxy-victim')
    const real = join(dir, 'credproxy-rules.json')
    writeFileSync(victim, 'precious')
    symlinkSync(victim, `${real}.tmp`)

    writeCredProxyFile(real, { v: 1, enabled: true, port: 5199, rules: [] })

    expect(readFileSync(victim, 'utf8')).toBe('precious')
    expect(JSON.parse(readFileSync(real, 'utf8')).port).toBe(5199)
  })
})

describe('the MCP client config refuses a symlink at its temp path', () => {
  it('writes the token into its own file, at 0600', () => {
    const victim = join(dir, 'clientconfig-victim')
    const real = join(dir, 'claude_desktop_config.json')
    writeFileSync(victim, 'precious')
    symlinkSync(victim, `${real}.opsmaxx-tmp`)

    const result = writeClaudeDesktopConfigTo(real, 'tok-abc', 5177)

    expect(result.ok).toBe(true)
    expect(readFileSync(victim, 'utf8')).toBe('precious')
    expect(readFileSync(real, 'utf8')).toContain('tok-abc')
    if (process.platform !== 'win32') expect(modeOf(real)).toBe(0o600)
  })
})
