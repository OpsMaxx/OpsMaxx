import { app, clipboard } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from '../atomicWrite'
import { AddyError } from './sidecar'
import { EchoSuppressor, identifyText, type ClipboardIdentity } from '../../../shared/clipboardIdentity'
import { relayError, type RelayClient } from './relay'
import {
  LEGACY_MAIL_REASON,
  MAILBOX_MAX_AGE_MS,
  isLegacyMail,
  openMail,
  sealMail,
  type MailDeps,
  type OpenedMail
} from './mail'

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

export interface ClipboardDeps extends MailDeps {
  relay: RelayClient
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

/**
 * How old a clipboard may be and still be what somebody is reaching for.
 *
 * "Newest" was `clips[clips.length - 1]` — the last element of the array THE
 * RELAY returned, in the relay's order — with the rollback check disabled and
 * `sentAt` written into every payload and read by nothing. So a relay could
 * keep any clipboard row it had ever carried and serve it as current: the
 * user presses receive expecting the URL they just copied, and pastes last
 * week's password into whatever has focus.
 *
 * The time used is the one the sender SIGNED (see mail.ts), so it is the
 * sender's own claim and not the relay's. Ten minutes is generous for "I
 * copied that on the other machine a moment ago" and short enough that
 * nothing stale is applied silently.
 */
const MAX_CLIPBOARD_AGE_MS = 10 * 60_000

/** One clipboard payload, as it crosses the wire. Sealed before it leaves. */
interface ClipboardPayload {
  kind: 'text'
  text: string
  /** The sender's own identity for the content, so the receiver can suppress
   *  its own echo without re-deriving it and risking a different answer. */
  identity: ClipboardIdentity
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

  // WHAT THIS DEVICE JUST RECEIVED IS NOT WORTH SENDING BACK.
  //
  // The echo flag was armed on every receive and consulted by nothing, which
  // made the arming decoration. It matters on the send side even with an
  // explicit keystroke: press receive and then send within the suppressor's
  // window — which is exactly what somebody does while checking the feature
  // works — and the other device is handed back the string it just sent, as
  // though it had come from here.
  //
  // The window is short and the check CONSUMES the arming, both by design:
  // the same text copied again later is a real event and must be sent. So
  // this suppresses the immediate bounce and nothing else, which is all it
  // should do.
  if (isOwnEcho(identity.hash)) {
    return {
      sent: 0,
      skipped: 'That is what this device just received. It is already on the other machine.'
    }
  }

  if (identity.size > MAX_CLIPBOARD_BYTES) {
    return {
      sent: 0,
      skipped: `That is ${Math.round(identity.size / 1024)} KB, and the clipboard limit is ${MAX_CLIPBOARD_BYTES / 1024} KB. Send it as a file instead.`
    }
  }

  const payload: ClipboardPayload = { kind: 'text', text, identity }
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8')

  let sent = 0
  const failed: string[] = []
  for (const peer of deps.peers()) {
    // Sealed TO THAT DEVICE'S OWN KEY and signed by this one's — see mail.ts.
    // The relay routes on the recipient's public key, which it can compare
    // and cannot use.
    let sealed: string
    try {
      sealed = await sealMail(deps, CLIPBOARD_KIND, peer, plaintext)
    } catch (err) {
      failed.push(`device ${peer.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }

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

    // A REFUSAL IS SAID, not counted silently as "not sent". A full mailbox
    // (507) was the ordinary way this failed, and the notification read
    // "Clipboard sent to 0 devices" with no reason — or, with two devices and
    // one refused, "sent to 1" as though that were all of them. Reported in
    // `skipped`, because the shortcut that calls this shows that field and
    // has nowhere to show an exception.
    try {
      const resp = await deps.relay.request('POST', '/v1/mail', {
        toDevice: peer,
        kind: CLIPBOARD_KIND,
        sealed
      })
      if (resp.ok) sent++
      else failed.push((await relayError(resp, `device ${peer.slice(0, 8)}`)).message)
    } catch (err) {
      failed.push(`device ${peer.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (failed.length === 0) return { sent }
  return {
    sent,
    skipped:
      (sent > 0 ? `Sent to ${sent}, but not to ${failed.length}. ` : 'Not sent. ') + failed.join('; ')
  }
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
  if (!resp.ok) throw await relayError(resp, 'collecting mail')
  const { messages } = (await resp.json()) as {
    messages: { id: number; fromDevice: string; kind: string; sealed: string }[]
  }

  // FROM A CURRENT MEMBER ONLY, and decided by the SIGNATURE, not by
  // `fromDevice`. Filtering on the relay's label let a relay name any current
  // member, and opening proved only that somebody holding the epoch key sealed
  // it — a removed device included. `openMail` refuses a signer that is not on
  // the verified roster, whatever the row says.
  const clips = messages.filter((m) => m.kind === CLIPBOARD_KIND)
  if (clips.length === 0) return { applied: false, reason: 'Nothing has been sent to this device.' }

  /**
   * THE NEWEST BY ITS OWN TIMESTAMP, not by the relay's ordering.
   *
   * Opened before one is chosen, because the only trustworthy time is the one
   * the sender signed — the array's order is the relay's to pick.
   */
  const opened: (OpenedMail & { clip: ClipboardPayload })[] = []
  let legacy = false
  for (const m of clips) {
    try {
      // The mailbox's window, not the clipboard's ten minutes: an older one
      // still opens, so the refusal below can say how old it was.
      opened.push(await openClipboard(deps, m.sealed, MAILBOX_MAX_AGE_MS))
    } catch {
      // A payload this device cannot open is one to acknowledge and forget
      // rather than retry for ever: sealed to another device, signed by one
      // that is not on the roster, already delivered once, or from an
      // OpsMaxx too old to sign it.
      legacy ||= isLegacyMail(m.sealed)
    }
  }
  opened.sort((a, b) => a.sentAt - b.sentAt)
  const newest = opened[opened.length - 1]

  if (!newest) {
    await deps.relay.request('POST', '/v1/mail/ack', { ids: clips.map((m) => m.id) })
    return {
      applied: false,
      reason: legacy
        ? `The clipboard sent to this device was not pasted. ${LEGACY_MAIL_REASON}`
        : 'Nothing that could be opened on this device.'
    }
  }

  const age = Date.now() - newest.sentAt
  if (age > MAX_CLIPBOARD_AGE_MS) {
    // Acknowledged, so it stops being offered — but NOT applied. Writing a
    // week-old clipboard into whatever has focus is the one outcome this
    // check exists to prevent, and it happens silently.
    await deps.relay.request('POST', '/v1/mail/ack', { ids: clips.map((m) => m.id) })
    return {
      applied: false,
      reason: `The newest thing sent to this device is ${Math.round(age / 60_000)} minutes old, so it was not pasted. Send it again from the other machine.`
    }
  }

  applyOpenedClipboard(newest.clip)

  // Acknowledge everything, not just the one applied. The rest are older
  // clipboard entries nobody is going to want, and leaving them means the next
  // receive has the same backlog.
  await deps.relay.request('POST', '/v1/mail/ack', { ids: clips.map((m) => m.id) })

  return { applied: true, from: newest.from }
}

/**
 * Opens one sealed clipboard payload and puts it on this machine's clipboard.
 *
 * SHARED BY BOTH PATHS ON PURPOSE. A payload that arrived over a direct
 * connection and one that came out of the mailbox are the same bytes sealed
 * the same way, and a second copy of this is a second place the echo flag can
 * be armed in the wrong order — which is a loop between two devices that each
 * re-send what the other just pasted. And the same signature check: a direct
 * connection proves which device dialled, not that it is still a member.
 */
export async function applySealedClipboard(
  deps: ClipboardDeps,
  sealed: string
): Promise<ClipboardIdentity> {
  return applyOpenedClipboard((await openClipboard(deps, sealed, MAX_CLIPBOARD_AGE_MS)).clip)
}

/** Opens one sealed clipboard payload without applying it. */
async function openClipboard(
  deps: ClipboardDeps,
  sealed: string,
  maxAgeMs: number
): Promise<OpenedMail & { clip: ClipboardPayload }> {
  // Not a document with a history, so there is no counter to enforce. The
  // sidecar refuses a replay by the sender's nonce and a stale one by the
  // signed time.
  const opened = await openMail(deps, CLIPBOARD_KIND, sealed, maxAgeMs)
  // AND ON DISK. The sidecar's memory of what it opened is gone after a
  // restart, so the relay could hand back a clipboard still inside its window
  // and it would be applied a second time — into whatever terminal has focus.
  // Remembered here by signer and signed time until that window closes.
  if (seenBefore(`${opened.from}:${opened.sentAt}`, opened.sentAt + maxAgeMs + 5 * 60_000)) {
    throw new AddyError('config-invalid', 'this clipboard was already delivered once')
  }
  return { ...opened, clip: JSON.parse(opened.payload.toString('utf8')) as ClipboardPayload }
}

/** DEVICE-LOCAL: which clipboards this device already applied, until each
 *  one's window closes. In NOT_SYNCED.clipboardSeen and the wipe list. */
export const CLIPBOARD_SEEN_FILE = 'opsmaxx-addy-clipboard-seen.json'

function seenBefore(key: string, until: number): boolean {
  const path = join(app.getPath('userData'), CLIPBOARD_SEEN_FILE)
  let seen: Record<string, number> = {}
  try {
    if (existsSync(path)) seen = JSON.parse(readFileSync(path, 'utf8')) as Record<string, number>
  } catch {
    seen = {}
  }
  const now = Date.now()
  for (const [k, t] of Object.entries(seen)) if (t < now) delete seen[k]
  if (key in seen) return true
  seen[key] = until
  atomicWriteFileSync(path, JSON.stringify(seen))
  return false
}

function applyOpenedClipboard(payload: ClipboardPayload): ClipboardIdentity {
  // THE HASH IS RECOMPUTED, not taken from the payload. It was armed straight
  // from `payload.identity.hash`, which the sender chose — so a peer could arm
  // this device's echo suppressor with the hash of something the user was
  // about to copy, and their next send would be refused with "that is what
  // this device just received".
  const identity = identifyText(payload.text)

  // ARMED BEFORE THE WRITE, not after. The platform's change notification can
  // arrive before the write call returns, and a flag set afterwards would miss
  // its own event -- which is a loop between two devices that each re-send
  // what the other just pasted.
  echo.arm(identity.hash)
  clipboard.writeText(payload.text)
  return identity
}

/** Whether a clipboard read is our own write coming back.
 *
 *  Consulted by `sendClipboard` above, and exported for a future watcher that
 *  will need the same question answered before it forwards anything. It used
 *  to be exported and called from nowhere, with a comment explaining why that
 *  was fine — which is the shape of every dead feature found in this module,
 *  so it now has a caller. */
export function isOwnEcho(hash: string): boolean {
  return echo.shouldIgnore(hash)
}
