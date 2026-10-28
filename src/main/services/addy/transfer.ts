import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app } from 'electron'
import { AddyError } from './sidecar'
import { MAX_REQUEST_BYTES, relayError, type RelayClient } from './relay'
import { CLIPBOARD_KIND } from './clipboard'
import { LEGACY_MAIL_REASON, isLegacyMail, openMail, sealMail, type MailDeps, type OpenedMail } from './mail'

/**
 * Sending a file to another of your own devices.
 *
 * ---------------------------------------------------------------------------
 * THE POINTER, NOT THE PAYLOAD
 * ---------------------------------------------------------------------------
 *
 * The bytes go into the object store, sealed; the mailbox carries a small
 * notice saying where to find them. That split is the design's rule for every
 * notification and it earns its keep here twice over: a mailbox row is
 * delivered to one device and read once, so a payload in it could not be
 * retried after a crash, and the object store is the half that has a quota,
 * an ETag and a size the relay can refuse. A 200 MB row in a message table is
 * a different kind of outage from a full bucket.
 *
 * ---------------------------------------------------------------------------
 * QUARANTINE, AND WHY IT IS NOT THE DOWNLOADS FOLDER
 * ---------------------------------------------------------------------------
 *
 * An arriving file lands in a directory this app owns, named after the
 * transfer, and is swept after a week. It is not written to Downloads and it
 * is never opened automatically. The sender is one of the user's own devices,
 * which is exactly the belief that makes an automatic write dangerous: a
 * device on the roster is a device somebody could have paired, and the roster
 * is the thing the user is asked to review after a recovery for that reason.
 */

/** Where arriving files land. Device-local; nothing here is ever synced. */
export const TRANSFER_DIR = 'addy-transfers'

/**
 * What sealing adds to a transfer's bytes, exactly.
 *
 * The bytes are a mail blob (`protocol/mail.go`, `SealMailBlob`), sealed under
 * a one-time key that travels only inside the notice: "addy-mail-blob-v1\0"
 * (18) + nonce (24) + the plaintext + a 16-byte tag = 58.
 * `TestTransferSealOverhead` in the sidecar seals a transfer and fails if this
 * number is wrong.
 */
export const TRANSFER_SEAL_OVERHEAD = 58

/** Room for `{"epoch":…,"counter":1,"body":"…"}` around the base64. The real
 *  envelope is 33 bytes plus the epoch's digits. */
const PUT_ENVELOPE_BYTES = 64

/**
 * The largest file this will send: whatever still fits in ONE request once it
 * is sealed, base64-encoded and wrapped in JSON.
 *
 * It was 100 MB, and the relay reads at most 8 MiB of a request. Above that it
 * truncated the body, the body hash no longer matched the signature, and the
 * relay answered 401 — so every file over about 6 MB failed as "this device is
 * not paired". It now answers 413 instead, and this keeps a send from getting
 * that far. Derived rather than written down, so a change to the relay's limit
 * or the seal's layout moves it with them. A bigger file is a job for a real
 * file-transfer tool, and saying so beats a request the relay will refuse.
 */
export const MAX_TRANSFER_BYTES =
  Math.floor((MAX_REQUEST_BYTES - PUT_ENVELOPE_BYTES) / 4) * 3 - TRANSFER_SEAL_OVERHEAD

/** How long an arrived file is kept before it is swept. */
export const QUARANTINE_MS = 7 * 24 * 60 * 60 * 1000

/** The mail kind. The relay routes on it and knows nothing else. */
export const TRANSFER_KIND = 'transfer'

/** What the mailbox carries: where the bytes are and what they should be. */
interface TransferNotice {
  id: string
  name: string
  size: number
  /** SHA-256 of the plaintext, so the recipient can tell a truncated fetch
   *  from a complete one. The AEAD already proves the bytes were not altered
   *  by anyone without the key; this proves they are all there. */
  sha256: string
  /**
   * Base64 of the one-time key the object is sealed under.
   *
   * The object was sealed under the EPOCH key, so every device on the account
   * -- and a removed one, until somebody re-keyed -- could fetch and read any
   * file sent to any other. The key now travels only here, in a notice sealed
   * to the recipient and signed by the sender, so the bytes are exactly as
   * readable as the notice: by one device.
   */
  key: string
  sentAt: number
}

export interface TransferDeps extends MailDeps {
  relay: RelayClient
  epoch(): number
}

/**
 * Notices opened on an earlier pass whose bytes were not there yet.
 *
 * Opening one spends its nonce — the sidecar refuses the same mail twice, so a
 * relay cannot replay it — and the ordinary reason the bytes are missing is a
 * sender still uploading. Without this the retry the comment below promises
 * would open a "replay" and drop the transfer. Keyed by the sealed bytes, so
 * the relay renumbering a row cannot attach one notice's verdict to another.
 */
const heldNotices = new Map<string, OpenedMail>()

const quarantine = (): string => join(app.getPath('userData'), TRANSFER_DIR)

/**
 * A transfer id, as this code mints them: 24 lowercase hex characters.
 *
 * VALIDATED ON ARRIVAL, not merely on the way out. The id comes out of a
 * decrypted notice written by another machine, and it is used to build a
 * directory path — so an id of `../../../../.ssh` and a name of
 * `authorized_keys` writes an SSH key into the user's home directory at mode
 * 0600, which is exactly the mode sshd insists on.
 *
 * A valid signature from a device on the roster is not a reason to trust the
 * id either. It is the reason to check it: a member is a device somebody could
 * have paired, and an arriving file is the one artefact this feature asks the
 * user to make a trust judgement about.
 */
const TRANSFER_ID = /^[0-9a-f]{8,64}$/

/** The object name the bytes live under. Includes the recipient, so two
 *  transfers of the same file to two devices do not collide. */
function objectName(id: string): string {
  return `transfer:${id}`
}

/**
 * Sends one file to one device.
 *
 * Sealed to that device, uploaded, and only then announced — the order
 * matters: a notice that arrives before the object exists is a recipient that
 * fetches a 404 and reports a failure for a transfer that is about to work.
 */
export async function sendFile(
  deps: TransferDeps,
  path: string,
  toDevice: string
): Promise<{ id: string; name: string; size: number }> {
  if (!deps.peers().includes(toDevice)) {
    // Refused rather than attempted. Sealing to a key that is not on the
    // roster is sealing to somebody who was removed, and the relay would
    // happily carry it.
    throw new AddyError('not-paired', 'that device is not on this account')
  }

  const info = statSync(path)
  if (!info.isFile()) {
    throw new AddyError('config-invalid', 'only a file can be sent, not a folder')
  }
  if (info.size > MAX_TRANSFER_BYTES) {
    throw new AddyError(
      'too-large',
      `that file is ${(info.size / 1024 / 1024).toFixed(1)} MB and the limit is ${(MAX_TRANSFER_BYTES / 1024 / 1024).toFixed(1)} MB. Use a file-transfer tool for something that size.`
    )
  }

  const bytes = readFileSync(path)
  const id = createHash('sha256')
    .update(`${toDevice}:${path}:${Date.now()}`)
    .digest('hex')
    .slice(0, 24)
  const name = basename(path)
  const digest = createHash('sha256').update(bytes).digest('hex')

  const sealed = await deps.addyd.send<{ key: string; sealed: string }>('sealBlob', {
    payload: bytes.toString('base64')
  })
  await deps.relay.putObject(
    objectName(id),
    deps.epoch(),
    1,
    Buffer.from(sealed.sealed, 'base64')
  )

  // THE NOTICE SECOND. See above: announcing before the bytes are there is a
  // recipient that fetches a 404 and reports a failure for a working transfer.
  const notice: TransferNotice = {
    id,
    name,
    size: bytes.length,
    sha256: digest,
    key: sealed.key,
    sentAt: Date.now()
  }
  const sealedNotice = await sealMail(
    deps,
    TRANSFER_KIND,
    toDevice,
    Buffer.from(JSON.stringify(notice), 'utf8')
  )
  const resp = await deps.relay.request('POST', '/v1/mail', {
    toDevice,
    kind: TRANSFER_KIND,
    sealed: sealedNotice
  })
  if (!resp.ok) {
    // The bytes are already on the relay and now nothing will ever point at
    // them. Deleted, or every refused notice — a full mailbox above all —
    // leaves up to 6 MB counted against the account's quota for good.
    const err = await relayError(resp, 'the relay would not carry the notice')
    await deps.relay.deleteObject(objectName(id)).catch(() => undefined)
    throw err
  }

  return { id, name, size: bytes.length }
}

export interface ArrivedFile {
  id: string
  name: string
  size: number
  path: string
  from: string
  at: number
}

/**
 * Collects whatever has been sent to this device.
 *
 * Every notice, not just the newest — unlike the clipboard, where only the
 * last thing copied is worth having. A file somebody sent an hour ago is still
 * the file they sent.
 */
export async function collectFiles(deps: TransferDeps): Promise<ArrivedFile[]> {
  const resp = await deps.relay.request('GET', '/v1/mail')
  if (!resp.ok) throw await relayError(resp, 'collecting mail')
  const { messages } = (await resp.json()) as {
    messages: { id: number; fromDevice: string; kind: string; sealed: string }[]
  }
  /**
   * ONLY FROM A DEVICE THAT IS STILL ON THE ROSTER — and that is decided by
   * the notice's SIGNATURE, in `openMail`, against the roster this device
   * verified. A removed device keeps a working key, and a file arriving from
   * "one of your own devices" is exactly the belief this feature asks the
   * user to act on.
   *
   * The `fromDevice` filter here is housekeeping, not that proof: it is the
   * relay's label, and a relay can write any label it likes. Relabelling a
   * removed device's notice as a member's gets it as far as `openMail`, which
   * refuses it; relabelling a real one as a stranger's drops it, which a relay
   * can do anyway by not delivering it.
   */
  const peers = new Set(deps.peers())
  const notices = messages.filter((m) => m.kind === TRANSFER_KIND && peers.has(m.fromDevice))

  /**
   * AND WHAT CANNOT BE USED IS ACKNOWLEDGED, not left to pile up.
   *
   * Mail from a device that is not on the roster, of a kind this build does
   * not know, or that does not open, was skipped and never acknowledged — so
   * it was offered again on every pass until the relay's 48-hour expiry, and
   * it counted against the 256-message cap the whole time. Fill that and
   * every sender gets 507, with nothing on either screen saying why.
   *
   * Clipboard mail from a member is NOT touched here: it is collected by a
   * keystroke, and dropping it on a timer would empty the clipboard queue
   * before the person pressed receive. The caller refreshes the roster before
   * this runs, so "not a member" means not a member now, rather than a
   * device that joined since the last pass.
   */
  const unusable = messages
    .filter(
      (m) =>
        !peers.has(m.fromDevice) || (m.kind !== TRANSFER_KIND && m.kind !== CLIPBOARD_KIND)
    )
    .map((m) => m.id)
  if (notices.length === 0) {
    if (unusable.length > 0) await ack(deps, unusable)
    return []
  }

  const dir = quarantine()
  mkdirSync(dir, { recursive: true })

  const arrived: ArrivedFile[] = []
  const done: number[] = []
  /** Objects to delete once their notice is acknowledged. */
  const finished: string[] = []
  let legacy = 0
  for (const m of notices) {
    let opened: OpenedMail
    let notice: TransferNotice
    try {
      opened = heldNotices.get(m.sealed) ?? (await openMail(deps, TRANSFER_KIND, m.sealed))
      heldNotices.delete(m.sealed)
      notice = JSON.parse(opened.payload.toString('utf8')) as TransferNotice
    } catch {
      // A notice that does not open will not open next time either: sealed to
      // another device, signed by one not on the roster, already delivered,
      // or from an OpsMaxx too old to sign it.
      if (isLegacyMail(m.sealed)) legacy++
      unusable.push(m.id)
      continue
    }

    // BEFORE THE ID IS USED FOR ANYTHING. It addresses both a relay object
    // and a local directory, and the local one is the dangerous half — see
    // TRANSFER_ID. Refused rather than sanitised, because there is no
    // legitimate id this rejects: every one this code mints is hex. Dropped
    // with it, because it is the same notice every time it is offered.
    if (
      typeof notice.id !== 'string' ||
      !TRANSFER_ID.test(notice.id) ||
      typeof notice.key !== 'string'
    ) {
      unusable.push(m.id)
      continue
    }

    try {

      const object = await deps.relay.getObject(objectName(notice.id), deps.epoch())
      if (!object) {
        // The bytes are not there. NOT acknowledged, so the next collection
        // tries again: the ordinary cause is a sender still uploading, and
        // dropping the notice would lose the transfer permanently.
        heldNotices.set(m.sealed, opened)
        continue
      }
      const body = await deps.addyd.send<{ payload: string }>('openBlob', {
        key: notice.key,
        sealed: object.body.toString('base64')
      })
      const bytes = Buffer.from(body.payload, 'base64')

      // CHECKED BEFORE IT IS WRITTEN. The AEAD proves nobody without the
      // notice's key altered these bytes; the digest, which the sender
      // signed, proves they are all of them and the ones it meant.
      // Dropped when it fails: fetching again gets the same bytes.
      const digest = createHash('sha256').update(bytes).digest('hex')
      if (digest !== notice.sha256) {
        unusable.push(m.id)
        finished.push(objectName(notice.id))
        continue
      }

      // Named by the transfer, not by the sender's filename alone: a file
      // called `.bashrc` should not be able to choose where it lands, and two
      // transfers of `report.pdf` should not overwrite each other.
      // `basename` as well as the check above, and not instead of it: two
      // independent reasons this cannot escape the quarantine is the right
      // number for a path built from a remote string.
      const folder = join(dir, basename(notice.id))
      mkdirSync(folder, { recursive: true })
      const safe = basename(notice.name).replace(/[/\\]/g, '_') || 'file'
      const full = join(folder, safe)
      writeFileSync(full, bytes, { mode: 0o600 })

      arrived.push({
        id: notice.id,
        name: safe,
        size: bytes.length,
        path: full,
        from: opened.from,
        at: opened.sentAt
      })
      done.push(m.id)
      finished.push(objectName(notice.id))
    } catch {
      // One bad transfer does not stop the rest, and it is NOT acknowledged —
      // so a failure that was transient is retried rather than silently
      // dropped on the floor. Held, for the same reason as a missing object.
      heldNotices.set(m.sealed, opened)
    }
  }

  if (done.length + unusable.length > 0) {
    // Acknowledged FIRST, deleted after. Deleting an object whose notice is
    // still in the mailbox would turn the next collection into a 404 it
    // retries for two days.
    if (await ack(deps, [...done, ...unusable])) {
      // AND THE BYTES GO, which they never did. Nothing deleted a transfer
      // object, so every file ever sent sat in the account's quota until
      // sync itself started failing with 507.
      for (const name of finished) await deps.relay.deleteObject(name).catch(() => undefined)
    }
  }
  if (legacy > 0 && arrived.length === 0) {
    // Said, because otherwise the file simply never arrives. Thrown only once
    // the notices are acknowledged, so it is said once rather than every pass.
    throw new AddyError(
      'config-invalid',
      `${legacy === 1 ? 'A file' : `${legacy} files`} sent to this device ${legacy === 1 ? 'was' : 'were'} refused. ${LEGACY_MAIL_REASON}`
    )
  }
  return arrived
}

async function ack(deps: TransferDeps, ids: number[]): Promise<boolean> {
  const resp = await deps.relay.request('POST', '/v1/mail/ack', { ids })
  return resp.ok
}

/** What is sitting in quarantine now, newest first. */
export function pendingFiles(): ArrivedFile[] {
  const dir = quarantine()
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const out: ArrivedFile[] = []
  for (const id of entries) {
    try {
      const folder = join(dir, id)
      for (const name of readdirSync(folder)) {
        const full = join(folder, name)
        const info = statSync(full)
        out.push({ id, name, size: info.size, path: full, from: '', at: info.mtimeMs })
      }
    } catch {
      /* a folder that vanished between the listing and the stat */
    }
  }
  return out.sort((a, b) => b.at - a.at)
}

/**
 * Deletes what has been sitting too long.
 *
 * A transfer directory is not a Downloads folder: these are files the user did
 * not choose to keep, written by another machine, and leaving them for ever
 * turns a convenience into an accumulating copy of everything anyone ever
 * sent. Swept on a schedule rather than on read, so a device that is never
 * opened still clears itself down when it is.
 */
export function sweepQuarantine(now = Date.now()): number {
  const dir = quarantine()
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const id of entries) {
    const folder = join(dir, id)
    try {
      if (now - statSync(folder).mtimeMs < QUARANTINE_MS) continue
      rmSync(folder, { recursive: true, force: true })
      removed++
    } catch {
      /* already gone */
    }
  }
  return removed
}

/** Removes one arrived transfer, for a user who has taken what they wanted. */
export function discardTransfer(id: string): void {
  // `basename` rather than the id verbatim: this comes from the renderer, and
  // a `../` in it would delete a directory outside the quarantine.
  rmSync(join(quarantine(), basename(id)), { recursive: true, force: true })
}
