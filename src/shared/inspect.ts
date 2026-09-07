// The HTTPS traffic inspector, as the renderer and the CLI see it.
//
// Everything here is a plain, structurally-cloneable shape: these types cross
// the IPC boundary, and a class or a Date on this side becomes a mystery on
// the other. The wire shapes emitted by `sidecar/netd/inspect.go` are mirrored
// one-for-one so a flow needs no translation layer — only a decision about
// what to keep, which the main process makes.
//
// One rule runs through the whole file: a captured body is never a string on
// this side until someone asks to look at it. Bodies are base64 previews and
// byte counts, and the full payload lives in the sidecar's capture directory
// until `inspect:body` fetches a page of it. A traffic inspector that holds
// every response it has ever seen in the renderer's heap works beautifully for
// ten minutes and then takes the window down with it.

/** Where the traffic being inspected comes from. */
export type InspectSourceKind =
  /** Local terminals ShellPilot itself starts get the proxy variables
   *  injected. No privilege, no system state, nothing to undo if the app is
   *  killed.
   *
   *  Deliberately NOT remote SSH sessions. `ssh` can carry environment
   *  variables, but `sshd` refuses all but `LANG` and `LC_*` in its default
   *  configuration and says nothing when it drops the rest — so injecting
   *  there would appear to work, capture nothing, and give the user no way to
   *  tell the difference. A remote shell is pointed at the proxy by exporting
   *  the variables yourself; the panel hands you the exact lines. */
  | 'sessions'
  /** The machine's own proxy settings are pointed at us while capture is on,
   *  and restored when it stops. */
  | 'system'
  /** Something the user pointed at the listener themselves. */
  | 'manual'

export interface InspectFlowRequest {
  method: string
  scheme: 'http' | 'https'
  host: string
  port: number
  path: string
  query?: string
  httpVersion: string
  headers: InspectHeader[]
  /** The recorded header block hit its cap. The request itself was forwarded
   *  whole; only the recording is short. */
  headersTruncated?: boolean
}

export interface InspectHeader {
  name: string
  value: string
}

/** One exchange. A flow exists from the moment the request is understood; it
 *  is `pending` until the response body closes, which is what makes a
 *  server-sent-event stream visible while it is still streaming. */
export interface InspectFlow {
  id: string
  startedAt: number
  endedAt?: number
  state: 'pending' | 'complete' | 'failed'
  request: InspectFlowRequest
  status?: number
  statusText?: string
  responseHeaders?: InspectHeader[]
  contentType?: string
  /** Bytes on the wire, which is not the same as bytes recorded: a body past
   *  the capture cap is delivered in full and recorded in part. */
  requestBytes?: number
  responseBytes?: number
  /** Base64, capped at the sidecar's inline preview size. */
  requestPreview?: string
  responsePreview?: string
  requestSpilled?: boolean
  responseSpilled?: boolean
  requestTruncated?: boolean
  responseTruncated?: boolean
  /** The connection was handed to another protocol after the handshake — a
   *  WebSocket, almost always. The status and headers are real; there is no
   *  body, and the frames that follow are not recorded. */
  upgraded?: boolean
  /** Present when the exchange did not complete. Already redacted. */
  error?: string
}

/** A host whose client refused the certificate we minted for it. The only
 *  remedy short of patching that client is to stop intercepting it. */
export interface InspectPinnedHost {
  host: string
  attempts: number
  at: number
}

/** A CONNECT tunnel that carried neither TLS nor HTTP — a mail client, an SSH
 *  hop. Interception BREAKS these rather than merely failing to read them, so
 *  it is reported with the same prominence as a pinning host and has the same
 *  remedy: let it through untouched. */
export interface InspectOpaqueTunnel {
  /** host:port as the client asked for it. The port is the useful half — it is
   *  what says this was IMAP rather than a website. */
  host: string
  at: number
}

export interface InspectCaInfo {
  /** PEM. Public by definition — this is the certificate the user installs. */
  certPem: string
  fingerprint: string
  /** Colon-separated uppercase hex, which is how every trust-store UI on
   *  every platform shows a fingerprint. Provided so a person can compare
   *  what ShellPilot says with what Keychain Access or certmgr.msc says
   *  without transcribing 64 characters. */
  fingerprintDisplay: string
  notBefore: number
  notAfter: number
  commonName: string
  /** Where the certificate was written for the user to install by hand, and
   *  for tools that take a path (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`). */
  certPath: string
  /** Seconds until the authority expires; negative once it has. Everything it
   *  has signed stops being accepted at that moment, so this is surfaced
   *  rather than left to be discovered as an unexplained certificate error. */
  expiresInSec: number
  /** Whether the private key survived a restart. False means the OS keychain
   *  refused to seal it, and a new authority will be minted next time — which
   *  the user needs to know, because the one they installed will stop working. */
  keyPersisted: boolean
}

/** Whether this machine's trust stores currently accept our CA. Each store is
 *  reported separately because a single "installed" flag is a lie: Firefox,
 *  Java and Node keep their own, and telling someone their certificate is
 *  installed while their Node script still fails is worse than saying nothing. */
export interface InspectTrustStore {
  id: 'system' | 'nss' | 'java' | 'node' | 'python'
  label: string
  state: 'trusted' | 'untrusted' | 'unknown' | 'unsupported'
  /** What to do about it, in one sentence, when the state is not `trusted`. */
  hint?: string
  /** True when ShellPilot can change this store itself. Firefox and the JVM
   *  cannot be done for the user without reaching into someone else's data
   *  directory, so they are reported and explained instead. */
  installable: boolean
}

export interface InspectStatus {
  running: boolean
  listening?: { host: string; port: number }
  /** Set when the listener is bound to something other than loopback, which
   *  makes it an open proxy for the local network. */
  lanExposed?: boolean
  source: InspectSourceKind
  /** The tunnel or VPN profile upstream traffic is dialled through, if any. */
  viaProfileId?: string
  ca?: InspectCaInfo
  trust: InspectTrustStore[]
  /** Hosts excluded from interception, in the order they are applied. */
  passthrough: string[]
  pinned: InspectPinnedHost[]
  opaque: InspectOpaqueTunnel[]
  flows: number
  captureBodies: boolean
  maxBodyBytes: number
  /** Upstream certificate verification is off. Present and true only when a
   *  person deliberately turned it off; the UI is expected to say so loudly. */
  insecureUpstream?: boolean
  /** Set while the listener requires proxy credentials, which it does
   *  whenever it is not on loopback. The values themselves are in the env the
   *  panel hands out, never in the status. */
  requiresCredentials?: boolean
  /** Why the inspector stopped on its own, when it did. */
  stoppedReason?: string
}

/** How long before expiry the UI starts saying so. Long enough that nobody is
 *  surprised, short enough that it is not permanent furniture. */
export const INSPECT_CA_EXPIRY_WARN_SEC = 14 * 24 * 60 * 60

export interface InspectStartOptions {
  /** Defaults to 127.0.0.1. Anything else is an open proxy on the LAN and the
   *  UI must confirm it explicitly. */
  bindHost?: string
  /** 0 asks the OS. The chosen port is always reported back. */
  bindPort?: number
  source?: InspectSourceKind
  viaProfileId?: string
  passthrough?: string[]
  captureBodies?: boolean
  maxBodyBytes?: number
  upstreamCAsPem?: string[]
  insecureUpstream?: boolean
  /** Required when `bindHost` is anything but loopback: without credentials
   *  such a listener is an open proxy that also decrypts TLS for anyone on the
   *  network. The sidecar refuses to start one, rather than warning. */
  username?: string
  password?: string
}

export interface InspectBodyPage {
  /** Base64 of the requested slice. */
  base64: string
  offset: number
  total: number
  eof: boolean
}

/** What to set on a process so it talks to the inspector and trusts it.
 *  Returned rather than applied, so the terminal, the SSH session and the
 *  "copy for my own shell" button all use one definition. */
export type InspectEnv = Record<string, string>

/** The default set of hosts nothing intercepts.
 *
 *  These are not a guess at what pins: they are the hosts where interception
 *  is either useless or actively harmful. Certificate transparency, revocation
 *  and update endpoints must see the real chain to do their job, and putting
 *  ourselves in the middle of an OS update is a way to break a machine rather
 *  than a way to learn something. */
export const INSPECT_DEFAULT_PASSTHROUGH: readonly string[] = [
  // Certificate revocation and transparency. Interception here does not just
  // fail, it can make a client conclude the whole chain is untrustworthy.
  'ocsp.digicert.com',
  'ocsp.sectigo.com',
  '*.ocsp.identrust.com',
  'crl.microsoft.com',
  // Platform update services, which pin and which must not be tampered with.
  'swscan.apple.com',
  'swcdn.apple.com',
  'gdmf.apple.com',
  '*.windowsupdate.com',
  '*.update.microsoft.com',
  // ShellPilot's own updater. Inspecting our own signature check while
  // holding a CA that can forge it is the one combination that turns a
  // debugging tool into a supply-chain problem.
  'api.github.com',
  'objects.githubusercontent.com'
]

/** Fingerprint as every OS trust UI renders it: uppercase hex, colon-separated. */
export function formatFingerprint(hex: string): string {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  return clean.match(/.{1,2}/g)?.join(':') ?? clean
}

/** Which headers a UI should mask by default.
 *
 *  Not a security control — the whole point of the inspector is that the user
 *  can read these, and the value is one click away. It exists because a
 *  screen-shared or screenshotted flow list should not put a session cookie in
 *  a bug report by accident. */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-amz-security-token'
])

export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADERS.has(name.trim().toLowerCase())
}

/** True when a host is covered by a passthrough list.
 *
 *  This is the same rule the sidecar applies, restated here so the UI can show
 *  a host as excluded without a round trip. `*.example.com` covers subdomains
 *  and NOT the bare domain, which is what a wildcard means everywhere else a
 *  person has seen one. */
export function isPassthroughHost(list: readonly string[], host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, '')
  if (!h) return false
  return list.some((raw) => {
    const entry = raw.trim().toLowerCase()
    if (entry === h) return true
    if (entry.startsWith('*.')) return h.endsWith(`.${entry.slice(2)}`)
    return false
  })
}

/** A short, human description of one flow, for a list row and for the
 *  accessibility name of that row. */
export function describeFlow(flow: InspectFlow): string {
  const { method, host, path, query } = flow.request
  const suffix = query ? `${path}?${query}` : path
  if (flow.state === 'pending') return `${method} ${host}${suffix} — in flight`
  if (flow.state === 'failed') return `${method} ${host}${suffix} — failed`
  return `${flow.status ?? ''} ${method} ${host}${suffix}`.trim()
}
