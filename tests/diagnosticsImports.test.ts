import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

// ===========================================================================
// WHAT THE DIAGNOSTICS PAYLOAD MAY NOT BE ABLE TO READ
// ===========================================================================
//
// "Copy diagnostics" produces a text block a user pastes into a public issue.
// Its entire safety argument is that there is nothing in it worth redacting:
// versions, inventory COUNTS and feature state as booleans, with no names, no
// addresses, no paths and no remote output. Nobody has to trust that promise
// about the fields that are there today — tests/diagnostics.test.ts checks those
// against a fake estate. This is about the fields that get added next.
//
// The realistic breach is not malice. It is the obvious next request: "put the
// credential shape in there too", or "say whether the vault is unlocked", or
// "include the last backup time". Each of those is one import away from a module
// that holds the real thing — secrets.ts's `exportSecrets()` returns every stored
// credential in PLAINTEXT — and from there the distance to a field that prints
// one is a single line in a template string. So the modules that hold the actual
// values are kept out of the payload's import closure entirely: a field that
// cannot be read cannot be formatted by accident.
//
// The closure is walked with ts.preProcessFile, not a regex over `from` clauses,
// because `await import('./x')` and re-export chains are exactly how this would
// arrive. Same mechanism as tests/jobsNotExposed.test.ts and
// tests/localTerminalNotExposed.test.ts; deliberately copied rather than shared,
// since a common helper would let one edit weaken three guards at once.

const ROOT = resolve(__dirname, '..')

/** The two halves of the feature: the pure formatter the renderer also sees, and
 *  main's collector. */
const SEED_FILES = [
  join(ROOT, 'src/shared/diagnostics.ts'),
  join(ROOT, 'src/main/services/diagnostics.ts')
]

/**
 * Module basenames the payload may not reach, and what each one holds.
 *
 * Matched on the specifier's basename, case-insensitively, so './secrets',
 * '../services/secrets.js' and './secrets/index' all hit.
 */
const FORBIDDEN: { name: string; file: string; why: string }[] = [
  {
    name: 'secrets',
    file: 'src/main/services/secrets.ts',
    why: 'exportSecrets() returns every stored credential in plaintext'
  },
  { name: 'vault', file: 'src/main/services/vault.ts', why: 'the encrypted store itself' },
  {
    name: 'credentialResolver',
    file: 'src/main/services/credentialResolver.ts',
    why: 'resolves a server to the credential it connects with'
  },
  {
    name: 'backup',
    file: 'src/main/services/backup.ts',
    why: 'reads and writes the whole encrypted archive'
  },
  {
    name: 'biometrics',
    file: 'src/main/services/biometrics.ts',
    why: 'holds the key that unlocks the vault without a password'
  },
  {
    name: 'history',
    file: 'src/main/services/history.ts',
    why: 'every command, output and job this app has recorded'
  },
  { name: 'sftp', file: 'src/main/services/sftp.ts', why: 'file contents off remote hosts' },
  {
    name: 'dbOps',
    file: 'src/main/services/dbOps.ts',
    why: 'query results out of somebody else\u2019s database'
  }
]

const FORBIDDEN_MODULE = new RegExp(`^(${FORBIDDEN.map((f) => f.name).join('|')})$`, 'i')

function isForbiddenSpecifier(spec: string): boolean {
  const base = spec.replace(/\.[cm]?[jt]sx?$/i, '').split(/[/\\]/).pop() ?? ''
  return FORBIDDEN_MODULE.test(base)
}

function isLocalSpecifier(spec: string): boolean {
  return spec.startsWith('.')
}

function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const literal = join(dirname(fromFile), spec)
  const stripped = literal.replace(/\.[cm]?js$/i, '')
  for (const candidate of [
    literal,
    `${literal}.ts`,
    `${literal}.tsx`,
    `${stripped}.ts`,
    `${stripped}.tsx`,
    join(literal, 'index.ts'),
    join(literal, 'index.tsx'),
    join(stripped, 'index.ts')
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

interface ImportEdge {
  from: string
  spec: string
  to: string | null
}

function importClosure(seeds: string[]): { files: Set<string>; edges: ImportEdge[] } {
  const files = new Set<string>()
  const edges: ImportEdge[] = []
  const queue = [...seeds]

  while (queue.length > 0) {
    const file = queue.pop() as string
    if (files.has(file)) continue
    files.add(file)
    if (!/\.tsx?$/.test(file) || !existsSync(file)) continue
    const source = readFileSync(file, 'utf8')
    // (text, readImportFiles, detectJavaScriptImports): the second and third
    // arguments are what pick up `require()` and `await import()`.
    for (const ref of ts.preProcessFile(source, true, true).importedFiles) {
      const to = resolveSpecifier(file, ref.fileName)
      edges.push({ from: file, spec: ref.fileName, to })
      if (to !== null && !files.has(to)) queue.push(to)
    }
  }
  return { files, edges }
}

/** The guard on the guard: modules the collector definitely reaches. If the
 *  walker breaks, the closure collapses to nothing and every assertion below
 *  passes for the wrong reason. */
const MUST_BE_IN_CLOSURE = [
  'src/shared/diagnostics.ts',
  'src/main/services/diagnostics.ts',
  'src/main/portable.ts',
  'src/main/services/mcpDataCache.ts',
  'src/main/services/mcpAuth.ts',
  'src/main/services/store.ts',
  'src/main/services/updatePrefs.ts',
  'src/main/services/localGate.ts',
  'src/main/services/accessWriteGate.ts',
  // The secure-store projection. Listed here for the reason the whole list
  // exists, and with one more: this is the module that was split OUT of
  // secrets.ts so the payload could report `secretStore.available` without
  // importing the file whose `exportSecrets()` returns plaintext. If the
  // collector ever stops reaching it, either the field is gone or it is being
  // read from somewhere else, and the second of those is the bad one.
  'src/main/services/secretsBackend.ts',
  'src/shared/modules.ts'
]

describe('the diagnostics payload cannot reach what it must not print', () => {
  const { files, edges } = importClosure(SEED_FILES)
  const relFiles = new Set([...files].map((f) => relative(ROOT, f).split('\\').join('/')))

  it('walked a real closure, not an empty one', () => {
    const missing = MUST_BE_IN_CLOSURE.filter((f) => !relFiles.has(f))
    expect(
      missing,
      `The import walker did not reach modules the collector definitely imports. The closure is ` +
        `broken, so the assertions below are meaningless.\n  ${missing.join('\n  ')}`
    ).toEqual([])
  })

  it('names modules that still exist', () => {
    // A forbidden module that has been renamed is a hole: the alternation keeps
    // matching a basename nothing uses any more, and the real module is free to
    // be imported. Cheaper to notice here than in a review.
    const gone = FORBIDDEN.filter((f) => !existsSync(join(ROOT, f.file))).map((f) => f.file)
    expect(
      gone,
      `These modules no longer exist at the paths this guard names: ${gone.join(', ')}. Rename the ` +
        `entry rather than deleting it — the basename is what the match is on.`
    ).toEqual([])
  })

  it('followed every local import it found', () => {
    // A specifier the walker cannot resolve is neither an offender nor walked,
    // so it would silently void both assertions below.
    const unresolved = edges
      .filter((e) => e.to === null && isLocalSpecifier(e.spec))
      .map((e) => `${relative(ROOT, e.from)} -> '${e.spec}'`)
    expect(
      unresolved,
      `The import walker could not follow these. Teach resolveSpecifier about them.\n  ` +
        `${unresolved.join('\n  ')}`
    ).toEqual([])
  })

  it('imports none of the modules that hold the real values', () => {
    const offenders = edges
      .filter((e) => isForbiddenSpecifier(e.spec))
      .map((e) => `${relative(ROOT, e.from)} imports '${e.spec}'`)

    expect(
      offenders,
      `A module the diagnostics payload is assembled from now reaches one of these:\n\n` +
        `${offenders.join('\n')}\n\n` +
        FORBIDDEN.map((f) => `  ${f.name} — ${f.why}`).join('\n') +
        `\n\nThe payload is text a user pastes into a public issue, and its safety argument is ` +
        `that there is nothing in it to redact. A field that needs one of these modules is a ` +
        `field that does not belong in it: pass a BOOLEAN in from the caller, the way the webhook ` +
        `projection and the AI bridge's running flag already are.`
    ).toEqual([])
  })

  it('has none of them anywhere in the closure', () => {
    // Belt and braces: catches a reach that arrived through a re-export chain
    // whose specifier text never says the module's own name.
    const offenders = [...relFiles].filter((f) =>
      FORBIDDEN_MODULE.test(f.split('/').pop()?.replace(/\.tsx?$/i, '') ?? '')
    )
    expect(offenders, `forbidden modules in the closure: ${offenders.join(', ')}`).toEqual([])
  })

  it('matches the specifier forms a real import would take', () => {
    for (const spec of [
      './secrets',
      '../services/secrets.js',
      './vault',
      '../../main/services/credentialResolver',
      './dbOps.ts',
      './history',
      './sftp',
      './biometrics',
      './backup'
    ]) {
      expect(isForbiddenSpecifier(spec), spec).toBe(true)
    }
    // The other direction, and the list below is two kinds of entry rather than
    // one. Both are pinned as NOT forbidden; what each proves is different.
    //
    //  * Real modules whose basename merely CONTAINS a forbidden name and which
    //    the collector does not import at all: `./vaultPrompt`
    //    (src/renderer/src/store/vaultPrompt.ts, a renderer store holding no
    //    secret) and `./backupTargets` (which holds destinations, not archives).
    //    These pin the `^(...)$` anchoring in FORBIDDEN_MODULE — drop the anchors
    //    and the guard starts refusing modules it has no argument against, which
    //    is how a real field gets deleted to make a test pass.
    //  * Modules the collector genuinely DOES import, which must stay allowed:
    //    `./secretsBackend`, `./secretRedaction`, `./mcpDataCache`,
    //    `./updatePrefs`, `../portable`, `node:os` and `electron`. Cross-check
    //    them against MUST_BE_IN_CLOSURE above, which asserts the other half —
    //    that they are reached.
    //
    // './secretsBackend' is the one in the second group worth naming out loud. It
    // is the projection secrets.ts's `secretsAvailable()` was moved into, and the
    // collector imports it directly: it holds the safeStorage predicates and
    // the Linux password-store name, and reaches `electron` and nothing else —
    // no secrets file path, no ciphertext map, no decryptString. Allowed on
    // purpose, and the pin is here so a future widening of the alternation to
    // `secrets.*` is a deliberate act rather than an accident that quietly
    // deletes a field.
    for (const spec of [
      './secretsBackend',
      '../services/secretsBackend.js',
      './secretRedaction',
      './vaultPrompt',
      './backupTargets',
      './mcpDataCache',
      './updatePrefs',
      '../portable',
      'node:os',
      'electron'
    ]) {
      expect(isForbiddenSpecifier(spec), spec).toBe(false)
    }
  })
})
