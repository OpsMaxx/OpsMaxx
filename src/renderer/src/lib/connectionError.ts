// What actually went wrong with a connection, worked out from the text the
// failure arrived with.
//
// ssh2, node's socket layer and five database drivers each phrase the same
// handful of problems differently, and none of them phrase any of it for a
// person. Classifying in one place is what lets every surface say one short
// sentence and offer the one button that fixes it, instead of pasting a driver
// string into a toast and leaving the reader to interpret it.

export type ConnectionFault =
  | 'host-key'
  | 'port-in-use'
  | 'passphrase'
  | 'key-missing'
  | 'auth'
  | 'refused'
  | 'unreachable'
  | 'permission'
  | 'unknown'

// First match wins, so the specific patterns come before the general ones.
// "Permission denied (publickey)" is a rejected credential, not a filesystem
// refusal, and has to be tested before the bare permission pattern.
const PATTERNS: [ConnectionFault, RegExp][] = [
  ['host-key', /host key|host verification|hostkey|fingerprint/i],
  ['port-in-use', /EADDRINUSE|already in use/i],
  ['passphrase', /passphrase|encrypted private key/i],
  ['key-missing', /(ENOENT|no such file|cannot (open|read))[^]*(key|\.pem|id_)/i],
  [
    'auth',
    /authentication|permission denied \(|publickey|password rejected|access denied for user|auth failed|login failed/i
  ],
  ['refused', /ECONNREFUSED|connection refused/i],
  ['unreachable', /ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|getaddrinfo|timed out|timeout/i],
  ['permission', /permission denied|EACCES|access denied|not permitted/i]
]

export function classifyConnectionError(text: string | null | undefined): ConnectionFault {
  if (!text) return 'unknown'
  for (const [fault, re] of PATTERNS) if (re.test(text)) return fault
  return 'unknown'
}

/**
 * The message out of a thrown IPC rejection, without the transport's own
 * preamble.
 *
 * Electron prefixes a rejected handler's message with "Error invoking remote
 * method 'sftp:connect':", which describes how the failure travelled rather
 * than what failed.
 */
export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')
    .trim()
}

// ---------------------------------------------------------------------------
// WHAT TO SAY, AND WHAT TO OFFER, FOR EACH FAULT
// ---------------------------------------------------------------------------
//
// The classifier above has existed for a while and the database surface uses
// it. The terminal did not: an unreachable host, a wrong port, a wrong username
// and a rejected key all arrived as one string — "Connection failed: Timed out
// while waiting for handshake" — over a card whose only button was Reconnect.
//
// Reconnect is the one action that cannot help most of those. If the username
// is wrong it fails identically, forever, and the card then reassured the
// reader that "reconnecting reuses the pooled connection … so it usually skips
// authentication" at the exact moment authentication was the suspect.
//
// So each fault gets a cause sentence, and — more importantly — says whether
// retrying is worth anything and whether the fix is in the connection's
// settings. `retry` is not a style preference: offering it on an auth failure
// is offering a button that is known not to work.

export interface FaultAdvice {
  /** One sentence naming the cause, in the user's terms. */
  cause: string
  /** Worth pressing Reconnect? False when the same attempt must fail again. */
  retry: boolean
  /** Is the fix a field on the connection? Drives the Edit connection button. */
  edit: boolean
  /** What to change, when we can say. */
  hint?: string
}

const ADVICE: Record<ConnectionFault, FaultAdvice> = {
  'host-key': {
    cause: 'The server presented a different host key than the one saved for it.',
    // Deliberately neither. A changed host key is a decision — rebuilt server,
    // or interception — and it is not made by pressing a button on this card.
    retry: false,
    edit: false,
    hint: 'Forget the saved key in Settings → Security only if you are certain the server changed.'
  },
  'port-in-use': {
    cause: 'Something on this machine is already listening on that port.',
    retry: false,
    edit: true,
    hint: 'Pick another local port.'
  },
  passphrase: {
    cause: 'The private key is encrypted and no passphrase was supplied.',
    retry: false,
    edit: true,
    hint: 'Add the passphrase to the connection, or load the key into your agent.'
  },
  'key-missing': {
    cause: 'The private key file is not where the connection says it is.',
    retry: false,
    edit: true,
    hint: 'Point the connection at the key, or switch it to password or agent authentication.'
  },
  auth: {
    // The case that made this necessary. Retrying re-runs the same rejected
    // credential and fails the same way, forever.
    cause: 'The server rejected the username or the credential.',
    retry: false,
    edit: true,
    hint: 'Check the username and the authentication method.'
  },
  refused: {
    // Nothing is listening. That is usually a wrong port or a stopped daemon —
    // both worth one retry, since a daemon may be restarting.
    cause: 'Nothing is listening on that port.',
    retry: true,
    edit: true,
    hint: 'Check the port, and that sshd is running.'
  },
  unreachable: {
    cause: 'The server did not answer in time.',
    retry: true,
    edit: true,
    hint: 'Check the address, and whether a firewall or VPN sits in the way.'
  },
  permission: {
    cause: 'The operating system refused access to something the connection needs.',
    retry: false,
    edit: false
  },
  // NOT a cause sentence. Inventing one for text we did not recognise is how
  // four different problems came to share a single wrong explanation in the
  // first place — the raw text underneath is the honest thing to show.
  unknown: {
    cause: 'OpsMaxx could not tell what went wrong from what the server said.',
    retry: true,
    edit: true
  }
}

export function faultAdvice(fault: ConnectionFault): FaultAdvice {
  return ADVICE[fault]
}

/** Advice straight from the raw failure text. */
export function adviseOnError(text: string | null | undefined): FaultAdvice {
  return faultAdvice(classifyConnectionError(text))
}
