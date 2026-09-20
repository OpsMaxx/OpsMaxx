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

/** What the relay answers a login with. */
export interface LoginResult {
  token: string
  /** SHA-256 of the instance's TLS SubjectPublicKeyInfo, hex. The pin this
   *  login was bound to, kept so a later reconnect can notice it changed. */
  spki: string
}

interface SignedHeaders {
  nonce: string
  signature: string
}

export class RelayClient {
  constructor(
    private cfg: RelayConfig,
    private readonly addyd: AddySidecar
  ) {}

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
  async serverPin(): Promise<string> {
    const url = new URL(this.cfg.baseURL)
    const port = url.port ? Number(url.port) : 443
    const { connect } = await import('node:tls')
    const { X509Certificate, createHash } = await import('node:crypto')

    return new Promise<string>((resolve, reject) => {
      const socket = connect(
        {
          host: url.hostname,
          port,
          servername: url.hostname,
          rejectUnauthorized: !this.cfg.insecureTLS
        },
        () => {
          const der = socket.getPeerCertificate()?.raw
          socket.end()
          if (!der || der.length === 0) {
            reject(new AddyError('relay-unreachable', 'the relay presented no certificate.'))
            return
          }
          const spki = new X509Certificate(der).publicKey.export({ type: 'spki', format: 'der' })
          resolve(createHash('sha256').update(spki).digest('hex'))
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
  async login(): Promise<LoginResult> {
    const spki = await this.serverPin()

    // The account and device are what the server needs to find the key it will
    // verify against. `whoami` names them `accountId` and `devicePub`; the
    // wire wants `account` and `device`, so the mapping is explicit rather
    // than a spread that would silently send the wrong field names.
    const me = await this.addyd.send<{ accountId: string; devicePub: string }>('whoami', {})
    const challenge = await this.raw('POST', '/v1/auth/challenge', {
      account: me.accountId,
      device: me.devicePub
    })
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
    if (!resp.ok) {
      throw new AddyError('relay-unreachable', `the relay refused the login: ${resp.status}.`)
    }
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
    return fetch(`${this.cfg.baseURL}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(await this.tlsOptions())
    })
  }

  /**
   * The dispatcher a development relay needs, and nothing otherwise.
   *
   * A relay started with `-dev` presents a self-signed certificate. Refusing
   * it would make the local end-to-end test impossible to run, and running
   * that test is the only way anyone can say this works. Guarded on an
   * explicit flag that the setup screen has to set deliberately — it is never
   * inferred from a failure, because "the certificate did not verify" is
   * exactly the condition it must not silently paper over.
   */
  private async tlsOptions(): Promise<Record<string, unknown>> {
    if (!this.cfg.insecureTLS) return {}
    const { Agent } = await import('undici')
    return { dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) }
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
    const path = pathWithQuery.split('?')[0]
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
    const { nonce, signature } = await this.signed(method, path, payload)

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.cfg.token}`,
      'x-addy-nonce': nonce,
      'x-addy-signature': signature,
      ...extraHeaders
    }
    if (payload) headers['content-type'] = 'application/json'

    let resp: Response
    try {
      resp = await fetch(this.cfg.baseURL + pathWithQuery, {
        method,
        headers,
        body: payload ?? undefined
      })
    } catch (err) {
      // A relay that cannot be reached is the commonest failure by a wide
      // margin -- a laptop on a train, a box being restarted -- and it has its
      // own code so a caller can retry rather than alarm.
      throw new AddyError(
        'relay-unreachable',
        `could not reach ${this.cfg.baseURL}: ${err instanceof Error ? err.message : String(err)}`
      )
    }

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
      // the remedy is a conflict chooser rather than a retry.
      throw new AddyError('internal', `${name} was written by another device first`)
    }
    if (resp.status === 507) {
      throw new AddyError('quota-exceeded', `the relay has no room for ${name}`)
    }
    if (!resp.ok) throw await relayError(resp, `writing ${name}`)
    return resp.headers.get('etag') ?? ''
  }

  /**
   * The transition entry that announced one epoch, from the roster.
   *
   * Fetched as bytes and returned verbatim, because the sidecar needs the
   * entry ITSELF rather than a summary of it: the flag saying whether this was
   * a revocation lives in it, and a chained handoff must be refused for one of
   * those. A caller that passed along "it was a revocation, honestly" would be
   * passing along the relay's word for the one thing the relay must not decide.
   *
   * Null when the chain has no such transition, which is the ordinary state
   * for an account that has never rotated.
   */
  async transitionFor(epoch: number): Promise<string | null> {
    const chain = Buffer.from(await this.roster(), 'base64')
    const found = await this.addyd.send<{ entry: string | null }>('findTransition', {
      chain: chain.toString('base64'),
      epoch
    })
    return found.entry
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
    if (resp.status === 507) {
      throw new AddyError('quota-exceeded', `the relay has no room to keep a copy of ${name}`)
    }
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

async function relayError(resp: Response, what: string): Promise<AddyError> {
  let detail = resp.statusText
  try {
    const body = (await resp.json()) as { error?: string }
    if (body.error) detail = body.error
  } catch {
    /* a body that is not JSON is not worth a second failure */
  }
  const code = resp.status === 401 || resp.status === 403 ? 'not-paired' : 'internal'
  return new AddyError(code, `${what}: ${resp.status} ${detail}`)
}
