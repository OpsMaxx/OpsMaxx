import { clipboard } from 'electron'
import { EchoSuppressor, identifyText, type ClipboardIdentity } from '../../../shared/clipboardIdentity'
import { AddyError, type AddySidecar } from './sidecar'
import type { RelayClient } from './relay'

/**
 * Sending the clipboard to another device, and receiving one.
 *
 * EXPLICIT SEND AND RECEIVE, ON A KEYSTROKE. Not ambient mirroring, and that
 * is a decision rather than a simplification:
 *
 *  - GNOME on Wayland refuses clipboard interception by design. An app that
 *    needs to watch the clipboard does not work there, and "works everywhere
 *    except the desktop half your Linux users run" is not a feature.
 *  - macOS 15.4 added `NSPasteboard.accessBehavior`, which prompts when an app
 *    reads a pasteboard it did not write. A background poller turns that into
 *    a prompt every few seconds.
 *  - And it is the right behaviour anyway. A clipboard that mirrors everything
 *    sends the password you just copied to every machine you own, including
 *    the one in the office you are not sitting at.
 *
 * So: the user presses a key to send, and presses a key to receive. The
 * capture problem disappears, the surprise disappears, and what is left is a
 * pipe.
 */

/** The mail kind. The relay routes on it without knowing what it means. */
export const CLIPBOARD_KIND = 'clipboard'

/** The largest clipboard entry that will be sent.
 *
 *  A clipboard is not a file transfer. Anything bigger is a transfer, which is
 *  a different feature with a different consent step -- and silently sending
 *  a 40 MB screenshot over somebody's tethered connection is the kind of thing
 *  that gets a feature switched off. */
export const MAX_CLIPBOARD_BYTES = 1024 * 1024

export interface ClipboardDeps {
  addyd: AddySidecar
  relay: RelayClient
  epoch(): number
  /** Every device on the roster except this one, as hex signing keys. */
  peers(): string[]
  /**
   * Try a direct connection first, returning true when the payload went that
   * way. Absent means "no p2p available" -- the `--rtc` sidecar is not
   * running, or no relay credentials were obtained -- and everything falls
   * back to the mailbox.
   *
   * A function rather than a transport object, because the ONLY thing this
   * layer needs to know is whether the bytes arrived. The dialling, the ICE
   * and the fallback ordering all live behind it.
   */
  tryDirect?(peerHex: string, sealed: string): Promise<boolean>
}

/** One clipboard payload, as it crosses the wire. Sealed before it leaves. */
interface ClipboardPayload {
  kind: 'text'
  text: string
  /** The sender's own identity for the content, so the receiver can suppress
   *  its own echo without re-deriving it and risking a different answer. */
  identity: ClipboardIdentity
  sentAt: number
}

/** Shared between send and receive, because the whole point of arming is that
 *  one side's write is the other side's read. */
const echo = new EchoSuppressor()

/**
 * Sends what is on the clipboard now, to every other device on the account.
 *
 * Every device, not a chosen one. Picking a destination is a decision the user
 * has to make at the moment they are trying to paste something, and the set of
 * devices is theirs already -- a clipboard that asks "to which machine?" is one
 * people stop using.
 */
export async function sendClipboard(deps: ClipboardDeps): Promise<{ sent: number; skipped?: string }> {
  const text = clipboard.readText()
  if (!text) {
    // Files and images are a transfer, not a clipboard send. Said plainly
    // rather than silently sending nothing.
    return { sent: 0, skipped: 'There is no text on the clipboard. Files and images are sent as transfers.' }
  }

  const identity = identifyText(text)
  if (identity.size > MAX_CLIPBOARD_BYTES) {
    return {
      sent: 0,
      skipped: `That is ${Math.round(identity.size / 1024)} KB, and the clipboard limit is ${MAX_CLIPBOARD_BYTES / 1024} KB. Send it as a file instead.`
    }
  }

  const payload: ClipboardPayload = { kind: 'text', text, identity, sentAt: Date.now() }
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8')

  let sent = 0
  for (const peer of deps.peers()) {
    // Sealed TO THAT DEVICE. The relay routes on the recipient's public key,
    // which it can compare and cannot use.
    const { sealed } = await deps.addyd.send<{ sealed: string }>('seal', {
      collection: `${CLIPBOARD_KIND}:${peer}`,
      epoch: deps.epoch(),
      schema: 1,
      writerVersion: process.env.npm_package_version ?? 'dev',
      counter: Date.now(),
      payload: plaintext.toString('base64')
    })

    // DIRECT FIRST, MAILBOX SECOND, and the order is decreasing quality
    // rather than decreasing convenience: a direct path means the relay sees
    // neither the bytes nor the timing, and a mailbox means it sees when you
    // copied something even though it cannot read what.
    //
    // A direct attempt that fails is not an error. Two symmetric NATs, a
    // corporate firewall, or a peer that is simply asleep are the ordinary
    // cases this whole design has a second path for.
    if (deps.tryDirect && (await deps.tryDirect(peer, sealed).catch(() => false))) {
      sent++
      continue
    }

    const resp = await deps.relay.request('POST', '/v1/mail', {
      toDevice: peer,
      kind: CLIPBOARD_KIND,
      sealed
    })
    if (resp.ok) sent++
  }
  return { sent }
}

/**
 * Applies the newest clipboard entry waiting for this device.
 *
 * NEWEST, and the rest are acknowledged rather than applied. A receive that
 * pasted a backlog one entry at a time would leave the clipboard holding
 * whatever happened to be last in the queue, which is not what anybody asked
 * for -- they pressed a key once and meant "give me the thing I just copied
 * over there".
 */
export async function receiveClipboard(
  deps: ClipboardDeps
): Promise<{ applied: boolean; from?: string; reason?: string }> {
  const resp = await deps.relay.request('GET', '/v1/mail')
  if (!resp.ok) {
    throw new AddyError('relay-unreachable', `collecting mail: ${resp.status}`)
  }
  const { messages } = (await resp.json()) as {
    messages: { id: number; fromDevice: string; kind: string; sealed: string }[]
  }

  const clips = messages.filter((m) => m.kind === CLIPBOARD_KIND)
  if (clips.length === 0) return { applied: false, reason: 'Nothing has been sent to this device.' }

  const newest = clips[clips.length - 1]
  await applySealedClipboard(deps, newest.sealed)

  // Acknowledge everything, not just the one applied. The rest are older
  // clipboard entries nobody is going to want, and leaving them means the next
  // receive has the same backlog.
  await deps.relay.request('POST', '/v1/mail/ack', { ids: clips.map((m) => m.id) })

  return { applied: true, from: newest.fromDevice }
}

/**
 * Opens one sealed clipboard payload and puts it on this machine's clipboard.
 *
 * SHARED BY BOTH PATHS ON PURPOSE. A payload that arrived over a direct
 * connection and one that came out of the mailbox are the same bytes sealed
 * the same way, and a second copy of this is a second place the echo flag can
 * be armed in the wrong order — which is a loop between two devices that each
 * re-send what the other just pasted.
 */
export async function applySealedClipboard(
  deps: ClipboardDeps,
  sealed: string
): Promise<ClipboardIdentity> {
  const opened = await deps.addyd.send<{ payload: string }>('open', {
    collection: `${CLIPBOARD_KIND}:${await selfDevice(deps)}`,
    epoch: deps.epoch(),
    sealed,
    knownSchema: 1,
    // Clipboard entries are not a document with a history, so there is no
    // rollback to enforce: every one is newer than the last by construction
    // and applying an older one is what "receive" sometimes means.
    seenCounter: 0
  })
  const payload = JSON.parse(Buffer.from(opened.payload, 'base64').toString('utf8')) as ClipboardPayload

  // ARMED BEFORE THE WRITE, not after. The platform's change notification can
  // arrive before the write call returns, and a flag set afterwards would miss
  // its own event -- which is a loop between two devices that each re-send
  // what the other just pasted.
  echo.arm(payload.identity.hash)
  clipboard.writeText(payload.text)
  return payload.identity
}

/** Whether a clipboard read is our own write coming back. Exposed so a future
 *  watcher can consult it; the explicit-send design does not need it today,
 *  and it is here because arming without a consumer is a bug waiting to be
 *  reintroduced. */
export function isOwnEcho(hash: string): boolean {
  return echo.shouldIgnore(hash)
}

/**
 * This device's own signing key, asked of the sidecar rather than remembered.
 *
 * The parent must not be the party that tracks it: a separately held copy can
 * drift from the key actually loaded, and the symptom of that is a seal nobody
 * can open -- discovered by a user whose clipboard silently stops arriving.
 */
async function selfDevice(deps: ClipboardDeps): Promise<string> {
  const { devicePub } = await deps.addyd.send<{ devicePub: string }>('whoami')
  if (!devicePub) throw new AddyError('not-paired', 'this device is not attached to an account')
  return devicePub
}
