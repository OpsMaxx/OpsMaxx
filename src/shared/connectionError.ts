// What actually went wrong with a connection, worked out from the text the
// failure arrived with.
//
// ssh2, node's socket layer and five database drivers each phrase the same
// handful of problems differently, and none of them phrase any of it for a
// person. Classifying in one place is what lets every surface say one short
// sentence and offer the one button that fixes it, instead of pasting a driver
// string into a toast and leaving the reader to interpret it.

export type ConnectionFault =
  /**
   * Not a fault at all: the shell ended, which is what `exit` does.
   *
   * It is in this union because the dead-session card asks this classifier
   * what happened, and every unrecognised string fell through to `unknown` —
   * whose whole job is to admit it cannot explain a FAILURE. So typing `exit`
   * produced "OpsMaxx could not tell what went wrong from what the server
   * said." over a session that had done exactly what it was told, which reads
   * as a bug in the app rather than a shell closing.
   */
  | 'exited'
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
  // A clean exit, and only a clean one. `transport.ts` writes "shell exited"
  // for status 0 and "shell exited with N" for anything else, so the negative
  // lookahead is the whole difference: a shell that died on an error stays a
  // failure and keeps its Edit button. Matching the "session closed" wrapper
  // instead would have swallowed both, which is the mistake this narrow
  // pattern exists to avoid.
  ['exited', /\bshell exited\b(?! with)/i],
  // `Host denied (verification failed)` is ssh2's own wording when our verifier
  // refuses, and it matched none of the patterns beside it -- so the one error
  // the user can actually finish in a single action was classified as generic.
  ['host-key', /host key|host verification|hostkey|fingerprint|host denied|no trusted host key/i],
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


// ---------------------------------------------------------------------------
// THE SENTENCE AN AGENT IS ALLOWED TO SEE
// ---------------------------------------------------------------------------
//
// `faultAdvice` next door is written for a person looking at the connection
// editor, with a Retry button beside it and the raw text underneath. An agent
// has neither, and — this is the part that matters — it must never be handed
// the raw text at all.
//
// ssh2 and node's socket layer put the address in the message: a refused dial
// arrives as `connect ECONNREFUSED 10.21.15.7:22`. Returning that through the
// MCP bridge would disclose, in a failure string, the one thing the whole
// addressing model exists to withhold. `errorText` in mcpServer.ts does not
// redact, and a redactor that tried to strip addresses out of arbitrary driver
// text would be guessing.
//
// So nothing is stripped. The text is CLASSIFIED and then thrown away, and
// these sentences are written from the fault alone. They cannot leak an address
// because no address was ever in them.
const AGENT_SENTENCE: Record<ConnectionFault, string> = {
  'host-key': 'the host key does not match the one saved for this server',
  'port-in-use': 'something on this machine is already listening on that port',
  passphrase: 'the private key is encrypted and no passphrase is stored for it',
  'key-missing': 'the private key file is not where the connection says it is',
  auth: 'the server rejected the username or the credential',
  refused: 'nothing is listening on that port',
  unreachable: 'the server did not answer in time',
  permission: 'the operating system refused access to something the connection needs',
  exited: 'the shell exited',
  // Admits it cannot explain, rather than picking the nearest plausible cause.
  // An agent that is told "authentication failed" when the truth is unknown
  // will go and rewrite a credential that was never wrong.
  unknown: 'OpsMaxx could not tell what went wrong from what the server said'
}

/**
 * Why a connection failed, in one clause, with no host, port or username in it.
 *
 * Takes the raw failure text and returns only what survives classification.
 * Safe to put in an MCP tool response or an audit entry.
 */
export function agentFaultSentence(text: string | null | undefined): string {
  return AGENT_SENTENCE[classifyConnectionError(text)]
}
