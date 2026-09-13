import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Reading a private key's material, without turning main into a file server.
 *
 * The feature: a key belongs in the vault as MATERIAL, not as a `keyPath`
 * pointing at plaintext on disk — the one credential this app never actually
 * held, and the one thing an encrypted backup could not carry elsewhere.
 *
 * The risk it introduces: a renderer-supplied path handed to `readFileSync` is
 * a way to ask main to read anything the user can. These are the limits that
 * stop it being one.
 */

let home: string
vi.mock('node:os', async (orig) => {
  const real = await orig<typeof import('node:os')>()
  return { ...real, homedir: () => home }
})

const PEM = `-----BEGIN OPENSSH PRIVATE KEY-----\n${'b3BlbnNzaC1rZXk'.repeat(4)}\n-----END OPENSSH PRIVATE KEY-----\n`

let mod: typeof import('../src/main/services/sshKeys')

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'opsmaxx-keys-'))
  mkdirSync(join(home, '.ssh'))
  writeFileSync(join(home, '.ssh', 'id_ed25519'), PEM)
  writeFileSync(join(home, '.ssh', 'id_ed25519.pub'), 'ssh-ed25519 AAAA user@host\n')
  writeFileSync(join(home, '.ssh', 'config'), 'Host x\n  HostName y\n')
  writeFileSync(join(home, 'secrets.txt'), 'not a key, but readable by this user')
  vi.resetModules()
  mod = await import('../src/main/services/sshKeys')
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('reading a key by name, out of ~/.ssh', () => {
  it('returns the PEM for a key the scan already lists', () => {
    expect(mod.keyMaterialFor('id_ed25519')).toBe(PEM)
  })

  it('refuses a name that walks out of the directory', () => {
    // The set of readable files is the set `listDefaultKeys()` offers, and a
    // name carrying a separator matches nothing in it — so traversal is not a
    // thing this has to parse its way out of.
    expect(mod.keyMaterialFor('../secrets.txt')).toBeNull()
    expect(mod.keyMaterialFor('../../etc/passwd')).toBeNull()
    expect(mod.keyMaterialFor('/etc/passwd')).toBeNull()
  })

  it('refuses a file in ~/.ssh that is not a private key', () => {
    // `config` and `.pub` files live in the same directory and are not secrets
    // to hand out. They are not in the listing either, which is the same rule
    // stated once.
    expect(mod.keyMaterialFor('config')).toBeNull()
    expect(mod.keyMaterialFor('id_ed25519.pub')).toBeNull()
  })

  it('refuses a name that is not there at all', () => {
    expect(mod.keyMaterialFor('id_nonexistent')).toBeNull()
  })
})

describe('reading a key by path, as the native dialog hands one back', () => {
  it('returns the PEM for a real private key', () => {
    expect(mod.readKeyMaterialAt(join(home, '.ssh', 'id_ed25519'))).toBe(PEM)
  })

  it('refuses a file that does not look like a private key', () => {
    // The header check is what stops this being a general-purpose read even on
    // a path the user really did choose in the file dialog.
    expect(mod.readKeyMaterialAt(join(home, 'secrets.txt'))).toBeNull()
  })

  it('refuses a directory', () => {
    expect(mod.readKeyMaterialAt(join(home, '.ssh'))).toBeNull()
  })

  it('refuses a missing file without throwing', () => {
    expect(mod.readKeyMaterialAt(join(home, 'nope'))).toBeNull()
  })

  it('refuses a file too large to be a key', () => {
    // A ceiling, so a file that happens to start with the right line cannot be
    // used to pull something large into memory. Real keys are kilobytes.
    const big = join(home, '.ssh', 'huge')
    writeFileSync(big, `${PEM}${'x'.repeat(70 * 1024)}`)
    expect(mod.readKeyMaterialAt(big)).toBeNull()
  })

  it('follows a symlink only to something that is still a key', () => {
    // A link in ~/.ssh pointing at an ordinary file is the traversal that
    // survives a name check, so the header check has to be what refuses it.
    const link = join(home, '.ssh', 'linked')
    symlinkSync(join(home, 'secrets.txt'), link)
    expect(mod.readKeyMaterialAt(link)).toBeNull()
    expect(mod.keyMaterialFor('linked')).toBeNull()
  })
})

describe('who can ask for a key body', () => {
  /**
   * A human-UI surface only, and stated as an assertion rather than a habit.
   *
   * This reads a private key off disk and returns it. The renderer is allowed
   * to have it — vault entries already reach the renderer in plaintext, so a
   * key body is not a new class of exposure there. An AI agent is not: the
   * whole point of putting a key in the vault is that the bridge hands out
   * references and main does the resolving, and a tool that returns PEM would
   * undo that in one call.
   *
   * The reach is limited by construction — both functions are called from
   * `main/index.ts` and wired to `ipcMain` handlers, which an agent has no way
   * to invoke — so this pins the construction rather than adding a gate.
   */
  const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8')

  it('is called from main/index.ts and nowhere else', () => {
    const callers = ['src/main/services/mcpServer.ts', 'src/cli/index.ts']
    for (const f of callers) {
      const src = read(f)
      expect(src, `${f} reaches the key-material readers`).not.toMatch(
        /readKeyMaterialAt|keyMaterialFor/
      )
    }
  })

  it('is not named as an MCP tool or a CLI command', () => {
    for (const f of ['src/main/services/mcpServer.ts', 'src/cli/index.ts']) {
      const src = read(f)
      expect(src, `${f} exposes the key-material channel`).not.toContain('ssh:keyMaterial')
      expect(src, `${f} exposes the key picker`).not.toContain('dialog:openKeyMaterial')
    }
  })
})
