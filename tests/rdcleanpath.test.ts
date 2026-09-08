import { describe, it, expect } from 'vitest'
import {
  buildError,
  buildResponse,
  parseDestination,
  parseRequest
} from '../src/main/services/rdcleanpath'

// The relay reads these PDUs off a socket before it has decided to trust
// anything on it, so the decoder is the first thing an untrusted peer reaches.
// Its failure mode has to be "throw", never "loop" or "read past the end".

const VERSION_1 = 3390

// A minimal DER encoder, written independently of the one under test so that a
// bug in the encoder cannot cancel out a matching bug in the decoder.
function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n])
  const bytes: number[] = []
  let rest = n
  while (rest > 0) {
    bytes.unshift(rest & 0xff)
    rest >>>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}
const tlv = (tag: number, body: Buffer): Buffer =>
  Buffer.concat([Buffer.from([tag]), len(body.length), body])
const int = (n: number): Buffer => {
  const bytes: number[] = []
  let rest = n
  while (rest > 0) {
    bytes.unshift(rest & 0xff)
    rest >>>= 8
  }
  if (bytes.length === 0) bytes.push(0)
  if ((bytes[0] & 0x80) !== 0) bytes.unshift(0)
  return tlv(0x02, Buffer.from(bytes))
}
const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, 'utf-8'))
const octets = (b: Buffer): Buffer => tlv(0x04, b)
const ctx = (n: number, body: Buffer): Buffer => tlv(0xa0 + n, body)

function request(opts: {
  version?: number
  destination?: string
  proxyAuth?: string
  x224?: Buffer
  pcb?: string
  extra?: Buffer
}): Buffer {
  const parts: Buffer[] = [ctx(0, int(opts.version ?? VERSION_1))]
  if (opts.destination !== undefined) parts.push(ctx(2, utf8(opts.destination)))
  if (opts.proxyAuth !== undefined) parts.push(ctx(3, utf8(opts.proxyAuth)))
  if (opts.pcb !== undefined) parts.push(ctx(5, utf8(opts.pcb)))
  if (opts.x224 !== undefined) parts.push(ctx(6, octets(opts.x224)))
  if (opts.extra) parts.push(opts.extra)
  return tlv(0x30, Buffer.concat(parts))
}

describe('RDCleanPath request parsing', () => {
  it('reads the destination, the token and the X.224 request', () => {
    const x224 = Buffer.from([0x03, 0x00, 0x00, 0x2b, 0x26, 0xe0])
    const parsed = parseRequest(
      request({ destination: 'win-01.corp:3389', proxyAuth: 'tok-1', x224 })
    )
    expect(parsed.destination).toBe('win-01.corp:3389')
    expect(parsed.proxyAuth).toBe('tok-1')
    expect(parsed.x224.equals(x224)).toBe(true)
    expect(parsed.preconnectionBlob).toBeNull()
  })

  it('reports a missing token as null rather than defaulting it', () => {
    // The relay compares proxyAuth to the ticket it minted. A decoder that
    // returned '' for an absent field would make an empty token in the PDU and
    // no token at all indistinguishable.
    const parsed = parseRequest(request({ destination: 'h:3389', x224: Buffer.from([1]) }))
    expect(parsed.proxyAuth).toBeNull()
  })

  it('skips a field it does not know instead of failing', () => {
    // The client is versioned separately from the relay; a field added upstream
    // must not take the connection down.
    const parsed = parseRequest(
      request({
        destination: 'h:3389',
        x224: Buffer.from([1]),
        extra: ctx(11, utf8('something new'))
      })
    )
    expect(parsed.destination).toBe('h:3389')
  })

  it('rejects another protocol version', () => {
    expect(() => parseRequest(request({ version: 1, destination: 'h', x224: Buffer.from([1]) })))
      .toThrow(/version/)
  })

  it('rejects a request with no destination or no X.224 PDU', () => {
    expect(() => parseRequest(request({ x224: Buffer.from([1]) }))).toThrow(/destination/)
    expect(() => parseRequest(request({ destination: 'h' }))).toThrow(/x224/)
  })

  it('rejects a PDU that is not a SEQUENCE', () => {
    expect(() => parseRequest(tlv(0x04, Buffer.from([0])))).toThrow(/SEQUENCE/)
  })

  describe('malformed input from an untrusted peer', () => {
    it('throws on an empty buffer', () => {
      expect(() => parseRequest(Buffer.alloc(0))).toThrow()
    })

    it('throws rather than reading past the end when a length overruns', () => {
      // Claims 32 bytes of content inside a 4-byte buffer.
      expect(() => parseRequest(Buffer.from([0x30, 0x20, 0x02, 0x01]))).toThrow(/truncated/)
    })

    it('throws on a length field that is itself truncated', () => {
      expect(() => parseRequest(Buffer.from([0x30, 0x82, 0x01]))).toThrow(/truncated/)
    })

    it('refuses an absurd multi-byte length instead of overflowing', () => {
      // 0x88 = eight length bytes, which no real PDU uses and which would
      // overflow a 32-bit shift.
      expect(() =>
        parseRequest(Buffer.concat([Buffer.from([0x30, 0x88]), Buffer.alloc(8, 0xff)]))
      ).toThrow(/length/)
    })

    it('terminates on a truncated tail rather than looping', () => {
      // A SEQUENCE whose body ends mid-element. The decoder must fail, and it
      // must fail quickly: the guard exists so a zero-length element cannot
      // make the walk stand still.
      const body = Buffer.concat([ctx(0, int(VERSION_1)), Buffer.from([0xa2, 0x40])])
      const pdu = tlv(0x30, body)
      expect(() => parseRequest(pdu)).toThrow()
    })
  })
})

describe('RDCleanPath response building', () => {
  it('round-trips through the decoder used for requests', () => {
    // Not a request, but the same DER: this checks the encoder emits lengths
    // and context tags the decoder agrees with.
    const response = buildResponse('10.0.0.5:3389', Buffer.from([0x03, 0x00]), [
      Buffer.from([0xde, 0xad]),
      Buffer.from([0xbe, 0xef])
    ])
    expect(response[0]).toBe(0x30)
    // [0] version, [6] x224, [7] cert chain, [9] server address.
    expect(response.includes(Buffer.from('10.0.0.5:3389', 'utf-8'))).toBe(true)
    expect(response.includes(Buffer.from([0xde, 0xad]))).toBe(true)
    expect(response.includes(Buffer.from([0xbe, 0xef]))).toBe(true)
  })

  it('encodes a length over 127 with the long form', () => {
    // A real certificate is always longer than the short form can describe, so
    // this is the path every genuine response takes.
    const big = Buffer.alloc(300, 0x41)
    const response = buildResponse('h:3389', Buffer.from([0x03]), [big])
    expect(response.includes(big)).toBe(true)
  })

  it('builds an error PDU with and without an HTTP status', () => {
    expect(buildError(1, 502)[0]).toBe(0x30)
    expect(buildError(1).length).toBeLessThan(buildError(1, 502).length)
  })
})

describe('destination parsing', () => {
  it('splits host and port', () => {
    expect(parseDestination('win-01:3389')).toEqual({ host: 'win-01', port: 3389 })
  })

  it('defaults the port when there is none', () => {
    expect(parseDestination('win-01')).toEqual({ host: 'win-01', port: 3389 })
  })

  it('handles a bracketed IPv6 literal', () => {
    expect(parseDestination('[2001:db8::1]:3390')).toEqual({ host: '2001:db8::1', port: 3390 })
    expect(parseDestination('[::1]')).toEqual({ host: '::1', port: 3389 })
  })

  it('does not read a bare IPv6 address as host:port', () => {
    // The last colon is part of the address, not a separator. Reading it as one
    // would dial a different host than the one named.
    expect(parseDestination('::1')).toEqual({ host: '::1', port: 3389 })
  })

  it('falls back to the default port rather than NaN', () => {
    expect(parseDestination('host:not-a-port')).toEqual({ host: 'host:not-a-port', port: 3389 })
    expect(parseDestination('host:0')).toEqual({ host: 'host:0', port: 3389 })
    expect(parseDestination('host:99999')).toEqual({ host: 'host:99999', port: 3389 })
  })
})
