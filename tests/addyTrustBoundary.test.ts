import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SYNCED_COLLECTIONS, NOT_SYNCED } from '../src/shared/addy'
import { T2_ALLOWLIST, T2_NAMES, CAPABILITY_GATING_KEYS, validateT2 } from '../src/shared/addyProfile'
import { TERMINAL_SCHEMES } from '../src/shared/terminalTheme'
import { ALL_DATA_FILES, ALL_DATA_DIRS } from '../src/main/services/backup'

/**
 * The trust boundary between what addy stores as ciphertext and what it stores
 * in the clear.
 *
 * DEFAULT-DENY, ENFORCED BY CI. A new key is T0 unless it is explicitly added
 * to the T2 allowlist, and a new record type is either synced or recorded as
 * deliberately not synced WITH A REASON. This copies the mechanism that already
 * works twice in this repo -- `backfillModules`, where absence reads as OFF,
 * and `backup.test.ts` pinning `ALL_DATA_FILES` against a directory listing --
 * because default-deny enforced by CI is the only version of this that survives
 * contact with a year of feature work.
 *
 * THIS FILE PINS AGAINST FOUR KEY SETS, NOT ONE. A guardrail with a hole in it
 * is worse than none, because it is believed:
 *
 *   1. `AppSettings`      -- the cosmetic subset that may be public
 *   2. the `ModuleId` union -- capability switches, none of which may be
 *   3. `Persisted`        -- the record types that sync
 *   4. `ALL_DATA_FILES`   -- everything this app writes to disk
 *
 * The fourth was missing from the original specification of this test, and a
 * review found the consequence: `ALL_DATA_FILES` is much longer than
 * `Persisted`, so every file that is not a `Persisted` key fell outside the
 * guardrail entirely -- neither synced nor recorded as deliberately not synced.
 * That is the exact failure this file exists to prevent, applied to whole files
 * rather than record types.
 */

const root = join(__dirname, '..')

/** Read an interface's member names out of the real source file.
 *
 * TypeScript types are erased, so there is no runtime value to compare
 * against. Reading the source is what the Go sidecar's protocol test already
 * does in the other direction, and it has the same property: it checks the
 * thing that ships rather than a copy somebody remembered to update. */
function interfaceKeys(file: string, name: string): string[] {
  const src = readFileSync(join(root, file), 'utf8')
  const start = src.indexOf(`interface ${name} {`)
  expect(start, `${name} not found in ${file}`).toBeGreaterThan(-1)

  let depth = 0
  let i = src.indexOf('{', start)
  const body: string[] = []
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) break
    }
    body.push(src[i])
  }
  const text = body.join('')

  // Members at depth 1 only: `foo: Bar` or `foo?: Bar`, not the innards of a
  // nested object type.
  const keys: string[] = []
  let nest = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    const opens = (trimmed.match(/[{[]/g) ?? []).length
    const closes = (trimmed.match(/[}\]]/g) ?? []).length
    if (nest === 1) {
      const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\??\s*:/)
      if (m) keys.push(m[1])
    }
    nest += opens - closes
    if (nest < 0) nest = 0
  }
  return keys
}

function unionMembers(file: string, name: string): string[] {
  const src = readFileSync(join(root, file), 'utf8')
  const start = src.indexOf(`export type ${name} =`)
  expect(start, `${name} not found in ${file}`).toBeGreaterThan(-1)
  const rest = src.slice(start)
  const end = rest.indexOf('\n\n')
  const body = end > 0 ? rest.slice(0, end) : rest
  return [...body.matchAll(/'([A-Za-z0-9_-]+)'/g)].map((m) => m[1])
}

describe('the T2 allowlist', () => {
  it('holds only keys that exist somewhere real', () => {
    const settings = interfaceKeys('src/renderer/src/store/app.ts', 'AppSettings')
    expect(settings.length, 'the AppSettings parser is wrong, not the code').toBeGreaterThan(10)

    // `theme` is the exception and it is a real one: it lives on AppState
    // rather than in `settings`, which is why a test that only knew about
    // AppSettings would silently fail to cover it.
    const known = new Set([...settings, 'theme'])
    for (const name of T2_NAMES) {
      expect(known.has(name), `${name} is in the T2 allowlist but is not a real setting`).toBe(true)
    }
  })

  it('contains no capability-gating key', () => {
    // NO KEY WHOSE ABSENCE GRANTS SOMETHING MAY BE PUBLIC. AppSettings merges
    // saved-over-default, so several keys read absence as "on". Against that
    // polarity an OMISSION is an attack: a hostile server that simply leaves a
    // key out gets the permissive default.
    for (const key of CAPABILITY_GATING_KEYS) {
      expect(T2_NAMES, `${key} must never be in the T2 allowlist`).not.toContain(key)
    }
  })

  it('contains no module id', () => {
    // `modules` was on this list once and security review moved it to T0. It is
    // a capability switch, not a preference: a plaintext profile could
    // otherwise enable the whole privileged surface on every device, and
    // `backfillModules` exists precisely so that an upgrade is not consent.
    const moduleIds = unionMembers('src/shared/modules.ts', 'ModuleId')
    expect(moduleIds.length, 'the ModuleId parser is wrong, not the code').toBeGreaterThan(10)
    for (const id of moduleIds) {
      expect(T2_NAMES, `the module ${id} must not be public`).not.toContain(id)
    }
    expect(T2_NAMES).not.toContain('modules')
  })

  it('accepts its own valid values and refuses everything else', () => {
    for (const field of T2_ALLOWLIST) {
      const value = field.kind === 'bool' ? true : field.kind === 'int' ? field.min : field.values[0]
      expect(() => validateT2({ [field.name]: value })).not.toThrow()
    }
    expect(() => validateT2({ sshPrivateKey: 'x' })).toThrow(/not in the T2 allowlist/)
    expect(() => validateT2({ modules: { cicdTrigger: true } })).toThrow(/not in the T2 allowlist/)
    expect(() => validateT2({ terminalFontSize: 9999 })).toThrow(/allowed/)
    expect(() => validateT2({ theme: 'chartreuse' })).toThrow(/not one of/)
  })
})

describe('the collection list', () => {
  it('covers every Persisted key', () => {
    const persisted = interfaceKeys('src/renderer/src/store/persist.ts', 'Persisted')
    expect(persisted.length, 'the Persisted parser is wrong, not the code').toBeGreaterThan(10)

    for (const key of persisted) {
      const synced = (SYNCED_COLLECTIONS as readonly string[]).includes(key)
      const declined = key in NOT_SYNCED
      expect(
        synced || declined,
        `${key} is persisted but is in neither the synced list nor NOT_SYNCED. ` +
          'Without this, absence is indistinguishable from "I have not added one yet"',
      ).toBe(true)
    }
  })

  it('covers every file this app writes to disk', () => {
    // THE HOLE A REVIEW FOUND. Pinning only against `Persisted` leaves every
    // file that is not a `Persisted` key outside the guardrail entirely.
    // The constants are real entries that ALL_DATA_FILES carries by reference
    // rather than by literal, so they have to be added back or three files sit
    // outside the guardrail while it reports success.
    const named = [...[...ALL_DATA_FILES, ...ALL_DATA_DIRS].map(collectionNameFor), ...FILES_BY_CONSTANT]
    expect(
      named.length,
      'the on-disk enumeration is shorter than expected; the parser is wrong, not the code',
    ).toBeGreaterThan(20)

    for (const name of named) {
      const synced = (SYNCED_COLLECTIONS as readonly string[]).includes(name)
      const declined = name in NOT_SYNCED
      expect(
        synced || declined,
        `the on-disk file mapping to "${name}" is in neither list. ` +
          'Device-local may well be right -- but the decision has to be made and written down',
      ).toBe(true)
    }
  })

  it('records a real reason for everything it declines', () => {
    for (const [name, reason] of Object.entries(NOT_SYNCED)) {
      expect(reason.trim().length, `${name} is not synced for no stated reason`).toBeGreaterThan(20)
    }
  })

  it('puts nothing in both lists', () => {
    for (const name of Object.keys(NOT_SYNCED)) {
      expect(SYNCED_COLLECTIONS as readonly string[]).not.toContain(name)
    }
  })

  it('syncs deviceNames, so the recovery screen is not limited to birth names', () => {
    expect(SYNCED_COLLECTIONS as readonly string[]).toContain('deviceNames')
  })
})

/**
 * Map an on-disk file or directory to the collection name this contract uses.
 *
 * Most map by their own name. Two do not and the exceptions are worth stating:
 * `opsmaxx-data.json` is the CONTAINER for the synced record types rather than
 * a collection itself, and a handful carry a different word on disk from the
 * one the protocol uses.
 */
function collectionNameFor(file: string): string {
  const base = file
    .replace(/^opsmaxx-/, '')
    .replace(/\.(json|jsonl)$/, '')
    .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

  const aliases: Record<string, string> = {
    // The Persisted blob. Its CONTENTS are the synced collections, so it is
    // covered by the Persisted test above rather than by a name of its own.
    data: 'servers',
    credproxy: 'credproxyRules',
    inspect: 'inspectCA',
  }
  return aliases[base] ?? base
}

/**
 * The constants `ALL_DATA_FILES` carries by reference rather than by literal.
 * They are real entries and the guardrail must see them.
 */
const FILES_BY_CONSTANT = ['credproxyAudit', 'rules', 'backupTargets']

/**
 * The fifth key set: an enum that names values from somewhere else.
 *
 * `terminalScheme`'s allowed values were wrong in both directions from the day
 * they were written -- `default`, `gruvbox` and `custom` are ids this app has
 * never had, while `''`, `gruvbox-dark` and `one-dark` are ids it does have
 * and were missing. `validateT2` throws rather than drops, so somebody on One
 * Dark would have had their entire profile rejected.
 *
 * It drifted because nothing tied it to the schemes. Restating a list is how
 * a list goes stale; this derives it, in the same spirit as ALL_DATA_FILES
 * being pinned against a directory listing above.
 */
describe('the terminalScheme enum tracks the schemes that exist', () => {
  const field = T2_ALLOWLIST.find((f) => f.name === 'terminalScheme')

  it('is an enum', () => {
    expect(field?.kind).toBe('enum')
  })

  it('names every built-in scheme, plus the app palette', () => {
    const allowed = field?.kind === 'enum' ? [...field.values].sort() : []
    const expected = ['', ...TERMINAL_SCHEMES.map((s) => s.id)].sort()
    expect(allowed).toEqual(expected)
  })

  it('accepts what the settings pane can actually store', () => {
    expect(() => validateT2({ terminalScheme: '' })).not.toThrow()
    for (const s of TERMINAL_SCHEMES) {
      expect(() => validateT2({ terminalScheme: s.id })).not.toThrow()
    }
  })

  it('still refuses an imported scheme, whose id carries a user string', () => {
    // Deliberate, and the reason the enum is not a prefix rule: this tier is
    // stored in the clear, so publishing `imported-<slug of a filename>`
    // would put something off the user's disk into it. A caller has to decide
    // what to do instead -- most likely fall back to ''.
    expect(() => validateT2({ terminalScheme: 'imported-my-theme' })).toThrow()
  })
})
