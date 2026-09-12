import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

// secretsBackend.ts is the projection that lets the diagnostics payload say
// whether this machine can store a credential, without importing the module
// that holds the credentials. tests/diagnosticsImports.test.ts proves the
// payload cannot reach secrets.ts; these prove the projection it reaches
// instead is worth reaching, and that it stays a projection.

const FILE = join(__dirname, '../src/main/services/secretsBackend.ts')

let available = true
let backend: string | (() => never) = 'gnome_libsecret'

// The shared mock in tests/mocks/electron.ts has a fixed `isEncryptionAvailable`
// and no `getSelectedStorageBackend` at all, and both of those are the variables
// here — so this file supplies its own. `app` is in it because secrets.ts, which
// one test below imports to prove there is a single implementation, resolves its
// file path at module scope.
vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join: j } = await import('node:path')
  const dir = mkdtempSync(j(tmpdir(), 'opsmaxx-secbackend-'))
  return {
    app: { getPath: (): string => dir },
    safeStorage: {
      isEncryptionAvailable: (): boolean => available,
      getSelectedStorageBackend: (): string =>
        typeof backend === 'function' ? backend() : backend,
      encryptString: (s: string): Buffer => Buffer.from(s, 'utf8'),
      decryptString: (b: Buffer): string => b.toString('utf8')
    }
  }
})

/** process.platform is read-only on the real object, so it is redefined and put
 *  back. The Linux branch is the only interesting one and CI does not run every
 *  platform. */
function asPlatform<T>(platform: string, fn: () => T): T {
  const original = process.platform
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true })
  }
}

afterEach(() => {
  available = true
  backend = 'gnome_libsecret'
})

describe('secretsAvailable', () => {
  it('reports what safeStorage says, in both directions', async () => {
    const { secretsAvailable } = await import('../src/main/services/secretsBackend')
    expect(secretsAvailable()).toBe(true)
    available = false
    expect(secretsAvailable()).toBe(false)
  })

  it('is the same function secrets.ts refuses to persist on', async () => {
    // The point of the extraction: ONE implementation. If secrets.ts ever grows
    // its own copy of the predicate, the two can disagree and the diagnostics
    // field starts describing something other than the behaviour it is supposed
    // to explain.
    const secrets = await import('../src/main/services/secrets')
    const projection = await import('../src/main/services/secretsBackend')
    expect(secrets.secretsAvailable).toBe(projection.secretsAvailable)

    available = false
    expect(projection.secretsAvailable()).toBe(false)
    // And the behaviour that makes the field worth printing: no keychain means
    // the credential is not written at all, rather than written in the clear.
    expect(secrets.setSecret('diag-probe', 'hunter2')).toBe(false)
    expect(secrets.getSecret('diag-probe')).toBeNull()
  })
})

describe('secretsBackend', () => {
  it('names the Linux password store', async () => {
    const { secretsBackend } = await import('../src/main/services/secretsBackend')
    expect(asPlatform('linux', secretsBackend)).toBe('gnome_libsecret')
    backend = 'basic_text'
    expect(asPlatform('linux', secretsBackend)).toBe('basic_text')
  })

  it('is null where the question has no answer', async () => {
    const { secretsBackend } = await import('../src/main/services/secretsBackend')
    // Electron defines getSelectedStorageBackend on Linux only. Calling it
    // elsewhere must not be attempted at all.
    backend = (): never => {
      throw new Error('getSelectedStorageBackend is not a function')
    }
    expect(asPlatform('darwin', secretsBackend)).toBeNull()
    expect(asPlatform('win32', secretsBackend)).toBeNull()
  })

  it('costs a field rather than throwing when Electron cannot answer', async () => {
    const { secretsBackend } = await import('../src/main/services/secretsBackend')
    backend = (): never => {
      throw new TypeError('not a function')
    }
    // Diagnostics are what someone reaches for when the app is already
    // misbehaving; an older Electron must not turn the whole payload into an
    // exception.
    expect(asPlatform('linux', secretsBackend)).toBeNull()
  })
})

describe('the projection stays a projection', () => {
  // This module imports `electron` directly, which is how it sidesteps the
  // import guard legitimately — and also the one hole that creates. Nothing in
  // the closure walk would notice `decryptString` appearing in here, so the
  // check is on the source.
  const source = readFileSync(FILE, 'utf8')
  /** Comments stripped, because the file's own note names the calls it refuses
   *  to make and a prose mention is not a call. The module uses only `//`
   *  comments and `*` doc lines. */
  const code = source
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')

  it('has no way to read or write a secret', () => {
    for (const forbidden of ['decryptString', 'encryptString', 'readFileSync', 'writeFileSync']) {
      expect(code.includes(forbidden), forbidden).toBe(false)
    }
  })

  it('imports nothing but electron', () => {
    // ts.preProcessFile, not a regex over `from '…'`. The regex saw one shape of
    // import and the assertion's whole job is that there are no others: a
    // double-quoted specifier, a bare side-effect `import './x'` and an
    // `await import()` all passed it unseen, and a new import arriving in one of
    // those shapes is the only way this check ever gets a chance to fire.
    // Same mechanism, for the same reason, as tests/diagnosticsImports.test.ts.
    const specifiers = ts.preProcessFile(source, true, true).importedFiles.map((f) => f.fileName)
    expect(specifiers).toEqual(['electron'])
  })
})
