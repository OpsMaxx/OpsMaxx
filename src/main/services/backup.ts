import { app, dialog, BrowserWindow } from 'electron'
import { join } from 'node:path'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  renameSync,
  unlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { randomBytes, scrypt, createCipheriv, createDecipheriv } from 'node:crypto'
import { spawn } from 'node:child_process'
import { atomicWriteFileSync } from './atomicWrite'
import { exportSecrets, importSecrets } from './secrets'
import { removeHistoryFiles } from './history'
import { CRED_PROXY_AUDIT_FILE } from './credProxy'
import { RULES_FILE } from '../../shared/rules'
import { openTarget, sha256, type BackupTarget, type TargetDeps } from './backupTargets'
import { vaultList, vaultStatus } from './vault'
import {
  backupObjectName,
  backupObjectTime,
  dumpCommand,
  dumpObjectName,
  DUMP_BINARY,
  describeRun,
  dueDestinations,
  planRetention
} from '../../shared/backup'
import type {
  BackupDestination,
  BackupGeneration,
  BackupPayload,
  BackupResult,
  BackupRunReport,
  BackupStage,
  BackupSummary,
  BackupTargetsFile,
  BackupVerification,
  DumpCommand,
  DumpRunReport,
  DumpTarget,
  RemoteListResult
} from '../../shared/backup'

// A backup is a single passphrase-encrypted file containing everything needed
// to rebuild the app on another machine.
//
// Credentials on disk are sealed with the OS keychain, which is bound to this
// machine and user — copying that file elsewhere yields nothing recoverable.
// So the bundle unseals them and re-encrypts the whole payload under a
// passphrase the user supplies, which travels with the file.

const KDF = { N: 32768, r: 8, p: 1, keylen: 32, maxmem: 96 * 1024 * 1024 }
const MAGIC = 'opsmaxx-backup'

interface Envelope {
  magic: string
  version: 1
  kdf: 'scrypt'
  salt: string
  iv: string
  tag: string
  data: string
}

const userFile = (name: string): string => join(app.getPath('userData'), name)

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KDF.keylen, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: KDF.maxmem }, (err, dk) =>
      err ? reject(err) : resolve(dk as Buffer)
    )
  })
}

function readJson(name: string): unknown | null {
  try {
    const p = userFile(name)
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    /* treat unreadable as absent rather than failing the whole backup */
  }
  return null
}

// Through the shared helper, not its own temp-then-rename: four of the five
// files this writes are the vault, the workspace locks, the host-key pins and
// the server list — the very files vault.ts, wslock.ts, knownhosts.ts and
// store.ts were hardened for. A restore written the old way handed back both
// gaps on all four, so the hardening lasted until the user restored a backup.
function writeJson(name: string, value: unknown): void {
  atomicWriteFileSync(userFile(name), JSON.stringify(value))
}

function summarise(payload: BackupPayload): BackupSummary {
  const data = payload.data as
    | { servers?: unknown[]; databases?: unknown[]; workspaces?: unknown[] }
    | null
  return {
    createdAt: payload.createdAt,
    app: payload.app,
    servers: data?.servers?.length ?? 0,
    databases: data?.databases?.length ?? 0,
    workspaces: data?.workspaces?.length ?? 0,
    secrets: Object.keys(payload.secrets ?? {}).length,
    hasVault: payload.vault !== null
  }
}

export const MIN_PASSPHRASE = 8

/**
 * The bytes a backup file consists of, and what is in them.
 *
 * Split out of backupExport unchanged so there is exactly one place that
 * builds a bundle: the file the save dialog writes, the object uploaded to a
 * bucket and the file a scheduled run leaves in a directory are byte-for-byte
 * the same artefact, and none of them can drift away from the others by being
 * built somewhere else.
 */
export async function buildBundle(
  password: string
): Promise<{ bytes: Buffer; summary: BackupSummary }> {
  const payload: BackupPayload = {
    version: 1,
    createdAt: new Date().toISOString(),
    app: app.getVersion(),
    data: readJson('opsmaxx-data.json'),
    secrets: exportSecrets(),
    vault: readJson('opsmaxx-vault.json'),
    workspaceLocks: readJson('opsmaxx-wslocks.json'),
    knownHosts: readJson('opsmaxx-known-hosts.json')
  }

  const salt = randomBytes(16)
  const key = await derive(password, salt)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  const envelope: Envelope = {
    magic: MAGIC,
    version: 1,
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: body.toString('base64')
  }
  key.fill(0)
  return { bytes: Buffer.from(JSON.stringify(envelope), 'utf8'), summary: summarise(payload) }
}

export async function backupExport(password: string): Promise<BackupResult> {
  if (password.length < MIN_PASSPHRASE) {
    return { ok: false, error: 'Backup passphrase must be at least 8 characters.' }
  }

  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const stamp = new Date().toISOString().slice(0, 10)
  const chosen = await dialog.showSaveDialog(win, {
    title: 'Save OpsMaxx backup',
    defaultPath: join(app.getPath('downloads'), `opsmaxx-backup-${stamp}.spbackup`),
    filters: [{ name: 'OpsMaxx backup', extensions: ['spbackup'] }]
  })
  if (chosen.canceled || !chosen.filePath) return { ok: false, cancelled: true }

  try {
    const { bytes, summary } = await buildBundle(password)
    writeFileSync(chosen.filePath, bytes, { mode: 0o600 })
    return { ok: true, path: chosen.filePath, summary }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function decryptBundle(bytes: Buffer, password: string): Promise<BackupPayload> {
  let envelope: Envelope
  try {
    envelope = JSON.parse(bytes.toString('utf8')) as Envelope
  } catch {
    // A truncated upload, a text-mode transfer that mangled the file, or an
    // object that was never ours. All three are "not a OpsMaxx backup", and
    // saying so beats a JSON parser's offset.
    throw new Error('That file is not a OpsMaxx backup.')
  }
  if (envelope.magic !== MAGIC) throw new Error('That file is not a OpsMaxx backup.')
  const key = await derive(password, Buffer.from(envelope.salt, 'base64'))
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
  const plain = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, 'base64')),
    decipher.final()
  ])
  key.fill(0)
  return JSON.parse(plain.toString('utf8')) as BackupPayload
}

async function decryptFile(path: string, password: string): Promise<BackupPayload> {
  return decryptBundle(readFileSync(path), password)
}

// Reads a bundle and reports what it holds, without changing anything.
export async function backupInspect(password: string, path?: string): Promise<BackupResult> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  let file = path
  if (!file) {
    const chosen = await dialog.showOpenDialog(win, {
      title: 'Open OpsMaxx backup',
      properties: ['openFile'],
      filters: [{ name: 'OpsMaxx backup', extensions: ['spbackup'] }]
    })
    if (chosen.canceled || !chosen.filePaths[0]) return { ok: false, cancelled: true }
    file = chosen.filePaths[0]
  }
  try {
    const payload = await decryptFile(file, password)
    return { ok: true, path: file, summary: summarise(payload) }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      path: file,
      error: message.includes('OpsMaxx backup')
        ? message
        : 'Could not decrypt the backup — check the passphrase.'
    }
  }
}

// Replaces local state with the bundle's contents, then restarts so every
// service re-reads its files from a consistent starting point.
export async function backupImport(
  password: string,
  path: string,
  closeHistory?: () => void
): Promise<BackupResult> {
  // Decryption gets its own try, so that only a decryption failure is reported
  // as one. Everything after it is a WRITE, and a write that failed used to be
  // surfaced as "check the passphrase" — which sends the user to rotate a
  // passphrase that was fine, while the real cause (a temp path that could not
  // be cleared, a full disk, a read-only userData) goes unmentioned.
  let payload: BackupPayload
  try {
    payload = await decryptFile(path, password)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      error: message.includes('OpsMaxx backup')
        ? message
        : 'Could not decrypt the backup — check the passphrase.'
    }
  }

  try {
    const summary = summarise(payload)

    if (payload.data !== null) writeJson('opsmaxx-data.json', payload.data)
    if (payload.vault !== null) writeJson('opsmaxx-vault.json', payload.vault)
    if (payload.workspaceLocks !== null) writeJson('opsmaxx-wslocks.json', payload.workspaceLocks)
    if (payload.knownHosts !== null) writeJson('opsmaxx-known-hosts.json', payload.knownHosts)

    // The bundle carries connections, credentials and vault. It does not carry
    // history, and the history already on this machine belongs to a different
    // estate: keep it and the previous estate's hostnames, units and ports sit
    // underneath the restored ones in one table with nothing marking which is
    // which, and every "first seen" answer it gives is about somebody else's
    // server. So the store is cleared, exactly as deleteAllData clears it —
    // closed first, because unlinking an open database is EBUSY on Windows.
    //
    // After the writes above, not before: a bundle that fails to decrypt must
    // leave this machine exactly as it was, and by this line the local state
    // has already been replaced.
    closeHistory?.()
    removeHistoryFiles(app.getPath('userData'))

    const sealed = importSecrets(payload.secrets ?? {})
    if (!sealed) {
      return {
        ok: false,
        error:
          'Restored settings, but this system has no available secure storage, so credentials could not be saved.'
      }
    }
    return { ok: true, path, summary }
  } catch (err) {
    // The bundle decrypted, so the passphrase is not the problem. Say where it
    // stopped instead: by here some files may hold the restored contents and
    // the rest the previous ones, and that is the thing the user has to know.
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      error: `The backup decrypted, but restoring it failed partway through (${message}), so some settings may be the restored ones and some the previous ones.`
    }
  }
}

export function relaunchApp(): void {
  app.relaunch()
  app.exit(0)
}

// Deliberately its own file rather than a corner of opsmaxx-data.json.
//
// opsmaxx-data.json is `payload.data` — it is INSIDE every bundle. A
// destination's configuration describing the bucket that receives those
// bundles would therefore ride along in each one, and the vault entry ids it
// names would point at the credentials for the very store the file is sitting
// in. Keeping it out of the payload also means a restore does not silently
// re-point this machine at somebody else's bucket.
export const TARGETS_FILE = 'opsmaxx-backup-targets.json'

// Every file OpsMaxx writes to userData that says anything about this user or
// their estate — connections, credentials, vault, workspace locks, trusted SSH
// and RDP host keys, the AI/MCP bridge's own config, sessions, access-group
// policy, the four append-only logs of what was run and who said yes, the
// credential proxy's rules and the env variables they feed, the biometric vault
// key, the automation rules, the runbook notes, the managed process command
// lines, and where backups go. Twenty files, and the reason each is here is
// written beside it. Deliberately exhaustive: leaving one behind after a "delete
// everything" is worse than deleting one that never existed, which the removal's
// own `force: true` makes a no-op.
//
// It is exhaustive against a DIRECTORY LISTING rather than against memory —
// `grep -rn "getPath('userData')" src/main/` is the check, and
// tests/backup.test.ts pins the result so a new file fails the build rather
// than quietly surviving a wipe. It had drifted by ELEVEN of the twenty entries
// below: three of the four append-only logs (the AI audit log was the one
// already here) and eight of the state files were written by the app and absent
// from this list. Each of the eleven carries its own comment where it sits, so
// the count can be rechecked by reading down rather than taken on faith.
//
// Three files the app writes are deliberately NOT in it, because they are
// SETTINGS rather than data and deleting them changes behaviour without
// deleting anything about anybody:
//
//   * `update-prefs.json` — updater channel, interval, auto-install. Naming no
//     host and no credential, and a wipe that silently moved a beta user back
//     to stable would be a functional change made by a privacy action.
//   * `opsmaxx-startup.json` — one boolean, `openAsHidden`. Same argument.
//   * `instance-id` — a random per-install id, no estate information in it, and
//     detached jobs ALREADY RUNNING on remote hosts are matched to this install
//     by it (see `foreign` in shared/jobs.ts). Minting a new one would orphan
//     every one of them on machines this delete has no business reaching.
//
// The history database is NOT in this list because it is not one file: it is
// the database, two journal sidecars, a .bak and any number of timestamped
// corrupt copies. history.ts owns that list — see removeHistoryFiles — because
// a second copy of those suffixes over here is exactly how the database came to
// be missing from a delete that called itself exhaustive.
//
// The DIRECTORIES the app writes are ALL_DATA_DIRS, below, and are argued about
// there. They are a separate list only because a directory has to be removed
// recursively; the wipe walks both.
export const ALL_DATA_FILES = [
  'opsmaxx-data.json',
  'opsmaxx-secrets.json',
  'opsmaxx-vault.json',
  'opsmaxx-wslocks.json',
  'opsmaxx-known-hosts.json',
  'opsmaxx-mcp-config.json',
  'opsmaxx-mcp-sessions.json',
  'opsmaxx-ai-policy.json',
  'opsmaxx-ai-audit.jsonl',
  // The other three append-only logs, all three of which this list predated.
  // What they hold is the argument: local shells with their paths and cwds,
  // every approval with the hostnames and commands it authorised, and every
  // credential the proxy forwarded and to whom. A "delete everything" that
  // leaves a year of "who did what, and who approved it" behind has deleted the
  // connections and kept the record of using them.
  'opsmaxx-local-sessions.jsonl',
  'opsmaxx-job-approvals.jsonl',
  CRED_PROXY_AUDIT_FILE,
  // The proxy's rules: the third-party endpoints this machine forwards to and
  // the vault entry ids that unlock them, plus the token records. No secret
  // value is in it — those are in the keychain — and it is still a map of which
  // API credential this user holds for which service.
  'opsmaxx-credproxy.json',
  // Which environment variables were registered as secret-bearing, and what
  // they point at.
  'opsmaxx-env-secrets.json',
  // The vault's derived key, wrapped by safeStorage, for biometric unlock. The
  // single worst omission on this list: deleting opsmaxx-vault.json and leaving
  // this behind leaves an on-disk key for a vault the user was told was gone.
  'opsmaxx-vault-bio.json',
  // Trusted RDP host certificates — hostnames and fingerprints, the same kind
  // of thing as opsmaxx-known-hosts.json two lines up.
  'opsmaxx-rdp-certs.json',
  // Automation rules and runbook notes: commands, pinned server ids, and
  // whatever the user wrote down about their own estate.
  RULES_FILE,
  'opsmaxx-runbooks.json',
  // Managed long-running processes: command lines, hosts and the vault entries
  // they resolve at start time.
  'opsmaxx-processes.json',
  // Where backups go, how often, and which vault entries unlock the
  // destinations. No credential is in it — see backupTargets.ts — but the
  // endpoints, buckets and remote paths of every place this estate's secrets
  // are stored certainly are, and a "delete everything" that leaves behind a
  // map of where the copies live has not deleted everything.
  TARGETS_FILE
]

// Every DIRECTORY OpsMaxx creates under userData that holds anything about this
// user or their estate. Same standard as the file list, same check — the joins
// against `app.getPath('userData')` across src/main/ — and tests/backup.test.ts
// pins it the same way.
//
// It was a paragraph of excuses before it was a list. "Delete everything"
// walked the twenty files above and not one directory, so the traffic inspector's
// ROOT CA CERTIFICATE survived the button whose entire job is to leave nothing
// behind — the very certificate the user was walked through installing into
// their OS trust store, left on disk by a wipe, with the record of the system
// proxy settings it replaced beside it. (Not its private key: that is sealed
// into `opsmaxx-secrets.json` by setSecret, which is on the file list above, or
// held in main-process memory when the OS keychain refused to seal it. See
// inspect.ts.) Nor did `external-edit/` go, and that is whole remote file
// contents in plain text.
export const ALL_DATA_DIRS = [
  // The inspector's certificate authority, public half: the CERTIFICATE — the
  // one the user may have installed into the OS trust store, so a wipe that
  // leaves it behind leaves the artefact that matching trust decision points at
  // — plus `system-proxy-backup.json`, which records the system proxy settings
  // as they were before the inspector changed them and therefore names whatever
  // proxy this machine was pointed at. The CA's private key is NOT in here; it
  // never touches disk unsealed.
  'inspect',
  // Remote files pulled down to be opened in the user's own editor: whole file
  // contents from hosts in the estate, in plain text, under a hash of the
  // remote path.
  'external-edit',
  // Captured HTTP bodies. Cleared on every inspector start, so usually empty —
  // but "usually" is not the standard this function works to, and the session
  // interrupted by the delete is exactly the one whose bodies are still there.
  'inspect-capture',
  // The tsnet node's durable identity, which is a PRIVATE KEY, kept outside the
  // run root precisely so the startup sweep cannot reach it (see vpnStateRoot in
  // vpn/runDir.ts). Nothing else ever deletes it: alone among the directories
  // here, it survives forever on its own.
  'vpn-state'
]

// Three directories the app writes are deliberately NOT in that list —
// `inspect-run`, `process-run` and the VPN run root (`vpn-run`, see vpnRunRoot)
// — and the argument is the same for all three.
//
// They hold pid files and control sockets, and they hold them ONLY while a
// process is alive; when nothing is running they are empty or absent and
// deleting them achieves nothing. So the only case where deleting one does
// anything is the case where a process is running — and there the pid file is
// the sole remaining handle on it. `relaunchApp()` exits with `app.exit(0)`,
// which stops nothing on the way out, so the inspector sidecar or a live tunnel
// is orphaned BY this delete; `reapOrphans()` on the next launch finds and kills
// it by that pid file, and `sweepRunDirs([])` empties the root seconds later
// anyway. Remove the directory and the orphan cannot be killed at all: a tunnel
// still holding the user's routes and DNS, or a proxy still decrypting their
// TLS, with the UI that could have stopped it now knowing nothing about it. A
// generated engine config in a live run directory does carry key material, and
// that is the price — it is derived from a file this wipe does remove, and the
// relaunch sweeps it.
//
// The fix that would let them be wiped is to STOP all three first, the way
// `closeHistory` is handed in for the database. That is index.ts's call, not
// this file's.
//
// Not here either: the shell-integration files (`.zshrc`, `bash-init.sh`,
// `fish/`), which are a compile-time constant snippet naming no host and no
// user, rewritten on demand; and Chromium's own directories, which are not ours,
// are open in the running process, and hold nothing from the renderer but which
// banners have been dismissed.

// The renderer only calls this once a fresh backup exists (`!backupDirty`), so
// this function itself does not re-check that.
//
// Every removal stands alone and the failures are collected rather than thrown.
// One `try` around the whole loop is what this had, and the list is an order of
// declaration, not of priority: a single path that would not go — EPERM on a
// directory handed to `unlinkSync`, EBUSY on an open handle — abandoned every
// path after it, so the longer the list grew the more a "delete everything"
// could leave behind. It still reports the failure, because the only thing worse
// than a partial wipe is a partial wipe reported as a complete one.
//
// `closeHistory` is not optional in practice, only in signature: relaunchApp()
// uses app.exit(0), which does NOT emit 'before-quit', so the teardown that
// closes the store never runs on this path. The store has to be closed here or
// the removal below hits an open handle — EBUSY on Windows — and the app
// relaunches on a database it just told the user was deleted.
export function deleteAllData(closeHistory?: () => void): BackupResult {
  const failed: string[] = []
  const step = (what: string, run: () => void): void => {
    try {
      run()
    } catch (err) {
      failed.push(`${what} (${err instanceof Error ? err.message : String(err)})`)
    }
  }

  // Logged, never added to `failed`, so `ok: false` keeps meaning "something is
  // still on disk". It is not a path, and the renderer's wording names the
  // failures as things that are "still there"; worse, a close that throws made
  // `ok: false` permanent — the relaunch is skipped, every path is already gone,
  // and "Try again" re-runs with `force: true` turning each removal into a
  // no-op, so only this step fails again and the user can never reach the
  // success toast or the restart. Its failure is also redundant here: it matters
  // only because the unlink below then hits the open handle, and that step
  // reports itself.
  try {
    closeHistory?.()
  } catch (err) {
    console.error('[backup] could not close the history store before deleting it:', err)
  }
  // `recursive` so a directory goes, `force` so an absent path is not a failure
  // — which most of these are on most machines, and why no existsSync is needed.
  for (const name of [...ALL_DATA_FILES, ...ALL_DATA_DIRS]) {
    step(name, () => rmSync(userFile(name), { recursive: true, force: true }))
  }
  // The database holds every hostname, kernel version, systemd unit and
  // listening port in the estate, for ninety days. history.ts chmods it 0600
  // because it is sensitive; a "delete all data" that leaves it behind and
  // then goes on appending to it is that same judgement made backwards.
  step('the history database', () => removeHistoryFiles(app.getPath('userData')))

  if (failed.length > 0) {
    return { ok: false, error: `Some of it could not be deleted: ${failed.join('; ')}` }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Destinations: where a bundle goes, on a schedule, and how we know it landed
// ---------------------------------------------------------------------------


const EMPTY_TARGETS: BackupTargetsFile = {
  version: 1,
  destinations: [],
  lastRunAt: {},
  lastReport: {}
}

/**
 * The destinations, and whether the file that holds them could be read.
 *
 * `readJson` treats an unreadable file as absent, which is right for the
 * backup payload — a missing known_hosts should not fail an export. It is
 * wrong here, and dangerously so: a corrupt file would read as "no
 * destinations", every scheduled backup would silently stop, and the next save
 * would write an empty list over the configuration. That is the same failure
 * this feature exists to prevent, one layer down.
 *
 * So this reads the file itself and reports which of the three states it is
 * in: absent, readable, or there-but-unreadable.
 */
export function readTargets(): BackupTargetsFile {
  const p = userFile(TARGETS_FILE)
  if (!existsSync(p)) return { ...EMPTY_TARGETS }
  let raw: Partial<BackupTargetsFile> | null = null
  try {
    raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<BackupTargetsFile>
  } catch (err) {
    return {
      ...EMPTY_TARGETS,
      corrupt: `${TARGETS_FILE} could not be read (${err instanceof Error ? err.message : String(err)}), so no destination is configured and nothing is being backed up on a schedule.`
    }
  }
  if (!raw || !Array.isArray(raw.destinations)) {
    return {
      ...EMPTY_TARGETS,
      corrupt: `${TARGETS_FILE} does not hold a list of destinations, so nothing is being backed up on a schedule.`
    }
  }
  return {
    version: 1,
    destinations: raw.destinations,
    lastRunAt: raw.lastRunAt ?? {},
    lastReport: raw.lastReport ?? {}
  }
}

export function writeTargets(file: BackupTargetsFile): void {
  writeJson(TARGETS_FILE, file)
}

/** Replace the configured destinations, keeping the run history of the ones
 *  that survived and dropping the history of the ones that did not. */
export function saveDestinations(destinations: BackupDestination[]): BackupTargetsFile {
  const current = readTargets()
  // A file we could not parse still held somebody's configuration. Move it
  // aside rather than write over it: the destinations in it are recoverable by
  // hand, and they are not recoverable once this function has replaced them
  // with whatever the panel was showing after it read nothing.
  if (current.corrupt) {
    const p = userFile(TARGETS_FILE)
    try {
      renameSync(p, `${p}.corrupt-${Date.now()}`)
    } catch {
      /* if it cannot be moved it cannot be overwritten either */
    }
  }
  const live = new Set(destinations.map((d) => d.id))
  const prune = <T>(m: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(m).filter(([id]) => live.has(id)))
  const next: BackupTargetsFile = {
    version: 1,
    destinations,
    lastRunAt: prune(current.lastRunAt),
    lastReport: prune(current.lastReport)
  }
  writeTargets(next)
  return next
}

/**
 * Remember a run, whether it worked or not.
 *
 * Both outcomes, deliberately. A panel that only records successes shows a
 * destination that has been failing for a month as "last backed up three weeks
 * ago" — the reassuring half of the truth, which is the half that stops
 * somebody looking.
 */
export function recordRun(destinationId: string, report: BackupRunReport, at = Date.now()): void {
  const current = readTargets()
  writeTargets({
    ...current,
    lastRunAt: { ...current.lastRunAt, [destinationId]: at },
    lastReport: { ...current.lastReport, [destinationId]: report }
  })
}

/**
 * Decrypt a bundle and look inside it.
 *
 * This is the restore test, and it is the reason this feature is not cron plus
 * rsync. Reading bytes back off a destination proves the bytes are there; it
 * does not prove they are a backup. A file can round-trip perfectly and still
 * be an envelope whose ciphertext was corrupted before it was ever written, or
 * one written under a different passphrase, or a zero-byte file that a
 * filesystem is perfectly happy to hand back.
 *
 * So this decrypts with the real passphrase, authenticates the GCM tag, parses
 * the payload and checks the payload has the shape of a backup. Anything less
 * would be a check that passes on rubbish.
 */
export async function verifyBundle(bytes: Buffer, password: string): Promise<BackupVerification> {
  try {
    const payload = await decryptBundle(bytes, password)
    if (payload.version !== 1) {
      return { ok: false, error: `Decrypted, but the bundle says version ${String(payload.version)}.`, bytes: 0 }
    }
    // `secrets` is the field a restore re-seals into the keychain. A bundle
    // whose secrets are not an object would import as nothing, and finding
    // that out during a real restore is finding it out too late.
    if (typeof payload.secrets !== 'object' || payload.secrets === null || Array.isArray(payload.secrets)) {
      return { ok: false, error: 'Decrypted, but the bundle has no credential map.', bytes: 0 }
    }
    if (typeof payload.createdAt !== 'string' || !payload.createdAt) {
      return { ok: false, error: 'Decrypted, but the bundle has no creation time.', bytes: 0 }
    }
    return { ok: true, summary: summarise(payload), bytes: bytes.length }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      bytes: 0,
      error: message.includes('OpsMaxx backup')
        ? message
        : `The bundle at the destination did not decrypt — ${message}`
    }
  }
}

function fail(report: BackupRunReport, stage: BackupStage, err: unknown): BackupRunReport {
  return {
    ...report,
    ok: false,
    failedStage: stage,
    error: err instanceof Error ? err.message : String(err),
    finishedAt: new Date().toISOString()
  }
}

export interface RunOptions extends TargetDeps {
  /** Fixed clock, so a test can assert the object name as a literal. */
  now?: () => Date
  /**
   * Where the bytes come from. Defaults to `buildBundle`.
   *
   * A seam, and a narrow one: the restore test only ever fires on a bundle
   * that survived the checksum, which by construction a healthy build cannot
   * produce. Without a way to hand the run a bundle that is already broken,
   * the branch that catches a corrupt archive would be the one branch in this
   * file no test ever executed — which is exactly the branch a backup feature
   * cannot afford to have never run.
   */
  bundle?: (password: string) => Promise<{ bytes: Buffer; summary: BackupSummary }>
  /** Skip the decrypt-and-inspect pass even when the destination asks for it.
   *  Only the manual "write one now" path passes this, and only when the user
   *  turned it off. */
  restoreTest?: boolean
}

/**
 * Write one generation to one destination, and report only what was proved.
 *
 * The order is: build, write, read back and compare, decrypt and inspect,
 * then retention. Every one of those is a stage that can fail the run, and
 * retention is LAST on purpose — deleting an old generation before the new one
 * has been read back and opened is deleting a backup that works in favour of
 * one that might not be there.
 */
export async function runBackupToDestination(
  dest: BackupDestination,
  password: string,
  opts: RunOptions = {}
): Promise<BackupRunReport> {
  const now = opts.now ?? ((): Date => new Date())
  const startedAt = now().toISOString()
  const base: BackupRunReport = {
    ok: false,
    destinationId: dest.id,
    destinationName: dest.name,
    destinationKind: dest.kind,
    startedAt,
    finishedAt: startedAt,
    verified: false,
    restoreTested: false,
    removed: []
  }

  if (password.length < MIN_PASSPHRASE) {
    return fail(base, 'bundle', new Error('Backup passphrase must be at least 8 characters.'))
  }

  let bundle: { bytes: Buffer; summary: BackupSummary }
  try {
    bundle = await (opts.bundle ?? buildBundle)(password)
  } catch (err) {
    return fail(base, 'bundle', err)
  }

  const name = backupObjectName(now())
  const digest = sha256(bundle.bytes)
  let report: BackupRunReport = { ...base, name, bytes: bundle.bytes.length, digest }

  let target: BackupTarget
  try {
    target = await openTarget(dest, opts)
  } catch (err) {
    return fail(report, 'write', err)
  }

  try {
    try {
      await target.put(name, bundle.bytes)
    } catch (err) {
      // A put that threw may still have left something under the name — an
      // SFTP rename that succeeded and then a connection that dropped, say.
      // Reporting "failed" while leaving a file the next list() counts as a
      // generation is the partial-success this whole feature exists to refuse.
      await discard(target, name)
      return fail(report, 'write', err)
    }

    let readBack: Buffer
    try {
      readBack = await target.get(name)
    } catch (err) {
      await discard(target, name)
      return fail(
        report,
        'verify',
        new Error(
          `Wrote ${name}, but could not read it back: ${err instanceof Error ? err.message : String(err)}. A destination that cannot be read is not a backup, so it has been removed.`
        )
      )
    }

    const readBackDigest = sha256(readBack)
    report = { ...report, readBackDigest }
    if (readBackDigest !== digest) {
      await discard(target, name)
      return fail(
        report,
        'verify',
        new Error(
          `${name} came back as ${readBack.length} bytes, not the ${bundle.bytes.length} written (checksum ${readBackDigest.slice(0, 12)} against ${digest.slice(0, 12)}). It has been removed rather than left looking like a backup.`
        )
      )
    }
    report = { ...report, verified: true }

    const wantsTest = opts.restoreTest ?? dest.restoreTest
    if (wantsTest) {
      const verification = await verifyBundle(readBack, password)
      report = { ...report, restoreTest: verification, restoreTested: verification.ok }
      if (!verification.ok) {
        await discard(target, name)
        return fail(report, 'restore-test', new Error(`${verification.error} It has been removed.`))
      }
    }

    // Retention runs against what the destination actually holds now, not
    // against a count we kept: another machine may be writing here too, and a
    // deletion decided from a stale list deletes the wrong file.
    let generations: BackupGeneration[]
    try {
      generations = await target.list()
    } catch (err) {
      return fail(report, 'retention', err)
    }
    const plan = planRetention(withNameTimes(generations), dest.keep)
    const removed: string[] = []
    for (const g of plan.remove) {
      try {
        await target.remove(g.name)
        removed.push(g.name)
      } catch (err) {
        return fail({ ...report, removed }, 'retention', err)
      }
    }

    return {
      ...report,
      ok: true,
      removed,
      retentionRefused: plan.refused,
      finishedAt: new Date().toISOString()
    }
  } finally {
    await target.close().catch(() => undefined)
  }
}

/** Remove an object we have just decided is not a backup. Best effort, and
 *  deliberately silent: the caller is already reporting a failure, and a
 *  second one about the cleanup would bury it. */
async function discard(target: BackupTarget, name: string): Promise<void> {
  try {
    await target.remove(name)
  } catch {
    /* the destination keeps a file nothing will ever list as a generation */
  }
}

/** Prefer the timestamp in the name over the destination's own clock. An S3
 *  LastModified is when the bucket accepted the PUT and an SFTP mtime is the
 *  remote clock; the name is ours. */
export function withNameTimes(generations: BackupGeneration[]): BackupGeneration[] {
  return generations.map((g) => {
    const encoded = backupObjectTime(g.name)
    return encoded === null ? g : { ...g, modified: encoded }
  })
}

// ---------------------------------------------------------------------------
// Restore from a destination
// ---------------------------------------------------------------------------

/** What is actually at a destination right now, newest first. Only our own
 *  names: someone else's files in that directory are not offered as things to
 *  restore from. */
export async function listRemoteBackups(
  dest: BackupDestination,
  deps: TargetDeps = {}
): Promise<RemoteListResult> {
  let target: BackupTarget
  try {
    target = await openTarget(dest, deps)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  try {
    const all = withNameTimes(await target.list())
    const ours = all
      .filter((g) => backupObjectTime(g.name) !== null)
      .sort((a, b) => b.modified - a.modified)
    return { ok: true, generations: ours }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    await target.close().catch(() => undefined)
  }
}

/** Where a downloaded generation is staged before it is inspected. Inside
 *  userData rather than the OS temp directory: this file is the vault, and a
 *  world-readable /tmp is where it should least be. */
function stagingPath(name: string): string {
  return userFile(`staged-${name.replace(/[^A-Za-z0-9._-]/g, '_')}`)
}

/**
 * Download one generation and report what is inside it, changing nothing.
 *
 * The inspect-before-import discipline is the same one the local path already
 * has, and it matters MORE from a remote: the file came off a machine this one
 * does not control, so "what does it say it is" has to be answered before
 * anything is replaced. The download is staged to disk so `backupImport` runs
 * on exactly the bytes that were inspected — not on a second download that
 * could differ.
 */
export async function inspectRemoteBackup(
  dest: BackupDestination,
  name: string,
  password: string,
  deps: TargetDeps = {}
): Promise<BackupResult> {
  if (backupObjectTime(name) === null) {
    return { ok: false, error: `“${name}” is not a OpsMaxx backup name.` }
  }
  let target: BackupTarget
  try {
    target = await openTarget(dest, deps)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  try {
    const bytes = await target.get(name)
    const verification = await verifyBundle(bytes, password)
    if (!verification.ok || !verification.summary) {
      return { ok: false, error: verification.error ?? 'The bundle did not open.' }
    }
    const staged = stagingPath(name)
    writeFileSync(staged, bytes, { mode: 0o600 })
    return { ok: true, path: staged, summary: verification.summary }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    await target.close().catch(() => undefined)
  }
}

/** Delete a staged download. Called when the user cancels rather than
 *  restores, so a copy of the vault is not left lying in userData. */
export function discardStagedBackup(path: string): void {
  try {
    if (path.startsWith(join(app.getPath('userData'), 'staged-')) && existsSync(path)) unlinkSync(path)
  } catch {
    /* a file we could not remove is reported nowhere useful; it is inert */
  }
}

// ---------------------------------------------------------------------------
// Database dumps as a source
// ---------------------------------------------------------------------------

/**
 * The largest dump this will hold.
 *
 * A dump is verified the same way a bundle is — read back off the destination
 * and compared — which means both copies are in memory at once. Rather than
 * discover that at 4 GB by dying, this refuses at a stated limit and says so.
 * Raising it is a decision about memory, and it should look like one.
 */
export const MAX_DUMP_BYTES = 512 * 1024 * 1024

export interface SpawnedDump {
  /** Everything the dump wrote to stdout. */
  stdout: Buffer
  /** The tail of stderr, for a message worth reading. */
  stderr: string
  code: number | null
  signal: string | null
}

export type DumpSpawner = (cmd: DumpCommand) => Promise<SpawnedDump>

/** The default spawner: run the dump binary on this machine. Separated so a
 *  test drives the real streaming, size-limit and verification logic without
 *  needing pg_dump installed. */
export const spawnDump: DumpSpawner = (cmd) =>
  new Promise((resolve, reject) => {
    // mongodump has no password environment variable, so its credential goes in
    // a config file it is pointed at. Written 0600 in a private directory and
    // removed in `finally` below, whatever happens -- including a throw, which
    // is the path that would otherwise leave a password on disk.
    let configDir: string | null = null
    const args = [...cmd.args]
    if (cmd.configFile) {
      configDir = mkdtempSync(join(tmpdir(), 'opsmaxx-dump-'))
      const file = join(configDir, 'config.yaml')
      writeFileSync(file, cmd.configFile.contents, { mode: 0o600 })
      args.push('--config', file)
    }
    const cleanup = (): void => {
      if (configDir === null) return
      try {
        rmSync(configDir, { recursive: true, force: true })
      } catch {
        /* the dump matters more than the tidy-up, and the file is 0600 */
      }
      configDir = null
    }
    const child = spawn(cmd.binary, args, {
      env: { ...process.env, ...cmd.env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    // ON EXIT, NOT ON SPAWN. The first version deleted it as soon as the
    // process existed, and a test caught that immediately: `spawn` fires when
    // the child has been created, which is BEFORE it has run, let alone read
    // anything -- so the config was gone by the time the command looked for it
    // and the run failed outright.
    //
    // So the password is on disk for the length of the dump. That is the real
    // trade and it is worth stating plainly: a 0600 file readable by this user
    // and root, for as long as a dump takes, against an argv readable by every
    // user on the machine for the same period. Better, not free.
    child.once('error', cleanup)
    child.once('close', cleanup)
    const out: Buffer[] = []
    let size = 0
    let err = ''
    let overflowed = false
    child.stdout.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_DUMP_BYTES) {
        if (!overflowed) {
          overflowed = true
          child.kill('SIGTERM')
        }
        return
      }
      out.push(c)
    })
    child.stderr.on('data', (c: Buffer) => {
      err = (err + c.toString('utf8')).slice(-4000)
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (overflowed) {
        reject(
          new Error(
            `The dump passed ${Math.round(MAX_DUMP_BYTES / (1024 * 1024))} MB, which is the most this can hold in memory while checking what it wrote. Nothing was uploaded.`
          )
        )
        return
      }
      resolve({ stdout: Buffer.concat(out), stderr: err.trim(), code, signal })
    })
  })

/**
 * Run pg_dump/mysqldump and put the result at a destination, verified.
 *
 * The dump is NOT encrypted by this — it is plaintext SQL, it is named .sql,
 * and it is not a `.spbackup`, so retention never counts it as a generation of
 * one. That is stated rather than assumed: a caller that thought this produced
 * an encrypted bundle would be putting a database in a bucket in the clear.
 */
export async function dumpToDestination(
  dest: BackupDestination,
  target: DumpTarget,
  password: string,
  opts: RunOptions & { spawn?: DumpSpawner } = {}
): Promise<DumpRunReport> {
  const now = opts.now ?? ((): Date => new Date())
  const startedAt = now().toISOString()
  const base: DumpRunReport = {
    ok: false,
    destinationId: dest.id,
    destinationName: dest.name,
    verified: false,
    startedAt,
    finishedAt: startedAt
  }
  const stop = (stage: BackupStage, err: unknown): DumpRunReport => ({
    ...base,
    failedStage: stage,
    error: err instanceof Error ? err.message : String(err),
    finishedAt: new Date().toISOString()
  })

  let dumped: SpawnedDump
  try {
    dumped = await (opts.spawn ?? spawnDump)(dumpCommand(target, password))
  } catch (err) {
    return stop('bundle', err)
  }
  if (dumped.code !== 0) {
    return stop(
      'bundle',
      new Error(
        `${DUMP_BINARY[target.engine]} exited ${dumped.signal ? `on ${dumped.signal}` : String(dumped.code)}${dumped.stderr ? `: ${dumped.stderr.split('\n').slice(-3).join(' ')}` : ''}`
      )
    )
  }
  // A dump binary that exits 0 having written nothing is the failure this
  // codebase already shipped once, in another shape: a zero-length file that a
  // reader accepts as valid and empty. An empty dump is never a correct dump.
  if (dumped.stdout.length === 0) {
    return stop('bundle', new Error(`${DUMP_BINARY[target.engine]} exited cleanly but produced no output.`))
  }

  const name = dumpObjectName(target, now())
  const digest = sha256(dumped.stdout)
  let driver: BackupTarget
  try {
    driver = await openTarget(dest, opts)
  } catch (err) {
    return stop('write', err)
  }
  try {
    try {
      await driver.put(name, dumped.stdout)
    } catch (err) {
      await discard(driver, name)
      return { ...stop('write', err), name, bytes: dumped.stdout.length, digest }
    }
    const readBack = await driver.get(name).catch((err: unknown) => err as Error)
    if (readBack instanceof Error || !Buffer.isBuffer(readBack)) {
      await discard(driver, name)
      return {
        ...stop('verify', new Error(`Wrote ${name} but could not read it back: ${String(readBack)}`)),
        name,
        bytes: dumped.stdout.length,
        digest
      }
    }
    if (sha256(readBack) !== digest) {
      await discard(driver, name)
      return {
        ...stop(
          'verify',
          new Error(
            `${name} came back as ${readBack.length} bytes, not the ${dumped.stdout.length} written. It has been removed.`
          )
        ),
        name,
        bytes: dumped.stdout.length,
        digest
      }
    }
    return {
      ...base,
      ok: true,
      name,
      bytes: dumped.stdout.length,
      digest,
      verified: true,
      finishedAt: new Date().toISOString()
    }
  } finally {
    await driver.close().catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/**
 * The passphrase a scheduled run encrypts with, out of the vault.
 *
 * Every failure here is a REASON, not a false. A scheduled backup that stops
 * happening and says nothing is the exact failure mode this whole item is
 * written against — the operator stops thinking about it, and finds out when
 * they need the file.
 */
export function scheduledPassphrase(dest: BackupDestination): { password?: string; skipped?: string } {
  if (!dest.passphraseVaultEntryId) {
    return { skipped: 'No vault entry is set to hold the passphrase for unattended runs.' }
  }
  const status = vaultStatus()
  if (!status.exists) return { skipped: 'The passphrase lives in the vault, and there is no vault on this machine.' }
  if (!status.unlocked) return { skipped: 'The passphrase lives in the vault, and the vault is locked.' }
  const entry = vaultList().entries?.find((e) => e.id === dest.passphraseVaultEntryId)
  if (!entry) return { skipped: 'The vault entry holding the passphrase no longer exists.' }
  if (!entry.password) return { skipped: `Vault entry “${entry.name}” has no secret to use as a passphrase.` }
  if (entry.password.length < MIN_PASSPHRASE) {
    return { skipped: `Vault entry “${entry.name}” holds a passphrase shorter than ${MIN_PASSPHRASE} characters.` }
  }
  return { password: entry.password }
}

export interface TickResult {
  ran: BackupRunReport[]
  /** Destination id -> why it did not run. Never empty-and-silent. */
  skipped: Record<string, string>
  /**
   * Runs that failed where the previous one had not.
   *
   * The transition, not the state. A destination that has been broken for a
   * week should say so once and then be visible in the panel — an hourly
   * notification about the same failure is noise, and noise is exactly how a
   * failing backup becomes one nobody reads.
   */
  newlyFailing: BackupRunReport[]
}

/**
 * One pass of the schedule.
 *
 * Exported and pure of timers so it can be driven directly by a test with a
 * fixed `now` — the alternative is a test that sleeps, which is a test that
 * gets flakier as the machine gets busier.
 */
export async function backupTick(now = Date.now(), opts: RunOptions = {}): Promise<TickResult> {
  const file = readTargets()
  const due = dueDestinations(file.destinations, file.lastRunAt, now)
  const result: TickResult = { ran: [], skipped: {}, newlyFailing: [] }
  for (const dest of due) {
    const { password, skipped } = scheduledPassphrase(dest)
    if (!password) {
      result.skipped[dest.id] = skipped ?? 'No passphrase available.'
      // NOT marked as attempted: a locked vault is a condition that clears on
      // its own, and pushing the next attempt a full period into the future
      // because the user happened to be locked at the tick would turn an
      // hourly backup into a daily one.
      continue
    }
    const wasFailing = readTargets().lastReport[dest.id]?.ok === false
    const report = await runBackupToDestination(dest, password, opts)
    result.ran.push(report)
    if (!report.ok && !wasFailing) result.newlyFailing.push(report)
    recordRun(dest.id, report, now)
  }
  return result
}

let scheduleTimer: ReturnType<typeof setInterval> | null = null

/** How often the schedule is examined. Not how often a backup runs — that is
 *  each destination's `everyHours`. A five-minute tick means a destination set
 *  to six hours runs within five minutes of being due. */
export const TICK_MS = 5 * 60 * 1000

export interface ScheduleHandlers {
  /** Every run, for the log. */
  onRun?: (line: string) => void
  /** A destination that has just started failing, for something the user will
   *  actually see. Only the transition — see TickResult.newlyFailing. */
  onNewFailure?: (report: BackupRunReport) => void
}

export function startBackupSchedule(handlers: ScheduleHandlers = {}): void {
  if (scheduleTimer) return
  scheduleTimer = setInterval(() => {
    void backupTick()
      .then(({ ran, newlyFailing }) => {
        for (const r of ran) handlers.onRun?.(describeRun(r))
        for (const r of newlyFailing) handlers.onNewFailure?.(r)
      })
      .catch((err: unknown) => {
        console.error('[backup] scheduled run failed:', err)
      })
  }, TICK_MS)
  // Never hold the process open for a backup that is not due.
  scheduleTimer.unref?.()
}

export function stopBackupSchedule(): void {
  if (scheduleTimer) clearInterval(scheduleTimer)
  scheduleTimer = null
}
