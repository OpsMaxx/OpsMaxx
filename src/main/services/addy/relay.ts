import { AddyError, type AddySidecar } from './sidecar'

/**
 * HTTP to an addy relay, signed by the sidecar.
 *
 * Main does the transport and addyd does the signing. Every request carries a
 * bearer token from login plus a per-request authorization the device signed:
 * the token says which session, and the signature says that this device, right
 * now, meant to make this exact call. A stolen token alone buys nothing.
 */

export interface RelayConfig {
  /** `https://relay.example`. */
  baseURL: string
  /** Bearer token from login. Empty until `login()` has run. */
  token: string
  /** Accept a self-signed certificate. Development instances only — a relay
   *  run with `-dev` presents one, and refusing it would make the local
   *  end-to-end test impossible to run at all. */
  insecureTLS?: boolean
}

/**
 * The wire contract this build speaks, sent on every request.
 *
 * Equal to `ProtocolVersion` in `sidecar/addyd/protocol/version.go` —
 * addyRelayContract.test.ts reads both and fails if they drift. A relay that
 * speaks a different version answers 426, which is turned into
 * `version-mismatch` below; a relay older than the header ignores it.
 */
export const ADDY_PROTOCOL = 'addy-protocol-v1'

/** The largest request body the relay reads (`maxBody` in its api/auth.go).
 *  It answers 413 past this rather than truncating. */
export const MAX_REQUEST_BYTES = 8 * 1024 * 1024

let insecureAgent: unknown = null

/**
 * Every HTTP call to a relay, signed or not, goes through here.
 *
 * Four call sites used to build their own `fetch` — login, signed requests,
 * account creation and the pairing rendezvous — and each had its own idea of
 * what a failure meant. Only one of them honoured the development relay's
 * self-signed certificate, so `-dev` worked for login and failed for the two
 * calls a new device makes first. One function means one place for the TLS
 * choice, the protocol header, and the answers that mean the same thing on
 * every route: 426 and 413.
 *
 * The insecure dispatcher is built once. One per request would open a fresh
 * connection pool for every call and never close any of them.
 */
export async function relayFetch(
  url: string,
  init: RequestInit,
  insecureTLS = false
): Promise<Response> {
  let dispatcher: unknown
  if (insecureTLS) {
    if (insecureAgent === null) {
      const { Agent } = await import('undici')
      insecureAgent = new Agent({ connect: { rejectUnauthorized: false } })
    }
    dispatcher = insecureAgent
  }
  const headers = new Headers(init.headers)
  headers.set('x-addy-protocol', ADDY_PROTOCOL)
  let resp: Response
  try {
    resp = await fetch(url, { ...init, headers, ...(dispatcher ? { dispatcher } : {}) } as RequestInit)
  } catch (err) {
    // An abort is the caller's own decision, not a relay failure, and the
    // caller knows what it meant.
    if (init.signal?.aborted) throw err
    // A relay that cannot be reached is the commonest failure by a wide
    // margin -- a laptop on a train, a box being restarted -- and it has its
    // own code so a caller can retry rather than alarm.
    throw new AddyError(
      'relay-unreachable',
      `could not reach ${new URL(url).origin}: ${whyFetchFailed(err)}`
    )
  }
  if (resp.status === 426) {
    throw new AddyError(
      'version-mismatch',
      `${new URL(url).origin} speaks a different addy protocol version than this copy of OpsMaxx (${ADDY_PROTOCOL}). Update OpsMaxx, or ask whoever runs the relay to update it.`
    )
  }
  if (resp.status === 413) {
    throw new AddyError(
      'too-large',
      `that is too large for the relay, which accepts at most ${MAX_REQUEST_BYTES / 1024 / 1024} MB in one request.`
    )
  }
  return resp
}

/** The relay's own explanation, from its JSON error body. Empty when there is
 *  none — a body that is not JSON is not worth a second failure. */
export async function relayDetail(resp: Response): Promise<string> {
  try {
    const body = (await resp.clone().json()) as { error?: unknown }
    return typeof body.error === 'string' ? body.error : ''
  } catch {
    return ''
  }
}

/**
 * Whether a 401 means "this session is gone" rather than "this request is
 * not authorised".
 *
 * Sessions live in the relay's memory for twelve hours and die with it on a
 * restart. Before this, that was indistinguishable from a forged request: every
 * call answered `not-paired` until somebody pressed Try again, and the sync
 * timer, the clipboard and revocation detection all stopped in silence.
 *
 * Only the two answers the relay gives BEFORE it looks at the signature count.
 * A signature that does not verify, a replayed nonce or a malformed session is
 * a refusal of this device's proof, and logging in again to retry it would be
 * the client arguing with the check. A body that cannot be read at all is given
 * the benefit of the doubt — the retry is bounded to once per request, so the
 * worst it costs is one login.
 */
async function sessionGone(resp: Response): Promise<boolean> {
  if (resp.status !== 401) return false
  let error: unknown
  try {
    error = ((await resp.clone().json()) as { error?: unknown }).error
  } catch {
    return true
  }
  if (typeof error !== 'string') return true
  return error.startsWith('unknown or expired session') || error.startsWith('no bearer token')
}

/**
 * Compares the key a relay presents with the one this device recorded.
 *
 * Returns false when there is nothing to do (no pin yet, or the same key),
 * true when the key changed and should be re-pinned, and throws when it
 * changed and nothing vouches for the new one. The reasoning is at the call
 * site in session.ts, where the audit record is written.
 */
export function comparePin(known: string | undefined, seen: ServerPin, baseURL: string): boolean {
  if (!known || known === seen.spki) return false
  if (!seen.webpki) {
    throw new AddyError(
      'relay-unreachable',
      `the relay at ${baseURL} is presenting a different TLS key than the one this device recorded when it joined, and its certificate is not one a public authority vouches for. Either it was replaced, or something is between you and it. Nothing was sent.`
    )
  }
  return true
}

/** What the relay answers a login with. */
export interface LoginResult {
  token: string
  /** SHA-256 of the instance's TLS SubjectPublicKeyInfo, hex. The pin this
   *  login was bound to, kept so a later reconnect can notice it changed. */
  spki: string
}

/** The relay's TLS key as one connection saw it. */
export interface ServerPin {
  spki: string
  /** Whether the chain validated against the public CA store for the relay's
   *  hostname. False only on a development relay reached with `insecureTLS`,
   *  where nothing checked it. */
  webpki: boolean
}

interface SignedHeaders {
  nonce: string
  signature: string
}

/**
 * Why a fetch failed, in words, including the ones Node hides.
 *
 * `fetch` rejects with a TypeError whose `message` is "fetch failed" — or, for
 * several transport errors, EMPTY — and puts the reason a person could act on
 * in `cause`: ECONNREFUSED, ENOTFOUND, a TLS mismatch. Reading only `message`
 * produced "could not reach https://relay.example: " with nothing after the
 * colon, which tells somebody there is a problem and refuses to say what.
 */
export function whyFetchFailed(err: unknown): string {
  const parts: string[] = []
  let cur: unknown = err
  for (let depth = 0; depth < 4 && cur !== null && cur !== undefined; depth++) {
    if (cur instanceof Error) {
      const m = cur.message.trim()
      if (m !== '' && !parts.includes(m)) parts.push(m)
      const code = (cur as { code?: unknown }).code
      if (typeof code === 'string' && !parts.includes(code)) parts.push(code)
      cur = (cur as { cause?: unknown }).cause
      continue
    }
    const t = String(cur).trim()
    if (t !== '' && t !== '[object Object]' && !parts.includes(t)) parts.push(t)
    break
  }
  // Never empty. "the connection failed with no reason given" is still a
  // sentence somebody can report; a bare colon is not.
  return parts.length > 0 ? parts.join(' — ') : 'the connection failed with no reason given'
}

export class RelayClient {
  constructor(
    private cfg: RelayConfig,
    private readonly addyd: AddySidecar,
    /**
     * Logs in again when the relay has forgotten this session, and must apply
     * every check a first login does — the TLS pin above all. Supplied by the
     * session, which owns the pin; absent, an expired session is reported as
     * it always was.
     */
    private readonly reauth?: () => Promise<void>
  ) {}

  /** One re-login shared by every request that found the session gone at the
   *  same moment, rather than one login each. */
  private reauthing: Promise<void> | null = null

  /** The token this client is using, so a session can persist it. */
  get token(): string {
    return this.cfg.token
  }

  /** The relay this client talks to, for the unauthenticated rendezvous a
   *  pairing uses — a joining device has no account yet, which is the point. */
  get baseURL(): string {
    return this.cfg.baseURL
  }

  /**
   * SHA-256 of the instance's TLS SubjectPublicKeyInfo.
   *
   * The login signature is bound to this, which is what stops a relay that
   * terminates TLS somewhere else replaying a login it watched. It must be
   * computed exactly as the relay computes it — over
   * `RawSubjectPublicKeyInfo` of the LEAF certificate — so this goes through
   * `X509Certificate.publicKey` exported as SPKI DER rather than through any
   * of Node's friendlier certificate fields, which are not that structure.
   *
   * A raw TLS connection rather than `fetch`, because `fetch` does not expose
   * the peer certificate at all.
   */
  async serverPin(): Promise<ServerPin> {
    const url = new URL(this.cfg.baseURL)
    const port = url.port ? Number(url.port) : 443
    const { connect } = await import('node:tls')
    const { X509Certificate, createHash } = await import('node:crypto')

    return new Promise<ServerPin>((resolve, reject) => {
      const socket = connect(
        {
          host: url.hostname,
          port,
          servername: url.hostname,
          rejectUnauthorized: !this.cfg.insecureTLS
        },
        () => {
          const der = socket.getPeerCertificate()?.raw
          // Read rather than inferred from `rejectUnauthorized`: with it off,
          // a certificate that happens to be valid still reports true, and one
          // that is not reports false instead of failing the connection.
          const webpki = socket.authorized
          socket.end()
          if (!der || der.length === 0) {
            reject(new AddyError('relay-unreachable', 'the relay presented no certificate.'))
            return
          }
          const spki = new X509Certificate(der).publicKey.export({ type: 'spki', format: 'der' })
          resolve({ spki: createHash('sha256').update(spki).digest('hex'), webpki })
        }
      )
      socket.setTimeout(10_000, () => {
        socket.destroy()
        reject(new AddyError('relay-unreachable', `${this.cfg.baseURL} did not answer in time.`))
      })
      socket.on('error', (e: Error) =>
        reject(new AddyError('relay-unreachable', `${this.cfg.baseURL}: ${e.message}`))
      )
    })
  }

  /**
   * Trade a signed challenge for a bearer token.
   *
   * THIS IS WHAT WAS MISSING. Every authorised call carried
   * `Bearer ${this.cfg.token}` and the token was the empty string at both
   * sites that built a client, so every one of them was unauthenticated. The
   * comment at the top of this file described a login that did not exist.
   *
   * Two round trips, because the server's nonce has to exist before the
   * device can sign it: ask for a challenge, sign it together with the TLS
   * pin and a timestamp, present the signature. The device key never leaves
   * the sidecar — main does the transport and addyd does the signing.
   */
  async login(checkPin?: (pin: ServerPin) => void): Promise<LoginResult> {
    const pin = await this.serverPin()
    // BEFORE anything is signed or sent: a caller that refuses this key must be
    // able to say "nothing was sent" and have it be true.
    checkPin?.(pin)
    const spki = pin.spki

    // The account and device are what the server needs to find the key it will
    // verify against. `whoami` names them `accountId` and `devicePub`; the
    // wire wants `account` and `device`, so the mapping is explicit rather
    // than a spread that would silently send the wrong field names.
    const me = await this.addyd.send<{ accountId: string; devicePub: string }>('whoami', {})
    const challenge = await this.raw('POST', '/v1/auth/challenge', {
      account: me.accountId,
      device: me.devicePub
    })
    if (!challenge.ok) throw await loginError(challenge, this.cfg.baseURL)
    const { nonce } = (await challenge.json()) as { nonce?: string }
    if (!nonce) {
      throw new AddyError('relay-unreachable', 'the relay issued no login challenge.')
    }

    const signed = await this.addyd.send<{
      account: string
      device: string
      deviceNonce: string
      ts: number
      signature: string
    }>('signLogin', { serverNonce: nonce, serverSPKI: spki })

    const resp = await this.raw('POST', '/v1/auth/login', {
      account: signed.account,
      device: signed.device,
      device_nonce: signed.deviceNonce,
      server_nonce: nonce,
      server_spki: spki,
      ts: signed.ts,
      signature: signed.signature
    })
    if (!resp.ok) throw await loginError(resp, this.cfg.baseURL)
    const { token } = (await resp.json()) as { token?: string }
    if (!token) throw new AddyError('relay-unreachable', 'the relay issued no token.')

    this.cfg = { ...this.cfg, token }
    return { token, spki }
  }

  /**
   * An UNSIGNED request, for the two calls that happen before there is a
   * session to sign with. Everything else goes through `request`.
   *
   * The challenge and the login are the only calls the relay accepts without
   * an authorization, and necessarily so: the signature they would carry is
   * the thing being established.
   */
  private async raw(method: string, path: string, body: unknown): Promise<Response> {
    return relayFetch(
      `${this.cfg.baseURL}${path}`,
      { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      this.cfg.insecureTLS
    )
  }

  /**
   * One signed request.
   *
   * The signature covers the method, the PATH WITHOUT ITS QUERY, and a hash of
   * the body. The server rebuilds the same structure from its own view of the
   * request and compares, so signing the query would sign something it never
   * reconstructs -- the sidecar refuses a path carrying one rather than
   * trimming it silently.
   */
  private async signed(
    method: string,
    path: string,
    body?: Buffer
  ): Promise<SignedHeaders> {
    return this.addyd.send<SignedHeaders>('signRequest', {
      method,
      path,
      body: body ? body.toString('base64') : ''
    })
  }

  async request(
    method: string,
    pathWithQuery: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {}
  ): Promise<Response> {
    const resp = await this.send(method, pathWithQuery, body, extraHeaders)
    if (!this.reauth || !(await sessionGone(resp))) return resp
    // ONCE, and then whatever the relay says stands. A login that fails throws
    // its own error, which says more than the 401 it replaces; a retry that
    // still 401s is reported as before rather than looping.
    this.reauthing ??= this.reauth().finally(() => {
      this.reauthing = null
    })
    await this.reauthing
    return this.send(method, pathWithQuery, body, extraHeaders)
  }

  private async send(
    method: string,
    pathWithQuery: string,
    body: unknown,
    extraHeaders: Record<string, string>
  ): Promise<Response> {
    /**
     * SIGNED OVER THE DECODED PATH, because that is what the far end checks.
     *
     * The relay verifies against Go's `r.URL.Path`, which is percent-DECODED
     * — so a name containing anything `encodeURIComponent` escapes is signed
     * one way and verified another. With only `servers` and `escrow` in play
     * nothing escaped and it never showed; the first object name with a colon
     * in it (`transfer:<id>`) produced a 401 that reads exactly like a bad
     * token, on a request whose token was fine.
     *
     * Decoded here rather than by dropping the encoding from the URL: the URL
     * must stay escaped or a name with a `/` in it would address a different
     * route entirely.
     */
    const raw = pathWithQuery.split('?')[0]
    let path: string
    try {
      path = decodeURIComponent(raw)
    } catch {
      // A malformed escape is not something to sign a guess about. Sent as-is
      // so the relay refuses it, rather than silently signing something else.
      path = raw
    }
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
    const { nonce, signature } = await this.signed(method, path, payload)

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.cfg.token}`,
      'x-addy-nonce': nonce,
      'x-addy-signature': signature,
      ...extraHeaders
    }
    if (payload) headers['content-type'] = 'application/json'

    const resp = await relayFetch(
      this.cfg.baseURL + pathWithQuery,
      { method, headers, body: payload ?? undefined },
      this.cfg.insecureTLS
    )

    if (resp.status === 503 && resp.headers.get('x-addy-reonboard')) {
      // The relay was panicked or reset. Not a transport failure and not an
      // auth failure: a client that retried either way would loop against a
      // box somebody deliberately took out of service.
      throw new AddyError(
        'relay-unreachable',
        `this relay was reset or panicked at ${resp.headers.get('x-addy-reonboard')} and is not serving until an operator has re-checked its devices`
      )
    }
    return resp
  }

  /** Reads an object, or null when the relay has none. */
  async getObject(name: string, epoch: number): Promise<{ body: Buffer; etag: string } | null> {
    const resp = await this.request('GET', `/v1/obj/${encodeURIComponent(name)}?epoch=${epoch}`)
    if (resp.status === 404) return null
    if (!resp.ok) throw await relayError(resp, `reading ${name}`)
    const json = (await resp.json()) as { body: string; etag: string }
    return { body: Buffer.from(json.body, 'base64'), etag: json.etag }
  }

  /** Writes an object. `ifMatch` makes it conditional. */
  async putObject(
    name: string,
    epoch: number,
    counter: number,
    sealed: Buffer,
    ifMatch?: string
  ): Promise<string> {
    const resp = await this.request(
      'PUT',
      `/v1/obj/${encodeURIComponent(name)}`,
      { epoch, counter, body: sealed.toString('base64') },
      ifMatch ? { 'if-match': ifMatch } : {}
    )
    if (resp.status === 409) {
      // Somebody else wrote first. Distinct from every other refusal, because
      // the remedy is a conflict chooser rather than a retry — and its own
      // CODE, so the sync engine asks the code rather than matching words in
      // a message somebody might reasonably reword.
      throw new AddyError('conflict', `${name} was written by another device first`)
    }
    if (!resp.ok) throw await relayError(resp, `writing ${name}`)
    return resp.headers.get('etag') ?? ''
  }

  /**
   * Deletes an object in every epoch. Absent already counts as done: the
   * caller wants it gone, and a retry after a lost response must not fail.
   */
  async deleteObject(name: string): Promise<void> {
    const resp = await this.request('DELETE', `/v1/obj/${encodeURIComponent(name)}`)
    if (resp.status === 404 || resp.ok) return
    throw await relayError(resp, `deleting ${name}`)
  }

  /**
   * Hands over a copy whose conditional PUT lost, still sealed.
   *
   * Called by the LOSER, immediately after its 409, and that timing is the
   * whole point: those bytes exist nowhere else at that moment, and a client
   * that simply gave up on the 409 would throw away the edit somebody made.
   * The relay stores the ciphertext, records which device wrote it and when,
   * and cannot read a byte of it — deciding between the copies needs the epoch
   * key, so it happens in the chooser and never here.
   */
  async keepConflict(name: string, epoch: number, counter: number, sealed: Buffer): Promise<void> {
    const resp = await this.request('POST', `/v1/obj/${encodeURIComponent(name)}/conflict`, {
      epoch,
      counter,
      body: sealed.toString('base64')
    })
    if (!resp.ok) throw await relayError(resp, `keeping a conflict copy of ${name}`)
  }

  /**
   * Append one entry to the roster.
   *
   * The server checks contiguity and NOTHING else — it holds no key and does
   * not pretend to. Every client verifies the chain from genesis before
   * trusting any of it, so a forged entry is caught there rather than here.
   */
  async appendRoster(seq: number, entry: string): Promise<void> {
    const resp = await this.request('POST', '/v1/roster', { seq, entry })
    if (!resp.ok) throw await relayError(resp, 'adding the device to the roster')
  }

  /** The roster, as bytes. Verification happens in the sidecar, under keys the
   *  caller holds -- never against anything this response contains. */
  async roster(from = 0): Promise<string> {
    const resp = await this.request('GET', `/v1/roster?from=${from}`)
    if (!resp.ok) throw await relayError(resp, 'reading the roster')
    return ((await resp.json()) as { chain: string }).chain
  }
}

/**
 * A refusal, typed by what the caller can do about it.
 *
 * 401/403 used to be the only distinction made, and everything else became
 * `internal` with the status code — so a full relay, whose 507 body says which
 * quota and why, reached the panel as "internal: 507" and the explanation was
 * thrown away. The relay's own sentence is kept in every case.
 */
export async function relayError(resp: Response, what: string): Promise<AddyError> {
  const detail = (await relayDetail(resp)) || resp.statusText
  const code =
    resp.status === 401 || resp.status === 403
      ? 'not-paired'
      : resp.status === 409
        ? 'conflict'
        : resp.status === 507
          ? 'quota-exceeded'
          : resp.status >= 500
            ? 'relay-unreachable'
            : 'internal'
  return new AddyError(code, `${what}: ${resp.status} ${detail}`)
}

/**
 * Why a login was refused, without calling every refusal "unreachable".
 *
 * A relay that answered was reachable. A 401 is the relay declining this
 * device — removed from the account, or never on it — and saying "could not
 * reach" sent people checking their network for a problem that was not there.
 */
async function loginError(resp: Response, baseURL: string): Promise<AddyError> {
  const detail = await relayDetail(resp)
  if (resp.status === 401 || resp.status === 403) {
    return new AddyError(
      'not-paired',
      `${baseURL} refused this device's sign-in${detail ? ` (${detail})` : ''}. ` +
        'If this device was removed from the account on another machine, that is why; otherwise pair it again.'
    )
  }
  return new AddyError(
    resp.status >= 500 ? 'relay-unreachable' : 'internal',
    `${baseURL} could not sign this device in: ${resp.status}${detail ? ` ${detail}` : ''}`
  )
}
