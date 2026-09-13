// The renderer's half of connection-error handling: the copy and the buttons.
//
// The classifier itself moved to src/shared/connectionError.ts when the MCP
// bridge needed it — main cannot import from the renderer, and `test_connection`
// has to turn an ssh2 failure into a sentence with no address in it. Same split
// as src/shared/capacity.ts and this directory's capacity.ts, and for the same
// reason: the logic is shared, the wording and the affordances are not.
//
// Re-exported here so every existing caller keeps its import unchanged.
export { classifyConnectionError, agentFaultSentence, type ConnectionFault } from '../../../shared/connectionError'

import { classifyConnectionError, type ConnectionFault } from '../../../shared/connectionError'
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
  exited: {
    // Says what happened, and does not imply anybody did anything wrong.
    cause: 'The shell exited.',
    retry: true,
    // There is nothing to correct in a connection that worked.
    edit: false
  },
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
