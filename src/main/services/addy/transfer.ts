import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app } from 'electron'
import { AddyError, type AddySidecar } from './sidecar'
import type { RelayClient } from './relay'

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
 * The largest file this will send.
 *
 * Not a technical limit — the object store would take more — but a limit on
 * what one keystroke should be able to put on somebody's tethered connection
 * without a second thought. Above it the honest answer is a real file-transfer
 * tool, and saying so beats a progress bar that stalls for an hour.
 */
export const MAX_TRANSFER_BYTES = 100 * 1024 * 1024

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
  sentAt: number
}

export interface TransferDeps {
  addyd: AddySidecar
  relay: RelayClient
  epoch(): number
  /** Every other device on the roster, as hex signing keys. */
  peers(): string[]
}

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
 * The sender holding the epoch key is not a reason to trust the id. It is the
 * reason to check it: a revoked-but-not-re-keyed device still holds that key,
 * and an arriving file is the one artefact this feature asks the user to make
 * a trust judgement about.
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
      'quota-exceeded',
      `that file is ${Math.round(info.size / 1024 / 1024)} MB and the limit is ${MAX_TRANSFER_BYTES / 1024 / 1024} MB. Use a file-transfer tool for something that size.`
    )
  }

  const bytes = readFileSync(path)
  const id = createHash('sha256')
    .update(`${toDevice}:${path}:${Date.now()}`)
    .digest('hex')
    .slice(0, 24)
  const name = basename(path)
  const digest = createHash('sha256').update(bytes).digest('hex')

  const sealed = await deps.addyd.send<{ sealed: string }>('seal', {
    collection: objectName(id),
    epoch: deps.epoch(),
    schema: 1,
    writerVersion: 'transfer',
    counter: 1,
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
  const notice: TransferNotice = { id, name, size: bytes.length, sha256: digest, sentAt: Date.now() }
  const sealedNotice = await deps.addyd.send<{ sealed: string }>('seal', {
    collection: `${TRANSFER_KIND}:${toDevice}`,
    epoch: deps.epoch(),
    schema: 1,
    writerVersion: 'transfer',
    counter: Date.now(),
    payload: Buffer.from(JSON.stringify(notice), 'utf8').toString('base64')
  })
  const resp = await deps.relay.request('POST', '/v1/mail', {
    toDevice,
    kind: TRANSFER_KIND,
    sealed: sealedNotice.sealed
  })
  if (!resp.ok) {
    throw new AddyError('relay-unreachable', `the relay would not carry the notice (${resp.status})`)
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
  if (!resp.ok) throw new AddyError('relay-unreachable', `collecting mail: ${resp.status}`)
  const { messages } = (await resp.json()) as {
    messages: { id: number; fromDevice: string; kind: string; sealed: string }[]
  }
  /**
   * ONLY FROM A DEVICE THAT IS STILL ON THE ROSTER.
   *
   * Opening a notice proves someone holding this epoch's key sealed it under
   * the right collection name. That is a weaker statement than it looks: a
   * device that was removed and not re-keyed is still someone holding that
   * key. Without this filter, such a device could go on delivering files to
   * every machine on the account — and a file arriving from "one of your own
   * devices" is exactly the belief this feature asks the user to act on.
   *
   * The sender is the relay's word for it, which is why this is a filter and
   * not a proof: a relay can relabel a row. What it buys is that the relay
   * must now name a CURRENT member, so a removed device cannot deliver under
   * its own identity, and the label shown to the user is at least a device
   * that exists on the account.
   */
  const peers = new Set(deps.peers())
  const notices = messages.filter((m) => m.kind === TRANSFER_KIND && peers.has(m.fromDevice))
  if (notices.length === 0) return []

  const { devicePub } = await deps.addyd.send<{ devicePub: string }>('whoami')
  const dir = quarantine()
  mkdirSync(dir, { recursive: true })

  const arrived: ArrivedFile[] = []
  const done: number[] = []
  for (const m of notices) {
    try {
      const opened = await deps.addyd.send<{ payload: string }>('open', {
        collection: `${TRANSFER_KIND}:${devicePub}`,
        epoch: deps.epoch(),
        sealed: m.sealed,
        knownSchema: 1,
        seenCounter: 0
      })
      const notice = JSON.parse(
        Buffer.from(opened.payload, 'base64').toString('utf8')
      ) as TransferNotice

      // BEFORE THE ID IS USED FOR ANYTHING. It addresses both a relay object
      // and a local directory, and the local one is the dangerous half — see
      // TRANSFER_ID. Refused rather than sanitised, because there is no
      // legitimate id this rejects: every one this code mints is hex.
      if (typeof notice.id !== 'string' || !TRANSFER_ID.test(notice.id)) {
        throw new AddyError('config-invalid', 'a transfer arrived with an id this build will not use')
      }

      const object = await deps.relay.getObject(objectName(notice.id), deps.epoch())
      if (!object) {
        // The bytes are not there. NOT acknowledged, so the next collection
        // tries again: the ordinary cause is a sender still uploading, and
        // dropping the notice would lose the transfer permanently.
        continue
      }
      const body = await deps.addyd.send<{ payload: string }>('open', {
        collection: objectName(notice.id),
        epoch: deps.epoch(),
        sealed: object.body.toString('base64'),
        knownSchema: 1,
        seenCounter: 0
      })
      const bytes = Buffer.from(body.payload, 'base64')

      // CHECKED BEFORE IT IS WRITTEN. The AEAD proves nobody without the key
      // altered these bytes; the digest proves they are all of them.
      const digest = createHash('sha256').update(bytes).digest('hex')
      if (digest !== notice.sha256) {
        throw new AddyError('internal', `${notice.name} arrived incomplete`)
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
        from: m.fromDevice,
        at: notice.sentAt
      })
      done.push(m.id)
    } catch {
      // One bad transfer does not stop the rest, and it is NOT acknowledged —
      // so a failure that was transient is retried rather than silently
      // dropped on the floor.
    }
  }

  if (done.length > 0) {
    await deps.relay.request('POST', '/v1/mail/ack', { ids: done })
  }
  return arrived
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
