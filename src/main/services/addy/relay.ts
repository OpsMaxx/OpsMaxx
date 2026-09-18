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
  /** Bearer token from login. */
  token: string
}

interface SignedHeaders {
  nonce: string
  signature: string
}

export class RelayClient {
  constructor(
    private readonly cfg: RelayConfig,
    private readonly addyd: AddySidecar
  ) {}

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
