/**
 * `opsmaxx://` links, which is how a relay address and an invite reach a second
 * machine without anybody retyping either.
 *
 * THE PROBLEM THIS SOLVES IS NOT TYPING, IT IS KNOWING. A new machine cannot
 * join a relay it cannot name, and nothing on that machine knows the name —
 * the person is expected to remember `https://addy.opsmaxx.dev` and type it
 * correctly into a field before anything else can happen. A link carries the
 * address and the invite together, so the machine that has neither gets both
 * from one click or one paste.
 *
 * EVERY LINK IS UNTRUSTED. It arrives from outside the product — a chat
 * message, an email, a QR code someone photographed — and it names a server to
 * talk to and carries a bearer token to spend there. So parsing it is a
 * boundary, not a convenience:
 *
 *   - A parsed link NEVER acts on its own. It fills a form. The person sees
 *     the relay's hostname and presses something. A link that joined an
 *     account by being clicked would be a link anybody could send you.
 *   - The relay must be `https`, with an exception only for loopback, because
 *     a dev relay is self-signed on localhost and a plain-text relay anywhere
 *     else is somebody reading your invite off the wire.
 *   - No credentials in the URL's userinfo, no ports on non-loopback hosts
 *     that would let `https://addy.opsmaxx.dev@evil.example` read as the
 *     expected host to a person skimming it.
 *   - Everything is length-bounded, because this string comes from a stranger.
 */

/** What a link asks the app to do. Two, and both need a human press after. */
export type AddyLinkAction = 'sync' | 'pair'

export interface AddyLink {
  action: AddyLinkAction
  /** The relay to join, normalised — no trailing slash, no credentials. */
  relay: string
  /** An invite token, for a first device. */
  invite?: string
  /** A pairing code and its id, for a device joining an account that exists. */
  code?: string
  pairingId?: string
}

/** The scheme. One word, lowercase, registered with the OS at install. */
export const ADDY_LINK_SCHEME = 'opsmaxx'

// Bounds, not guesses: an invite is 32 random bytes base64url (43 chars) and a
// pairing code is short. The ceilings are generous enough for a format change
// and small enough that no version of this is a buffer somebody fills.
const MAX_URL = 2048
const TOKEN = /^[A-Za-z0-9_-]{8,128}$/
const PAIRING_ID = /^[A-Za-z0-9_-]{4,128}$/

function loopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
}

/**
 * Parse one link, or explain why it is not one.
 *
 * Returns a reason rather than throwing, because every caller shows it to
 * somebody: a link that does nothing and says nothing is worse than a link
 * that refuses out loud.
 */
export function parseAddyLink(raw: string): { link: AddyLink } | { reason: string } {
  if (typeof raw !== 'string' || raw.length === 0) return { reason: 'That is not a link.' }
  if (raw.length > MAX_URL) return { reason: 'That link is too long to be one of ours.' }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { reason: 'That is not a link this app understands.' }
  }
  if (url.protocol !== `${ADDY_LINK_SCHEME}:`) {
    return { reason: `A sync link starts with ${ADDY_LINK_SCHEME}://` }
  }

  // `opsmaxx://sync?...` puts "sync" in the host on every platform's parser;
  // `opsmaxx:///sync?...` would put it in the path. Accept both rather than
  // depend on which one the sender's client produced.
  const action = (url.hostname || url.pathname.replace(/^\/+/, '')).toLowerCase()
  if (action !== 'sync' && action !== 'pair') {
    return { reason: 'That link does not ask for anything this app can do.' }
  }

  const relayRaw = url.searchParams.get('relay')?.trim()
  if (!relayRaw) return { reason: 'That link does not say which relay to use.' }

  let relay: URL
  try {
    relay = new URL(relayRaw)
  } catch {
    return { reason: 'The relay in that link is not an address.' }
  }
  if (relay.username !== '' || relay.password !== '') {
    // `https://addy.opsmaxx.dev@evil.example` reads as the first host to a
    // person and resolves to the second.
    return { reason: 'That link hides a different address behind a familiar one.' }
  }
  const isLoopback = loopback(relay.hostname)
  if (relay.protocol !== 'https:' && !(relay.protocol === 'http:' && isLoopback)) {
    return { reason: 'A relay has to be https, so an invite cannot be read on the way.' }
  }
  if (relay.pathname !== '/' && relay.pathname !== '') {
    return { reason: 'The relay in that link has a path, and a relay is a host.' }
  }

  const normalised = `${relay.protocol}//${relay.host}`

  const invite = url.searchParams.get('invite')?.trim() || undefined
  const code = url.searchParams.get('code')?.trim() || undefined
  const pairingId = url.searchParams.get('id')?.trim() || undefined

  if (invite !== undefined && !TOKEN.test(invite)) {
    return { reason: 'The invite in that link is not shaped like one.' }
  }
  if (code !== undefined && !TOKEN.test(code)) {
    return { reason: 'The code in that link is not shaped like one.' }
  }
  if (pairingId !== undefined && !PAIRING_ID.test(pairingId)) {
    return { reason: 'The pairing id in that link is not shaped like one.' }
  }

  if (action === 'sync' && invite === undefined) {
    return { reason: 'That link has no invite in it.' }
  }
  if (action === 'pair' && (code === undefined || pairingId === undefined)) {
    return { reason: 'A pairing link needs both a code and a pairing id.' }
  }

  return {
    link: {
      action,
      relay: normalised,
      ...(invite ? { invite } : {}),
      ...(code ? { code } : {}),
      ...(pairingId ? { pairingId } : {})
    }
  }
}

/** Build the link a relay console hands out. The inverse of the parser, kept
 *  beside it so the two cannot drift. */
export function addyInviteLink(relay: string, invite: string): string {
  const r = new URL(relay)
  return `${ADDY_LINK_SCHEME}://sync?relay=${encodeURIComponent(`${r.protocol}//${r.host}`)}&invite=${encodeURIComponent(invite)}`
}
