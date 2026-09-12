import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  unlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { randomBytes, scrypt, createCipheriv } from 'node:crypto'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'
import { ALL_DATA_DIRS, ALL_DATA_FILES, backupImport, deleteAllData } from '../src/main/services/backup'
import { HISTORY_FILE } from '../src/main/services/history'
import { vpnRunRoot, vpnStateRoot } from '../src/main/services/vpn/runDir'

// Written out by hand, and compared against the real list below, because the
// two failure modes are opposite and both matter. Importing the list alone
// proves only that deleteAllData deletes what it names; this literal is the
// half that says WHAT IT SHOULD NAME, so a file the app starts writing has to
// be argued about in a diff a reviewer sees rather than quietly surviving a
// "delete everything".
//
// The check that keeps this honest is a directory listing, not memory:
//
//     grep -rn "getPath('userData')" src/main/
//
// That is how eleven of these were found missing from ALL_DATA_FILES — all three
// of the append-only logs next to the AI audit log (`opsmaxx-local-sessions`,
// `opsmaxx-job-approvals`, `opsmaxx-credproxy-audit`), and eight state files
// besides: `opsmaxx-credproxy`, `opsmaxx-env-secrets`, `opsmaxx-vault-bio`,
// `opsmaxx-rdp-certs`, `opsmaxx-rules`, `opsmaxx-runbooks`, `opsmaxx-processes`
// and `opsmaxx-backup-targets`. Spelled out rather than counted, because a
// number in a comment is the thing that goes stale first.
const WRITES_TO_USERDATA = [
  'instance-id',
  'opsmaxx-ai-audit.jsonl',
  'opsmaxx-ai-policy.json',
  'opsmaxx-backup-targets.json',
  'opsmaxx-credproxy-audit.jsonl',
  'opsmaxx-credproxy.json',
  'opsmaxx-data.json',
  'opsmaxx-env-secrets.json',
  'opsmaxx-job-approvals.jsonl',
  'opsmaxx-known-hosts.json',
  'opsmaxx-local-sessions.jsonl',
  'opsmaxx-mcp-config.json',
  'opsmaxx-mcp-sessions.json',
  'opsmaxx-processes.json',
  'opsmaxx-rdp-certs.json',
  'opsmaxx-rules.json',
  'opsmaxx-runbooks.json',
  'opsmaxx-secrets.json',
  'opsmaxx-startup.json',
  'opsmaxx-vault-bio.json',
  'opsmaxx-vault.json',
  'opsmaxx-wslocks.json',
  'update-prefs.json'
]

// Settings rather than data: deleting them changes how the app behaves without
// deleting anything about anybody. The reasoning for each is on ALL_DATA_FILES
// itself; it lives there because that is where the next person adding a file
// looks. Naming them HERE as well is what makes the assertion below a decision
// instead of a subtraction — a file must be in one list or the other.
const KEPT_ON_PURPOSE = ['instance-id', 'opsmaxx-startup.json', 'update-prefs.json']

const EXPECTED_DATA_FILES = WRITES_TO_USERDATA.filter((f) => !KEPT_ON_PURPOSE.includes(f))

// The same pair of lists for DIRECTORIES, and for the same reason. The wipe had
// none of these: it walked files only, so the traffic inspector's root CA
// CERTIFICATE — the one the user installs into their OS trust store — survived
// "delete everything", along with the record of the system proxy settings the
// inspector replaced. (Its private key was never here; setSecret seals that into
// opsmaxx-secrets.json, which the file list above already covered.)
const DIRS_UNDER_USERDATA = [
  'external-edit',
  'fish',
  'inspect',
  'inspect-capture',
  'inspect-run',
  'process-run',
  'vpn-run',
  'vpn-state'
]

// Kept, each for a reason spelled out next to ALL_DATA_DIRS. In short: the three
// run roots hold pid files and sockets and nothing else, and only while a
// process is alive — which is the one case where deleting them matters, and the
// case where the pid file is all that lets the next launch kill a process this
// delete orphaned. `fish` is a generated constant snippet naming nobody.
const KEPT_DIRS_ON_PURPOSE = ['fish', 'inspect-run', 'process-run', 'vpn-run']

const EXPECTED_DATA_DIRS = DIRS_UNDER_USERDATA.filter((d) => !KEPT_DIRS_ON_PURPOSE.includes(d))

function paths(): string[] {
  return ALL_DATA_FILES.map((f) => join(app.getPath('userData'), f))
}

function dirPaths(): string[] {
  return ALL_DATA_DIRS.map((d) => join(app.getPath('userData'), d))
}

// The database and every sidecar the store can leave behind: the WAL and shm
// the journal mode creates, the .bak the recovery ladder restores from, and the
// timestamped copies the ladder moves a corrupt primary aside to.
function historyPaths(): string[] {
  const db = join(app.getPath('userData'), HISTORY_FILE)
  return [
    db,
    `${db}-wal`,
    `${db}-shm`,
    `${db}.bak`,
    // The backup is written here and renamed onto the .bak, so a process that
    // died under one leaves this behind holding the same inventory.
    `${db}.bak.tmp`,
    `${db}.corrupt-1700000000000`
  ]
}

function writeHistoryFiles(): void {
  for (const p of historyPaths()) writeFileSync(p, 'srv-prod-01 kernel 6.1.0 nginx.service :443')
}

function cleanup(): void {
  // `.tmp` siblings as well: the restore writes through one per file, and the
  // symlink tests below plant links there — a leftover would be inherited by
  // every test after them.
  const tmps = paths().map((p) => `${p}.tmp`)
  for (const p of [...paths(), ...tmps, ...historyPaths(), ...dirPaths()]) {
    try {
      // A test that made something unremovable has to undo that first, or the
      // rest of the file inherits it.
      if (existsSync(p)) chmodSync(p, 0o700)
      rmSync(p, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

describe('the list of everything to delete', () => {
  it('names every file the app writes under userData, minus the ones kept on purpose', () => {
    // The bug this exists for: ALL_DATA_FILES called itself "deliberately
    // exhaustive" and was missing eleven of the twenty files it now names,
    // including the wrapped vault key that biometric unlock leaves on disk — so a
    // "delete everything" removed opsmaxx-vault.json and left a usable key for it
    // behind. The eleven are enumerated above WRITES_TO_USERDATA.
    expect([...ALL_DATA_FILES].sort()).toEqual([...EXPECTED_DATA_FILES].sort())
  })

  it('decides about every file rather than ignoring some', () => {
    // A new file added to WRITES_TO_USERDATA and to neither side fails the
    // assertion above; this one catches the other slip, a KEPT_ON_PURPOSE entry
    // for a file nothing writes any more.
    expect(KEPT_ON_PURPOSE.filter((f) => !WRITES_TO_USERDATA.includes(f))).toEqual([])
    expect(ALL_DATA_FILES.filter((f) => !WRITES_TO_USERDATA.includes(f))).toEqual([])
  })

  it('names every directory the app writes under userData, minus the ones kept on purpose', () => {
    // The bug: the wipe walked files and nothing else, so `inspect/` — holding
    // the certificate of a root CA the user installed into their OS trust store,
    // and the system proxy settings it replaced — came through "delete
    // everything" intact, along with the remote file contents under
    // `external-edit/` and the tsnet node key under `vpn-state/`.
    expect([...ALL_DATA_DIRS].sort()).toEqual([...EXPECTED_DATA_DIRS].sort())
  })

  it('decides about every directory rather than ignoring some', () => {
    expect(KEPT_DIRS_ON_PURPOSE.filter((d) => !DIRS_UNDER_USERDATA.includes(d))).toEqual([])
    expect(ALL_DATA_DIRS.filter((d) => !DIRS_UNDER_USERDATA.includes(d))).toEqual([])
  })

  it('keeps the VPN run root and wipes the durable VPN state, by the names runDir.ts uses', () => {
    // Both names are literals in ALL_DATA_DIRS, and the two directories are
    // opposites that look alike: one is scratch that must not outlive the
    // process, the other is a tsnet node's private key, which must. Renaming
    // either in vpn/runDir.ts — a file this list cannot see into — would
    // otherwise silently move a private key out of the wipe's reach.
    expect(KEPT_DIRS_ON_PURPOSE).toContain(basename(vpnRunRoot()))
    expect(ALL_DATA_DIRS).toContain(basename(vpnStateRoot()))
  })
})

describe('deleteAllData', () => {
  afterEach(cleanup)

  it('removes every known data file', () => {
    for (const p of paths()) writeFileSync(p, '{}')
    expect(paths().every(existsSync)).toBe(true)

    const result = deleteAllData()

    expect(result.ok).toBe(true)
    expect(paths().some(existsSync)).toBe(false)
  })

  it('succeeds even when some or all files and directories never existed', () => {
    // Nothing written this time — a fresh install with no data yet, which is
    // also every install that never opened the traffic inspector or edited a
    // remote file externally: none of the directories exist.
    expect(dirPaths().some(existsSync)).toBe(false)

    const result = deleteAllData()

    expect(result.ok).toBe(true)
  })

  it('removes every known data directory, contents and all', () => {
    // `inspect/` is the one that matters most: ca.crt, its KEY, and the system
    // proxy settings as they were before the inspector rewrote them.
    for (const d of dirPaths()) {
      mkdirSync(join(d, 'nested'), { recursive: true })
      writeFileSync(join(d, 'nested', 'ca.key'), '-----BEGIN PRIVATE KEY-----')
    }
    expect(dirPaths().every(existsSync)).toBe(true)

    const result = deleteAllData()

    expect(result.ok).toBe(true)
    expect(dirPaths().filter(existsSync)).toEqual([])
  })

  it('leaves the run roots alone, because their pid files are what kills an orphan', () => {
    // relaunchApp() exits with app.exit(0) and stops nothing on the way out, so
    // a tunnel or the inspector sidecar outlives this delete. reapOrphans()
    // finds and kills it on the next launch BY the pid file in here; delete the
    // directory and the orphan keeps the user's routes, DNS or TLS with nothing
    // left able to stop it.
    const runRoots = KEPT_DIRS_ON_PURPOSE.map((d) => join(app.getPath('userData'), d))
    for (const d of runRoots) {
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'tunnel.pid'), '{"pid":4242}')
    }

    deleteAllData()

    expect(runRoots.filter((d) => !existsSync(join(d, 'tunnel.pid')))).toEqual([])
    for (const d of runRoots) rmSync(d, { recursive: true, force: true })
  })

  // chmod is what makes a path unremovable here, and it decides nothing on
  // Windows; root ignores it everywhere.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps going when one path cannot be removed, and says which',
    () => {
      for (const p of paths()) writeFileSync(p, '{}')
      for (const d of dirPaths()) mkdirSync(d, { recursive: true })
      writeHistoryFiles()
      // A directory whose child cannot be unlinked: removing it throws EACCES
      // part of the way through, which is the shape of the real failures — EPERM
      // on a directory, EBUSY on a handle Windows still has open.
      const stuck = join(app.getPath('userData'), 'inspect')
      writeFileSync(join(stuck, 'ca.key'), '-----BEGIN PRIVATE KEY-----')
      chmodSync(stuck, 0o500)

      const result = deleteAllData()

      // Reported, not swallowed: a partial wipe announced as a complete one is
      // worse than the partial wipe.
      expect(result.ok).toBe(false)
      expect(result.error).toContain('inspect')
      // And everything else went anyway. Before this was isolated per path, the
      // first EACCES abandoned every path after it in the list — so the longer
      // the list grew, the more a "delete everything" could leave behind.
      expect(existsSync(stuck)).toBe(true)
      expect(paths().filter(existsSync)).toEqual([])
      expect(dirPaths().filter((d) => d !== stuck).filter(existsSync)).toEqual([])
      expect(historyPaths().filter(existsSync)).toEqual([])

      chmodSync(stuck, 0o700)
    }
  )

  it('does not touch files outside the known list', () => {
    const untouched = join(app.getPath('userData'), 'some-other-file.json')
    writeFileSync(untouched, 'keep me')

    deleteAllData()

    expect(existsSync(untouched)).toBe(true)
    unlinkSync(untouched)
  })

  it('deletes the history database, its sidecars, its backup and its corrupt copies', () => {
    // "Delete all data" that leaves opsmaxx-history.db behind relaunches the
    // app on a file still holding every hostname, kernel version, systemd unit
    // and listening port in the estate — for ninety days — and then goes on
    // appending to it. history.ts chmods that file 0600 precisely because it is
    // sensitive; a delete that skips it is the same claim made backwards.
    writeHistoryFiles()
    expect(historyPaths().every(existsSync)).toBe(true)

    const result = deleteAllData()

    expect(result.ok).toBe(true)
    expect(historyPaths().filter(existsSync)).toEqual([])
    // And nothing history-shaped is left in the directory at all.
    expect(readdirSync(app.getPath('userData')).filter((f) => f.startsWith(HISTORY_FILE))).toEqual([])
  })

  it('closes the store before unlinking, because app.exit(0) never runs before-quit', () => {
    // relaunchApp() calls app.exit(0), which does NOT emit 'before-quit', so
    // the teardown that closes the store never runs on this path. Unlinking an
    // open database is EBUSY on Windows, so the close has to happen here.
    writeHistoryFiles()
    const sawFile: boolean[] = []
    deleteAllData(() => sawFile.push(existsSync(historyPaths()[0])))
    // Called exactly once, and while the database was still on disk — i.e.
    // before the unlink, not after it.
    expect(sawFile).toEqual([true])
    expect(historyPaths().some(existsSync)).toBe(false)
  })

  it('still succeeds when closing the store throws but everything went anyway', () => {
    // The close is not a path, and `ok: false` is read as "something is still on
    // disk": it skips the relaunch and puts the user back on "Try again", where
    // every removal is now a `force: true` no-op and only the close fails again
    // — the same ok:false forever, with the success toast and the restart
    // unreachable. The close mattering at all is covered by the unlink, which
    // reports itself.
    writeFileSync(paths()[0], '{}')
    writeHistoryFiles()

    const result = deleteAllData(() => {
      throw new Error('store was already gone')
    })

    expect(result.ok).toBe(true)
    expect(paths().filter(existsSync)).toEqual([])
    expect(historyPaths().filter(existsSync)).toEqual([])
  })
})

// A bundle written the way backupExport writes one, so the import path can be
// exercised without a save dialog.
async function writeBundle(
  file: string,
  password: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const salt = randomBytes(16)
  const key: Buffer = await new Promise((resolve, reject) =>
    scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 }, (err, dk) =>
      err ? reject(err) : resolve(dk as Buffer)
    )
  )
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const payload = {
    version: 1,
    createdAt: new Date().toISOString(),
    app: '0.9.7',
    data: { servers: [] },
    secrets: {},
    vault: null,
    workspaceLocks: null,
    knownHosts: null,
    ...extra
  }
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  writeFileSync(
    file,
    JSON.stringify({
      magic: 'opsmaxx-backup',
      version: 1,
      kdf: 'scrypt',
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: body.toString('base64')
    })
  )
}

describe('backupImport', () => {
  afterEach(cleanup)

  it('clears the previous estate history rather than co-mingling it', async () => {
    // A bundle carries connections, credentials and vault — it does not carry
    // history. Restoring one onto a machine that already has a database leaves
    // the PREVIOUS estate's hostnames, units and ports underneath the new
    // estate's, in one table, with nothing marking which is which.
    const bundle = join(app.getPath('userData'), 'test.spbackup')
    await writeBundle(bundle, 'passphrase-1234')
    writeHistoryFiles()

    const result = await backupImport('passphrase-1234', bundle)

    expect(result.ok).toBe(true)
    expect(historyPaths().filter(existsSync)).toEqual([])
    unlinkSync(bundle)
  })
})

// ---------------------------------------------------------------------------
// The restore is a WRITER, and four of the five files it writes are the ones
// the rest of the app was hardened for this session: the vault, the workspace
// locks, the SSH host-key pins and the server list. Its own temp-then-rename
// was missed, so restoring a backup handed all four of them back both gaps —
// the hardening held right up until the user used the feature that replaces
// those files wholesale.
// ---------------------------------------------------------------------------

const modeOf = (f: string): number => statSync(f).mode & 0o777

describe('the restore writes its files the hardened way', () => {
  afterEach(cleanup)

  // Somewhere to be overwritten that is not in userData, so cleanup() cannot
  // be what makes the assertion pass.
  let outside: string
  let victim: string
  beforeEach(() => {
    outside = mkdtempSync(join(tmpdir(), 'restore-victim-'))
    victim = join(outside, 'precious.txt')
  })
  afterEach(() => rmSync(outside, { recursive: true, force: true }))

  async function bundleWith(extra: Record<string, unknown>): Promise<string> {
    const bundle = join(outside, 'test.spbackup')
    await writeBundle(bundle, 'passphrase-1234', extra)
    return bundle
  }

  it('does not write the host-key pins through a symlink planted at their temp path', async () => {
    // The attack this closes: the temp path is fixed and guessable, so a
    // same-uid attacker pre-creates it as a link, waits for a restore, and both
    // chooses where the contents land AND what the app reads back as the host
    // keys it trusts. The old form wrote THROUGH the link and then renamed the
    // victim's inode into place as the real pin file.
    const real = join(app.getPath('userData'), 'opsmaxx-known-hosts.json')
    writeFileSync(victim, 'precious')
    rmSync(`${real}.tmp`, { force: true })
    symlinkSync(victim, `${real}.tmp`)

    const pins = { 'example.test:2222': { key: 'AAAA-restored' } }
    const result = await backupImport('passphrase-1234', await bundleWith({ knownHosts: pins }))

    expect(result.ok).toBe(true)
    // The victim is untouched...
    expect(readFileSync(victim, 'utf8')).toBe('precious')
    // ...the real file holds the restored pins, is not the link, and is 0600.
    expect(JSON.parse(readFileSync(real, 'utf8'))).toEqual(pins)
    expect(lstatSync(real).isSymbolicLink()).toBe(false)
    expect(existsSync(`${real}.tmp`)).toBe(false)
    if (process.platform !== 'win32') expect(modeOf(real)).toBe(0o600)
  })

  it.skipIf(process.platform === 'win32')(
    'narrows a wide temp file left behind at the vault path instead of inheriting it',
    async () => {
      // Gap one needs no symlink at all. `mode` applies only on CREATION, so a
      // 0644 `.tmp` from a crashed earlier run kept its mode and the rename
      // published the vault with it.
      //
      // The precondition is set with chmodSync: writeFileSync's `mode` option is
      // masked by the umask, so setting 0o666 that way asserts nothing.
      const real = join(app.getPath('userData'), 'opsmaxx-vault.json')
      writeFileSync(`${real}.tmp`, 'stale')
      chmodSync(`${real}.tmp`, 0o666)
      expect(modeOf(`${real}.tmp`)).toBe(0o666)

      const result = await backupImport(
        'passphrase-1234',
        await bundleWith({ vault: { entries: [{ id: 'v1' }] } })
      )

      expect(result.ok).toBe(true)
      expect(modeOf(real)).toBe(0o600)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'blames the write, not the passphrase, when a restored file cannot be written',
    async () => {
      // The bundle DECRYPTED. Reporting this as "check the passphrase" sends the
      // user to rotate a passphrase that was fine and says nothing about the
      // half-restored state they are actually in.
      const bundle = await bundleWith({ data: { servers: [{ id: 's1' }] } })
      const userData = app.getPath('userData')
      chmodSync(userData, 0o500) // nothing can be created in here
      try {
        const result = await backupImport('passphrase-1234', bundle)
        expect(result.ok).toBe(false)
        expect(result.error).not.toContain('passphrase')
        expect(result.error).toContain('decrypted')
      } finally {
        chmodSync(userData, 0o700)
      }
    }
  )
})

// closeHistoryNow is read off main/index.ts rather than imported: the module is
// an Electron entry point that arms timers and IPC at load, and the mistake
// worth catching here is one edit wide. Same approach as dbSizeSample.test.ts
// and localTargetGated.test.ts.
describe('closeHistoryNow drops the store reference even when close() throws', () => {
  it('assigns null in a finally, not after the call', () => {
    const whole = readFileSync(
      fileURLToPath(new URL('../src/main/index.ts', import.meta.url)),
      'utf8'
    )
    const at = whole.indexOf('function closeHistoryNow')
    expect(at).toBeGreaterThan(0)
    const body = whole.slice(at, whole.indexOf('\n}', at))

    // A throwing close is the one case where the store keeps BOTH its reference
    // and its open handle: deleteAllData catches the throw and carries on, the
    // POSIX unlink then succeeds, `failed` stays empty, and it reports ok:true
    // with a live sqlite connection still attached to the unlinked inode.
    expect(body).toMatch(/try\s*\{\s*historyStore\?\.close\(\)\s*\}\s*finally\s*\{\s*historyStore = null/)
    // And not the old bare sequence, which skipped the assignment on a throw.
    expect(body).not.toMatch(/historyStore\?\.close\(\)\s*\n\s*historyStore = null/)
  })
})
