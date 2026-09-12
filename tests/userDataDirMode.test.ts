import { describe, it, expect, vi } from 'vitest'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The mode of the app's own data directory.
//
// Nothing set or checked it before: `app.getPath('userData')` was whatever the
// umask produced, usually 0755, while the files inside it are the secrets file,
// the vault, known_hosts, the inspector's CA key and four 0600 append-only
// logs. A 0600 file under a 0755 directory is still unreadable — the directory
// is what makes ENUMERATING those fixed paths, and PRE-CREATING one of them
// before the app does, available to any other account on the machine. Portable
// mode is the sharper case: the same directory, beside the executable, on
// whatever was plugged in.
//
// ensureUserDataDir takes the directory as an argument purely so this file can
// point it at a temp path; in the app it is called with no argument, at
// portable.ts's module scope, which is before any service module has resolved
// — let alone written — a file under it.

// The mode change has to be made to fail on demand: the only real cases are a
// filesystem with no POSIX modes (FAT32 on a stick, portable mode's likely
// home) and a directory owned by somebody else, neither of which a test can
// produce. Everything else here is the real fs.
//
// `fchmodSync`, not `chmodSync` — the mode now goes on the descriptor of the
// opened directory rather than on the path, and a mock of the function the code
// no longer calls is a test that passes because it asserts nothing.
const state = vi.hoisted(() => ({ chmodThrows: false, chmodCalls: 0 }))
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>()
  return {
    ...real,
    fchmodSync: (fd: number, mode: number): void => {
      state.chmodCalls++
      if (state.chmodThrows) throw Object.assign(new Error('EPERM: not yours'), { code: 'EPERM' })
      real.fchmodSync(fd, mode)
    }
  }
})

const { ensureUserDataDir } = await import('../src/main/portable')

const scratch = (): string => mkdtempSync(join(tmpdir(), 'opsmaxx-userdata-'))
const modeOf = (d: string): number => statSync(d).mode & 0o777

describe('securing the data directory', () => {
  it('creates it when it is not there', () => {
    const dir = join(scratch(), 'OpsMaxx-data')
    ensureUserDataDir(dir)
    expect(statSync(dir).isDirectory()).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('creates it 0700', () => {
    const dir = join(scratch(), 'OpsMaxx-data')
    ensureUserDataDir(dir)
    // Not mkdir's `mode` alone: the umask masks that, which is why the explicit
    // chmod is there and why this asserts the final number.
    expect(modeOf(dir)).toBe(0o700)
  })

  it.skipIf(process.platform === 'win32')('tightens one that already existed at 0755', () => {
    const dir = join(scratch(), 'OpsMaxx-data')
    mkdirSync(dir)
    chmodSync(dir, 0o755)
    ensureUserDataDir(dir)
    expect(modeOf(dir)).toBe(0o700)
  })

  it.skipIf(process.platform === 'win32')(
    'tightens the TARGET of a symlinked directory, because that is where the files go',
    () => {
      // This used to assert the opposite: the chmod was skipped whenever
      // userData was a link, on the reasoning that a linked data directory is a
      // deliberate act and its target is not this app's to change.
      //
      // The case that reasoning misses is the one the protection is for. Nothing
      // here can tell "the user moved their data to another volume" from
      // "somebody pre-created this path as a link to a 0777 directory they own,
      // before the app was ever launched" — mkdirSync(recursive) succeeds on the
      // existing link either way. Skipping meant the secrets file, the vault,
      // known_hosts and four plaintext logs were then written into a directory
      // readable by whoever planted the link.
      //
      // So the mode now goes on the DESCRIPTOR of the directory that was
      // actually opened, which is the directory the app is about to write into,
      // link or not. A genuinely deliberate link gets its target tightened to
      // 0700 as a side effect; that is the trade, and it is the safe direction.
      const base = scratch()
      const real = join(base, 'elsewhere')
      mkdirSync(real)
      chmodSync(real, 0o755)
      const link = join(base, 'OpsMaxx-data')
      symlinkSync(real, link)

      expect(() => ensureUserDataDir(link)).not.toThrow()
      expect(modeOf(real)).toBe(0o700)
      // And the link is still a link: fchmod changes a mode, it does not
      // replace the path with a directory.
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'refuses a path that is not a directory rather than chmodding it',
    () => {
      // O_DIRECTORY's job, and the assertion has to be about the MODE: a file
      // that gets chmodded 0700 is still a file, so `isFile()` here was a check
      // that could not fail. A path-based chmod would tighten it instead of
      // refusing, which is the behaviour being ruled out.
      // The not-throwing half is covered on every platform by the mkdir failure
      // below, which is why this one may skip Windows with its absent modes.
      const path = join(scratch(), 'OpsMaxx-data')
      writeFileSync(path, 'not a directory')
      const before = modeOf(path)
      expect(() => ensureUserDataDir(path)).not.toThrow()
      expect(modeOf(path)).toBe(before)
      expect(modeOf(path)).not.toBe(0o700)
      expect(statSync(path).isFile()).toBe(true)
    }
  )
})

describe('resolving the default directory', () => {
  it('survives an app.getPath that throws, without taking module scope down', async () => {
    // `dir` used to be a default PARAMETER — `dir: string = app.getPath(...)` —
    // and a default parameter expression is evaluated at the CALL SITE, outside
    // the function body's try. portable.ts's bare `ensureUserDataDir()` at
    // module scope was therefore the one step of the whole function that was not
    // wrapped, in the FIRST-IMPORTED module of the app. A getPath that threw
    // there was a module-evaluation failure: no window, and nothing in the
    // console to say why — precisely the outcome the function's own docstring
    // says must never happen.
    //
    // Importing the module IS the test: if the call at its scope throws, this
    // import rejects.
    vi.resetModules()
    vi.doMock('electron', () => ({
      app: {
        getPath: (): string => {
          throw new Error('userData is not resolvable')
        },
        setPath: (): void => undefined
      }
    }))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const mod = await import('../src/main/portable')
      // And the exported function is safe for any other caller that omits the
      // argument, which is the half that made the call site safe.
      expect(() => mod.ensureUserDataDir()).not.toThrow()
      // Proof that the throwing mock is the one that was used, rather than the
      // ordinary temp-directory one from tests/mocks/electron.ts — without this
      // the test passes whether or not the bug is present.
      expect(
        errors.mock.calls.some(
          (c) => String(c[0]).includes('[portable]') && String(c[1]).includes('not resolvable')
        )
      ).toBe(true)
    } finally {
      errors.mockRestore()
      vi.doUnmock('electron')
      vi.resetModules()
    }
  })
})

describe('when it cannot be secured', () => {
  // Every one of these must be non-fatal. This runs at portable.ts's module
  // scope, so a throw here is a window that never opens — strictly worse than
  // a loose directory mode.
  it.skipIf(process.platform === 'win32')('survives an fchmod that fails', () => {
    const dir = join(scratch(), 'OpsMaxx-data')
    state.chmodThrows = true
    state.chmodCalls = 0
    try {
      expect(() => ensureUserDataDir(dir)).not.toThrow()
    } finally {
      state.chmodThrows = false
    }
    // The mock is the fix's own call, so "nothing threw" alone would also hold
    // for an implementation that never calls it -- a path-based chmodSync, say,
    // which is the arrangement this file's header warns about. So assert the
    // throwing mock was actually reached: without this the case proves nothing.
    expect(state.chmodCalls).toBeGreaterThan(0)
    // The directory still got made; only the mode was lost.
    expect(statSync(dir).isDirectory()).toBe(true)
  })

  it('survives a mkdir that fails', () => {
    // A file where the directory should be: stands in for the read-only
    // install directory and the unwritable stick, which a test cannot make.
    const path = join(scratch(), 'OpsMaxx-data')
    writeFileSync(path, 'not a directory')
    expect(() => ensureUserDataDir(path)).not.toThrow()
  })
})
