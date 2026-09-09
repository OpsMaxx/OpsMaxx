// The RDP domain, shared by main, preload and the renderer.
//
// Why RDP is a property of a saved `Server` rather than a record of its own:
// the thing being connected to is a machine the user has already described --
// it has a host, a workspace, a folder, a route through a bastion, maybe a VPN.
// A second record type would restate all of that and then disagree with it. So
// a server that speaks RDP carries `rdp`, the same way a files-only account
// carries `sftpOnly`, and everything that resolves a host keeps working.
//
// What is genuinely new is the *session*: RDP is not a shell, so it gets its
// own tab kind and its own view rather than a fourth PanelView on a tab whose
// other views assume an SSH transport.

/** RDP settings on a server that speaks it. Absent means the server does not. */
export interface RdpSettings {
  /** 3389 unless someone moved it. Separate from `Server.port`, which is SSH's. */
  port: number
  /**
   * Windows domain for the login, when the account is a domain account.
   *
   * Empty and undefined both mean "no domain", which is what a local account
   * or an Entra-joined machine wants. Stored rather than parsed out of a
   * `DOMAIN\user` username so that a username containing a backslash for any
   * other reason is not silently reinterpreted.
   */
  domain?: string
  /**
   * Use Network Level Authentication (CredSSP).
   *
   * Defaults to on, because every supported Windows Server has required it by
   * policy for years and connecting without it against such a host fails in a
   * way that looks like a wrong password. It is a setting rather than a
   * constant because the other common RDP target -- xrdp on Linux -- is not a
   * CredSSP server at all and cannot be reached with it on.
   */
  nla: boolean
  /**
   * MS-KKDCP proxy for Kerberos, when the target requires Kerberos rather than
   * accepting NTLM.
   *
   * The session runs in the renderer, which has no SSPI and no ticket cache, so
   * a Kerberos-only host is unreachable without one of these. Absent means
   * NTLM, which is what a standalone or workgroup machine uses anyway.
   */
  kdcProxyUrl?: string
}

/** Where a session should draw. Sent to main so the first frame is the right size. */
export interface RdpDesktopSize {
  width: number
  height: number
}

/**
 * What the renderer needs to open a session, minted by main.
 *
 * The renderer never learns the password: it goes into the CredSSP exchange
 * inside the WASM client, which means it *does* cross this boundary. What it
 * does not do is come from the renderer -- main resolves it from the vault
 * against the server record, so a renderer cannot ask to authenticate as
 * someone else.
 */
export interface RdpTicket {
  /**
   * One-shot bearer token. Travels twice: as a query parameter on the
   * WebSocket upgrade, and inside the RDCleanPath request's `proxy_auth`
   * field, where the relay checks it against the destination it was minted
   * for. Spent on first use and expired after `expiresInMs`.
   */
  token: string
  /** `ws://127.0.0.1:<port>/rdp` -- loopback, on a port chosen at listen time. */
  proxyUrl: string
  /** `host:port` the relay will dial. The client repeats it; the relay verifies. */
  destination: string
  username: string
  password: string
  domain?: string
  nla: boolean
  kdcProxyUrl?: string
  expiresInMs: number
}

export type RdpErrorCode =
  /** The server record is gone, or has no `rdp` settings. */
  | 'no-target'
  /** No password could be resolved for the account. */
  | 'no-credentials'
  /** The capability is denied for this workspace or this caller. */
  | 'denied'
  /** The relay could not be started. */
  | 'relay-unavailable'

export interface RdpTicketResult {
  ok: boolean
  ticket?: RdpTicket
  code?: RdpErrorCode
  error?: string
}
