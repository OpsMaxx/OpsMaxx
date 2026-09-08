// RDCleanPath PDU codec.
//
// The RDP client runs in the renderer as WebAssembly, so it cannot open a TCP
// socket, and therefore cannot perform the two parts of an RDP connection that
// happen before a TLS tunnel exists: the X.224 negotiation, and the TLS
// handshake itself. RDCleanPath is the protocol that delegates exactly those
// two steps to a proxy and hands the result back.
//
// That is why `rdpRelay.ts` is not a socket pipe. The first message the client
// sends is a request PDU naming a destination and carrying an X.224 Connection
// Request it built; the relay connects, replays that X.224 verbatim, completes
// TLS, and answers with the Connection Confirm plus the server's certificate
// chain -- which the client needs, because CredSSP binds to the server
// certificate and a client that never saw it cannot authenticate. Only after
// that exchange does the connection become a plain relay of TLS records.
//
// The encoding is ASN.1 DER. Field numbers follow ironrdp-rdcleanpath; only the
// fields this relay actually reads or writes are implemented, and an unknown
// field is skipped rather than rejected so that a newer client stays readable.

/**
 * Protocol version. Not a version number anyone chose to be sequential: it is
 * 3389 + 1, so that a stray RDP connection to a proxy port cannot be mistaken
 * for a valid RDCleanPath v1 PDU.
 */
const VERSION_1 = 3390

const TAG_SEQUENCE = 0x30
const TAG_INTEGER = 0x02
const TAG_OCTET_STRING = 0x04
const TAG_UTF8STRING = 0x0c

/** Context-specific, constructed, EXPLICIT tag `[n]`. */
const ctxTag = (n: number): number => 0xa0 + n

export interface RdCleanPathRequest {
  destination: string
  /** The bearer token, which the relay authenticates before dialling anything. */
  proxyAuth: string | null
  x224: Buffer
  preconnectionBlob: string | null
}

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  const bytes: number[] = []
  let rest = length
  while (rest > 0) {
    bytes.unshift(rest & 0xff)
    rest >>>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function wrap(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content])
}

function encodeInteger(value: number): Buffer {
  if (value === 0) return wrap(TAG_INTEGER, Buffer.from([0]))
  const bytes: number[] = []
  let rest = value
  while (rest > 0) {
    bytes.unshift(rest & 0xff)
    rest >>>= 8
  }
  // DER INTEGER is signed, so a leading high bit would decode as negative.
  if ((bytes[0] & 0x80) !== 0) bytes.unshift(0)
  return wrap(TAG_INTEGER, Buffer.from(bytes))
}

const encodeUtf8 = (value: string): Buffer => wrap(TAG_UTF8STRING, Buffer.from(value, 'utf-8'))
const encodeOctets = (value: Buffer): Buffer => wrap(TAG_OCTET_STRING, value)

interface Tlv {
  tag: number
  value: Buffer
  totalLength: number
}

function decodeLength(buf: Buffer, offset: number): { length: number; bytesRead: number } {
  const first = buf[offset]
  if (first === undefined) throw new Error('truncated: no length byte')
  if (first < 0x80) return { length: first, bytesRead: 1 }
  const count = first & 0x7f
  // A DER length of more than four bytes describes something larger than any
  // PDU this protocol produces, and shifting it would overflow anyway.
  if (count === 0 || count > 4) throw new Error(`unsupported DER length of ${count} bytes`)
  if (offset + count >= buf.length) throw new Error('truncated: length runs past the buffer')
  let length = 0
  for (let i = 0; i < count; i++) length = length * 256 + buf[offset + 1 + i]
  return { length, bytesRead: 1 + count }
}

function decodeTlv(buf: Buffer, offset: number): Tlv {
  if (offset >= buf.length) throw new Error('truncated: no tag byte')
  const tag = buf[offset]
  const { length, bytesRead } = decodeLength(buf, offset + 1)
  const headerLen = 1 + bytesRead
  const end = offset + headerLen + length
  if (end > buf.length) throw new Error('truncated: value runs past the buffer')
  return { tag, value: buf.subarray(offset + headerLen, end), totalLength: headerLen + length }
}

function decodeChildren(buf: Buffer): Tlv[] {
  const out: Tlv[] = []
  let offset = 0
  while (offset < buf.length) {
    const tlv = decodeTlv(buf, offset)
    out.push(tlv)
    // A zero-length TLV cannot happen for a well-formed PDU, and treating it as
    // progress would be an infinite loop on a malformed one.
    if (tlv.totalLength <= 0) throw new Error('malformed: zero-length element')
    offset += tlv.totalLength
  }
  return out
}

function decodeInteger(buf: Buffer): number {
  let value = 0
  for (const byte of buf) value = value * 256 + byte
  return value
}

export function parseRequest(data: Buffer): RdCleanPathRequest {
  const outer = decodeTlv(data, 0)
  if (outer.tag !== TAG_SEQUENCE) {
    throw new Error(`expected SEQUENCE, got 0x${outer.tag.toString(16)}`)
  }

  let version: number | null = null
  let destination: string | null = null
  let proxyAuth: string | null = null
  let x224: Buffer | null = null
  let preconnectionBlob: string | null = null

  for (const child of decodeChildren(outer.value)) {
    // Strip the class and constructed bits to get the field number.
    switch (child.tag & 0x1f) {
      case 0:
        version = decodeInteger(decodeTlv(child.value, 0).value)
        break
      case 2:
        destination = decodeTlv(child.value, 0).value.toString('utf-8')
        break
      case 3:
        proxyAuth = decodeTlv(child.value, 0).value.toString('utf-8')
        break
      case 5:
        preconnectionBlob = decodeTlv(child.value, 0).value.toString('utf-8')
        break
      case 6:
        x224 = Buffer.from(decodeTlv(child.value, 0).value)
        break
      default:
        // Forwards compatibility: a field this relay does not read is not an
        // error, because the client is versioned separately from the relay.
        break
    }
  }

  if (version !== VERSION_1) throw new Error(`unsupported RDCleanPath version ${version}`)
  if (destination === null) throw new Error('request has no destination')
  if (x224 === null) throw new Error('request has no x224_connection_pdu')

  return { destination, proxyAuth, x224, preconnectionBlob }
}

export function buildResponse(
  serverAddr: string,
  x224Response: Buffer,
  certChain: Buffer[]
): Buffer {
  const certSeq = wrap(TAG_SEQUENCE, Buffer.concat(certChain.map(encodeOctets)))
  return wrap(
    TAG_SEQUENCE,
    Buffer.concat([
      wrap(ctxTag(0), encodeInteger(VERSION_1)),
      wrap(ctxTag(6), encodeOctets(x224Response)),
      wrap(ctxTag(7), certSeq),
      wrap(ctxTag(9), encodeUtf8(serverAddr))
    ])
  )
}

/**
 * An error PDU, so a failed handshake reaches the client as a protocol error it
 * can report rather than as a socket that closed for no stated reason.
 *
 * `errorCode` is 1 for a general failure and 2 for a negotiation failure.
 */
export function buildError(errorCode: number, httpStatusCode?: number): Buffer {
  const errParts = [wrap(ctxTag(0), encodeInteger(errorCode))]
  if (httpStatusCode !== undefined) {
    errParts.push(wrap(ctxTag(1), encodeInteger(httpStatusCode)))
  }
  return wrap(
    TAG_SEQUENCE,
    Buffer.concat([
      wrap(ctxTag(0), encodeInteger(VERSION_1)),
      wrap(ctxTag(1), wrap(TAG_SEQUENCE, Buffer.concat(errParts)))
    ])
  )
}

/** `host:port`, `[::1]:3389`, or a bare host, where the port defaults to 3389. */
export function parseDestination(destination: string): { host: string; port: number } {
  if (destination.startsWith('[')) {
    const end = destination.indexOf(']')
    if (end === -1) throw new Error(`malformed IPv6 destination: ${destination}`)
    const host = destination.slice(1, end)
    const rest = destination.slice(end + 1)
    if (!rest) return { host, port: 3389 }
    if (!rest.startsWith(':')) throw new Error(`malformed IPv6 destination: ${destination}`)
    const port = Number(rest.slice(1))
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`malformed port in destination: ${destination}`)
    }
    return { host, port }
  }
  const colon = destination.lastIndexOf(':')
  if (colon === -1) return { host: destination, port: 3389 }
  // An unbracketed IPv6 literal has colons of its own, and its last one is part
  // of the address rather than a separator. Splitting on it turned '::1' into
  // host ':' port 1 -- a different machine than the one named, dialled without
  // complaint. More than one colon means there is no port here.
  if (destination.indexOf(':') !== colon) return { host: destination, port: 3389 }
  const port = Number(destination.slice(colon + 1))
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { host: destination, port: 3389 }
  }
  return { host: destination.slice(0, colon), port }
}
