import { describe, it, expect, afterEach, afterAll, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The client's half of the relay contract, exercised against the call rather
 * than the source text.
 *
 * Every item here was a place the two sides disagreed and the client's tests
 * did not notice, because they mocked the relay to say whatever the client
 * expected: a signal published with GET and a body, a 100 MB transfer cap over
 * an 8 MiB request limit, a 401 that meant "your session expired" read as "this
 * device is not paired", a changed TLS key that locked every device out.
 */

const userData = mkdtempSync(join(tmpdir(), 'opsmaxx-addy-contract-'))
vi.mock('electron', () => ({ app: { getPath: () => userData }, clipboard: {} }))

const relayMod = await import('../src/main/services/addy/relay')
const { RelayClient, relayFetch, comparePin, ADDY_PROTOCOL, MAX_REQUEST_BYTES } = relayMod
const { AddyError } = await import('../src/main/services/addy/sidecar')
const transfer = await import('../src/main/services/addy/transfer')
const { dialPeer, answerPeer } = await import('../src/main/services/addy/p2p')
const { receive } = await import('../src/main/services/addy/pairing')

afterEach(() => vi.unstubAllGlobals())
afterAll(() => rmSync(userData, { recursive: true, force: true }))

const json = (status: number, body: unknown): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })

/** A sidecar that signs nothing, for a RelayClient under test. */
const signer = {
  alive: () => true,
  close: async () => undefined,
  send: async () => ({ nonce: '00'.repeat(32), signature: '00'.repeat(64) })
} as unknown as import('../src/main/services/addy/sidecar').AddySidecar

describe('the protocol version travels with every request', () => {
  it('is the version the vendored protocol package declares', () => {
    const go = readFileSync(
      join(__dirname, '..', 'sidecar', 'addyd', 'protocol', 'version.go'),
      'utf8'
    )
    const declared = /const ProtocolVersion = "([^"]+)"/.exec(go)?.[1]
    expect(declared, 'the parser is wrong, not the code').toBeTruthy()
    expect(ADDY_PROTOCOL).toBe(declared)
  })

  it('is sent, and a 426 becomes version-mismatch rather than a generic failure', async () => {
    let seen: string | null = null
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      seen = new Headers(init.headers).get('x-addy-protocol')
      return json(426, { error: 'this relay speaks addy-protocol-v2' })
    })
    const err = await relayFetch('https://relay.example/v1/roster', { method: 'GET' }).catch((e) => e)
    expect(seen).toBe(ADDY_PROTOCOL)
    expect(err).toBeInstanceOf(AddyError)
    expect(err.code).toBe('version-mismatch')
  })

  it('a 413 says it is too large, not that the device is unpaired', async () => {
    vi.stubGlobal('fetch', async () => json(413, { error: 'a request body is at most 8388608 bytes' }))
    const err = await relayFetch('https://relay.example/v1/obj/x', { method: 'PUT' }).catch((e) => e)
    expect(err.code).toBe('too-large')
    expect(err.message).toMatch(/8 MB/)
  })
})

describe('a session the relay has forgotten is renewed, once', () => {
  /** A relay whose first answers are scripted, then 200. */
  function scripted(...first: Response[]): { calls: string[] } {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${new URL(url).pathname}`)
      return first.shift() ?? json(200, { chain: '' })
    })
    return { calls }
  }

  it('logs in again on "unknown or expired session" and retries the request', async () => {
    const { calls } = scripted(json(401, { error: 'unknown or expired session' }))
    const reauth = vi.fn(async () => undefined)
    const relay = new RelayClient({ baseURL: 'https://r.example', token: 't' }, signer, reauth)
    await expect(relay.roster()).resolves.toBe('')
    expect(reauth).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['GET /v1/roster', 'GET /v1/roster'])
  })

  it('does not argue with a signature the relay refused', async () => {
    scripted(json(401, { error: 'request authorization: signature does not verify' }))
    const reauth = vi.fn(async () => undefined)
    const relay = new RelayClient({ baseURL: 'https://r.example', token: 't' }, signer, reauth)
    const err = await relay.roster().catch((e) => e)
    expect(reauth).not.toHaveBeenCalled()
    expect(err.code).toBe('not-paired')
  })

  it('retries only once, and concurrent requests share one login', async () => {
    const gone = (): Response => json(401, { error: 'unknown or expired session' })
    scripted(gone(), gone(), gone(), gone())
    const reauth = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
    const relay = new RelayClient({ baseURL: 'https://r.example', token: 't' }, signer, reauth)
    // Both find the session gone, share one login, and each retries once —
    // the retries get the 3rd and 4th 401s and stop there.
    const results = await Promise.all([relay.roster().catch((e) => e), relay.roster().catch((e) => e)])
    expect(reauth).toHaveBeenCalledTimes(1)
    for (const r of results) expect(r.code).toBe('not-paired')
  })
})

describe('typed refusals', () => {
  it('a lost conditional write is a conflict, and a full relay keeps its explanation', async () => {
    vi.stubGlobal('fetch', async () => json(409, { error: 'etag mismatch' }))
    const relay = new RelayClient({ baseURL: 'https://r.example', token: 't' }, signer)
    const lost = await relay.putObject('servers', 1, 2, Buffer.from('x'), 'e1').catch((e) => e)
    expect(lost.code).toBe('conflict')

    vi.stubGlobal('fetch', async () =>
      json(507, { error: "store: this write would exceed the account's quota" })
    )
    const full = await relay.putObject('servers', 1, 2, Buffer.from('x')).catch((e) => e)
    expect(full.code).toBe('quota-exceeded')
    expect(full.message).toMatch(/exceed the account's quota/)
  })

  it('deleting an object that is already gone is not a failure', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push(`${init.method} ${new URL(url).pathname}${new URL(url).search}`)
      return json(404, { error: 'store: no such object' })
    })
    const relay = new RelayClient({ baseURL: 'https://r.example', token: 't' }, signer)
    await expect(relay.deleteObject('transfer:abc')).resolves.toBeUndefined()
    expect(seen).toEqual(['DELETE /v1/obj/transfer%3Aabc'])
  })
})

describe('a changed TLS key', () => {
  const was = 'aa'.repeat(32)
  const now = 'bb'.repeat(32)

  it('is re-pinned when the public CA store vouches for it', () => {
    expect(comparePin(was, { spki: now, webpki: true }, 'https://r.example')).toBe(true)
  })

  it('is refused when nothing checked the certificate', () => {
    expect(() => comparePin(was, { spki: now, webpki: false }, 'https://r.example')).toThrow(
      /different TLS key/
    )
  })

  it('is nothing at all when it has not changed or was never recorded', () => {
    expect(comparePin(was, { spki: was, webpki: false }, 'https://r.example')).toBe(false)
    expect(comparePin(undefined, { spki: now, webpki: false }, 'https://r.example')).toBe(false)
  })
})

describe('a transfer fits in one request', () => {
  it('the largest file allowed, sealed and encoded, is under the relay limit', () => {
    // The body putObject sends, built the way it builds it, at an epoch far
    // beyond any real account's so its digits are not the slack.
    const sealed = Buffer.alloc(transfer.MAX_TRANSFER_BYTES + transfer.TRANSFER_SEAL_OVERHEAD)
    const body = JSON.stringify({ epoch: 2 ** 40, counter: 1, body: sealed.toString('base64') })
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_REQUEST_BYTES)
    // And not needlessly under it: a cap far below the limit is a feature
    // nobody can use.
    expect(transfer.MAX_TRANSFER_BYTES).toBeGreaterThan(6 * 1024 * 1024 - 64 * 1024)
  })

  it('refuses a larger file before sealing it', async () => {
    const path = join(userData, 'big.bin')
    writeFileSync(path, Buffer.alloc(transfer.MAX_TRANSFER_BYTES + 1))
    const err = await transfer
      .sendFile(
        { addyd: signer as never, relay: {} as never, epoch: () => 1, peers: () => ['bb'.repeat(32)] },
        path,
        'bb'.repeat(32)
      )
      .catch((e) => e)
    expect(err.code).toBe('too-large')
  })

  it('takes back the uploaded bytes when the notice is refused', async () => {
    const path = join(userData, 'small.txt')
    writeFileSync(path, 'hello')
    const deleted: string[] = []
    const relay = {
      putObject: async () => 'e1',
      request: async () => json(507, { error: 'that device has too much undelivered mail' }),
      deleteObject: async (name: string) => {
        deleted.push(name)
      }
    }
    const sidecar = { send: async () => ({ sealed: Buffer.from('x').toString('base64') }) }
    const err = await transfer
      .sendFile(
        { addyd: sidecar as never, relay: relay as never, epoch: () => 1, peers: () => ['bb'.repeat(32)] },
        path,
        'bb'.repeat(32)
      )
      .catch((e) => e)
    expect(err.code).toBe('quota-exceeded')
    expect(err.message).toMatch(/too much undelivered mail/)
    expect(deleted).toHaveLength(1)
    expect(deleted[0]).toMatch(/^transfer:[0-9a-f]+$/)
  })
})

describe('mail nobody can use is acknowledged', () => {
  it('drops mail from non-members, of unknown kinds and that will not open — and leaves member clipboards alone', async () => {
    const member = 'bb'.repeat(32)
    const acked: number[][] = []
    const relay = {
      request: async (_m: string, path: string, body?: { ids: number[] }) => {
        if (path === '/v1/mail') {
          return json(200, {
            messages: [
              { id: 1, fromDevice: 'cc'.repeat(32), kind: 'transfer', sealed: 'x' },
              { id: 2, fromDevice: member, kind: 'something-newer', sealed: 'x' },
              { id: 3, fromDevice: member, kind: 'transfer', sealed: 'unopenable' },
              { id: 4, fromDevice: member, kind: 'clipboard', sealed: 'x' }
            ]
          })
        }
        acked.push(body?.ids ?? [])
        return json(200, { deleted: 1 })
      },
      getObject: async () => null,
      deleteObject: async () => undefined
    }
    const sidecar = {
      send: async (method: string) => {
        if (method === 'whoami') return { devicePub: 'aa'.repeat(32) }
        throw new Error('AEAD: message authentication failed')
      }
    }
    await transfer.collectFiles({
      addyd: sidecar as never,
      relay: relay as never,
      epoch: () => 1,
      peers: () => [member]
    })
    expect(acked.flat().sort()).toEqual([1, 2, 3])
  })

  it('deletes a delivered transfer object only after its notice is acknowledged', async () => {
    const { createHash } = await import('node:crypto')
    const bytes = Buffer.from('the runbook\n')
    const notice = {
      id: 'deadbeef00000001',
      name: 'runbook.sh',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sentAt: 1
    }
    const order: string[] = []
    const relay = {
      request: async (_m: string, path: string) => {
        if (path === '/v1/mail') {
          return json(200, {
            messages: [
              {
                id: 7,
                fromDevice: 'bb'.repeat(32),
                kind: 'transfer',
                sealed: Buffer.from(JSON.stringify(notice)).toString('base64')
              }
            ]
          })
        }
        order.push('ack')
        return json(200, { deleted: 1 })
      },
      getObject: async () => ({ body: bytes, etag: 'e' }),
      deleteObject: async (name: string) => {
        order.push(`delete ${name}`)
      }
    }
    const sidecar = {
      send: async (method: string, p?: { sealed?: string }) =>
        method === 'whoami' ? { devicePub: 'aa'.repeat(32) } : { payload: p?.sealed }
    }
    const arrived = await transfer.collectFiles({
      addyd: sidecar as never,
      relay: relay as never,
      epoch: () => 1,
      peers: () => ['bb'.repeat(32)]
    })
    expect(arrived).toHaveLength(1)
    expect(order).toEqual(['ack', 'delete transfer:deadbeef00000001'])
  })
})

describe('direct-connection signalling', () => {
  const me = 'aa'.repeat(32)
  const peer = 'bb'.repeat(32)

  /**
   * A relay mailbox that behaves like the hub: one queue for this device, and
   * a frame goes to the EARLIEST waiting poll. The "peer" answers any offer
   * it is sent by publishing into this device's queue.
   */
  function hub(): { relay: unknown; methods: string[] } {
    const queue: string[] = []
    const polls: ((frame: string | null) => void)[] = []
    const methods: string[] = []
    const deliver = (frame: string): void => {
      const waiting = polls.shift()
      if (waiting) waiting(frame)
      else queue.push(frame)
    }
    const relay = {
      request: async (method: string, path: string, body?: { frame: string }) => {
        methods.push(`${method} ${path.split('?')[0]}`)
        if (body) {
          // What Node's fetch does with a GET that has a body.
          if (method !== 'POST') throw new TypeError('Request with GET/HEAD method cannot have body.')
          const env = JSON.parse(Buffer.from(body.frame, 'base64').toString('utf8'))
          if (env.kind === 'offer') {
            const answer = {
              session: env.session,
              kind: 'answer',
              sdp: 'v=0 answer',
              from: peer,
              signature: '',
              deviceNonce: '11'.repeat(32),
              peerNonce: env.deviceNonce,
              ts: 1,
              rosterHead: ''
            }
            setTimeout(() => deliver(Buffer.from(JSON.stringify(answer)).toString('base64')), 5)
          }
          return new Response(null, { status: 204 })
        }
        const next = queue.shift()
        const frame =
          next ??
          (await new Promise<string | null>((resolve) => {
            polls.push(resolve)
            setTimeout(() => {
              const i = polls.indexOf(resolve)
              if (i >= 0) {
                polls.splice(i, 1)
                resolve(null)
              }
            }, 200)
          }))
        return frame === null ? new Response(null, { status: 204 }) : json(200, { frame })
      }
    }
    return { relay, methods }
  }

  const sidecar = {
    alive: () => true,
    close: async () => undefined,
    send: async (method: string) => {
      if (method === 'rtcOffer') return { sdp: 'v=0 offer' }
      if (method === 'signSignal') return { signature: '', deviceNonce: '22'.repeat(32), ts: 1 }
      return {}
    }
  }

  it('publishes with POST, and the answer reaches the dial while the answering loop is listening', async () => {
    const { relay, methods } = hub()
    const deps = {
      selfDeviceHex: me,
      rtc: sidecar as never,
      crypto: sidecar as never,
      relay: relay as never,
      iceServers: [],
      epoch: 1,
      rosterHead: '',
      members: () => [me, peer]
    }
    // The answering loop is already polling when the dial starts — the
    // ordinary state whenever the clipboard shortcuts are on.
    const answering = answerPeer(deps, 1_000)
    await new Promise((r) => setTimeout(r, 10))
    const session = await dialPeer(deps, peer, 1_000)
    expect(session).toMatch(/^[0-9a-f-]{36}$/)
    expect(methods).toContain('POST /v1/signal')
    await answering
  })
})

describe('the pairing rendezvous', () => {
  const deps = { addyd: signer as never, baseURL: 'https://r.example' }

  it('survives a failed poll inside the window instead of ending the pairing', async () => {
    const answers: (() => Response)[] = [
      () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNRESET') })
      },
      () => new Response(null, { status: 204 }),
      () => json(200, { frame: Buffer.from(JSON.stringify({ msgA: 'm' })).toString('base64') })
    ]
    vi.stubGlobal('fetch', async () => answers.shift()!())
    const got = await receive<{ msgA: string }>(deps, 'ab'.repeat(16), 'joiner', new AbortController().signal, 10_000)
    expect(got.msgA).toBe('m')
  })

  it('stops at once, with the relay\'s words, when the pairing no longer exists', async () => {
    const said =
      'no pairing with this id is in progress on this relay: it finished, expired, or the relay restarted -- start again on the device showing the code'
    vi.stubGlobal('fetch', async () => json(404, { error: said }))
    const started = Date.now()
    const err = (await receive(deps, 'ab'.repeat(16), 'joiner', new AbortController().signal, 10_000).catch(
      (e: unknown) => e
    )) as InstanceType<typeof AddyError>
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(err.code).toBe('pairing-expired')
    expect(err.message).toBe(said)
  })
})

describe('the session says what changed', () => {
  const session = readFileSync(
    join(__dirname, '..', 'src', 'main', 'services', 'addy', 'session.ts'),
    'utf8'
  )
  const body = (sig: string): string => {
    const from = session.slice(session.indexOf(sig))
    return from.slice(0, from.indexOf('\n  }\n'))
  }

  it('pausing pushes a status, so the panel stops saying "syncing"', () => {
    expect(body('pauseSync(): void {')).toContain('this.announce()')
  })

  it('a roster that stops verifying is reported, not swallowed on every pass', () => {
    const pass = body('async syncNow()')
    expect(pass.length, 'the parser is wrong, not the code').toBeGreaterThan(400)
    expect(pass).not.toMatch(/refreshRoster\(\)\.catch\(\(\) => undefined\)/)
    expect(pass).toMatch(/result\.error \?\?= failure\('device list'/)
  })

  it('a relay that forgot the session is logged into again through the pin check', () => {
    // Every RelayClient this session builds gets the re-login, and the
    // re-login is signIn — the path that compares the TLS pin — never a bare
    // relay.login() that would skip it.
    const built = session.match(/new RelayClient\(/g)?.length ?? 0
    const wired = session.match(/\(\) => this\.reauth\(\)/g)?.length ?? 0
    const reauth = session.slice(session.indexOf('private async reauth()'))
    expect(reauth.slice(0, 300)).toContain('await this.signIn()')
    // recoverFromPhrase builds one without: it is the path that starts over.
    expect(wired).toBe(built - 1)
  })
})

describe('a revoked device', () => {
  it('a live session the relay ended is retried through exactly one login', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls++
      return json(401, { error: 'this device has been removed from its sync group' })
    })
    // The login is what answers this: 403 with the chain, which the session
    // verifies. Here it fails the way that path ends, and nothing loops.
    const reauth = vi.fn(async () => {
      throw new AddyError('not-paired', 'removed, and the verified chain confirms it')
    })
    const relay = new RelayClient({ baseURL: 'https://r.example', token: 't' }, signer, reauth)
    const err = (await relay.roster().catch((e: unknown) => e)) as InstanceType<typeof AddyError>
    expect(reauth).toHaveBeenCalledTimes(1)
    expect(calls).toBe(1)
    expect(err.message).toMatch(/verified chain confirms/)
  })

  it('a login refused with the chain carries the chain, for the session to verify', async () => {
    const chain = Buffer.from('chain bytes').toString('base64')
    vi.stubGlobal('fetch', async (url: string) =>
      new URL(url).pathname === '/v1/auth/challenge'
        ? json(200, { nonce: '00'.repeat(32) })
        : json(403, { error: 'this device was removed from the account', roster: { chain } })
    )
    const sidecar = {
      send: async (m: string) =>
        m === 'whoami'
          ? { accountId: 'ab'.repeat(16), devicePub: 'aa'.repeat(32) }
          : { account: '', device: '', deviceNonce: '', ts: 0, signature: '' }
    } as never
    const relay = new RelayClient({ baseURL: 'https://r.example', token: '' }, sidecar)
    vi.spyOn(relay, 'serverPin').mockResolvedValue({ spki: 'aa'.repeat(32), webpki: true })
    const err = await relay.login().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(relayMod.DeviceRemovedError)
    expect((err as InstanceType<typeof relayMod.DeviceRemovedError>).chain).toBe(chain)
    expect((err as InstanceType<typeof AddyError>).code).toBe('not-paired')
  })

  it('a key that is merely not on the roster is not re-logged in for ever', async () => {
    vi.stubGlobal('fetch', async () =>
      json(401, { error: "this device is not on its sync group's roster" })
    )
    const reauth = vi.fn(async () => undefined)
    const relay = new RelayClient({ baseURL: 'https://r.example', token: 't' }, signer, reauth)
    const err = (await relay.roster().catch((e: unknown) => e)) as InstanceType<typeof AddyError>
    // Logging in again hands back the same limited session, so it is not tried.
    expect(reauth).not.toHaveBeenCalled()
    expect(err.code).toBe('not-paired')
  })
})

describe('pairing writes the roster before it hands the key over', () => {
  const session = readFileSync(
    join(__dirname, '..', 'src', 'main', 'services', 'addy', 'session.ts'),
    'utf8'
  )
  const body = (sig: string): string => {
    const from = session.slice(session.indexOf(sig))
    return from.slice(0, from.indexOf('\n  }\n'))
  }

  it('the initiator appends the joiner before publishing the handoff', () => {
    // The joiner logs in and reads the chain the moment the handoff arrives.
    // Handoff first meant it could find itself missing.
    const fn = body('async completePairing(')
    expect(fn.length, 'the parser is wrong, not the code').toBeGreaterThan(800)
    const append = fn.indexOf('relay.appendRoster(')
    const publish = fn.indexOf('await publish(')
    expect(append).toBeGreaterThan(-1)
    expect(publish).toBeGreaterThan(-1)
    expect(append, 'the handoff is published before the roster lists the joiner').toBeLessThan(publish)
  })

  it('the joiner logs in only after the handoff, and pins nothing from it', () => {
    // So with the new order, its first login and roster read already see its
    // own add. It does not take the handoff's head as a pin either: that head
    // is the one BEFORE its add, and a chain that extends it is exactly what
    // it should accept.
    const fn = body('async finishJoin(')
    expect(fn.indexOf('await receive<')).toBeLessThan(fn.indexOf('await this.loginAndRecord()'))
    expect(fn).not.toMatch(/pinSeq|pinHead/)
  })
})

describe('large bodies stay off the sidecar line', () => {
  it('signs a hash of the body, never the body', async () => {
    const seen: Record<string, unknown>[] = []
    const recording = {
      alive: () => true,
      close: async () => undefined,
      send: async (_m: string, p: Record<string, unknown>) => {
        seen.push(p)
        return { nonce: '00'.repeat(32), signature: '00'.repeat(64) }
      }
    } as unknown as import('../src/main/services/addy/sidecar').AddySidecar
    vi.stubGlobal('fetch', async () => json(200, { chain: '' }))
    const relay = new RelayClient({ baseURL: 'https://r.example', token: 't' }, recording)
    await relay.request('POST', '/v1/roster', { seq: 1, entry: 'x' })
    const { createHash } = await import('node:crypto')
    const expected = createHash('sha256').update(JSON.stringify({ seq: 1, entry: 'x' })).digest('hex')
    expect(seen[0]).toEqual({ method: 'POST', path: '/v1/roster', bodyHash: expected })
    // And a request with no body sends no hash: the sidecar signs NoBody.
    await relay.request('GET', '/v1/roster')
    expect(seen[1]).toEqual({ method: 'GET', path: '/v1/roster' })
  })

  it('refuses a body over the relay limit before signing or sending it', async () => {
    const sign = vi.fn(async () => ({ nonce: '00'.repeat(32), signature: '00'.repeat(64) }))
    const fetched = vi.fn(async () => json(200, {}))
    vi.stubGlobal('fetch', fetched)
    const relay = new RelayClient(
      { baseURL: 'https://r.example', token: 't' },
      { alive: () => true, close: async () => undefined, send: sign } as never
    )
    const err = (await relay
      .request('PUT', '/v1/obj/big', { body: 'A'.repeat(MAX_REQUEST_BYTES) })
      .catch((e: unknown) => e)) as InstanceType<typeof AddyError>
    expect(err.code).toBe('too-large')
    expect(sign).not.toHaveBeenCalled()
    expect(fetched).not.toHaveBeenCalled()
  })

  it('the parent\'s line limit is the sidecar\'s', async () => {
    const { MAX_LINE_BYTES } = await import('../src/main/services/addy/sidecar')
    const go = readFileSync(join(__dirname, '..', 'sidecar', 'addyd', 'main.go'), 'utf8')
    const m = /const maxRequestBytes = (\d+) << (\d+)/.exec(go)
    expect(m, 'the parser is wrong, not the code').toBeTruthy()
    expect(MAX_LINE_BYTES).toBe(Number(m![1]) * 2 ** Number(m![2]))
    // Big enough for the largest object a request can carry, base64'd again
    // on its way through `open`.
    expect(MAX_LINE_BYTES).toBeGreaterThan((MAX_REQUEST_BYTES * 4) / 3 + 1024)
  })
})

describe('a re-login that fails is not repeated by every request', () => {
  it('one failed re-login answers the rest of the pass', async () => {
    vi.stubGlobal('fetch', async () => json(401, { error: 'unknown or expired session' }))
    const reauth = vi.fn(async () => {
      throw new AddyError('relay-unreachable', 'the pin was refused')
    })
    const relay = new RelayClient({ baseURL: 'https://r.example', token: 't' }, signer, reauth)
    for (let i = 0; i < 5; i++) {
      const err = (await relay.roster().catch((e: unknown) => e)) as InstanceType<typeof AddyError>
      expect(err.message).toBe('the pin was refused')
    }
    expect(reauth).toHaveBeenCalledTimes(1)
  })
})
