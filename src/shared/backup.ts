// Contents of a backup bundle, before encryption.
export interface BackupPayload {
  version: 1
  createdAt: string
  app: string // OpsMaxx version that wrote the bundle
  // Non-secret application state (workspaces, folders, servers, databases…).
  data: unknown | null
  // Credentials, unsealed from the OS keychain. Only ever exists inside the
  // encrypted envelope or in memory.
  secrets: Record<string, string>
  // Already password-encrypted by the vault itself; carried verbatim.
  vault: unknown | null
  // Per-workspace password verifiers.
  workspaceLocks: unknown | null
  // Trusted SSH host keys.
  knownHosts: unknown | null
}

export interface BackupSummary {
  createdAt: string
  app: string
  servers: number
  databases: number
  workspaces: number
  secrets: number
  hasVault: boolean
}

export interface BackupResult {
  ok: boolean
  error?: string
  // Set when the user completes a save/open dialog.
  path?: string
  cancelled?: boolean
  summary?: BackupSummary
}

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

export const BACKUP_DESTINATION_KINDS = ['local', 'sftp', 's3'] as const
export type BackupDestinationKind = (typeof BACKUP_DESTINATION_KINDS)[number]

interface BackupDestinationBase {
  id: string
  /** What the user called it. Shown in the list; never parsed. */
  name: string
  /**
   * Keep this many generations here, oldest deleted first.
   *
   * 0 means "keep everything", which is the default, because a retention
   * setting nobody chose should never be the reason a backup disappeared.
   */
  keep: number
  /**
   * Run automatically this often. 0 means manual only.
   *
   * Hours rather than a cron expression on purpose: src/shared/cron.ts reads
   * crontabs off other people's machines and says in its own header that it
   * will not write one until the parser has been proven against real files.
   * A backup that runs every N hours needs none of that vocabulary.
   */
  everyHours: number
  /**
   * Decrypt and structurally check every bundle after writing it.
   *
   * On by default. This is the difference between this feature and cron plus
   * rsync, so it is opt-OUT, and the only reason to turn it off is a
   * destination whose egress is metered.
   */
  restoreTest: boolean
  /**
   * Vault entry whose secret is the passphrase a scheduled run encrypts with.
   *
   * Required for `everyHours > 0` and meaningless without it: an unattended
   * run has nobody to type a passphrase. It is a vault reference for the same
   * reason the S3 secret is — the settings blob is inside the bundle, so a
   * passphrase kept there would be shipped inside the file it protects, which
   * is the same as shipping no passphrase at all.
   *
   * The consequence is that scheduled runs only happen while the vault is
   * unlocked. That is stated, and a skipped run says so; it is not a silent
   * no-op.
   */
  passphraseVaultEntryId?: string
}

export interface LocalBackupDestination extends BackupDestinationBase {
  kind: 'local'
  /** Absolute path on the machine running OpsMaxx. */
  directory: string
}

export interface SftpBackupDestination extends BackupDestinationBase {
  kind: 'sftp'
  /** A server already configured in OpsMaxx. Its credentials are resolved
   *  through credentialResolver, exactly as the terminal and file browser do —
   *  this destination stores no credential of its own. */
  serverId: string
  /** Absolute remote directory. Must already exist. */
  directory: string
}

export interface S3BackupDestination extends BackupDestinationBase {
  kind: 's3'
  /** Full origin, e.g. https://s3.eu-west-1.amazonaws.com or
   *  http://127.0.0.1:9000 for MinIO. */
  endpoint: string
  region: string
  bucket: string
  /** Key prefix inside the bucket; '' for the bucket root. */
  prefix: string
  /**
   * Vault entry holding the credentials: `username` is the access key id and
   * `password` is the secret access key.
   *
   * A vault reference and not the key itself. The secret access key cannot
   * live in the application settings blob, because that blob is inside every
   * bundle this destination receives — storing it there would put the key to
   * the bucket inside every backup sitting in the bucket.
   */
  vaultEntryId: string
  /**
   * Address objects as `<endpoint>/<bucket>/<key>` rather than
   * `<bucket>.<endpoint>/<key>`. MinIO, Ceph and most S3-compatible stores
   * need this; AWS accepts it.
   */
  pathStyle: boolean
}

export type BackupDestination =
  | LocalBackupDestination
  | SftpBackupDestination
  | S3BackupDestination

export const BACKUP_DESTINATION_LABEL: Record<BackupDestinationKind, string> = {
  local: 'Local directory',
  sftp: 'SFTP server',
  s3: 'S3-compatible storage'
}

/**
 * What putting a backup here actually means, said where the destination is
 * chosen.
 *
 * A bundle contains the vault, every stored credential and every trusted host
 * key. Where it lands is therefore a security decision, and the roadmap says
 * the UI must make that obvious rather than bury it in a settings footnote —
 * so this text lives beside the destination form, not in documentation.
 */
export const BACKUP_DESTINATION_EXPOSURE: Record<BackupDestinationKind, string> = {
  local:
    'Every credential in this app, your vault and your trusted host keys will be written to this directory as an encrypted file. Anyone who can read the directory and guess the passphrase has all of it. A synced folder (Dropbox, OneDrive, iCloud) copies it onward.',
  sftp: 'Every credential in this app, your vault and your trusted host keys will be uploaded to this server as an encrypted file. Anyone with an account there that can read the directory holds your secrets, offline, for as long as the file exists.',
  s3: 'Every credential in this app, your vault and your trusted host keys will be uploaded to this bucket as an encrypted file. A bucket that is public, or whose keys leak, hands over the whole file — the passphrase is then the only thing left between someone and your estate.'
}

/**
 * Why this S3 key prefix cannot be used, in the words the panel shows. Null
 * when it is fine.
 *
 * Both refusals were found by pointing the driver at a real MinIO, and both
 * are refused here rather than at the far end because of what the far end says
 * when it refuses them:
 *
 *  - An empty segment (`a//b`) makes a key an object store will not accept.
 *    MinIO answers `400 XMinioInvalidObjectName`, which at least names the
 *    key — but nothing in this app was going to tell the operator that the
 *    two slashes they typed were the reason.
 *  - A `.` or `..` segment is worse, because the signature is computed over
 *    the path this module builds and the URL parser then rewrites that path
 *    before it goes on the wire. `a/./b` is signed and sent as two different
 *    strings, so the store answers `403 SignatureDoesNotMatch` — which reads
 *    as "your access key is wrong", sends the operator to rotate a credential
 *    that was never the problem, and leaves the destination broken.
 */
export function s3PrefixProblem(prefix: string): string | null {
  const trimmed = prefix.replace(/^\/+|\/+$/g, '')
  if (!trimmed) return null
  for (const segment of trimmed.split('/')) {
    if (segment === '') {
      return `The key prefix “${prefix}” has an empty path segment. Object stores reject a key with “//” in it, so nothing would ever be written here.`
    }
    if (segment === '.' || segment === '..') {
      return `The key prefix “${prefix}” has a “${segment}” path segment. The request is signed over the path before the URL is parsed, and the parser removes that segment afterwards — so the store would answer SignatureDoesNotMatch and it would look like the access key was wrong.`
    }
  }
  return null
}

/** Roots the object name so a destination directory holding other things is
 *  never a retention candidate. */
export const BACKUP_OBJECT_PREFIX = 'opsmaxx-'
export const BACKUP_OBJECT_SUFFIX = '.spbackup'

/**
 * The name a generation is written under.
 *
 * The timestamp is in the name and not only in the file metadata, because the
 * two destinations that are not a filesystem report modification times that
 * are theirs, not ours: an S3 object's LastModified is when the bucket
 * accepted the PUT, and an SFTP mtime is whatever the remote clock said. The
 * name is the one ordering key we control, and retention orders by it.
 */
export function backupObjectName(when: Date): string {
  const iso = when.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  return `${BACKUP_OBJECT_PREFIX}${iso}${BACKUP_OBJECT_SUFFIX}`
}

const NAME_RE = /^opsmaxx-(\d{8})T(\d{6})Z\.spbackup$/

export function isBackupObjectName(name: string): boolean {
  return NAME_RE.test(name)
}

/** Milliseconds encoded in the name, or null if this is not one of ours. */
export function backupObjectTime(name: string): number | null {
  const m = NAME_RE.exec(name)
  if (!m) return null
  const [, d, t] = m
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}

/** One bundle sitting at a destination. */
export interface BackupGeneration {
  name: string
  size: number
  /** Milliseconds. From the name where we can read one, so it is our clock. */
  modified: number
}

export interface RetentionPlan {
  keep: BackupGeneration[]
  remove: BackupGeneration[]
  /** Present when a plan deliberately removed nothing it otherwise would. */
  refused?: string
}

/**
 * Which generations to delete, given a limit.
 *
 * Three refusals, each of which is a way a retention policy eats the only copy
 * someone has:
 *
 *  - `keep` of 0 or less removes nothing. An unset limit is not "keep none".
 *  - A destination holding one generation removes nothing, whatever the limit
 *    says. There is no arrangement of settings under which deleting the last
 *    backup is the helpful thing to do.
 *  - Files that are not ours are never candidates. A destination directory is
 *    somebody's directory.
 */
export function planRetention(
  generations: BackupGeneration[],
  keep: number
): RetentionPlan {
  const ours = generations.filter((g) => isBackupObjectName(g.name))
  const sorted = [...ours].sort((a, b) => b.modified - a.modified || b.name.localeCompare(a.name))
  if (!Number.isFinite(keep) || keep <= 0) {
    return { keep: sorted, remove: [], refused: 'No limit is set, so nothing is deleted.' }
  }
  if (sorted.length <= 1) {
    return {
      keep: sorted,
      remove: [],
      refused: 'Only one backup is here, and the last one is never deleted.'
    }
  }
  const kept = sorted.slice(0, Math.max(1, keep))
  return { keep: kept, remove: sorted.slice(kept.length) }
}

// ---------------------------------------------------------------------------
// A run, and what it proved
// ---------------------------------------------------------------------------

/**
 * Where a run stopped. Reported rather than inferred, so "it failed" can
 * always be read as "it failed HERE" — a write that never started and a write
 * that landed and then failed to read back call for different actions.
 */
export type BackupStage = 'bundle' | 'write' | 'verify' | 'restore-test' | 'retention'

export const BACKUP_STAGE_LABEL: Record<BackupStage, string> = {
  bundle: 'building the bundle',
  write: 'writing to the destination',
  verify: 'reading the bundle back',
  'restore-test': 'test-restoring the bundle',
  retention: 'applying retention'
}

/** The result of decrypting a bundle and looking inside it. */
export interface BackupVerification {
  ok: boolean
  error?: string
  summary?: BackupSummary
  /** Bytes that were decrypted. 0 on failure. */
  bytes?: number
}

export interface BackupRunReport {
  ok: boolean
  destinationId: string
  destinationName: string
  destinationKind: BackupDestinationKind
  startedAt: string
  finishedAt: string
  /** The object that was written, when the write got that far. */
  name?: string
  bytes?: number
  /** sha256 of what we sent, and of what came back when we re-read it. Both
   *  present only once the verify stage has actually run. */
  digest?: string
  readBackDigest?: string
  /** True only when the bytes read back off the destination matched. */
  verified: boolean
  /** True only when those bytes decrypted and parsed as a bundle. */
  restoreTested: boolean
  restoreTest?: BackupVerification
  /** Names deleted by retention. Empty is the normal case. */
  removed: string[]
  retentionRefused?: string
  failedStage?: BackupStage
  error?: string
}

/**
 * One line for a log or a toast.
 *
 * Deliberately refuses to say "backed up" for anything that was not read back
 * off the destination: this repo has already shipped a recovery that reported
 * success over a zero-byte file, and the lesson was that the only success
 * worth reporting is one that was confirmed by reading.
 */
export function describeRun(r: BackupRunReport): string {
  if (!r.ok) {
    const stage = r.failedStage ? BACKUP_STAGE_LABEL[r.failedStage] : 'running the backup'
    return `${r.destinationName}: failed while ${stage} — ${r.error ?? 'no reason given'}`
  }
  const parts = [`${r.destinationName}: wrote ${r.name}`]
  parts.push(r.restoreTested ? 'read back and test-restored' : 'read back and matched')
  if (r.removed.length) parts.push(`removed ${r.removed.length} older`)
  return parts.join(', ')
}

/** Destinations due to run now, given when each last ATTEMPTED a run.
 *
 *  Attempted and not succeeded, deliberately: keying off the last success
 *  means a destination that is failing gets retried on every tick, which turns
 *  a broken SFTP server into a login attempt every minute. The failure is
 *  reported; it is not hammered. */
export function dueDestinations(
  destinations: BackupDestination[],
  lastRunAt: Record<string, number>,
  now: number
): BackupDestination[] {
  return destinations.filter((d) => {
    if (!Number.isFinite(d.everyHours) || d.everyHours <= 0) return false
    const last = lastRunAt[d.id]
    // Never run: due immediately. A schedule that waits a full period before
    // its first run leaves a window in which the user believes it is on and
    // nothing has been written.
    if (last === undefined) return true
    return now - last >= d.everyHours * 3600_000
  })
}

/** What stops a destination from being usable, in the words the panel shows.
 *  Null when it is fine. */
export function destinationProblem(d: BackupDestination): string | null {
  if (!d.name.trim()) return 'This destination has no name.'
  if (d.kind === 'local' && !d.directory.trim()) return 'Choose a directory to write backups into.'
  if (d.kind === 'sftp') {
    if (!d.serverId) return 'Choose which configured server to upload to.'
    if (!d.directory.trim()) return 'Set the remote directory to upload into.'
  }
  if (d.kind === 's3') {
    if (!d.endpoint.trim()) return 'Set the endpoint URL of the object store.'
    if (!d.bucket.trim()) return 'Set the bucket name.'
    if (!d.region.trim()) return 'Set the region the bucket lives in.'
    if (!d.vaultEntryId) {
      return 'Choose the vault entry holding the access key — the secret key cannot be stored in settings, because settings travel inside every backup written here.'
    }
    const prefixProblem = s3PrefixProblem(d.prefix)
    if (prefixProblem) return prefixProblem
  }
  if (d.everyHours > 0 && !d.passphraseVaultEntryId) {
    return 'A scheduled run has nobody to type a passphrase, so it needs a vault entry holding one.'
  }
  return null
}

/**
 * The destinations file, as it crosses the IPC boundary.
 *
 * Here rather than beside the code that reads it: the preload bridge has to
 * name this type, and a preload that imported it from src/main would drag the
 * whole main process into the renderer's type graph — which is a boundary, not
 * a formatting preference.
 */
export interface BackupTargetsFile {
  version: 1
  destinations: BackupDestination[]
  /** Destination id -> epoch ms of the last ATTEMPT. See dueDestinations. */
  lastRunAt: Record<string, number>
  /** Destination id -> the last run, success or failure, for the panel. */
  lastReport: Record<string, BackupRunReport>
  /**
   * Set when the file exists but could not be read.
   *
   * Distinct from "no destinations", and the distinction is the point: a
   * corrupt file that read as an empty list would stop every scheduled backup
   * without a word, and the next save would write that empty list over the
   * configuration.
   */
  corrupt?: string
}

export interface RemoteListResult {
  ok: boolean
  error?: string
  generations?: BackupGeneration[]
}

// ---------------------------------------------------------------------------
// Database dumps as a source
// ---------------------------------------------------------------------------

export const DUMP_ENGINES = ['postgres', 'mysql'] as const
export type DumpEngine = (typeof DUMP_ENGINES)[number]

export const DUMP_BINARY: Record<DumpEngine, string> = {
  postgres: 'pg_dump',
  mysql: 'mysqldump'
}

export interface DumpTarget {
  engine: DumpEngine
  host: string
  port: number
  username: string
  database: string
}

export interface DumpCommand {
  binary: string
  args: string[]
  /** Passed through the environment, never on the command line: an argv is
   *  world-readable in /proc and lands in shell history. */
  env: Record<string, string>
}

/**
 * The command that produces a dump on stdout.
 *
 * Pure, so the argv can be asserted as a literal. The password never appears
 * in it — `mysqldump --password=` would put the credential in every process
 * listing on the machine, and pg_dump has no password flag at all.
 */
export function dumpCommand(target: DumpTarget, password: string): DumpCommand {
  if (target.engine === 'postgres') {
    return {
      binary: 'pg_dump',
      args: [
        '--host', target.host,
        '--port', String(target.port),
        '--username', target.username,
        '--no-password',
        '--format', 'plain',
        target.database
      ],
      env: password ? { PGPASSWORD: password } : {}
    }
  }
  return {
    binary: 'mysqldump',
    args: [
      '--host', target.host,
      '--port', String(target.port),
      '--user', target.username,
      '--single-transaction',
      '--routines',
      '--events',
      target.database
    ],
    env: password ? { MYSQL_PWD: password } : {}
  }
}

/** What a dump run proved. Not a BackupRunReport: a dump has no retention and
 *  no restore test, because it is not an encrypted bundle and nothing here can
 *  open it to check. What it does have is the read-back — a dump that cannot be
 *  read off the destination is as useless as a bundle that cannot. */
export interface DumpRunReport {
  ok: boolean
  destinationId: string
  destinationName: string
  name?: string
  bytes?: number
  digest?: string
  verified: boolean
  error?: string
  failedStage?: BackupStage
  startedAt: string
  finishedAt: string
}

/** The object a dump is written under. Not `.spbackup`: a dump is plaintext
 *  SQL and is NOT one of our encrypted bundles, so retention must never see it
 *  as a generation of one. */
export function dumpObjectName(target: DumpTarget, when: Date): string {
  const iso = when.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const safe = safeDumpDatabase(target.database)
  return `${BACKUP_OBJECT_PREFIX}dump-${safe}-${iso}.sql`
}

/**
 * The safe form of a database name, as it appears inside a dump object.
 *
 * Exported because it is LOSSY and callers have to be able to see that: `my-db`
 * and `my_db` both become `my_db`, and two such databases dumping to one
 * destination share a retention group. See collidingDumpDatabases().
 */
export function safeDumpDatabase(database: string): string {
  return database.replace(/[^A-Za-z0-9_.-]/g, '_')
}

/** `opsmaxx-dump-<db>-<ISO>.sql`, parsed from the RIGHT: the database name
 *  may contain `-` and `.`, so only the timestamp's fixed shape makes the
 *  boundary unambiguous. */
const DUMP_NAME_RE = new RegExp(
  `^${BACKUP_OBJECT_PREFIX}dump-(.+)-(\\d{8}T\\d{6}Z)\\.sql$`
)

export function isDumpObjectName(name: string): boolean {
  return DUMP_NAME_RE.test(name)
}

/** The safe database name inside a dump object, or null when the object is not
 *  one of ours. Never the raw name -- that is not recoverable. */
export function dumpDatabaseOf(name: string): string | null {
  const m = DUMP_NAME_RE.exec(name)
  return m === null ? null : m[1]
}

/**
 * Databases whose names collide once sanitised.
 *
 * A caller that dumps two of these to one destination is a caller whose
 * retention will count them together and delete one database's dumps because
 * the other's are newer. Surfaced rather than worked around: renaming a
 * database is the operator's decision, and silently keeping more than asked
 * would be a retention setting that does not mean what it says.
 */
export function collidingDumpDatabases(databases: string[]): string[][] {
  const by = new Map<string, string[]>()
  for (const d of databases) {
    const k = safeDumpDatabase(d)
    by.set(k, [...(by.get(k) ?? []), d])
  }
  return [...by.values()].filter((g) => g.length > 1)
}

/**
 * Retention for dumps -- item 38's first gap.
 *
 * Dumps had none at all: `backupTick` iterates bundle destinations only, and
 * `isBackupObjectName` deliberately does not match a `.sql`, so a destination
 * accumulated one dump per run for ever.
 *
 * PER DATABASE, which is the difference from the bundle's. Bundles are one
 * series; a destination holds dumps of several databases interleaved, and a
 * global "keep 7" would keep seven objects rather than seven of each -- so a
 * busy database would evict a quiet one entirely.
 *
 * The same three refusals as planRetention, because they are the same three
 * mistakes.
 */
export function planDumpRetention(
  generations: BackupGeneration[],
  keep: number,
  database: string
): RetentionPlan {
  const safe = safeDumpDatabase(database)
  const ours = generations.filter((g) => dumpDatabaseOf(g.name) === safe)
  const sorted = [...ours].sort((a, b) => b.modified - a.modified || b.name.localeCompare(a.name))
  if (!Number.isFinite(keep) || keep <= 0) {
    return { keep: sorted, remove: [], refused: 'No limit is set, so no dump is deleted.' }
  }
  if (sorted.length <= 1) {
    return {
      keep: sorted,
      remove: [],
      refused: 'Only one dump of this database is here, and the last one is never deleted.'
    }
  }
  const kept = sorted.slice(0, Math.max(1, keep))
  return { keep: kept, remove: sorted.slice(kept.length) }
}

// ---------------------------------------------------------------------------
// Is there actually a backup?
// ---------------------------------------------------------------------------
//
// The roadmap parked this behind item 5 — "there is no backup that could fail"
// — and item 5 shipped, so here it is.
//
// THE TRAP IS `lastRunAt`, and it is documented thirty lines above: it records
// an ATTEMPT, not a success, deliberately, so a broken SFTP server is not
// retried every minute. Which means an "is it overdue" check written against
// it reports a healthy schedule while every single run fails. The question an
// operator is actually asking is "do I have a backup", and the only field that
// answers it is the last SUCCESSFUL report.
//
// The second trap is quieter: a run can succeed and not be verified. `verified`
// is true only when the bytes were read back off the destination and matched,
// and a write nobody read back is a backup nobody has evidence of. That is not
// an alarm — the file is probably there — but it is not silence either.

export type BackupAlarmReason = 'failed' | 'never' | 'overdue' | 'unverified'

export interface BackupAlarm {
  destinationId: string
  destinationName: string
  reason: BackupAlarmReason
  level: 'watch' | 'alarm'
  /** What to say, in the words the panel and the webhook both use. */
  detail: string
}

/**
 * How late a backup may be before it is worth interrupting somebody.
 *
 * TWO periods, not one. OpsMaxx only backs up while it is running, so a
 * daily schedule on a laptop that was shut overnight is routinely a few hours
 * late and that is not a fault. Two missed periods is not lateness, it is a
 * schedule that has stopped.
 */
export const BACKUP_OVERDUE_PERIODS = 2

export function assessBackups(
  destinations: BackupDestination[],
  lastReport: Record<string, BackupRunReport>,
  now: number
): BackupAlarm[] {
  const out: BackupAlarm[] = []
  for (const d of destinations) {
    // Not scheduled is not overdue. A destination somebody backs up to by hand
    // is a choice, and alarming about it would train people to ignore this.
    if (!Number.isFinite(d.everyHours) || d.everyHours <= 0) continue

    const r = lastReport[d.id]
    if (r === undefined) {
      out.push({
        destinationId: d.id,
        destinationName: d.name,
        reason: 'never',
        level: 'alarm',
        detail: `${d.name} is scheduled every ${d.everyHours}h and has never produced a backup.`
      })
      continue
    }
    if (!r.ok) {
      out.push({
        destinationId: d.id,
        destinationName: d.name,
        reason: 'failed',
        level: 'alarm',
        detail: `The last backup to ${d.name} failed: ${r.error ?? 'no reason given'}`
      })
      continue
    }

    const at = Date.parse(r.finishedAt)
    if (!Number.isFinite(at)) {
      // A report we cannot date is not a recent one. Reading it as fresh would
      // be the reassuring half of the guess.
      out.push({
        destinationId: d.id,
        destinationName: d.name,
        reason: 'overdue',
        level: 'alarm',
        detail: `${d.name} has a backup report with an unreadable date, so how old it is cannot be told.`
      })
      continue
    }
    const lateBy = now - at
    if (lateBy > d.everyHours * 3600_000 * BACKUP_OVERDUE_PERIODS) {
      out.push({
        destinationId: d.id,
        destinationName: d.name,
        reason: 'overdue',
        level: 'alarm',
        detail: `${d.name} last backed up ${Math.floor(lateBy / 3600_000)}h ago on a ${d.everyHours}h schedule.`
      })
      continue
    }
    if (!r.verified) {
      out.push({
        destinationId: d.id,
        destinationName: d.name,
        reason: 'unverified',
        level: 'watch',
        detail: `${d.name} was written but not read back, so there is no evidence the backup is intact.`
      })
    }
  }
  return out
}
