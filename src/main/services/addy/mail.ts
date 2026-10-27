import { AddyError, type AddySidecar } from './sidecar'

/**
 * Mail between two devices on this account: clipboards and file notices.
 *
 * SEALED TO ONE DEVICE AND SIGNED BY ONE DEVICE. Both used to be sealed under
 * the account-wide epoch key with the recipient's name as a label, and the
 * sender was the relay's `fromDevice`. So a removed device -- which keeps the
 * epoch key until somebody re-keys -- could read every clipboard, and could
 * write one "from your desktop" that this device pasted into a terminal. Now
 * the sidecar seals to the recipient's encryption key from the verified roster
 * and signs with this device's key (`sidecar/addyd/mail.go`), and opening
 * refuses anything whose signer is not on the roster this device verified.
 *
 * `fromDevice` is not consulted for any of that. It is the relay's word, and
 * the relay is the party this is a defence against.
 */

/** How long a mail may wait in the mailbox and still be opened: the relay's
 *  48-hour expiry, plus the clock drift the sidecar allows. A kind with a
 *  tighter rule (the clipboard's ten minutes) checks it on the signed time. */
export const MAILBOX_MAX_AGE_MS = 49 * 60 * 60_000

/** What a 0.59.0 sender leaves: a collection object sealed under the epoch
 *  key, which says nothing about which device wrote it. */
const LEGACY_PREFIX = Buffer.from('addy-obj-v1\0', 'latin1')

export const LEGACY_MAIL_REASON =
  'It was sent by an older version of OpsMaxx, which cannot prove which device sent it. ' +
  'Update OpsMaxx on the sending device.'

export function isLegacyMail(sealed: string): boolean {
  // 12 bytes of prefix are exactly the first 16 base64 characters.
  return Buffer.from(sealed.slice(0, 16), 'base64').equals(LEGACY_PREFIX)
}

export interface MailDeps {
  addyd: AddySidecar
  /** Every other device on the verified roster, as hex signing keys. */
  peers(): string[]
  /** The encryption key that same roster lists for one of them. */
  peerEnc(pubSign: string): string | undefined
}

export async function sealMail(
  deps: MailDeps,
  kind: string,
  to: string,
  payload: Buffer
): Promise<string> {
  const toEnc = deps.peerEnc(to)
  if (!toEnc) throw new AddyError('not-paired', 'that device is not on this account')
  const { sealed } = await deps.addyd.send<{ sealed: string }>('sealMail', {
    kind,
    to,
    toEnc,
    payload: payload.toString('base64')
  })
  return sealed
}

export interface OpenedMail {
  /** The signer, checked against the roster. Not the relay's `fromDevice`. */
  from: string
  /** The sender's clock, inside the signature. */
  sentAt: number
  payload: Buffer
}

export async function openMail(
  deps: MailDeps,
  kind: string,
  sealed: string,
  maxAgeMs = MAILBOX_MAX_AGE_MS
): Promise<OpenedMail> {
  if (isLegacyMail(sealed)) throw new AddyError('config-invalid', LEGACY_MAIL_REASON)
  const opened = await deps.addyd.send<{ from: string; sentAt: number; payload: string }>(
    'openMail',
    { kind, sealed, senders: deps.peers(), maxAgeMs }
  )
  return { from: opened.from, sentAt: opened.sentAt, payload: Buffer.from(opened.payload, 'base64') }
}
