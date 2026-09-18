import { AGENT } from '../../../shared/sshAgentHost'

/**
 * The agent wire format.
 *
 * Every message is `uint32 length || byte type || payload`, and every
 * composite value inside a payload is `uint32 length || bytes`. That is the
 * whole format; the complexity is entirely in what the payloads mean.
 *
 * Written from `draft-miller-ssh-agent` rather than from an implementation.
 * Two things that matters for: the length prefixes are what an attacker
 * controls, so the reader below is strict about them in a way a port of
 * somebody's loop would not necessarily be; and the repository is MIT with a
 * CI test that fails on a GPL dependency, so "I read how gpg-agent does it" is
 * not available even if it were a good idea.
 */

/** The largest message this agent will read.
 *
 *  A client sends a public key, a session identifier and a signature blob.
 *  None of those is large. The limit exists because the length prefix is the
 *  first thing off the socket and is entirely attacker-controlled: without a
 *  cap, `0xffffffff` is an instruction to allocate four gigabytes, from any
 *  local process that can reach the socket. */
export const MAX_MESSAGE = 256 * 1024

export class ProtocolError extends Error {}

/** Reads the primitives the format is made of, refusing anything that does not
 *  fit rather than returning a short buffer. */
export class Reader {
  private offset = 0

  constructor(private readonly buf: Buffer) {}

  get remaining(): number {
    return this.buf.length - this.offset
  }

  get atEnd(): boolean {
    return this.offset >= this.buf.length
  }

  byte(): number {
    if (this.remaining < 1) throw new ProtocolError('truncated: expected a byte')
    return this.buf[this.offset++]
  }

  uint32(): number {
    if (this.remaining < 4) throw new ProtocolError('truncated: expected a uint32')
    const v = this.buf.readUInt32BE(this.offset)
    this.offset += 4
    return v
  }

  /** A length-prefixed blob.
   *
   *  The length is checked against what is ACTUALLY LEFT, not against the
   *  declared message length, so a message claiming an inner blob longer than
   *  itself is refused rather than truncated into something that parses. */
  blob(): Buffer {
    const len = this.uint32()
    if (len > this.remaining) {
      throw new ProtocolError(`truncated: a field claims ${len} bytes with ${this.remaining} left`)
    }
    const out = this.buf.subarray(this.offset, this.offset + len)
    this.offset += len
    return Buffer.from(out)
  }

  str(): string {
    return this.blob().toString('utf8')
  }

  bool(): boolean {
    return this.byte() !== 0
  }
}

/** Builds a message body. The outer length prefix is added by `frame`. */
export class Writer {
  private readonly parts: Buffer[] = []

  byte(v: number): this {
    this.parts.push(Buffer.from([v & 0xff]))
    return this
  }

  uint32(v: number): this {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(v >>> 0)
    this.parts.push(b)
    return this
  }

  blob(v: Buffer | string): this {
    const b = Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8')
    return this.uint32(b.length).push(b)
  }

  push(b: Buffer): this {
    this.parts.push(b)
    return this
  }

  body(): Buffer {
    return Buffer.concat(this.parts)
  }
}

/** Wraps a body in the outer `uint32 length` the transport expects. */
export function frame(body: Buffer): Buffer {
  const out = Buffer.alloc(4 + body.length)
  out.writeUInt32BE(body.length)
  body.copy(out, 4)
  return out
}

export const FAILURE = frame(Buffer.from([AGENT.FAILURE]))
export const SUCCESS = frame(Buffer.from([AGENT.SUCCESS]))
export const EXTENSION_FAILURE = frame(Buffer.from([AGENT.EXTENSION_FAILURE]))

/**
 * Splits a stream into messages.
 *
 * A stateful accumulator rather than a per-chunk parse, because a socket
 * delivers whatever it delivers: one message may arrive in five chunks, and
 * five messages may arrive in one. An implementation that assumed a chunk is a
 * message works on loopback until the day a client sends two requests without
 * waiting, and then desynchronises for the life of the connection.
 */
export class MessageStream {
  private buf: Buffer = Buffer.alloc(0)

  /** Feeds a chunk and returns whatever complete messages it completed.
   *
   *  Throws on a length that exceeds MAX_MESSAGE. The caller closes the
   *  connection: a peer that asked for a 4 GiB allocation is not a peer to
   *  keep talking to, and there is no way to resynchronise a stream whose
   *  framing you have stopped trusting. */
  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk])
    const out: Buffer[] = []
    for (;;) {
      if (this.buf.length < 4) return out
      const len = this.buf.readUInt32BE(0)
      if (len === 0) {
        throw new ProtocolError('a zero-length message')
      }
      if (len > MAX_MESSAGE) {
        throw new ProtocolError(`a message claims ${len} bytes; the limit is ${MAX_MESSAGE}`)
      }
      if (this.buf.length < 4 + len) return out
      out.push(Buffer.from(this.buf.subarray(4, 4 + len)))
      this.buf = Buffer.from(this.buf.subarray(4 + len))
    }
  }

  /** Bytes held pending a complete message. Used by a test, and by the guard
   *  that stops a peer holding a partial message open forever. */
  get pending(): number {
    return this.buf.length
  }
}

/** An `SSH_AGENT_IDENTITIES_ANSWER` for the given keys. */
export function identitiesAnswer(keys: { blob: Buffer; comment: string }[]): Buffer {
  const w = new Writer().byte(AGENT.IDENTITIES_ANSWER).uint32(keys.length)
  for (const k of keys) {
    w.blob(k.blob).blob(k.comment)
  }
  return frame(w.body())
}

/** An `SSH_AGENT_SIGN_RESPONSE`. The signature is already in its
 *  `string algorithm || string blob` form -- this only wraps it. */
export function signResponse(signature: Buffer): Buffer {
  return frame(new Writer().byte(AGENT.SIGN_RESPONSE).blob(signature).body())
}

/** The reply to `query`: the extension names this agent implements.
 *
 *  OpenSSH probes with this before using any of them, so an agent that answers
 *  FAILURE here is one that never gets asked to session-bind -- and then
 *  cannot tell where a signature is going. */
export function extensionQueryAnswer(names: string[]): Buffer {
  const w = new Writer().byte(AGENT.SUCCESS)
  for (const n of names) w.blob(n)
  return frame(w.body())
}
