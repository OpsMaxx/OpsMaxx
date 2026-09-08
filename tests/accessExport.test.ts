import { describe, it, expect } from 'vitest'

import {
  ACCESS_EXPORT_COLUMNS,
  accessCoverageCsv,
  accessExportCoverage,
  accessExportCsv,
  accessExportJson,
  buildAccessExport,
  loginRecency,
  type AccessExportInput
} from '../src/shared/accessExport'
import type { AccessAccount, HostAccess } from '../src/shared/access'

// Item 46's access-review export. A projection of facts the collector already
// holds, and everything asserted here is about the difference between a fact
// and a gap: an export is read as a complete list of who can get in, and every
// way for it not to be one has to be visible in the file itself.

const T0 = Date.UTC(2026, 5, 1)
const DAY = 86_400_000

const account = (over: Partial<AccessAccount> = {}): AccessAccount =>
  ({
    user: 'deploy',
    uid: 1001,
    shell: '/bin/bash',
    home: '/home/deploy',
    keys: [
      {
        type: 'ssh-ed25519',
        rawType: 'ssh-ed25519',
        bits: 256,
        comment: 'laptop',
        fingerprint: 'SHA256:aaa',
        options: [],
        restricted: false,
        broadened: false
      }
    ],
    keysStatus: 'ok',
    keyPath: '/home/deploy/.ssh/authorized_keys',
    hasLegacyKeyFile: false,
    passwordLocked: false,
    accountStatus: 'ok',
    expiresText: null,
    expired: false,
    adminGroups: ['sudo'],
    lastLoginText: 'Mon Jun 1 09:00',
    lastLoginAt: T0 - 10 * DAY,
    neverLoggedIn: false,
    ...over
  }) as AccessAccount

const host = (over: Partial<HostAccess> = {}): HostAccess =>
  ({
    accounts: [account()],
    authorizedKeysFile: ['.ssh/authorized_keys'],
    keyFileIsDefault: true,
    readsTheFileWeRead: true,
    readsLegacyKeyFile: true,
    authorizedKeysCommand: null,
    collectedAs: 'ops',
    sessionKeyFingerprints: [],
    sessionKeysCertain: true,
    collectedAt: T0,
    ...over
  }) as HostAccess

const one = (over: Partial<AccessExportInput> = {}): AccessExportInput[] => [
  { serverId: 's1', serverName: 'web-1', access: host(), ...over }
]

describe('a host that could not be read is still in the export', () => {
  // An export is read as a complete list of access. A host dropping out of it
  // turns "we could not look at that machine" into "nobody can get into it".
  it('gives an unread host a row saying so', () => {
    const rows = buildAccessExport(one({ access: null, error: 'permission denied' }))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ serverName: 'web-1', user: '', hostProblem: 'permission denied' })
  })

  it('says something even when no reason was recorded', () => {
    expect(buildAccessExport(one({ access: null }))[0].hostProblem).toContain('was not read')
  })

  it('separates a host that answered with nothing from one that did not answer', () => {
    // An empty section in an access review is a question. A missing one is not.
    const empty = buildAccessExport(one({ access: host({ accounts: [] }) }))
    expect(empty).toHaveLength(1)
    expect(empty[0].hostProblem).toContain('answered and listed no accounts')
    expect(empty[0].hostProblem).not.toContain('not read')
  })
})

describe('the since filter never silently drops an unknown', () => {
  const since = T0 - 30 * DAY

  it('keeps an account that logged in after the cut-off', () => {
    expect(buildAccessExport(one(), { since })).toHaveLength(1)
  })

  it('drops one that logged in before it', () => {
    const old = host({ accounts: [account({ lastLoginAt: T0 - 200 * DAY })] })
    expect(buildAccessExport(one({ access: old }), { since })).toEqual([])
  })

  // THE rule. `lastLoginAt` is null both for an account whose last login could
  // not be dated and for one that never logged in, and those are different
  // things the collector already separates. Filtering either out would remove
  // exactly the accounts an auditor is looking for.
  it('keeps an account whose last login could not be dated, and marks it', () => {
    const undated = host({
      accounts: [account({ lastLoginAt: null, lastLoginText: 'Jun 1', neverLoggedIn: false })]
    })
    const rows = buildAccessExport(one({ access: undated }), { since })
    expect(rows).toHaveLength(1)
    expect(rows[0].recency).toBe('undated')
  })

  it('keeps an account that has never logged in, and marks it differently', () => {
    const never = host({
      accounts: [account({ lastLoginAt: null, lastLoginText: null, neverLoggedIn: true })]
    })
    const rows = buildAccessExport(one({ access: never }), { since })
    expect(rows[0].recency).toBe('never')
  })

  it('marks recency even with no cut-off asked for', () => {
    expect(loginRecency(account(), null)).toBe('since')
    expect(loginRecency(account({ neverLoggedIn: true, lastLoginAt: null }), null)).toBe('never')
  })
})

describe('what a row carries', () => {
  it('classifies the account rather than repeating its name', () => {
    const rows = buildAccessExport(one())
    expect(rows[0]).toMatchObject({ user: 'deploy', uid: 1001, klass: 'person', loginDisabled: false })
  })

  it('reports an unread shell as unknown, not as a usable login', () => {
    const noShell = host({ accounts: [account({ shell: null })] })
    expect(buildAccessExport(one({ access: noShell }))[0].loginDisabled).toBeNull()
  })

  it('gives each key its own row', () => {
    const two = host({
      accounts: [
        account({
          keys: [
            { type: 'ssh-ed25519', fingerprint: 'SHA256:a', options: [], restricted: false, bits: 256 },
            { type: 'ssh-rsa', fingerprint: 'SHA256:b', options: ['no-pty'], restricted: true, bits: 2048 }
          ] as unknown as AccessAccount['keys']
        })
      ]
    })
    const rows = buildAccessExport(one({ access: two }))
    expect(rows.map((r) => r.keyFingerprint)).toEqual(['SHA256:a', 'SHA256:b'])
    expect(rows[1]).toMatchObject({ keyOptions: 'no-pty', keyRestricted: true })
  })

  it('still lists an account whose keys could not be read, with the status', () => {
    // An account missing from the export because its key file refused is an
    // account that looks like it has no access.
    const denied = host({ accounts: [account({ keys: null, keysStatus: 'denied' })] })
    const rows = buildAccessExport(one({ access: denied }))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ user: 'deploy', keyFingerprint: '', keysStatus: 'denied' })
  })

  // The whole access feature exists on the promise that key material does not
  // leave. A column that carried a blob would be that promise ending.
  it('has no column that could hold key material', () => {
    for (const c of ACCESS_EXPORT_COLUMNS) {
      expect(c).not.toMatch(/blob|material|secret|private|body|raw$/i)
    }
    const csv = accessExportCsv(buildAccessExport(one()))
    expect(csv).toContain('SHA256:aaa')
    expect(csv).not.toContain('AAAAC3Nza')
  })
})

describe('the coverage line, which says whether the rows are the whole story', () => {
  it('flags an sshd reading keys from somewhere this did not look', () => {
    const elsewhere = host({ keyFileIsDefault: false })
    expect(accessExportCoverage(one({ access: elsewhere }))[0].problem).toContain(
      'a path this collection did not open'
    )
  })

  it('flags an sshd that does not read the file this read', () => {
    const other = host({ readsTheFileWeRead: false })
    expect(accessExportCoverage(one({ access: other }))[0].problem).toContain('grant nothing')
  })

  it('flags keys generated at login time, which cannot be listed at all', () => {
    const cmd = host({ authorizedKeysCommand: '/usr/bin/sss_ssh_authorizedkeys' })
    const p = accessExportCoverage(one({ access: cmd }))[0]
    expect(p.problem).toContain('sss_ssh_authorizedkeys')
    expect(p.problem).toContain('cannot be listed from disk')
  })

  it('counts the accounts whose keys could not be read', () => {
    const mixed = host({
      accounts: [account(), account({ user: 'root', uid: 0, keys: null, keysStatus: 'denied' })]
    })
    expect(accessExportCoverage(one({ access: mixed }))[0].accountsWithUnreadKeys).toBe(1)
  })

  it('does not count an account that genuinely has no key file', () => {
    // `absent` was CHECKED. It is not a gap.
    const none = host({ accounts: [account({ keys: [], keysStatus: 'absent' })] })
    expect(accessExportCoverage(one({ access: none }))[0].accountsWithUnreadKeys).toBe(0)
  })

  it('says nothing is known about a host that was not read', () => {
    const c = accessExportCoverage(one({ access: null, error: 'timed out' }))[0]
    expect(c).toMatchObject({ collectedAt: null, keyFileIsDefault: null, problem: 'timed out' })
  })

  it('leaves the problem empty on a host with nothing to disclose', () => {
    expect(accessExportCoverage(one())[0].problem).toBe('')
  })
})

describe('the file itself', () => {
  it('writes a header and one line per row', () => {
    const csv = accessExportCsv(buildAccessExport(one()))
    expect(csv.split('\n')).toHaveLength(2)
    expect(csv.split('\n')[0]).toBe(ACCESS_EXPORT_COLUMNS.join(','))
  })

  it('writes an unknown as empty, never as a zero or the word null', () => {
    // A spreadsheet reading `0` for "we could not tell" is the failure this
    // whole app is built against.
    const unknown = host({ accounts: [account({ uid: null, passwordLocked: null, expired: null })] })
    const line = accessExportCsv(buildAccessExport(one({ access: unknown }))).split('\n')[1]
    expect(line).not.toContain('null')
    expect(line.split(',')[2]).toBe('')
  })

  // A key comment is attacker-controlled text off a host. A cell beginning `=`
  // is a FORMULA in every spreadsheet, so this is an injection into the
  // auditor's machine rather than a formatting nicety.
  it('defuses a cell a spreadsheet would run as a formula', () => {
    const evil = host({
      accounts: [
        account({
          keys: [
            {
              type: 'ssh-rsa',
              fingerprint: 'SHA256:c',
              comment: '=cmd|\' /c calc\'!A1',
              options: [],
              restricted: false,
              bits: 2048
            }
          ] as unknown as AccessAccount['keys']
        })
      ]
    })
    const csv = accessExportCsv(buildAccessExport(one({ access: evil })))
    expect(csv).toContain("'=cmd")
    expect(csv).not.toMatch(/,=cmd/)
  })

  it('quotes a value containing a comma or a quote', () => {
    const comma = host({ accounts: [account({ lastLoginText: 'Mon, 1 Jun "09:00"' })] })
    expect(accessExportCsv(buildAccessExport(one({ access: comma })))).toContain(
      '"Mon, 1 Jun ""09:00"""'
    )
  })

  it('writes booleans as words rather than true/false', () => {
    expect(accessExportCsv(buildAccessExport(one()))).toContain(',no,')
  })

  it('puts the coverage before the rows in the JSON', () => {
    const json = accessExportJson(buildAccessExport(one()), accessExportCoverage(one()), {
      generatedAt: T0,
      since: null
    })
    expect(json.indexOf('"coverage"')).toBeLessThan(json.indexOf('"accounts"'))
    expect(JSON.parse(json).since).toBeNull()
  })

  it('writes a coverage CSV of its own', () => {
    const csv = accessCoverageCsv(accessExportCoverage(one({ access: host({ keyFileIsDefault: false }) })))
    expect(csv.split('\n')[0]).toContain('accountsWithUnreadKeys')
    expect(csv).toContain('a path this collection did not open')
  })
})
