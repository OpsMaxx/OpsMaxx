import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Windows OpenVPN: finding the program, and finding the profiles.
 *
 * Reported from Windows: "it doesn't detect openvpn binary path automatically
 * even if OpenVPN Connect was installed, and doesn't automatically import
 * openvpn connection profiles." The screenshot showed the official client
 * sitting in `Program Files\OpenVPN Connect`.
 *
 * Three separate reasons it could not have worked:
 *
 *  1. The Windows candidate list was two hard-coded strings,
 *     `C:\Program Files\OpenVPN\bin\openvpn.exe` and its x86 twin. That is
 *     the Community edition's layout on an English install on drive C:. It is
 *     not OpenVPN Connect's, it is not a localised Windows', and it is not a
 *     machine whose system drive is not C:.
 *  2. `HKLM\SOFTWARE\OpenVPN` — the key the installer writes and the official
 *     GUI reads — was never consulted, so the one authoritative answer was
 *     the one answer not asked for.
 *  3. Nothing looked for existing `.ovpn` files at all. Import was paste-only.
 *
 * Nothing here runs `reg` or `openvpn`. The seams are child_process and the
 * environment; every path assertion is against a file this test really made,
 * and the registry fixture is the literal shape `reg query` prints.
 */

const hoisted = vi.hoisted(() => ({
  /** Every command, in order, as [cmd, ...args]. */
  calls: [] as string[][],
  /** `HKLM\...\OpenVPN` -> value name -> value. `''` is the default value. */
  registry: new Map<string, Map<string, string>>()
}))

vi.mock('node:child_process', () => {
  const execFile = (
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout?: string, stderr?: string) => void
  ): void => {
    hoisted.calls.push([cmd, ...args])
    if (cmd !== 'reg' || args[0] !== 'query') {
      // Everything else here is the resolver's `--version` probe, which is
      // decoration: answer it and move on.
      return cb(null, 'OpenVPN 2.6.12 fixture\n', '')
    }
    const values = hoisted.registry.get(args[1])
    const name = args.includes('/ve') ? '' : (args[args.indexOf('/v') + 1] ?? '')
    const value = values?.get(name)
    if (value === undefined) {
      return cb(
        Object.assign(new Error('reg failed'), { code: 1 }),
        'ERROR: The system was unable to find the specified registry key or value.'
      )
    }
    // The real layout: a blank line, the key, then one indented
    // "<name>    REG_SZ    <value>" line, then a blank line.
    return cb(null, `\n${args[1]}\n    ${name || '(Default)'}    REG_SZ    ${value}\n\n`, '')
  }
  return { execFile, default: { execFile } }
})

// Never written to by anything here — the vault is not touched — but
// `credentialResolver` reaches `app.getPath` at import time.
const electronUserData = vi.hoisted(() => {
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  const { join: j } = require('node:path') as typeof import('node:path')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  return mk(j(tmpdir(), 'opsmaxx-vpnwin-'))
})
vi.mock('electron', () => ({ app: { getPath: () => electronUserData } }))

import { resetBinaryCache, resolveSystem } from '../src/main/services/vpn/binaries'
import { discoverVpnProfiles, resetDiscoveryCache } from '../src/main/services/vpn/import'
import { isVpnError } from '../src/main/services/vpn/errors'

/** Beside the repo rather than under os.tmpdir(): /tmp is world-writable and
 *  the resolver rightly refuses a binary with a world-writable ancestor, so a
 *  fixture there would exercise the rejection path instead. The same reason
 *  tests/vpnBinaries.test.ts gives. */
const SANDBOX = resolve(__dirname, '..', '.tmp-tests')
/** The real `.ovpn` this repo already keeps for parser tests. Copied rather
 *  than retyped, so what discovery parses is a file the OpenVPN parser tests
 *  agree is a valid profile. */
const OK_OVPN = resolve(__dirname, 'fixtures', 'ovpn', 'ok-minimal.ovpn')

let root: string
let programFiles: string
const saved = new Map<string, string | undefined>()
let platformDescriptor: PropertyDescriptor | undefined

function setEnv(name: string, value: string | undefined): void {
  if (!saved.has(name)) saved.set(name, process.env[name])
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function stubPlatform(value: NodeJS.Platform): void {
  platformDescriptor ??= Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

/** An `openvpn.exe` at `parts`, with the directories above it. */
function putExe(...parts: string[]): string {
  const file = join(root, ...parts)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, 'MZ fixture')
  return file
}

function putRegistry(key: string, values: Record<string, string>): void {
  hoisted.registry.set(key, new Map(Object.entries(values)))
}

beforeEach(() => {
  mkdirSync(SANDBOX, { recursive: true })
  root = mkdtempSync(join(SANDBOX, 'sp-win-'))
  // Deliberately NOT "Program Files": a German install spells it "Programme",
  // and the old list could only ever have found the English one.
  programFiles = join(root, 'Programme')
  mkdirSync(programFiles, { recursive: true })

  hoisted.calls.length = 0
  hoisted.registry.clear()
  // Discovery caches a completed scan for 30s. Every case here swaps the whole
  // fixture tree underneath it, so without this the second case is answered
  // from the first case's filesystem.
  resetDiscoveryCache()
  setEnv('ProgramFiles', programFiles)
  setEnv('ProgramW6432', undefined)
  setEnv('ProgramFiles(x86)', undefined)
  setEnv('SystemRoot', join(root, 'Windows'))
  setEnv('PATH', '')
  stubPlatform('win32')
  resetBinaryCache()
})

afterEach(() => {
  if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
  platformDescriptor = undefined
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  saved.clear()
  resetBinaryCache()
  rmSync(root, { recursive: true, force: true })
})

describe('finding openvpn.exe on Windows', () => {
  it('reads %ProgramFiles% rather than assuming it says "Program Files"', async () => {
    const exe = putExe('Programme', 'OpenVPN', 'bin', 'openvpn.exe')

    const info = await resolveSystem('openvpn', {})

    expect(info.available).toBe(true)
    expect(info.bundled).toBe(false)
    expect(info.path).toBe(realpathSync(exe))
  })

  it('finds the core binary OpenVPN Connect ships, wherever in its tree it is', async () => {
    // The reported case: the official GUI client in Program Files, and no
    // Community install anywhere. Which subdirectory holds the core binary
    // has moved between versions, so the resolver scans one level down rather
    // than naming a version's layout.
    const exe = putExe('Programme', 'OpenVPN Connect', 'core', 'openvpn.exe')

    const info = await resolveSystem('openvpn', {})

    expect(info.path).toBe(realpathSync(exe))
  })

  it('does not offer ovpnconnect.exe as the engine', async () => {
    // OpenVPN Connect's own CLI takes a completely different command line.
    // Returning it would turn "not found" into a launch that fails in a
    // stranger way, which is worse.
    putExe('Programme', 'OpenVPN Connect', 'ovpnconnect.exe')

    const err = await resolveSystem('openvpn', {}).catch((e) => e)

    expect(isVpnError(err) && err.code).toBe('binary-missing')
  })

  it('refuses a hand-typed path to OpenVPN Connect, and says why', async () => {
    // The test above stops it being OFFERED. This stops it being ACCEPTED,
    // which is the path a user takes precisely when detection found nothing
    // and they went looking for something that sounded right.
    //
    // Nothing checked the name before. The GUI passed every test — absolute,
    // exists, inside Program Files, a non-empty file — and on Windows the
    // POSIX checks are skipped, so the profile saved, the engine reported
    // AVAILABLE, and Start gave a UAC prompt, a GUI window and then
    // `handshake-timeout` sixty seconds later, naming nothing that happened.
    const gui = putExe('Programme', 'OpenVPN Connect', 'OpenVPNConnect.exe')

    const err = await resolveSystem('openvpn', { binaryPath: gui, confirmed: true }).catch((e) => e)

    // `config-invalid`, not `binary-missing`: the binary is right there. What
    // is wrong is the choice, and telling someone to install what they have
    // already installed is how this started.
    expect(isVpnError(err) && err.code).toBe('config-invalid')
    // It has to name the alternative: "this is wrong" without "this is right"
    // leaves them where they started.
    expect(String(err.detail ?? err.message)).toMatch(/openvpn\.exe/)
    expect(String(err.detail ?? err.message)).toMatch(/OpenVPN Connect/)
  })

  it('refuses the Connect CLI by name as well, not only by where it was found', async () => {
    const cli = putExe('Programme', 'OpenVPN', 'bin', 'ovpnconnect.exe')

    const err = await resolveSystem('openvpn', { binaryPath: cli, confirmed: true }).catch((e) => e)

    expect(isVpnError(err) && err.code).toBe('config-invalid')
  })

  it('asks the registry, and accepts what it says even off Program Files', async () => {
    // An install on another drive is invisible to any list of guesses, and
    // HKLM is administrator-only — so a path from it is better evidence than
    // a path we assumed.
    const exe = putExe('D-drive', 'OpenVPN', 'bin', 'openvpn.exe')
    putRegistry('HKLM\\SOFTWARE\\OpenVPN', { exe_path: exe })

    const info = await resolveSystem('openvpn', {})

    expect(info.path).toBe(realpathSync(exe))
    // The command string itself, as it was issued.
    const queries = hoisted.calls.filter((c) => c[0] === 'reg')
    expect(queries).toContainEqual(['reg', 'query', 'HKLM\\SOFTWARE\\OpenVPN', '/v', 'exe_path'])
    // A 32-bit installer on 64-bit Windows writes under WOW6432Node instead,
    // so not asking there is half an answer.
    expect(queries.some((c) => c[2] === 'HKLM\\SOFTWARE\\WOW6432Node\\OpenVPN')).toBe(true)
  })

  it('derives bin\\openvpn.exe from the key\'s default install directory', async () => {
    // Older installers record the directory and no exe_path.
    const exe = putExe('D-drive', 'OpenVPN', 'bin', 'openvpn.exe')
    putRegistry('HKLM\\SOFTWARE\\WOW6432Node\\OpenVPN', { '': join(root, 'D-drive', 'OpenVPN') })

    const info = await resolveSystem('openvpn', {})

    expect(info.path).toBe(realpathSync(exe))
  })

  it('prefers what the registry says over a guess that also exists', async () => {
    const guess = putExe('Programme', 'OpenVPN', 'bin', 'openvpn.exe')
    const real = putExe('D-drive', 'OpenVPN', 'bin', 'openvpn.exe')
    putRegistry('HKLM\\SOFTWARE\\OpenVPN', { exe_path: real })

    const info = await resolveSystem('openvpn', {})

    expect(info.path).toBe(realpathSync(real))
    expect(info.path).not.toBe(realpathSync(guess))
  })

  it('still refuses a candidate that resolves out of its install tree', async () => {
    // The check the wider search must not cost us (E45): the name is in
    // Program Files, the bytes are not.
    const evil = putExe('evil', 'openvpn.exe')
    mkdirSync(join(programFiles, 'OpenVPN', 'bin'), { recursive: true })
    symlinkSync(evil, join(programFiles, 'OpenVPN', 'bin', 'openvpn.exe'))

    const err = await resolveSystem('openvpn', {}).catch((e) => e)

    expect(isVpnError(err) && err.code).toBe('binary-missing')
  })

  it('still does not search PATH on Windows', async () => {
    const dir = join(root, 'Users', 'someone', 'bin')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'openvpn.exe'), 'MZ planted')
    setEnv('PATH', dir)

    const err = await resolveSystem('openvpn', {}).catch((e) => e)

    expect(isVpnError(err) && err.code).toBe('binary-missing')
    expect(err.detail).toContain('does not search PATH on Windows')
  })

  it('names the places it actually looked', async () => {
    const err = await resolveSystem('openvpn', {}).catch((e) => e)
    expect(err.detail).toContain(join(programFiles, 'OpenVPN', 'bin', 'openvpn.exe'))
  })
})

describe('finding profiles that are already on the machine', () => {
  function setUpWindowsProfiles(): { home: string; appData: string } {
    const home = join(root, 'Users', 'someone')
    const appData = join(home, 'AppData', 'Roaming')
    setEnv('HOME', home)
    setEnv('USERPROFILE', home)
    setEnv('APPDATA', appData)
    setEnv('LOCALAPPDATA', join(home, 'AppData', 'Local'))
    return { home, appData }
  }

  function putProfile(dir: string, name: string): string {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, name)
    copyFileSync(OK_OVPN, file)
    return file
  }

  it('finds what OpenVPN Connect and the Community GUI already store', async () => {
    const { home, appData } = setUpWindowsProfiles()
    const connect = putProfile(join(appData, 'OpenVPN Connect', 'profiles'), 'work.ovpn')
    const gui = putProfile(join(home, 'OpenVPN', 'config'), 'home-lab.ovpn')

    const found = await discoverVpnProfiles()

    expect(found.map((p) => p.sourcePath).sort()).toEqual([connect, gui].sort())
    // Parsed, not merely listed: a file that cannot be imported is worth
    // saying so about, and one that can is worth offering.
    for (const p of found) {
      expect(p.kind).toBe('openvpn')
      expect(p.report.ok).toBe(true)
      expect(p.report.spec?.kind).toBe('openvpn')
    }
    expect(found.map((p) => p.name).sort()).toEqual(['home-lab', 'work'])
  })

  it('reads the registry\'s own config_dir', async () => {
    setUpWindowsProfiles()
    const dir = join(root, 'D-drive', 'OpenVPN', 'config')
    const file = putProfile(dir, 'relocated.ovpn')
    putRegistry('HKLM\\SOFTWARE\\OpenVPN', { config_dir: dir })

    const found = await discoverVpnProfiles()

    expect(found.map((p) => p.sourcePath)).toContain(file)
  })

  it('finds a profile filed in a subfolder', async () => {
    const { home } = setUpWindowsProfiles()
    const file = putProfile(join(home, 'OpenVPN', 'config', 'clients'), 'branch.ovpn')

    const found = await discoverVpnProfiles()

    expect(found.map((p) => p.sourcePath)).toContain(file)
  })

  it('offers nothing twice: the same scan, and a scan after an import', async () => {
    const { home, appData } = setUpWindowsProfiles()
    putProfile(join(appData, 'OpenVPN Connect', 'profiles'), 'work.ovpn')
    putProfile(join(home, 'OpenVPN', 'config'), 'home-lab.ovpn')

    const first = await discoverVpnProfiles()
    expect(first).toHaveLength(2)

    // The file stays on disk after an import, so it is found again every
    // time. Keyed on its path, the second scan has nothing new to say.
    const again = await discoverVpnProfiles({
      knownSourcePaths: first.map((p) => p.sourcePath)
    })
    expect(again).toEqual([])
  })

  it('does not offer the same file twice when two roots name one directory', async () => {
    const { home } = setUpWindowsProfiles()
    const dir = join(home, 'OpenVPN', 'config')
    putProfile(dir, 'work.ovpn')
    // The registry's config_dir is usually one of the directories that would
    // have been guessed anyway.
    putRegistry('HKLM\\SOFTWARE\\OpenVPN', { config_dir: dir })

    const found = await discoverVpnProfiles()

    expect(found).toHaveLength(1)
  })

  it('skips a file too large to be a profile, and survives a directory that is not there', async () => {
    const { home } = setUpWindowsProfiles()
    const dir = join(home, 'OpenVPN', 'config')
    const ok = putProfile(dir, 'small.ovpn')
    const big = join(dir, 'huge.ovpn')
    writeFileSync(big, 'x')
    truncateSync(big, 4 << 20)

    const found = await discoverVpnProfiles()

    expect(found.map((p) => p.sourcePath)).toEqual([ok])
  })

  it('returns nothing, rather than throwing, on a machine with no OpenVPN', async () => {
    setUpWindowsProfiles()
    await expect(discoverVpnProfiles()).resolves.toEqual([])
  })
})
