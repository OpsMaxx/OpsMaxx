// VPN and reverse-proxy tunnels.
//
// Deliberately a separate domain from `./tunnel.ts`: that type is SSH-shaped
// (a listener plus a target, carried over an SSH chain), and a WireGuard peer
// or an frp proxy set does not fit inside it. What they do share is the shape
// of an ephemeral local forward, so `VpnDriver.openForward` returns the same
// `{ port, close }` pair `openEphemeralForward` does and `db.ts` can consume
// either without knowing which it got.

export type VpnKind = 'wireguard' | 'openvpn' | 'frp' | 'tailscale' | 'ngrok'

// `userspace` runs the whole TCP/IP stack in-process (gVisor netstack) and
// exposes the tunnel as local listeners only: no TUN device, no route table
// change, no elevation. `system` creates a real interface and touches routes
// and DNS, so it needs the user to approve an elevation prompt every launch.
export type VpnMode = 'userspace' | 'system'

export type VpnSecretField =
  | 'privateKey'
  | 'presharedKey'
  | 'password'
  | 'username'
  | 'keyPassphrase'
  | 'token'
  | 'configBody'
  | 'proxySecretKey'

// A pointer into the vault. A literal secret must never appear on a
// VpnProfile: profiles are persisted by store.ts into plain JSON.
export interface VpnSecretRef {
  vaultEntryId: string
  field: VpnSecretField
  // Which custom vault field holds it, for the fields that don't map onto a
  // built-in slot (per-peer preshared keys, per-proxy secret keys).
  fieldKey?: string
}

export type VpnListener =
  | { kind: 'socks5'; bindHost: string; bindPort: number }
  | { kind: 'http'; bindHost: string; bindPort: number }
  | {
      kind: 'forward'
      bindHost: string
      bindPort: number
      targetHost: string
      targetPort: number
    }

export interface WireGuardPeer {
  // base64, 44 chars including the trailing '='.
  publicKey: string
  presharedKeyRef?: VpnSecretRef
  // host:port, or [v6]:port.
  endpoint: string
  allowedIps: string[]
  // Seconds. 0 or absent means off.
  persistentKeepalive?: number
}

export interface WireGuardSpec {
  kind: 'wireguard'
  mode: VpnMode
  privateKeyRef: VpnSecretRef
  // CIDR, e.g. ['10.0.0.2/32', 'fd00::2/128'].
  addresses: string[]
  dns: string[]
  mtu?: number
  peers: WireGuardPeer[]
  // Userspace mode only. Ignored in system mode, where the OS routes instead.
  listeners: VpnListener[]
  // Kept so the import report can be shown again later, not just once.
  strippedDirectives?: StrippedDirective[]
}

export type OpenVpnAuthMode = 'none' | 'userpass' | 'userpass-otp'

export interface OpenVpnSpec {
  kind: 'openvpn'
  // The SANITISED config we re-emitted, including inline <ca>/<cert>/<key>/
  // <tls-crypt> blocks. Stored whole in the vault; it only ever reaches disk
  // inside a 0700 run directory, and on Windows only because there is no
  // /dev/stdin there.
  configRef: VpnSecretRef
  authMode: OpenVpnAuthMode
  usernameRef?: VpnSecretRef
  passwordRef?: VpnSecretRef
  keyPassphraseRef?: VpnSecretRef
  staticChallenge?: { text: string; echo: boolean }
  // false => --route-nopull plus explicit routes. Default false: never hijack
  // the default route because a downloaded profile asked us to.
  redirectGateway: boolean
  httpProxy?: { host: string; port: number; auth?: 'none' | 'basic' | 'ntlm' }
  strippedDirectives?: StrippedDirective[]
  // Explicit user override; absent means allowlisted auto-detect.
  binaryPath?: string
  // Summary fields kept out of the encrypted config body so the UI can show
  // something useful without unlocking the vault.
  remotes?: { host: string; port: number; proto: string }[]
  /**
   * Epoch ms at which this profile's own client certificate stops being
   * accepted, or absent when it could not be read -- and absent is not
   * "fine", it is not known.
   *
   * Computed once at import from material the parser already had, so nothing
   * unlocks the vault to draw a date. Never set for a pkcs12 profile: that is
   * a password-wrapped container, not a certificate.
   */
  clientCertNotAfter?: number
}

export type FrpProxyType = 'tcp' | 'udp' | 'http' | 'https' | 'stcp' | 'sudp' | 'xtcp' | 'tcpmux'

export interface FrpProxy {
  name: string
  type: FrpProxyType
  // Forced to 127.0.0.1 unless the user explicitly confirmed otherwise.
  localIp: string
  localPort: number
  remotePort?: number
  customDomains?: string[]
  subdomain?: string
  // stcp/sudp/xtcp.
  secretKeyRef?: VpnSecretRef
  plugin?: { name: 'socks5' | 'http_proxy'; username?: string; passwordRef?: VpnSecretRef }
  // The user ticked "this makes localhost:<port> reachable from <serverAddr>".
  // start() refuses without it. Not a preference — a gate.
  acknowledgedExposure: boolean
}

/**
 * Where a service published through this frp client actually appears.
 *
 * OpsMaxx does not own a public endpoint and this record is the whole
 * reason it never has to pretend otherwise. ngrok can hand out a URL because
 * ngrok runs the server the name resolves to; frp cannot, so somebody pointed
 * `*.<baseDomain>` at an frp server they control, and this is that somebody's
 * answer written down. Every published URL is derived from it rather than
 * invented, which means a URL is only ever shown once there is a real domain
 * behind it.
 *
 * Absent means the one-click publish flow refuses and explains, rather than
 * composing a plausible-looking address out of the frp server's own hostname.
 */
export interface FrpPublicHost {
  /** The wildcard-delegated zone, without a leading dot: `tunnel.example.com`
   *  when `*.tunnel.example.com` resolves to the frp server. */
  baseDomain: string
  /** How the names are served in front of the frp server. `https` only when
   *  something actually terminates TLS for `*.<baseDomain>` — frp itself does
   *  not do that for a plain local HTTP service, and a URL whose scheme is a
   *  wish fails in the browser rather than in this app. */
  scheme: 'http' | 'https'
  /** frps `vhostHTTPPort`, when the URL has to carry it. Absent, or the
   *  scheme's default, means the URL carries no port at all. */
  port?: number
  /**
   * Epoch ms of the moment the operator said the DNS record exists.
   *
   * Its presence is what stops the guided setup asking again — the roadmap's
   * "a guided one-time thing and then never mentioned again" is this field.
   * It records a claim, not a measurement: OpsMaxx never resolves the name,
   * so this says the operator told us, and nothing stronger.
   */
  confirmedAt: number
}

export interface FrpVisitor {
  name: string
  type: 'stcp' | 'sudp' | 'xtcp'
  serverName: string
  secretKeyRef?: VpnSecretRef
  bindAddr: string
  bindPort: number
}

export interface FrpOidc {
  clientId: string
  clientSecretRef?: VpnSecretRef
  audience?: string
  scope?: string
  tokenEndpointUrl: string
}

export interface FrpSpec {
  kind: 'frp'
  serverAddr: string
  serverPort: number
  auth: { method: 'token' | 'oidc'; tokenRef?: VpnSecretRef; oidc?: FrpOidc }
  transport: {
    protocol: 'tcp' | 'kcp' | 'quic' | 'websocket' | 'wss'
    tlsEnable: boolean
    // Corporate proxy: http://, socks5://, ntlm://.
    proxyUrl?: string
    poolCount?: number
    heartbeatIntervalSec?: number
  }
  proxies: FrpProxy[]
  visitors: FrpVisitor[]
  // Set by the guided setup, and by nothing else. An imported frpc.toml never
  // carries it: the file says where the client dials, not which domain its
  // operator pointed at that server, and guessing would be exactly the lie
  // this field exists to avoid.
  publicHost?: FrpPublicHost
  strippedDirectives?: StrippedDirective[]
  // Choices the user has explicitly accepted, each of which validation
  // otherwise treats as an error.
  //
  // These live on the profile rather than in the form's local state because
  // validation runs twice: once as you type, and again at start. A
  // confirmation the form remembered but the profile did not would let Save
  // succeed and then make Start fail forever, with no control anywhere that
  // could satisfy it.
  //
  // `acknowledgedExposure` is deliberately NOT here — it is per-proxy and
  // lives on FrpProxy, because "this specific port becomes reachable" is a
  // different question for every proxy.
  confirmations?: FrpConfirmations
}

export interface FrpConfirmations {
  /** `localIp` other than 127.0.0.1: the proxy then reaches something that is
   *  not this machine's loopback. */
  allowNonLoopbackLocalIp?: boolean
  /** `transport.tls.enable = false`. */
  allowPlaintextTransport?: boolean
  /** socks5 / http_proxy plugins: the proxy becomes a general-purpose way out
   *  of this machine rather than a single port. */
  allowProxyPlugins?: boolean
  /** A visitor listening on something other than loopback. */
  allowNonLoopbackBindAddr?: boolean
}

/**
 * Tailscale, which this app ATTACHES to rather than runs.
 *
 * There is almost nothing to configure, and that is the design rather than an
 * omission. `tailscaled` is a machine-wide daemon that other software depends
 * on and that the user installed deliberately; OpsMaxx does not start it, does
 * not stop it, and stores no credential for it — login is a browser flow the
 * Tailscale client owns. What this profile holds is the app's own view of it.
 */
export interface TailscaleSpec {
  kind: 'tailscale'
  /**
   * The device name this node takes on the tailnet.
   *
   * This node is OURS — a separate device with its own key, not a view of a
   * `tailscaled` the user may also run — so it needs a name of its own in the
   * admin console. Absent means the sidecar picks one.
   */
  hostname?: string
  /**
   * Offer this tailnet's peers as connections to open.
   *
   * Read-only either way: it changes what the app SHOWS, never what the tailnet
   * is. Off by default, because a device list is information about a network the
   * user may not want mirrored into this app's UI.
   */
  showPeers?: boolean
  /**
   * Always absent, and present in the type only so the profile UI can read it
   * without branching. There is no Tailscale import, so nothing is ever
   * stripped.
   */
  strippedDirectives?: StrippedDirective[]
}

/** One device on a tailnet, as the UI shows it. */
export interface TailnetPeer {
  name: string
  /** The address a connection would dial. */
  host: string
  online: boolean
  os?: string
}

/** One endpoint an ngrok profile publishes. */
export interface NgrokTunnel {
  name: string
  proto: 'http' | 'tcp' | 'tls'
  /** The port on THIS machine that gets published. */
  localPort: number
  /**
   * A reserved domain or TCP address, for accounts that have one. Absent means
   * ngrok assigns a random address per run — so the public URL changes every
   * restart, and anything holding the old one breaks.
   */
  domain?: string
  /**
   * The user ticked "this makes localhost:<port> reachable from the public
   * internet". start() refuses without it. Not a preference — a gate.
   */
  acknowledgedExposure: boolean
}

/**
 * ngrok, running inside the bundled sidecar.
 *
 * No agent binary is involved. `golang.ngrok.com/ngrok/v2` is MIT and opens
 * endpoints from inside `opsmaxx-netd`, so this works on a machine that has
 * never heard of ngrok. The agent itself is closed-source and could not have
 * been shipped — which is true, and is not the same question as whether ngrok
 * can be embedded.
 */
export interface NgrokSpec {
  kind: 'ngrok'
  /**
   * The account authtoken, in the vault.
   *
   * A vault ref rather than a stored string: it has to travel with an encrypted
   * backup, and the OS keychain is machine-local. It reaches the sidecar per
   * call and is never written to disk by this app.
   */
  authtokenRef?: VpnSecretRef
  tunnels: NgrokTunnel[]
  strippedDirectives?: StrippedDirective[]
}

export type VpnSpec = WireGuardSpec | OpenVpnSpec | FrpSpec | TailscaleSpec | NgrokSpec

/**
 * The kinds that can be created from a config FILE.
 *
 * Excluded at the type level rather than by a runtime guard, so the compiler
 * refuses an attempt to open the import flow instead of the user reaching a
 * parser whose only possible answer is "that file was wrong".
 *
 * Tailscale has no configuration file at all — the daemon holds its own state
 * and its own login. ngrok has one, but it is not the unit of exchange: what a
 * user has is an account and a port they want published, and both are chosen in
 * the profile form. Neither is an omission waiting to be filled in.
 */
export type ImportableVpnKind = Exclude<VpnKind, 'tailscale' | 'ngrok'>

/**
 * Whether a kind publishes outward rather than making the other side reachable
 * here.
 *
 * One predicate, because this distinction is drawn in three places — the tab
 * counts and each of the two manager panels — and each of them used to spell it
 * as `kind === 'frp'` or `kind !== 'frp'`. That pair is only correct while frp
 * is the only reverse proxy: adding ngrok to some of them and not others counts
 * it in both tabs and lists it in neither reliably.
 */
export function isReverseProxyKind(kind: VpnKind): boolean {
  return kind === 'frp' || kind === 'ngrok'
}

export interface VpnProfile {
  id: string
  workspaceId: string
  name: string
  autoStart: boolean
  spec: VpnSpec
}

// ------------------------------------------------------------------ status

export type VpnState =
  | 'stopped'
  | 'starting'
  | 'authenticating'
  | 'connected'
  | 'reconnecting'
  // Up, but not passing traffic: a WireGuard handshake older than 180s, or an
  // frp proxy in `start error`. Amber, not red — the distinction between
  // up-but-not-working and down is the single most useful thing this UI shows.
  | 'degraded'
  | 'error'

/**
 * What a VPN's state says about the two conditions worth alerting on.
 *
 * A pure map, exported and exhaustive, because the map IS the feature -- the
 * poll around it is ten lines of timer. Written as a Record so a state added to
 * VpnState is a type error here rather than a silent `null` that makes a new
 * failure mode invisible.
 *
 * `null` is "this state is not an observation of that condition", and it is not
 * `false`. The two that matter:
 *
 *   stopped   NOT an outage. A person pressed Stop. It is also not evidence
 *             the VPN is healthy, so it is null in both columns rather than
 *             false -- resolving a down alert because somebody stopped the
 *             profile would be the app marking its own alert as fixed.
 *   degraded  Up and not passing traffic. `down: false` because it IS up, and
 *             `silent: true`, which is a different alert with a different fix.
 *             vpn.ts calls that distinction the single most useful thing this
 *             UI shows.
 */
export const VPN_ALERT_READINGS: Record<VpnState, { down: boolean | null; silent: boolean | null }> = {
  error: { down: true, silent: null },
  connected: { down: false, silent: false },
  degraded: { down: false, silent: true },
  // Coming up, or going round again. Neither condition is observable yet, and
  // announcing a failure every time somebody starts a VPN is how an alert
  // becomes one people turn off.
  starting: { down: null, silent: null },
  authenticating: { down: null, silent: null },
  reconnecting: { down: null, silent: null },
  stopped: { down: null, silent: null }
}

/**
 * One endpoint the ngrok agent has published.
 *
 * In `shared/` rather than in the driver because the public URL is the entire
 * point of an ngrok tunnel and the UI has to render it — the same reason
 * FrpProxyStatus lives here.
 */
export interface NgrokEndpoint {
  name: string
  publicUrl: string
  proto: string
  localAddr?: string
}

export interface FrpProxyStatus {
  name: string
  type: string
  status: string
  err?: string
  localAddr?: string
  remoteAddr?: string
}

/**
 * One WireGuard peer's own numbers.
 *
 * THE AGGREGATE ABOVE ANSWERS "IS THIS TUNNEL ALIVE"; this answers "which
 * peer", which is a different question and the one somebody asks when a
 * site-to-site link is half up and the totals still look fine.
 *
 * `publicKey` is an identity rather than a secret -- a WireGuard public key is
 * meant to be shared -- but it is still what names a person's device, and
 * `list_vpns` promises an agent is never shown keys of any kind. Nothing that
 * builds an agent-facing answer may read this field, and a test asserts it.
 */
export interface VpnPeerStat {
  publicKey: string
  endpoint?: string
  rxBytes: number
  txBytes: number
  /** AGE in seconds, converted from the sidecar's absolute stamp the same way
   *  the aggregate is. Absent means this peer has never completed a handshake,
   *  which is not the same as a long time ago. */
  lastHandshakeSec?: number
}

export interface VpnStats {
  rxBytes: number
  txBytes: number
  // WireGuard only. Age in seconds; absent means there has never been one.
  lastHandshakeSec?: number
  assignedIp?: string
  remoteEndpoint?: string
  latencyMs?: number
  // WireGuard only, and absent rather than empty when the sidecar reported no
  // rows: a tunnel whose peers were removed and one from a build that does not
  // report rows are different, and only the first is a fact about the tunnel.
  peers?: VpnPeerStat[]
  // frp only; frp exposes no client-side byte counters, so the proxy table is
  // the telemetry rather than faked rx/tx numbers.
  proxies?: FrpProxyStatus[]
  // ngrok only, and the same reasoning: a mesh of endpoints has no single
  // rx/tx pair worth reporting, and the public URL is what the user actually
  // needs — it is assigned by the server, changes per run without a reserved
  // domain, and exists nowhere else in the app.
  endpoints?: NgrokEndpoint[]
  // Tailscale only. A tailnet is a mesh, so there is no single peer the way a
  // WireGuard tunnel has one — `peers` above is the WireGuard shape and does
  // not fit. Present only when the profile asked to list devices.
  tailnetPeers?: TailnetPeer[]
  sampledAt: number
}

export type VpnErrorCode =
  | 'binary-missing'
  | 'binary-untrusted'
  | 'config-invalid'
  | 'config-rejected'
  | 'auth-failed'
  | 'auth-otp-required'
  | 'tls-handshake-failed'
  | 'cert-expired'
  | 'handshake-timeout'
  | 'dns-failure'
  | 'port-in-use'
  | 'permission-denied'
  | 'elevation-declined'
  | 'network-unreachable'
  | 'server-rejected'
  | 'crash-loop'
  | 'vault-locked'
  | 'proxy-required'
  | 'version-mismatch'
  | 'interface-conflict'
  | 'already-running'
  // Installed and reachable, but not running.
  | 'engine-stopped'
  // The engine started and then failed — refused, timed out, or was rejected
  // by the far side. Distinct from `config-invalid`, which is our input being
  // wrong, and from `network-unreachable`, which is the path to it.
  | 'engine-failed'
  | 'clock-skew'
  | 'exposure-unacknowledged'
  | 'unsupported'
  | 'internal'

export interface VpnBoundListener {
  kind: string
  bindHost: string
  bindPort: number
  targetHost?: string
  targetPort?: number
}

// ------------------------------------------------------- diagnose

/**
 * One line of the connectivity checklist.
 *
 * THREE WORDS AND NO FOURTH. `skipped` is not a soft `ok`: it means the check
 * did not run, it always carries the reason in `detail`, and rendering it as a
 * pass would put a green tick over a question nobody asked. That is the whole
 * reason this is a vocabulary rather than a boolean.
 */
export type VpnCheckStatus = 'ok' | 'failed' | 'skipped'

/**
 * `handshake`, `dns` and `tcp` come from the sidecar and are about the far
 * side. `ipv6` is decided HERE and is about this machine: whether traffic the
 * tunnel was supposed to carry is going somewhere else instead, which netd
 * cannot see because it has no view of the host's routing table.
 */
export type VpnCheckName = 'handshake' | 'dns' | 'tcp' | 'ipv6' | 'server'

export interface VpnDiagnoseCheck {
  name: VpnCheckName
  status: VpnCheckStatus
  /** Present on every row, including the passing ones. */
  detail: string
  /** Milliseconds for a probe, SECONDS for the handshake's age. Absent when
   *  nothing was timed, which is not the same as zero. */
  elapsed?: number
}

/** What the operator asks the probe to reach. There is no default: see
 *  `sidecar/netd/diagnose.go`. A probe that picked an address would be this app
 *  opening a connection to a third party through somebody's VPN. */
export interface VpnDiagnoseTarget {
  host?: string
  port?: number
}

export interface VpnDiagnoseResult {
  id: string
  checks: VpnDiagnoseCheck[]
  /** TCP connect time through the tunnel, present only when that check passed.
   *  NOT a ping: it includes the peer's forwarding and the far service's
   *  accept, and the field is named for what was measured. */
  latencyMs?: number
  sampledAt: number
}

/** A driver with no probe says so in words. An empty checklist would render
 *  exactly like a tunnel where everything passed. */
export interface VpnDiagnoseRefusal {
  id: string
  unsupported: string
}

export interface VpnStatus {
  id: string
  kind: VpnKind
  state: VpnState
  // Epoch ms of the last state change.
  since?: number
  // Human, actionable, already localised.
  error?: string
  // Machine-readable; drives the "how to fix" text in the UI.
  errorCode?: VpnErrorCode
  listeners?: VpnBoundListener[]
  stats?: VpnStats
  restarts: number
  /**
   * Where to go to authorise this node, while it is waiting to be authorised.
   *
   * Its own field rather than a sentence inside `error`, because it is the one
   * thing on the screen a person has to ACT on and a URL buried in a paragraph
   * cannot be clicked, copied or opened. It reached the user only as log
   * output before this — wrapped across two lines by the log viewer, in a
   * message the engine reprinted every five seconds — so completing the login
   * was, in practice, not possible from inside the app.
   *
   * Absent whenever the node is not waiting on a login, and cleared as soon as
   * it stops waiting: an authorisation link that outlives its state is an
   * invitation to authorise something twice.
   */
  authUrl?: string
}

export interface VpnResult {
  ok: boolean
  error?: string
  errorCode?: VpnErrorCode
}

export interface VpnStartResult extends VpnResult {
  listeners?: VpnBoundListener[]
}

// ------------------------------------------------------------- validation

export interface VpnValidationIssue {
  // Dotted path into the spec, e.g. 'peers[0].endpoint'.
  path: string
  severity: 'error' | 'warning'
  code: string
  message: string
}

export interface VpnValidation {
  ok: boolean
  issues: VpnValidationIssue[]
}

// ----------------------------------------------------------------- engine

export interface VpnEngineInfo {
  kind: VpnKind
  available: boolean
  path?: string
  version?: string
  sha256?: string
  bundled: boolean
  // Why it is unavailable, in words the user can act on.
  reason?: string
}

// ----------------------------------------------------------------- import

export interface StrippedDirective {
  directive: string
  reason: string
  // `removed` is dropped with a report and the import continues. `rejected`
  // fails the whole import: a profile that uses `up`/`PostUp` expects side
  // effects, so quietly discarding them and reporting success would be a lie.
  severity: 'removed' | 'rejected'
}

// What crosses IPC. Never carries key material — the main-process handler puts
// everything into the vault and returns refs.
export interface VpnImportResult {
  ok: boolean
  error?: string
  errorCode?: VpnErrorCode
  spec?: VpnSpec
  // Suggested profile name taken from the file, when there was one.
  name?: string
  stripped: StrippedDirective[]
  warnings: string[]
}

// Main-process only. The split exists so the compiler stops `secrets` from
// being returned over IPC by accident.
export interface VpnImportResultInternal extends VpnImportResult {
  secrets?: ImportedSecrets
}

// ------------------------------------------------------------- key material

// A WireGuard keypair is the one place OpsMaxx mints a secret rather than
// being handed one, so these shapes are separate on purpose.
//
// `VpnKeygenResult` carries a private key and therefore never leaves the
// machine, but it does cross IPC: the user has to be able to reveal and copy
// the key they just made, and the same channel already carries whole `.conf`
// bodies in the other direction during an import. `VpnPublicKeyResult` carries
// nothing secret at all and is what the live "what is the public half of this?"
// preview uses.
//
// `VpnMintResult` is the third: a keypair that has been made and *not* stored.
// The distinction is in the type rather than in a boolean parameter, because
// "did this write a secret to the vault" is exactly the question a reader
// should be able to answer from the call site. The absence of `privateKeyRef`
// here is the whole point — there is no ref because there is nothing to point
// at yet, and the form does not create one until the user presses Save.

export interface VpnMintResult {
  ok: boolean
  error?: string
  errorCode?: VpnErrorCode
  // base64. Held in the form, shown masked, and lost if the form is cancelled.
  privateKey?: string
  // base64. The half the user gives to their server or their provider.
  publicKey?: string
}

export interface VpnKeygenResult {
  ok: boolean
  error?: string
  errorCode?: VpnErrorCode
  // base64. Shown masked, copyable, and never persisted on the profile.
  privateKey?: string
  // base64. The half the user gives to their server or their provider.
  publicKey?: string
  // Where the private key was stored. Copy this onto `WireGuardSpec`.
  privateKeyRef?: VpnSecretRef
  vaultEntryId?: string
}

/**
 * Where an frp server token ended up in the vault.
 *
 * Named beside `VpnKeygenResult` because it is the same shape of operation —
 * a secret the renderer holds for a moment goes into the vault and only a ref
 * comes back — and deliberately NOT the same type. A keygen result carries the
 * private key back out so the user can copy the half they have to authorise
 * somewhere else; a token has no such half. Sharing the type would put an
 * optional `privateKey` on a result that must never have one.
 */
export interface FrpTokenResult {
  ok: boolean
  error?: string
  errorCode?: VpnErrorCode
  /** Copy this onto `FrpSpec.auth.tokenRef`. */
  tokenRef?: VpnSecretRef
  vaultEntryId?: string
}

export interface VpnPublicKeyResult {
  ok: boolean
  error?: string
  errorCode?: VpnErrorCode
  publicKey?: string
}

export interface ImportedSecrets {
  privateKey?: string
  presharedKeys?: Record<string, string>
  username?: string
  password?: string
  keyPassphrase?: string
  token?: string
  configBody?: string
  proxySecretKeys?: Record<string, string>
}

// ------------------------------------------------------------------- logs

export interface VpnLogLine {
  at: number
  stream: 'stdout' | 'stderr' | 'ctl' | 'app'
  text: string
}

// ------------------------------------------------------------- dependents

export type VpnDependentKind = 'server' | 'database' | 'tunnel' | 'session'

export interface VpnDependent {
  kind: VpnDependentKind
  id: string
  name: string
  // True when this is a live session rather than a stored definition, which is
  // what makes a stop destructive rather than merely inconvenient.
  live: boolean
}

// ---------------------------------------------------------------- prompts

export interface VpnPrompt {
  id: string
  profileId: string
  profileName: string
  kind: 'password' | 'otp' | 'passphrase' | 'username'
  // The engine's own wording, e.g. "Need 'Auth' username/password SC:1,Enter
  // your 6-digit code". Shown verbatim: the server chose it and the user has
  // probably seen it before in another client.
  label: string
  echo: boolean
}

// ------------------------------------------------------------------ utils

// A WireGuard key is 32 bytes, so base64 is 44 characters and the 43rd is
// constrained: it encodes only the low nibble of the last byte, shifted left
// by two, which takes the sixteen values 0, 4, ... 60 — base64
// `AEIMQUYcgkosw048`.
//
// The `048` at the end is not optional and is easy to leave off, because the
// first thirteen are letters and the last three are digits. Omitting them
// rejects 19% of legitimate keys, and the same class appears in the log
// redactor and in the sidecar, where the consequence is a private key going
// unredacted rather than a form refusing valid input. Measured over 4000 real
// X25519 keypairs: 0/4/8 turned up 252/248/270 times.
const B64_KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/

/** A WireGuard key is 32 bytes; base64 of that is 44 chars with a fixed final
 *  alphabet. Rejecting on shape here means a typo is caught in the form rather
 *  than as a silent no-handshake ten seconds later. */
export function isWireGuardKey(s: string): boolean {
  return B64_KEY.test(s.trim())
}

const CIDR4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/

export function isCidr(s: string): boolean {
  const t = s.trim()
  const m4 = CIDR4.exec(t)
  if (m4) {
    const octets = [m4[1], m4[2], m4[3], m4[4]].map(Number)
    if (octets.some((o) => o > 255)) return false
    return Number(m4[5]) <= 32
  }
  // IPv6: anything with a colon plus a /0-128 prefix. Full v6 validation is
  // the engine's job; this only has to catch fat-finger input.
  const i = t.lastIndexOf('/')
  if (i === -1) return false
  const addr = t.slice(0, i)
  const bits = Number(t.slice(i + 1))
  if (!addr.includes(':')) return false
  if (!/^[0-9a-fA-F:.]+$/.test(addr)) return false
  return Number.isInteger(bits) && bits >= 0 && bits <= 128
}

/** "vpn.example.com:51820" / "[2001:db8::1]:51820" -> parts, or null. */
export function parseVpnEndpoint(s: string): { host: string; port: number } | null {
  const t = s.trim()
  if (!t) return null
  const v6 = /^\[(.+)\]:(\d+)$/.exec(t)
  if (v6) {
    const port = Number(v6[2])
    return port > 0 && port < 65536 ? { host: v6[1], port } : null
  }
  const i = t.lastIndexOf(':')
  if (i <= 0) return null
  const host = t.slice(0, i)
  const port = Number(t.slice(i + 1))
  if (!host || host.includes(':')) return null
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) return null
  return { host, port }
}

/** A handshake older than this means the tunnel is up but not passing
 *  traffic. WireGuard rekeys well inside 180s whenever anything is flowing. */
export const WG_HANDSHAKE_STALE_SEC = 180

export function isVpnRunning(state: VpnState): boolean {
  return state !== 'stopped' && state !== 'error'
}
